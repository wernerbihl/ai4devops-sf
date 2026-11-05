import { randomUUID } from 'node:crypto';
import type { AttentionRequest, RecipeSummary, Repository, Settings, Tag, TaskRecord } from '../contracts/domain.ts';
import { validateContract } from '../contracts/schemas.ts';
import type { AdmissionCandidate, AdmissionRecords, AdmissionState, ExternalStartIdentity, QuotaState, RecipeReadiness, Reservation, RotationState } from '../scheduling/admission-types.ts';
import { compatibleTask, hasCapabilityGrants, repositoryEligible, taskEligible } from '../scheduling/eligibility.ts';
import { effectiveDayKey, quotaAvailable } from '../scheduling/quotas.ts';
import { selectAutomaticTag } from '../scheduling/rotation.ts';
import type { WeightSnapshot } from '../scheduling/rotation-types.ts';
import { StoreDatabase, canonical, ensure, fingerprint } from './database.ts';
import type { RecipeStorage } from './recipes.ts';
import type { TaskStorage } from './tasks.ts';

interface StoredReservation extends Reservation { basis: AdmissionCandidate; rotationAtReservation: RotationState | null }
export class AdmissionStorage {
  private db: StoreDatabase;
  private recipes: RecipeStorage;
  private tasks: TaskStorage;
  constructor(db: StoreDatabase, recipes: RecipeStorage, tasks: TaskStorage) { this.db = db; this.recipes = recipes; this.tasks = tasks; }
  /** Called inside entity writes, so every effective membership/priority change advances its durable version. */
  syncRotations(): void {
    const tags = this.db.all<Tag>('tags').filter(tag => !tag.archivedAt);
    for (const repo of this.db.all<Repository>('repositories')) {
      const entries = tags.map((tag, createdOrder) => ({ tagId: tag.id, value: repo.weights[tag.id] ?? 0, createdOrder }));
      const hash = fingerprint(entries);
      const old = this.db.sql.prepare('SELECT fingerprint, weights_version FROM admission_rotations WHERE repository_id = ?').get(repo.id);
      if (old?.fingerprint === hash) continue;
      const revision = old ? Number(old.weights_version) + 1 : 1;
      this.db.sql.prepare(`INSERT INTO admission_rotations(repository_id, fingerprint, weights_version, weights) VALUES (?, ?, ?, ?)
        ON CONFLICT(repository_id) DO UPDATE SET fingerprint = excluded.fingerprint, weights_version = excluded.weights_version, weights = excluded.weights`).run(repo.id, hash, revision, JSON.stringify({ revision, entries }));
    }
  }
  rotation(repositoryId: string): RotationState {
    const row = this.db.sql.prepare('SELECT weights, cursor FROM admission_rotations WHERE repository_id = ?').get(repositoryId);
    ensure(row, 'not_found', 'Repository rotation not found');
    return { weights: JSON.parse(String(row.weights)) as WeightSnapshot, cursor: row.cursor ? JSON.parse(String(row.cursor)) : null };
  }
  reservations(): StoredReservation[] {
    return this.db.sql.prepare('SELECT payload FROM admission_reservations ORDER BY rowid').all().map(row => JSON.parse(String(row.payload)) as StoredReservation);
  }
  private require(id: string): StoredReservation {
    const row = this.db.sql.prepare('SELECT payload FROM admission_reservations WHERE id = ?').get(id);
    ensure(row, 'not_found', 'Reservation not found'); return JSON.parse(String(row.payload)) as StoredReservation;
  }
  private write(value: StoredReservation): void {
    this.db.sql.prepare(`INSERT INTO admission_reservations(id, task_id, repository_id, status, lease_active, fence, payload) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, lease_active = excluded.lease_active, payload = excluded.payload`).run(value.id, value.task.spec.id, value.task.spec.repositoryId, value.status, value.lease.active ? 1 : 0, value.lease.fence, JSON.stringify(value));
  }
  quota(): QuotaState {
    const high = this.db.sql.prepare('SELECT high_water_day FROM admission_clock WHERE id = 1').get();
    const dayKey = effectiveDayKey(this.db.clock.localDayKey(this.db.clock.wallNow()), high ? String(high.high_water_day) : undefined);
    return { dayKey,
      confirmed: Number(this.db.sql.prepare('SELECT COUNT(*) AS count FROM admission_starts WHERE day_key = ?').get(dayKey)!.count),
      // Uncertain starts remain held across midnight until reconciliation, rather than buying a new allowance.
      pending: Number(this.db.sql.prepare("SELECT COUNT(*) AS count FROM admission_reservations WHERE status = 'pending'").get()!.count),
    };
  }
  private advanceDay(dayKey: string): void {
    this.db.sql.prepare('INSERT INTO admission_clock(id, high_water_day) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET high_water_day = MAX(high_water_day, excluded.high_water_day)').run(dayKey);
  }
  state(): AdmissionState {
    const repositories = this.db.all<Repository>('repositories');
    const starts = this.db.sql.prepare('SELECT repository_id, recipe_id, MAX(sequence) AS sequence FROM admission_starts GROUP BY repository_id, recipe_id').all();
    const repositoryService: Record<string, number> = {}; const recipeService: Record<string, number> = {};
    for (const row of starts) {
      const id = String(row.repository_id); const sequence = Number(row.sequence);
      repositoryService[id] = Math.max(repositoryService[id] ?? 0, sequence);
      recipeService[`${id}:${String(row.recipe_id)}`] = sequence;
    }
    const data = {
      settings: this.db.read<Settings>('settings', 1)!, repositories,
      recipeReadiness: this.readiness(),
      tags: this.db.all<Tag>('tags'), recipes: this.db.all<RecipeSummary>('recipes'), tasks: this.db.all<TaskRecord>('tasks'),
      grants: this.db.all<import('../contracts/domain.ts').Grant>('grants'),
      rotations: Object.fromEntries(repositories.map(repo => [repo.id, this.rotation(repo.id)])), repositoryService, recipeService,
      activeLeases: this.reservations().filter(value => value.lease.active).map(value => value.lease), quota: this.quota(),
    };
    return { ...data, token: fingerprint(data) };
  }
  records(): AdmissionRecords {
    return { attempts: this.reservations().map(value => value.attempt), attention: this.db.sql.prepare('SELECT payload FROM admission_attention ORDER BY rowid').all().map(row => JSON.parse(String(row.payload)) as AttentionRequest) };
  }
  private readiness(): RecipeReadiness[] {
    return this.db.sql.prepare('SELECT payload FROM recipe_readiness ORDER BY rowid').all().map(row => JSON.parse(String(row.payload)) as RecipeReadiness);
  }
  setReadiness(recipeId: string, revision: string, readiness: { hash: string; ready: boolean; reasons: string[] }, expectedRevision: number): RecipeSummary {
    const old = this.recipes.summary(recipeId); const recipe = this.recipes.revision(recipeId, revision);
    ensure(old && recipe && recipe.hash === readiness.hash, 'revision_conflict', 'Readiness must match an exact immutable recipe revision and hash');
    ensure(old.revision === expectedRevision, 'revision_conflict', 'Recipe readiness revision conflict');
    ensure(readiness.ready || readiness.reasons.length > 0, 'invalid_readiness', 'Blocked readiness requires a reason');
    const value = validateContract('RecipeSummary', { ...old, ...(old.currentRevision === revision ? { ready: readiness.ready, reasons: readiness.reasons } : {}), revision: old.revision + 1 });
    const record: RecipeReadiness = { recipeId, recipeRevision: revision, ...readiness };
    this.db.sql.prepare(`INSERT INTO recipe_readiness(recipe_id, recipe_revision, recipe_hash, payload) VALUES (?, ?, ?, ?)
      ON CONFLICT(recipe_id, recipe_revision, recipe_hash) DO UPDATE SET payload = excluded.payload`).run(recipeId, revision, readiness.hash, JSON.stringify(record));
    this.db.sql.prepare('UPDATE recipes SET payload = ? WHERE id = ?').run(JSON.stringify(value), recipeId);
    this.db.emit('recipe', value); return value;
  }
  private readyRevision(state: AdmissionState, spec: import('../contracts/domain.ts').TaskSpec): boolean {
    const recipe = this.recipes.revision(spec.recipeId, spec.recipeRevision);
    return !!recipe && state.recipeReadiness.some(record => record.recipeId === spec.recipeId && record.recipeRevision === spec.recipeRevision && record.hash === recipe.hash && record.ready);
  }
  attention(taskId: string, expectedRevision: number, code: string, recovery: string): void {
    const task = this.tasks.get(taskId);
    ensure(task && task.revision === expectedRevision && task.status === 'queued', 'revision_conflict', 'Task changed during preflight');
    ensure(!this.state().activeLeases.some(lease => lease.taskId === taskId), 'task_reserved', 'Reserved tasks need launch reconciliation');
    this.tasks.write({ ...task, status: 'needs_attention', reason: code, recovery, revision: task.revision + 1, updatedAt: this.db.now() });
    const value = validateContract('AttentionRequest', { id: randomUUID(), taskId, repositoryId: task.spec.repositoryId, source: 'factory', kind: 'blocked', prompt: code, recovery, inputSchema: {}, status: 'open', createdAt: this.db.now(), revision: 1 });
    this.db.sql.prepare('INSERT INTO admission_attention(id, payload) VALUES (?, ?)').run(value.id, JSON.stringify(value));
    this.db.emit('attention', value);
  }
  reserve(candidate: AdmissionCandidate, dayKey: string): Reservation {
    const state = this.state(); const spec = validateContract('TaskSpec', candidate.task);
    ensure(state.token === candidate.stateToken, 'admission_changed', 'Admission state changed during preflight');
    ensure(!state.settings.paused, 'paused', 'Factory is paused');
    ensure(state.activeLeases.length < state.settings.config.limits.concurrency, 'capacity', 'Global run capacity is occupied');
    ensure(quotaAvailable(state.quota, state.settings.config.limits.startsPerDay), 'day_limit', 'Local-day start limit reached');
    ensure(dayKey === this.db.clock.localDayKey(this.db.clock.wallNow()), 'day_changed', 'Local calendar day changed during preflight');
    const repository = state.repositories.find(repo => repo.id === spec.repositoryId);
    ensure(repository && repository.revision === candidate.repositoryRevision && repositoryEligible(repository, spec.source === 'manual', state), 'repository_changed', 'Repository is no longer eligible');
    ensure(state.settings.revision === candidate.settingsRevision, 'settings_changed', 'Settings changed during preflight');
    const recipeSummary = state.recipes.find(recipe => recipe.id === spec.recipeId);
    ensure(recipeSummary && recipeSummary.revision === candidate.recipeSummaryRevision && recipeSummary.active && this.readyRevision(state, spec) && (candidate.taskRevision !== null || recipeSummary.currentRevision === spec.recipeRevision), 'recipe_changed', 'Recipe is no longer ready at the selected revision');
    const recipe = this.recipes.revision(spec.recipeId, spec.recipeRevision)!;
    ensure(compatibleTask(spec, recipe) && hasCapabilityGrants(spec, state.grants, this.db.clock), 'capability_blocked', 'Recipe execution requires current capability grants');
    const old = this.tasks.get(spec.id);
    if (candidate.taskRevision !== null) {
      ensure(old && old.revision === candidate.taskRevision && canonical(old.spec) === canonical(spec) && taskEligible(old, state), 'task_changed', 'Task changed during preflight');
    } else {
      ensure(!old && spec.source === 'automatic', 'invalid_candidate', 'Fresh admission must be a new automatic task');
    }
    this.checkProposedRotation(candidate, state);
    const prepared = candidate.prepared;
    ensure(prepared.ready && [prepared.baseSha, prepared.workspacePath, prepared.profileId].every(value => typeof value === 'string' && value.trim()), 'invalid_preflight', 'Start requires verified workspace and isolation profile');
    if (!old) this.tasks.insertAutomatic(spec);
    const task = this.tasks.get(spec.id)!;
    const previousFence = this.db.sql.prepare('SELECT fence FROM admission_fences WHERE repository_id = ?').get(repository.id);
    const fence = previousFence ? Number(previousFence.fence) + 1 : 1;
    this.db.sql.prepare('INSERT INTO admission_fences(repository_id, fence) VALUES (?, ?) ON CONFLICT(repository_id) DO UPDATE SET fence = excluded.fence').run(repository.id, fence);
    const id = randomUUID(); const attemptId = randomUUID();
    const attempt = validateContract('Attempt', { id: attemptId, taskId: spec.id, recipeRevision: spec.recipeRevision,
      baseSha: prepared.baseSha, workspacePath: prepared.workspacePath, profileId: prepared.profileId, fence, status: 'queued', createdAt: this.db.now(), activeDurationMs: 0 });
    const reservedTask = this.tasks.write({ ...task, attemptIds: [...task.attemptIds, attemptId], revision: task.revision + 1, updatedAt: this.db.now() });
    const reservation: StoredReservation = { id, status: 'pending', task: reservedTask, attempt,
      quota: { dayKey: state.quota.dayKey }, lease: { repositoryId: repository.id, taskId: spec.id, attemptId, fence, active: true },
      proposedRotation: candidate.proposedRotation, basis: candidate, rotationAtReservation: spec.source === 'manual' ? null : state.rotations[repository.id]! };
    this.write(reservation); this.advanceDay(state.quota.dayKey); this.db.emit('attempt', attempt);
    return reservation;
  }
  private checkProposedRotation(candidate: AdmissionCandidate, state: AdmissionState): void {
    if (candidate.task.source === 'manual') {
      ensure(candidate.proposedRotation === null, 'invalid_rotation', 'Manual starts do not consume rotation'); return;
    }
    const rotation = state.rotations[candidate.task.repositoryId]!;
    const choice = selectAutomaticTag(rotation.weights, rotation.cursor, new Set([candidate.task.tagId]));
    ensure(choice && choice.tagId === candidate.task.tagId && canonical(choice.cursorAfterStart) === canonical(candidate.proposedRotation), 'rotation_changed', 'Automatic rotation changed before reservation');
  }
  /** Persist proven identity independently, before atomic accounting, for crash-safe reconciliation. */
  rememberExternal(id: string, externalIdentity: ExternalStartIdentity): void {
    validateContract('WorkflowIdentity', externalIdentity.workflow);
    if (externalIdentity.native) validateContract('NativeIdentity', externalIdentity.native);
    const reservation = this.require(id);
    ensure(reservation.status !== 'released', 'released_reservation', 'A released reservation cannot have started');
    ensure(!reservation.externalIdentity || (canonical(reservation.externalIdentity.workflow) === canonical(externalIdentity.workflow)
      && (!externalIdentity.native || !reservation.externalIdentity.native || canonical(reservation.externalIdentity.native) === canonical(externalIdentity.native))), 'identity_conflict', 'External start identity is immutable');
    if (externalIdentity.native) ensure(externalIdentity.native.ownerId === reservation.task.spec.ownerId && externalIdentity.native.providerId === reservation.task.spec.providerId, 'identity_conflict', 'Native owner/provider must match the selected task');
    reservation.externalIdentity = { ...externalIdentity, ...(reservation.externalIdentity?.native ? { native: reservation.externalIdentity.native } : {}) }; this.write(reservation);
  }
  confirm(id: string, externalIdentity: ExternalStartIdentity): void {
    this.rememberExternal(id, externalIdentity);
    const reservation = this.require(id);
    if (reservation.status === 'confirmed') return;
    const state = this.state(); const spec = reservation.task.spec;
    const repository = state.repositories.find(repo => repo.id === spec.repositoryId)!;
    const task = this.tasks.get(spec.id)!;
    const summary = this.recipes.summary(spec.recipeId)!;
    ensure(reservation.lease.active, 'inactive_lease', 'Proven start must retain its fenced lease');
    const taskChanged = task.revision !== reservation.task.revision || task.status !== 'queued' || canonical(task.spec) !== canonical(spec);
    const revokedInFlight = state.settings.paused || state.activeLeases.length > state.settings.config.limits.concurrency
      || state.quota.confirmed + state.quota.pending > state.settings.config.limits.startsPerDay
      || repository.controlMode !== 'factory' || (spec.source !== 'manual' && !repository.active)
      || !summary.active || !this.readyRevision(state, spec)
      || !state.tags.some(tag => tag.id === spec.tagId && !tag.archivedAt)
      || !hasCapabilityGrants(spec, state.grants, this.db.clock) || taskChanged;
    const rotation = state.rotations[repository.id]!;
    const rotationChanged = spec.source !== 'manual' && (rotation.weights.revision !== reservation.proposedRotation!.weightsVersion
      || canonical(rotation.cursor) !== canonical(reservation.rotationAtReservation!.cursor));
    // Launch is already proven: account it once even if authority changed while awaiting the reply.
    // A stale proposal must never reset a newer policy/cursor.
    if (spec.source !== 'manual' && !rotationChanged) this.db.sql.prepare('UPDATE admission_rotations SET cursor = ? WHERE repository_id = ?').run(JSON.stringify(reservation.proposedRotation), repository.id);
    if (revokedInFlight || rotationChanged) this.launchedAttention(reservation, 'Admission policy changed while external start was in flight', 'Inspect and quiesce the started execution before returning this repository to factory control');
    reservation.status = 'confirmed'; reservation.quota.confirmedDayKey = state.quota.dayKey;
    reservation.attempt = validateContract('Attempt', { ...reservation.attempt, ...externalIdentity, status: 'running', startedAt: this.db.now() });
    reservation.task = taskChanged ? task : this.tasks.write({ ...task, status: 'running', revision: task.revision + 1, updatedAt: this.db.now() });
    this.write(reservation); this.advanceDay(state.quota.dayKey);
    this.db.sql.prepare('INSERT INTO lifecycle_state(attempt_id, payload) VALUES (?, ?) ON CONFLICT(attempt_id) DO NOTHING').run(reservation.attempt.id, JSON.stringify({ segments: [], active: { epoch: this.db.epoch, started: this.db.clock.monotonicMs() }, quiescent: false }));
    this.db.sql.prepare('INSERT INTO admission_starts(reservation_id, repository_id, recipe_id, day_key) VALUES (?, ?, ?, ?)').run(id, repository.id, spec.recipeId, state.quota.dayKey);
    const updated = { ...repository, lastServicedAt: this.db.now(), currentTaskId: spec.id, revision: repository.revision + 1 };
    this.db.sql.prepare('UPDATE repositories SET payload = ? WHERE id = ?').run(JSON.stringify(updated), repository.id);
    this.db.emit('attempt', reservation.attempt); this.db.emit('repository', updated);
  }
  private launchedAttention(reservation: Reservation, prompt: string, recovery: string): void {
    const value = validateContract('AttentionRequest', { id: randomUUID(), taskId: reservation.task.spec.id, attemptId: reservation.attempt.id,
      repositoryId: reservation.lease.repositoryId, source: 'factory', kind: 'blocked', prompt, recovery, inputSchema: {}, status: 'open', createdAt: this.db.now(), revision: 1 });
    this.db.sql.prepare('INSERT INTO admission_attention(id, payload) VALUES (?, ?)').run(value.id, JSON.stringify(value));
    this.db.emit('attention', value);
  }
  releaseUnstarted(id: string): void {
    const reservation = this.require(id);
    ensure(reservation.status !== 'confirmed' && !reservation.externalIdentity, 'already_started', 'Proven starts must be reconciled, never released as unstarted');
    if (reservation.status === 'released') return;
    reservation.status = 'released'; reservation.lease.active = false;
    reservation.attempt = { ...reservation.attempt, status: 'cancelled', endedAt: this.db.now() };
    this.write(reservation); this.db.emit('attempt', reservation.attempt);
  }
  /** Trusted C4 seam: invoke only after terminal task transition and external quiescence, never for uncertain starts. */
  releaseLease(id: string, fence: number): void {
    const reservation = this.require(id);
    ensure(reservation.lease.fence === fence, 'stale_fence', 'Lease release requires its current fence');
    ensure(reservation.status === 'confirmed', 'unconfirmed_start', 'Pending starts require reconciliation');
    const task = this.tasks.get(reservation.task.spec.id)!;
    ensure(['completed', 'failed', 'cancelled'].includes(task.status), 'live_task', 'Live work retains its admission lease');
    if (!reservation.lease.active) return;
    reservation.lease.active = false; reservation.task = task;
    reservation.attempt = { ...reservation.attempt, status: task.status, endedAt: this.db.now() };
    this.write(reservation); this.db.emit('attempt', reservation.attempt);
    const repository = this.db.read<Repository>('repositories', task.spec.repositoryId)!;
    if (repository.currentTaskId === task.spec.id) {
      const { currentTaskId: _currentTaskId, ...rest } = repository;
      const updated = { ...rest, revision: repository.revision + 1 };
      this.db.sql.prepare('UPDATE repositories SET payload = ? WHERE id = ?').run(JSON.stringify(updated), repository.id);
      this.db.emit('repository', updated);
    }
  }
}
