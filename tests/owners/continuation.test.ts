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
test('controlled stop admits C4 continuation from durable receipt, resumes only under lease/accounting and preserves original history', async () => {
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
    let running = true, native = true;
    let restartChecks = 0;
    const host = fakeHost();
    const options = { nativeState, nativeStateOwnership: { installationId: 'installation', root: f.directory }, containerId: 'd'.repeat(64), runtimeOwnerId: 'owned', image: 'image@sha256:' + 'a'.repeat(64), entrypoint: '/opt/vscode/out/vs/platform/agentHost/node/agentHostServerMain.js', entrypointSha256: 'b'.repeat(64), userDataDir: nativeState.target + '/user-data', tokenFile: nativeState.target + '/connection-token', port: 8081 };
    const docker = { async command(args: string[]) {
            if (args[0] === 'container' && args[1] === 'stop') {
                running = false;
                native = false;
                return '';
            }
            if (args[0] === 'container' && args[1] === 'start') {
                const r = f.store.getLifecycle(attempt.id);
                assert.equal(r.reservation.lease.active, true);
                assert.ok(r.state.active);
                assert.ok(r.state.effect);
                restartChecks++;
                running = true;
                return '';
            }
            if (args[0] === 'container')
                return JSON.stringify([{ Id: options.containerId, Config: { Labels: { 'sf.runtime-owner': 'owned' }, User: '1000' }, HostConfig: { RestartPolicy: { Name: 'no' }, AutoRemove: false }, State: { Running: running, Paused: false, Pid: running ? 12 : 0, Status: running ? 'running' : 'exited' }, Image: 'image-id', Mounts: [{ Source: nativeState.source, Destination: nativeState.target, RW: true, Type: 'bind' }] }]);
            if (args[0] === 'image')
                return JSON.stringify([{ Id: 'image-id', RepoDigests: [options.image] }]);
            if (args[1] === '-d') {
                native = true;
                return '';
            }
            return JSON.stringify({ entrypointHash: options.entrypointSha256, processes: native ? [{ pid: 12, startTime: String(restartChecks), netNamespace: 'net', mountNamespace: 'mnt', pidNamespace: 'pid', bootId: 'boot', entrypoint: options.entrypoint }] : [] });
        } };
    const launcher = createManagedVsCodeLauncher({ ...options, docker });
    const create = () => createVsCodeOwner({ journalPath: join(f.directory, 'owner', 'journal.sqlite'), launcher, connect: async () => { assert.equal(running, true); return host.connect(); }, timeoutMs: 100, requireVerifiedProfile: async (s) => ({ profileId: s.profileId, ownerId: s.task.ownerId, providerId: s.task.providerId, required: s.task.required, verifiedAt: new Date().toISOString(), probes: [] }) });
    let owner = create();
    try {
        const identity = await owner.ensureSession(start);
        f.store.bindLifecycleIdentity(attempt.id, identity);
        await owner.send(identity, { text: 'First' }, 'first');
        await owner.send(identity, { requestId: 'question-1', response: 'accept' }, 'answer-before-stop');
        const lifecycle = createLifecycle({ store: f.store, clock: f.clock, owner: () => owner, readiness: async () => running ? prepared : { ready: false, code: 'stopped', recovery: 'Acquire current lease before restart' }, workspace: async () => true, workflow: { snapshot: async () => 'present', quiesce: async () => 'waiting', resume: async () => { } }, managedContinuation: { async preflight(a) { return await owner.stoppedReceipt(a.native!) ? prepared : undefined; }, async prepare(a, key) { const s = broker.nativeStart(a.id, key); await launcher.resume(s, gate); assert.equal((await owner.reconcile(s)).state, 'done'); } } });
        await lifecycle.waitForCI(attempt.id);
        assert.equal(running, false);
        assert.equal(f.store.getAdmissionState().activeLeases.length, 0);
        await owner.close();
        owner = create();
        assert.deepEqual((await owner.stoppedReceipt(identity))?.identity, identity);
        assert.equal(running, false);
        f.store.enqueueAction({ key: 'managed-continue', kind: 'lifecycle.send', payload: { attemptId: attempt.id, input: { text: 'Continue original' } } });
        const result = await lifecycle.dispatchPending();
        assert.equal(result?.kind, 'started');
        assert.equal(restartChecks, 1);
        assert.equal(host.creates, 1);
        assert.deepEqual(f.store.getLifecycle(attempt.id).reservation.attempt.native, identity);
        assert.equal(host.actions.filter(a => a === 'chat/turnStarted').length, 2);
        // A subsequent controlled restart may discover lost history, but cannot allocate a replacement or send.
        await lifecycle.waitForCI(attempt.id);
        host.sessions.clear();
        host.chats.clear();
        f.store.enqueueAction({ key: 'lost-continue', kind: 'lifecycle.send', payload: { attemptId: attempt.id, input: { text: 'Never send' } } });
        await assert.rejects(lifecycle.dispatchPending());
        assert.equal(host.creates, 1);
        assert.equal(host.actions.filter(a => a === 'chat/turnStarted').length, 2);
    }
    finally {
        await owner.close();
        f.close();
    }
});
