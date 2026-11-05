import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
async function run(program: string, input: unknown) {
  const child = spawn(process.execPath, ['-e', program], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.resume(); child.stdin.end(JSON.stringify(input));
  await new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('worker refused'))); });
  return JSON.parse(output);
}
test('isolated worker executes finite file operations and refuses path escape', async () => {
  const m = await import('../../src/owners/worker.ts').catch(() => undefined);
  assert.ok(m?.workerProgram, 'concrete isolated worker executor is missing');
  const root = mkdtempSync(join(tmpdir(), 'sf-worker-')); const file = join(root, 'file'); writeFileSync(file, 'before');
  try {
    const input = { roots: [{ target: root, writable: true }], cwd: root, operation: { kind: 'read', path: file } };
    assert.deepEqual(await run(m.workerProgram, input), { content: 'before' });
    await run(m.workerProgram, { ...input, operation: { kind: 'write', path: file, content: 'after' } });
    assert.equal(readFileSync(file, 'utf8'), 'after');
    await assert.rejects(run(m.workerProgram, { ...input, operation: { kind: 'read', path: '/etc/passwd' } }));
    await assert.rejects(run(m.workerProgram, { ...input, roots: [{ target: root, writable: false }], operation: { kind: 'write', path: file, content: 'bad' } }));
    assert.equal(readFileSync(file, 'utf8'), 'after');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

async function workerFixture(){
 const {openStore}=await import('../../src/storage/store.ts');const {RecipeRegistry,recipePayloadHash}=await import('../../src/recipes/registry.ts');const {recipeMaterializer}=await import('../../src/recipes/materialize.ts');const {parse}=await import('yaml');
 const {createScheduler}=await import('../../src/scheduling/admission.ts');const {systemClock}=await import('../../src/storage/database.ts');const {createAttemptBroker}=await import('../../src/broker/operations.ts');const {createFactoryToolGate}=await import('../../src/owners/tools.ts');const {IsolatedToolWorker}=await import('../../src/owners/worker.ts');
 const root=mkdtempSync(join(tmpdir(),'sf-worker-authority-'));const file=join(root,'file');writeFileSync(file,'before');const store=openStore(join(root,'store.sqlite'),{materialize:recipeMaterializer});
 store.createRepository({id:'repo',name:'Fixture',url:'https://github.com/fixture/repo.git'});const source=parse(readFileSync(new URL('../../recipes/starter/focused-feature.yaml',import.meta.url),'utf8'));source.variables.sf.tagId=store.snapshot().tags[0]!.id;source.variables.sf.required.allowedFinishPolicies=['result'];source.variables.sf.defaultFinishPolicy='result';
 const registry=new RecipeRegistry(store,{resolveReference:()=>true,executionReadiness:()=>[]});const recipe=registry.createCommand({yaml:JSON.stringify(source),repositoryIds:['repo']},{key:'recipe'});registry.patchCommand(recipe.recipeId,{active:true,approval:{recipeHash:recipe.hash,payloadHash:recipePayloadHash(recipe),repositoryIds:['repo'],capabilities:recipe.contract.variables.sf.required}},{key:'approve',expectedRevision:store.snapshot().recipes[0]!.revision});store.createManualTasks({recipeId:recipe.recipeId,repositoryIds:['repo'],title:'Task',description:'Test'},'task');
 await createScheduler({store,clock:systemClock,materialize:recipeMaterializer,readiness:async()=>({ready:true,baseSha:'base',workspacePath:root,profileId:'profile'}),start:async()=>({kind:'started',identity:{workflow:{executionId:'engine',flowId:'flow',namespace:'sf',revision:recipe.revision}}})}).dispatch('manual');
 const r=store.getReservations()[0]!;const identity={ownerId:'vscode',providerId:'copilot' as const,sessionId:'ahp-session:/original',chatId:'ahp-chat:/original'};store.bindLifecycleIdentity(r.attempt.id,identity);
 const broker=createAttemptBroker({store,clock:systemClock,signingKey:Buffer.alloc(32,7)});const gate=createFactoryToolGate({store,broker});const start=broker.nativeStart(r.attempt.id,'original');gate.prepare(start,'original');
 let executions=0;let drop=false;
 const config={containerId:'worker',nativeContainerId:'native',runtimeOwnerId:'owned',image:'worker@sha256:'+'a'.repeat(64),mountTargets:[]};
 const c={Id:'worker',Image:'image',Config:{Image:config.image,Labels:{'sf.runtime-owner':'owned'},User:'1000',WorkingDir:'/workspaces/task',Env:['PATH=/usr/local/bin:/usr/bin:/bin','HOME=/tmp','LANG=C.UTF-8']},State:{Running:true,Paused:false,Pid:32,StartedAt:'epoch'},Mounts:[{Type:'bind',Source:root,Destination:root,RW:true}],NetworkSettings:{Networks:{none:{}}},HostConfig:{NetworkMode:'none',ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],IpcMode:'private',PidsLimit:256,Memory:2147483648,NanoCpus:2e9,RestartPolicy:{Name:'no'},AutoRemove:false}};
 const worker=new IsolatedToolWorker({config,store,gate,docker:{async command(args,options){if(args[0]==='image')return JSON.stringify([{Id:'image',RepoDigests:[config.image]}]);if(args[0]==='container')return JSON.stringify([c]);executions++;const result=await run(args.at(-1)!,JSON.parse(options!.stdin!));if(drop)throw Error('lost external reply');return JSON.stringify(result)}}});
 return{store,worker,gate,start,identity,file,r,c,config,get executions(){return executions},loseReply(){drop=true},close(){store.close();rmSync(root,{recursive:true,force:true})}};
}
test('worker unknown write is never replayed and current native identity is mandatory',async()=>{
 const f=await workerFixture();try{
  await assert.rejects(f.worker.invoke({...f.identity,sessionId:'foreign'},'foreign','sf_write_file',{path:f.file,content:'bad'}));assert.equal(f.executions,0);
  f.loseReply();await assert.rejects(f.worker.invoke(f.identity,'lost','sf_write_file',{path:f.file,content:'once'}));assert.equal(readFileSync(f.file,'utf8'),'once');assert.equal(f.store.getTask(f.r.task.spec.id)!.status,'needs_attention');assert.equal(f.gate.isSuspended(),true);
  await assert.rejects(f.worker.invoke(f.identity,'lost','sf_write_file',{path:f.file,content:'once'}));assert.equal(f.executions,1);
 }finally{f.close()}
});
test('human tools require separate current admission while factory operations stay suspended',async()=>{
 const f=await workerFixture();try{
  f.store.updateLifecycle(f.r.attempt.id,f.r.lease.fence,{status:'needs_attention',release:'waiting',human:true});const repo=f.store.getRepository('repo')!;f.store.setRepositoryControl('repo','human',repo.revision);f.gate.suspend();
  f.worker.admitHuman(f.start,f.identity,()=>assert.equal(f.store.getRepository('repo')!.controlMode,'human'));
  assert.deepEqual(await f.worker.invoke(f.identity,'human-read','sf_read_file',{path:f.file}),{content:'before'});
  await assert.rejects(f.gate.invoke(f.identity,'factory-denied','sf_factory_operation',{operation:'task.read',payload:{taskId:f.r.task.spec.id}}));
  f.store.setRepositoryControl('repo','factory',f.store.getRepository('repo')!.revision);
  await assert.rejects(f.worker.invoke(f.identity,'human-after-return','sf_read_file',{path:f.file}));assert.equal(f.executions,1);
 }finally{f.close()}
});

test('human tool admission does not survive revocation of its exact recipe grant',async()=>{
 const f=await workerFixture();try{
  f.store.updateLifecycle(f.r.attempt.id,f.r.lease.fence,{status:'needs_attention',release:'waiting',human:true});f.store.setRepositoryControl('repo','human',f.store.getRepository('repo')!.revision);f.gate.suspend();
  f.worker.admitHuman(f.start,f.identity,()=>assert.equal(f.store.getRepository('repo')!.controlMode,'human'));
  f.store.revokeGrant(f.store.getAdmissionState().grants[0]!.id);
  await assert.rejects(f.worker.invoke(f.identity,'revoked-human','sf_read_file',{path:f.file}));assert.equal(f.executions,0);
 }finally{f.close()}
});

test('maintenance stops a verified worker and preserves an unresolved worker effect',async()=>{
 const f=await workerFixture();try {
  const {IsolatedToolWorker}=await import('../../src/owners/worker.ts');let kills=0;
  const docker={async command(args:string[]){if(args[0]==='image')return JSON.stringify([{Id:'image',RepoDigests:[f.config.image]}]);if(args[1]==='inspect')return JSON.stringify([f.c]);if(args[1]==='kill'){kills++;Object.assign(f.c.State,{Running:false,Paused:false,Pid:0,Status:'exited'});return ''}throw Error('unexpected')}};
  const worker=new IsolatedToolWorker({config:f.config,store:f.store,gate:f.gate,docker});
  const pending=f.store.enqueueAction({key:'unknown-worker-test',kind:'worker.execute',payload:{attemptId:f.r.attempt.id}});
  await assert.rejects(worker.stopForMaintenance());assert.equal(kills,0);
  f.store.completeAction(pending.id);await worker.stopForMaintenance();assert.equal(kills,1);assert.equal(f.c.State.Running,false);assert.equal(await worker.quiesceForMaintenance(),'stopped');
 }finally{f.close()}
});
test('unacknowledged worker stop retains its intent and is never retried as proof',async()=>{
 const f=await workerFixture();try {
  const {IsolatedToolWorker}=await import('../../src/owners/worker.ts');let kills=0;
  const docker={async command(args:string[]){if(args[0]==='image')return JSON.stringify([{Id:'image',RepoDigests:[f.config.image]}]);if(args[1]==='inspect')return JSON.stringify([f.c]);if(args[1]==='kill'){kills++;throw Error('lost response')}throw Error('unexpected')}};
  const worker=new IsolatedToolWorker({config:f.config,store:f.store,gate:f.gate,docker});
  await assert.rejects(worker.stopForMaintenance());await assert.rejects(worker.stopForMaintenance());assert.equal(kills,1);assert.ok(f.store.pendingActions().some(a=>a.kind==='worker.maintenance_stop'));
 }finally{f.close()}
});
test('maintenance closes human tool admission before awaiting external quiescence',async()=>{
 const f=await workerFixture();try{
  f.store.updateLifecycle(f.r.attempt.id,f.r.lease.fence,{status:'needs_attention',release:'waiting',human:true});f.store.setRepositoryControl('repo','human',f.store.getRepository('repo')!.revision);f.gate.suspend();f.worker.admitHuman(f.start,f.identity,()=>{});
  f.worker.closeAdmission();await assert.rejects(f.worker.invoke(f.identity,'closed-human','sf_read_file',{path:f.file}));assert.equal(f.executions,0);
 }finally{f.close()}
});
