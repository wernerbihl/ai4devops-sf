import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeStateFixture } from '../helpers/native-state.ts';
async function implementation() { const m = await import('../../src/owners/managed.ts').catch(() => undefined); assert.ok(m?.createManagedVsCodeLauncher, 'managed supported native launcher is required'); return m; }
test('managed launcher validates owned pinned container and launches only supported authenticated standalone entry', async () => {
    const { createManagedVsCodeLauncher } = await implementation();
    const calls: string[][] = [];
    let running = false;
    const root = await mkdtemp(join(tmpdir(), 'sf-managed-state-'));
    const nativeState = await nativeStateFixture(root);
    const options = { nativeState, nativeStateOwnership: { installationId: 'installation', root }, containerId: 'c'.repeat(64), runtimeOwnerId: 'owned', image: 'image@sha256:' + 'a'.repeat(64), entrypoint: '/opt/vscode/out/vs/platform/agentHost/node/agentHostServerMain.js', entrypointSha256: 'b'.repeat(64), userDataDir: nativeState.target + '/user-data', tokenFile: nativeState.target + '/connection-token', port: 8081 };
    const docker = { command: async (args: string[]) => {
            calls.push(args);
            if (args[0] === 'container')
                return JSON.stringify([{ Id: options.containerId, Config: { Labels: { 'sf.runtime-owner': 'owned' }, User: '1000' }, State: { Running: true }, Image: 'image-id', Mounts: [{ Source: nativeState.source, Destination: nativeState.target, RW: true, Type: 'bind' }] }]);
            if (args[0] === 'image')
                return JSON.stringify([{ Id: 'image-id', RepoDigests: [options.image] }]);
            if (args[1] === '-d') {
                running = true;
                return '';
            }
            return JSON.stringify({ entrypointHash: options.entrypointSha256, processes: running ? [{ pid: 12, startTime: '123', netNamespace: 'net:1', mountNamespace: 'mnt:1', pidNamespace: 'pid:1', bootId: 'boot', entrypoint: options.entrypoint }] : [] });
        } };
    const launcher = createManagedVsCodeLauncher({ ...options, docker });
    await launcher.ensureStarted();
    await launcher.ensureStarted();
    assert.equal(calls.filter(a => a[1] === '-d').length, 1);
    const args = calls.find(a => a[1] === '-d')!;
    assert.ok(args.includes('--connection-token-file'));
    assert.ok(args.includes('--user-data-dir'));
    assert.ok(!args.includes('--without-connection-token'));
    assert.equal((await launcher.inspect()).runtimeId, options.containerId);
    assert.throws(() => createManagedVsCodeLauncher({ ...options, runtimeOwnerId: 'foreign', docker }));
    await writeFile(nativeState.markerPath, '{}');
    await assert.rejects(launcher.inspect(), /state|marker/i);
    await rm(root, { recursive: true, force: true });
});
test('managed stop proves detached writers gone and restart requires a live reservation', async () => {
    const { createManagedVsCodeLauncher } = await implementation();
    const root = await mkdtemp(join(tmpdir(), 'sf-stop-state-'));
    const nativeState = await nativeStateFixture(root);
    let running = true, native = true, autoRestart = false;
    const calls: string[][] = [];
    const options = { nativeState, nativeStateOwnership: { installationId: 'installation', root }, containerId: 'd'.repeat(64), runtimeOwnerId: 'owned', image: 'image@sha256:' + 'a'.repeat(64), entrypoint: '/opt/vscode/out/vs/platform/agentHost/node/agentHostServerMain.js', entrypointSha256: 'b'.repeat(64), userDataDir: nativeState.target + '/user-data', tokenFile: nativeState.target + '/connection-token', port: 8081 };
    const docker = { async command(args: string[]) {
            calls.push(args);
            if (args[0] === 'container' && args[1] === 'stop') {
                running = false;
                native = false;
                return '';
            }
            if (args[0] === 'container' && args[1] === 'start') {
                running = true;
                return '';
            }
            if (args[0] === 'container')
                return JSON.stringify([{ Id: options.containerId, Config: { Labels: { 'sf.runtime-owner': 'owned' }, User: '1000' }, HostConfig: { RestartPolicy: { Name: autoRestart ? 'always' : 'no' }, AutoRemove: false }, State: { Running: running, Paused: false, Pid: running ? 12 : 0, Status: running ? 'running' : 'exited' }, Image: 'image-id', Mounts: [{ Source: nativeState.source, Destination: nativeState.target, RW: true, Type: 'bind' }] }]);
            if (args[0] === 'image')
                return JSON.stringify([{ Id: 'image-id', RepoDigests: [options.image] }]);
            if (args[1] === '-d') {
                native = true;
                return '';
            }
            return JSON.stringify({ entrypointHash: options.entrypointSha256, processes: native ? [{ pid: 12, startTime: 'new-start', netNamespace: 'net:1', mountNamespace: 'mnt:1', pidNamespace: 'pid:1', bootId: 'boot', entrypoint: options.entrypoint }] : [] });
        } };
    const launcher = createManagedVsCodeLauncher({ ...options, docker });
    try {
        autoRestart = true;
        await assert.rejects(launcher.stop!(), /restart/);
        assert.equal(running, true);
        autoRestart = false;
        await launcher.stop!();
        assert.equal(running, false);
        await assert.rejects(launcher.ensureStarted());
        assert.equal(running, false);
        const start = { task: { id: nativeState.taskId } } as any;
        await assert.rejects(launcher.resume(start, { nativeIdentity() { throw Error('expired lease'); } }));
        assert.equal(running, false);
        let checks = 0;
        await launcher.resume(start, { nativeIdentity() { checks++; return undefined; } });
        assert.ok(checks >= 3);
        assert.equal(running, true);
        assert.equal(calls.filter(a => a[1] === 'start').length, 1);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
