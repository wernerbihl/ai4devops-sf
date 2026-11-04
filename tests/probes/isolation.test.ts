import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRecipePolicy, makeProbeFlow } from '../../probes/kestra.ts';
import { verifyProfile, probeIsolation, inspectRestrictions, requireWorkerAssertions } from '../../probes/isolation.ts';
import workerReceipt from '../../release/evidence/p4/isolation/isolation.json' with { type: 'json' };
import { OwnedDocker } from '../../probes/docker.ts';

const negatives = [
  { type: 'io.kestra.plugin.scripts.shell.Commands', taskRunner: { type: 'io.kestra.plugin.core.runner.Process' }, commands: ['id'] },
  { type: 'io.kestra.plugin.core.debug.Return', format: 'safe', privileged: true },
  { type: 'io.kestra.plugin.core.debug.Return', format: 'safe', volumes: ['/var/run/docker.sock:/var/run/docker.sock'] },
  { type: 'io.kestra.plugin.core.debug.Return', format: 'safe', mounts: ['/home:/host'] },
  { type: 'arbitrary.JvmPlugin' },
  { type: 'io.kestra.plugin.core.flow.Subflow', namespace: 'unsafe', flowId: 'escape' },
  { type: 'io.kestra.plugin.core.debug.Return', format: '{{ readFile("/host/.git-credentials") }}' },
  { type: 'io.kestra.plugin.core.debug.Return', format: 'safe', containerImage: 'alpine:latest' },
  { type: 'io.kestra.plugin.core.debug.Return', format: 'safe', networkMode: 'host' },
];
test('RF4 rejects Process, arbitrary plugins/subflows, privileges, socket/host mounts, unsafe interpolation and runtime overrides', () => {
  const escapeResults = negatives.map(task => {
    const flow = makeProbeFlow(); flow.tasks = [{ id: 'escape', ...task }];
    assert.throws(() => validateRecipePolicy(flow)); return { blocked: true };
  });
  assert.equal(escapeResults.every(result => result.blocked), true);
  for (const extra of [{ triggers: [] }, { pluginDefaults: [] }, { errors: [] }, { variables: { sf: makeProbeFlow().variables.sf, unsafe: '{{ secret("TOKEN") }}' } }]) {
    assert.throws(() => validateRecipePolicy({ ...makeProbeFlow(), ...extra }));
  }
});
const safeInspect = () => ({ Config: { User: '1000:1000', Image: `node@sha256:${'a'.repeat(64)}` }, HostConfig: { ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: [], SecurityOpt: ['no-new-privileges'], NetworkMode: 'none', PidMode: '', IpcMode: 'private', Binds: null, Devices: [], PortBindings: {}, Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec', '/workspace': 'rw,nosuid,nodev,noexec' } }, Mounts: [] });
test('effective inspection rejects symlink-capable host mounts, alternate network/IPv6/DNS paths and host namespaces', () => {
  inspectRestrictions(safeInspect(), []);
  for (const patch of [{ Privileged: true }, { ReadonlyRootfs: false }, { NetworkMode: 'host' }, { NetworkMode: 'bridge' }, { PidMode: 'host' }, { CapAdd: ['NET_ADMIN'] }, { SecurityOpt: [] }]) {
    const inspect = safeInspect(); Object.assign(inspect.HostConfig, patch);
    assert.throws(() => inspectRestrictions(inspect, []));
  }
  const inspect = safeInspect(); (inspect.Mounts as any[]).push({ Type: 'bind', Source: '/home', Destination: '/host' });
  assert.throws(() => inspectRestrictions(inspect, []));
});
test('client-contributed tools outside the native boundary cannot become a verified profile', async () => {
  for (const ownerId of ['vscode', 'bb']) await assert.rejects(verifyProfile({ id: `${ownerId}-codex`, ownerId, providerId: 'codex', image: `node@sha256:${'a'.repeat(64)}`, version: 'test', workspaceRoot: '/workspace', required: { paths: [{ root: '/workspace', mode: 'write' }], tools: ['client-tool'], networkDestinations: [], credentialRefs: [], allowedFinishPolicies: ['result'] } }), /native|boundary|credential/i);
});
test('fixture and denied-live probes do not touch Docker', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'sf-p4-test-'));
  const report = await probeIsolation({ mode: 'fixture', allowLive: true, scratchRepo: '/unused', outputDir });
  assert.equal(report.mode, 'fixture'); assert.equal(report.status, 'blocked');
  await assert.rejects(probeIsolation({ mode: 'live', allowLive: false, scratchRepo: '/unused', outputDir } as any));
});
test('cleanup never deletes a same-name resource with a different ownership label', async () => {
  const calls: string[][] = [];
  const dir = await mkdtemp(join(tmpdir(), 'sf-p4-test-'));
  const docker = new OwnedDocker(dir, async args => { calls.push(args); return JSON.stringify([{ Config: { Labels: { 'sf.p4.owner': 'someone-else' } } }]); });
  await docker.checkpoint('container', 'sf-p4-not-ours');
  await assert.rejects(docker.cleanup(), /ownership/);
  assert.equal(calls.some(args => args.includes('rm')), false);
});
test('exec-local API client must share exactly the inspected server container network namespace', () => {
  const inspect = safeInspect(); inspect.HostConfig.NetworkMode = 'container:actual-server-id';
  inspectRestrictions(inspect, [], 'container:actual-server-id');
  assert.throws(() => inspectRestrictions(inspect, [], 'container:another-server-id'));
});
test('setup-generated server configuration must be mounted read-only at runtime', () => {
  const inspect = safeInspect();
  (inspect.Mounts as any[]).push({ Type: 'volume', Name: 'owned-config', Destination: '/app/confs', RW: true });
  assert.throws(() => inspectRestrictions(inspect, [{ name: 'owned-config', destination: '/app/confs', readOnly: true }]));
  (inspect.Mounts as any[])[0].RW = false;
  inspectRestrictions(inspect, [{ name: 'owned-config', destination: '/app/confs', readOnly: true }]);
});

test('worker evidence cannot pass with missing, duplicate or failed restriction results', () => {
  const complete = workerReceipt.assertions.slice(2);
  requireWorkerAssertions(complete);
  assert.throws(() => requireWorkerAssertions(complete.map((r, i) => i === 0 ? { ...r, passed: false } : r)));
  assert.throws(() => requireWorkerAssertions(complete.slice(1)));
  assert.throws(() => requireWorkerAssertions([]));
  assert.throws(() => requireWorkerAssertions([{ name: 'rootfs-write-denied', passed: true }]));
  assert.throws(() => requireWorkerAssertions(Array.from({ length: 13 }, () => ({ name: 'rootfs-write-denied', passed: true }))));
  assert.throws(() => requireWorkerAssertions([{ name: 'rootfs-write-denied', passed: false }]));
});
