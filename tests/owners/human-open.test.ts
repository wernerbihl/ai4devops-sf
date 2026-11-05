import assert from 'node:assert/strict';
import test from 'node:test';
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
import { fakeHost } from './ahp-fixture.ts';
for (const scenario of ['success', 'lost', 'changed', 'pending', 'unknown', 'focus-race', 'completed', 'failed', 'cycles'] as const)
    test(`actual C4 human takeover ${scenario} preserves admission and original native identity`, async () => {
        const f = createFixture();
        const summary = f.store.snapshot().recipes[0]!;
        f.store.setRecipeReadiness(summary.id, summary.currentRevision, { hash: f.recipe.hash, ready: true, reasons: [] }, summary.revision);
        const prepared = { ready: true as const, baseSha: 'base', workspacePath: f.directory, profileId: 'profile' };
        await createScheduler({ store: f.store, clock: f.clock, materialize: materializeFixture, readiness: async () => prepared, start: async (r) => ({ kind: 'started', identity: { workflow: { executionId: r.attempt.id, namespace: 'sf', flowId: 'quality', revision: '1' } } }) }).dispatch('manual');
        const attempt = f.store.getReservations()[0]!.attempt;
        const broker = createAttemptBroker({ store: f.store, clock: f.clock, signingKey: Buffer.alloc(32, 1) });
        const start = broker.nativeStart(attempt.id, 'start');
        const gate = createFactoryToolGate({ store: f.store, broker });
        const nativeState = await nativeStateFixture(f.directory, start.task.id);
        let running = true, native = true, paused = false;
        let restartChecks = 0;
        const nativeDescriptor = { pid: 12, startTime: '0', netNamespace: 'net', mountNamespace: 'mnt', pidNamespace: 'pid', bootId: 'boot', entrypoint: '/opt/vscode/out/vs/platform/agentHost/node/agentHostServerMain.js' };
        const host = fakeHost({ canary: { native: nativeDescriptor, defaultDnsDenied: true } });
        let signalStart!: () => void, releaseStart!: () => void;
        const startReached = new Promise<void>(r => signalStart = r);
        const startWait = new Promise<void>(r => releaseStart = r);
        const opens: string[] = [];
        let auths = 0;
        const options = { nativeState, nativeStateOwnership: { installationId: 'installation', root: f.directory }, containerId: 'd'.repeat(64), runtimeOwnerId: 'owned', image: 'image@sha256:' + 'a'.repeat(64), entrypoint: '/opt/vscode/out/vs/platform/agentHost/node/agentHostServerMain.js', entrypointSha256: 'b'.repeat(64), userDataDir: nativeState.target + '/user-data', tokenFile: nativeState.target + '/connection-token', port: 8081 };
        const docker = { async command(args: string[]) {
                if (args[0] === 'container' && args[1] === 'pause') {
                    paused = true;
                    return '';
                }
                if (args[0] === 'container' && args[1] === 'unpause') {
                    paused = false;
                    return '';
                }
                if (args[0] === 'container' && args[1] === 'stop') {
                    running = false;
                    native = false;
                    return '';
                }
                if (args[0] === 'container' && args[1] === 'start') {
                    const r = f.store.getLifecycle(attempt.id);
                    assert.equal(r.reservation.lease.active, false);
                    assert.equal(f.store.getRepository('repo-1')!.controlMode, 'human');
                    assert.equal(f.store.getAdmissionState().activeLeases.length, 0);
                    restartChecks++;
                    signalStart();
                    if (scenario === 'pending')
                        await startWait;
                    if (scenario === 'unknown')
                        throw Error('start acknowledgement lost');
                    if (scenario === 'changed') {
                        const repo = f.store.getRepository('repo-1')!;
                        f.store.setRepositoryControl(repo.id, 'factory', repo.revision);
                    }
                    if (scenario === 'success' || scenario === 'focus-race') {
                        delete host.config.modelCapabilityOverrides;
                        delete host.config['http.proxy'];
                        delete host.config['http.noProxy'];
                        delete host.config.systemProxyEnabled;
                    }
                    if (scenario === 'lost') {
                        host.sessions.clear();
                        host.chats.clear();
                    }
                    nativeDescriptor.startTime = String(restartChecks);
                    running = true;
                    return '';
                }
                if (args[0] === 'container')
                    return JSON.stringify([{ Id: options.containerId, Config: { Labels: { 'sf.runtime-owner': 'owned' }, User: '1000' }, HostConfig: { RestartPolicy: { Name: 'no' }, AutoRemove: false }, State: { Running: running, Paused: paused, Pid: running ? 12 : 0, StartedAt: 'container-original', Status: running ? 'running' : 'exited' }, Image: 'image-id', Mounts: [{ Source: nativeState.source, Destination: nativeState.target, RW: true, Type: 'bind' }] }]);
                if (args[0] === 'image')
                    return JSON.stringify([{ Id: 'image-id', RepoDigests: [options.image] }]);
                if (args[1] === '-d') {
                    native = true;
                    return '';
                }
                return JSON.stringify({ entrypointHash: options.entrypointSha256, processes: native ? [{ pid: 12, startTime: String(restartChecks), netNamespace: 'net', mountNamespace: 'mnt', pidNamespace: 'pid', bootId: 'boot', entrypoint: options.entrypoint }] : [] });
            } };
        const launcher = createManagedVsCodeLauncher({ ...options, docker });
        const create = () => createVsCodeOwner({ journalPath: join(f.directory, 'owner', 'journal.sqlite'), launcher, tools: gate, navigation: { connectionAuthority: 'managed-test', launch: async (uri) => { opens.push(uri); } }, connect: async () => { assert.equal(running, true); return host.connect(); }, timeoutMs: 100, requireVerifiedProfile: async (s) => ({ profileId: s.profileId, ownerId: s.task.ownerId, providerId: s.task.providerId, required: s.task.required, verifiedAt: new Date().toISOString(), probes: [] }) });
        let owner = create();
        try {
            const { createVsCodeNativeToolBoundary } = await import('../../src/owners/boundary.ts');
            const { createManagedHumanOpen } = await import('../../src/owners/human-open.ts');
            const { fingerprint } = await import('../../src/storage/database.ts');
            const policy = { schemaVersion: 1 as const, kind: 'copilot-model-connect' as const, listenPort: 3128 as const, nativeRuntimeId: options.containerId, internalNetworkId: 'internal', allowedAuthorities: ['api.githubcopilot.com:443'] };
            const modelProxy = { policy, async inspect() { return { runtimeId: 'proxy', processIdentity: 'proxy', image: 'proxy@sha256:' + 'b'.repeat(64), policySha256: fingerprint(policy), nativeRuntimeId: options.containerId, internalNetworkId: 'internal', egressNetworkId: 'egress' }; } };
            const boundary = createVsCodeNativeToolBoundary({ owner, gate, launcher, modelProxy, protectedPaths: [owner.metadataDirectory, nativeState.markerPath, launcher.controlIntentPath, launcher.pauseReceiptPath, '/host-auth', '/var/run/docker.sock'] });
            const authenticate = async () => { auths++; await owner.authenticateProvider('copilot', { resource: 'https://api.github.com', token: 'fixture-native-auth', expiresIn: 300 }); };
            await authenticate();
            await boundary.prepareBinding(start, 'initial');
            const identity = await owner.ensureSession(start);
            f.store.bindLifecycleIdentity(attempt.id, identity);
            const lifecycle = createLifecycle({ store: f.store, clock: f.clock, owner: () => owner, readiness: async () => { assert.ok(scenario !== 'completed' && scenario !== 'failed', 'Terminal history must not undergo continuation readiness'); return prepared; }, workspace: async () => true, workflow: { snapshot: async () => 'present', quiesce: async () => 'waiting', resume: async () => { } }, managedContinuation: { async preflight(a) { assert.ok(scenario !== 'completed' && scenario !== 'failed', 'Terminal history must not undergo continuation preflight'); return await owner.stoppedReceipt(a.native!) ? prepared : undefined; }, async prepare() { throw Error('unused'); } }, managedHumanOpen: createManagedHumanOpen({ owner, launcher, boundary, authenticate }) });
            await assert.rejects(owner.open(identity), /admitted/);
            assert.equal(restartChecks, 0);
            assert.equal(opens.length, 0);
            if (scenario === 'completed' || scenario === 'failed') {
                assert.equal(await owner.quiesce(identity), 'stopped');
                f.store.updateLifecycle(attempt.id, attempt.fence, { status: scenario, release: 'stopped' });
                const repo = f.store.getRepository('repo-1')!;
                f.store.setRepositoryControl(repo.id, 'human', repo.revision);
                await lifecycle.openNative(identity, 'terminal-history');
                assert.equal(running, true);
                assert.equal(opens.length, 1);
                await lifecycle.returnControl('repo-1');
                assert.equal(running, false, 'Returning terminal history to factory control must stop its human runtime');
                assert.equal(f.store.getRepository('repo-1')!.controlMode, 'factory');
                assert.equal(f.store.getTask(start.task.id)!.status, scenario);
                assert.equal(host.creates, 1);
                assert.equal(host.actions.filter(a => a === 'chat/turnStarted').length, 0);
                assert.equal(f.store.getAdmissionState().activeLeases.length, 0);
                return;
            }
            if (scenario === 'cycles') {
                await lifecycle.requestTakeover(start.task.id);
                assert.equal(opens.length, 1);
                await lifecycle.requestTakeover(start.task.id);
                assert.equal(running, true);
                assert.equal(opens.length, 1);
                assert.equal(restartChecks, 1);
                await lifecycle.returnControl('repo-1');
                assert.equal(running, false);
                await lifecycle.requestTakeover(start.task.id);
                await lifecycle.requestTakeover(start.task.id);
                assert.equal(running, true);
                assert.equal(opens.length, 2);
                assert.equal(restartChecks, 2);
                assert.equal(host.creates, 1);
                assert.equal(host.actions.filter(a => a === 'chat/turnStarted').length, 0);
                return;
            }
            const taking = lifecycle.requestTakeover(start.task.id);
            if (scenario === 'pending') {
                await startReached;
                assert.equal(running, false);
                assert.equal(await owner.quiesce(identity), 'unknown');
                await assert.rejects(lifecycle.returnControl('repo-1'), /pending|unknown/);
                const reconstructed = createManagedVsCodeLauncher({ ...options, docker });
                await assert.rejects(reconstructed.stop!(), /pending|unknown/);
                const repo = f.store.getRepository('repo-1')!;
                f.store.setRepositoryControl(repo.id, 'factory', repo.revision);
                releaseStart();
            }
            if (scenario === 'success' || scenario === 'focus-race') {
                await taking;
                assert.equal(opens.length, 1);
                assert.ok(opens[0]!.includes(encodeURIComponent(encodeURIComponent(identity.chatId!))));
                assert.ok(opens[0]!.includes('connectionAuthority=managed-test'));
                assert.equal(restartChecks, 1);
                assert.equal(auths, 2);
                assert.equal(gate.isSuspended(), true);
                if (scenario === 'success') {
                    await owner.send(identity, { text: 'Explicit interactive human input' }, 'human-only');
                    const snapshot = await owner.snapshot(identity);
                    assert.equal(snapshot.state, 'waiting');
                    const before = JSON.stringify(f.store.getLifecycle(attempt.id));
                    for (const event of [{ type: 'snapshot', snapshot }, { type: 'activity', active: true }, { type: 'connection_lost', reason: 'Human UI reconnect' }] as const)
                        await lifecycle.applyOwnerEvent(attempt.id, { ...event, identity, at: new Date().toISOString() });
                    await assert.rejects(lifecycle.applyOwnerEvent(attempt.id, { type: 'activity', active: true, identity: { ...identity, sessionId: 'ahp-session:/foreign' }, at: new Date().toISOString() }));
                    assert.equal(running, true, 'Human input/activity must not quiesce interactive work');
                    assert.equal(JSON.stringify(f.store.getLifecycle(attempt.id)), before, 'Human events must not charge factory budget or acquire/release a lease');
                }
                if (scenario === 'focus-race') {
                    const original = owner.nativeSession.bind(owner);
                    let reads = 0;
                    owner.nativeSession = async (id) => {
                        const value = await original(id);
                        if (++reads === 2) {
                            const repo = f.store.getRepository('repo-1')!;
                            f.store.setRepositoryControl(repo.id, 'factory', repo.revision);
                        }
                        return value;
                    };
                    await assert.rejects(lifecycle.openNative(identity, 'raced-focus'), /admission|unadmitted/);
                    assert.equal(opens.length, 1);
                    assert.equal(running, false);
                }
                else {
                    await lifecycle.openNative(identity, 'focus-again');
                    assert.equal(opens.length, 2);
                }
                assert.equal(restartChecks, 1);
                assert.equal(auths, 2);
                await assert.rejects(owner.open(identity), /admitted/);
            }
            else {
                await assert.rejects(taking);
                assert.equal(opens.length, 0);
                assert.equal(running, false);
                if (scenario === 'unknown') {
                    await assert.rejects(lifecycle.returnControl('repo-1'), /pending|unknown/);
                    await assert.rejects(createManagedVsCodeLauncher({ ...options, docker }).stop!(), /pending|unknown/);
                }
            }
            assert.equal(host.creates, 1);
            assert.equal(host.actions.filter(a => a === 'chat/turnStarted').length, scenario === 'success' ? 1 : 0);
            if (scenario === 'success') {
                await lifecycle.returnControl('repo-1');
                const before = JSON.stringify(f.store.getLifecycle(attempt.id));
                await lifecycle.applyOwnerEvent(attempt.id, { type: 'connection_lost', identity, reason: 'Late human generation', at: new Date().toISOString() });
                assert.equal(JSON.stringify(f.store.getLifecycle(attempt.id)), before);
                assert.equal(paused, true);
                const originalQuestion = host.chats.get(identity.chatId!)!.activeTurn!.id;
                await lifecycle.requestTakeover(start.task.id);
                assert.equal(paused, false);
                assert.equal(opens.length, 3);
                assert.equal(host.chats.get(identity.chatId!)!.activeTurn!.id, originalQuestion);
                assert.equal(host.actions.filter(a => a === 'chat/turnStarted').length, 1);
            }
            assert.equal(f.store.getAdmissionState().activeLeases.length, 0);
        }
        finally {
            await owner.close();
            f.close();
        }
    });
