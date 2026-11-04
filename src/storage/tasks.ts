import { randomUUID } from 'node:crypto';
import type { ActorScope, CreateTaskRequest, ExecutionDefaults, FindingInput, Grant, RecipeRevision, Repository, Settings, Tag, TaskPatch, TaskRecord, TaskSource, TaskSpec, TaskStatus } from '../contracts/domain.ts';
import { validateContract } from '../contracts/schemas.ts';
import { StoreDatabase, canonical, ensure } from './database.ts';
import type { RecipeStorage } from './recipes.ts';

export interface MaterializationContext {
  id: string; parentId?: string; repository: Repository; recipe: RecipeRevision;
  request: CreateTaskRequest; defaults: ExecutionDefaults; source: TaskSource;
}
export type RecipeMaterializer = (context: MaterializationContext) => TaskSpec;
export interface Submission {
  id: string; createdAt: string; recipeId: string; request: CreateTaskRequest;
  childTaskIds: string[]; status: 'queued' | 'in_progress' | 'completed' | 'partial_failure';
}
interface RegisteredActor { scope: ActorScope; taskId: string }
const closed = new Set<TaskStatus>(['completed', 'failed', 'cancelled']);
export class TaskStorage {
  private db: StoreDatabase;
  private recipes: RecipeStorage;
  private materialize: RecipeMaterializer | undefined;
  constructor(db: StoreDatabase, recipes: RecipeStorage, materialize?: RecipeMaterializer) { this.db = db; this.recipes = recipes; this.materialize = materialize; }
  get(id: string, actor?: ActorScope): TaskRecord | undefined {
    const registration = actor ? this.authorize(actor) : undefined;
    const task = this.db.read<TaskRecord>('tasks', id);
    if (task && registration) this.owned(task, registration);
    return task;
  }
  history(id: string): TaskRecord[] { return this.db.sql.prepare('SELECT payload FROM task_revisions WHERE task_id = ? ORDER BY revision').all(id).map(row => JSON.parse(String(row.payload)) as TaskRecord); }
  write(value: TaskRecord, creatorAttemptId?: string): TaskRecord {
    validateContract('TaskRecord', value);
    const spec = value.spec;
    this.db.sql.prepare('INSERT INTO task_nodes(id) VALUES (?) ON CONFLICT(id) DO NOTHING').run(spec.id);
    this.db.sql.prepare(`INSERT INTO tasks(id, repository_id, recipe_id, recipe_revision, tag_id, parent_id, creator_attempt_id, revision, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET recipe_revision = excluded.recipe_revision, tag_id = excluded.tag_id, revision = excluded.revision, payload = excluded.payload`).run(spec.id, spec.repositoryId, spec.recipeId, spec.recipeRevision, spec.tagId, spec.parentId ?? null, creatorAttemptId ?? null, value.revision, JSON.stringify(value));
    this.db.sql.prepare('INSERT INTO task_revisions(task_id, revision, payload) VALUES (?, ?, ?)').run(spec.id, value.revision, JSON.stringify(value));
    this.db.emit('task', value); return structuredClone(value);
  }
  insert(spec: TaskSpec, creatorAttemptId?: string): TaskSpec {
    ensure(!this.db.read('tasks', spec.id) && !this.db.sql.prepare('SELECT id FROM task_nodes WHERE id = ?').get(spec.id), 'duplicate_task', 'Task ID already exists');
    const now = this.db.now();
    this.write({ spec, status: 'queued', revision: 1, controlMode: 'factory', createdAt: now, updatedAt: now, attemptIds: [], childTaskIds: [] }, creatorAttemptId);
    return structuredClone(spec);
  }
  registerActor(scope: ActorScope, taskId: string): void {
    validateContract('ActorScope', scope);
    const task = this.get(taskId);
    ensure(task && task.spec.recipeId === scope.recipeId && task.spec.recipeRevision === scope.recipeRevision && scope.repositoryIds.includes(task.spec.repositoryId), 'invalid_scope', 'Actor scope must match its persisted task and recipe revision');
    ensure(Date.parse(scope.expiresAt) > this.db.clock.wallNow().getTime(), 'expired_scope', 'Actor scope is expired');
    const previous = this.db.read<RegisteredActor>('actor_scopes', scope.attemptId);
    if (previous) {
      ensure(previous.taskId === taskId && scope.fence > previous.scope.fence && scope.recipeId === previous.scope.recipeId && scope.recipeRevision === previous.scope.recipeRevision, 'stale_fence', 'Actor registration must advance the fence for the same task and revision');
    }
    const value = { scope, taskId };
    this.db.sql.prepare('INSERT INTO actor_scopes(attempt_id, task_id, recipe_id, recipe_revision, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT(attempt_id) DO UPDATE SET payload = excluded.payload').run(scope.attemptId, taskId, scope.recipeId, scope.recipeRevision, JSON.stringify(value));
    this.authorize(scope); // Roll back registration if any grant or authority is invalid.
  }
  authorize(actor: ActorScope): RegisteredActor {
    validateContract('ActorScope', actor);
    ensure(Date.parse(actor.expiresAt) > this.db.clock.wallNow().getTime(), 'expired_scope', 'Actor scope is expired');
    const registration = this.db.read<RegisteredActor>('actor_scopes', actor.attemptId);
    ensure(registration && canonical(registration.scope) === canonical(actor), 'invalid_scope', 'Actor scope or fence does not match its trusted registration');
    const issued = this.db.sql.prepare("SELECT lease_active, fence FROM admission_reservations WHERE json_extract(payload, '$.attempt.id') = ?").get(actor.attemptId);
    if (issued) ensure(issued.lease_active === 1 && issued.fence === actor.fence, 'stale_fence', 'Actor requires a current active execution lease');
    const recipe = this.recipes.revision(actor.recipeId, actor.recipeRevision);
    ensure(recipe, 'invalid_scope', 'Actor recipe revision does not exist');
    const task = this.db.read<TaskRecord>('tasks', registration.taskId);
    ensure(task && !closed.has(task.status), 'closed_actor', 'Actor task is closed');
    ensure(task.spec.recipeId === actor.recipeId && task.spec.recipeRevision === actor.recipeRevision, 'invalid_scope', 'Actor scope no longer matches its pinned task recipe revision');
    const grants = actor.grantIds.map(id => {
      const grant = this.db.read<Grant>('grants', id);
      ensure(grant && !grant.revokedAt && (!grant.expiresAt || Date.parse(grant.expiresAt) > this.db.clock.wallNow().getTime()), 'invalid_grant', 'Actor grant is absent, revoked or expired');
      ensure(grant.recipeId === actor.recipeId && grant.recipeRevision === actor.recipeRevision && actor.repositoryIds.every(id => grant.repositoryIds.includes(id)), 'invalid_grant', 'Actor grant does not cover its recipe revision and repositories');
      return grant;
    });
    const required = recipe.contract.variables.sf.required;
    const covers = <T>(items: T[], select: (grant: Grant) => T[]) => items.every(item => grants.some(grant => select(grant).some(candidate => canonical(candidate) === canonical(item))));
    ensure(covers(required.paths, g => g.required.paths) && covers(required.tools, g => g.required.tools) && covers(required.networkDestinations, g => g.required.networkDestinations) && covers(required.credentialRefs, g => g.required.credentialRefs) && covers(required.allowedFinishPolicies, g => g.required.allowedFinishPolicies), 'invalid_grant', 'Actor grants do not cover declared recipe capabilities');
    return registration;
  }
  private owned(task: TaskRecord, actor: RegisteredActor): void {
    const created = this.db.sql.prepare('SELECT creator_attempt_id FROM tasks WHERE id = ?').get(task.spec.id);
    ensure(actor.scope.repositoryIds.includes(task.spec.repositoryId) && task.spec.recipeId === actor.scope.recipeId && task.spec.recipeRevision === actor.scope.recipeRevision && (actor.taskId === task.spec.id || created?.creator_attempt_id === actor.scope.attemptId), 'task_scope', 'Unrelated task is outside actor ownership and scope');
  }
  private availableRecipe(id: string, actor?: ActorScope): RecipeRevision {
    const summary = this.recipes.summary(id);
    ensure(summary?.active, 'inactive_recipe', 'Recipe must be active');
    ensure(!actor || actor.recipeId === id, 'recipe_scope', 'Recipe is outside actor scope');
    const recipe = actor ? this.recipes.revision(id, actor.recipeRevision) : this.recipes.current(id);
    ensure(recipe, 'not_found', 'Recipe revision not found');
    const tag = this.db.read<Tag>('tags', recipe.tagId);
    ensure(tag && !tag.archivedAt, 'archived_tag', 'Recipe revision tag is archived');
    return recipe;
  }
  private checkSpec(spec: TaskSpec, recipe: RecipeRevision, repositoryId: string): void {
    validateContract('TaskSpec', spec);
    const metadata = recipe.contract.variables.sf;
    ensure(spec.repositoryId === repositoryId && spec.recipeId === recipe.recipeId && spec.recipeRevision === recipe.revision && spec.tagId === recipe.tagId, 'invalid_materialization', 'Task materialization must inherit repository, recipe revision and tag');
    ensure(canonical(spec.required) === canonical(metadata.required), 'invalid_authority', 'Task materialization cannot change required authority');
    ensure(metadata.compatibleOwners.includes(spec.ownerId) && metadata.compatibleProviders.includes(spec.providerId) && metadata.required.allowedFinishPolicies.includes(spec.finishPolicy), 'invalid_authority', 'Task execution or finish authority is incompatible with recipe');
    ensure(recipe.repositoryIds.includes(repositoryId), 'repository_scope', 'Repository is outside recipe assignments');
    ensure(this.db.read('repositories', repositoryId), 'invalid_repository', 'Repository does not exist');
  }
  /** Trusted admission only; validates the exact revision and authority before fresh insertion. */
  insertAutomatic(spec: TaskSpec): void {
    ensure(spec.source === 'automatic' && !spec.parentId, 'invalid_candidate', 'Fresh automatic task has no parent');
    const recipe = this.availableRecipe(spec.recipeId);
    ensure(recipe.revision === spec.recipeRevision, 'revision_conflict', 'Automatic task requires current recipe revision');
    this.checkSpec(spec, recipe, spec.repositoryId);
    this.insert(spec);
  }
  create(request: CreateTaskRequest, key: string, actor?: ActorScope): TaskSpec[] {
    validateContract('CreateTaskRequest', request);
    const registered = actor ? this.authorize(actor) : undefined;
    if (actor) ensure(request.repositoryIds.every(id => actor.repositoryIds.includes(id)), 'repository_scope', 'Requested repository is outside actor scope');
    return this.db.idempotent(actor ? `actor:${actor.attemptId}:create` : 'admin:create', key, request, () => {
      const recipe = this.availableRecipe(request.recipeId, actor);
      ensure(this.materialize, 'materializer_missing', 'A recipe materializer is required to create tasks');
      const settings = this.db.read<Settings>('settings', 1)!;
      const defaults: ExecutionDefaults = { ownerId: request.ownerId ?? settings.config.defaultOwnerId, providerId: request.providerId ?? settings.config.defaultProviderId, finishPolicy: request.finishPolicy ?? recipe.contract.variables.sf.defaultFinishPolicy };
      let parentId = registered?.taskId;
      if (request.repositoryIds.length > 1) {
        parentId = randomUUID();
        this.db.sql.prepare('INSERT INTO task_nodes(id) VALUES (?)').run(parentId);
        this.db.sql.prepare('INSERT INTO submissions(id, created_at, recipe_id, request) VALUES (?, ?, ?, ?)').run(parentId, this.db.now(), recipe.recipeId, JSON.stringify(request));
      }
      const tasks = request.repositoryIds.map(repositoryId => {
        const repository = this.db.read<Repository>('repositories', repositoryId);
        ensure(repository, 'invalid_repository', 'Requested repository does not exist');
        const id = randomUUID();
        const source = actor ? 'recipe' : 'manual';
        const spec = structuredClone(this.materialize!({ id, ...(parentId ? { parentId } : {}), repository, recipe: structuredClone(recipe), request: structuredClone(request), defaults: structuredClone(defaults), source }));
        this.checkSpec(spec, recipe, repositoryId);
        ensure(spec.id === id && spec.parentId === parentId && spec.source === source && spec.title === request.title && spec.description === request.description && spec.ownerId === defaults.ownerId && spec.providerId === defaults.providerId && spec.finishPolicy === defaults.finishPolicy, 'invalid_materialization', 'Task materialization changed requested identity or execution defaults');
        this.insert(spec, actor?.attemptId);
        if (request.repositoryIds.length > 1) this.db.sql.prepare('INSERT INTO submission_children(submission_id, task_id, repository_id) VALUES (?, ?, ?)').run(parentId!, spec.id, repositoryId);
        return spec;
      });
      if (registered) this.linkChildren(registered.taskId, tasks.map(task => task.id));
      return tasks;
    });
  }
  private linkChildren(taskId: string, ids: string[]): void {
    const task = this.get(taskId)!;
    this.write({ ...task, childTaskIds: [...task.childTaskIds, ...ids], revision: task.revision + 1, updatedAt: this.db.now() });
  }
  finding(input: FindingInput, actor: ActorScope, key: string): TaskSpec {
    validateContract('FindingInput', input);
    const registered = this.authorize(actor);
    ensure(actor.recipeId === input.recipeId && actor.repositoryIds.includes(input.repositoryId), 'finding_scope', 'Finding is outside actor recipe or repository scope');
    const recipe = this.availableRecipe(input.recipeId, actor);
    this.checkSpec(input.task, recipe, input.repositoryId);
    if (input.relatedTaskId) {
      const related = this.get(input.relatedTaskId, actor);
      ensure(related, 'not_found', 'Related task not found');
    }
    return this.db.idempotent(`actor:${actor.attemptId}:finding`, key, input, () => {
      const prior = this.db.sql.prepare('SELECT task_id FROM findings WHERE repository_id = ? AND recipe_id = ? AND finding_key = ?').get(input.repositoryId, input.recipeId, input.findingKey);
      const old = prior ? this.get(String(prior.task_id)) : undefined;
      if (old && !closed.has(old.status)) return old.spec;
      const spec = { ...structuredClone(input.task), source: 'recipe' as const, parentId: old?.spec.id ?? input.relatedTaskId ?? registered.taskId };
      this.insert(spec, actor.attemptId);
      this.db.sql.prepare('INSERT INTO findings(repository_id, recipe_id, finding_key, task_id) VALUES (?, ?, ?, ?) ON CONFLICT(repository_id, recipe_id, finding_key) DO UPDATE SET task_id = excluded.task_id').run(input.repositoryId, input.recipeId, input.findingKey, spec.id);
      this.linkChildren(registered.taskId, [spec.id]);
      return spec;
    });
  }
  patch(id: string, patch: TaskPatch, expectedRevision: number, actor?: ActorScope, key?: string): TaskRecord {
    validateContract('TaskPatch', patch);
    const registration = actor ? this.authorize(actor) : undefined;
    if (actor) ensure(!Object.hasOwn(patch, 'finishPolicy') && !Object.hasOwn(patch, 'ownerId') && !Object.hasOwn(patch, 'providerId'), 'worker_authority', 'Worker updates cannot change execution or finish authority');
    const apply = () => {
      const task = this.get(id);
      ensure(task, 'not_found', 'Task not found');
      if (registration) this.owned(task, registration);
      ensure(task.revision === expectedRevision, 'revision_conflict', 'Task revision conflict');
      ensure(!this.db.sql.prepare('SELECT id FROM admission_reservations WHERE task_id = ? AND lease_active = 1').get(id), 'task_reserved', 'Reserved tasks require launch reconciliation or lifecycle control');
      ensure(!this.db.sql.prepare("SELECT id FROM admission_reservations WHERE task_id = ? AND status = 'confirmed'").get(id), 'immutable_task', 'Started execution identity and authority are fixed');
      ensure(task.status === 'queued', 'immutable_task', 'Only queued tasks can be edited or cancelled through CRUD');
      const { status, ...specPatch } = patch;
      const spec = { ...task.spec, ...specPatch };
      const recipe = this.recipes.revision(spec.recipeId, spec.recipeRevision)!;
      this.checkSpec(spec, recipe, spec.repositoryId);
      return this.write({ ...task, spec, status: status ?? task.status, revision: task.revision + 1, updatedAt: this.db.now() });
    };
    // Authorize the object even on replay: possession of another task ID is never sufficient.
    if (registration) { const task = this.get(id)!; ensure(task, 'not_found', 'Task not found'); this.owned(task, registration); }
    if (actor) ensure(key, 'invalid_key', 'Worker updates require an idempotency key');
    return key ? this.db.idempotent(actor ? `actor:${actor.attemptId}:patch` : 'admin:patch', key, { id, patch, expectedRevision }, apply) : apply();
  }
  status(id: string, status: TaskStatus, expectedRevision: number): TaskRecord {
    validateContract('TaskStatus', status);
    const task = this.get(id);
    ensure(task, 'not_found', 'Task not found');
    ensure(task.revision === expectedRevision, 'revision_conflict', 'Task revision conflict');
    ensure(!closed.has(task.status), 'closed_task', 'Closed task history cannot be reopened');
    return this.write({ ...task, status, revision: task.revision + 1, updatedAt: this.db.now() });
  }
  archive(id: string, expectedRevision: number): TaskRecord {
    const task = this.get(id);
    ensure(task, 'not_found', 'Task not found');
    ensure(task.revision === expectedRevision, 'revision_conflict', 'Task revision conflict');
    ensure(closed.has(task.status), 'live_task', 'Live tasks must be quiesced and cancelled before archival');
    return this.write({ ...task, archivedAt: this.db.now(), revision: task.revision + 1, updatedAt: this.db.now() });
  }
  submission(id: string): Submission | undefined {
    const row = this.db.sql.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
    if (!row) return undefined;
    const ids = this.db.sql.prepare('SELECT task_id FROM submission_children WHERE submission_id = ? ORDER BY rowid').all(id).map(child => String(child.task_id));
    const tasks = ids.map(id => this.get(id)!);
    const status = tasks.every(task => task.status === 'completed') ? 'completed' : tasks.some(task => task.status === 'failed' || task.status === 'cancelled') ? 'partial_failure' : tasks.every(task => task.status === 'queued') ? 'queued' : 'in_progress';
    return { id, createdAt: String(row.created_at), recipeId: String(row.recipe_id), request: JSON.parse(String(row.request)) as CreateTaskRequest, childTaskIds: ids, status };
  }
}
