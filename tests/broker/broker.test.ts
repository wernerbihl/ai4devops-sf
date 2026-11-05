import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from '../helpers/store.ts';
import { materializeFixture } from '../helpers/fixtures.ts';
import { createScheduler } from '../../src/scheduling/admission.ts';
import type { WorkerRequest } from '../../src/contracts/domain.ts';

async function implementation() {
  const module = await import('../../src/broker/operations.ts').catch(() => undefined);
  assert.ok(module?.createAttemptBroker, 'Production attempt broker must enforce current reservation authority');
  return module;
}
async function fixture() {
  const f = createFixture(); const summary = f.store.snapshot().recipes[0]!;
  f.store.setRecipeReadiness(summary.id, summary.currentRevision, { hash: f.recipe.hash, ready: true, reasons: [] }, summary.revision);
  await createScheduler({ store: f.store, clock: f.clock, materialize: materializeFixture,
    readiness: async () => ({ ready: true, baseSha: 'base', workspacePath: '/fixture', profileId: 'fixture' }),
    start: async r => ({ kind: 'started', identity: { workflow: { executionId: r.attempt.id, namespace: 'sf', flowId: 'quality', revision: '1' } } }),
  }).dispatch('manual');
  return { f, reservation: f.store.getReservations()[0]! };
}

test('blocks_stale_or_cross_scope_worker_mutations_and_persists_results_without_closeout', async () => {
  const { createAttemptBroker } = await implementation(); const { f, reservation: r } = await fixture();
  try {
    const deps = { store: f.store, clock: f.clock, signingKey: Buffer.alloc(32, 7) };
    const broker = createAttemptBroker(deps);
    const token = broker.issueAttemptCapability(r.attempt.id, ['grant-1']);
    const scope = broker.authorizeAttempt(token, 'task.create', { repositoryId: 'repo-1' });
    const child = { ...r.task.spec, id: 'untrusted-id', parentId: r.task.spec.id, source: 'recipe' as const, title: 'Child', context: { text: '{{ untouched }}' } };
    const request: WorkerRequest = { requestId: 'r', idempotencyKey: 'child', scope, operation: 'task.create', payload: child };
    const response = await broker.execute(token, request); assert.equal(response.ok, true);
    if (!response.ok || !response.result || !('spec' in response.result)) throw Error('Expected real created task');
    const id = response.result.spec.id;
    assert.notEqual(id, child.id); assert.deepEqual(response.result.spec.context, child.context);
    assert.equal(response.result.spec.tagId, r.task.spec.tagId);
    assert.deepEqual(await broker.execute(token, request), response);
    assert.throws(() => broker.authorizeAttempt(token, 'task.read', { taskId: f.store.createManualTasks(f.request, 'unrelated')[0]!.id }));
    assert.throws(() => broker.authorizeAttempt(token, 'task.create', { repositoryId: 'repo-2' }));
    assert.throws(() => broker.authorizeAttempt(token, 'admin.settings' as never, {}));
    for (const patch of [{ ownerId: 'other' }, { providerId: 'codex' }, { finishPolicy: 'pr' }, { tagId: 'other' }, { required: { ...child.required, tools: ['shell'] } }]) {
      await assert.rejects(broker.execute(token, { ...request, idempotencyKey: JSON.stringify(patch), payload: { ...child, ...patch } } as WorkerRequest));
    }
    await assert.rejects(broker.execute(token, { ...request, scope: { ...scope, fence: scope.fence + 1 } }));
    const result: WorkerRequest = { requestId: 'result', idempotencyKey: 'result', scope, operation: 'result.submit', payload: { attemptId: r.attempt.id, summary: 'Proposal', evidence: [], createdTaskIds: [id], outcome: 'result' } };
    await broker.execute(token, result);
    assert.notEqual(f.store.getTask(r.task.spec.id)!.status, 'completed');
    const resumed = createAttemptBroker({ ...deps, store: f.reopen() });
    assert.deepEqual(resumed.getResultProposal(r.attempt.id), result.payload);
    assert.deepEqual(await resumed.execute(token, request), response);
    f.store.revokeGrant('grant-1');
    assert.throws(() => resumed.authorizeAttempt(token, 'task.read', { taskId: id }));
    await assert.rejects(resumed.execute(token, result));
  } finally { f.close(); }
});

test('expired_capabilities_and_released_leases_never_authorize_replay', async () => {
  const { createAttemptBroker } = await implementation(); const { f, reservation: r } = await fixture();
  try {
    const broker = createAttemptBroker({ store: f.store, clock: f.clock, signingKey: Buffer.alloc(32, 7), ttlMs: 1000 });
    const token = broker.issueAttemptCapability(r.attempt.id, ['grant-1']);
    f.clock.advance(1001); assert.throws(() => broker.authorizeAttempt(token, 'task.read', {}));
  } finally { f.close(); }
});

test('native_writer_claim_survives_unknown_outcome_restart_and_blocks_second_key', async () => {
  const { createAttemptBroker } = await implementation(); const { f, reservation: r } = await fixture(); let calls = 0;
  try {
    const native = { start: async () => { calls++; throw Error('lost acknowledgement'); }, continue: async () => { calls++; }, reconcile: async () => ({ state: 'unknown' as const }) };
    const profiles = { requireVerifiedProfile: async () => ({}) };
    const deps = { store: f.store, clock: f.clock, signingKey: Buffer.alloc(32, 7), native, profiles };
    const broker = createAttemptBroker(deps as any); const token = broker.issueAttemptCapability(r.attempt.id, ['grant-1']);
    const scope = broker.authorizeAttempt(token, 'native.start', {});
    const payload = { idempotencyKey: 'start', attemptId: r.attempt.id, task: r.task.spec, workspacePath: r.attempt.workspacePath, baseSha: r.attempt.baseSha, fence: r.lease.fence, profileId: r.attempt.profileId };
    const request: WorkerRequest = { requestId: 'start', idempotencyKey: 'start', scope, operation: 'native.start', payload };
    await assert.rejects(broker.execute(token, request)); assert.equal(calls, 1);
    const reopened = createAttemptBroker({ ...deps, store: f.reopen() } as any);
    await assert.rejects(reopened.execute(token, request)); assert.equal(calls, 1);
    await assert.rejects(reopened.execute(token, { ...request, idempotencyKey: 'second', payload: { ...payload, idempotencyKey: 'second' } })); assert.equal(calls, 1);
    await assert.rejects(reopened.execute(token, { ...request, payload: { ...payload, workspacePath: '/host' } }));
  } finally { f.close(); }
});

test('private_routes_decode_once_and_reject_admin_route_operation_mismatch_and_raw_json', async () => {
  const server = await import('../../src/broker/server.ts').catch(() => undefined);
  assert.ok(server?.startWorkerBroker, 'Production private routed broker is required');
  const { createAttemptBroker } = await implementation(); const { f, reservation: r } = await fixture();
  const { encodeWorkerRequest, decodeWorkerResponse } = await import('../../src/contracts/worker-transport.ts');
  try {
    const broker = createAttemptBroker({ store: f.store, clock: f.clock, signingKey: Buffer.alloc(32, 7) });
    const api = await server.startWorkerBroker({ broker }); const token = broker.issueAttemptCapability(r.attempt.id, ['grant-1']);
    const scope = broker.authorizeAttempt(token, 'result.submit', {});
    const request: WorkerRequest = { requestId: 'result', idempotencyKey: 'result', scope, operation: 'result.submit', payload: { attemptId: r.attempt.id, summary: '{{ raw < > }}', evidence: [], createdTaskIds: [], outcome: 'result' } };
    const invoke = (path: string, body: string) => api.handle({ method: 'POST', path, authorization: 'Bearer '+ token, body });
    assert.equal((await invoke('/v1/settings', encodeWorkerRequest(request))).status, 404);
    assert.equal((await invoke('/worker/v1/native/start', encodeWorkerRequest(request))).status, 403);
    assert.equal((await invoke('/worker/v1/results', JSON.stringify(request))).status, 400);
    const result = await invoke('/worker/v1/results', encodeWorkerRequest(request)); assert.equal(result.status, 200);
    const decoded = decodeWorkerResponse(result.body); assert.equal(decoded.ok, true);
  } finally { f.close(); }
});

test('engine_authority_reconstructs_pinned_start_and_fresh_result_capabilities', async () => {
  const module = await import('../../src/broker/authority.ts').catch(() => undefined);
  assert.ok(module?.createKestraAuthority, 'E2 needs actual current-store authority');
  const { createAttemptBroker } = await implementation(); const { f, reservation:r } = await fixture();
  try {
    const broker = createAttemptBroker({store:f.store,clock:f.clock,signingKey:Buffer.alloc(32,7)});
    const authority = module.createKestraAuthority({broker,store:f.store});
    const input = {idempotencyKey:'start',attemptId:r.attempt.id,recipe:f.recipe,inputs:{},scopeId:r.id,fence:r.lease.fence};
    const first = await authority.start(input); assert.equal(first.request.operation,'native.start');
    await assert.rejects(authority.start({...input,fence:input.fence+1}));
    await assert.rejects(authority.start({...input,inputs:{sf_capability:'injected'}}));
    const result = {attemptId:r.attempt.id,summary:'Result',evidence:[],createdTaskIds:[],outcome:'result' as const};
    const last = await authority.result(r.attempt.workflow!,result,'final'); assert.notEqual(first.capability,last.capability);
    assert.throws(()=>broker.authorizeAttempt(first.capability,'result.submit',{}));
    assert.throws(()=>broker.authorizeAttempt(last.capability,'native.start',{}));
  } finally { f.close(); }
});

test('fence_advance_release_tamper_and_async_profile_revocation_block_native_dispatch', async () => {
  const { createAttemptBroker } = await implementation(); const { f, reservation:r } = await fixture(); let calls = 0;
  try {
    const broker = createAttemptBroker({store:f.store,clock:f.clock,signingKey:Buffer.alloc(32,7),native:{start:async()=>{calls++;return {ownerId:'vscode',providerId:'copilot',sessionId:'native'};},continue:async()=>{},reconcile:async()=>({state:'unknown'})},profiles:{requireVerifiedProfile:async()=>{f.store.revokeGrant('grant-1');return {} as any;}}});
    const token = broker.issueAttemptCapability(r.attempt.id,['grant-1']); const scope = broker.authorizeAttempt(token,'native.start',{});
    assert.throws(()=>broker.authorizeAttempt(token.slice(0,10)+(token[10]==='A'?'B':'A')+token.slice(11),'task.read',{}));
    await assert.rejects(broker.execute(token,{requestId:'start',idempotencyKey:'start',scope,operation:'native.start',payload:broker.nativeStart(r.attempt.id,'start')}));
    assert.equal(calls,0); assert.equal(f.store.broker.write(r.attempt.id,r.lease.fence),undefined);
  } finally { f.close(); }
  const second = await fixture();
  try {
    const { f, reservation:r } = second; const broker = createAttemptBroker({store:f.store,clock:f.clock,signingKey:Buffer.alloc(32,7)});
    const old = broker.issueAttemptCapability(r.attempt.id,['grant-1']);
    f.store.bindLifecycleIdentity(r.attempt.id,{ownerId:'vscode',providerId:'copilot',sessionId:'native'});
    f.store.updateLifecycle(r.attempt.id,r.lease.fence,{release:'waiting',status:'waiting_input',state:{segments:[],quiescent:true}});
    assert.throws(()=>broker.authorizeAttempt(old,'task.read',{}));
    const action = f.store.enqueueAction({key:'resume',kind:'lifecycle.send',payload:{attemptId:r.attempt.id}});
    const current = f.store.acquireLifecycle(r.attempt.id,f.store.getAdmissionState().token,false,action.id);
    assert.equal(current.lease.fence,r.lease.fence+1);
    assert.throws(()=>broker.authorizeAttempt(old,'task.read',{}));
    const fresh = broker.issueAttemptCapability(r.attempt.id,['grant-1']); assert.equal(broker.authorizeAttempt(fresh,'task.read',{}).fence,current.lease.fence);
  } finally { second.f.close(); }
});

test('attention_metadata_is_server_owned_and_workflow_sourced', async () => {
  const { createAttemptBroker } = await implementation();const {f,reservation:r}=await fixture();
  try {
    const broker=createAttemptBroker({store:f.store,clock:f.clock,signingKey:Buffer.alloc(32,7)});const token=broker.issueAttemptCapability(r.attempt.id,['grant-1']);const scope=broker.authorizeAttempt(token,'attention.create',{});
    const reply=await broker.execute(token,{requestId:'attention',idempotencyKey:'attention',scope,operation:'attention.create',payload:{id:'forged',taskId:r.task.spec.id,attemptId:r.attempt.id,repositoryId:r.task.spec.repositoryId,source:'workflow',kind:'blocked',prompt:'Need input',recovery:'Review prompt',inputSchema:{},status:'open',createdAt:'2000-01-01T00:00:00Z',revision:999}});
    assert.equal(reply.ok,true);const saved=f.store.snapshot().attention[0]!;assert.notEqual(saved.id,'forged');assert.equal(saved.source,'workflow');assert.equal(saved.revision,1);assert.equal(saved.createdAt,f.clock.wallNow().toISOString());
  } finally{f.close();}
});

test('input_attention_requires_real_pending_owner_correlation', async()=>{
  const {createAttemptBroker}=await implementation();const {f,reservation:r}=await fixture();
  try{
    const identity={ownerId:'vscode',providerId:'copilot' as const,sessionId:'native'};f.store.bindLifecycleIdentity(r.attempt.id,identity);
    const deps={store:f.store,clock:f.clock,signingKey:Buffer.alloc(32,7)};const broker=createAttemptBroker(deps);const token=broker.issueAttemptCapability(r.attempt.id,['grant-1']);const scope=broker.authorizeAttempt(token,'attention.create',{});
    const request:WorkerRequest={requestId:'input',idempotencyKey:'input',scope,operation:'attention.create',payload:{id:'forged',taskId:r.task.spec.id,attemptId:r.attempt.id,repositoryId:r.task.spec.repositoryId,source:'workflow',kind:'input',prompt:'Untrusted prompt',recovery:'Review',inputSchema:{forged:true},status:'open',createdAt:'2000-01-01T00:00:00Z',revision:1}};
    await assert.rejects(broker.execute(token,request),{code:'attention_input_unsupported'});assert.equal(f.store.snapshot().attention.length,0);
    const trusted=createAttemptBroker({...deps,pendingNativeInput:()=>({identity,input:{id:'native-input',prompt:'Actual question',schema:{type:'string'}}})});
    await trusted.execute(token,request);const saved=f.store.snapshot().attention[0]!;assert.equal(saved.nativeInputId,'native-input');assert.deepEqual(saved.inputSchema,{type:'string'});assert.equal(saved.prompt,'Actual question');
    assert.ok(f.store.queueLifecycleReply(saved.id,'answer','answer-key').id);
  }finally{f.close();}
});
