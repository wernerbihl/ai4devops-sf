import { randomUUID } from 'node:crypto';
import type { AttentionRequest, Attempt, NativeIdentity, TaskStatus, Usage } from '../contracts/domain.ts';
import { validateContract } from '../contracts/schemas.ts';
import { continuationAllowed } from '../scheduling/leases.ts';
import type { LifecycleState, Quiescence } from '../scheduling/leases.ts';
import type { Reservation } from '../scheduling/admission-types.ts';
import { StoreDatabase, canonical, ensure } from './database.ts';
import type { AdmissionStorage } from './admission.ts';
import type { TaskStorage } from './tasks.ts';
import type { Outbox, OutboxAction } from './outbox.ts';

export interface LifecycleUpdate {
  status?: TaskStatus; state?: LifecycleState; activeDurationMs?: number; usage?: Usage;
  attention?: { kind: AttentionRequest['kind']; prompt: string; recovery: string; inputSchema?: Record<string, unknown>; nativeInputId?: string };
  release?: Quiescence; human?: boolean;
}
export interface LifecycleRecord { reservation: Reservation; state: LifecycleState }
export class LifecycleStorage {
  private db: StoreDatabase; private admission: AdmissionStorage; private tasks: TaskStorage; private outbox: Outbox;
  constructor(db: StoreDatabase, admission: AdmissionStorage, tasks: TaskStorage, outbox: Outbox) { this.db = db; this.admission = admission; this.tasks = tasks; this.outbox = outbox; }
  get(attemptId: string): LifecycleRecord {
    const reservation = this.admission.reservations().find(r => r.attempt.id === attemptId);
    ensure(reservation, 'not_found', 'Attempt not found');
    const row = this.db.sql.prepare('SELECT payload FROM lifecycle_state WHERE attempt_id = ?').get(attemptId);
    return { reservation, state: row ? JSON.parse(String(row.payload)) as LifecycleState : { segments: [] } };
  }
  private write(reservation: Reservation): void {
    // Preserve C3's private immutable basis; callers receive only the public reservation shape.
    this.db.sql.prepare('UPDATE admission_reservations SET status = ?, lease_active = ?, fence = ?, payload = ? WHERE id = ?').run(reservation.status, reservation.lease.active ? 1 : 0, reservation.lease.fence, JSON.stringify(reservation), reservation.id);
  }
  private fence(record: LifecycleRecord, fence: number): void {
    const current = this.db.sql.prepare('SELECT fence FROM admission_fences WHERE repository_id = ?').get(record.reservation.lease.repositoryId);
    ensure(record.reservation.lease.active && record.reservation.lease.fence === fence && current?.fence === fence, 'stale_fence', 'Mutation requires the active repository fence');
    ensure(record.reservation.status === 'confirmed' || !!record.reservation.attempt.retryOfAttemptId, 'unconfirmed_start', 'Reconcile pending start before lifecycle mutation');
  }
  update(attemptId: string, fence: number, patch: LifecycleUpdate): LifecycleRecord {
    const record = this.get(attemptId); this.fence(record, fence);
    const r = record.reservation; const old = this.tasks.get(r.attempt.taskId)!;
    ensure(old.attemptIds.at(-1) === attemptId, 'stale_attempt', 'Only current attempt may change task state');
    ensure(!['completed', 'failed', 'cancelled'].includes(old.status), 'closed_task', 'Closed tasks cannot receive lifecycle events');
    ensure(r.status === 'confirmed' || (patch.status !== 'running' && !patch.release), 'unconfirmed_start', 'Unconfirmed retry keeps its capacity hold until native send is proven');
    if (patch.release) ensure(patch.release !== 'unknown', 'quiescence_unknown', 'Only proven stopped or waiting execution releases a lease');
    r.attempt = validateContract('Attempt', { ...r.attempt,
      ...(patch.status ? { status: patch.status } : {}), ...(patch.usage ? { usage: patch.usage } : {}),
      ...(patch.activeDurationMs !== undefined ? { activeDurationMs: Math.max(r.attempt.activeDurationMs, patch.activeDurationMs) } : {}),
      ...(patch.status && ['failed', 'cancelled', 'completed'].includes(patch.status) ? { endedAt: this.db.now() } : {}),
    });
    if (patch.status || patch.human !== undefined) r.task = this.tasks.write({ ...old, status: patch.status ?? old.status,
      controlMode: patch.human ? 'human' : old.controlMode, revision: old.revision + 1, updatedAt: this.db.now() });
    if (patch.release) { r.lease.active = false; this.db.sql.prepare('DELETE FROM actor_scopes WHERE attempt_id = ?').run(attemptId); }
    if (patch.state) record.state = { ...patch.state,
      ...(record.state.effect ? { effect: record.state.effect } : {}),
      stopRequested: !!record.state.stopRequested || !!patch.state.stopRequested,
    };
    if (patch.release) { record.state.quiescent = true; record.state.stopRequested = false; delete record.state.effect; }
    this.db.sql.prepare('INSERT INTO lifecycle_state(attempt_id, payload) VALUES (?, ?) ON CONFLICT(attempt_id) DO UPDATE SET payload = excluded.payload').run(attemptId, JSON.stringify(record.state));
    this.write(r); this.db.emit('attempt', r.attempt);
    if (patch.attention) {
      const a = patch.attention;
      const prior = this.admission.records().attention.find(item => item.attemptId === attemptId && item.status === 'open' && (a.nativeInputId ? item.nativeInputId === a.nativeInputId : item.prompt === a.prompt));
      if (!prior) {
        const request = validateContract('AttentionRequest', { id: randomUUID(), taskId: old.spec.id, attemptId,
          repositoryId: old.spec.repositoryId, source: 'owner', kind: a.kind, prompt: a.prompt, recovery: a.recovery,
          inputSchema: a.inputSchema ?? {}, ...(a.nativeInputId ? { nativeInputId: a.nativeInputId } : {}), status: 'open', createdAt: this.db.now(), revision: 1 });
        this.db.sql.prepare('INSERT INTO admission_attention(id, payload) VALUES (?, ?)').run(request.id, JSON.stringify(request)); this.db.emit('attention', request);
      }
    }
    return record;
  }
  queueReply(requestId: string, value: unknown, key: string): OutboxAction {
    const request = this.admission.records().attention.find(a => a.id === requestId);
    ensure(request?.attemptId && request.nativeInputId && request.kind === 'input', 'not_found', 'Native attention request not found');
    // Outbox enforces exact replay before checking the request status.
    const prior = this.db.sql.prepare('SELECT id FROM outbox WHERE key = ?').get(`lifecycle:reply:${key}`);
    ensure(prior || request.status === 'open', 'request_closed', 'Input request is already answered');
    const r = this.get(request.attemptId).reservation;
    ensure(r.attempt.native && r.attempt.workflow && r.attempt.id === this.tasks.get(request.taskId)!.attemptIds.at(-1), 'identity_missing', 'Input requires the original current execution');
    const action = this.outbox.enqueue({ key: `lifecycle:reply:${key}`, kind: 'lifecycle.send', payload: { attemptId: request.attemptId, requestId, input: { requestId: request.nativeInputId, response: value, answers: value } } });
    if (!prior) {
      const responded = { ...request, status: 'responded' as const, revision: request.revision + 1 };
      this.db.sql.prepare('UPDATE admission_attention SET payload = ? WHERE id = ?').run(JSON.stringify(responded), request.id); this.db.emit('attention', responded);
    }
    return action;
  }
  acquire(attemptId: string, token: string, retry: boolean): Reservation {
    const original = this.get(attemptId); const state = this.admission.state();
    ensure(state.token === token, 'admission_changed', 'Policy changed during continuation preflight');
    const old = original.reservation; const task = this.tasks.get(old.attempt.taskId)!;
    ensure(old.attempt.native && old.attempt.workflow && original.state.quiescent, 'identity_missing', 'Original identity and proven quiescence are required');
    ensure(!old.lease.active && task.attemptIds.at(-1) === attemptId && !['completed', 'cancelled'].includes(task.status), 'stale_attempt', 'Continuation must use the current quiescent attempt');
    continuationAllowed(task.spec, state, this.db.clock, retry);
    if (retry) ensure(this.admission.records().attempts.filter(a => a.taskId === task.spec.id && a.retryOfAttemptId).length < state.settings.config.limits.transientRetries, 'retry_limit', 'Automatic retry limit reached');
    const row = this.db.sql.prepare('SELECT fence FROM admission_fences WHERE repository_id = ?').get(task.spec.repositoryId)!;
    const fence = Number(row.fence) + 1;
    this.db.sql.prepare('UPDATE admission_fences SET fence = ? WHERE repository_id = ?').run(fence, task.spec.repositoryId);
    const r = structuredClone(old);
    if (retry) {
      r.id = randomUUID(); r.status = 'pending';
      r.attempt = validateContract('Attempt', { ...old.attempt, id: randomUUID(), retryOfAttemptId: attemptId, fence, status: 'queued', createdAt: this.db.now(), activeDurationMs: 0, startedAt: undefined, endedAt: undefined });
      r.quota = { dayKey: state.quota.dayKey }; r.proposedRotation = null;
      r.task = this.tasks.write({ ...task, status: 'needs_attention', attemptIds: [...task.attemptIds, r.attempt.id], revision: task.revision + 1, updatedAt: this.db.now() });
      r.lease = { ...old.lease, attemptId: r.attempt.id, fence, active: true };
      this.db.sql.prepare('INSERT INTO admission_reservations(id, task_id, repository_id, status, lease_active, fence, payload) VALUES (?, ?, ?, ?, 1, ?, ?)').run(r.id, task.spec.id, task.spec.repositoryId, r.status, fence, JSON.stringify(r));
      this.db.sql.prepare('INSERT INTO lifecycle_state(attempt_id, payload) VALUES (?, ?)').run(r.attempt.id, JSON.stringify({ segments: [], quiescent: true }));
    } else {
      r.attempt.fence = fence; r.lease.fence = fence; r.lease.active = true; this.write(r);
    }
    this.db.emit('attempt', r.attempt); return r;
  }
  finishAction(actionId: string, attemptId: string, fence: number, state: LifecycleState, activeDurationMs: number, effectToken: string): void {
    const record = this.get(attemptId); const r = record.reservation;
    this.authority(attemptId, fence);
    ensure(record.state.effect?.token === effectToken && record.state.effect.phase === 'accepted' && !record.state.stopRequested, 'effect_interrupted', 'Late external completion cannot finalize interrupted work');
    this.accountAccepted(r);
    this.update(attemptId, fence, { status: 'running', state, activeDurationMs });
    const action = this.outbox.find(actionId); ensure(action, 'not_found', 'Action not found');
    if (action.payload.requestId) {
      const request = this.admission.records().attention.find(a => a.id === action.payload.requestId)!;
      const updated = { ...request, status: 'resolved' as const, resolvedAt: this.db.now(), revision: request.revision + 1 };
      this.db.sql.prepare('UPDATE admission_attention SET payload = ? WHERE id = ?').run(JSON.stringify(updated), request.id); this.db.emit('attention', updated);
    }
    this.outbox.complete(actionId);
  }
  private accountAccepted(r: Reservation): void {
    if (r.status === 'pending') {
      // Retry reuses external history; its successful idempotent native send is a new charged attempt.
      const quota = this.admission.quota(); r.status = 'confirmed'; r.quota.confirmedDayKey = quota.dayKey;
      this.db.sql.prepare('INSERT INTO admission_starts(reservation_id, repository_id, recipe_id, day_key) VALUES (?, ?, ?, ?)').run(r.id, r.task.spec.repositoryId, r.task.spec.recipeId, quota.dayKey);
      this.db.sql.prepare('INSERT INTO admission_clock(id, high_water_day) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET high_water_day = MAX(high_water_day, excluded.high_water_day)').run(quota.dayKey);
      r.attempt.startedAt = this.db.now(); this.write(r);
    }
    this.db.emit('attempt', r.attempt);
  }
  authority(attemptId: string, fence: number): string {
    const record = this.get(attemptId); this.fence(record, fence);
    const task = this.tasks.get(record.reservation.attempt.taskId)!; const state = this.admission.state();
    ensure(task.attemptIds.at(-1) === attemptId && task.controlMode === 'factory' && !task.archivedAt
      && !['completed', 'failed', 'cancelled'].includes(task.status), 'stale_attempt', 'Action requires the current factory-owned attempt');
    const pending = record.reservation.status === 'pending';
    continuationAllowed(task.spec, state, this.db.clock, pending, { attemptId, pending });
    if (pending) ensure(this.admission.records().attempts.filter(a => a.taskId === task.spec.id && a.retryOfAttemptId).length <= state.settings.config.limits.transientRetries, 'retry_limit', 'Automatic retry limit reached');
    return state.token;
  }
  beginAction(attemptId: string, fence: number, epoch: string, actionId: string): string {
    const record = this.get(attemptId); this.authority(attemptId, fence);
    ensure(!record.state.stopRequested, 'effect_interrupted', 'Execution was interrupted before this effect');
    ensure(!record.state.effect || record.state.effect.phase !== 'inflight', 'effect_inflight', 'An external effect is still in flight');
    ensure(!record.state.uncertain && (!record.state.active || record.state.active.epoch === epoch), 'active_time_uncertain', 'Inspect interrupted native send before replay');
    record.state.active ??= { epoch, started: this.db.clock.monotonicMs() };
    record.state.quiescent = false;
    const token = randomUUID(); record.state.effect = { actionId, token, phase: 'inflight' };
    this.db.sql.prepare('INSERT INTO lifecycle_state(attempt_id, payload) VALUES (?, ?) ON CONFLICT(attempt_id) DO UPDATE SET payload = excluded.payload').run(attemptId, JSON.stringify(record.state));
    return token;
  }
  settleEffect(attemptId: string, fence: number, token: string, phase: 'unknown' | 'accepted'): void {
    const record = this.get(attemptId); this.fence(record, fence);
    ensure(record.state.effect?.token === token, 'stale_effect', 'External completion belongs to an obsolete effect');
    ensure(phase === 'accepted' || record.state.effect.phase !== 'accepted', 'stale_effect', 'Known acceptance cannot become unknown');
    record.state.effect.phase = phase;
    if (phase === 'accepted') this.accountAccepted(record.reservation);
    this.db.sql.prepare('UPDATE lifecycle_state SET payload = ? WHERE attempt_id = ?').run(JSON.stringify(record.state), attemptId);
  }
  bindAction(actionId: string, attemptId: string, fence: number): void {
    const row = this.outbox.find(actionId); ensure(row, 'not_found', 'Action not found');
    this.db.sql.prepare('INSERT INTO lifecycle_actions(action_id, attempt_id, fence) VALUES (?, ?, ?) ON CONFLICT(action_id) DO UPDATE SET attempt_id = excluded.attempt_id, fence = excluded.fence').run(actionId, attemptId, fence);
  }
  actionBinding(actionId: string): { attemptId: string; fence: number } | undefined {
    const row = this.db.sql.prepare('SELECT * FROM lifecycle_actions WHERE action_id = ?').get(actionId);
    return row ? { attemptId: String(row.attempt_id), fence: Number(row.fence) } : undefined;
  }

  returnControl(repositoryId: string, revision: number, token: string): void {
    const state = this.admission.state(); const repo = state.repositories.find(r => r.id === repositoryId);
    ensure(state.token === token && repo?.revision === revision && repo.controlMode === 'human', 'admission_changed', 'Repository changed during return control');
    ensure(!state.activeLeases.some(lease => lease.repositoryId === repositoryId), 'repository_busy', 'Native writers must quiesce before return control');
    for (const task of state.tasks.filter(t => t.spec.repositoryId === repositoryId && t.controlMode === 'human')) {
      this.tasks.write({ ...task, controlMode: 'factory', revision: task.revision + 1, updatedAt: this.db.now() });
    }
    const updated = { ...repo, controlMode: 'factory' as const, revision: repo.revision + 1 };
    this.db.sql.prepare('UPDATE repositories SET payload = ? WHERE id = ?').run(JSON.stringify(updated), repo.id); this.db.emit('repository', updated);
  }
  bindIdentity(attemptId: string, identity: NativeIdentity): void {
    validateContract('NativeIdentity', identity);
    const record = this.get(attemptId); this.fence(record, record.reservation.lease.fence);
    const r = record.reservation;
    ensure(identity.ownerId === r.task.spec.ownerId && identity.providerId === r.task.spec.providerId
      && (!r.attempt.native || canonical(r.attempt.native) === canonical(identity)), 'identity_conflict', 'Started owner/provider and native identity are immutable');
    r.attempt.native = identity;
    ensure(r.externalIdentity, 'identity_missing', 'Native identity requires a proven original workflow');
    r.externalIdentity.native = identity; this.write(r); this.db.emit('attempt', r.attempt);
  }
  validateIdentity(attemptId: string, identity: NativeIdentity): void {
    const record = this.get(attemptId); ensure(canonical(record.reservation.attempt.native) === canonical(identity), 'identity_conflict', 'Event identity must match the persisted native execution');
  }
}
