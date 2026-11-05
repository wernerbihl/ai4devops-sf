import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../helpers/store.ts';
import { materializeFixture } from '../helpers/fixtures.ts';
import { nativeStateFixture } from '../helpers/native-state.ts';
import { createScheduler } from '../../src/scheduling/admission.ts';
import { createLifecycle } from '../../src/scheduling/lifecycle.ts';
import { createAttemptBroker } from '../../src/broker/operations.ts';
import { createFactoryToolGate } from '../../src/owners/tools.ts';
import { createManagedVsCodeLauncher } from '../../src/owners/managed.ts';
import { createVsCodeOwner } from '../../src/owners/vscode.ts';
import { createVsCodeNativeToolBoundary } from '../../src/owners/boundary.ts';
import { createDockerNativeBoundary } from '../../src/isolation/docker.ts';
import { createProfileVerifier } from '../../src/isolation/verify.ts';
import { fingerprint } from '../../src/storage/database.ts';
import { fakeHost } from './ahp-fixture.ts';
for (const scenario of ['answer', 'decline', 'cancel', 'pause-unknown', 'unpause-unknown'] as const)
    test(`I1 I2 actual owner C4 ${scenario} preserves official activeTurn and physical exclusion`, async () => {
        const f = createFixture();
        const summary = f.store.snapshot().recipes[0]!;
        f.store.setRecipeReadiness(summary.id, summary.currentRevision, { hash: f.recipe.hash, ready: true, reasons: [] }, summary.revision);
        const workspace = join(f.directory, 'workspace');
        await mkdir(workspace);
        const prepared = { ready: true as const, baseSha: 'base', workspacePath: workspace, profileId: 'profile' };
        await createScheduler({ store: f.store, clock: f.clock, materialize: materializeFixture, readiness: async () => prepared, start: async (r) => ({ kind: 'started', identity: { workflow: { executionId: r.attempt.id, namespace: 'sf', flowId: 'quality', revision: '1' } } }) }).dispatch('manual');
        const attempt = f.store.getReservations()[0]!.attempt;
        const broker = createAttemptBroker({ store: f.store, clock: f.clock, signingKey: Buffer.alloc(32, 1) });
        const start = broker.nativeStart(attempt.id, 'start');
        const gate = createFactoryToolGate({ store: f.store, broker });
        const nativeState = await nativeStateFixture(f.directory, start.task.id);
        let paused = false, running = true, pauses = 0, thaws = 0, starts = 0;
        const native = { pid: 12, startTime: 'native-original', netNamespace: 'net', mountNamespace: 'mnt', pidNamespace: 'pid', bootId: 'boot', entrypoint: '/opt/vscode/out/vs/platform/agentHost/node/agentHostServerMain.js' };
        const host = fakeHost({ canary: { native, defaultDnsDenied: true }, inputQuestions: [{ kind: 'text' as any, id: 'name', message: 'Name', required: true, min: 2 }, { kind: 'integer' as any, id: 'count', message: 'Count', required: true, min: 1, max: 4 }] });
        const options = { nativeState, nativeStateOwnership: { installationId: 'installation', root: f.directory }, containerId: 'e'.repeat(64), runtimeOwnerId: 'owned', image: 'image@sha256:' + 'a'.repeat(64), entrypoint: native.entrypoint, entrypointSha256: 'b'.repeat(64), userDataDir: nativeState.target + '/user-data', tokenFile: nativeState.target + '/connection-token', port: 8081 };
        const docker = { async command(args: string[], input?: {
                stdin?: string;
            }) {
                if (args[0] === 'container' && args[1] === 'pause') {
                    paused = true;
                    pauses++;
                    if (scenario === 'pause-unknown')
                        throw Error('Pause acknowledgement lost');
                    return '';
                }
                if (args[0] === 'container' && args[1] === 'unpause') {
                    const r = f.store.getLifecycle(attempt.id);
                    assert.equal(r.reservation.lease.active, true);
                    assert.ok(r.state.active && r.state.effect);
                    paused = false;
                    thaws++;
                    if (scenario === 'unpause-unknown')
                        throw Error('Unpause acknowledgement lost');
                    return '';
                }
                if (args[0] === 'container' && args[1] === 'stop') {
                    running = false;
                    paused = false;
                    return '';
                }
                if (args[0] === 'container' && args[1] === 'start') {
                    running = true;
                    starts++;
                    return '';
                }
                if (args[0] === 'container')
                    return JSON.stringify([{ Id: options.containerId, Image: 'image-id', Config: { User: '1000', Labels: { 'sf.runtime-owner': 'owned' } }, State: { Running: running, Paused: paused, Pid: running ? 10 : 0, StartedAt: 'container-original', Status: running ? 'running' : 'exited' }, HostConfig: { RestartPolicy: { Name: 'no' }, AutoRemove: false, ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], NetworkMode: 'internal', IpcMode: 'private', PidsLimit: 64, Memory: 1000000, NanoCpus: 1000000 }, Mounts: [{ Source: workspace, Destination: workspace, RW: false, Type: 'bind' }, { Source: nativeState.source, Destination: nativeState.target, RW: true, Type: 'bind' }], NetworkSettings: { Networks: { internal: { NetworkID: 'internal' } } } }]);
                if (args[0] === 'image')
                    return JSON.stringify([{ Id: 'image-id', RepoDigests: [options.image] }]);
                if (args[0] === 'network')
                    return JSON.stringify([{ Id: 'internal', Internal: true, Driver: 'bridge' }]);
                assert.equal(paused, false, 'No exec may run inside frozen runtime');
                if (args[1] === '-i')
                    return JSON.stringify({ nonce: JSON.parse(input!.stdin!).nonce, denied: true });
                return JSON.stringify({ entrypointHash: options.entrypointSha256, processes: [native] });
            } };
        let launcher = createManagedVsCodeLauncher({ ...options, docker });
        let verifier: ReturnType<typeof createProfileVerifier>;
        const createOwner = () => createVsCodeOwner({ journalPath: join(f.directory, 'metadata', 'owner.sqlite'), launcher, connect: async () => { assert.equal(paused, false); return host.connect(); }, tools: gate, timeoutMs: 100, requireVerifiedProfile: s => verifier.requireVerifiedProfile(s) });
        let owner = createOwner();
        const policy = { schemaVersion: 1 as const, kind: 'copilot-model-connect' as const, listenPort: 3128 as const, nativeRuntimeId: options.containerId, internalNetworkId: 'internal', allowedAuthorities: ['api.githubcopilot.com:443'] };
        const modelProxy = { policy, async inspect() { return { runtimeId: 'proxy', processIdentity: 'proxy', image: 'proxy@sha256:' + 'b'.repeat(64), policySha256: fingerprint(policy), nativeRuntimeId: options.containerId, internalNetworkId: 'internal', egressNetworkId: 'egress' }; } };
        function configure() { const protectedPaths = [owner.metadataDirectory, nativeState.markerPath, launcher.controlIntentPath, join(f.directory, 'owned', 'control-pause.json'), '/host-auth', '/var/run/docker.sock']; const boundary = createVsCodeNativeToolBoundary({ owner, gate, launcher, modelProxy, protectedPaths }); verifier = createProfileVerifier({ profiles: [{ id: 'profile', ownerId: 'vscode', providerId: 'copilot', image: options.image, networks: ['internal'], protectedPaths, nativeState, nativeStateOwnership: options.nativeStateOwnership, boundary: createDockerNativeBoundary({ docker, containerId: options.containerId, runtimeOwnerId: 'owned', image: options.image, networks: ['internal'], protectedPaths, tools: boundary }) }] }); return boundary; }
        let boundary = configure();
        const authenticate = () => owner.authenticateProvider('copilot', { resource: 'https://api.github.com', token: 'fixture-auth', expiresIn: 300 });
        try {
            await boundary.prepareModelTransport(start);
            await authenticate();
            await boundary.prepareBinding(start, 'initial');
            const identity = await owner.ensureSession(start);
            f.store.bindLifecycleIdentity(attempt.id, identity);
            await owner.send(identity, { text: 'Ask genuine native question' }, 'initial');
            const original = host.chats.get(identity.chatId!)!.activeTurn!;
            const lifecycle = createLifecycle({ store: f.store, clock: f.clock, owner: () => owner, workspace: async () => true, readiness: async (task, a) => { await verifier.requireVerifiedProfile(broker.nativeStart(a.id, 'readiness')); return prepared; }, workflow: { snapshot: async () => 'present', quiesce: async () => 'waiting', resume: async () => { } }, managedContinuation: { async preflight(a) { return await owner.stoppedReceipt(a.native!) ? prepared : undefined; }, async prepare(a, key) { const s = broker.nativeStart(a.id, key); await launcher.resume(s, gate); await boundary.prepareModelTransport(s); await authenticate(); await boundary.prepareBinding(s, key); await verifier.requireVerifiedProfile(s); assert.equal((await owner.reconcile(s)).state, 'done'); } } });
            const snapshot = await owner.snapshot(identity);
            if (scenario === 'pause-unknown') {
                await assert.rejects(lifecycle.applyOwnerEvent(attempt.id, { type: 'snapshot', identity, snapshot, at: new Date().toISOString() }), /Prove|quiescence/);
                assert.equal(f.store.getAdmissionState().activeLeases.length, 1);
                assert.equal(await owner.quiesce(identity), 'unknown');
                assert.equal(host.actions.includes('chat/turnCancelled'), false);
                assert.equal(host.chats.get(identity.chatId!)!.activeTurn!.id, original.id);
                await assert.rejects(createManagedVsCodeLauncher({ ...options, docker }).stop!(), /pending|unknown/);
                return;
            }
            const entering: Promise<void>[] = [];
            const detach = owner.subscribe(event => entering.push(lifecycle.applyOwnerEvent(attempt.id, event)));
            await owner.snapshot(identity);
            await Promise.all(entering);
            detach();
            assert.equal(paused, true);
            assert.equal(running, true);
            assert.equal(host.actions.includes('chat/turnCancelled'), false);
            assert.equal(host.chats.get(identity.chatId!)!.activeTurn!.id, original.id);
            assert.equal(f.store.getAdmissionState().activeLeases.length, 0);
            const attention = f.store.snapshot().attention.find(a => a.kind === 'input')!;
            for (const invalid of [{}, { response: 'accept', answers: {} }, { response: 'accept', answers: { name: 'A', count: 2 } }, { response: 'accept', answers: { name: 'Ada', count: '2' } }])
                await assert.rejects(lifecycle.resumeInput(attention.id, invalid, 'invalid'), /schema/);
            assert.equal(f.store.snapshot().attention.find(a => a.id === attention.id)!.status, 'open');
            await owner.close();
            launcher = createManagedVsCodeLauncher({ ...options, docker });
            owner = createOwner();
            boundary = configure();
            assert.ok(await owner.stoppedReceipt(identity));
            await assert.rejects(launcher.ensureStarted());
            assert.equal(paused, true);
            const events: Promise<void>[] = [];
            const unsubscribe = owner.subscribe(event => events.push(lifecycle.applyOwnerEvent(attempt.id, event)));
            const value = scenario === 'decline' || scenario === 'cancel' ? { response: scenario } : { response: 'accept', answers: { name: 'Ada', count: 2 } };
            if (scenario === 'unpause-unknown') {
                await assert.rejects(lifecycle.resumeInput(attention.id, value, 'answer-original'), /acknowledgement/);
                assert.equal(f.store.getAdmissionState().activeLeases.length, 1);
                assert.ok(f.store.getLifecycle(attempt.id).state.active);
                assert.equal(f.store.getLifecycle(attempt.id).state.effect?.phase, 'unknown');
                assert.equal(await owner.quiesce(identity), 'unknown');
                assert.equal(host.actions.includes('chat/turnCancelled'), false);
                assert.equal(host.actions.includes('chat/inputCompleted'), false);
                await assert.rejects(createManagedVsCodeLauncher({ ...options, docker }).ensureStarted(), /pending|unknown/);
                unsubscribe();
                return;
            }
            await lifecycle.resumeInput(attention.id, value, 'answer-original');
            await Promise.all(events);
            unsubscribe();
            assert.equal(paused, false);
            assert.equal(thaws, 1);
            assert.equal(pauses, 1);
            assert.equal(starts, 0);
            assert.equal(host.creates, 1);
            assert.equal(host.actions.filter(a => a === 'chat/inputCompleted').length, 1);
            assert.equal(host.actions.filter(a => a === 'chat/turnStarted').length, 1);
            const actual = host.chats.get(identity.chatId!)!.activeTurn!;
            assert.equal(actual.id, original.id);
            const answer = actual.responseParts.find(p => p.kind === 'inputRequest');
            assert.ok(answer?.kind === 'inputRequest');
            assert.equal(answer.response, value.response);
            if (value.response === 'accept') {
                assert.deepEqual(answer.request.answers?.name, { state: 'submitted', value: { kind: 'text', value: 'Ada' } });
                assert.deepEqual(answer.request.answers?.count, { state: 'submitted', value: { kind: 'number', value: 2 } });
            }
            else
                assert.equal(answer.request.answers, undefined);
            assert.equal(gate.binding().fence, f.store.getLifecycle(attempt.id).reservation.lease.fence);
            await lifecycle.resumeInput(attention.id, value, 'answer-original');
            assert.equal(host.actions.filter(a => a === 'chat/inputCompleted').length, 1);
        }
        finally {
            await owner.close();
            f.close();
        }
    });
