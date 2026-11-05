import assert from 'node:assert/strict';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { request as httpRequest } from 'node:http';
import { startApi } from '../../src/service/api.ts';
import type { ApiFailureStatus, Reconciliation } from '../../src/service/api.ts';
import { createFixture } from '../helpers/store.ts';
import { fakePorts, fakeRuntime } from '../helpers/fake-ports.ts';
const origin = 'http://127.0.0.1:5173';
/** Read complete SSE frames until expected payload; independent of network chunk boundaries. */
async function readFrames(response: Response, expected: (frame: string) => boolean): Promise<string> {
  const reader = response.body!.getReader(); const decoder = new TextDecoder();
  let pending = ''; let complete = ''; let bytes = 0;
  const timer = setTimeout(() => { void reader.cancel('SSE fixture deadline'); }, 2000);
  try {
    while (true) {
      const chunk = await reader.read(); assert.equal(chunk.done, false, 'SSE ended before expected payload');
      bytes += chunk.value!.byteLength; assert.ok(bytes <= 1024 * 1024, 'SSE fixture bounded to 1 MiB');
      pending += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, end); pending = pending.slice(end + 2); complete += frame + '\n\n';
        if (expected(frame)) return complete;
      }
    }
  } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function setup() {
  const fixture = createFixture(); const ports = fakePorts(fixture.store); const api = await startApi(ports.deps);
  const session = api.sessions.provision(origin);
  const headers = { origin, cookie: session.cookie, 'x-sf-csrf': session.csrfToken, 'content-type': 'application/json' };
  const call = (path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => fetch(api.url + path, { method, headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { fixture, ports, api, headers, call, async close() { await api.close(); fixture.close(); } };
}
test('requires_pairing_origin_and_csrf_for_mutations', async () => {
  const f = await setup(); try {
    assert.equal((await fetch(f.api.url + '/v1/snapshot', { headers: { origin } })).status, 401);
    assert.equal((await f.call('/v1/settings', 'PATCH', { paused: true }, { origin: 'https://evil.test', 'idempotency-key': 'bad', 'if-match': '1' })).status, 403);
    assert.equal((await f.call('/v1/settings', 'PATCH', { paused: true }, { 'x-sf-csrf': '', 'idempotency-key': 'bad', 'if-match': '1' })).status, 403);
    assert.equal((await f.call('/v1/settings', 'PATCH', { paused: true }, { 'idempotency-key': 'stale', 'if-match': '999' })).status, 409);
    assert.equal((await f.call('/owner/v1/rpc', 'POST', {})).status, 404);
    assert.equal((await f.call('/worker/v1/tasks', 'POST', {})).status, 404);
    f.fixture.store.patchTask(f.fixture.task.id, { title: 'fake-credential-secret' }, 1);
    assert.equal((await (await f.call('/v1/snapshot')).text()).includes('fake-credential-secret'), false);
  } finally { await f.close(); }
});
test('manual_create_dispatches_and_sse_reconnect_refreshes', async () => {
  const f = await setup(); try {
    const before = f.fixture.store.snapshot().sequence;
    const response = await f.call('/v1/tasks', 'POST', f.fixture.request, { 'idempotency-key': 'create' });
    assert.equal(response.status, 200); const records = await response.json();
    assert.equal(records[0].spec.source, 'manual'); assert.equal(records[0].revision, 1); assert.equal(f.ports.dispatches, 1);
    assert.deepEqual(await (await f.call('/v1/tasks', 'POST', f.fixture.request, { 'idempotency-key': 'create' })).json(), records);
    assert.equal(f.ports.dispatches, 1);
    const controller = new AbortController();
    const events = await fetch(f.api.url + '/v1/events', { headers: { ...f.headers, 'last-event-id': String(before) }, signal: controller.signal });
    assert.equal(events.status, 200);
    const text = await readFrames(events, frame => frame.includes('data: ')); controller.abort();
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1]));
    assert.ok(ids.length > 0); assert.equal(new Set(ids).size, ids.length); assert.ok(ids.every(id => id > before));
    assert.equal((await f.call('/v1/events', 'GET', undefined, { 'last-event-id': '999999999' })).status, 409);
    assert.equal((await f.call('/v1/events', 'GET', undefined, { 'last-event-id': '-1' })).status, 409);
    assert.equal(f.ports.dispatches, 1);
  } finally { await f.close(); }
});

test('durable_results_survive_restart_and_conflicting_requests_do_not_mutate', async () => {
  const f = await setup(); try {
    const result = await f.call('/v1/settings', 'PATCH', { paused: true }, { 'idempotency-key': 'durable', 'if-match': '1' });
    assert.equal(result.status, 200); const saved = await result.json();
    await f.api.close(); f.fixture.reopen();
    const ports = fakePorts(f.fixture.store); const restarted = await startApi(ports.deps);
    try {
      const session = restarted.sessions.provision(origin); const headers = { ...f.headers, cookie: session.cookie, 'x-sf-csrf': session.csrfToken, 'idempotency-key': 'durable', 'if-match': '1' };
      const replay = await fetch(restarted.url + '/v1/settings', { method: 'PATCH', headers, body: JSON.stringify({ paused: true }) });
      assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), saved); assert.equal(f.fixture.store.getSettings().revision, 2);
      assert.equal((await fetch(restarted.url + '/v1/settings', { method: 'PATCH', headers, body: JSON.stringify({ paused: false }) })).status, 409);
      assert.equal((await fetch(restarted.url + '/v1/repositories/repo-1', { method: 'PATCH', headers, body: JSON.stringify({ active: true }) })).status, 409);
      assert.equal(f.fixture.store.getRepository('repo-1')!.active, false);
    } finally { await restarted.close(); }
  } finally { f.fixture.close(); }
});

test('local_response_validation_rolls_back_entity_event_and_journal_together', async () => {
  const f = await setup(); try {
    const before = f.fixture.store.snapshot();
    assert.throws(() => f.fixture.store.runApiMutation('rollback', {}, () => { f.fixture.store.createTag({ displayName: 'rolled back' }); throw new Error('response invalid'); }));
    assert.deepEqual(f.fixture.store.snapshot().tags, before.tags); assert.equal(f.fixture.store.snapshot().sequence, before.sequence);
    assert.equal((await f.call('/v1/tags', 'POST', { displayName: 'works' }, { 'idempotency-key': 'rollback' })).status, 200);
  } finally { await f.close(); }
});

test('unknown_external_actions_are_pending_across_restart_and_reconcile_without_repeat', async () => {
  const fixture = createFixture(); let probes = 0; let reconciles = 0;
  const ports = fakePorts(fixture.store);
  const auth = { async state() { return { status: 'missing' as const, reasons: ['Authenticate'] }; },
    async probe() { probes++; throw new Error('provider stdout fake-credential-secret'); },
    async startDeviceFlow() { throw new Error('absent'); }, async deviceFlow() { throw new Error('absent'); }, async completeDeviceFlow() { throw new Error('absent'); } };
  let api = await startApi({ ...ports.deps, auth });
  const run = async () => { const session = api.sessions.provision(origin); return fetch(api.url + '/v1/auth/probe', { method: 'POST', headers: { origin, cookie: session.cookie, 'x-sf-csrf': session.csrfToken, 'idempotency-key': 'unknown', 'content-type': 'application/json' }, body: '{}' }); };
  try {
    const first = await run(); assert.equal(first.status, 503); assert.equal((await first.text()).includes('fake-credential-secret'), false);
    await api.close(); fixture.reopen();
    api = await startApi({ ...ports.deps, store: fixture.store, auth });
    const pending = await run(); assert.equal(pending.status, 503); assert.equal((await pending.json()).code, 'REQUEST_PENDING'); assert.equal(probes, 1);
    await api.close();
    api = await startApi({ ...ports.deps, store: fixture.store, auth, async reconcileRequest(request) { assert.equal(request.key, 'unknown'); reconciles++; return { state: 'complete', body: { status: 'ready', reasons: [] } }; } });
    assert.equal((await run()).status, 200); assert.equal((await run()).status, 200); assert.equal(probes, 1); assert.equal(reconciles, 1);
  } finally { await api.close(); fixture.close(); }
});

test('rejects_rebinding_untrusted_bootstrap_bad_bodies_and_excessive_requests', async () => {
  const f = await setup(); try {
    const rebound = await new Promise<number>(resolve => { const req = httpRequest(f.api.url + '/v1/snapshot', { headers: { ...f.headers, host: 'attacker.test' } }, res => { res.resume(); resolve(res.statusCode!); }); req.end(); });
    assert.equal(rebound, 403);
    assert.equal((await f.call('/v1/session', 'POST', {}, { 'idempotency-key': 'bootstrap' })).status, 404);
    assert.equal((await f.call('/v1/auth/device-flow/not-paired', 'GET', undefined, { cookie: '' })).status, 401);
    assert.equal((await f.call('/v1/tags', 'POST', { displayName: 'valid', token: 'bad' }, { 'idempotency-key': 'invalid' })).status, 400);
    assert.equal((await f.call('/v1/tags', 'POST', { displayName: 'valid' })).status, 400);
    assert.equal((await f.call('/v1/settings', 'PATCH', {}, { 'idempotency-key': 'revision' })).status, 400);
    assert.equal((await f.call('/v1/tasks/%ZZ')).status, 400);
    const oversized = await f.call('/v1/tags', 'POST', { displayName: 'x'.repeat(1024 * 1024) }, { 'idempotency-key': 'large' });
    assert.equal(oversized.status, 400);
  } finally { await f.close(); }
});

test('expired_event_window_requires_snapshot_reset_without_replaying_commands', async () => {
  const f = await setup(); await f.api.close();
  const api = await startApi({ ...f.ports.deps, events: { retention: 2, pollMs: 10 } });
  try {
    const old = f.fixture.store.snapshot().cursor;
    for (let i = 0; i < 3; i++) f.fixture.store.createTag({ displayName: 'retained' + i });
    const session = api.sessions.provision(origin); const headers = { ...f.headers, cookie: session.cookie, 'x-sf-csrf': session.csrfToken, 'last-event-id': old };
    const response = await fetch(api.url + '/v1/events', { headers });
    assert.equal(response.status, 409); assert.equal((await response.json()).code, 'STALE_CURSOR'); assert.equal(f.ports.dispatches, 0);
  } finally { await api.close(); f.fixture.close(); }
});

test('external_error_after_effect_is_not_falsely_completed', async () => {
  const f = await setup(); await f.api.close();
  const { StoreError } = await import('../../src/storage/store.ts');
  let calls = 0;
  const api = await startApi({ ...f.ports.deps, auth: {
    async state() { return { status: 'missing', reasons: [] }; },
    async probe() { calls++; throw new StoreError('transport_unknown', 'fake-credential-secret'); },
    async startDeviceFlow() { throw new Error(); }, async deviceFlow() { throw new Error(); }, async completeDeviceFlow() { throw new Error(); },
  } });
  try {
    const session = api.sessions.provision(origin); const headers = { ...f.headers, cookie: session.cookie, 'x-sf-csrf': session.csrfToken, 'idempotency-key': 'store-error' };
    const run = () => fetch(api.url + '/v1/auth/probe', { method: 'POST', headers, body: '{}' });
    await run(); const replay = await run();
    assert.equal(replay.status, 503); assert.equal((await replay.json()).code, 'REQUEST_PENDING'); assert.equal(calls, 1);
  } finally { await api.close(); f.fixture.close(); }
});

test('same_origin_browser_reads_work_without_an_origin_header', async () => {
  const f = await setup(); await f.api.close();
  const api = await startApi({ ...f.ports.deps, listen: { port: Number(new URL(f.api.url).port) }, session: { allowedOrigins: [origin, f.api.url] } });
  try {
    const session = api.sessions.provision(api.url);
    assert.equal((await fetch(api.url + '/v1/snapshot', { headers: { cookie: session.cookie, 'sec-fetch-site': 'same-origin' } })).status, 200);
    assert.equal((await fetch(api.url + '/v1/snapshot', { headers: { cookie: session.cookie, 'sec-fetch-site': 'cross-site' } })).status, 403);
  } finally { await api.close(); f.fixture.close(); }
});

test('crud_routes_validate_wire_results_and_rotation_preview_does_not_move_cursor', async () => {
  const f = await setup(); let n = 0;
  const mutate = (path: string, method: string, body: unknown, revision?: number) => f.call(path, method, body, { 'idempotency-key': `crud-${n++}`, ...(revision === undefined ? {} : { 'if-match': String(revision) }) });
  try {
    for (const path of ['/v1/health', '/v1/settings', '/v1/repositories', '/v1/tasks', `/v1/tasks/${f.fixture.task.id}`, '/v1/recipes', '/v1/recipes/recipe-1']) assert.equal((await f.call(path)).status, 200, path);
    assert.equal((await mutate('/v1/repositories/repo-1', 'PATCH', { active: true }, 1)).status, 200);
    const tag = f.fixture.store.snapshot().tags[0]!;
    assert.equal((await mutate('/v1/repositories/repo-1/weights', 'PATCH', { weights: { [tag.id]: 90 } }, 2)).status, 200);
    const rotation = f.fixture.store.getRotationState('repo-1'); const sequence = f.fixture.store.snapshot().sequence;
    assert.equal((await f.call('/v1/repositories/repo-1/rotation-preview')).status, 200);
    assert.deepEqual(f.fixture.store.getRotationState('repo-1'), rotation); assert.equal(f.fixture.store.snapshot().sequence, sequence);
    const created = await (await mutate('/v1/tags', 'POST', { displayName: 'API tag' })).json();
    assert.equal((await mutate(`/v1/tags/${created.id}`, 'PATCH', { displayName: 'Renamed' }, 1)).status, 200);
    const archived = await mutate(`/v1/tags/${created.id}/archive`, 'POST', { reassignToTagId: tag.id }, 2);
    assert.equal(archived.status, 200); assert.ok((await archived.json()).archivedAt);
    const unused = await (await mutate('/v1/tags', 'POST', { displayName: 'Unused' })).json();
    assert.equal((await mutate(`/v1/tags/${unused.id}`, 'DELETE', undefined, 1)).status, 200);
    assert.equal((await mutate(`/v1/tasks/${f.fixture.task.id}`, 'PATCH', { title: 'Changed' }, 1)).status, 200);
    assert.equal((await mutate(`/v1/tasks/${f.fixture.task.id}`, 'PATCH', { status: 'cancelled' }, 2)).status, 200);
    const archivedTask = await mutate(`/v1/tasks/${f.fixture.task.id}`, 'DELETE', undefined, 3);
    assert.equal(archivedTask.status, 200); assert.ok((await archivedTask.json()).archivedAt);
    assert.equal((await mutate('/v1/recipes/recipe-1', 'PATCH', { active: true }, 1)).status, 503);
    assert.equal(f.fixture.store.snapshot().recipes[0]!.active, true);
    assert.equal((await f.call('/v1/tasks/absent')).status, 404);
    assert.equal((await mutate('/v1/dispatch', 'POST', {})).status, 200);
  } finally { await f.close(); }
});

test('typed_auth_and_recipe_routes_delegate_stable_keys_and_overlay_real_readiness', async () => {
  const f = await setup(); await f.api.close();
  const calls: string[] = []; const flow = { id: 'flow', userCode: 'USER-CODE', verificationUri: 'https://github.com/login/device', expiresAt: '2099-01-01T00:00:00Z', pollIntervalMs: 5000, status: 'pending' as const };
  const authState = { status: 'ready' as const, login: 'user', reasons: [] };
  const api = await startApi({ ...f.ports.deps,
    health: async () => ({ schemaVersion: 1, ready: true, reasons: [], version: 'runtime' }),
    auth: { state: async () => authState, probe: async c => { calls.push('probe:' + c.key); return authState; }, startDeviceFlow: async c => { calls.push('start:' + c.key); return flow; }, deviceFlow: async id => { assert.equal(id, 'flow'); return flow; }, completeDeviceFlow: async (id, c) => { assert.equal(id, 'flow'); calls.push('complete:' + c.key); return authState; } },
    recipes: { patch: async (id, input, c) => f.fixture.store.patchRecipe(id, input, c.expectedRevision!), create: async (_input, c) => { calls.push('create:' + c.key); return f.fixture.recipe; }, validate: async (_input, c) => { calls.push('validate:' + c.key); return { valid: false, errors: ['Untrusted recipe requires explicit capabilities'] }; }, revise: async (id, _input, c) => { assert.equal(id, 'recipe-1'); assert.equal(c.expectedRevision, 1); calls.push('revise:' + c.key); return f.fixture.recipe; } },
  });
  try {
    const session = api.sessions.provision(origin); const headers = { ...f.headers, cookie: session.cookie, 'x-sf-csrf': session.csrfToken };
    const run = (path: string, key: string, body: unknown = {}, revision?: number) => fetch(api.url + path, { method: 'POST', headers: { ...headers, 'idempotency-key': key, ...(revision ? { 'if-match': String(revision) } : {}) }, body: JSON.stringify(body) });
    for (const [path, key] of [['/v1/auth/probe', 'probe'], ['/v1/auth/device-flow', 'start'], ['/v1/auth/device-flow/flow/complete', 'complete']]) assert.equal((await run(path!, key!)).status, 200);
    assert.equal((await fetch(api.url + '/v1/auth/device-flow/flow', { headers })).status, 200);
    assert.equal((await run('/v1/recipes', 'create', { yaml: 'id: fake' })).status, 200);
    assert.equal((await run('/v1/recipes/validate', 'validate', { yaml: 'id: fake' })).status, 200);
    assert.equal((await run('/v1/recipes/recipe-1/revisions', 'stale-recipe', { yaml: 'id: fake' }, 999)).status, 409);
    assert.equal((await run('/v1/recipes/recipe-1/revisions', 'revise', { yaml: 'id: fake' }, 1)).status, 200);
    const snapshot = await (await fetch(api.url + '/v1/snapshot', { headers })).json(); assert.equal(snapshot.health.ready, true); assert.equal(snapshot.auth.status, 'ready');
    assert.deepEqual(calls, ['probe:probe', 'start:start', 'complete:complete', 'create:create', 'validate:validate', 'revise:revise']);
    assert.equal((await run('/v1/recipes', 'create', { yaml: 'id: fake' })).status, 200); assert.equal(calls.length, 6);
    assert.equal((await fetch(api.url + '/v1/recipes/recipe-1', { method: 'PATCH', headers: { ...headers, 'idempotency-key': 'recipe-patch', 'if-match': '1' }, body: JSON.stringify({ active: false }) })).status, 200);
    assert.equal(f.fixture.store.snapshot().recipes[0]!.active, false);
  } finally { await api.close(); f.fixture.close(); }
});

test('real_scheduler_and_lifecycle_preserve_session_input_and_takeover_control', async () => {
  const x = fakeRuntime(); const api = await startApi(x.deps); let key = 0;
  const session = api.sessions.provision(origin);
  const headers = { origin, cookie: session.cookie, 'x-sf-csrf': session.csrfToken, 'content-type': 'application/json' };
  const run = (path: string, body: unknown, revision?: number, fixedKey?: string) => fetch(api.url + path, { method: 'POST', headers: { ...headers, 'idempotency-key': fixedKey ?? `runtime-${key++}`, ...(revision ? { 'if-match': String(revision) } : {}) }, body: JSON.stringify(body) });
  try {
    const created = await run('/v1/tasks', x.fixture.request); assert.equal(created.status, 200);
    const attempt = x.fixture.store.snapshot().attempts[0]!; assert.ok(attempt); assert.equal(attempt.taskId, x.fixture.task.id);
    const dispatch = await run('/v1/dispatch', {}); assert.equal(dispatch.status, 200); assert.equal((await dispatch.json()).admitted, false);
    await x.lifecycle.applyOwnerEvent(attempt.id, { type: 'input', identity: x.native, at: x.fixture.clock.wallNow().toISOString(), input: { id: 'native-question', prompt: 'Pick a name', schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } } });
    const request = x.fixture.store.snapshot().attention.find(a => a.nativeInputId === 'native-question')!;
    assert.equal((await run(`/v1/attention/${request.id}/respond`, { input: { name: 'value' }, fence: 99 }, request.revision)).status, 400);
    assert.equal((await run(`/v1/attention/${request.id}/respond`, { input: { name: 'value' } }, request.revision + 1)).status, 409);
    const before = x.fixture.store.getQuotaState().confirmed;
    const answered = await run(`/v1/attention/${request.id}/respond`, { input: { name: 'value' } }, request.revision, 'answer');
    assert.equal(answered.status, 200); assert.equal(x.sent.length, 1); assert.deepEqual(x.sent[0]!.identity, x.native);
    assert.deepEqual(x.sent[0]!.input, { requestId: 'native-question', response: { name: 'value' }, answers: { name: 'value' } });
    assert.equal((await run(`/v1/attention/${request.id}/respond`, { input: { name: 'value' } }, request.revision, 'answer')).status, 200); assert.equal(x.sent.length, 1); assert.equal(x.fixture.store.getQuotaState().confirmed, before);
    assert.equal((await run(`/v1/tasks/${attempt.taskId}/open-native`, {})).status, 409);
    let task = x.fixture.store.getTask(attempt.taskId)!;
    assert.equal((await run(`/v1/tasks/${task.spec.id}/takeover`, {}, task.revision + 1)).status, 409);
    assert.equal((await run(`/v1/tasks/${task.spec.id}/takeover`, {}, task.revision, 'takeover')).status, 200); assert.equal(x.opened.length, 1);
    assert.equal((await run(`/v1/tasks/${task.spec.id}/takeover`, {}, task.revision, 'takeover')).status, 200); assert.equal(x.opened.length, 1);
    assert.equal((await run(`/v1/tasks/${task.spec.id}/open-native`, {}, undefined, 'open')).status, 200); assert.equal(x.opened.length, 2);
    assert.equal((await run(`/v1/tasks/${task.spec.id}/open-native`, {}, undefined, 'open')).status, 200); assert.equal(x.opened.length, 2); assert.ok(x.opened.every(n => n.sessionId === x.native.sessionId));
    const repo = x.fixture.store.getRepository('repo-1')!;
    assert.equal((await run('/v1/repositories/repo-1/return-control', {}, repo.revision + 1)).status, 409);
    assert.equal((await run('/v1/repositories/repo-1/return-control', {}, repo.revision)).status, 200); assert.equal(x.fixture.store.getRepository('repo-1')!.controlMode, 'factory');
  } finally { await api.close(); x.fixture.close(); }
});

test('trusted_one_time_pairing_exchanges_a_bound_token_and_cannot_issue_or_reuse_privilege', async () => {
  const f = await setup(); try {
    const pairing = f.api.sessions.issuePairing(origin);
    const exchange = (token: string, from = origin) => fetch(f.api.url + '/v1/session/pair', { method: 'POST', headers: { origin: from, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    assert.equal((await exchange('guessed')).status, 401);
    assert.equal((await exchange(pairing.token, 'https://evil.test')).status, 403);
    const response = await exchange(pairing.token); assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie')!; assert.ok(cookie.includes('HttpOnly')); assert.ok(cookie.includes('SameSite=Strict')); assert.ok(!cookie.includes('Domain='));
    const result = await response.json(); assert.equal(typeof result.csrfToken, 'string'); assert.equal(JSON.stringify(result).includes('sf_session'), false);
    assert.equal((await exchange(pairing.token)).status, 401);
    assert.equal((await fetch(f.api.url + '/v1/settings', { method: 'PATCH', headers: { origin, cookie, 'x-sf-csrf': result.csrfToken, 'idempotency-key': 'paired', 'if-match': '1', 'content-type': 'application/json' }, body: '{"paused":true}' })).status, 200);
  } finally { await f.close(); }
});

test('expired_pairing_and_session_tokens_are_rejected_and_listener_rejects_nonloopback', async () => {
  const f = await setup(); await f.api.close();
  const api = await startApi({ ...f.ports.deps, session: { allowedOrigins: [origin], ttlMs: 10, pairingTtlMs: 10 } });
  try {
    const pairing = api.sessions.issuePairing(origin); const session = api.sessions.provision(origin);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal((await fetch(api.url + '/v1/session/pair', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: pairing.token }) })).status, 401);
    assert.equal((await fetch(api.url + '/v1/snapshot', { headers: { origin, cookie: session.cookie } })).status, 401);
    await assert.rejects(startApi({ ...f.ports.deps, listen: { host: '0.0.0.0' as '127.0.0.1' } }), /loopback/);
  } finally { await api.close(); f.fixture.close(); }
});

test('snapshots_events_and_errors_redact_broker_values_and_provider_token_patterns', async () => {
  const { materializeFixture } = await import('../helpers/fixtures.ts');
  const fixture = createFixture({ materialize: c => ({ ...materializeFixture(c), context: { 'fake-credential-secret': { accessToken: 'opaque-value', nested: 'ghp_abcdefghijk1234' } } }) });
  const ports = fakePorts(fixture.store); const api = await startApi(ports.deps);
  try {
    const session = api.sessions.provision(origin); const headers = { origin, cookie: session.cookie };
    const snapshot = await (await fetch(api.url + '/v1/snapshot', { headers })).text();
    assert.equal(snapshot.includes('fake-credential-secret'), false); assert.equal(snapshot.includes('opaque-value'), false); assert.equal(snapshot.includes('ghp_abcdefghijk1234'), false);
    const created = await fetch(api.url + '/v1/tasks', { method: 'POST', headers: { ...headers, 'x-sf-csrf': session.csrfToken, 'idempotency-key': 'safe-journal', 'content-type': 'application/json' }, body: JSON.stringify(fixture.request) });
    assert.equal(created.status, 200);
    const db = new DatabaseSync(fixture.path); const journal = String(db.prepare('SELECT result FROM api_requests WHERE key = ?').get('safe-journal')!.result); db.close();
    for (const value of ['fake-credential-secret', 'opaque-value', 'ghp_abcdefghijk1234', session.csrfToken, session.cookie.split(';')[0]!]) assert.equal(journal.includes(value), false);
    const cursor = fixture.store.snapshot().cursor;
    fixture.store.patchTask(fixture.task.id, { title: 'fake-credential-secret' }, 1);
    const controller = new AbortController(); const event = await fetch(api.url + '/v1/events', { headers: { ...headers, 'last-event-id': cursor }, signal: controller.signal });
    const text = await readFrames(event, frame => frame.includes('event: task\n')); controller.abort();
    assert.equal(text.includes('fake-credential-secret'), false); assert.equal(text.includes('opaque-value'), false); assert.equal(text.includes('ghp_abcdefghijk1234'), false);
  } finally { await api.close(); fixture.close(); }
});

test('sse_reconnect_delivers_each_later_cursor_once_and_manual_dispatch_maps_real_attempt', async () => {
  const x = fakeRuntime(); const api = await startApi(x.deps);
  try {
    const session = api.sessions.provision(origin); const headers = { origin, cookie: session.cookie, 'x-sf-csrf': session.csrfToken, 'content-type': 'application/json' };
    const result = await fetch(api.url + '/v1/dispatch', { method: 'POST', headers: { ...headers, 'idempotency-key': 'dispatch' }, body: '{}' });
    assert.equal(result.status, 200); const publicResult = await result.json(); assert.equal(publicResult.admitted, true); assert.equal(publicResult.taskId, x.fixture.task.id); assert.equal(publicResult.attemptId, x.fixture.store.snapshot().attempts[0]!.id);
    assert.deepEqual(await (await fetch(api.url + '/v1/dispatch', { method: 'POST', headers: { ...headers, 'idempotency-key': 'dispatch' }, body: '{}' })).json(), publicResult); assert.equal(x.fixture.store.snapshot().attempts.length, 1);
    let cursor = x.fixture.store.snapshot().cursor;
    const read = async () => {
      const controller = new AbortController(); const response = await fetch(api.url + '/v1/events', { headers: { ...headers, 'last-event-id': cursor }, signal: controller.signal });
      const text = await readFrames(response, frame => frame.includes('event: tag\n')); controller.abort();
      return [...text.matchAll(/^id: (\d+)$/gm)].map(m => m[1]!);
    };
    x.fixture.store.createTag({ displayName: 'one' }); const first = await read(); assert.equal(first.length, 1); cursor = first[0]!;
    x.fixture.store.createTag({ displayName: 'two' }); const second = await read(); assert.equal(second.length, 1); assert.ok(Number(second[0]) > Number(cursor)); assert.equal(second.includes(cursor), false);
  } finally { await api.close(); x.fixture.close(); }
});

test('open_native_requires_proven_repository_quiescence_even_if_control_was_paused', async () => {
  const x = fakeRuntime(); await x.scheduler.dispatch('manual');
  const api = await startApi(x.deps);
  try {
    // C4 takeover pauses repository control before waiting for native/workflow quiescence.
    x.fixture.store.setRepositoryControl('repo-1', 'human', x.fixture.store.getRepository('repo-1')!.revision);
    const session = api.sessions.provision(origin);
    const response = await fetch(api.url + `/v1/tasks/${x.fixture.task.id}/open-native`, { method: 'POST', headers: { origin, cookie: session.cookie, 'x-sf-csrf': session.csrfToken, 'idempotency-key': 'unsafe-open', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 409); assert.equal(x.opened.length, 0);
  } finally { await api.close(); x.fixture.close(); }
});

test('definitive_auth_and_recipe_refusals_replay_exact_safe_errors_across_restart', async () => {
  const apiModule = await import('../../src/service/api.ts');
  const fixture = createFixture(); const ports = fakePorts(fixture.store); let appCalls = 0; let recipeCalls = 0;
  const appError = { code: 'APP_NOT_CONFIGURED', message: 'Publisher App is missing: fake-credential-secret', recovery: 'Configure the publisher GitHub App', retryable: false };
  const recipeError = { code: 'INVALID_RECIPE', message: 'Invalid YAML ghp_abcdefghijk1234', recovery: 'Fix the recipe YAML before importing', retryable: false };
  const auth = { state: async () => ({ status: 'unavailable' as const, reasons: [] }), probe: async () => { throw new Error(); }, deviceFlow: async () => { throw new Error(); }, completeDeviceFlow: async () => { throw new Error(); }, startDeviceFlow: async () => { appCalls++; throw new apiModule.DefinitiveNoEffect(503, appError); } };
  const recipes = { patch: async () => { throw new Error(); }, validate: async () => { throw new Error(); }, revise: async () => { throw new Error(); }, create: async () => { recipeCalls++; throw new apiModule.DefinitiveNoEffect(400, recipeError); } };
  let api = await startApi({ ...ports.deps, auth, recipes });
  const run = (path: string, key: string, body: unknown) => { const session = api.sessions.provision(origin); return fetch(api.url + path, { method: 'POST', headers: { origin, cookie: session.cookie, 'x-sf-csrf': session.csrfToken, 'idempotency-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) }); };
  const cases = [
    { path: '/v1/auth/device-flow', key: 'known-app', body: {}, status: 503, error: { ...appError, message: 'Publisher App is missing: [redacted]' } },
    { path: '/v1/recipes', key: 'known-yaml', body: { yaml: 'invalid:' }, status: 400, error: { ...recipeError, message: 'Invalid YAML [redacted]' } },
  ];
  try {
    for (const c of cases) { const response = await run(c.path, c.key, c.body); assert.equal(response.status, c.status); assert.deepEqual(await response.json(), c.error); }
    await api.close(); fixture.reopen(); api = await startApi({ ...ports.deps, store: fixture.store, auth, recipes });
    for (const c of cases) { const response = await run(c.path, c.key, c.body); assert.equal(response.status, c.status); assert.deepEqual(await response.json(), c.error); }
    assert.equal(appCalls, 1); assert.equal(recipeCalls, 1);
    const db = new DatabaseSync(fixture.path); const rows = db.prepare('SELECT state, result FROM api_requests WHERE key IN (?, ?)').all('known-app', 'known-yaml'); db.close();
    assert.equal(rows.length, 2); for (const row of rows) { assert.equal(row.state, 'complete'); assert.equal(String(row.result).includes('fake-credential-secret'), false); assert.equal(String(row.result).includes('ghp_abcdefghijk1234'), false); }
  } finally { await api.close(); fixture.close(); }
});

test('reconciled_no_effect_failure_completes_exact_safe_error_without_reinvoking_the_port', async () => {
  const fixture = createFixture(); const ports = fakePorts(fixture.store); let calls = 0; let reconciles = 0;
  const error = { code: 'AUTH_DENIED', message: 'Denied fake-credential-secret', recovery: 'Authorize the configured App', retryable: false };
  const auth = { state: async () => ({ status: 'missing' as const, reasons: [] }), probe: async () => { calls++; throw new Error('lost transport'); }, startDeviceFlow: async () => { throw new Error(); }, deviceFlow: async () => { throw new Error(); }, completeDeviceFlow: async () => { throw new Error(); } };
  const api = await startApi({ ...ports.deps, auth, reconcileRequest: async () => { reconciles++; return { state: 'failed', status: 403, error }; } });
  try {
    const session = api.sessions.provision(origin); const run = () => fetch(api.url + '/v1/auth/probe', { method: 'POST', headers: { origin, cookie: session.cookie, 'x-sf-csrf': session.csrfToken, 'idempotency-key': 'known-reconciliation', 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await run()).status, 503);
    for (let i = 0; i < 2; i++) { const response = await run(); assert.equal(response.status, 403); assert.deepEqual(await response.json(), { ...error, message: 'Denied [redacted]' }); }
    assert.equal(calls, 1); assert.equal(reconciles, 1);
  } finally { await api.close(); fixture.close(); }
});

test('schema_field_identifiers_survive_http_snapshot_events_answers_and_journal_while_instance_credentials_are_redacted', async () => {
  const x = fakeRuntime();
  const schema = {
    type: 'object', properties: {
      password: { type: 'string', minLength: 3, default: 'opaque-password-default', examples: ['opaque-password-example'] },
      accessToken: { $ref: '#/$defs/accessToken' },
      nested: { type: 'object', properties: { secret: { type: 'string', default: 'opaque-nested-default' } }, required: ['secret'], additionalProperties: false },
    },
    $defs: { accessToken: { type: 'string', default: 'opaque-token-default', examples: ['opaque-token-example'] } },
    required: ['password', 'accessToken', 'nested'], additionalProperties: false,
    default: { password: 'opaque-object-default', accessToken: 'opaque-object-token' },
    examples: [{ password: 'opaque-object-example', accessToken: 'opaque-example-token' }],
  };
  const recipe = structuredClone(x.fixture.recipe); recipe.id = 'recipe-1:schema-rev'; recipe.revision = 'schema-rev';
  recipe.contract.variables.sf.inputSchema = schema;
  recipe.contract.variables.sf.taskTemplate.context = { inputSchema: schema,
    response: { password: 'opaque-response', accessToken: 'opaque-response-token' },
    schema: { type: 'object', properties: { password: { type: 'string' } }, password: 'opaque-schema-instance' },
  };
  x.fixture.store.saveRecipeRevision(recipe, x.fixture.store.snapshot().recipes[0]!.revision);
  await x.scheduler.dispatch('manual'); const attempt = x.fixture.store.snapshot().attempts[0]!;
  const cursor = x.fixture.store.snapshot().cursor;
  await x.lifecycle.applyOwnerEvent(attempt.id, { type: 'input', identity: x.native, at: x.fixture.clock.wallNow().toISOString(), input: { id: 'credential-fields', prompt: 'Supply input', schema } });
  const api = await startApi(x.deps); const session = api.sessions.provision(origin);
  const headers = { origin, cookie: session.cookie, 'x-sf-csrf': session.csrfToken, 'content-type': 'application/json' };
  const answer = { password: 'answer-password', accessToken: 'answer-token', nested: { secret: 'answer-secret' } };
  const assertSchema = (value: typeof schema) => {
    assert.equal(typeof value.properties.password, 'object'); assert.equal(value.properties.password.type, 'string');
    assert.equal(typeof value.$defs.accessToken, 'object'); assert.equal(value.properties.accessToken.$ref, '#/$defs/accessToken');
    assert.deepEqual(value.required, ['password', 'accessToken', 'nested']); assert.deepEqual(value.properties.nested.required, ['secret']);
    const ajv = new Ajv2020({ strict: false }); assert.equal(ajv.validateSchema(value), true); assert.equal(ajv.compile(value)(answer), true);
    assert.equal(value.properties.password.default, '[redacted]'); assert.deepEqual(value.properties.password.examples, ['[redacted]']);
    assert.equal(value.$defs.accessToken.default, '[redacted]'); assert.deepEqual(value.$defs.accessToken.examples, ['[redacted]']);
    assert.equal(value.properties.nested.properties.secret.default, '[redacted]');
    assert.equal(value.default.password, '[redacted]'); assert.equal(value.examples[0]!.accessToken, '[redacted]');
  };
  const assertNoInstanceSecrets = (value: unknown) => {
    const text = JSON.stringify(value);
    for (const secret of ['opaque-password-default', 'opaque-password-example', 'opaque-nested-default', 'opaque-token-default', 'opaque-token-example', 'opaque-object-default', 'opaque-object-token', 'opaque-object-example', 'opaque-example-token', 'opaque-response', 'opaque-response-token', 'opaque-schema-instance']) assert.equal(text.includes(secret), false, secret);
  };
  try {
    const created = await fetch(api.url + '/v1/tasks', { method: 'POST', headers: { ...headers, 'idempotency-key': 'schema-create' }, body: JSON.stringify(x.fixture.request) });
    assert.equal(created.status, 200); const records = await created.json(); assertSchema(records[0].spec.context.inputSchema); assertNoInstanceSecrets(records);
    assert.equal(records[0].spec.context.response.password, '[redacted]'); assert.equal(records[0].spec.context.schema.password, '[redacted]');
    const snapshot = await (await fetch(api.url + '/v1/snapshot', { headers })).json();
    const attention = snapshot.attention.find((a: { nativeInputId: string }) => a.nativeInputId === 'credential-fields'); assert.ok(attention); assertSchema(attention.inputSchema); assertNoInstanceSecrets(snapshot);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 1000);
    try {
      const response = await fetch(api.url + '/v1/events', { headers: { ...headers, 'last-event-id': cursor }, signal: controller.signal }); assert.equal(response.status, 200);
      const text = await readFrames(response, frame => frame.includes('event: attention\n'));
      const frame = text.split('\n\n').find(frame => frame.includes('event: attention\n'))!;
      const event = JSON.parse(frame.split('\n').find(line => line.startsWith('data: '))!.slice(6));
      assertSchema(event.data.inputSchema); assertNoInstanceSecrets(event);
    } finally { clearTimeout(timer); controller.abort(); }
    const answered = await fetch(api.url + `/v1/attention/${attention.id}/respond`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'schema-answer', 'if-match': String(attention.revision) }, body: JSON.stringify({ input: answer }) });
    assert.equal(answered.status, 200); assertSchema((await answered.json()).inputSchema); assert.deepEqual(x.sent[0]!.input, { requestId: 'credential-fields', response: answer, answers: answer });
    const db = new DatabaseSync(x.fixture.path); const rows = db.prepare('SELECT key, result FROM api_requests WHERE key IN (?, ?)').all('schema-create', 'schema-answer'); db.close();
    assert.equal(rows.length, 2);
    for (const row of rows) { const result = JSON.parse(String(row.result)); assertNoInstanceSecrets(result); assertSchema(row.key === 'schema-create' ? result.body[0].spec.context.inputSchema : result.body.inputSchema); }
  } finally { await api.close(); x.fixture.close(); }
});

test('invalid_explicit_failure_status_or_error_cannot_complete_a_pending_request', async () => {
  const apiModule = await import('../../src/service/api.ts');
  const fixture = createFixture(); const ports = fakePorts(fixture.store); let calls = 0;
  const error = { code: 'REFUSED', message: 'Command refused', recovery: 'Fix the configuration', retryable: false };
  const auth = { state: async () => ({ status: 'missing' as const, reasons: [] }),
    probe: async () => { calls++; throw new apiModule.DefinitiveNoEffect(200 as ApiFailureStatus, error); },
    startDeviceFlow: async () => { throw new Error(); }, deviceFlow: async () => { throw new Error(); }, completeDeviceFlow: async () => { throw new Error(); } };
  let proof: Reconciliation = { state: 'failed', status: 200 as ApiFailureStatus, error };
  const api = await startApi({ ...ports.deps, auth, reconcileRequest: async () => proof });
  try {
    const session = api.sessions.provision(origin); const run = () => fetch(api.url + '/v1/auth/probe', { method: 'POST', headers: { origin, cookie: session.cookie, 'x-sf-csrf': session.csrfToken, 'idempotency-key': 'invalid-proof', 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await run()).status, 503); assert.equal((await run()).status, 503);
    proof = { state: 'failed', status: 400, error: { ...error, retryable: 'false' } as unknown as typeof error };
    assert.equal((await run()).status, 503);
    const db = new DatabaseSync(fixture.path); assert.equal(db.prepare('SELECT state FROM api_requests WHERE key = ?').get('invalid-proof')!.state, 'pending'); db.close();
    proof = { state: 'failed', status: 400, error };
    const refused = await run(); assert.equal(refused.status, 400); assert.deepEqual(await refused.json(), error); assert.equal(calls, 1);
  } finally { await api.close(); fixture.close(); }
});

test('maintenance admission closes dashboard mutations while preserving read access', async () => {
  const { MaintenanceGate } = await import('../../src/service/maintenance-gate.ts');
  const fixture = createFixture(); const ports = fakePorts(fixture.store); const gate = new MaintenanceGate();
  const api = await startApi({ ...ports.deps, maintenanceGate: gate });
  try {
    const session = api.sessions.provision(origin); await gate.close();
    const headers = { origin, cookie: session.cookie, 'x-sf-csrf': session.csrfToken, 'content-type': 'application/json', 'idempotency-key': 'maintenance' };
    const response = await fetch(api.url + '/v1/tasks', { method: 'POST', headers, body: JSON.stringify(fixture.request) });
    assert.equal(response.status, 503);
    assert.equal(ports.dispatches, 0);
    assert.equal((await fetch(api.url + '/v1/snapshot', { headers })).status, 200);
  } finally { await api.close(); fixture.close(); }
});

test('public_readiness_is_session_scoped_sanitized_and_does_not_qualify_or_dispatch', async () => {
  const f = await setup(); await f.api.close();
  let reads = 0;
  const api = await startApi({ ...f.ports.deps, readiness: async () => { reads++; return [{ ownerId: 'vscode', ready: false, reasons: ['Per-attempt verification required'], supportedProviders: ['copilot'], verifiedProfileIds: [], version: 'fixture', providers: [{ providerId: 'copilot', ready: false, reasons: ['fake-credential-secret'], verifiedProfileIds: [] }] }]; } });
  try {
    assert.equal((await fetch(api.url + '/v1/readiness', { headers: { origin } })).status, 401);
    const session = api.sessions.provision(origin);
    assert.equal((await fetch(api.url + '/v1/readiness', { headers: { origin: 'https://evil.test', cookie: session.cookie } })).status, 403);
    assert.equal(reads, 0);
    const response = await fetch(api.url + '/v1/readiness', { headers: { origin, cookie: session.cookie } });
    assert.equal(response.status, 200); const result = await response.json();
    assert.equal(result[0].ownerId, 'vscode'); assert.equal(result[0].providers[0].ready, false);
    assert.equal(JSON.stringify(result).includes('fake-credential-secret'), false);
    assert.equal(f.ports.dispatches, 0); assert.equal(reads, 1);
    assert.equal((await fetch(api.url + '/readiness', { headers: { origin, cookie: session.cookie } })).status, 404);
  } finally { await api.close(); f.fixture.close(); }
});

test('repository_catalog_and_explicit_selection_require_authenticated_session_and_csrf', async () => {
  const fixture = createFixture(); const ports = fakePorts(fixture.store);
  let selected = 0;
  const catalog = { async list() { return [{ githubId: '123', owner: 'octo', name: 'project', url: 'https://github.com/octo/project.git', defaultBranch: 'main' }]; },
    async select(id: string) { selected++; assert.equal(id, '123'); return fixture.store.createRepository({ id: 'github:123', name: 'octo/project', url: 'https://github.com/octo/project.git' }); } };
  const api = await startApi({ ...ports.deps, catalog });
  try {
    const session = api.sessions.provision(origin);
    const headers = { origin, cookie: session.cookie, 'x-sf-csrf': session.csrfToken, 'content-type': 'application/json', 'idempotency-key': 'select' };
    assert.equal((await fetch(api.url + '/v1/repository-catalog', { headers })).status, 200);
    assert.equal((await fetch(api.url + '/v1/repository-selections', { method: 'POST', headers: { ...headers, 'x-sf-csrf': '' }, body: JSON.stringify({ githubId: '123' }) })).status, 403);
    assert.equal(selected, 0);
    const response = await fetch(api.url + '/v1/repository-selections', { method: 'POST', headers, body: JSON.stringify({ githubId: '123' }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).active, false);
  } finally { await api.close(); fixture.close(); }
});

test('catalog_only_repository_cannot_be_activated_until_explicitly_selected', async () => {
  const fixture = createFixture(); const ports = fakePorts(fixture.store);
  const catalog = { async list() { return []; }, async select() { throw Error('unused'); }, allows() { return false; } };
  const api = await startApi({ ...ports.deps, catalog });
  try {
    const session = api.sessions.provision(origin);
    const headers = { origin, cookie:session.cookie, 'x-sf-csrf':session.csrfToken, 'content-type':'application/json', 'idempotency-key':'activate-unselected', 'if-match':'1' };
    const response = await fetch(api.url + '/v1/repositories/repo-1', { method:'PATCH', headers, body:JSON.stringify({active:true}) });
    assert.equal(response.status, 403); assert.equal(fixture.store.getRepository('repo-1')!.active, false);
  } finally { await api.close(); fixture.close(); }
});

test('manual_preflight_patch_dispatches_once_and_resolves_only_original_preflight_attention', async () => {
  const f = await setup(); try {
    const id = f.fixture.task.id;
    f.fixture.store.markAdmissionAttention(id, 1, 'owner_unavailable', 'Restore original owner');
    const original = f.fixture.store.snapshot().attention[0]!;
    const unrelated = { ...original, id: 'other-native-input', kind: 'input', source: 'owner', attemptId: 'native-attempt', nativeInputId: 'native-question' };
    const db = new DatabaseSync(f.fixture.path); db.prepare('INSERT INTO admission_attention(id,payload) VALUES (?,?)').run(unrelated.id, JSON.stringify(unrelated)); db.close();
    const headers = { 'idempotency-key': 'requeue-manual', 'if-match': '2' };
    const result = await f.call('/v1/tasks/'+id, 'PATCH', {}, headers); assert.equal(result.status, 200); assert.equal((await result.json()).status, 'queued');
    assert.equal(f.ports.dispatches, 1);
    assert.equal(f.fixture.store.snapshot().attention.find(a=>a.id===original.id)?.status, 'resolved');
    assert.equal(f.fixture.store.snapshot().attention.find(a=>a.id===unrelated.id)?.status, 'open');
    const replay = await f.call('/v1/tasks/'+id, 'PATCH', {}, headers); assert.equal(replay.status, 200); assert.equal(f.ports.dispatches, 1);
    assert.equal((await f.call('/v1/tasks/'+id, 'PATCH', {}, { 'idempotency-key':'stale-requeue', 'if-match':'2' })).status, 409);
    assert.equal(f.ports.dispatches, 1);
  } finally { await f.close(); }
});

test('manual_patch_respects_pause_and_limit_without_activating_repository_or_advancing_rotation', async () => {
  for (const gate of ['paused','capacity','day_limit'] as const) {
    const x = fakeRuntime(); const store = x.fixture.store;
    try {
      if(gate==='capacity'||gate==='day_limit') await x.scheduler.dispatch('manual');
      if(gate==='paused') store.patchSettings({paused:true},store.getSettings().revision);
      if(gate==='day_limit') store.patchSettings({limits:{...store.getSettings().config.limits,concurrency:2,startsPerDay:1}},store.getSettings().revision);
      const t = store.createManualTasks({...x.fixture.request,repositoryIds:['repo-2']},'blocked-'+gate)[0]!;
      store.markAdmissionAttention(t.id,1,'owner_unavailable','Restore owner');
      const before=store.getRotationState('repo-2'); let dispatched=0;let outcome='';
      const api=await startApi({...x.deps,scheduler:{async dispatch(trigger,key){dispatched++;const result=await x.scheduler.dispatch(trigger,key);outcome=result.kind==='noop'?result.code:result.kind;return result;}}});
      try {
        const session=api.sessions.provision(origin);const res=await fetch(api.url+'/v1/tasks/'+t.id,{method:'PATCH',headers:{origin,cookie:session.cookie,'x-sf-csrf':session.csrfToken,'content-type':'application/json','idempotency-key':'gate-'+gate,'if-match':'2'},body:'{}'});
        assert.equal(res.status,200);assert.equal(dispatched,1);assert.equal(outcome,gate);
        assert.equal(store.getTask(t.id)!.status,'queued');assert.equal(store.getRepository('repo-2')!.active,false);assert.deepEqual(store.getRotationState('repo-2'),before);
      }finally{await api.close();}
    }finally{x.fixture.close();}
  }
});

test('manual_requeue_runs_immediately_after_repair_and_cancellation_does_not_dispatch',async()=>{
  const x=fakeRuntime();const store=x.fixture.store;const id=x.fixture.task.id;let dispatches=0;
  store.markAdmissionAttention(id,1,'owner_unavailable','Restore owner');
  const api=await startApi({...x.deps,scheduler:{async dispatch(trigger,key){dispatches++;return x.scheduler.dispatch(trigger,key);}}});
  try{
    const session=api.sessions.provision(origin);const headers={origin,cookie:session.cookie,'x-sf-csrf':session.csrfToken,'content-type':'application/json'};
    const res=await fetch(api.url+'/v1/tasks/'+id,{method:'PATCH',headers:{...headers,'idempotency-key':'repair-start','if-match':'2'},body:JSON.stringify({description:'Repaired work'})});
    assert.equal(res.status,200);assert.equal((await res.json()).status,'queued');assert.equal(store.getTask(id)!.status,'running');assert.equal(dispatches,1);assert.equal(store.getRepository('repo-1')!.active,false);
    const t=store.createManualTasks({...x.fixture.request,repositoryIds:['repo-2']},'cancelled')[0]!;store.markAdmissionAttention(t.id,1,'blocked','Repair or cancel');
    const cancel=await fetch(api.url+'/v1/tasks/'+t.id,{method:'PATCH',headers:{...headers,'idempotency-key':'cancel-only','if-match':'2'},body:JSON.stringify({status:'cancelled'})});
    assert.equal(cancel.status,200);assert.equal(dispatches,1);assert.equal(store.snapshot().attention.find(a=>a.taskId===t.id)!.status,'resolved');
  }finally{await api.close();x.fixture.close();}
});

test('generated_task_requeue_preserves_takt_dispatch_and_stale_patch_keeps_attention_open',async()=>{
 const f=await setup();try{
  const [child]=f.fixture.store.createTasks(f.fixture.request,f.fixture.actor,'generated');
  f.fixture.store.markAdmissionAttention(child!.id,1,'preflight_unavailable','Restore boundary');
  const attention=f.fixture.store.snapshot().attention.find(a=>a.taskId===child!.id)!;
  const stale=await f.call('/v1/tasks/'+child!.id,'PATCH',{}, {'idempotency-key':'generated-stale','if-match':'1'});
  assert.equal(stale.status,409);assert.equal(f.fixture.store.snapshot().attention.find(a=>a.id===attention.id)!.status,'open');assert.equal(f.ports.dispatches,0);
  const response=await f.call('/v1/tasks/'+child!.id,'PATCH',{}, {'idempotency-key':'generated-requeue','if-match':'2'});
  assert.equal(response.status,200);assert.equal(f.ports.dispatches,0);assert.equal(f.fixture.store.getTask(child!.id)!.status,'queued');assert.equal(f.fixture.store.snapshot().attention.find(a=>a.id===attention.id)!.status,'resolved');
 }finally{await f.close();}
});
