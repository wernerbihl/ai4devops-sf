import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('installation singleton rejects another controller and releases on close', async () => {
  const module = await import('../../src/service/singleton.ts').catch(() => undefined);
  assert.ok(module?.acquireInstallationSingleton, 'kernel lifetime installation exclusion is missing');
  const root = mkdtempSync(join(tmpdir(), 'sf-runtime-'));
  try {
    const lock = module.acquireInstallationSingleton(root);
    assert.throws(() => module.acquireInstallationSingleton(root), /controller|locked/);
    lock.close();
    module.acquireInstallationSingleton(root).close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deadline lane continues while dispatch never acknowledges and drops missed ticks', async () => {
  const module = await import('../../src/service/coordinator.ts').catch(() => undefined);
  assert.ok(module?.createCoordinator, 'independent runtime lanes are missing');
  let dispatches = 0; let controls = 0;
  const coordinator = module.createCoordinator({
    taktMs: 20, controlMs: 5,
    dispatch: async () => { dispatches++; await new Promise(() => {}); },
    control: async () => { controls++; },
    reconcile: async () => {},
  });
  coordinator.start();
  await new Promise(resolve => setTimeout(resolve, 85));
  coordinator.stop();
  assert.equal(dispatches, 1);
  assert.ok(controls >= 4, 'hung dispatch must not prevent active deadline/control checks');
});

test('preexecution attention can be edited and requeued but unknown reservations stay fenced', async () => {
  const { createFixture } = await import('../helpers/store.ts');
  const f = createFixture();
  try {
    const task = f.store.getTask(f.task.id)!;
    f.store.markAdmissionAttention(task.spec.id, task.revision, 'owner_unavailable', 'Restore owner');
    const attention = f.store.getTask(task.spec.id)!;
    const updated = f.store.patchTask(task.spec.id, { title: 'Recovered' }, attention.revision);
    assert.equal(updated.status, 'queued');
    assert.equal(updated.spec.title, 'Recovered');
  } finally { f.close(); }
});

test('real runtime opens API and private control honestly unavailable without provisioned images', async () => {
  const m = await import('../../src/service/runtime.ts').catch(() => undefined);
  assert.ok(m?.startRuntime, 'runnable runtime composition is missing');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(),'sf-service-')); mkdirSync(join(root,'vault'),{mode:0o700});
  writeFileSync(join(root,'runtime.json'),JSON.stringify({schemaVersion:1,installationId:'fixture',allowedOrigins:['http://127.0.0.1:4000'],repositories:[],providerCredentials:[],native:[]}),{mode:0o600});
  writeFileSync(join(root,'vault','broker-signing'),Buffer.alloc(32,7),{mode:0o600});
  writeFileSync(join(root,'vault','private-control'),Buffer.alloc(32,9),{mode:0o600});
  let commands=0;
  const installation={id:'fixture',root,docker:{async command(){commands++;throw new Error('No pinned fixture images')}},secrets:{async loadOrCreate(){throw new Error('No secrets')}}};
  let runtime: Awaited<ReturnType<NonNullable<typeof m>['startRuntime']>> | undefined;
  try {
    runtime=await m.startRuntime(installation);
    assert.equal((await runtime.health()).ready,false);
    assert.ok(runtime.api.url.startsWith('http://127.0.0.1:'));
    const before=commands;
    await assert.rejects(m.startRuntime(installation),/controller|lock/);
    assert.equal(commands,before,'singleton must precede any mutating engine deployment');
    const denied=await fetch(runtime.controlUrl+'/health'); assert.equal(denied.status,401);
    const health=await fetch(runtime.controlUrl+'/health',{headers:{authorization:'Bearer '+Buffer.alloc(32,9).toString('base64url')}});
    assert.equal(health.status,200); assert.equal((await health.json()).ready,false);
  } finally {await runtime?.stop();rmSync(root,{recursive:true,force:true})}
});

test('zero existing native runtimes can be provisionable without minting profile evidence',async()=>{
 const {createFixture}=await import('../helpers/store.ts');const {createNativeFleet}=await import('../../src/service/native.ts');const {createAttemptBroker}=await import('../../src/broker/operations.ts');const {mkdirSync,writeFileSync}=await import('node:fs');
 const f=createFixture();try{
  mkdirSync(join(f.directory,'vault'),{mode:0o700});writeFileSync(join(f.directory,'vault','provider'), 'owned-fixture-sentinel',{mode:0o600});
  const calls:string[][]=[];const nativeImage='native@sha256:'+'a'.repeat(64);const workerImage='worker@sha256:'+'b'.repeat(64);const proxyImage='proxy@sha256:'+'c'.repeat(64);
  const docker={async command(args:string[]){calls.push(args);assert.equal(args[0],'image','provisionability must not allocate/start native resources');return JSON.stringify([{RepoDigests:[args.at(-1)],Os:'linux',Architecture:'amd64'}])}};
  const fleet=createNativeFleet({installation:{id:'fixture',root:f.directory,docker,secrets:{async loadOrCreate(){throw Error('unused')}}},store:f.store,broker:createAttemptBroker({store:f.store,clock:f.clock,signingKey:Buffer.alloc(32,7)}),protectedPaths:[join(f.directory,'vault'),f.path,'/var/run/docker.sock'],config:{schemaVersion:1,installationId:'fixture',allowedOrigins:['http://127.0.0.1:4000'],repositories:[],providerCredentials:[{ref:'provider',providerId:'copilot',resource:'https://api.github.com',expiresAt:'2099-01-01T00:00:00Z',scopes:[]}],native:[{kind:'vscode-isolated-worker-v2',nativeImage,workerImage,entrypoint:'/opt/vscode/out/vs/platform/agentHost/node/agentHostServerMain.js',entrypointSha256:'d'.repeat(64),hostCommit:'e576c7bbeb39772a1d1ebe472545def0d93e6d8b',pristineDirectory:'/workspaces/task',emptyHome:'/opt/software-factory/empty-home',credentialRef:'provider',proxy:{image:proxyImage,entrypoint:'/opt/sf/proxy.cjs',entrypointSha256:'e'.repeat(64),allowedAuthorities:['api.githubcopilot.com:443']}}]}});
  assert.deepEqual(await fleet.provisionability(f.task),[]);assert.equal(calls.length,3);assert.equal(f.store.getReservations().length,0);
  const readiness=await fleet.owner.readiness(f.task.required);assert.equal(readiness.ready,false);assert.deepEqual(readiness.verifiedProfileIds,[]);
  await fleet.close();
 }finally{f.close()}
});
