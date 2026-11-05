import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { KestraClient } from '../../src/kestra/client.ts';
import { encodeWorkerResponse, decodeWorkerRequest } from '../../src/contracts/worker-transport.ts';
import { openStore } from '../../src/storage/store.ts';
import { RecipeRegistry } from '../../src/recipes/registry.ts';
import { materializeTask } from '../../src/recipes/materialize.ts';
import type { TaskResult, WorkerRequest } from '../../src/contracts/domain.ts';
import type { KestraAuthority } from '../../src/kestra/pause.ts';
import type { EngineRequest, EngineResponse } from '../../src/kestra/executions.ts';

const literal = '{% raw %}{{ inputs.secret }}{% endraw %} "\\\n % 🐈 日本語';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sf-e2-')); const store = openStore(':memory:');
  const source = parse(readFileSync(new URL('../../recipes/starter/focused-feature.yaml', import.meta.url), 'utf8'));
  source.variables.sf.tagId = store.snapshot().tags[0]!.id;
  store.createRepository({ id: 'repo', name: 'Repo', url: 'https://example.test/repo' });
  const registry = new RecipeRegistry(store, { resolveReference: () => true, executionReadiness: () => [] });
  const recipe = registry.createCommand({ yaml: JSON.stringify(source), repositoryIds: ['repo'] }, { key: 'recipe' });
  const start = { idempotencyKey: 'start-1', attemptId: 'attempt-1', recipe, inputs: {}, scopeId: 'scope-1', fence: 1 };
  const scope = { attemptId: 'attempt-1', recipeId: recipe.recipeId, recipeRevision: recipe.revision, repositoryIds: ['repo'], grantIds: ['grant-1'], expiresAt: '2099-01-01T00:00:00.000Z', fence: 1 };
  const task = materializeTask({ recipeId: recipe.recipeId, repositoryIds: ['repo'], title: literal, description: literal }, recipe, 'repo', { ownerId: 'vscode', providerId: 'copilot', finishPolicy: 'pr' });
  const native: WorkerRequest = { requestId: 'native-request', idempotencyKey: 'native-key', scope, operation: 'native.start', payload: { idempotencyKey: 'native-key', attemptId: 'attempt-1', task, workspacePath: '/work', baseSha: 'abc', fence: 1, profileId: 'profile' } };
  const nativeIdentity = { ownerId: 'vscode', providerId: 'copilot' as const, sessionId: 'session-1' };
  const result: TaskResult = { attemptId: 'attempt-1', summary: literal, evidence: [literal], createdTaskIds: [], outcome: 'result' };
  let flow: any; const executions: any[] = []; let starts = 0; let resumes = 0; let dropStart = false; let dropResume = false; let failSearch = false;
  const request = async (r: EngineRequest): Promise<EngineResponse> => {
    const url = new URL('http://fixture' + r.path);
    if (r.path.startsWith('/flows/')) return flow ? { status: 200, body: flow } : { status: 404, body: null };
    if (r.path === '/flows') { flow = { ...parse(r.body as string), revision: 1 }; return { status: 200, body: flow }; }
    if (url.pathname === '/executions/search') { if (failSearch) throw Error('offline'); return { status: 200, body: { total: executions.length, results: executions } }; }
    if (url.pathname.startsWith('/executions/') && url.searchParams.has('revision')) {
      starts++; const fields = r.body as Record<string, string>; assert.equal(decodeWorkerRequest(fields.sf_native_start!).operation, 'native.start');
      const labels = url.searchParams.getAll('labels').map(x => { const i = x.indexOf(':'); return { key: x.slice(0, i), value: x.slice(i + 1) }; });
      const e = { id: 'execution-1', namespace: flow.namespace, flowId: flow.id, flowRevision: 1, labels, state: { current: 'RUNNING' }, taskRunList: [] }; executions.push(e);
      if (dropStart) throw Error('lost start reply'); return { status: 200, body: e };
    }
    const e = executions[0];
    if (r.path.endsWith('/actions/resume')) { resumes++; const fields = r.body as Record<string, string>; assert.equal(decodeWorkerRequest(fields.sf_result!).operation, 'result.submit'); e.state.current = 'SUCCESS'; e.taskRunList[0].state.current = 'SUCCESS'; e.resume = fields.sf_result; if (dropResume) throw Error('lost resume reply'); return { status: 204, body: null }; }
    if (r.path.endsWith('/actions/eval')) { return { status: 200, body: { result: r.body === '{{ outputs.await_result.onResume.sf_result }}' ? e.resume : r.body === '{{ outputs.native_start.body }}' ? encodeWorkerResponse({requestId: 'native-request', ok: true, result: nativeIdentity}) : encodeWorkerResponse({ requestId: 'result-request', ok: true, result: e.resume ? (decodeWorkerRequest(e.resume) as any).payload : result }) } }; }
    if (r.path.endsWith('/actions/kill')) return { status: 200, body: null };
    if (r.method === 'GET' && r.path === '/executions/execution-1') return { status: 200, body: e };
    throw Error('Unexpected fixture request ' + r.method + ' ' + r.path);
  };
  const authority: KestraAuthority = { start: async () => ({ request: native, capability: 'safe.start' }), result: async (_identity: unknown, input: TaskResult) => ({ request: { requestId: 'result-request', idempotencyKey: 'result-key', scope, operation: 'result.submit', payload: input } as WorkerRequest, capability: 'safe.fresh' }) };
  const client = () => new KestraClient({ journalDirectory: root, request, authority });
  return { root, start, result, native, nativeIdentity, scope, task, authority, request, client, executions, pause() { executions[0].state.current = 'PAUSED'; executions[0].taskRunList = [{ id: 'pause-1', taskId: 'await_result', state: { current: 'PAUSED' } }]; }, dropStart() { dropStart = true; }, dropResume() { dropResume = true; }, failSearch() { failSearch = true; }, get starts() { return starts; }, get resumes() { return resumes; }, cleanup() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('finds_existing_execution_after_lost_start_reply', async () => {
  const f = fixture(); let c = f.client(); try {
    f.dropStart(); const original = await c.ensureExecution(f.start); c.close(); c = f.client();
    const recovered = await c.ensureExecution(f.start);
    assert.equal(f.starts, 1); assert.equal(recovered.executionId, original.executionId); assert.equal(recovered.revision, f.start.recipe.revision);
    assert.equal((await c.snapshot(recovered)).state, 'running');
    await assert.rejects(c.ensureExecution({ ...f.start, fence: 2 }), /conflict/i);
  } finally { c.close(); f.cleanup(); }
});

test('durable_pending_result_waits_for_internal_pause_and_reconciles_lost_reply', async () => {
  const f = fixture(); let c = f.client(); try {
    const id = await c.ensureExecution(f.start); await c.resumeInput(id, f.result, 'resume-1'); assert.equal(f.resumes, 0);
    c.close(); c = f.client(); f.pause(); f.dropResume();
    const done = await c.snapshot(id); assert.equal(done.state, 'completed'); assert.deepEqual(done.result, f.result); assert.deepEqual(done.inputs, []);
    await c.resumeInput(id, f.result, 'resume-1'); assert.equal(f.resumes, 1);
    await assert.rejects(c.resumeInput(id, { ...f.result, summary: 'changed' }, 'resume-1'), /conflict/i);
  } finally { c.close(); f.cleanup(); }
});

test('unknown_start_is_never_blindly_resubmitted', async () => {
  const f = fixture(); const c = f.client(); try {
    f.dropStart(); f.failSearch(); await assert.rejects(c.ensureExecution(f.start)); await assert.rejects(c.ensureExecution(f.start)); assert.equal(f.starts, 1);
  } finally { c.close(); f.cleanup(); }
});

test('rejects_reserved_inputs_and_mismatched_trusted_authority', async () => {
  const f = fixture(); const c = f.client(); try {
    await assert.rejects(c.ensureExecution({ ...f.start, inputs: { sf_capability: 'evil' } }), /reserved/i);
    f.native.scope.fence = 2; await assert.rejects(c.ensureExecution(f.start), /authority/i); assert.equal(f.starts, 0);
  } finally { c.close(); f.cleanup(); }
});

test('engine_success_without_a_broker_result_and_idle_are_not_completion', async () => {
  const f = fixture(); const c = f.client(); try {
    const id = await c.ensureExecution(f.start); assert.equal((await c.snapshot(id)).state, 'running');
    f.executions[0].state.current = 'SUCCESS'; assert.equal((await c.snapshot(id)).state, 'unknown');
  } finally { c.close(); f.cleanup(); }
});

test('stop_remains_uncertain_until_engine_observes_terminal_state', async () => {
  const f = fixture(); const c = f.client(); try {
    const id = await c.ensureExecution(f.start); await c.stop(id); assert.equal((await c.snapshot(id)).state, 'running');
    f.executions[0].state.current = 'KILLED'; assert.equal((await c.snapshot(id)).state, 'cancelled');
  } finally { c.close(); f.cleanup(); }
});


test('trusted_continuation_rebinds_same_workflow_for_retry_and_current_fence', async () => {
  const f = fixture(); let c = f.client(); try {
    const id = await c.ensureExecution(f.start); await c.resumeInput(id, f.result, 'old-pending');
    f.authority.continuation = async () => ({ attemptId: 'attempt-2', previousAttemptId: 'attempt-1', fence: 3, taskId: f.task.id, recipeId: f.start.recipe.recipeId, recipeRevision: f.start.recipe.revision, native: f.nativeIdentity });
    await c.rebindContinuation(id, 'retry-1'); await c.rebindContinuation(id, 'retry-1');
    f.scope.attemptId = 'attempt-2'; f.scope.fence = 3; c.close(); c = f.client();
    await assert.rejects(c.resumeInput(id, f.result, 'stale'), /attempt/);
    f.pause(); const result = { ...f.result, attemptId: 'attempt-2' };
    await c.resumeInput(id, result, 'new-result'); const done = await c.snapshot(id);
    assert.equal(done.state, 'completed'); assert.deepEqual(done.result, result); assert.equal(f.starts, 1); assert.equal(f.resumes, 1);
    f.authority.continuation = async () => ({ attemptId: 'attempt-3', previousAttemptId: 'attempt-2', fence: 4, taskId: f.task.id, recipeId: f.start.recipe.recipeId, recipeRevision: f.start.recipe.revision, native: f.nativeIdentity });
    await assert.rejects(c.rebindContinuation(id, 'unsafe-late-retry'), /Issued result resume/);
  } finally { c.close(); f.cleanup(); }
});

test('binding_change_fences_an_inflight_stale_result_authority', async () => {
  const f = fixture(); const c = f.client(); try {
    const id = await c.ensureExecution(f.start); f.pause();
    let release!: () => void; let reached!: () => void; const ready = new Promise<void>(r => reached = r); const pending = new Promise<void>(r => release = r);
    const original = f.authority.result;
    f.authority.result = async (...args) => { const value = await original(...args); reached(); await pending; return value; };
    const send = c.resumeInput(id, f.result, 'result-race'); await ready;
    f.authority.continuation = async () => ({ attemptId: 'attempt-1', previousAttemptId: 'attempt-1', fence: 2, taskId: f.task.id, recipeId: f.start.recipe.recipeId, recipeRevision: f.start.recipe.revision, native: f.nativeIdentity });
    await c.rebindContinuation(id, 'human-resume'); release(); await assert.rejects(send, /binding changed/); assert.equal(f.resumes, 0);
    f.authority.result = original; f.scope.fence = 2; await c.resumeInput(id, f.result, 'fresh'); assert.equal((await c.snapshot(id)).state, 'completed');
  } finally { c.close(); f.cleanup(); }
});

test('concurrent_clients_claim_one_start_and_one_result_effect', async () => {
  const f = fixture(); const a = f.client(); const b = f.client(); try {
    const outcomes = await Promise.allSettled([a.ensureExecution(f.start), b.ensureExecution(f.start)]);
    const id = await a.ensureExecution(f.start); assert.ok(outcomes.some(x => x.status === 'fulfilled')); assert.equal(f.starts, 1);
    f.pause(); await Promise.allSettled([a.resumeInput(id, f.result, 'same'), b.resumeInput(id, f.result, 'same')]); assert.equal(f.resumes, 1); assert.equal((await a.snapshot(id)).state, 'completed');
  } finally { a.close(); b.close(); f.cleanup(); }
});

test('rejects_wrong_engine_revision_and_broker_error_completion', async () => {
  const f = fixture(); const c = f.client(); try {
    const id = await c.ensureExecution(f.start); f.executions[0].flowRevision = 2;
    assert.equal((await c.snapshot(id)).state, 'unknown'); await assert.rejects(c.ensureExecution(f.start), /revision/);
    f.executions[0].flowRevision = 1; f.pause(); await c.resumeInput(id, f.result, 'resume');
    const broken = new KestraClient({ journalDirectory: f.root, authority: f.authority, request: async r => r.body === '{{ outputs.submit_result.body }}' ? { status: 200, body: { result: encodeWorkerResponse({ requestId: 'result-request', ok: false, error: { code: 'DENIED', message: 'denied', recovery: 'review', retryable: false } }) } } : f.request(r) });
    try { assert.equal((await broken.snapshot(id)).state, 'unknown'); } finally { broken.close(); }
  } finally { c.close(); f.cleanup(); }
});

test('ordinary quiescence proves exact internal result pause and no HTTP writer', async () => {
  const f = fixture(); const c = f.client();
  try {
    assert.equal(typeof c.quiescence, 'function', 'workflow needs a read-only writer quiescence proof');
    const id = await c.ensureExecution(f.start);
    assert.equal(await c.quiescence(id), 'unknown');
    f.pause();
    assert.equal(await c.quiescence(id), 'unknown', 'missing native HTTP acknowledgement is not quiet');
    f.executions[0].taskRunList.push({ id: 'native-1', taskId: 'native_start', state: { current: 'SUCCESS' } });
    assert.equal(await c.quiescence(id), 'waiting');
    f.executions[0].taskRunList.push({ id: 'http-2', taskId: 'submit_result', state: { current: 'RUNNING' } });
    assert.equal(await c.quiescence(id), 'unknown');
  } finally { c.close(); f.cleanup(); }
});
