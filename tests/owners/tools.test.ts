import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from '../helpers/store.ts';
import { materializeFixture } from '../helpers/fixtures.ts';
import { createScheduler } from '../../src/scheduling/admission.ts';
import { createAttemptBroker } from '../../src/broker/operations.ts';
import type { NativeStart } from '../../src/contracts/domain.ts';
async function implementation() { const m = await import('../../src/owners/tools.ts').catch(() => undefined); assert.ok(m?.createFactoryToolGate, 'real scoped native client tool producer is required'); return m; }
async function fixture(bind = true, workspacePath = '/fixture') {
    const f = createFixture();
    const summary = f.store.snapshot().recipes[0]!;
    f.store.setRecipeReadiness(summary.id, summary.currentRevision, { hash: f.recipe.hash, ready: true, reasons: [] }, summary.revision);
    await createScheduler({ store: f.store, clock: f.clock, materialize: materializeFixture, readiness: async () => ({ ready: true, baseSha: 'base', workspacePath, profileId: 'fixture' }), start: async (r) => ({ kind: 'started', identity: { workflow: { executionId: r.attempt.id, namespace: 'sf', flowId: 'quality', revision: '1' } } }) }).dispatch('manual');
    const r = f.store.getReservations()[0]!;
    const broker = createAttemptBroker({ store: f.store, clock: f.clock, signingKey: Buffer.alloc(32, 7) });
    const start = broker.nativeStart(r.attempt.id, 'start');
    const identity = { ownerId: 'vscode', providerId: 'copilot' as const, sessionId: 'ahp-session:/owned', chatId: 'ahp-chat:/owned' };
    if (bind)
        f.store.bindLifecycleIdentity(r.attempt.id, identity);
    return { f, r, broker, start, identity };
}
test('real native client gate queues broker-owned child IDs and records explicit structured result without closing task', async () => {
    const { createFactoryToolGate } = await implementation();
    const x = await fixture();
    try {
        const gate = createFactoryToolGate({ broker: x.broker, store: x.f.store });
        gate.prepare(x.start, 'binding');
        const child = { ...x.r.task.spec, id: 'imagined', source: 'recipe', title: 'Actual child' };
        const output = await gate.invoke(x.identity, 'call1', 'sf_factory_operation', { operation: 'task.create', payload: child });
        assert.equal(output.ok, true);
        const id = (output.result as any).spec.id;
        assert.notEqual(id, 'imagined');
        assert.deepEqual(await gate.invoke(x.identity, 'call1', 'sf_factory_operation', { operation: 'task.create', payload: child }), output);
        await gate.invoke(x.identity, 'call2', 'sf_factory_operation', { operation: 'result.submit', payload: { attemptId: x.start.attemptId, summary: 'Finished', evidence: [], createdTaskIds: [id], outcome: 'result' } });
        assert.equal(x.broker.getResultProposal(x.start.attemptId)?.summary, 'Finished');
        assert.notEqual(x.f.store.getTask(x.r.task.spec.id)?.status, 'completed');
        await assert.rejects(gate.invoke(x.identity, 'call3', 'sf_factory_operation', { operation: 'native.start', payload: x.start }));
        await assert.rejects(gate.invoke({ ...x.identity, chatId: 'ahp-chat:/foreign' }, 'call4', 'sf_factory_operation', { operation: 'task.read', payload: { taskId: x.r.task.spec.id } }));
        x.f.store.revokeGrant('grant-1');
        await assert.rejects(gate.invoke(x.identity, 'call5', 'sf_factory_operation', { operation: 'task.read', payload: { taskId: id } }));
    }
    finally {
        x.f.close();
    }
});
test('binding refuses forged attempts and fixed canaries exercise the same closed tool entry point', async () => {
    const { createFactoryToolGate } = await implementation();
    const x = await fixture();
    try {
        const gate = createFactoryToolGate({ broker: x.broker, store: x.f.store });
        assert.throws(() => gate.prepare({ ...x.start, fence: x.start.fence + 1 }, 'bad'));
        gate.prepare(x.start, 'good');
        assert.deepEqual(gate.binding(), { attemptId: x.start.attemptId, fence: x.start.fence });
        for (const name of ['resourceRead', 'resourceWrite', 'shell', 'fetch', 'dns', 'metadata.write'])
            await assert.rejects(gate.invoke(x.identity, 'canary-' + name, name, { path: '/protected' }));
        assert.throws(() => gate.prepare({ ...x.start, workspacePath: '/other' } as NativeStart, 'good'));
    }
    finally {
        x.f.close();
    }
});
test('actual AHP client tool frames produce real broker task IDs and reverse host resource requests are closed', async () => {
    const { createFactoryToolGate } = await implementation();
    const x = await fixture(false);
    const { createVsCodeOwner } = await import('../../src/owners/vscode.ts');
    const { fakeHost } = await import('./ahp-fixture.ts');
    const host = fakeHost();
    const gate = createFactoryToolGate({ broker: x.broker, store: x.f.store });
    const owner = createVsCodeOwner({ journalPath: x.f.directory + '/owner.sqlite', connect: host.connect, timeoutMs: 300, tools: gate, requireVerifiedProfile: async (s) => ({ profileId: s.profileId, ownerId: s.task.ownerId, providerId: s.task.providerId, verifiedAt: new Date().toISOString(), required: s.task.required, probes: [] }) });
    try {
        const id = await owner.ensureSession(x.start);
        x.f.store.bindLifecycleIdentity(x.start.attemptId, id);
        gate.prepare(x.start, 'binding');
        await owner.send(id, { text: 'Tool integration' }, 'turn');
        await host.tool(id.chatId!, 'sf_factory_operation', { operation: 'task.create', payload: { ...x.r.task.spec, id: 'untrusted', source: 'recipe', title: 'Native child' } });
        const until = Date.now() + 1000;
        while (Date.now() < until && !host.actions.includes('chat/toolCallComplete'))
            await new Promise(r => setTimeout(r, 5));
        const part = (await owner.chat(id)).activeTurn!.responseParts.find(p => p.kind === 'toolCall');
        assert.ok(part?.kind === 'toolCall' && part.toolCall.status === 'completed');
        if (part?.kind === 'toolCall' && part.toolCall.status === 'completed') {
            assert.equal(part.toolCall.success, true);
            const result = part.toolCall.structuredContent as any;
            assert.equal(result.ok, true);
            assert.notEqual(result.result.spec.id, 'untrusted');
            assert.equal(x.f.store.getTask(result.result.spec.id)?.spec.title, 'Native child');
        }
        assert.equal(x.f.store.snapshot().tasks.length, 2);
        await host.reverse();
        while (Date.now() < until && !host.reverseResponses.length)
            await new Promise(r => setTimeout(r, 5));
        assert.equal(host.reverseResponses[0]?.error?.code, -32601);
    }
    finally {
        await owner.close();
        x.f.close();
    }
});
test('actual broker first start verifies root policy before allocating original native session and sends once', async () => {
    const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'sf-bootstrap-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const x = await fixture(false, workspace);
    const { createVsCodeOwner } = await import('../../src/owners/vscode.ts');
    const { fakeHost } = await import('./ahp-fixture.ts');
    const { createVsCodeNativeToolBoundary } = await import('../../src/owners/boundary.ts');
    const { nativeProcessIdentity } = await import('../../src/owners/managed.ts');
    const { createDockerNativeBoundary } = await import('../../src/isolation/docker.ts');
    const { createProfileVerifier } = await import('../../src/isolation/verify.ts');
    const { nativeStateFixture } = await import('../helpers/native-state.ts');
    const { fingerprint } = await import('../../src/storage/database.ts');
    const native = { pid: 12, startTime: 'start', netNamespace: 'net', mountNamespace: 'mnt', pidNamespace: 'pid', bootId: 'boot', entrypoint: '/opt/vscode/out/vs/platform/agentHost/node/agentHostServerMain.js' };
    const host = fakeHost({ canary: { native, defaultDnsDenied: true } });
    let verifier: ReturnType<typeof createProfileVerifier>;
    let owner: ReturnType<typeof createVsCodeOwner>;
    let verificationsBeforeCreate = 0;
    const profiles = { async requireVerifiedProfile(s: NativeStart) { if (host.creates === 0)
            verificationsBeforeCreate++; return verifier.requireVerifiedProfile(s); } };
    const broker = createAttemptBroker({ store: x.f.store, clock: x.f.clock, signingKey: Buffer.alloc(32, 8), profiles, native: { async start(s) { const id = await owner.ensureSession(s); x.f.store.bindLifecycleIdentity(s.attemptId, id); await owner.send(id, { text: 'Initial task' }, s.idempotencyKey); return id; }, async continue() { throw Error('unexpected'); }, async reconcile() { return { state: 'unknown' }; } } });
    const { createFactoryToolGate } = await implementation();
    const gate = createFactoryToolGate({ broker, store: x.f.store });
    owner = createVsCodeOwner({ journalPath: join(root, 'metadata', 'owner.sqlite'), connect: host.connect, tools: gate, timeoutMs: 300, requireVerifiedProfile: profiles.requireVerifiedProfile });
    try {
        const start = broker.nativeStart(x.start.attemptId, 'first-start');
        const state = await nativeStateFixture(root, start.task.id);
        const protectedPaths = [owner.metadataDirectory, state.markerPath, '/host-auth', '/var/run/docker.sock'];
        const launcher = { options: { entrypoint: native.entrypoint, nativeState: state, nativeStateOwnership: { installationId: 'installation', root } }, async inspect() { return { runtimeId: 'container', native, processIdentity: nativeProcessIdentity(native) }; } };
        const policy = { schemaVersion: 1 as const, kind: 'copilot-model-connect' as const, listenPort: 3128 as const, nativeRuntimeId: 'container', internalNetworkId: 'internal', allowedAuthorities: ['api.githubcopilot.com:443'] };
        const modelProxy = { policy, async inspect() { return { runtimeId: 'proxy', processIdentity: 'proxy', image: 'proxy@sha256:' + 'b'.repeat(64), policySha256: fingerprint(policy), nativeRuntimeId: 'container', internalNetworkId: 'internal', egressNetworkId: 'egress' }; } };
        const tools = createVsCodeNativeToolBoundary({ owner, gate, launcher: launcher as any, protectedPaths, modelProxy });
        const image = 'image@sha256:' + 'a'.repeat(64);
        const docker = { async command(args: string[], input?: {
                stdin?: string;
            }) { if (args[0] === 'image')
                return JSON.stringify([{ Id: 'image-id', RepoDigests: [image] }]); if (args[0] === 'network')
                return JSON.stringify([{ Id: 'internal', Internal: true, Driver: 'bridge' }]); if (args[0] === 'exec')
                return JSON.stringify({ nonce: JSON.parse(input!.stdin!).nonce, denied: true }); return JSON.stringify([{ Id: 'container', Image: 'image-id', State: { Running: true, Pid: 12, StartedAt: 'start' }, Config: { User: '1000', Labels: { 'sf.runtime-owner': 'owned' } }, HostConfig: { ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], NetworkMode: 'internal', IpcMode: 'private', PidsLimit: 64, Memory: 1000000, NanoCpus: 1000000 }, Mounts: [{ Source: workspace, Destination: workspace, RW: false, Type: 'bind' }, { Source: state.source, Destination: state.target, RW: true, Type: 'bind' }], NetworkSettings: { Networks: { internal: { NetworkID: 'internal' } } } }]); } };
        verifier = createProfileVerifier({ profiles: [{ id: start.profileId, ownerId: 'vscode', providerId: 'copilot', image, networks: ['internal'], protectedPaths, nativeState: state, nativeStateOwnership: launcher.options.nativeStateOwnership, boundary: createDockerNativeBoundary({ docker, containerId: 'container', runtimeOwnerId: 'owned', image, networks: ['internal'], protectedPaths, tools }) }] });
        await owner.ensureStarted();
        await tools.prepareModelTransport(start);
        await owner.authenticateProvider('copilot', { resource: 'https://api.github.com', token: 'fixture-native-auth', expiresIn: 300 });
        await tools.prepareBinding(start, 'bootstrap');
        assert.equal(host.creates, 0);
        assert.equal(broker.current(start.attemptId).attempt.native, undefined);
        assert.deepEqual(host.config.modelCapabilityOverrides, { '*': { availableTools: ['custom:sf_factory_operation'], excludedTools: ['mcp:*'] } });
        const token = broker.issueAttemptCapability(start.attemptId, broker.currentGrantIds(start.attemptId), ['native.start']);
        const request = { requestId: 'first', idempotencyKey: start.idempotencyKey, operation: 'native.start' as const, payload: start, scope: broker.authorizeAttempt(token, 'native.start', {}) };
        const result = await broker.execute(token, request);
        assert.equal(result.ok, true);
        assert.equal(host.creates, 1);
        assert.ok(verificationsBeforeCreate >= 2);
        assert.deepEqual(await broker.execute(token, request), result);
        assert.equal(host.actions.filter(a => a === 'chat/turnStarted').length, 1);
    }
    finally {
        await owner.close();
        x.f.close();
        await rm(root, { recursive: true, force: true });
    }
});
