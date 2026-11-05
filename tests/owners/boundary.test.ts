import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVsCodeOwner } from '../../src/owners/vscode.ts';
import { nativeProcessIdentity } from '../../src/owners/managed.ts';
import { fingerprint } from '../../src/storage/database.ts';
import { nativeStateFixture } from '../helpers/native-state.ts';
import { validTask } from '../fixtures/contracts.ts';
import { fakeHost } from './ahp-fixture.ts';
import type { NativeStart } from '../../src/contracts/domain.ts';
async function implementation() { const m = await import('../../src/owners/boundary.ts').catch(() => undefined); assert.ok(m?.createVsCodeNativeToolBoundary, 'concrete native terminal/client-tool boundary required'); return m; }
const native = { pid: 12, startTime: '123', netNamespace: 'net:1', mountNamespace: 'mnt:1', pidNamespace: 'pid:1', bootId: 'boot', entrypoint: '/opt/vscode/out/vs/platform/agentHost/node/agentHostServerMain.js' };
async function fixture(defaultDnsDenied = true) { const dir = await mkdtemp(join(tmpdir(), 'sf-native-boundary-')); const workspace = join(dir, 'workspace'); await mkdir(workspace); const state = await nativeStateFixture(dir, validTask().id); const host = fakeHost({ canary: { native, defaultDnsDenied } }); const owner = createVsCodeOwner({ journalPath: join(dir, 'metadata', 'owner.sqlite'), connect: host.connect, timeoutMs: 100 }); const start: NativeStart = { idempotencyKey: 'start', attemptId: 'a1', fence: 1, workspacePath: workspace, baseSha: 'sha', profileId: 'profile', task: { ...validTask(), ownerId: 'vscode', providerId: 'copilot', required: { paths: [], tools: [], credentialRefs: [], networkDestinations: [], allowedFinishPolicies: ['result'] } } }; let bound: NativeStart | undefined; const gate = { definitions: [], prepare(s: NativeStart) { bound = s; }, currentStart() { assert.ok(bound); return bound; }, binding() { assert.ok(bound); return { attemptId: bound.attemptId, fence: bound.fence }; }, async invoke() { throw new Error('denied'); } }; const launcher = { options: { entrypoint: native.entrypoint, nativeState: state, nativeStateOwnership: { installationId: 'installation', root: dir } }, async inspect() { return { runtimeId: 'container', native, processIdentity: nativeProcessIdentity(native) }; } }; await owner.authenticateProvider('copilot', { resource: 'https://api.github.com', token: 'fixture-native-only', expiresIn: 300 }); const policy = { schemaVersion: 2 as const, nativeAddress: '172.18.0.2', listenAddress: '172.18.0.3', kind: 'copilot-model-connect' as const, listenPort: 3128 as const, nativeRuntimeId: 'container', internalNetworkId: 'internal', allowedAuthorities: ['api.githubcopilot.com:443'] }; const proxy = { policy, async inspect() { return { runtimeId: 'proxy', processIdentity: 'proxy-process', image: 'proxy@sha256:' + 'b'.repeat(64), policySha256: fingerprint(policy), nativeRuntimeId: 'container', internalNetworkId: 'internal', egressNetworkId: 'egress' }; } }; return { owner, host, start, gate, launcher, proxy, protectedPaths: [owner.metadataDirectory, state.markerPath, '/host-auth', '/var/run/docker.sock'] }; }
test('native boundary uses actual AHP terminal with full protected target union and same native process', async () => {
    const { createVsCodeNativeToolBoundary } = await implementation();
    const f = await fixture();
    try {
        const protectedPaths = f.protectedPaths;
        const boundary = createVsCodeNativeToolBoundary({ owner: f.owner, gate: f.gate as any, launcher: f.launcher as any, modelProxy: f.proxy, protectedPaths });
        await assert.rejects(boundary.inspect(f.start));
        await boundary.prepareBinding(f.start, 'first');
        const settings = await boundary.inspect(f.start);
        assert.equal(settings.processIdentity, nativeProcessIdentity(native));
        assert.equal(settings.alternateEgressDenied, true);
        const union = [...protectedPaths, '/canonical/credentials'];
        const proof = await boundary.challenge(f.start, 'a'.repeat(32), union);
        assert.equal(proof.denied, true);
        assert.deepEqual(f.host.canaryInputs.at(-1)?.protectedPaths, union);
        assert.equal(f.host.terminals.size, 0);
        assert.ok(f.host.methods.includes('createTerminal'));
        assert.ok(f.host.actions.includes('terminal/input'));
        assert.equal(f.host.creates, 0);
        await assert.rejects(boundary.inspect({ ...f.start, fence: 2 }));
    }
    finally {
        await f.owner.close();
    }
});
test('default resolver escape never earns native profile evidence', async () => {
    const { createVsCodeNativeToolBoundary } = await implementation();
    const f = await fixture(false);
    try {
        const boundary = createVsCodeNativeToolBoundary({ owner: f.owner, gate: f.gate as any, launcher: f.launcher as any, modelProxy: f.proxy, protectedPaths: f.protectedPaths });
        await assert.rejects(boundary.prepareBinding(f.start, 'first'), /canary|denial/i);
        assert.equal(f.host.terminals.size, 0);
    }
    finally {
        await f.owner.close();
    }
});
test('readonly workspace positive canary writes only owned persistent state', async () => {
    const { createVsCodeNativeToolBoundary } = await implementation();
    const f = await fixture();
    try {
        const boundary = createVsCodeNativeToolBoundary({ owner: f.owner, gate: f.gate as any, launcher: f.launcher as any, modelProxy: f.proxy, protectedPaths: f.protectedPaths });
        await boundary.prepareBinding(f.start, 'readonly');
        assert.equal(f.host.canaryInputs[0]?.controlPath, f.launcher.options.nativeState.target);
        assert.equal(f.host.canaryInputs[0]?.workspaceWritable, false);
    }
    finally {
        await f.owner.close();
    }
});
test('real E1 starter materialization verifies through E3 Docker boundary and concrete AHP native tool producer with persistent state', async () => {
    const { readFile } = await import('node:fs/promises');
    const { validateRecipe } = await import('../../src/recipes/validate.ts');
    const { materializeTask } = await import('../../src/recipes/materialize.ts');
    const { recipeFixture } = await import('../helpers/fixtures.ts');
    const { createDockerNativeBoundary } = await import('../../src/isolation/docker.ts');
    const { createProfileVerifier } = await import('../../src/isolation/verify.ts');
    const { createVsCodeNativeToolBoundary } = await implementation();
    const f = await fixture();
    try {
        const v = validateRecipe(await readFile(new URL('../../recipes/starter/focused-feature.yaml', import.meta.url), 'utf8'), []);
        const recipe = { ...recipeFixture('Features'), yaml: v.yaml, contract: v.contract, hash: v.hash, recipeId: v.contract.variables.sf.recipeId, repositoryIds: ['repo-1'] };
        const task = materializeTask({ recipeId: recipe.recipeId, repositoryIds: ['repo-1'], title: 'Real feature', description: 'Real feature' }, recipe, 'repo-1', { ownerId: 'vscode', providerId: 'copilot', finishPolicy: 'pr' });
        const start = { ...f.start, task };
        const state = await nativeStateFixture(f.launcher.options.nativeStateOwnership.root, task.id);
        f.launcher.options.nativeState = state;
        const tools = createVsCodeNativeToolBoundary({ owner: f.owner, gate: f.gate as any, launcher: f.launcher as any, modelProxy: f.proxy, protectedPaths: f.protectedPaths });
        await tools.prepareBinding(start, 'actual-starter');
        const image = 'image@sha256:' + 'a'.repeat(64);
        const docker = { async command(args: string[], input?: {
                stdin?: string;
            }) {
                if (args[0] === 'image')
                    return JSON.stringify([{ Id: 'image-id', RepoDigests: [image] }]);
                if (args[0] === 'network')
                    return JSON.stringify([{ Id: 'internal', Internal: true, Driver: 'bridge' }]);
                if (args[0] === 'exec')
                    return JSON.stringify({ nonce: JSON.parse(input!.stdin!).nonce, denied: true });
                return JSON.stringify([{ Id: 'container', Image: 'image-id', State: { Running: true, Pid: 12, StartedAt: 'start' }, Config: { User: '1000', Labels: { 'sf.runtime-owner': 'owned' } }, HostConfig: { ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], NetworkMode: 'internal', IpcMode: 'private', PidsLimit: 64, Memory: 1000000, NanoCpus: 1000000 }, Mounts: [{ Source: start.workspacePath, Destination: start.workspacePath, RW: true, Type: 'bind' }, { Source: state.source, Destination: state.target, RW: true, Type: 'bind' }], NetworkSettings: { Networks: { internal: { NetworkID: 'internal' } } } }]);
            } };
        const boundary = createDockerNativeBoundary({ docker, containerId: 'container', runtimeOwnerId: 'owned', image, networks: ['internal'], protectedPaths: f.protectedPaths, tools });
        const verifier = createProfileVerifier({ profiles: [{ id: start.profileId, ownerId: 'vscode', providerId: 'copilot', image, networks: ['internal'], protectedPaths: f.protectedPaths, boundary, nativeState: state, nativeStateOwnership: f.launcher.options.nativeStateOwnership }] });
        const before = JSON.stringify(task);
        const proof = await verifier.requireVerifiedProfile(start);
        assert.equal(proof.profileId, start.profileId);
        assert.equal(JSON.stringify(task), before);
        assert.ok(f.host.canaryInputs.every(v => v.controlPath === state.target));
        assert.ok(f.host.canaryInputs.every(v => v.workspaceWritable === true));
    }
    finally {
        await f.owner.close();
    }
});
test('same current reservation binding survives a distinct native wire idempotency key', async () => {
    const { createVsCodeNativeToolBoundary } = await implementation();
    const f = await fixture();
    try {
        const boundary = createVsCodeNativeToolBoundary({ owner: f.owner, gate: f.gate as any, launcher: f.launcher as any, modelProxy: f.proxy, protectedPaths: f.protectedPaths });
        await boundary.prepareBinding(f.start, 'prepare');
        assert.equal((await boundary.inspect({ ...f.start, idempotencyKey: 'wire-key' })).fence, f.start.fence);
    }
    finally {
        await f.owner.close();
    }
});
test('managed native readiness requires actual model proxy inspection instead of an undefined model egress prerequisite', async () => {
    const { createVsCodeNativeToolBoundary } = await implementation();
    const f = await fixture();
    try {
        const boundary = createVsCodeNativeToolBoundary({ owner: f.owner, gate: f.gate as any, launcher: f.launcher as any, protectedPaths: f.protectedPaths });
        await assert.rejects(boundary.prepareBinding(f.start, 'missing-proxy'), /proxy/i);
    }
    finally {
        await f.owner.close();
    }
});
test('private model transport setup precedes OAuth without granting native readiness', async () => { const { createVsCodeNativeToolBoundary } = await implementation(); const f = await fixture(); try {
    const boundary = createVsCodeNativeToolBoundary({ owner: f.owner, gate: f.gate as any, launcher: f.launcher as any, modelProxy: f.proxy, protectedPaths: f.protectedPaths });
    assert.equal(typeof boundary.prepareModelTransport, 'function', 'model proxy must be configurable before provider auth validation');
    await boundary.prepareModelTransport(f.start);
    assert.equal(f.host.config['http.proxy'], 'http://sf-model-proxy:3128');
    await assert.rejects(boundary.inspect(f.start));
    assert.equal(f.host.creates, 0);
}
finally {
    await f.owner.close();
} });
