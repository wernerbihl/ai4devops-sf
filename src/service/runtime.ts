import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Installation } from '../kestra/deployment.ts';
import { ensureKestra, ProcessDocker } from '../kestra/deployment.ts';
import { KestraClient } from '../kestra/client.ts';
import { createKestraAuthority } from '../broker/authority.ts';
import { createAttemptBroker } from '../broker/operations.ts';
import { startWorkerBroker } from '../broker/server.ts';
import { startPrivateBrokerBridge, ProcessStreamingDocker } from '../broker/bridge.ts';
import { openStore } from '../storage/store.ts';
import { canonical, ensure, fingerprint, systemClock } from '../storage/database.ts';
import { recipeMaterializer } from '../recipes/materialize.ts';
import { RecipeRegistry, C5RecipePort } from '../recipes/registry.ts';
import { resolveNativeToolReference } from '../owners/toolkits.ts';
import { createScheduler } from '../scheduling/admission.ts';
import { createLifecycle } from '../scheduling/lifecycle.ts';
import type { Lifecycle } from '../scheduling/lifecycle.ts';
import { createGitHubBackend } from '../github/auth.ts';
import { createWorkspaceManager } from '../workspaces/manager.ts';
import { createCloseout } from '../github/closeout.ts';
import { OwnerRegistry } from '../owners/registry.ts';
import { createBbOwner } from '../owners/bb.ts';
import { createOwnerPairing, listenBbOwner, createBbNavigationAuthority } from '../owners/bridge-rpc.ts';
import { startApi } from './api.ts';
import { createCoordinator } from './coordinator.ts';
import { createLifecycleApi } from './lifecycle-api.ts';
import { createDispatchApi } from './dispatch-api.ts';
import { acquireInstallationSingleton } from './singleton.ts';
import { startPrivateControl } from './control.ts';
import { loadRuntimeConfig, readVaultSecret } from './config.ts';
import { createNativeFleet, isolatedProfileId } from './native.ts';
import type { NativeFleet } from './native.ts';
import { reconcileInstallation } from './reconcile.ts';
import type { ReconcileRuntime } from './reconcile.ts';
import type { Health, NativeInput, NativeIdentity, TaskSpec, WorkflowStart } from '../contracts/domain.ts';
import type { Reservation } from '../scheduling/admission-types.ts';
import { hasCapabilityGrants } from '../scheduling/eligibility.ts';
export type { Installation } from '../kestra/deployment.ts';
const promptFor=(start: import('../contracts/domain.ts').NativeStart)=>({text:`Work on this admitted task in the isolated tool workspace /workspaces/task. The native host CWD is pristine; use only sf_read_file, sf_write_file and sf_terminal for repository work. Submit an explicit TaskResult through sf_factory_operation result.submit with attemptId ${start.attemptId}; never treat turn idle as task completion.\n${JSON.stringify({title:start.task.title,goal:start.task.goal,description:start.task.description,acceptanceCriteria:start.task.acceptanceCriteria,context:start.task.context})}`});
export async function startRuntime(installation: Installation) {
  const singleton=acquireInstallationSingleton(installation.root);
  const cleanup:(()=>Promise<void>|void)[]=[()=>singleton.close()];
  try {
    const config=loadRuntimeConfig(installation.root,installation.id);
    const signingKey=readVaultSecret(installation.root,'broker-signing');const controlKey=readVaultSecret(installation.root,'private-control');
    ensure(signingKey.length>=32&&controlKey.length>=32,'runtime_secrets','Persistent protected broker/control keys required');
    const store=openStore(join(installation.root,'factory.sqlite'),{clock:systemClock,materialize:recipeMaterializer});cleanup.push(()=>store.close());
    if(process.platform!=='win32')chmodSync(join(installation.root,'factory.sqlite'),0o600);
    let stopping=false;let engine:KestraClient|undefined;let engineReason='Protected workflow engine is unavailable';let fleet!:NativeFleet;let lifecycle!:Lifecycle;
    const requiredEmpty={paths:[],tools:[],credentialRefs:[],networkDestinations:[],allowedFinishPolicies:[]};
    const pendingInputs=new Map<string,{identity:NativeIdentity;input:NativeInput}>();
    const broker=createAttemptBroker({store,clock:systemClock,signingKey,pendingNativeInput:id=>pendingInputs.get(id),
      profiles:{async requireVerifiedProfile(start){const until=Date.now()+20_000;while(store.getLifecycle(start.attemptId).reservation.status==='pending'&&Date.now()<until&&!stopping)await delay(10);ensure(!stopping,'runtime_stopping','Runtime is stopping');return fleet.prepare(start)}},
      native:{async start(start){
          ensure(!stopping,'runtime_stopping','Runtime is stopping');
          const action=store.enqueueAction({key:'runtime:native:'+start.idempotencyKey,kind:'runtime.native',payload:{attemptId:start.attemptId,fence:start.fence}});
          const token=store.beginLifecycleAction(start.attemptId,start.fence,store.getLifecycleEpoch(),action.id);
          try {const member=await fleet.member(start);const identity=await member.owner.ensureSession(start);store.bindLifecycleIdentity(start.attemptId,identity);
            store.assertLifecycleAuthority(start.attemptId,start.fence);ensure(!stopping&&!store.getLifecycle(start.attemptId).state.stopRequested,'native_interrupted','Native start was interrupted');
            await member.owner.send(identity,promptFor(start),start.idempotencyKey+':prompt');store.settleLifecycleEffect(start.attemptId,start.fence,token,'accepted');store.completeAction(action.id);return identity;
          } catch(error){store.settleLifecycleEffect(start.attemptId,start.fence,token,'unknown');throw error}
        },
        async continue(attemptId,input,key){const request=store.snapshot().attention.find(a=>a.attemptId===attemptId&&a.status==='open'&&a.nativeInputId===input.requestId);ensure(request,'native_input','Only original pending native input may continue through the broker');await lifecycle.resumeInput(request.id,input.response,key)},
        async reconcile(write,start){const recovered=await fleet.reconcile(start);if(recovered.state!=='done')return recovered;const member=await fleet.member(start);const request=write.payload as import('../contracts/domain.ts').WorkerRequest;const input=request.operation==='native.start'?promptFor(start):request.operation==='native.continue'?request.payload.input:{};const key=request.operation==='native.start'?start.idempotencyKey+':prompt':start.idempotencyKey;return await member.owner.reconcileInput(recovered.identity,input,key)==='done'?recovered:{state:'unknown'}}}});
    const protectedPaths=[join(installation.root,'factory.sqlite'),join(installation.root,'vault'),join(installation.root,'auth'),join(installation.root,'repositories'),join(installation.root,'workspace-manifests'),join(installation.root,'disabled-hooks'),join(installation.root,'.workspace-manager.lock'),join(installation.root,'runtime.json'),join(installation.root,'controller-lock.sqlite'),join(installation.root,'kestra'),join(installation.root,'bb'),'/var/run/docker.sock',...['.ssh','.aws','.azure','.config/gh','.config/gcloud','.codex','.gitconfig','.npmrc'].map(name=>join(homedir(),name))];
    fleet=createNativeFleet({installation,config,store,broker,protectedPaths});cleanup.push(()=>fleet.close());
    const bbDirectory=join(installation.root,'bb');const pairingPath=join(bbDirectory,'bb-owner-pairing.json');
    if(!existsSync(pairingPath))await createOwnerPairing(bbDirectory,installation.id,'bb');
    const bbChannel=await listenBbOwner({pairingPath,authority:createBbNavigationAuthority(store)});cleanup.push(()=>bbChannel.close());
    const bb=createBbOwner({...bbChannel,readiness:async()=>({ownerId:'bb',ready:false,reasons:['BB SDK 0.6.104 Send-now bypasses mandatory dispatch admission; execution unsupported before allocation. Use the verified VS Code owner.'],supportedProviders:['copilot','codex'],verifiedProfileIds:[],providers:['copilot','codex'].map(providerId=>({providerId:providerId as 'copilot'|'codex',ready:false,reasons:['No non-bypass dispatch enforcement'],verifiedProfileIds:[]})),version:'0.6.104'})});
    const owners=new OwnerRegistry([['vscode',fleet.owner],['bb',bb]]);
    const preparingTasks=new Map<string,TaskSpec>();
    const backend=createGitHubBackend({storageDirectory:join(installation.root,'auth'),repositories:config.repositories,...(config.selectedIdentity?{selectedIdentity:config.selectedIdentity}:{}),
      async authorizeOperation(repositoryId,operation,key){
        if(!config.repositories.some(r=>r.id===repositoryId&&r.operations.includes(operation)))return false;
        const state=store.getAdmissionState();
        const candidates=[...preparingTasks.values(),...state.tasks.map(t=>t.spec)].filter(t=>t.repositoryId===repositoryId);
        const target=key?.startsWith('workspace-')?candidates.find(t=>key.endsWith(':'+createHash('sha256').update(t.id).digest('hex'))):undefined;
        const current=(task:TaskSpec)=>!state.settings.paused&&state.repositories.some(r=>r.id===repositoryId&&r.controlMode==='factory'&&(task.source==='manual'||r.active))
          &&state.recipes.some(r=>r.id===task.recipeId&&r.active)&&state.recipeReadiness.some(r=>r.recipeId===task.recipeId&&r.recipeRevision===task.recipeRevision&&r.ready)
          &&hasCapabilityGrants(task,state.grants,systemClock);
        if(operation==='read'&&target)return current(target);
        const task=state.tasks.find(t=>t.spec.repositoryId===repositoryId&&t.attemptIds.some(id=>{const r=store.getLifecycle(id);return r.reservation.lease.active||r.state.closeout?.phase==='monitoring'}));
        // Closed read-only API adapter paths can reconcile issued closeout facts after revocation.
        if(operation==='read')return !!task&&(current(task.spec)||task.attemptIds.some(id=>!!store.getActionByKey('closeout:'+id+':metadata')));
        if(!task||!current(task.spec))return false;
        return operation==='contents_write'?task.spec.finishPolicy!=='result':operation==='pull_requests_write'?task.spec.finishPolicy!=='result':task.spec.finishPolicy==='merge_ci'||task.spec.finishPolicy==='merge_bypass';
      }});
    const workspace=createWorkspaceManager({factoryRoot:installation.root,gitAuth:backend.git,resolveRepository:async id=>{const repo=store.getRepository(id);const allowed=config.repositories.find(r=>r.id===id);return repo&&allowed?{id,url:repo.url,baseRef:allowed.baseRef}:undefined},
      metadataBoundary:{async assertProtected(){for(const r of store.getReservations().filter(r=>r.lease.active&&r.attempt.native)){const member=await fleet.member(fleet.startFor(r.attempt));const c=await installation.docker.command(['container','inspect',member.worker.config.containerId]);const actual=JSON.parse(c)[0];ensure(actual.Mounts.every((m:any)=>!protectedPaths.some(p=>m.Source===p||p.startsWith(m.Source+'/')||m.Source.startsWith(p+'/'))),'metadata_exposed','Worker mount intersects protected factory metadata')}}}});
    const prepared=(attempt:import('../contracts/domain.ts').Attempt)=>({ready:true as const,baseSha:attempt.baseSha,workspacePath:attempt.workspacePath,profileId:attempt.profileId});
    const retainedWorkspace=async(attempt:import('../contracts/domain.ts').Attempt)=>workspace.withTrustedMetadata(async scope=>{const current=await scope.readWorkspace(store.getTask(attempt.taskId)!.spec.repositoryId,attempt.taskId);return current.path===attempt.workspacePath&&current.baseSha===attempt.baseSha&&(await scope.revalidateWorkspace(current,attempt.baseSha)).kind==='ready'});
    lifecycle=createLifecycle({store,clock:systemClock,owner:identity=>owners.get(identity.ownerId),readiness:async(_task,attempt)=>{const member=await fleet.member(fleet.startFor(attempt));await member.verify.requireVerifiedProfile(member.gate.currentStart());return prepared(attempt)},workspace:retainedWorkspace,
      managedContinuation:{async preflight(attempt){if(!attempt.native)return;const m=await fleet.member(fleet.startFor(attempt));return await m.owner.stoppedReceipt(attempt.native)?prepared(attempt):undefined},
        async prepare(attempt,key){const start=fleet.startFor(attempt);const m=await fleet.member(start);await m.launcher.resume(start,m.gate);m.gate.prepare(start,key);await m.worker.resume(start,key);await m.boundary.prepare(start,key,m.authenticate);await m.verify.requireVerifiedProfile(start)}},
      managedHumanOpen:{async prepare(attempt,_key,context){const m=await fleet.member(context.start);context.assertCurrent();m.gate.suspend();m.worker.admitHuman(context.start,attempt.native!,context.assertCurrent,false);if(await m.owner.stoppedReceipt(attempt.native!)){await m.launcher.resumeHuman(context.start,context.assertCurrent);await m.worker.resume(context.start,'human:'+_key);await m.owner.ensureStarted();await m.boundary.prepareHuman(context.start,m.authenticate,context.assertCurrent)}else{await m.boundary.prepareHuman(context.start,m.authenticate,context.assertCurrent,false)}context.assertCurrent();m.worker.enableHuman();m.owner.admitHumanOpen(attempt.native!,context.assertCurrent)}},
      workflow:{async snapshot(attempt){if(!engine||!attempt.workflow)return'unknown';return(await engine.snapshot(attempt.workflow)).state==='unknown'?'unknown':'present'},async quiesce(attempt){return engine&&attempt.workflow?engine.quiescence(attempt.workflow):'unknown'},async resume(attempt,key){ensure(engine&&attempt.workflow,'workflow_missing','Original workflow is unavailable');await engine.rebindContinuation(attempt.workflow,key)}}});
    const closeout=createCloseout({store,clock:systemClock,lifecycle,workspace,github:backend.github,git:backend.git});
    const unsubscribe=fleet.owner.subscribe(event=>{const matches=store.getReservations().filter(r=>canonical(r.attempt.native)===canonical(event.identity)&&store.getTask(r.attempt.taskId)?.attemptIds.at(-1)===r.attempt.id);for(const r of matches){if(event.type==='input')pendingInputs.set(r.attempt.id,{identity:event.identity,input:event.input});else if(event.type==='snapshot'){const input=event.snapshot.inputs[0];if(input)pendingInputs.set(r.attempt.id,{identity:event.identity,input});else pendingInputs.delete(r.attempt.id)}if(store.broker.write(r.attempt.id,r.lease.fence)?.state==='done'||!store.broker.write(r.attempt.id,r.lease.fence))void lifecycle.applyOwnerEvent(r.attempt.id,event).catch(()=>{})}});cleanup.push(unsubscribe);
    let templateReasons=['Runtime provisionability has not been verified'];
    const recipeReady=new Map<string,string[]>();
    const registry=new RecipeRegistry(store,{resolveReference:resolveNativeToolReference,executionReadiness:metadata=>recipeReady.get(fingerprint(metadata))??[...templateReasons,...(Object.keys(metadata.skillVersions??{}).length||Object.entries(metadata.toolVersions??{}).some(([id,version])=>!['native-files','native-terminal'].includes(id)||version!=='2')||metadata.required.networkDestinations.length||metadata.required.credentialRefs.length?['Only isolated v2 file/terminal toolkits without external network/credentials/skills are provisionable']:[])],now:()=>systemClock.wallNow()});
    async function refreshReadiness(){
      templateReasons=engine?await fleet.templateReadiness():[engineReason];
      for(const summary of store.snapshot().recipes){const recipe=store.getRecipe(summary.id)!;let reasons=['Assign an allowed repository'];const repository=store.getRepository(recipe.repositoryIds[0]??'');
        if(repository){try{const task=recipeMaterializer({id:'provisionability-only',repository,recipe,request:{recipeId:recipe.recipeId,repositoryIds:[repository.id],title:recipe.name,description:recipe.description},defaults:{ownerId:'vscode',providerId:'copilot',finishPolicy:recipe.contract.variables.sf.defaultFinishPolicy},source:'manual'});reasons=engine?await fleet.provisionability(task):[engineReason]}catch{reasons=['Recipe default materialization is unavailable']}}
        recipeReady.set(fingerprint(recipe.contract.variables.sf),reasons);registry.refreshReadiness(recipe.recipeId,recipe.revision,'runtime:readiness:'+fingerprint({recipe:recipe.revision,reasons,at:Date.now()}));
      }
    }
    const workflowStart=(r:Reservation):WorkflowStart=>({idempotencyKey:`runtime:start:${r.id}`,attemptId:r.attempt.id,recipe:store.getRecipeRevision(r.task.spec.recipeId,r.task.spec.recipeRevision)!,inputs:{},scopeId:r.id,fence:r.lease.fence});
    const scheduler=createScheduler({store,clock:systemClock,materialize:recipeMaterializer,continuations:dispatchKey=>lifecycle.dispatchPending(dispatchKey),
      async readiness(task){if(stopping||!engine)return{ready:false,code:'engine_unavailable',recovery:engineReason};const reasons=await fleet.provisionability(task);if(reasons.length)return{ready:false,code:'native_unavailable',recovery:reasons.join('; ')};preparingTasks.set(task.id,task);try{const value=await workspace.prepareWorkspace(task);return{ready:true,baseSha:value.baseSha,workspacePath:value.path,profileId:isolatedProfileId}}finally{preparingTasks.delete(task.id)}},
      async start(reservation){ensure(engine&&!stopping,'runtime_stopping','Engine unavailable');const action=store.enqueueAction({key:`runtime:start:${reservation.id}`,kind:'runtime.start',payload:{reservationId:reservation.id}});const workflow=await engine.ensureExecution(workflowStart(reservation));store.confirmStart(reservation.id,{workflow});store.completeAction(action.id);return{kind:'started',identity:{workflow}}}});

    async function recoverNativeWrites(){
      for(const r of store.getReservations().filter(r=>r.lease.active)){
        const write=store.broker.write(r.attempt.id,r.lease.fence);if(!write||write.state==='done')continue;
        try {
          const request=write.payload as import('../contracts/domain.ts').WorkerRequest;
          if(request.operation!=='native.start'&&request.operation!=='native.continue')continue;
          const start=request.operation==='native.start'?request.payload:{...fleet.startFor(r.attempt),idempotencyKey:request.idempotencyKey};
          const recovered=await fleet.reconcile(start);if(recovered.state!=='done')continue;
          if(r.attempt.native&&canonical(r.attempt.native)!==canonical(recovered.identity))continue;
          const member=await fleet.member(start);const input=request.operation==='native.start'?promptFor(start):request.payload.input;
          if(await member.owner.reconcileInput(recovered.identity,input,request.operation==='native.start'?request.idempotencyKey+':prompt':request.idempotencyKey)!=='done')continue;
          const current=store.getLifecycle(r.attempt.id);if(!current.reservation.lease.active||current.reservation.lease.fence!==write.fence)continue;
          if(!current.reservation.attempt.native)store.bindLifecycleIdentity(r.attempt.id,recovered.identity);
          store.broker.settle(r.attempt.id,write.fence,write.key,{requestId:request.requestId,ok:true,result:request.operation==='native.start'?recovered.identity:null});
          const effect=current.state.effect;const action=store.getActionByKey('runtime:native:'+request.idempotencyKey);
          if(effect&&action&&effect.actionId===action.id){store.settleLifecycleEffect(r.attempt.id,write.fence,effect.token,'accepted');store.completeAction(action.id)}
        }catch{ /* Unknown original effects retain the writer fence. */ }
      }
    }
    const services:ReconcileRuntime={store,lifecycle,closeout,broker,workflowStart,recoverNativeWrites};
    let recovering = true;
    let lastReport = { confirmed: [] as string[], completed: [] as string[], retained: [] as string[] };
    const health=async():Promise<Health>=>({schemaVersion:1,ready:!stopping&&!recovering&&!!engine&&config.native.length>0&&store.snapshot().recipes.some(r=>r.ready),reasons:[...(stopping?['Runtime is stopping']:[]),...(recovering?['Initial recovery is pending']:[]),...(engineReason?[engineReason]:[]),...(!config.native.length?['No pinned isolated native/worker/proxy template is provisioned']:[]),...(!store.snapshot().recipes.some(r=>r.ready)?['No approved provisionable recipe is ready']:[])],version:'0.1.0'});
    let priorLeases=store.getAdmissionState().activeLeases.length;
    const unboundStops = new Map<string, Promise<void>>();
    const coordinator=createCoordinator({
      taktMs:()=>store.getSettings().config.taktSeconds*1000, controlMs:250,
      dispatch:trigger=>scheduler.dispatch(trigger),
      async control() {
        lifecycle.observeBudgets();
        // Construction/physical stop of a native set without a bound identity may itself hang.
        // Each attempt owns its job; neither it nor another attempt owns accounting observation.
        for (const r of store.getReservations().filter(r=>r.lease.active&&!r.attempt.native&&store.getLifecycle(r.attempt.id).state.stopRequested)) {
          if (unboundStops.has(r.attempt.id)) continue;
          const job=(async()=>{
            try {
              const m=await fleet.member(fleet.startFor(r.attempt));
              const current=store.getLifecycle(r.attempt.id);
              if(!current.reservation.lease.active||current.reservation.lease.fence!==r.lease.fence||!current.state.stopRequested)return;
              m.gate.suspend();
              await Promise.all([m.launcher.stop?.(),m.worker.pause()]);
            } catch { /* Unknown writers retain their stop intent and fence. */ }
          })().finally(()=>{unboundStops.delete(r.attempt.id)});
          unboundStops.set(r.attempt.id,job);
        }
      },
      async reconcile() {
        if(recovering)return;
        for(const r of store.getReservations().filter(r=>r.lease.active&&r.attempt.native&&store.broker.write(r.attempt.id,r.lease.fence)?.state==='done')) {
          try {await owners.get(r.attempt.native!.ownerId).snapshot(r.attempt.native!)} catch {}
        }
        lastReport=await reconcileInstallation(services);
        const leases=store.getAdmissionState().activeLeases.length;
        if(leases<priorLeases)void coordinator.dispatch('lease_released');
        priorLeases=leases;
      }
    });
    cleanup.push(()=>coordinator.stop());
    // Retained writers need conservative deadline observation even while initial recovery waits.
    // No dispatch/continuation admission is enabled until that initial recovery completes.
    coordinator.start({admission:false});
    await coordinator.check();
    try {const handle=await ensureKestra(installation);const client=new KestraClient({...handle,authority:createKestraAuthority({broker,store})});engine=client;cleanup.push(()=>client.close());const bridge=await startPrivateBrokerBridge({installation,kestra:handle,broker:await startWorkerBroker({broker}),...(installation.docker instanceof ProcessDocker?{streaming:new ProcessStreamingDocker(installation.docker.executable)}:{})});cleanup.push(()=>bridge.close());engineReason='';} catch {engine=undefined;engineReason='Pinned private Kestra deployment/transport is unavailable; inspect owned installation assets and bind support';}
    if(engine)services.engine=engine;
    await refreshReadiness();
    lastReport=await reconcileInstallation(services);
    recovering=false;
    const lifecycleApi=createLifecycleApi(store,lifecycle);
    const dispatchApi=createDispatchApi(store,scheduler);
    const api=await startApi({store,scheduler:dispatchApi.scheduler,lifecycle:lifecycleApi.lifecycle,session:{allowedOrigins:config.allowedOrigins},auth:backend.authApi,recipes:new C5RecipePort(registry),owner:lifecycleApi.owner,health,secrets:()=>backend.secrets(),reconcileRequest:async request=>{const dispatchResult=await dispatchApi.reconcile(request);if(dispatchResult.state!=='pending')return dispatchResult;const lifecycleResult=await lifecycleApi.reconcile(request);if(lifecycleResult.state!=='pending')return lifecycleResult;const result=registry.reconcile(request);return result.state==='pending'?backend.reconcileRequest(request):result},listen:{host:'127.0.0.1',port:config.apiPort??0}});cleanup.push(()=>api.close());
    const control=await startPrivateControl({root:installation.root,key:controlKey,async handle(method,path,input){
      if(method==='GET'&&path==='/health')return health();
      if(method==='GET'&&path==='/readiness')return{health:await health(),owners:await owners.list(requiredEmpty),reconciliation:lastReport};
      if(method==='POST'&&path==='/pair'){ensure(typeof input.origin==='string','pair_origin','Exact approved UI origin required');return{apiUrl:api.url,...api.sessions.issuePairing(input.origin)}}
      if(method==='POST'&&path==='/next'){await refreshReadiness();return scheduler.dispatch('manual')}
      if(method==='POST'&&path==='/reconcile')return reconcileInstallation(services);
      if(method==='POST'&&path==='/retry'){ensure(typeof input.attemptId==='string','retry_id','Attempt required');return lifecycle.retryTransient(input.attemptId,{transient:true,reason:'Explicit trusted retry'})}
      if(method==='POST'&&path==='/refresh'){const next=loadRuntimeConfig(installation.root,installation.id);ensure(canonical(next.selectedIdentity)===canonical(config.selectedIdentity)&&canonical(next.native)===canonical(config.native)&&canonical(next.allowedOrigins)===canonical(config.allowedOrigins),'runtime_reconfigure','Immutable user/native/origin changes require a new explicit installation');ensure(config.repositories.every(old=>{const replacement=next.repositories.find(r=>r.id===old.id);return !replacement||replacement.owner===old.owner&&replacement.name===old.name}),'repository_identity','Repository identities cannot be repointed');config.repositories.splice(0,config.repositories.length,...next.repositories);config.providerCredentials.splice(0,config.providerCredentials.length,...next.providerCredentials);const catalog=await backend.listRepositories();for(const item of catalog){const existing=store.snapshot().repositories.find(r=>r.id==='github:'+item.githubId||r.url===item.url);if(!existing)store.createRepository({id:config.repositories.find(r=>r.owner===item.owner&&r.name===item.name)?.id??'github:'+item.githubId,name:item.owner+'/'+item.name,url:item.url})}await refreshReadiness();return{repositories:store.snapshot().repositories}}
      throw new Error('Unsupported private command');
    }});cleanup.push(()=>control.close());
    coordinator.enableAdmission();
    return {store,api,controlUrl:control.url,scheduler,lifecycle,broker,owners,health,reconcile:()=>reconcileInstallation(services),async stop(){if(stopping)return;stopping=true;coordinator.stop();unsubscribe();for(const r of store.getReservations().filter(r=>r.lease.active&&r.attempt.native)){try{await owners.get(r.attempt.native!.ownerId).quiesce(r.attempt.native!)}catch{}}for(const close of cleanup.reverse()){try{await close()}catch{}}}};
  } catch(error){for(const close of cleanup.reverse()){try{await close()}catch{}}throw error}
}
export type FactoryRuntime=Awaited<ReturnType<typeof startRuntime>>;
