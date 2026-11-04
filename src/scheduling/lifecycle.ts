import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Attempt, Clock, NativeIdentity, OwnerEvent, TaskSpec } from '../contracts/domain.ts';
import type { NativeOwner } from '../contracts/owner.ts';
import { validateContract } from '../contracts/schemas.ts';
import { StoreError, ensure, fingerprint } from '../storage/database.ts';
import type { FactoryStore, OutboxAction } from '../storage/store.ts';
import type { LifecycleUpdate } from '../storage/lifecycle.ts';
import type { PreparedStart, UnavailableStart } from './admission-types.ts';
import { accountActive } from './leases.ts';
import type { Quiescence } from './leases.ts';
import { hasCapabilityGrants } from './eligibility.ts';
import { lifecycleActionKinds, verifySnapshot } from './recovery.ts';

export interface TransientFailure { transient: boolean; reason: string }
export interface LifecycleDeps {
  store: FactoryStore; clock: Clock;
  owner(identity: NativeIdentity): NativeOwner;
  readiness(task: TaskSpec, attempt: Attempt): Promise<PreparedStart | UnavailableStart>;
  workspace(attempt: Attempt): Promise<boolean>;
  workflow: {
    /** Reconcile this exact execution; never create an execution during recovery. */
    snapshot(attempt: Attempt): Promise<'present' | 'absent' | 'unknown'>;
    quiesce(attempt: Attempt, key: string): Promise<Quiescence>;
    /** Resume workflow bookkeeping only. NativeOwner.send is the sole native turn driver. */
    resume(attempt: Attempt, key: string): Promise<void>;
  };
}
export interface Lifecycle {
  applyOwnerEvent(attemptId: string, event: OwnerEvent): Promise<void>;
  requestTakeover(taskId: string): Promise<void>;
  returnControl(repositoryId: string): Promise<void>;
  resumeInput(requestId: string, value: unknown, key: string): Promise<void>;
  retryTransient(attemptId: string, failure: TransientFailure): Promise<Attempt | null>;
  checkBudgets(): Promise<void>;
  dispatchPending(): Promise<{ kind: 'started'; attemptId: string } | null>;
  reconnect(): Promise<void>;
  waitForCI(attemptId: string): Promise<void>;
}

/** Trusted source controller. HTTP/worker callers receive none of its persistence capabilities. */
export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  const { store, clock } = deps; const epoch = store.getLifecycleEpoch();
  // Serializes this controller's operations; durable fences also reject other controllers' stale mutations.
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const next = tail.then(fn, fn); tail = next.catch(() => {}); return next; };
  const record = (id: string) => store.getLifecycle(id);
  const budget = () => store.getSettings().config.limits.activeMinutes * 60000;
  function account(id: string, stop: boolean): Pick<LifecycleUpdate, 'state' | 'activeDurationMs'> {
    const r = record(id); const value = accountActive(r.reservation.attempt, r.state, clock, epoch, stop, budget());
    return { state: value.state, activeDurationMs: value.duration };
  }
  async function quiet(id: string): Promise<Quiescence> {
    const r = record(id).reservation;
    ensure(r.attempt.native && r.attempt.workflow, 'identity_missing', 'Reconnect original native and workflow identities');
    const action = store.enqueueAction({ key: `lifecycle:quiesce:${id}:${r.lease.fence}`, kind: 'lifecycle.quiesce', payload: { attemptId: id, fence: r.lease.fence } });
    let native: Quiescence = 'unknown'; let workflow: Quiescence = 'unknown';
    try { native = await deps.owner(r.attempt.native).quiesce(r.attempt.native); workflow = await deps.workflow.quiesce(r.attempt, action.key); } catch { /* Unknown preserves the writer lease. */ }
    if (native === 'unknown' || workflow === 'unknown') throw new StoreError('quiescence_unknown', 'Prove both native and workflow execution stopped or waiting before release');
    store.completeAction(action.id); return native;
  }
  async function pause(id: string, status: NonNullable<LifecycleUpdate['status']>, attention?: LifecycleUpdate['attention'], human = false): Promise<void> {
    const r = record(id).reservation;
    const action = store.enqueueAction({ key: `lifecycle:pause:${id}:${r.lease.fence}:${fingerprint({ status, attention, human })}`, kind: 'lifecycle.pause', payload: { attemptId: id, fence: r.lease.fence, status, ...(attention ? { attention } : {}), human } });
    const accounted = account(id, !record(id).state.active);
    // Persist the stopped active segment even when a lost writer cannot be released.
    store.updateLifecycle(id, r.lease.fence, { ...accounted, status: 'needs_attention', ...(attention ? { attention } : {}) });
    const proof = await quiet(id);
    const stopped = account(id, true);
    store.updateLifecycle(id, r.lease.fence, { ...stopped, state: { ...stopped.state!, uncertain: stopped.activeDurationMs! >= budget() }, status, release: proof, human, ...(attention ? { attention } : {}) });
    store.completeAction(action.id);
  }

  async function reconcile(attempt: Attempt): Promise<boolean> {
    if (!attempt.native || !attempt.workflow) return false;
    try {
      const snapshot = await deps.owner(attempt.native).snapshot(attempt.native);
      if (!verifySnapshot(attempt, snapshot)) return false;
      return await deps.workflow.snapshot(attempt) === 'present';
    } catch { return false; }
  }
  async function preflight(id: string): Promise<string> {
    const attempt = record(id).reservation.attempt; const task = store.getTask(attempt.taskId)!;
    const state = store.getAdmissionState();
    ensure(hasCapabilityGrants(task.spec, state.grants, clock)
      && state.recipes.some(recipe => recipe.id === task.spec.recipeId && recipe.active)
      && state.recipeReadiness.some(r => r.recipeId === task.spec.recipeId && r.recipeRevision === task.spec.recipeRevision && r.ready)
      && state.tags.some(tag => tag.id === task.spec.tagId && !tag.archivedAt), 'capability_blocked', 'Revalidate the pinned recipe and explicit capability grants');
    const prepared = await deps.readiness(task.spec, attempt);
    ensure(prepared.ready, prepared.ready ? 'unavailable' : prepared.code, prepared.ready ? 'Unavailable' : prepared.recovery);
    ensure(prepared.baseSha === attempt.baseSha && prepared.workspacePath === attempt.workspacePath && prepared.profileId === attempt.profileId
      && await deps.workspace(attempt), 'workspace_changed', 'Revalidate the original isolated workspace; do not allocate a replacement');
    ensure(await reconcile(attempt), 'identity_missing', 'Reconnect original native and workflow history');
    return state.token;
  }
  async function runAction(action: OutboxAction): Promise<Attempt | null> {
    if (!lifecycleActionKinds.has(action.kind) || action.completedAt) return null;
    const sourceId = String(action.payload.attemptId);
    let binding = store.getLifecycleActionBinding(action.id);
    if (!binding) {
      const token = await preflight(sourceId);
      const r = store.acquireLifecycle(sourceId, token, action.kind === 'lifecycle.retry', action.id); binding = { attemptId: r.attempt.id, fence: r.lease.fence };
    }
    const r = record(binding.attemptId).reservation;
    ensure(r.lease.active && r.lease.fence === binding.fence, 'stale_fence', 'Pending action has an obsolete lease');
    // Snapshot before every replay; actions retain their original external idempotency key.
    ensure(await reconcile(r.attempt), 'identity_missing', 'Reconcile snapshots before replaying native actions');
    const token = store.getAdmissionState().token;
    const prepared = await deps.readiness(store.getTask(r.attempt.taskId)!.spec, r.attempt);
    ensure(prepared.ready && prepared.workspacePath === r.attempt.workspacePath && prepared.baseSha === r.attempt.baseSha && prepared.profileId === r.attempt.profileId && await deps.workspace(r.attempt), 'unavailable', 'Revalidate original workspace before sending');
    const state = store.getAdmissionState();
    ensure(state.token === token && !state.settings.paused && state.repositories.find(repo => repo.id === r.lease.repositoryId)?.controlMode === 'factory', 'admission_changed', 'Policy changed before native send');
    const task = store.getTask(r.attempt.taskId)!;
    ensure(hasCapabilityGrants(task.spec, state.grants, clock), 'capability_blocked', 'Capability grant was revoked');
    const lifecycleState = record(r.attempt.id).state;
    if (lifecycleState.active && lifecycleState.active.epoch !== epoch) {
      store.updateLifecycle(r.attempt.id, binding.fence, { ...account(r.attempt.id, true), status: 'needs_attention', attention: { kind: 'blocked', prompt: 'Native send outcome and active time uncertain after restart', recovery: 'Inspect original execution and reconcile the original action key' } });
      throw new StoreError('active_time_uncertain', 'Interrupted native send requires explicit reconciliation');
    }
    ensure(r.attempt.activeDurationMs < budget() && !lifecycleState.uncertain, 'active_time_limit', 'Attempt active execution budget is exhausted');
    store.beginLifecycleAction(r.attempt.id, binding.fence, epoch);
    await deps.workflow.resume(r.attempt, action.key);
    ensure(store.getAdmissionState().token === state.token, 'admission_changed', 'Policy changed during workflow resume');
    await deps.owner(r.attempt.native!).send(r.attempt.native!, action.payload.input as object, action.key);
    const accrued = account(r.attempt.id, false);
    store.finishLifecycleAction(action.id, r.attempt.id, binding.fence, accrued.state!, accrued.activeDurationMs!);
    await checkBudgets();
    return record(r.attempt.id).reservation.attempt;
  }
  async function dispatchPending(): Promise<{ kind: 'started'; attemptId: string } | null> {
    for (const action of store.pendingActions().filter(a => lifecycleActionKinds.has(a.kind))) {
      try { const attempt = await runAction(action); if (attempt) return { kind: 'started', attemptId: attempt.id }; }
      catch (error) { if (!(error instanceof StoreError)) throw error; }
    }
    return null;
  }
  async function takeover(taskId: string): Promise<void> {
    const task = store.getTask(taskId); ensure(task, 'not_found', 'Task not found');
    const repo = store.getRepository(task.spec.repositoryId)!;
    if (repo.controlMode !== 'human') store.setRepositoryControl(repo.id, 'human', repo.revision);
    const id = task.attemptIds.at(-1); ensure(id, 'identity_missing', 'No started native identity to open');
    const r = record(id).reservation;
    const action = store.enqueueAction({ key: `lifecycle:takeover:${taskId}:${id}`, kind: 'lifecycle.takeover', payload: { taskId, attemptId: id } });
    // Repository ownership applies to every native writer, including a different task than the one opened.
    for (const current of store.getReservations().filter(value => value.lease.repositoryId === repo.id && value.lease.active)) {
      await pause(current.attempt.id, 'needs_attention', undefined, true);
    }
    await quiet(id);
    ensure(store.getRepository(repo.id)?.controlMode === 'human', 'control_mode', 'Native handoff requires paused repository control');
    await deps.owner(r.attempt.native!).open(r.attempt.native!); store.completeAction(action.id);
  }
  const api: Lifecycle = {
    applyOwnerEvent: (id, event) => serial(async () => {
      validateContract('OwnerEvent', event);
      if (event.type === 'identity') store.bindLifecycleIdentity(id, event.identity);
      else store.validateLifecycleIdentity(id, event.identity);
      const r = record(id).reservation;
      if (event.type === 'snapshot') store.validateLifecycleIdentity(id, event.snapshot.identity);
      const pendingInput = event.type === 'input' ? event.input : event.type === 'snapshot' && event.snapshot.state === 'waiting' ? event.snapshot.inputs[0] : undefined;
      if (pendingInput) {
        await pause(id, 'waiting_input', { kind: 'input', prompt: pendingInput.prompt, recovery: 'Answer this request to continue the original native session', inputSchema: pendingInput.schema, nativeInputId: pendingInput.id }); return;
      }
      if (event.type === 'connection_lost' || (event.type === 'snapshot' && event.snapshot.state === 'lost')) {
        store.updateLifecycle(id, r.lease.fence, { ...account(id, !record(id).state.active), status: 'needs_attention', state: { ...account(id, !record(id).state.active).state!, uncertain: true }, attention: { kind: 'blocked', prompt: 'Native connection lost', recovery: 'Reconnect original session and prove quiescence; lease expiry does not release ownership' } }); return;
      }
      const active = event.type === 'activity' ? event.active : event.type === 'snapshot' ? event.snapshot.state === 'active' : undefined;
      store.updateLifecycle(id, r.lease.fence, { ...(active !== undefined ? account(id, !active) : {}), ...(event.type === 'usage' ? { usage: event.usage } : event.type === 'snapshot' && event.snapshot.usage ? { usage: event.snapshot.usage } : {}) });
      // Idle changes activity only; TaskResult/closeout owns completion.
      await checkBudgets();
    }),
    requestTakeover: taskId => serial(() => takeover(taskId)),
    returnControl: repositoryId => serial(async () => {
      const repo = store.getRepository(repositoryId); ensure(repo, 'not_found', 'Repository not found');
      ensure(repo.controlMode === 'human', 'control_mode', 'Repository is not under human control');
      const attempts = store.getReservations().filter(r => r.lease.repositoryId === repositoryId && r.status === 'confirmed');
      for (const r of attempts.filter(r => store.getTask(r.attempt.taskId)!.attemptIds.at(-1) === r.attempt.id && !['completed', 'failed', 'cancelled'].includes(store.getTask(r.attempt.taskId)!.status))) {
        if (r.lease.active) await pause(r.attempt.id, 'needs_attention', undefined, true);
        else await quiet(r.attempt.id);
        const token = await preflight(r.attempt.id);
        ensure(store.getAdmissionState().token === token, 'admission_changed', 'Policy changed while returning control');
      }
      store.returnLifecycleControl(repositoryId, repo.revision, store.getAdmissionState().token);
      // An explicit return cancels an unfinished open request; reconnect must not take control back.
      for (const action of store.pendingActions().filter(a => a.kind === 'lifecycle.takeover' && store.getTask(String(a.payload.taskId))?.spec.repositoryId === repositoryId)) store.completeAction(action.id);
    }),
    resumeInput: (requestId, value, key) => serial(async () => {
      const request = store.snapshot().attention.find(a => a.id === requestId);
      ensure(request, 'not_found', 'Attention request not found');
      let valid = false;
      try { valid = new Ajv2020({ strict: false }).compile(request.inputSchema)(value) as boolean; } catch { /* Malformed schemas cannot admit input. */ }
      ensure(valid, 'invalid_answer', 'Answer does not match the trusted native input schema');
      const action = store.queueLifecycleReply(requestId, value, key);
      if (!action.completedAt) { try { await runAction(action); } catch (error) { if (!(error instanceof StoreError)) throw error; } }
    }),
    retryTransient: (id, failure) => serial(async () => {
      const r = record(id).reservation; const task = store.getTask(r.attempt.taskId)!;
      ensure(task.attemptIds.at(-1) === id, 'stale_attempt', 'Retry requires the current attempt');
      const attempts = store.snapshot().attempts.filter(a => a.taskId === task.spec.id && a.retryOfAttemptId);
      const allowed = failure.transient && attempts.length < store.getSettings().config.limits.transientRetries;
      if (r.lease.active) await pause(id, allowed ? 'failed' : 'needs_attention', { kind: 'error', prompt: failure.reason, recovery: allowed ? 'Retry original native session' : 'Inspect failure; automatic retries exhausted' });
      if (!allowed) return null;
      const action = store.enqueueAction({ key: `lifecycle:retry:${id}`, kind: 'lifecycle.retry', payload: { attemptId: id, input: { retryOfAttemptId: id, reason: failure.reason } } });
      try { return await runAction(action); } catch (error) { if (!(error instanceof StoreError)) throw error; return null; }
    }),
    checkBudgets: () => serial(checkBudgets),
    dispatchPending: () => serial(dispatchPending),
    reconnect: () => serial(async () => {
      for (const r of store.getReservations()) {
        if (r.status === 'pending' && !r.attempt.retryOfAttemptId && r.externalIdentity) store.confirmStart(r.id, r.externalIdentity);
        if (r.lease.active && r.status === 'confirmed' && r.attempt.native) {
          if (!await reconcile(r.attempt)) continue;
          const active = record(r.attempt.id).state.active;
          if (active && active.epoch !== epoch) await pause(r.attempt.id, 'needs_attention', { kind: 'blocked', prompt: 'Active time uncertain after restart', recovery: 'Inspect original execution before explicit continuation' });
        }
      }
      for (const action of store.pendingActions().filter(a => a.kind === 'lifecycle.pause')) {
        const id = String(action.payload.attemptId); const r = record(id).reservation;
        if (!r.lease.active || r.lease.fence !== action.payload.fence) { store.completeAction(action.id); continue; }
        if (!await reconcile(r.attempt)) continue;
        try { await pause(id, action.payload.status as NonNullable<LifecycleUpdate['status']>, action.payload.attention as LifecycleUpdate['attention'], Boolean(action.payload.human)); }
        catch (error) { if (!(error instanceof StoreError)) throw error; }
      }
      for (const action of store.pendingActions().filter(a => a.kind === 'lifecycle.takeover')) {
        const r = record(String(action.payload.attemptId)).reservation;
        if (!await reconcile(r.attempt)) continue;
        try { await takeover(String(action.payload.taskId)); } catch (error) { if (!(error instanceof StoreError)) throw error; }
      }
      await dispatchPending();
    }),
    waitForCI: id => serial(() => pause(id, 'waiting_ci')),
  };
  async function checkBudgets(): Promise<void> {
    for (const r of store.getReservations().filter(r => r.lease.active && r.status === 'confirmed')) {
      const accrued = account(r.attempt.id, !record(r.attempt.id).state.active);
      store.updateLifecycle(r.attempt.id, r.lease.fence, accrued);
      if (accrued.activeDurationMs! >= budget()) await pause(r.attempt.id, 'needs_attention', { kind: 'blocked', prompt: 'Active execution time limit reached', recovery: 'Inspect the stopped native execution' });
    }
  }
  return api;
}
