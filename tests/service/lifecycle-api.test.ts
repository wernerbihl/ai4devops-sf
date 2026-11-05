import assert from 'node:assert/strict';
import test from 'node:test';
import { fakeRuntime } from '../helpers/fake-ports.ts';
import { startApi } from '../../src/service/api.ts';

for (const operation of ['takeover','return-control','open-native','input']) test(`lost ${operation} HTTP reply recovers original keyed receipt after reconstruction without another effect`,async()=>{
 const module=await import('../../src/service/lifecycle-api.ts').catch(()=>undefined);assert.ok(module,'durable lifecycle API adapter required');
 const x=fakeRuntime();let api:Awaited<ReturnType<typeof startApi>>|undefined;
 try {
  await x.scheduler.dispatch('manual');const taskId=x.fixture.task.id;let path=`/v1/tasks/${taskId}/${operation}`;let body:unknown={};
  if(operation==='return-control'||operation==='open-native')await x.lifecycle.requestTakeover(taskId);
  if(operation==='return-control')path='/v1/repositories/repo-1/return-control';
  if(operation==='input'){
   const attempt=x.fixture.store.snapshot().attempts[0]!;
   await x.lifecycle.applyOwnerEvent(attempt.id,{type:'input',identity:x.native,at:x.fixture.clock.wallNow().toISOString(),input:{id:'original-question',prompt:'Name?',schema:{type:'object',properties:{name:{type:'string'}},required:['name']}}});
   const request=x.fixture.store.snapshot().attention.find(a=>a.nativeInputId==='original-question')!;path=`/v1/attention/${request.id}/respond`;body={input:{name:'answer'}};
  }
  const bridge=module.createLifecycleApi(x.fixture.store,x.lifecycle);
  const version=operation==='return-control'?x.fixture.store.getRepository('repo-1')!.revision:operation==='input'?x.fixture.store.snapshot().attention.find(a=>path.includes(a.id))!.revision:x.fixture.store.getTask(taskId)!.revision;
  const broken=async(fn:()=>Promise<unknown>)=>{await fn();throw Error('Lost HTTP completion before API journal finish')};
  api=await startApi({...x.deps,lifecycle:{requestTakeover:(id,key)=>broken(()=>bridge.lifecycle.requestTakeover(id,key)).then(()=>{}),returnControl:(id,key)=>broken(()=>bridge.lifecycle.returnControl(id,key)).then(()=>{}),resumeInput:(id,value,key)=>broken(()=>bridge.lifecycle.resumeInput(id,value,key)).then(()=>{})},owner:{open:(id,context)=>broken(()=>bridge.owner.open(id,context)) as Promise<{}>},reconcileRequest:bridge.reconcile});
  const call=async()=>{const session=api!.sessions.provision('http://127.0.0.1:5173');return fetch(api!.url+path,{method:'POST',headers:{origin:'http://127.0.0.1:5173',cookie:session.cookie,'x-sf-csrf':session.csrfToken,'content-type':'application/json','idempotency-key':'original-key','if-match':String(version)},body:JSON.stringify(body)})};
  assert.equal((await call()).status,503);const opened=x.opened.length;const sent=x.sent.length;const state=x.fixture.store.snapshot();await api.close();api=undefined;
  x.fixture.reopen();const restored=module.createLifecycleApi(x.fixture.store,x.lifecycle);
  api=await startApi({...x.deps,store:x.fixture.store,lifecycle:restored.lifecycle,owner:restored.owner,reconcileRequest:restored.reconcile});
  const replay=await call();assert.equal(replay.status,200);assert.equal(x.opened.length,opened);assert.equal(x.sent.length,sent);assert.deepEqual(x.fixture.store.snapshot().tasks,state.tasks);
  assert.deepEqual(await restored.reconcile({key:'original-key',method:'POST',path:'/v1/tasks/other/open-native'}),{state:'pending'});
 }finally{await api?.close();x.fixture.close()}
});

test('unknown navigation receipt cannot repeat OS open during replay or controller reconnect',async()=>{
 const module=await import('../../src/service/lifecycle-api.ts').catch(()=>undefined);assert.ok(module);
 const x=fakeRuntime();try{
  await x.scheduler.dispatch('manual');await x.lifecycle.requestTakeover(x.fixture.task.id);
  let opens=0;const original=x.lifecycle.openNative;
  x.lifecycle.openNative=async(identity,key)=>{opens++;await original(identity,key);throw Error('lost navigation result')};
  const bridge=module.createLifecycleApi(x.fixture.store,x.lifecycle);
  await assert.rejects(bridge.owner.open(x.native,{key:'unknown'}));
  assert.deepEqual(await bridge.reconcile({key:'unknown',method:'POST',path:`/v1/tasks/${x.fixture.task.id}/open-native`}),{state:'pending'});
  await assert.rejects(bridge.owner.open(x.native,{key:'unknown'}),{code:'effect_unresolved'});assert.equal(opens,1);
 }finally{x.fixture.close()}
});
