import { dirname, resolve } from 'node:path';
import type { ActorScope, Clock, CreateTaskRequest, FactorySnapshot, FindingInput, Grant, RecipePatch, RecipeRevision, Repository, RepositoryPatch, Settings, SettingsPatch, TagCreate, TagPatch, TaskPatch, TaskStatus, WeightsPatch } from '../contracts/domain.ts';
import { defaultConfig } from '../contracts/defaults.ts';
import { validateContract } from '../contracts/schemas.ts';
import { StoreDatabase, ensure, systemClock } from './database.ts';
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
  private closed = false;
  constructor(path: string, options: OpenStoreOptions = {}) {
    this.db = new StoreDatabase(path, options.clock ?? systemClock);
    this.tags = new TagStorage(this.db);
    this.recipes = new RecipeStorage(this.db);
    this.tasks = new TaskStorage(this.db, this.recipes, options.materialize);
    this.outbox = new Outbox(this.db);
    try {
      this.db.transaction(() => {
        if (this.db.read('settings', 1)) return;
        const settings: Settings = { config: defaultConfig(path === ':memory:' ? ':memory:' : dirname(resolve(path))), paused: false, revision: 1 };
        this.db.sql.prepare('INSERT INTO settings(id, payload) VALUES (1, ?)').run(JSON.stringify(settings));
        this.db.emit('settings', settings);
        this.tags.seed();
      });
    } catch (error) { this.close(); throw error; }
  }
  close(): void { if (!this.closed) { this.db.sql.close(); this.closed = true; } }
  snapshot(): FactorySnapshot {
    // A read transaction gives the event cursor and every entity one coherent SQLite snapshot.
    this.db.sql.exec('BEGIN');
    try {
      const settings = this.getSettings();
      const sequence = Number(this.db.sql.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events').get()!.sequence);
      const value = validateContract('FactorySnapshot', {
        schemaVersion: 1, sequence, cursor: String(sequence), at: this.db.now(), config: settings.config, paused: settings.paused,
        health: { schemaVersion: 1, ready: false, reasons: ['Runtime readiness has not been evaluated'], version: '0.1.0' },
        auth: { status: 'unavailable', reasons: ['GitHub authentication has not been evaluated'] },
        tags: this.db.all('tags'), repositories: this.db.all('repositories'), recipes: this.db.all('recipes'), tasks: this.db.all('tasks'),
        attempts: [], attention: [],
      });
      this.db.sql.exec('COMMIT'); return value;
    } catch (error) { this.db.sql.exec('ROLLBACK'); throw error; }
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
      const value = validateContract('Repository', { ...input, active: input.active ?? true, controlMode: 'factory', revision: 1, createdAt: this.db.now(), weights: input.weights ?? {} });
      ensure(!this.db.read('repositories', value.id), 'duplicate_repository', 'Repository already exists');
      this.validateWeights(value.weights);
      this.db.sql.prepare('INSERT INTO repositories(id, payload) VALUES (?, ?)').run(value.id, JSON.stringify(value));
      for (const [tagId, weight] of Object.entries(value.weights)) this.db.sql.prepare('INSERT INTO repository_weights(repository_id, tag_id, value) VALUES (?, ?, ?)').run(value.id, tagId, weight);
      this.db.emit('repository', value); return value;
    });
  }
  getRepository(id: string): Repository | undefined { return this.db.read('repositories', id); }
  patchRepository(id: string, patch: RepositoryPatch, expectedRevision: number): Repository {
    validateContract('RepositoryPatch', patch);
    return this.db.transaction(() => {
      const old = this.repositoryAtRevision(id, expectedRevision);
      return this.writeRepository({ ...old, ...patch, revision: old.revision + 1 });
    });
  }
  patchWeights(id: string, patch: WeightsPatch, expectedRevision: number): Repository {
    validateContract('WeightsPatch', patch);
    return this.db.transaction(() => {
      const old = this.repositoryAtRevision(id, expectedRevision);
      this.validateWeights(patch.weights);
      for (const [tagId, value] of Object.entries(patch.weights)) this.db.sql.prepare('INSERT INTO repository_weights(repository_id, tag_id, value) VALUES (?, ?, ?) ON CONFLICT(repository_id, tag_id) DO UPDATE SET value = excluded.value').run(id, tagId, value);
      return this.writeRepository({ ...old, weights: { ...old.weights, ...patch.weights }, revision: old.revision + 1 });
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
  createTag(input: TagCreate) { return this.db.transaction(() => this.tags.create(input)); }
  patchTag(id: string, input: TagPatch, expectedRevision: number) { return this.db.transaction(() => this.tags.patch(id, input, expectedRevision)); }
  deleteTag(id: string, expectedRevision: number): void { this.db.transaction(() => this.tags.delete(id, expectedRevision)); }
  archiveTag(id: string, replacementId: string, expectedRevision?: number): void { this.db.transaction(() => this.tags.archive(id, replacementId, this.recipes, value => this.tasks.write(value), expectedRevision)); }
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
  upsertFinding(input: FindingInput, actor: ActorScope, key: string) { return this.db.transaction(() => this.tasks.finding(input, actor, key)); }
  getTask(id: string, actor?: ActorScope) { return this.tasks.get(id, actor); }
  getTaskHistory(id: string) { return this.tasks.history(id); }
  getSubmission(id: string) { return this.tasks.submission(id); }
  patchTask(id: string, patch: TaskPatch, expectedRevision: number, actor?: ActorScope, key?: string) { return this.db.transaction(() => this.tasks.patch(id, patch, expectedRevision, actor, key)); }
  /** Trusted persistence seam only: C4 owns legal transitions and quiescence checks. */
  setTaskStatus(id: string, status: TaskStatus, expectedRevision: number) { return this.db.transaction(() => this.tasks.status(id, status, expectedRevision)); }
  archiveTask(id: string, expectedRevision: number) { return this.db.transaction(() => this.tasks.archive(id, expectedRevision)); }
  enqueueAction(input: ActionInput) { return this.db.transaction(() => this.outbox.enqueue(input)); }
  pendingActions() { return this.outbox.pending(); }
  completeAction(id: string): void { this.db.transaction(() => this.outbox.complete(id)); }
  eventsAfter(sequence: number) { return this.outbox.eventsAfter(sequence); }
}
export function openStore(path: string, options: OpenStoreOptions = {}): FactoryStore { return new FactoryStore(path, options); }
