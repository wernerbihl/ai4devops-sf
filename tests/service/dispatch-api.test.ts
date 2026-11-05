import assert from 'node:assert/strict';
import test from 'node:test';
import {createFixture} from '../helpers/store.ts';
import {materializeFixture} from '../helpers/fixtures.ts';
import {createScheduler} from '../../src/scheduling/admission.ts';
import {startApi} from '../../src/service/api.ts';
import {fakePorts} from '../helpers/fake-ports.ts';
const origin='http://127.0.0.1:5173';
for(const outcome of ['accepted','noop','unknown'])test(`public dispatch ${outcome} recovers only its original key after reconstruction`,async()=>{
 const module=await import('../../src/service/dispatch-api.ts').catch(()=>undefined);assert.ok(module);
 const f=createFixture();let api:Awaited<ReturnType<typeof startApi>>|undefined;let starts=0;let selected='';
 try{
  const recipe=f.store.snapshot().recipes[0]!;f.store.setRecipeReadiness(recipe.id,recipe.currentRevision,{hash:f.recipe.hash,ready:true,reasons:[]},recipe.revision);
  if(outcome==='noop')f.store.patchSettings({paused:true},f.store.getSettings().revision);
  const scheduler=createScheduler({store:f.store,clock:f.clock,materialize:materializeFixture,readiness:async()=>({ready:true,baseSha:'base',workspacePath:'/fixture',profileId:'profile'}),start:async r=>{
   starts++;selected=r.id;
   assert.equal(f.store.getActionByKey('dispatch:reservation:original')?.payload.reservationId,r.id,'key linkage must precede external start');
   if(outcome==='accepted')f.store.confirmStart(r.id,{workflow:{executionId:'original',namespace:'sf',flowId:'flow',revision:'1'}});
   throw Error('lost external reply');
  }});
  const adapter=module.createDispatchApi(f.store,scheduler);
  api=await startApi({...fakePorts(f.store).deps,scheduler:{async dispatch(trigger,key){await adapter.scheduler.dispatch(trigger,key);throw Error('lost HTTP reply')}},reconcileRequest:adapter.reconcile});
  const call=()=>{const session=api!.sessions.provision(origin);return fetch(api!.url+'/v1/dispatch',{method:'POST',headers:{origin,cookie:session.cookie,'x-sf-csrf':session.csrfToken,'content-type':'application/json','idempotency-key':'original'},body:'{}'})};
  assert.equal((await call()).status,503);await api.close();api=undefined;f.reopen();
  const restored=module.createDispatchApi(f.store,{async dispatch(){throw Error('must not dispatch on replay')}});
  api=await startApi({...fakePorts(f.store).deps,scheduler:restored.scheduler,reconcileRequest:restored.reconcile});
  const replay=await call();assert.equal(replay.status,outcome==='unknown'?503:200);
  if(outcome==='accepted'){const body=await replay.json();assert.equal(body.attemptId,f.store.getReservations().find(r=>r.id===selected)!.attempt.id);assert.equal(body.admitted,true)}
  if(outcome==='noop')assert.deepEqual(await replay.json(),{admitted:false,reason:'paused'});
  assert.equal(starts,outcome==='noop'?0:1);assert.deepEqual(await restored.reconcile({key:'unrelated',method:'POST',path:'/v1/dispatch'}),{state:'pending'});
 }finally{await api?.close();f.close()}
});

test('known scheduler no-op survives loss before the adapter receives its promise result',async()=>{
 const {createDispatchApi}=await import('../../src/service/dispatch-api.ts');
 const f=createFixture();
 try{
  f.store.patchSettings({paused:true},f.store.getSettings().revision);
  const actual=createScheduler({store:f.store,clock:f.clock,materialize:materializeFixture,readiness:async()=>{throw Error('paused dispatch must not prepare')},start:async()=>{throw Error('paused dispatch must not start')}});
  const adapter=createDispatchApi(f.store,{async dispatch(trigger,key){await actual.dispatch(trigger,key);throw Error('controller stopped before adapter received result')}});
  await assert.rejects(adapter.scheduler.dispatch('manual','known-noop'));
  f.reopen();f.store.patchSettings({paused:false},f.store.getSettings().revision);
  const restored=createDispatchApi(f.store,{async dispatch(){throw Error('never redispatch')}});
  assert.deepEqual(await restored.reconcile({key:'known-noop',method:'POST',path:'/v1/dispatch'}),{state:'complete',body:{admitted:false,reason:'paused'}});
 }finally{f.close()}
});

test('known not-started outcome is atomic with reservation release before controller loss',async()=>{
 const {createDispatchApi}=await import('../../src/service/dispatch-api.ts');const f=createFixture();
 try{
  const recipe=f.store.snapshot().recipes[0]!;f.store.setRecipeReadiness(recipe.id,recipe.currentRevision,{hash:f.recipe.hash,ready:true,reasons:[]},recipe.revision);
  const release=f.store.releaseUnstarted.bind(f.store);
  f.store.releaseUnstarted=(...args)=>{release(...args);throw Error('controller lost immediately after release commit')};
  const scheduler=createScheduler({store:f.store,clock:f.clock,materialize:materializeFixture,readiness:async()=>({ready:true,baseSha:'base',workspacePath:'/fixture',profileId:'profile'}),start:async()=>({kind:'not_started',code:'owner_rejected',recovery:'Restore owner'})});
  await assert.rejects(createDispatchApi(f.store,scheduler).scheduler.dispatch('manual','not-started'));
  assert.equal(f.store.getReservations()[0]!.status,'released');f.reopen();
  const restored=createDispatchApi(f.store,{async dispatch(){throw Error('never redispatch')}});
  assert.deepEqual(await restored.reconcile({key:'not-started',method:'POST',path:'/v1/dispatch'}),{state:'complete',body:{admitted:false,reason:'owner_rejected'}});
 }finally{f.close()}
});

test('unknown original dispatch stays pending after a different key starts another repository',async()=>{
 const {createDispatchApi}=await import('../../src/service/dispatch-api.ts');const f=createFixture();
 try{
  const recipe=f.store.snapshot().recipes[0]!;f.store.setRecipeReadiness(recipe.id,recipe.currentRevision,{hash:f.recipe.hash,ready:true,reasons:[]},recipe.revision);
  const settings=f.store.getSettings();f.store.patchSettings({limits:{...settings.config.limits,concurrency:2}},settings.revision);
  let starts=0;
  const adapter=createDispatchApi(f.store,createScheduler({store:f.store,clock:f.clock,materialize:materializeFixture,readiness:async()=>({ready:true,baseSha:'base',workspacePath:'/fixture',profileId:'profile'}),start:async()=>{starts++;return starts===1?{kind:'unknown',code:'unknown',recovery:'Inspect original'}:{kind:'started',identity:{workflow:{executionId:'unrelated',namespace:'sf',flowId:'flow',revision:'1'}}}}}));
  await assert.rejects(adapter.scheduler.dispatch('manual','original'));
  f.store.createManualTasks({...f.request,repositoryIds:['repo-2']},'unrelated-task');
  assert.equal((await adapter.scheduler.dispatch('manual','unrelated')).kind,'started');
  f.reopen();const restored=createDispatchApi(f.store,{async dispatch(){throw Error('no replay')}});
  assert.deepEqual(await restored.reconcile({key:'original',method:'POST',path:'/v1/dispatch'}),{state:'pending'});
  assert.equal((await restored.reconcile({key:'unrelated',method:'POST',path:'/v1/dispatch'})).state,'complete');
  assert.equal(starts,2);
 }finally{f.close()}
});

test('reconstructed dispatch reads its exact completed continuation without another send',async()=>{
 const {fakeRuntime}=await import('../helpers/fake-ports.ts');
 const {createDispatchApi}=await import('../../src/service/dispatch-api.ts');
 const x=fakeRuntime();const {fixture:f}=x;
 try{
  await x.scheduler.dispatch('manual');const attempt=f.store.snapshot().attempts[0]!;
  await x.lifecycle.applyOwnerEvent(attempt.id,{type:'input',identity:x.native,at:f.clock.wallNow().toISOString(),input:{id:'question',prompt:'Continue?',schema:{type:'object'}}});
  const input=f.store.snapshot().attention.find(a=>a.nativeInputId==='question')!;
  f.store.patchSettings({paused:true},f.store.getSettings().revision);
  await x.lifecycle.resumeInput(input.id,{},'answer');
  f.store.patchSettings({paused:false},f.store.getSettings().revision);
  const scheduler=createScheduler({store:f.store,clock:f.clock,materialize:materializeFixture,continuations:async dispatchKey=>{await x.lifecycle.dispatchPending(dispatchKey);throw Error('controller lost after original continuation completed')},readiness:async()=>{throw Error('no new allocation')},start:async()=>{throw Error('no new start')}});
  await assert.rejects(createDispatchApi(f.store,scheduler).scheduler.dispatch('manual','continue-original'));
  assert.equal(x.sent.length,1);f.reopen();
  const restored=createDispatchApi(f.store,{async dispatch(){throw Error('never replay continuation')}});
  const snapshot=f.store.snapshot();
  assert.deepEqual(await restored.reconcile({key:'continue-original',method:'POST',path:'/v1/dispatch'}),{state:'complete',body:{admitted:true,attemptId:attempt.id,taskId:attempt.taskId}});
  assert.equal(x.sent.length,1);assert.deepEqual(f.store.snapshot(),snapshot,'reconciliation is read-only');
 }finally{f.close()}
});

test('rejected continuation selection cannot claim a later separately admitted completion',async()=>{
 const {fakeRuntime}=await import('../helpers/fake-ports.ts');const {createDispatchApi}=await import('../../src/service/dispatch-api.ts');
 const x=fakeRuntime();const {fixture:f}=x;
 try{
  await x.scheduler.dispatch('manual');const attempt=f.store.snapshot().attempts[0]!;
  await x.lifecycle.applyOwnerEvent(attempt.id,{type:'input',identity:x.native,at:f.clock.wallNow().toISOString(),input:{id:'question',prompt:'Continue?',schema:{type:'object'}}});
  const input=f.store.snapshot().attention.find(a=>a.nativeInputId==='question')!;
  f.store.patchSettings({paused:true},f.store.getSettings().revision);await x.lifecycle.resumeInput(input.id,{},'answer');
  const scheduler=createScheduler({store:f.store,clock:f.clock,materialize:materializeFixture,continuations:async dispatchKey=>{
   assert.equal(await x.lifecycle.dispatchPending(dispatchKey),null);throw Error('controller lost after rejected candidate, before next outcome');
  },readiness:async()=>{throw Error('no allocation')},start:async()=>{throw Error('no start')}});
  await assert.rejects(createDispatchApi(f.store,scheduler).scheduler.dispatch('manual','rejected-original'));
  f.store.patchSettings({paused:false},f.store.getSettings().revision);assert.equal((await x.lifecycle.dispatchPending())?.kind,'started');assert.equal(x.sent.length,1);
  f.reopen();const restored=createDispatchApi(f.store,{async dispatch(){throw Error('no replay')}});
  assert.deepEqual(await restored.reconcile({key:'rejected-original',method:'POST',path:'/v1/dispatch'}),{state:'pending'},'later admission belongs only to its actual invocation');
 }finally{f.close()}
});
