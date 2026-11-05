import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {parse} from 'yaml';
import {openStore} from '../../../src/storage/store.ts';
import {RecipeRegistry,recipePayloadHash} from '../../../src/recipes/registry.ts';
import {recipeMaterializer} from '../../../src/recipes/materialize.ts';
import {createScheduler} from '../../../src/scheduling/admission.ts';
import {createLifecycle} from '../../../src/scheduling/lifecycle.ts';
import {createAttemptBroker} from '../../../src/broker/operations.ts';
import {createFactoryToolGate} from '../../../src/owners/tools.ts';
import {createVsCodeOwner} from '../../../src/owners/vscode.ts';
import {createWorkspaceManager} from '../../../src/workspaces/manager.ts';
import {createCloseout} from '../../../src/github/closeout.ts';
import {KestraClient} from '../../../src/kestra/client.ts';
import {createKestraAuthority} from '../../../src/broker/authority.ts';
import {reconcileInstallation} from '../../../src/service/reconcile.ts';
import {acquireInstallationSingleton} from '../../../src/service/singleton.ts';
import {systemClock} from '../../../src/storage/database.ts';
import type {WorkflowStart,TaskResult,NativeStart} from '../../../src/contracts/domain.ts';
import type {Reservation} from '../../../src/scheduling/admission-types.ts';
const root=process.argv[2]!;const crash=process.argv[3];const config=JSON.parse(readFileSync(join(root,'fixture.json'),'utf8'));
const checkpoint=async(phase:string,detail:Record<string,unknown>={})=>{if(crash===phase){process.send?.({phase,...detail});await new Promise(()=>{})}};
const request=async(url:string,value?:unknown)=>{const r=await fetch(url,{method:value===undefined?'GET':'POST',...(value===undefined?{}:{body:JSON.stringify(value),headers:{'content-type':'application/json'}})});if(!r.ok)throw Error(await r.text());return r.json()};
const lock=acquireInstallationSingleton(root);const store=openStore(join(root,'factory.sqlite'),{materialize:recipeMaterializer});
const registry=new RecipeRegistry(store,{resolveReference:()=>true,executionReadiness:()=>[]});
if(!store.getRepository('repo')){
  store.createRepository({id:'repo',name:'fixture',url:'https://github.com/fixture/repo.git'});
  const source=parse(readFileSync(new URL('../../../recipes/starter/focused-feature.yaml',import.meta.url),'utf8'));
  source.variables.sf.tagId=store.snapshot().tags[0]!.id;source.variables.sf.required.allowedFinishPolicies=['result'];source.variables.sf.defaultFinishPolicy='result';
  const recipe=registry.createCommand({yaml:JSON.stringify(source),repositoryIds:['repo']},{key:'fixture-recipe'});
  registry.patchCommand(recipe.recipeId,{active:true,approval:{recipeHash:recipe.hash,payloadHash:recipePayloadHash(recipe),repositoryIds:['repo'],capabilities:recipe.contract.variables.sf.required}},{key:'fixture-approve',expectedRevision:store.snapshot().recipes[0]!.revision});
  store.createManualTasks({recipeId:recipe.recipeId,repositoryIds:['repo'],title:'Fixture task',description:'Retain identity across crash',finishPolicy:'result'},'fixture-task');
}
const task=store.snapshot().tasks[0]!;
const gitEnv={PATH:process.env.PATH!,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
const workspace=createWorkspaceManager({factoryRoot:root,resolveRepository:async()=>({id:'repo',url:'https://github.com/fixture/repo.git',baseRef:'refs/heads/main'}),gitAuth:{async fetch(input){execFileSync('git',['fetch','--no-tags',config.source,input.ref!],{cwd:input.cwd,env:gitEnv,stdio:'pipe'})}},metadataBoundary:{async assertProtected(){}}});
const prepared=await workspace.prepareWorkspace(task.spec);
const broker=createAttemptBroker({store,clock:systemClock,signingKey:Buffer.alloc(32,7)});const gate=createFactoryToolGate({store,broker});
const engine=new KestraClient({journalDirectory:join(root,'engine'),request:q=>request(config.engine+'/engine',q),authority:createKestraAuthority({broker,store})});
const stopped=()=>{try{return readFileSync(`/proc/${config.nativePid}/stat`,'utf8').split(') ')[1]?.startsWith('T')??false}catch{return false}};
const owner=createVsCodeOwner({journalPath:join(root,'native.sqlite'),endpoint:{url:config.native.replace('http:','ws:'),tokenFile:join(root,'fixture-token')},tools:gate,
  launcher:{async ensureStarted(){return{url:config.native.replace('http:','ws:'),tokenFile:join(root,'fixture-token')}},async pause(){process.kill(config.nativePid,'SIGSTOP')},async paused(){return stopped()},async stop(){process.kill(config.nativePid,'SIGSTOP')},async stopped(){return stopped()}},
  requireVerifiedProfile:async start=>({profileId:start.profileId,ownerId:start.task.ownerId,providerId:start.task.providerId,verifiedAt:new Date().toISOString(),required:start.task.required,probes:[]})});
const workflowStart=(r:Reservation):WorkflowStart=>({idempotencyKey:'runtime:start:'+r.id,attemptId:r.attempt.id,recipe:store.getRecipeRevision(r.task.spec.recipeId,r.task.spec.recipeRevision)!,inputs:{},scopeId:r.id,fence:r.lease.fence});
const scheduler=createScheduler({store,clock:systemClock,materialize:recipeMaterializer,readiness:async()=>({ready:true,baseSha:prepared.baseSha,workspacePath:prepared.path,profileId:'fixture-process-boundary'}),async start(r){store.enqueueAction({key:'runtime:start:'+r.id,kind:'runtime.start',payload:{reservationId:r.id}});await checkpoint('reservation',{workspace:r.attempt.workspacePath});return{kind:'started',identity:{workflow:await engine.ensureExecution(workflowStart(r))}}}});
if(!store.getReservations().length)await scheduler.dispatch('manual');
let r=store.getReservations()[0]!;
if(r.status==='pending')store.confirmStart(r.id,{workflow:await engine.ensureExecution(workflowStart(r))});
r=store.getReservations()[0]!;
const start:NativeStart={idempotencyKey:'native-original',attemptId:r.attempt.id,task:r.task.spec,workspacePath:r.attempt.workspacePath,baseSha:r.attempt.baseSha,fence:r.lease.fence,profileId:r.attempt.profileId};
let identity=r.attempt.native!;
if(task.status!=='completed'){
 process.kill(config.nativePid,'SIGCONT');
 identity=await owner.ensureSession(start);await checkpoint('native',{identity,workflow:r.attempt.workflow,workspace:prepared.path});
 if(!r.attempt.native)store.bindLifecycleIdentity(r.attempt.id,identity);
 gate.prepare(start,'original');
 await request(config.engine+'/park',{identity});
 await owner.send(identity,{text:'Fixture task'},'original-turn');
 const snapshot=await owner.snapshot(identity);
 if(snapshot.inputs[0])await owner.send(identity,{requestId:snapshot.inputs[0].id,response:{response:'accept',answers:{}},answers:{response:'accept',answers:{}}},'exact-native-answer');
}
const lifecycle=createLifecycle({store,clock:systemClock,owner:()=>owner,readiness:async()=>({ready:true,baseSha:prepared.baseSha,workspacePath:prepared.path,profileId:r.attempt.profileId}),workspace:async()=>true,workflow:{snapshot:async()=> 'present',quiesce:()=>engine.quiescence(r.attempt.workflow!),resume:async()=>{}}});
const actualCloseout=createCloseout({store,clock:systemClock,lifecycle,workspace,github:{async request(){throw Error('Result-only fixture must not write GitHub')}},git:{async push(){throw Error('Result-only must not push')}}});
const closeout={async finishTask(spec:typeof task.spec,result:TaskResult){const value=await actualCloseout.finishTask(spec,result);await checkpoint('closeout',{identity,workflow:r.attempt.workflow,workspace:prepared.path});return value}};
const result:TaskResult={attemptId:r.attempt.id,summary:'Explicit native result',evidence:['process fixture'],createdTaskIds:[],outcome:'result'};
if(!broker.getResultProposal(r.attempt.id)){
  await request(config.native+'/tool',{chatId:identity.chatId,input:{operation:'result.submit',payload:result}});
  const until=Date.now()+3000;while(!broker.getResultProposal(r.attempt.id)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
  if(!broker.getResultProposal(r.attempt.id))throw Error('Native result tool not received');
}
await checkpoint('result',{identity,workflow:r.attempt.workflow,workspace:prepared.path});
const report=await reconcileInstallation({store,engine,lifecycle,broker,closeout,workflowStart});
const record=store.getTask(task.spec.id)!;
process.send?.({done:true,report,status:record.status,identity:store.getReservations()[0]!.attempt.native,workflow:store.getReservations()[0]!.attempt.workflow,workspace:prepared.path,leases:store.getAdmissionState().activeLeases.length});
await owner.close();engine.close();store.close();lock.close();process.exit(0);
