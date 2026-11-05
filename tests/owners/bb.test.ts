import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Dynamic import lets RED report the absent production behavior as an assertion.
test('maps_native_threads_and_reconciles_without_event_replay', async () => {
  const bridge = await import('../../src/owners/bridge-rpc.ts').catch(() => undefined);
  assert.ok(bridge, 'production authenticated BB owner channel must exist');
  const { createBbOwner } = await import('../../src/owners/bb.ts');
  const directory = await mkdtemp(join(tmpdir(), 'sf-bb-'));
  let server: Awaited<ReturnType<typeof bridge.listenBbOwner>> | undefined;
  try {
    const pairingPath = await bridge.createOwnerPairing(directory, 'install-1', 'backend-1');
    server = await bridge.listenBbOwner({ pairingPath, authority: async () => { throw new Error('No admitted reservation'); } });
    const backend = await bridge.connectOwnerPeer(pairingPath);
    const identity = { ownerId: 'bb', providerId: 'codex' as const, sessionId: 'thr_original' };
    let snapshots = 0;
    backend.handle(async (method, request: any) => {
      assert.equal(method, 'owner');
      if (request.method === 'snapshot') { snapshots++; return { requestId: request.requestId, ok: true, method: 'snapshot', result: { identity, state: 'idle', inputs: [] } }; }
      return { requestId: request.requestId, ok: true, method: 'ensureStarted', result: null };
    });
    const owner = createBbOwner(server);
    const events: unknown[] = []; owner.subscribe(event => events.push(event));
    await owner.ensureStarted();
    assert.deepEqual((await owner.snapshot(identity)).identity, identity);
    backend.publish({ type: 'activity', identity, at: new Date().toISOString(), active: false });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(events.length, 1);
    backend.close();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(events.filter((e: any) => e.type === 'connection_lost').length, 1, 'lost backend must publish observational connection loss');
    const reconnected = await bridge.connectOwnerPeer(pairingPath);
    reconnected.handle(async (_method, request: any) => ({ requestId: request.requestId, ok: true, method: 'snapshot', result: { identity, state: 'idle', inputs: [] } }));
    assert.deepEqual((await owner.snapshot(identity)).identity, identity);
    assert.equal(snapshots, 1);
    assert.equal(events.filter((e: any) => e.type === 'activity').length, 1, 'events are never replayed');
    reconnected.close(); await server.close();
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('rejects_dispatch_without_repo_admission_or_profile', async () => {
  const module = await import('../../src/owners/bb.ts').catch(() => undefined);
  assert.ok(module, 'production BB NativeOwner must exist');
  const owner = module.createBbOwner({ rpc: async () => { throw new Error('BB backend unavailable; start BB'); }, subscribe: () => () => {} });
  await assert.rejects(owner.ensureStarted(), /backend unavailable/);
  const required = { paths: [], tools: [], credentialRefs: [], networkDestinations: [], allowedFinishPolicies: ['result' as const] };
  const capabilities = await owner.capabilities(required);
  assert.equal(capabilities.ready, false);
  assert.equal(capabilities.supportedProviders.includes('copilot'), false);
  assert.deepEqual(capabilities.verifiedProfileIds, []);
});

test('private owner pairing rejects browser frames, altered identities and unsafe token permissions', async () => {
  const { createOwnerPairing, listenBbOwner, connectOwnerPeer } = await import('../../src/owners/bridge-rpc.ts');
  const { readFile, writeFile, chmod } = await import('node:fs/promises');
  const { createConnection } = await import('node:net');
  const directory = await mkdtemp(join(tmpdir(), 'sf-bb-auth-'));
  let server: Awaited<ReturnType<typeof listenBbOwner>> | undefined;
  try {
    const path = await createOwnerPairing(directory, 'installation', 'backend');
    server = await listenBbOwner({ pairingPath: path, authority: async () => { throw new Error('not authorized'); } });
    const pairing = JSON.parse(await readFile(path, 'utf8'));
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(pairing.socketPath, () => socket.write('POST /owner/v1/rpc HTTP/1.1\r\nOrigin: https://browser.example\r\n\r\n'));
      socket.on('error', reject); socket.on('close', () => resolve());
    });
    await writeFile(path, JSON.stringify({ ...pairing, backendId: 'other-backend' }));
    await assert.rejects(connectOwnerPeer(path), /authentication|unavailable/);
    await writeFile(path, JSON.stringify(pairing));
    await chmod(path, 0o644);
    await assert.rejects(connectOwnerPeer(path), /authentication|unavailable/);
    await chmod(path, 0o600);
    const peer = await connectOwnerPeer(path); peer.close();
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('recorded client hello cannot claim the backend without proof of the fresh server challenge', async () => {
  const { createOwnerPairing, listenBbOwner } = await import('../../src/owners/bridge-rpc.ts');
  const { readFile } = await import('node:fs/promises'); const { createConnection } = await import('node:net'); const { createHmac } = await import('node:crypto');
  const directory = await mkdtemp(join(tmpdir(), 'sf-bb-replay-'));
  const path = await createOwnerPairing(directory, 'install', 'backend'); const pairing = JSON.parse(await readFile(path, 'utf8'));
  const server = await listenBbOwner({ pairingPath: path, authority: async () => null });
  const socket = createConnection(pairing.socketPath);
  try {
    const hello = { kind: 'hello', version: 1, installationId: 'install', backendId: 'backend', nonce: 'a'.repeat(64) };
    socket.write(JSON.stringify({ ...hello, signature: createHmac('sha256', pairing.secret).update(JSON.stringify(hello)).digest('hex') }) + '\n');
    await new Promise<void>(resolve => socket.once('data', () => resolve()));
    await assert.rejects(server.rpc({ requestId: 'test', method: 'ensureStarted', params: {} }), /backend unavailable/);
  } finally { socket.destroy(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('BB navigation authority requires actual C4 human control and its pending original-identity action', async () => {
  const module = await import('../../src/owners/bridge-rpc.ts');
  assert.equal(typeof module.createBbNavigationAuthority, 'function', 'concrete store-bound navigation authority required');
  const { createFixture } = await import('../helpers/store.ts'); const { materializeFixture, grantFixture } = await import('../helpers/fixtures.ts');
  const { createScheduler } = await import('../../src/scheduling/admission.ts'); const { createLifecycle } = await import('../../src/scheduling/lifecycle.ts');
  const f = createFixture();
  try {
    f.store.setTaskStatus(f.task.id, 'cancelled', 1);
    const recipe = structuredClone(f.recipe); recipe.id = 'bb:rev-1'; recipe.recipeId = 'bb'; recipe.contract.variables.sf.recipeId = 'bb'; recipe.contract.variables.sf.compatibleOwners = ['bb'];
    f.store.saveRecipeRevision(recipe); f.store.saveGrant({ ...grantFixture(recipe), id: 'bb-grant' });
    const task = f.store.createManualTasks({ ...f.request, recipeId: 'bb', ownerId: 'bb' }, 'bb-task')[0]!;
    const summary = f.store.snapshot().recipes.find(r => r.id === 'bb')!; f.store.setRecipeReadiness(summary.id, summary.currentRevision, { hash: f.recipe.hash, ready: true, reasons: [] }, summary.revision);
    const identity = { ownerId: 'bb', providerId: 'copilot' as const, sessionId: 'thr_original' };
    const readiness = async () => ({ ready: true as const, baseSha: 'base', workspacePath: '/owned', profileId: 'fixture' });
    const scheduler = createScheduler({ store: f.store, clock: f.clock, materialize: materializeFixture, readiness, start: async () => ({ kind: 'started', identity: { native: identity, workflow: { executionId: 'wf', namespace: 'sf', flowId: 'bb', revision: '1' } } }) });
    const dispatched = await scheduler.dispatch('manual'); assert.equal(dispatched.kind, 'started', JSON.stringify(dispatched));
    const authority = module.createBbNavigationAuthority(f.store);
    await assert.rejects(authority('open', { identity }), /human|navigation/i);
    let opens = 0;
    const lifecycle = createLifecycle({ store: f.store, clock: f.clock, readiness, workspace: async () => true, workflow: { snapshot: async () => 'present', quiesce: async () => 'stopped', resume: async () => {} }, owner: () => ({ capabilities: async () => ({ ready: false, reasons: [], supportedProviders: [], verifiedProfileIds: [], version: 'fixture' }), ensureStarted: async () => {}, ensureSession: async () => identity, snapshot: async () => ({ identity, state: 'idle', inputs: [] }), send: async () => {}, quiesce: async () => 'stopped', open: async () => { await authority('open', { identity }); opens++; return {}; }, subscribe: () => () => {} }) });
    await lifecycle.requestTakeover(task.id); assert.equal(opens, 1);
    await assert.rejects(authority('open', { identity }), /pending|navigation/i);
    await assert.rejects(authority('dispatch', { identity }), /unsupported|method/i);
  } finally { f.close(); }
});
