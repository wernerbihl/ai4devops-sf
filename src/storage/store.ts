import { dirname, resolve } from 'node:path';
import type { ActorScope, Clock, CreateTaskRequest, FactorySnapshot, FindingInput, Grant, RecipePatch, RecipeRevision, Repository, RepositoryPatch, Settings, SettingsPatch, TagCreate, TagPatch, TaskPatch, TaskStatus, WeightsPatch } from '../contracts/domain.ts';
import { defaultConfig } from '../contracts/defaults.ts';
import { validateContract } from '../contracts/schemas.ts';
import { StoreDatabase, ensure, systemClock } from './database.ts';
import { BrokerStorage } from './broker.ts';
import { LifecycleStorage } from './lifecycle.ts';
import type { LifecycleUpdate, LifecycleRecord } from './lifecycle.ts';
import type { LifecycleState } from '../scheduling/leases.ts';
import { AdmissionStorage } from './admission.ts';
import type { AdmissionCandidate, ExternalStartIdentity, Reservation } from '../scheduling/admission-types.ts';
import { ApiRequests } from './api-requests.ts';
import type { ApiRequestResult } from './api-requests.ts';
import { Outbox } from './outbox.ts';
import type { ActionInput } from './outbox.ts';
import { RecipeStorage } from './recipes.ts';
import { TagStorage } from './tags.ts';
import { TaskStorage } from './tasks.ts';
import type { RecipeMaterializer } from './tasks.ts';

export { StoreError } from './database.ts';
export type { ActionInput, OutboxAction } from './outbox.ts';
export type { MaterializationContext, RecipeMaterializer, Submission } from './tasks.ts';
export interface OpenStoreOptions { clock?: Clock; materialize?: RecipeMaterializer }
export interface RepositoryCreate { id: string; name: string; url: string; active?: boolean; weights?: Record<string, number> }

/** Trusted backend storage. Never pass this object or its admin methods to a worker/browser. */
export class FactoryStore {
  private db: StoreDatabase;
  private tags: TagStorage;
  private recipes: RecipeStorage;
  private tasks: TaskStorage;
  private outbox: Outbox;
  private apiRequests: ApiRequests;
  private admission: AdmissionStorage;
  private lifecycle: LifecycleStorage;
  readonly broker: BrokerStorage;
  private closed = false;
  constructor(path: string, options: OpenStoreOptions = {}) {
    this.db = new StoreDatabase(path, options.clock ?? systemClock);
    this.broker = new BrokerStorage(this.db);
    this.tags = new TagStorage(this.db);
    this.recipes = new RecipeStorage(this.db);
    this.tasks = new TaskStorage(this.db, this.recipes, options.materialize);
    this.outbox = new Outbox(this.db);
    this.apiRequests = new ApiRequests(this.db);
    this.admission = new AdmissionStorage(this.db, this.recipes, this.tasks);
    this.lifecycle = new LifecycleStorage(this.db, this.admission, this.tasks, this.outbox);
    try {
      this.db.transaction(() => {
        if (this.db.read('settings', 1)) return;
        const settings: Settings = { config: defaultConfig(path === ':memory:' ? ':memory:' : dirname(resolve(path))), paused: false, revision: 1 };
        this.db.sql.prepare('INSERT INTO settings(id, payload) VALUES (1, ?)').run(JSON.stringify(settings));
        this.db.emit('settings', settings);
        this.tags.seed();
      });
      this.db.transaction(() => this.admission.syncRotations());
    } catch (error) { this.close(); throw error; }
  }
  close(): void { if (!this.closed) { this.db.sql.close(); this.closed = true; } }
  snapshot(): FactorySnapshot {
    // A read transaction gives the event cursor and every entity one coherent SQLite snapshot.
    const nested = this.db.sql.isTransaction;
    if (!nested) this.db.sql.exec('BEGIN');
    try {
      const settings = this.getSettings();
      const sequence = Number(this.db.sql.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events').get()!.sequence);
      const value = validateContract('FactorySnapshot', {
        schemaVersion: 1, sequence, cursor: String(sequence), at: this.db.now(), config: settings.config, paused: settings.paused,
        health: { schemaVersion: 1, ready: false, reasons: ['Runtime readiness has not been evaluated'], version: '0.1.0' },
        auth: { status: 'unavailable', reasons: ['GitHub authentication has not been evaluated'] },
        tags: this.db.all('tags'), repositories: this.db.all('repositories'), recipes: this.db.all('recipes'), tasks: this.db.all('tasks'),
        ...this.admission.records(),
      });
      if (!nested) this.db.sql.exec('COMMIT'); return value;
    } catch (error) { if (!nested) this.db.sql.exec('ROLLBACK'); throw error; }
  }
  getSettings(): Settings { return this.db.read<Settings>('settings', 1)!; }
  patchSettings(patch: SettingsPatch, expectedRevision: number): Settings {
    validateContract('SettingsPatch', patch);
    return this.db.transaction(() => {
      const old = this.getSettings();
      ensure(old.revision === expectedRevision, 'revision_conflict', 'Settings revision conflict');
      const { paused, ...config } = patch;
      const value = validateContract('Settings', { config: { ...old.config, ...config }, paused: paused ?? old.paused, revision: old.revision + 1 });
      this.db.sql.prepare('UPDATE settings SET payload = ? WHERE id = 1').run(JSON.stringify(value));
      this.db.emit('settings', value); return value;
    });
  }
  createRepository(input: RepositoryCreate): Repository {
    return this.db.transaction(() => {
      const value = validateContract('Repository', { ...input, active: input.active ?? false, controlMode: 'factory', revision: 1, createdAt: this.db.now(), weights: input.weights ?? {} });
      ensure(!this.db.read('repositories', value.id), 'duplicate_repository', 'Repository already exists');
      this.validateWeights(value.weights);
      this.db.sql.prepare('INSERT INTO repositories(id, payload) VALUES (?, ?)').run(value.id, JSON.stringify(value));
      for (const [tagId, weight] of Object.entries(value.weights)) this.db.sql.prepare('INSERT INTO repository_weights(repository_id, tag_id, value) VALUES (?, ?, ?)').run(value.id, tagId, weight);
      this.admission.syncRotations();
      this.db.emit('repository', value); return value;
    });
  }
  getRepository(id: string): Repository | undefined { return this.db.read('repositories', id); }
  patchRepository(id: string, patch: RepositoryPatch, expectedRevision: number): Repository {
    validateContract('RepositoryPatch', patch);
    return this.db.transaction(() => {
      const old = this.repositoryAtRevision(id, expectedRevision);
      const value = { ...old, ...patch, revision: old.revision + 1 };
      if (value.defaultOwnerId === null) delete value.defaultOwnerId;
      return this.writeRepository(validateContract('Repository', value));
    });
  }
  patchWeights(id: string, patch: WeightsPatch, expectedRevision: number): Repository {
    validateContract('WeightsPatch', patch);
    return this.db.transaction(() => {
      const old = this.repositoryAtRevision(id, expectedRevision);
      this.validateWeights(patch.weights);
      for (const [tagId, value] of Object.entries(patch.weights)) this.db.sql.prepare('INSERT INTO repository_weights(repository_id, tag_id, value) VALUES (?, ?, ?) ON CONFLICT(repository_id, tag_id) DO UPDATE SET value = excluded.value').run(id, tagId, value);
      const updated = this.writeRepository({ ...old, weights: { ...old.weights, ...patch.weights }, revision: old.revision + 1 });
      this.admission.syncRotations(); return updated;
    });
  }
  private validateWeights(weights: Record<string, number>): void {
    for (const tagId of Object.keys(weights)) ensure(!this.tags.require(tagId).archivedAt, 'archived_tag', 'Weights require active tags');
  }
  private repositoryAtRevision(id: string, expectedRevision: number): Repository {
    const value = this.getRepository(id);
    ensure(value, 'not_found', 'Repository not found');
    ensure(value.revision === expectedRevision, 'revision_conflict', 'Repository revision conflict'); return value;
  }
  private writeRepository(value: Repository): Repository {
    validateContract('Repository', value);
    this.db.sql.prepare('UPDATE repositories SET payload = ? WHERE id = ?').run(JSON.stringify(value), value.id);
    this.db.emit('repository', value); return value;
  }
  createTag(input: TagCreate) { return this.db.transaction(() => this.withRotationSync(() => this.tags.create(input))); }
  patchTag(id: string, input: TagPatch, expectedRevision: number) { return this.db.transaction(() => this.tags.patch(id, input, expectedRevision)); }
  deleteTag(id: string, expectedRevision: number): void { this.db.transaction(() => this.withRotationSync(() => this.tags.delete(id, expectedRevision))); }
  archiveTag(id: string, replacementId: string, expectedRevision?: number): void { this.db.transaction(() => this.withRotationSync(() => this.tags.archive(id, replacementId, this.recipes, value => this.tasks.write(value), expectedRevision))); }
  saveRecipeRevision(input: RecipeRevision, expectedRevision?: number) { return this.db.transaction(() => this.recipes.save(input, expectedRevision)); }
  getRecipe(id: string) { return this.recipes.current(id); }
  getRecipeRevision(id: string, revision: string) { return this.recipes.revision(id, revision); }
  patchRecipe(id: string, patch: RecipePatch, expectedRevision: number) { return this.db.transaction(() => this.recipes.patch(id, patch, expectedRevision)); }
  /** Only trusted lifecycle/admission code may register or advance an authenticated worker fence. */
  registerActor(actor: ActorScope, taskId: string): void { this.db.transaction(() => this.tasks.registerActor(actor, taskId)); }
  saveGrant(input: Grant): void {
    validateContract('Grant', input);
    this.db.transaction(() => {
      ensure(this.recipes.revision(input.recipeId, input.recipeRevision), 'not_found', 'Grant recipe revision does not exist');
      for (const id of input.repositoryIds) ensure(this.getRepository(id), 'not_found', 'Grant repository does not exist');
      ensure(!this.db.read('grants', input.id), 'immutable_grant', 'Grant identity is immutable');
      this.db.sql.prepare('INSERT INTO grants(id, recipe_id, recipe_revision, payload) VALUES (?, ?, ?, ?)').run(input.id, input.recipeId, input.recipeRevision, JSON.stringify(input));
    });
  }
  revokeGrant(id: string): void {
    this.db.transaction(() => {
      const grant = this.db.read<Grant>('grants', id);
      ensure(grant, 'not_found', 'Grant not found');
      this.db.sql.prepare('UPDATE grants SET payload = ? WHERE id = ?').run(JSON.stringify({ ...grant, revokedAt: grant.revokedAt ?? this.db.now() }), id);
    });
  }
  /** Trusted manual submission does not require a fabricated workflow attempt. */
  createManualTasks(request: CreateTaskRequest, key: string) { return this.db.transaction(() => this.tasks.create(request, key)); }
  createTasks(request: CreateTaskRequest, actor: ActorScope, key: string) { return this.db.transaction(() => this.tasks.create(request, key, actor)); }
  /** Trusted E3 only: generated content with server-reconstructed identity and authority. */
  createGeneratedTask(spec: import('../contracts/domain.ts').TaskSpec, actor: ActorScope, key: string) { return this.db.transaction(() => this.tasks.generated(spec, actor, key)); }
  upsertFinding(input: FindingInput, actor: ActorScope, key: string) { return this.db.transaction(() => this.tasks.finding(input, actor, key)); }
  getTask(id: string, actor?: ActorScope) { return this.tasks.get(id, actor); }
  getTaskHistory(id: string) { return this.tasks.history(id); }
  getSubmission(id: string) { return this.tasks.submission(id); }
  patchTask(id: string, patch: TaskPatch, expectedRevision: number, actor?: ActorScope, key?: string) { return this.db.transaction(() => this.tasks.patch(id, patch, expectedRevision, actor, key)); }
  /** Trusted persistence seam only: C4 owns legal transitions and quiescence checks. */
  setTaskStatus(id: string, status: TaskStatus, expectedRevision: number) { return this.db.transaction(() => this.tasks.status(id, status, expectedRevision)); }
  archiveTask(id: string, expectedRevision: number) { return this.db.transaction(() => this.tasks.archive(id, expectedRevision)); }
  private withRotationSync<T>(fn: () => T): T { const value = fn(); this.admission.syncRotations(); return value; }
  /** Trusted backend seam. C4 owns takeover/return-control legality and external quiescence. */
  setRepositoryControl(id: string, controlMode: Repository['controlMode'], expectedRevision: number): Repository {
    return this.db.transaction(() => { const old = this.repositoryAtRevision(id, expectedRevision); return this.writeRepository({ ...old, controlMode, revision: old.revision + 1 }); });
  }
  /** E1 supplies trusted, exact-revision/hash capability validation. This object must never be mounted as a worker/browser route. */
  setRecipeReadiness(recipeId: string, revision: string, readiness: { hash: string; ready: boolean; reasons: string[] }, expectedRevision: number) {
    return this.db.transaction(() => this.admission.setReadiness(recipeId, revision, readiness, expectedRevision));
  }
  getAdmissionState() { return this.db.transaction(() => this.admission.state()); }
  getRotationState(repositoryId: string) { return this.db.transaction(() => this.admission.rotation(repositoryId)); }
  getQuotaState() { return this.db.transaction(() => this.admission.quota()); }
  getReservations(): Reservation[] { return this.db.transaction(() => this.admission.reservations()); }
  reserveStart(candidate: AdmissionCandidate, dayKey: string, dispatchKey?: string) {
    return this.db.transaction(() => {
      const reservation = this.admission.reserve(candidate, dayKey);
      if (dispatchKey) this.outbox.enqueue({key:'dispatch:reservation:'+dispatchKey,kind:'dispatch.reservation',payload:{reservationId:reservation.id,taskId:reservation.task.spec.id,attemptId:reservation.attempt.id}});
      return reservation;
    });
  }
  confirmStart(id: string, identity: ExternalStartIdentity): void {
    // Persist immutable proof first, so accounting can resume after an interrupted confirmation.
    this.db.transaction(() => this.admission.rememberExternal(id, identity));
    this.db.transaction(() => this.admission.confirm(id, identity));
  }
  releaseUnstarted(id: string, dispatchOutcome?: ActionInput): void {
    this.db.transaction(() => {
      this.admission.releaseUnstarted(id);
      if (dispatchOutcome) this.outbox.complete(this.outbox.enqueue(dispatchOutcome).id);
    });
  }
  releaseAdmissionLease(id: string, fence: number): void { this.db.transaction(() => this.admission.releaseLease(id, fence)); }
  markAdmissionAttention(taskId: string, expectedRevision: number, code: string, recovery: string): void {
    this.db.transaction(() => this.admission.attention(taskId, expectedRevision, code, recovery));
  }
  returnLifecycleControl(repositoryId: string, revision: number, token: string): void { this.db.transaction(() => this.lifecycle.returnControl(repositoryId, revision, token)); }
  getLifecycleEpoch(): string { return this.db.epoch; }
  getLifecycle(attemptId: string): LifecycleRecord { return this.db.transaction(() => this.lifecycle.get(attemptId)); }
  updateLifecycle(attemptId: string, fence: number, patch: LifecycleUpdate): LifecycleRecord { return this.db.transaction(() => this.lifecycle.update(attemptId, fence, patch)); }
  bindLifecycleIdentity(attemptId: string, identity: import('../contracts/domain.ts').NativeIdentity): void { this.db.transaction(() => this.lifecycle.bindIdentity(attemptId, identity)); }
  validateLifecycleIdentity(attemptId: string, identity: import('../contracts/domain.ts').NativeIdentity): void { this.lifecycle.validateIdentity(attemptId, identity); }
  queueLifecycleReply(requestId: string, value: unknown, key: string) { return this.db.transaction(() => this.lifecycle.queueReply(requestId, value, key)); }
  acquireLifecycle(attemptId: string, token: string, retry: boolean, actionId: string): Reservation { return this.db.transaction(() => { const reservation = this.lifecycle.acquire(attemptId, token, retry); this.lifecycle.bindAction(actionId, reservation.attempt.id, reservation.lease.fence); return reservation; }); }
  assertLifecycleAuthority(attemptId: string, fence: number): string { return this.db.transaction(() => this.lifecycle.authority(attemptId, fence)); }
  beginLifecycleAction(attemptId: string, fence: number, epoch: string, actionId: string): string { return this.db.transaction(() => this.lifecycle.beginAction(attemptId, fence, epoch, actionId)); }
  settleLifecycleEffect(attemptId: string, fence: number, token: string, phase: 'unknown' | 'accepted'): void { this.db.transaction(() => this.lifecycle.settleEffect(attemptId, fence, token, phase)); }
  bindLifecycleAction(actionId: string, attemptId: string, fence: number): void { this.db.transaction(() => this.lifecycle.bindAction(actionId, attemptId, fence)); }
  getLifecycleActionBinding(actionId: string) { return this.lifecycle.actionBinding(actionId); }
  finishLifecycleAction(actionId: string, attemptId: string, fence: number, state: LifecycleState, activeDurationMs: number, effectToken: string, dispatchOutcome?: ActionInput): void {
    this.db.transaction(() => {
      this.lifecycle.finishAction(actionId, attemptId, fence, state, activeDurationMs, effectToken);
      if (dispatchOutcome) this.outbox.complete(this.outbox.enqueue(dispatchOutcome).id);
    });
  }
  enqueueAction(input: ActionInput) { return this.db.transaction(() => this.outbox.enqueue(input)); }
  getActionByKey(key: string) { return this.outbox.byKey(key); }
  getAction(id: string) { return this.outbox.find(id); }
  /** Atomic intent-before-effect claim. Existing intents never authorize another blind external write. */
  claimAction(input: ActionInput) { return this.db.transaction(() => { const fresh = !this.outbox.byKey(input.key); return { action: this.outbox.enqueue(input), fresh }; }); }
  saveCloseout(attemptId: string, result: import('../contracts/domain.ts').TaskResult | undefined, outcome: import('../contracts/domain.ts').CloseoutResult, release: boolean) { return this.db.transaction(() => this.lifecycle.closeout(attemptId, result, outcome, release)); }
  pendingActions() { return this.outbox.pending(); }
  /** Read all unresolved external request identities, including historical fences. */
  pendingExternalEffects(): {apiKeys:string[];nativeWrites:{attemptId:string;fence:number;key:string;state:'pending'|'unknown'}[]} {
    return this.db.transaction(()=>({
      apiKeys:this.db.sql.prepare("SELECT key FROM api_requests WHERE state='pending' ORDER BY key").all().map(row=>String(row.key)),
      nativeWrites:this.db.sql.prepare("SELECT attempt_id,fence,key,state FROM broker_writes WHERE state IN ('pending','unknown') ORDER BY attempt_id,fence").all().map(row=>({attemptId:String(row.attempt_id),fence:Number(row.fence),key:String(row.key),state:row.state as 'pending'|'unknown'})),
    }));
  }
  completeAction(id: string): void { this.db.transaction(() => this.outbox.complete(id)); }
  /** Trusted service only: the callback must be synchronous, returning a sanitized public DTO. */
  runApiMutation(key: string, input: unknown, mutate: () => ApiRequestResult) {
    return this.db.transaction(() => {
      const claim = this.apiRequests.claim(key, input);
      if (!claim.fresh) { ensure(claim.result, 'request_pending', 'Reconcile pending request'); return { fresh: false, result: claim.result }; }
      const result = mutate(); this.apiRequests.finish(key, input, result); return { fresh: true, result };
    });
  }
  /** Trusted E1 seam: synchronous local writes and exact stable-key outcome share one transaction. */
  runRecipeMutation<T>(key: string, input: unknown, mutate: () => T): T {
    return this.db.transaction(() => this.db.idempotent('recipe-registry', key, input, () => {
      const result = mutate();
      ensure(!(result instanceof Promise), 'invalid_recipe_mutation', 'Recipe mutations must be synchronous');
      return result;
    }));
  }
  /** Read-only reconciliation; never invokes an action or revalidates mutable current state. */
  readRecipeMutation<T>(key: string): T | undefined {
    const row = this.db.sql.prepare('SELECT result FROM idempotency WHERE namespace = ? AND key = ?').get('recipe-registry', key);
    return row ? JSON.parse(String(row.result)) as T : undefined;
  }
  claimApiRequest(key: string, input: unknown) { return this.db.transaction(() => this.apiRequests.claim(key, input)); }
  finishApiRequest(key: string, input: unknown, result: ApiRequestResult): void { this.db.transaction(() => this.apiRequests.finish(key, input, result)); }
  eventsAfter(sequence: number) { return this.outbox.eventsAfter(sequence); }
}
export function openStore(path: string, options: OpenStoreOptions = {}): FactoryStore { return new FactoryStore(path, options); }
