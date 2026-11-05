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
    const session=runtime.api.sessions.provision('http://127.0.0.1:4000');
    const readiness=await fetch(runtime.api.url+'/v1/readiness',{headers:{origin:'http://127.0.0.1:4000',cookie:session.cookie}});
    assert.equal(readiness.status,200,'real registry baseline must satisfy canonical capabilities');
    const facts=await readiness.json();assert.deepEqual(facts.map((owner:{ownerId:string})=>owner.ownerId),['vscode','bb']);
    assert.ok(facts.every((owner:{ready:boolean;verifiedProfileIds:string[]})=>!owner.ready&&owner.verifiedProfileIds.length===0));
    assert.equal(commands,before,'reading global readiness must not provision or start native/worker resources');
    assert.equal(runtime.store.getReservations().length,0);
    await assert.rejects(m.startRuntime(installation),/controller|lock/);
    assert.equal(commands,before,'singleton must precede any mutating engine deployment');
    const denied=await fetch(runtime.controlUrl+'/health'); assert.equal(denied.status,401);
    const health=await fetch(runtime.controlUrl+'/health',{headers:{authorization:'Bearer '+Buffer.alloc(32,9).toString('base64url')}});
    assert.equal(health.status,200); assert.equal((await health.json()).ready,false);
    const headers={authorization:'Bearer '+Buffer.alloc(32,9).toString('base64url'),'content-type':'application/json'};
    const missing=await fetch(runtime.controlUrl+'/next',{method:'POST',headers,body:'{}'}); assert.equal(missing.status,409);
    const send=()=>fetch(runtime!.controlUrl+'/next',{method:'POST',headers,body:JSON.stringify({key:'cli-fixture-key'})});
    const first=await send(); assert.equal(first.status,200); const firstBody=await first.json();
    const second=await send(); assert.equal(second.status,200); assert.deepEqual(await second.json(),firstBody);
    assert.ok(runtime.store.getActionByKey('dispatch:request:cli-fixture-key'));
    const status=await fetch(runtime.controlUrl+'/dispatch-status',{method:'POST',headers,body:JSON.stringify({key:'cli-fixture-key'})});
    assert.equal(status.status,200);assert.deepEqual(await status.json(),firstBody);
    const unknown=await fetch(runtime.controlUrl+'/dispatch-status',{method:'POST',headers,body:JSON.stringify({key:'unknown-key'})});
    assert.deepEqual(await unknown.json(),{state:'pending'});assert.equal(runtime.store.getActionByKey('dispatch:request:unknown-key'),undefined);

  } finally {await runtime?.stop();rmSync(root,{recursive:true,force:true})}
});

test('arbitrary proxy digest cannot make an unprovisioned runtime ready',async()=>{
 const {createFixture}=await import('../helpers/store.ts');const {createNativeFleet}=await import('../../src/service/native.ts');const {createAttemptBroker}=await import('../../src/broker/operations.ts');const {mkdirSync,writeFileSync}=await import('node:fs');
 const f=createFixture();try{
  mkdirSync(join(f.directory,'vault'),{mode:0o700});writeFileSync(join(f.directory,'vault','provider'), 'owned-fixture-sentinel',{mode:0o600});
  const calls:string[][]=[];const nativeImage='native@sha256:'+'a'.repeat(64);const workerImage='worker@sha256:'+'b'.repeat(64);const proxyImage='proxy@sha256:'+'c'.repeat(64);
  const docker={async command(args:string[]){calls.push(args);assert.equal(args[0],'image','provisionability must not allocate/start native resources');return JSON.stringify([{RepoDigests:[args.at(-1)],Os:'linux',Architecture:'amd64'}])}};
  const fleet=createNativeFleet({installation:{id:'fixture',root:f.directory,docker,secrets:{async loadOrCreate(){throw Error('unused')}}},store:f.store,broker:createAttemptBroker({store:f.store,clock:f.clock,signingKey:Buffer.alloc(32,7)}),protectedPaths:[join(f.directory,'vault'),f.path,'/var/run/docker.sock'],config:{schemaVersion:1,installationId:'fixture',allowedOrigins:['http://127.0.0.1:4000'],repositories:[],providerCredentials:[{ref:'provider',providerId:'copilot',resource:'https://api.github.com',expiresAt:'2099-01-01T00:00:00Z',scopes:[]}],native:[{kind:'vscode-isolated-worker-v2',nativeImage,workerImage,entrypoint:'/opt/vscode/out/vs/platform/agentHost/node/agentHostServerMain.js',entrypointSha256:'d'.repeat(64),hostCommit:'e576c7bbeb39772a1d1ebe472545def0d93e6d8b',pristineDirectory:'/workspaces/task',emptyHome:'/opt/software-factory/empty-home',credentialRef:'provider',proxy:{image:proxyImage,entrypoint:'/opt/sf/proxy.cjs',entrypointSha256:'e'.repeat(64),allowedAuthorities:['api.githubcopilot.com:443']}}]}});
  assert.match((await fleet.provisionability(f.task)).join(' '), /reviewed.*proxy/i);assert.equal(calls.length,0);assert.equal(f.store.getReservations().length,0);
  const readiness=await fleet.owner.readiness(f.task.required);assert.equal(readiness.ready,false);assert.deepEqual(readiness.verifiedProfileIds,[]);
  await fleet.close();
 }finally{f.close()}
});

for(const boundary of ['native-recovery','engine-adoption','config-stall','config-fail','vault-stall','vault-fail','vault-control-stall','vault-control-fail','pairing-stall','pairing-fail','listener-stall','listener-fail'])test(`runtime observes retained deadlines before stalled initial ${boundary} and keeps admission disabled`, async () => {
 const {openStore}=await import('../../src/storage/store.ts');
 const {recipeMaterializer}=await import('../../src/recipes/materialize.ts');
 const {RecipeRegistry,recipePayloadHash}=await import('../../src/recipes/registry.ts');
 const {parse}=await import('yaml');
 const {createScheduler}=await import('../../src/scheduling/admission.ts');
 const {createAttemptBroker}=await import('../../src/broker/operations.ts');
 const {fingerprint,systemClock}=await import('../../src/storage/database.ts');
 const {writeFileSync,mkdirSync,readFileSync}=await import('node:fs');
 const {startRuntime}=await import('../../src/service/runtime.ts');
 const directory=mkdtempSync(join(tmpdir(),'sf-recovery-deadline-'));
 const store=openStore(join(directory,'factory.sqlite'),{materialize:recipeMaterializer});
 const f={directory,store,clock:systemClock,close(){store.close();rmSync(directory,{recursive:true,force:true})}};
 let runtime:Awaited<ReturnType<typeof startRuntime>>|undefined;
 let release!:()=>void;let entered!:()=>void;
 const stalled=new Promise<void>(resolve=>{release=resolve});
 const recoveryEntered=new Promise<void>(resolve=>{entered=resolve});
 try {
  for(const id of ['repo-1','repo-2'])store.createRepository({id,name:id,url:'https://github.com/fixture/'+id+'.git'});
  const source=parse(readFileSync(new URL('../../recipes/starter/focused-feature.yaml',import.meta.url),'utf8'));
  source.variables.sf.tagId=store.snapshot().tags[0]!.id;source.variables.sf.required.allowedFinishPolicies=['result'];source.variables.sf.defaultFinishPolicy='result';
  const registry=new RecipeRegistry(store,{resolveReference:()=>true,executionReadiness:()=>[]});
  const recipe=registry.createCommand({yaml:JSON.stringify(source),repositoryIds:['repo-1','repo-2']},{key:'recipe'});
  registry.patchCommand(recipe.recipeId,{active:true,approval:{recipeHash:recipe.hash,payloadHash:recipePayloadHash(recipe),repositoryIds:['repo-1','repo-2'],capabilities:recipe.contract.variables.sf.required}},{key:'approve',expectedRevision:store.snapshot().recipes[0]!.revision});
  store.createManualTasks({recipeId:recipe.recipeId,repositoryIds:['repo-1','repo-2'],title:'Retained',description:'Restart deadline fixture'},'tasks');
  const settings=store.getSettings();store.patchSettings({limits:{...settings.config.limits,concurrency:2}},settings.revision);
  const scheduler=createScheduler({store,clock:systemClock,materialize:recipeMaterializer,readiness:async()=>({ready:true,baseSha:'base',workspacePath:directory,profileId:'profile'}),start:async()=>({kind:'started',identity:{workflow:{executionId:'retained',namespace:'sf',flowId:'flow',revision:'1'}}})});
  await scheduler.dispatch('manual');await scheduler.dispatch('manual');
  const reservations=f.store.getReservations();assert.equal(reservations.length,2);
  const broker=createAttemptBroker({store:f.store,clock:f.clock,signingKey:Buffer.alloc(32,7)});
  const r=reservations[0]!;const start=broker.nativeStart(r.attempt.id,'retained-start');
  f.store.broker.claim({attemptId:r.attempt.id,fence:r.lease.fence,key:'retained-start',payload:{operation:'native.start',payload:start,idempotencyKey:'retained-start'}});
  f.store.bindLifecycleIdentity(r.attempt.id,{ownerId:'vscode',providerId:'copilot',sessionId:'ahp-session:/retained',chatId:'ahp-chat:/retained'});
  const owner='rt-'+fingerprint({installation:'fixture',task:start.task.id}).slice(0,24);
  const parent=join(f.directory,'native-state',owner);mkdirSync(join(parent,'data'),{recursive:true,mode:0o700});
  writeFileSync(join(parent,'owner.json'),JSON.stringify({schemaVersion:1,installationId:'fixture',runtimeOwnerId:owner,taskId:start.task.id,source:join(parent,'data')}),{mode:0o600});
  mkdirSync(join(f.directory,'vault'),{mode:0o700});
  for(const name of ['broker-signing','private-control'])writeFileSync(join(f.directory,'vault',name),Buffer.alloc(32,7),{mode:0o600});
  writeFileSync(join(f.directory,'runtime.json'),JSON.stringify({schemaVersion:1,installationId:'fixture',allowedOrigins:['http://127.0.0.1:4000'],repositories:[],providerCredentials:[{ref:'provider',providerId:'copilot',resource:'https://api.github.com',expiresAt:'2099-01-01T00:00:00Z',scopes:[]}],native:[{kind:'vscode-isolated-worker-v2',nativeImage:'native@sha256:'+'a'.repeat(64),workerImage:'worker@sha256:'+'b'.repeat(64),entrypoint:'/opt/vscode/out/vs/platform/agentHost/node/agentHostServerMain.js',entrypointSha256:'c'.repeat(64),hostCommit:'e576c7bbeb39772a1d1ebe472545def0d93e6d8b',pristineDirectory:'/workspaces/task',emptyHome:'/opt/software-factory/empty-home',credentialRef:'provider',proxy:{image:'proxy@sha256:'+'d'.repeat(64),entrypoint:'/opt/sf/proxy.cjs',entrypointSha256:'e'.repeat(64),allowedAuthorities:['api.githubcopilot.com:443']}}]}),{mode:0o600});
  const configModule=await import('../../src/service/config.ts');const pairingModule=await import('../../src/owners/bridge-rpc.ts');let failed=false;
  async function boundaryWait(name:string){if(boundary!==name+'-stall'&&boundary!==name+'-fail')return;if(boundary.endsWith('-fail')&&!failed){failed=true;throw Error('fixture early dependency failure')}entered();await stalled}
  const pending=startRuntime({id:'fixture',root:f.directory,docker:{async command(args){if((boundary==='native-recovery'&&args[0]==='network'&&args[1]==='inspect'&&args[2]===owner+'-internal')||(boundary==='engine-adoption'&&args[0]==='image'&&args[1]==='inspect')){entered();await stalled;}throw Error('Fixture has no provisioned images')}},secrets:{async loadOrCreate(){return{username:'fixture',password:'nonsecret-fixture-password-000000000',encryptionKey:Buffer.alloc(32,11).toString('base64')}}}},{async loadConfig(root,id){await boundaryWait('config');return configModule.loadRuntimeConfigAsync(root,id)},async readSecret(root,ref){if(ref==='broker-signing')await boundaryWait('vault');if(ref==='private-control')await boundaryWait('vault-control');return configModule.readVaultSecretAsync(root,ref)},async pair(directory,id){await boundaryWait('pairing');return pairingModule.createOwnerPairing(directory,id,'bb')},async listen(options){await boundaryWait('listener');return pairingModule.listenBbOwner(options)}});
  await Promise.race([recoveryEntered,new Promise((_,reject)=>setTimeout(()=>reject(Error('recovery did not reach external inspection')),2000))]);
  let stopped=false;
  for(let i=0;i<20;i++){
   if(reservations.every(r=>f.store.getLifecycle(r.attempt.id).state.stopRequested)){stopped=true;break}
   await new Promise(resolve=>setTimeout(resolve,30));
  }
  release();runtime=await pending;
  assert.equal(stopped,true,'retained active epochs must be accounted and stopped while initial recovery is still blocked');
  assert.equal(f.store.getReservations().length,2,'startup recovery never admits new work');
  assert.equal(f.store.getAdmissionState().activeLeases.length,2,'unknown physical writers retain their original fences');
 } finally {release();await runtime?.stop();f.close()}
});

test('durable maintenance intent survives reconstruction without restarting Kestra or admitting mutations', async () => {
 const {mkdirSync,writeFileSync}=await import('node:fs'); const {openStore}=await import('../../src/storage/store.ts'); const {startRuntime}=await import('../../src/service/runtime.ts');
 const root=mkdtempSync(join(tmpdir(),'sf-maintenance-restart-'));mkdirSync(join(root,'vault'),{mode:0o700});
 writeFileSync(join(root,'runtime.json'),JSON.stringify({schemaVersion:1,installationId:'fixture',allowedOrigins:['http://127.0.0.1:4000'],repositories:[],providerCredentials:[],native:[]}),{mode:0o600});
 for(const name of ['broker-signing','private-control'])writeFileSync(join(root,'vault',name),Buffer.alloc(32,7),{mode:0o600});
 const store=openStore(join(root,'factory.sqlite'));store.enqueueAction({key:'maintenance:fixture',kind:'maintenance.intent',payload:{installationId:'fixture'}});store.close();
 let calls=0;let runtime:Awaited<ReturnType<typeof startRuntime>>|undefined;
 try {
  runtime=await startRuntime({id:'fixture',root,docker:{async command(){calls++;throw Error('must not touch Docker')}},secrets:{async loadOrCreate(){throw Error('must not create secrets')}}});
  assert.equal(calls,0);
  const headers={authorization:'Bearer '+Buffer.alloc(32,7).toString('base64url'),'content-type':'application/json'};
  assert.equal((await fetch(runtime.controlUrl+'/next',{method:'POST',headers,body:JSON.stringify({key:'blocked'})})).status,409);
  const session=runtime.api.sessions.provision('http://127.0.0.1:4000');
  assert.equal((await fetch(runtime.api.url+'/v1/tags',{method:'POST',headers:{origin:'http://127.0.0.1:4000',cookie:session.cookie,'x-sf-csrf':session.csrfToken,'content-type':'application/json','idempotency-key':'blocked'},body:JSON.stringify({displayName:'blocked'})})).status,503);
 } finally {await runtime?.stop();rmSync(root,{recursive:true,force:true})}
});

test('private maintenance admission persists before refusing new dispatch and survives restart', async () => {
 const {mkdirSync,writeFileSync}=await import('node:fs'); const {startRuntime}=await import('../../src/service/runtime.ts');
 const root=mkdtempSync(join(tmpdir(),'sf-maintenance-intent-'));mkdirSync(join(root,'vault'),{mode:0o700});
 writeFileSync(join(root,'runtime.json'),JSON.stringify({schemaVersion:1,installationId:'fixture',allowedOrigins:['http://127.0.0.1:4000'],repositories:[],providerCredentials:[],native:[]}),{mode:0o600});for(const name of ['broker-signing','private-control'])writeFileSync(join(root,'vault',name),Buffer.alloc(32,7),{mode:0o600});
 const installation={id:'fixture',root,docker:{async command(){throw Error('no docker')}},secrets:{async loadOrCreate(){throw Error('no engine')}}};let runtime:Awaited<ReturnType<typeof startRuntime>>|undefined;
 const headers={authorization:'Bearer '+Buffer.alloc(32,7).toString('base64url'),'content-type':'application/json'};
 try {
  runtime=await startRuntime(installation);
  assert.equal((await fetch(runtime.controlUrl+'/maintenance',{method:'POST',headers,body:'{}'})).status,409);
  const response=await fetch(runtime.controlUrl+'/maintenance',{method:'POST',headers,body:JSON.stringify({purpose:'reconfigure'})});assert.equal(response.status,200);
  const intent=runtime.store.pendingActions().find(action=>action.kind==='maintenance.intent');assert.equal(intent?.payload.purpose,'reconfigure');assert.ok(runtime.store.getActionByKey('maintenance:drained:'+intent!.id)?.completedAt);
  assert.equal((await fetch(runtime.controlUrl+'/maintenance',{method:'POST',headers,body:JSON.stringify({purpose:'uninstall'})})).status,409);
  assert.equal((await fetch(runtime.controlUrl+'/next',{method:'POST',headers,body:JSON.stringify({key:'after-maintenance'})})).status,409);
  await runtime.stop();runtime=await startRuntime(installation);
  assert.ok(runtime.store.pendingActions().some(action=>action.kind==='maintenance.intent'));
  assert.equal((await fetch(runtime.controlUrl+'/next',{method:'POST',headers,body:JSON.stringify({key:'after-restart'})})).status,409);
 } finally {await runtime?.stop();rmSync(root,{recursive:true,force:true})}
});
test('maintenance stops the owned engine only after empty writer inventories are proven',async()=>{
 const {mkdirSync,writeFileSync,readFileSync}=await import('node:fs');
 const {createMaintenanceRuntime,proveOwnedEngineStopped}=await import('../helpers/maintenance-runtime.ts');
 const f=await createMaintenanceRuntime('reconfigure');
 try{
  await proveOwnedEngineStopped(f);
  const backupRequest=()=>f.request('/backup',{});
  const firstBackup=await backupRequest();assert.equal(firstBackup.status,200);
  const backup=await firstBackup.json();assert.equal(backup.state,'complete');
  const secondBackup=await backupRequest();assert.deepEqual(await secondBackup.json(),backup);
  assert.equal(readFileSync(join(backup.directory,'kestra/data/database.mv.db'),'utf8'),'test-h2');
  mkdirSync(join(f.root,'runtime','0.2.0'),{recursive:true,mode:0o700});
  const node=join(f.root,'runtime','0.2.0','node'),entry=join(f.root,'runtime','0.2.0','service.js');
  writeFileSync(node,'candidate-node',{mode:0o600});writeFileSync(entry,'candidate-entry',{mode:0o600});
  const hold=f.holdNextEngineInspection();
  const candidateRequest=f.request('/prepare-candidate',{node,entry,taktSeconds:120});
  try{await hold.wait;assert.equal((await f.maintenance()).status,409)}finally{hold.release()}
  const candidate=await candidateRequest;assert.equal(candidate.status,200);assert.equal((await candidate.json()).state,'prepared');
  const rerequest=await f.maintenance();assert.equal((await rerequest.json()).state,'engine_stopped');
  const evidence=await f.request('/rollback-evidence');assert.equal(evidence.status,200);assert.ok((await evidence.json()).receipts.length>=5);
  writeFileSync(join(backup.directory,'kestra/data/database.mv.db'),'tampered',{mode:0o600});
  assert.equal((await backupRequest()).status,409);
 }finally{await f.close()}
});

test('uninstall cleanup removes only verified stopped Docker identities after writer proof',async()=>{
 const {createMaintenanceRuntime,proveOwnedEngineStopped}=await import('../helpers/maintenance-runtime.ts');
 const f=await createMaintenanceRuntime('uninstall');
 try{
  await proveOwnedEngineStopped(f);
  const cleanup=await f.request('/cleanup',{});assert.equal(cleanup.status,200);
  const result=await cleanup.json();assert.equal(result.state,'resources_removed');
  assert.deepEqual(new Set(result.removed),new Set(['container:'+f.relay,'container:'+f.transport,'container:'+f.engine,'network:'+f.network]));
  assert.equal(f.objects[f.engine],undefined);assert.equal(f.objects[f.network],undefined);
  const replay=await f.request('/cleanup',{});assert.equal(replay.status,200);assert.deepEqual(await replay.json(),result);
  const status=await f.request('/cleanup-status');assert.equal(status.status,200);assert.deepEqual(await status.json(),{removed:result.removed,blocked:[]});
  const recovered=await f.maintenance();assert.equal((await recovered.json()).state,'engine_stopped');
 }finally{await f.close()}
});

test('cleanup status reports exact completed and unknown removals',async()=>{
 const {createMaintenanceRuntime,proveOwnedEngineStopped}=await import('../helpers/maintenance-runtime.ts');
 const f=await createMaintenanceRuntime('uninstall');
 try{
  await proveOwnedEngineStopped(f);
  const intent=f.runtime.store.pendingActions().find(a=>a.kind==='maintenance.intent')!;
  const resources=[{kind:'container',id:f.relay},{kind:'container',id:f.engine},{kind:'network',id:f.network}];
  f.runtime.store.enqueueAction({key:'maintenance:cleanup:'+intent.id,kind:'maintenance.cleanup',payload:{maintenanceIntentId:intent.id,resources}});
  const done=f.runtime.store.enqueueAction({key:'maintenance:remove:container:'+f.relay,kind:'maintenance.remove',payload:{}});
  f.runtime.store.completeAction(done.id);
  f.runtime.store.enqueueAction({key:'maintenance:remove:container:'+f.engine,kind:'maintenance.remove',payload:{}});
  const status=await f.request('/cleanup-status');
  assert.deepEqual(await status.json(),{removed:['container:'+f.relay],blocked:[
    {kind:'effect',identity:'container:'+f.engine},{kind:'retained',identity:'network:'+f.network},
    {kind:'effect',identity:'cleanup-outcome-unconfirmed'}]});
 }finally{await f.close()}
});

test('pending uninstall intent fences bootstrap before dependency startup', async () => {
 const {mkdirSync,writeFileSync}=await import('node:fs'); const {openStore}=await import('../../src/storage/store.ts'); const {startRuntime}=await import('../../src/service/runtime.ts');
 const root=mkdtempSync(join(tmpdir(),'sf-maintenance-restart-'));mkdirSync(join(root,'vault'),{mode:0o700});
 writeFileSync(join(root,'runtime.json'),JSON.stringify({schemaVersion:1,installationId:'fixture',allowedOrigins:['http://127.0.0.1:4000'],repositories:[],providerCredentials:[],native:[]}),{mode:0o600});
 for(const name of ['broker-signing','private-control'])writeFileSync(join(root,'vault',name),Buffer.alloc(32,7),{mode:0o600});
 const store=openStore(join(root,'factory.sqlite'));writeFileSync(join(root,'uninstall-pending.json'),JSON.stringify({schemaVersion:1,installationId:'fixture',state:'pending'}),{mode:0o600});store.close();
 let calls=0;let runtime:Awaited<ReturnType<typeof startRuntime>>|undefined;
 try {
  runtime=await startRuntime({id:'fixture',root,docker:{async command(){calls++;throw Error('must not touch Docker')}},secrets:{async loadOrCreate(){throw Error('must not create secrets')}}});
  assert.equal(calls,0);assert.equal(runtime.store.pendingActions().find(a=>a.kind==='maintenance.intent')?.payload.purpose,'uninstall');
  const headers={authorization:'Bearer '+Buffer.alloc(32,7).toString('base64url'),'content-type':'application/json'};
  assert.equal((await fetch(runtime.controlUrl+'/next',{method:'POST',headers,body:JSON.stringify({key:'blocked'})})).status,409);
  const session=runtime.api.sessions.provision('http://127.0.0.1:4000');
  assert.equal((await fetch(runtime.api.url+'/v1/tags',{method:'POST',headers:{origin:'http://127.0.0.1:4000',cookie:session.cookie,'x-sf-csrf':session.csrfToken,'content-type':'application/json','idempotency-key':'blocked'},body:JSON.stringify({displayName:'blocked'})})).status,503);
 } finally {await runtime?.stop();rmSync(root,{recursive:true,force:true})}
});
