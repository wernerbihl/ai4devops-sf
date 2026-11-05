import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureKestra, PosixInstallationSecrets } from '../../src/kestra/deployment.ts';
import type { DockerPort } from '../../src/kestra/deployment.ts';

// Docker daemon is the external boundary; config files, protected secrets and reuse checks remain real.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sf e2,日本-')); const objects = new Map<string, any>(); const calls: string[][] = []; let dropCreate = false; let dropStart = false; const namespaceGeneration = new Map<string, number>(); const readinessNamespaces: boolean[] = [];
  const joinNamespace = (name: string) => { const object = objects.get(name); const mode = object.HostConfig.NetworkMode as string; if (mode.startsWith('container:')) namespaceGeneration.set(name, namespaceGeneration.get(mode.slice('container:'.length))!); else { namespaceGeneration.set(name, (namespaceGeneration.get(name) ?? 0) + 1); object.NetworkSettings.Networks[mode].NetworkID = objects.get(mode).Id; } };
  const docker: DockerPort = { async command(args) {
    calls.push(args);
    if (args[0] === 'image') return JSON.stringify([{ Id: args.at(-1), RepoDigests: [args.at(-1)], Os: 'linux', Architecture: 'amd64', Config: { Env: [], Entrypoint: ['docker-entrypoint.sh'], WorkingDir: '/app' } }]);
    if (args[1] === 'ls') return '';
    if (args[1] === 'inspect') { const v = objects.get(args[2]!); if (!v) throw Error('not found'); return JSON.stringify([v]); }
    if (args[0] === 'network' && args[1] === 'create') { const name = args.at(-1)!; const labels = args.flatMap((v, i) => v === '--label' ? [args[i + 1]!] : []); objects.set(name, { Id: name, Name: name, Internal: true, Driver: 'bridge', Labels: Object.fromEntries(labels.map(v => v.split('='))), Options: { "com.docker.network.enable_ipv4": "true", "com.docker.network.enable_ipv6": "false" } }); return name; }
    if (args[0] === 'create') {
      const get = (key: string) => args[args.indexOf(key) + 1]; const all = (key: string) => args.flatMap((v, i) => v === key ? [args[i + 1]!] : []);
      const name = get('--name')!; const index = args.findIndex(x => x.includes('@sha256:')); const image = args[index]!;
      objects.set(name, { Id: name, Name: '/' + name, Image: image, Config: { Image: image, Entrypoint: ['docker-entrypoint.sh'], WorkingDir: '/app', User: '1000:1000', Labels: Object.fromEntries(all('--label').map(v => v.split('='))), Env: all('--env'), Cmd: args.slice(index + 1), Hostname: get('--hostname') ?? name }, State: { Running: false }, NetworkSettings: { Networks: get('--network')!.startsWith('container:') ? {} : { [get('--network')!]: { NetworkID: '' } } }, HostConfig: { NetworkMode: get('--network'), ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: [], SecurityOpt: ['no-new-privileges'], PortBindings: {}, Binds: [], PidMode: '', IpcMode: 'private', Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,uid=1000,gid=1000,mode=1777' }, PidsLimit: 256, Memory: 2147483648, NanoCpus: 2000000000 }, Mounts: all('--mount').map(v => { const m = Object.fromEntries(v.match(/(?:"[^"]*(?:""[^"]*)*"|[^,])+/g)!.map(s => s.replace(/^"|"$/g, '').replaceAll('""', '"')).map(s => s.split('='))); return { Type: 'bind', Source: m.src, Destination: m.dst, RW: !('readonly' in m) }; }) }); if (dropCreate) throw Error('lost create reply'); return name;
    }
    if (args[0] === 'restart') { objects.get(args.at(-1)!).State.Running = true; joinNamespace(args.at(-1)!); return args.at(-1)!; }
    if (args[0] === 'start') { objects.get(args[1]!).State.Running = true; joinNamespace(args[1]!); if(dropStart)throw Error('lost start reply'); return args[1]!; }
    if (args[0] === 'exec') { const name = args[2]!; const mode = objects.get(name).HostConfig.NetworkMode as string; readinessNamespaces.push(namespaceGeneration.get(name) === namespaceGeneration.get(mode.slice('container:'.length))); return JSON.stringify({ status: 200, body: { total: 0, results: [] } }); }
    throw Error('Unexpected docker request');
  } };
  return { root, docker, objects, calls, namespaceGeneration, readinessNamespaces, restartEngineOutsideSetup(name: string) { joinNamespace(name); }, dropReplies() { dropCreate = true; dropStart = true; }, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}

test('persists_h2_and_correlates_pause_inputs', async () => {
  const f = fixture(); try {
    const installation = { id: 'test-install', root: f.root, docker: f.docker, secrets: new PosixInstallationSecrets() };
    const first = await ensureKestra(installation); const config = JSON.parse(readFileSync(join(f.root, 'kestra/config/application.yaml'), 'utf8'));
    assert.equal(config.kestra.repository.type, 'h2'); assert.equal(config.kestra.queue.type, 'h2'); assert.equal(config.kestra.variables['recursive-rendering'], false);
    assert.match(config.datasources.h2.url, /^jdbc:h2:file:\/app\/data\/database;/); assert.doesNotMatch(config.datasources.h2.url, /sqlite/);
    writeFileSync(join(f.root, 'kestra/data/database.mv.db'), 'H2 restart fixture');
    f.objects.get(first.containerId).State.Running = false;
    const restarted = await ensureKestra(installation); assert.equal(restarted.containerId, first.containerId); assert.ok(f.calls.some(x=>x[0]==='restart' && x.at(-1)===first.transportContainerId));
    assert.equal(readFileSync(join(f.root, 'kestra/data/database.mv.db'), 'utf8'), 'H2 restart fixture');
    assert.equal(f.calls.filter(x => x[0] === 'create').length, 2);
    assert.ok(f.calls.every(x => !x.includes('-p') && !x.includes('--publish')));
    assert.ok(f.calls.every(x => !x.join(' ').includes(config.kestra.encryption['secret-key'])));
    assert.equal(restarted.brokerNetwork.alias, 'sf-broker');
  } finally { f.cleanup(); }
});

test('rejects_tampered_configuration_and_foreign_owned_names', async () => {
  const f = fixture(); try {
    const installation = { id: 'test-install', root: f.root, docker: f.docker, secrets: new PosixInstallationSecrets() };
    const handle = await ensureKestra(installation);
    f.objects.get(handle.containerId).HostConfig.Privileged = true;
    await assert.rejects(ensureKestra(installation), /configuration|restriction/i);
    f.objects.get(handle.containerId).HostConfig.Privileged = false;
    const labels = f.objects.get(handle.containerId).Config.Labels; const owner = labels['sf.owner']; labels['sf.owner'] = 'foreign';
    await assert.rejects(ensureKestra(installation), /configuration/); labels['sf.owner'] = owner;
    writeFileSync(join(f.root, 'kestra/config/application.yaml'), '{}');
    await assert.rejects(ensureKestra(installation), /configuration/i);
  } finally { f.cleanup(); }
});

test('private_secret_store_rejects_symlinks_and_reuses_encryption_key', async () => {
  const f = fixture(); try {
    const secrets = new PosixInstallationSecrets(); const a = await secrets.loadOrCreate('test-install', f.root); const b = await secrets.loadOrCreate('test-install', f.root); assert.deepEqual(a, b); assert.equal(Buffer.from(a.encryptionKey, 'base64').byteLength, 32); assert.equal(Buffer.from(a.encryptionKey, 'base64').toString('base64'), a.encryptionKey);
    const other = join(f.root, 'linked'); symlinkSync(f.root, other); await assert.rejects(secrets.loadOrCreate('other', other), /canonical|symlink/);
  } finally { f.cleanup(); }
});


test('reconciles_unknown_create_start_replies_and_rejects_entrypoint_escape', async () => {
  const f = fixture(); try {
    f.dropReplies(); const installation = { id: 'test-install', root: f.root, docker: f.docker, secrets: new PosixInstallationSecrets() };
    const handle = await ensureKestra(installation); assert.equal(f.calls.filter(x=>x[0]==='create').length, 2);
    f.objects.get(handle.containerId).Config.Entrypoint = ['sh', '-c'];
    await assert.rejects(ensureKestra(installation), /configuration/);
  } finally { f.cleanup(); }
});

test('process_docker_uses_literal_argv_and_stdin_and_redacts_failures', async () => {
  const { ProcessDocker } = await import('../../src/kestra/deployment.ts'); const docker = new ProcessDocker(process.execPath);
  const literal = 'space 日本語 , " $(printf should-not-run)';
  const result = await docker.command(['-e', "let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({arg:process.argv[1],input:s})))", literal], { stdin: 'private-stdin' });
  assert.deepEqual(JSON.parse(result), { arg: literal, input: 'private-stdin' });
  await assert.rejects(docker.command(['-e', "process.stderr.write('private-stdin');process.exit(1)"], { stdin: 'private-stdin' }), error => error instanceof Error && !error.message.includes('private-stdin'));
});


test('rejects_extra_or_wrong_effective_engine_network_with_original_network_mode', async () => {
  const f = fixture(); try {
    const installation = { id: 'test-install', root: f.root, docker: f.docker, secrets: new PosixInstallationSecrets() };
    const handle = await ensureKestra(installation); const engine = f.objects.get(handle.containerId);
    const originalMode = engine.HostConfig.NetworkMode; const starts = f.calls.length;
    engine.NetworkSettings.Networks.external = { NetworkID: 'external-network' };
    await assert.rejects(ensureKestra(installation), /effective.*network/i);
    assert.equal(engine.HostConfig.NetworkMode, originalMode);
    assert.ok(f.calls.slice(starts).every(args => !['start', 'restart', 'exec'].includes(args[0]!)));
    delete engine.NetworkSettings.Networks.external;
    engine.NetworkSettings.Networks[handle.brokerNetwork.name].NetworkID = 'wrong-managed-network-id';
    await assert.rejects(ensureKestra(installation), /effective.*network/i);
  } finally { f.cleanup(); }
});

test('transport_container_namespace_rejects_independent_network_attachments', async () => {
  const f = fixture(); try {
    const installation = { id: 'test-install', root: f.root, docker: f.docker, secrets: new PosixInstallationSecrets() };
    const handle = await ensureKestra(installation); const transport = f.objects.get(handle.transportContainerId);
    assert.equal(transport.HostConfig.NetworkMode, 'container:' + handle.containerId);
    transport.NetworkSettings.Networks.external = { NetworkID: 'external-network' };
    const priorCalls = f.calls.length;
    await assert.rejects(ensureKestra(installation), /effective.*network/i);
    assert.ok(f.calls.slice(priorCalls).every(args => !['start', 'restart', 'exec'].includes(args[0]!)));
  } finally { f.cleanup(); }
});

test('adoption_rejoins_stale_transport_when_engine_and_transport_are_already_running', async () => {
  const f = fixture(); try {
    const installation = { id: 'test-install', root: f.root, docker: f.docker, secrets: new PosixInstallationSecrets() };
    const first = await ensureKestra(installation);
    // Models an engine restart or setup crash before transport reattachment in an earlier invocation.
    f.restartEngineOutsideSetup(first.containerId);
    assert.equal(f.objects.get(first.containerId).State.Running, true);
    assert.equal(f.objects.get(first.transportContainerId).State.Running, true);
    assert.notEqual(f.namespaceGeneration.get(first.containerId), f.namespaceGeneration.get(first.transportContainerId));
    const priorCalls = f.calls.length; const readyChecks = f.readinessNamespaces.length;
    const recovered = await ensureKestra(installation);
    assert.equal(recovered.containerId, first.containerId); assert.equal(recovered.transportContainerId, first.transportContainerId);
    assert.equal(f.namespaceGeneration.get(first.transportContainerId), f.namespaceGeneration.get(first.containerId));
    assert.deepEqual(f.readinessNamespaces.slice(readyChecks), [true]);
    const mutations = f.calls.slice(priorCalls).filter(args => ['start', 'restart', 'create'].includes(args[0]!));
    assert.deepEqual(mutations, [['restart', '--timeout', '1', first.transportContainerId]]);
  } finally { f.cleanup(); }
});
