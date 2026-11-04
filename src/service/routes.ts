import type { ApiDeps } from './api.ts';
import type { Contract, ContractName } from '../contracts/schemas.ts';
import { validateContract } from '../contracts/schemas.ts';
import { StoreError } from '../storage/store.ts';
import { previewRotation } from '../scheduling/rotation.ts';
import { taskEligible, hasCapabilityGrants } from '../scheduling/eligibility.ts';
import { systemClock } from '../storage/database.ts';
import { factorySnapshot } from './snapshot.ts';

export class ApiFault extends Error {
  status: number; code: string; recovery: string;
  constructor(status: number, code: string, recovery: string) { super(code); this.status = status; this.code = code; this.recovery = recovery; }
}
export const unavailable = (adapter: string): never => { throw new ApiFault(503, 'UNAVAILABLE', `Connect the ${adapter} adapter and retry with a new request key`); };
function exists<T>(value: T | undefined): T { if (value === undefined) throw new ApiFault(404, 'NOT_FOUND', 'Refresh the factory snapshot'); return value; }
function revision<T extends { revision: number }>(value: T | undefined, expected: number | undefined): T {
  const item = exists(value); if (item.revision !== expected) throw new ApiFault(409, 'REVISION_CONFLICT', 'Refresh the entity and retry with its current revision and a new key'); return item;
}
export interface Route {
  method: string; path: string; input?: ContractName; output: ContractName; array?: boolean;
  versioned?: boolean; external?: boolean; afterCreate?: boolean;
  check?(id: string, expected: number | undefined): void;
  run(body: unknown, id: string, expected: number | undefined, key: string): unknown | Promise<unknown>;
}
export function routes(deps: ApiDeps): Route[] {
  const s = deps.store; const validate = <N extends ContractName>(n: N, b: unknown) => validateContract(n, b);
  const ctx = (key: string, expected: number | undefined) => ({ key, ...(expected === undefined ? {} : { expectedRevision: expected }) });
  const task = (id: string) => exists(s.getTask(id));
  const recipes = () => deps.recipes ?? unavailable('recipe validation/import');
  const auth = () => deps.auth ?? unavailable('GitHub authentication');
  const lifecycle = () => deps.lifecycle ?? unavailable('lifecycle controller');
  const nativeToOpen = (id: string) => {
    const t = task(id); const repo = exists(s.getRepository(t.spec.repositoryId));
    if (repo.controlMode !== 'human') throw new ApiFault(409, 'TAKEOVER_REQUIRED', 'Take over repository control before opening the native session');
    if (s.getAdmissionState().activeLeases.some(lease => lease.repositoryId === repo.id)) throw new ApiFault(409, 'QUIESCENCE_REQUIRED', 'Finish takeover and prove all repository writers quiescent before opening the native session');
    const attemptId = t.attemptIds.at(-1); const attempt = exists(s.snapshot().attempts.find(a => a.id === attemptId));
    if (!attempt.native) throw new ApiFault(503, 'IDENTITY_MISSING', 'Reconnect the original native session');
    if (!deps.owner) unavailable('native owner');
    return attempt.native;
  };
  return [
    { method: 'GET', path: '/v1/health', output: 'Health', run: async () => (await factorySnapshot(deps)).health },
    { method: 'GET', path: '/v1/snapshot', output: 'FactorySnapshot', run: () => factorySnapshot(deps) },
    { method: 'GET', path: '/v1/settings', output: 'Settings', run: () => s.getSettings() },
    { method: 'PATCH', path: '/v1/settings', input: 'SettingsPatch', output: 'Settings', versioned: true, run: (b, _id, v) => s.patchSettings(validate('SettingsPatch', b), v!) },
    { method: 'GET', path: '/v1/repositories', output: 'Repository', array: true, run: () => s.snapshot().repositories },
    { method: 'PATCH', path: '/v1/repositories/:id', input: 'RepositoryPatch', output: 'Repository', versioned: true, run: (b, id, v) => s.patchRepository(id, validate('RepositoryPatch', b), v!) },
    { method: 'PATCH', path: '/v1/repositories/:id/weights', input: 'WeightsPatch', output: 'Repository', versioned: true, run: (b, id, v) => s.patchWeights(id, validate('WeightsPatch', b), v!) },
    { method: 'GET', path: '/v1/repositories/:id/rotation-preview', output: 'RotationPreview', run: (_b, id) => {
      exists(s.getRepository(id)); const state = s.getAdmissionState(); const rotation = state.rotations[id]!;
      const available = new Set(state.recipes.filter(r => r.active && r.ready && s.getRecipe(r.id)?.repositoryIds.includes(id)).map(r => r.tagId));
      for (const t of state.tasks) if (t.spec.repositoryId === id && t.spec.source !== 'manual' && taskEligible(t, state) && hasCapabilityGrants(t.spec, state.grants, deps.clock ?? systemClock)) available.add(t.spec.tagId);
      const nextTagIds = previewRotation(rotation.weights, rotation.cursor, available, 20);
      return { repositoryId: id, tagIds: rotation.weights.entries.filter(e => e.value > 0).map(e => e.tagId), nextTagIds, ...(nextTagIds.length ? {} : { reason: 'No eligible automatic recipe or queued task' }) };
    } },
    { method: 'POST', path: '/v1/tags', input: 'TagCreate', output: 'Tag', run: b => s.createTag(validate('TagCreate', b)) },
    { method: 'PATCH', path: '/v1/tags/:id', input: 'TagPatch', output: 'Tag', versioned: true, run: (b, id, v) => s.patchTag(id, validate('TagPatch', b), v!) },
    { method: 'DELETE', path: '/v1/tags/:id', output: 'Acknowledgement', versioned: true, run: (_b, id, v) => { s.deleteTag(id, v!); return { accepted: true }; } },
    { method: 'POST', path: '/v1/tags/:id/archive', input: 'TagArchive', output: 'Tag', versioned: true, run: (b, id, v) => { s.archiveTag(id, validate('TagArchive', b).reassignToTagId, v!); return exists(s.snapshot().tags.find(t => t.id === id)); } },
    { method: 'GET', path: '/v1/tasks', output: 'TaskRecord', array: true, run: () => s.snapshot().tasks },
    { method: 'POST', path: '/v1/tasks', input: 'CreateTaskRequest', output: 'TaskRecord', array: true, afterCreate: true, run: (b, _id, _v, key) => s.createManualTasks(validate('CreateTaskRequest', b), `api:${key}`).map(t => task(t.id)) },
    { method: 'GET', path: '/v1/tasks/:id', output: 'TaskRecord', run: (_b, id) => task(id) },
    { method: 'PATCH', path: '/v1/tasks/:id', input: 'TaskPatch', output: 'TaskRecord', versioned: true, run: (b, id, v) => s.patchTask(id, validate('TaskPatch', b), v!) },
    { method: 'DELETE', path: '/v1/tasks/:id', output: 'TaskRecord', versioned: true, run: (_b, id, v) => s.archiveTask(id, v!) },
    { method: 'GET', path: '/v1/recipes', output: 'RecipeSummary', array: true, run: () => s.snapshot().recipes },
    { method: 'POST', path: '/v1/recipes', input: 'RecipeCreate', output: 'RecipeRevision', external: true, check: () => { recipes(); }, run: (b, _id, v, key) => recipes().create(validate('RecipeCreate', b), ctx(key, v)) },
    { method: 'POST', path: '/v1/recipes/validate', input: 'RecipeCreate', output: 'RecipeValidation', external: true, check: () => { recipes(); }, run: (b, _id, v, key) => recipes().validate(validate('RecipeCreate', b), ctx(key, v)) },
    { method: 'POST', path: '/v1/recipes/:id/revisions', input: 'RecipeCreate', output: 'RecipeRevision', versioned: true, external: true, check: (id, v) => { recipes(); revision(s.snapshot().recipes.find(r => r.id === id), v); }, run: (b, id, v, key) => { revision(s.snapshot().recipes.find(r => r.id === id), v); return recipes().revise(id, validate('RecipeCreate', b), ctx(key, v)); } },
    { method: 'GET', path: '/v1/recipes/:id', output: 'RecipeRevision', run: (_b, id) => exists(s.getRecipe(id)) },
    { method: 'PATCH', path: '/v1/recipes/:id', input: 'RecipePatch', output: 'RecipeSummary', versioned: true, external: true, check: (id, v) => { recipes(); revision(s.snapshot().recipes.find(r => r.id === id), v); }, run: (b, id, v, key) => recipes().patch(id, validate('RecipePatch', b), ctx(key, v)) },
    { method: 'POST', path: '/v1/dispatch', input: 'Empty', output: 'DispatchResult', external: true, run: async () => {
      const r = await deps.scheduler.dispatch('manual');
      if (r.kind === 'noop') return { admitted: false, reason: r.code };
      const attempt = exists(s.snapshot().attempts.find(a => a.id === r.attemptId)); return { admitted: true, attemptId: attempt.id, taskId: attempt.taskId };
    } },
    { method: 'POST', path: '/v1/attention/:id/respond', input: 'AttentionResponse', output: 'AttentionRequest', versioned: true, external: true, check: (id, v) => { lifecycle(); revision(s.snapshot().attention.find(a => a.id === id), v); }, run: async (b, id, v, key) => {
      revision(s.snapshot().attention.find(a => a.id === id), v); await lifecycle().resumeInput(id, validate('AttentionResponse', b).input, `api:${key}`); return exists(s.snapshot().attention.find(a => a.id === id));
    } },
    { method: 'POST', path: '/v1/tasks/:id/takeover', input: 'Empty', output: 'TaskRecord', versioned: true, external: true, check: (id, v) => { lifecycle(); revision(task(id), v); }, run: async (_b, id, v) => { revision(task(id), v); await lifecycle().requestTakeover(id); return task(id); } },
    { method: 'POST', path: '/v1/repositories/:id/return-control', input: 'Empty', output: 'Repository', versioned: true, external: true, check: (id, v) => { lifecycle(); revision(s.getRepository(id), v); }, run: async (_b, id, v) => { revision(s.getRepository(id), v); await lifecycle().returnControl(id); return exists(s.getRepository(id)); } },
    { method: 'POST', path: '/v1/tasks/:id/open-native', input: 'Empty', output: 'NativeOpenResult', external: true, check: id => { nativeToOpen(id); }, run: (_b, id, _v, key) => deps.owner!.open(nativeToOpen(id), { key }) },
    { method: 'POST', path: '/v1/auth/probe', input: 'Empty', output: 'AuthState', external: true, check: () => { auth(); }, run: (_b, _id, v, key) => auth().probe(ctx(key, v)) },
    { method: 'POST', path: '/v1/auth/device-flow', input: 'Empty', output: 'DeviceFlow', external: true, check: () => { auth(); }, run: (_b, _id, v, key) => auth().startDeviceFlow(ctx(key, v)) },
    { method: 'GET', path: '/v1/auth/device-flow/:id', output: 'DeviceFlow', run: (_b, id) => auth().deviceFlow(id) },
    { method: 'POST', path: '/v1/auth/device-flow/:id/complete', input: 'Empty', output: 'AuthState', external: true, check: () => { auth(); }, run: (_b, id, v, key) => auth().completeDeviceFlow(id, ctx(key, v)) },
  ];
}
export function resultFor(route: Route, value: unknown): unknown {
  if (route.array) {
    if (!Array.isArray(value)) throw new TypeError('Invalid adapter response');
    return value.map(v => validateContract(route.output, v));
  }
  return validateContract(route.output, value);
}
export function safeFailure(error: unknown): { status: number; body: Contract<'ApiError'> } {
  if (error instanceof ApiFault) return { status: error.status, body: { code: error.code, message: error.code, recovery: error.recovery, retryable: error.status === 503 } };
  if (error instanceof StoreError) {
    const conflict = /conflict|stale|immutable|not_queued|invalid_transition|pending|unknown|human_control|in_progress|active_lease|quiescence|resolved|answered|effect_unresolved/.test(error.code);
    const status = error.code === 'not_found' ? 404 : error.code === 'request_pending' ? 503 : conflict ? 409 : /denied|scope|grant|unauthorized/.test(error.code) ? 403 : 400;
    return { status, body: { code: error.code.toUpperCase(), message: 'Factory request could not be applied', recovery: status === 409 ? 'Refresh current state and resolve repository or lifecycle readiness before retrying' : 'Check the request and connect required runtime adapters', retryable: status === 503 } };
  }
  return { status: 503, body: { code: 'UNAVAILABLE', message: 'Factory operation unavailable', recovery: 'Check runtime readiness; reconcile any pending external action before retrying', retryable: true } };
}
