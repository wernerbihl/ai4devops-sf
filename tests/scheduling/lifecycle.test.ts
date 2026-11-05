import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Clock, NativeIdentity, NativeSnapshot, OwnerEvent } from '../../src/contracts/domain.ts';
import type { NativeOwner } from '../../src/contracts/owner.ts';
import { createScheduler } from '../../src/scheduling/admission.ts';
import { createLifecycle } from '../../src/scheduling/lifecycle.ts';
import type { LifecycleDeps } from '../../src/scheduling/lifecycle.ts';
import { materializeFixture } from '../helpers/fixtures.ts';
import { createFixture } from '../helpers/store.ts';

class Time implements Clock {
  wall = Date.parse('2026-11-04T10:00:00Z'); elapsed = 0;
  wallNow() { return new Date(this.wall); }
  monotonicMs() { return this.elapsed; }
  localDayKey(at: Date) { return at.toISOString().slice(0, 10); }
  advance(ms: number) { this.elapsed += ms; this.wall += ms; }
}
async function fixture(deferIdentity = false) {
  const clock = new Time(); const f = createFixture({ clock });
  const summary = f.store.snapshot().recipes[0]!;
  f.store.setRecipeReadiness(summary.id, summary.currentRevision, { hash: f.recipe.hash, ready: true, reasons: [] }, summary.revision);
  const native: NativeIdentity = { ownerId: 'vscode', providerId: 'copilot', sessionId: 'original-session', chatId: 'original-chat' };
  let state: NativeSnapshot['state'] = 'active'; let quiescence: 'stopped' | 'waiting' | 'unknown' = 'waiting';
  let workflowQuiet: 'stopped' | 'waiting' | 'unknown' = 'waiting'; let available = true;
  const sent: { identity: NativeIdentity; input: object; key: string }[] = []; const opened: NativeIdentity[] = [];
  const owner: NativeOwner = {
    capabilities: async () => ({ ready: true, reasons: [], supportedProviders: ['copilot'], verifiedProfileIds: ['profile'], version: 'fixture' }),
    ensureStarted: async () => {}, ensureSession: async () => { throw new Error('Must preserve session'); },
    snapshot: async identity => ({ identity, state, inputs: [] }),
    send: async (identity, input, key) => { sent.push({ identity, input, key }); state = 'active'; },
    quiesce: async () => quiescence, open: async identity => { opened.push(identity); return {}; }, subscribe: () => () => {},
  };
  const readiness = async () => available ? { ready: true as const, baseSha: 'base', workspacePath: '/original/worktree', profileId: 'profile' }
    : { ready: false as const, code: 'unavailable', recovery: 'Restore assigned owner' };
  const scheduler = createScheduler({ store: f.store, clock, materialize: materializeFixture, readiness,
    start: async r => ({ kind: 'started', identity: { ...(deferIdentity ? {} : { native: r.task.spec.id===f.task.id?native:{...native,sessionId:`session-${r.task.spec.id}`,chatId:`chat-${r.task.spec.id}`} }), workflow: { executionId: 'original-workflow', namespace: 'sf', flowId: 'quality', revision: '1' } } }),
  });
  const started = await scheduler.dispatch('manual'); assert.equal(started.kind, 'started');
  const attempt = f.store.snapshot().attempts[0]!;
  const deps = (): LifecycleDeps => ({ store: f.store, clock, owner: () => owner, readiness,
    workspace: async () => true,
    workflow: { snapshot: async () => 'present', quiesce: async () => workflowQuiet, resume: async () => {} },
  });
  let lifecycle = createLifecycle(deps());
  const event = (value: Omit<OwnerEvent, 'identity' | 'at'> | Record<string, unknown>) => lifecycle.applyOwnerEvent(attempt.id, { identity: native, at: clock.wallNow().toISOString(), ...value } as OwnerEvent);
  if (!deferIdentity) await event({ type: 'activity', active: true });
  return { f, clock, attempt, native, scheduler, deps, event, sent, opened,
    get lifecycle() { return lifecycle; }, setState(value: NativeSnapshot['state']) { state = value; },
    setQuiet(value: typeof quiescence) { quiescence = value; }, setWorkflowQuiet(value: typeof workflowQuiet) { workflowQuiet = value; },
    setAvailable(value: boolean) { available = value; },
    reopen() { f.reopen(); lifecycle = createLifecycle(deps()); },
  };
}
const input = { id: 'native-request', prompt: 'Choose a name', schema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'], additionalProperties: false } };

test('deadline observation persists later attempt stops while an earlier protected subprocess is stalled', async () => {
  const x = await fixture(); const { f } = x;
  const {runProtectedProcess}=await import('../../src/platform/windows-private.ts');
  const stalled=runProtectedProcess(process.execPath,['-e','setTimeout(()=>process.stdout.write("done"),800)'],'',3000);
  let protectorDone=false;void stalled.then(()=>{protectorDone=true});
  const calls = new Map<string, number>();
  try {
    const settings = f.store.getSettings();
    f.store.patchSettings({ limits: { ...settings.config.limits, concurrency: 2, activeMinutes: 1 } }, settings.revision);
    x.clock.advance(30000);
    f.store.createManualTasks({ ...f.request, repositoryIds: ['repo-2'] }, 'second-repository');
    assert.equal((await x.scheduler.dispatch('manual')).kind, 'started');
    const second = f.store.snapshot().attempts.find(a => a.id !== x.attempt.id)!;
    const deps = x.deps();
    const lifecycle = createLifecycle({ ...deps, owner: identity => ({ ...deps.owner(identity), async quiesce(actual) {
      calls.set(actual.sessionId, (calls.get(actual.sessionId) ?? 0) + 1);
      if (actual.sessionId === x.native.sessionId) await stalled;
      return 'unknown';
    } }) });
    x.clock.advance(30000);
    lifecycle.observeBudgets();
    await Promise.resolve();
    assert.equal(f.store.getLifecycle(x.attempt.id).state.stopRequested, true);
    assert.equal(f.store.getLifecycle(second.id).state.stopRequested, false);
    x.clock.advance(30000);
    lifecycle.observeBudgets(); lifecycle.observeBudgets();
    await Promise.resolve();
    assert.equal(f.store.getLifecycle(second.id).state.stopRequested, true, 'later deadline must persist without awaiting the earlier stop');
    assert.equal(f.store.getLifecycle(second.id).reservation.attempt.activeDurationMs, 60000);
    assert.equal(calls.get(x.native.sessionId), 1, 'one physical stop job per attempt');
    assert.equal(calls.get(second.native!.sessionId), 1);
    assert.equal(protectorDone,false,'later physical stop advances while the actual asynchronous helper is stalled');
    assert.equal(f.store.getAdmissionState().activeLeases.length, 2, 'unknown writers retain both fences');
  } finally { await stalled; await new Promise(resolve => setImmediate(resolve)); f.close(); }
});

test('expired_lease_does_not_admit_a_second_native_writer', async () => {
  const x = await fixture(); const { f } = x;
  try {
    x.setQuiet('unknown'); x.setState('lost'); x.clock.advance(24 * 3600000);
    await x.event({ type: 'connection_lost', reason: 'transport disappeared' });
    assert.equal(f.store.getAdmissionState().activeLeases.length, 1);
    f.store.createManualTasks(f.request, 'second');
    assert.equal((await x.scheduler.dispatch('takt')).kind, 'noop');
    await assert.rejects(x.lifecycle.requestTakeover(f.task.id), { code: 'quiescence_unknown' });
    assert.equal(x.opened.length, 0);
    assert.equal(f.store.getRepository('repo-1')!.controlMode, 'human');
    x.setQuiet('waiting'); x.setState('waiting');
    await x.lifecycle.requestTakeover(f.task.id);
    assert.equal(f.store.getAdmissionState().activeLeases.length, 0);
    assert.equal(x.opened.length, 1);
    assert.throws(() => f.store.updateLifecycle(x.attempt.id, x.attempt.fence, { status: 'running' }), { code: 'stale_fence' });
  } finally { f.close(); }
});

test('human_resume_preserves_identity_and_retry_is_charged', async () => {
  const x = await fixture(); const { f } = x;
  try {
    const originalIdentity = { native: x.attempt.native, workflow: x.attempt.workflow, workspacePath: x.attempt.workspacePath };
    const startsBeforeHumanResume = f.store.getQuotaState().confirmed;
    await x.event({ type: 'input', input });
    assert.equal(f.store.getTask(f.task.id)!.status, 'waiting_input');
    assert.equal(f.store.getAdmissionState().activeLeases.length, 0);
    const request = f.store.snapshot().attention.find(a => a.nativeInputId === input.id)!;
    await assert.rejects(x.lifecycle.resumeInput(request.id, { name: 1 }, 'bad'), { code: 'invalid_answer' });
    await x.lifecycle.resumeInput(request.id, { name: 'chosen' }, 'reply-1');
    await x.lifecycle.resumeInput(request.id, { name: 'chosen' }, 'reply-1');
    const resumed = f.store.snapshot().attempts[0]!;
    assert.deepEqual({ native: resumed.native, workflow: resumed.workflow, workspacePath: resumed.workspacePath }, originalIdentity);
    assert.equal(f.store.getQuotaState().confirmed, startsBeforeHumanResume);
    assert.equal(f.store.snapshot().attempts.length, 1);
    assert.ok(resumed.fence > x.attempt.fence);
    assert.equal(x.sent.length, 1);
    assert.deepEqual(x.sent[0]!.input, { requestId: input.id, response: { name: 'chosen' }, answers: { name: 'chosen' } });
    await assert.rejects(x.lifecycle.resumeInput(request.id, { name: 'different' }, 'reply-1'), { code: 'idempotency_conflict' });
    const first = await x.lifecycle.retryTransient(resumed.id, { transient: true, reason: 'temporary' });
    assert.ok(first); assert.equal(f.store.getQuotaState().confirmed, startsBeforeHumanResume + 1);
    assert.deepEqual(first.native, x.native); assert.equal(first.workspacePath, '/original/worktree');
    const second = await x.lifecycle.retryTransient(first.id, { transient: true, reason: 'temporary' });
    assert.ok(second); assert.equal(f.store.getQuotaState().confirmed, startsBeforeHumanResume + 2);
    assert.equal(await x.lifecycle.retryTransient(second.id, { transient: true, reason: 'temporary' }), null);
    assert.equal(f.store.getTask(f.task.id)!.status, 'needs_attention');
    assert.equal(f.store.snapshot().attempts.length, 3);
    assert.deepEqual(f.store.getRotationState('repo-1').cursor, null);
  } finally { f.close(); }
});

test('active_time_uses_monotonic_segments', async () => {
  const x = await fixture(); const { f } = x;
  try {
    x.clock.advance(10 * 60000); await x.event({ type: 'input', input });
    x.clock.advance(5 * 3600000);
    const request = f.store.snapshot().attention.find(a => a.nativeInputId)!;
    await x.lifecycle.resumeInput(request.id, { name: 'chosen' }, 'reply');
    assert.equal(f.store.snapshot().attempts[0]!.activeDurationMs, 600000);
    x.clock.wall -= 7 * 86400000; x.clock.elapsed += 19 * 60000;
    await x.lifecycle.checkBudgets();
    assert.equal(f.store.getTask(f.task.id)!.status, 'running');
    x.clock.elapsed += 60000; await x.lifecycle.checkBudgets();
    assert.equal(f.store.getTask(f.task.id)!.status, 'needs_attention');
    assert.equal(f.store.snapshot().attempts[0]!.activeDurationMs, 1800000);
    assert.equal(f.store.getAdmissionState().activeLeases.length, 0);
  } finally { f.close(); }
});

test('takeover_blocks_automatic_turns_and_return_control_revalidates', async () => {
  const x = await fixture(); const { f } = x;
  try {
    await x.event({ type: 'snapshot', snapshot: { identity: x.native, state: 'idle', inputs: [] } });
    assert.equal(f.store.getTask(f.task.id)!.status, 'running');
    assert.equal(f.store.getAdmissionState().activeLeases.length, 1);
    await x.lifecycle.requestTakeover(f.task.id);
    assert.equal(f.store.getRepository('repo-1')!.controlMode, 'human');
    assert.equal((await x.scheduler.dispatch('takt')).kind, 'noop');
    x.setAvailable(false);
    await assert.rejects(x.lifecycle.returnControl('repo-1'), { code: 'unavailable' });
    assert.equal(f.store.getRepository('repo-1')!.controlMode, 'human');
    x.setAvailable(true); await x.lifecycle.returnControl('repo-1');
    assert.equal(f.store.getRepository('repo-1')!.controlMode, 'factory');
  } finally { f.close(); }
});

test('pending_continuation_survives_restart_and_precedes_new_work_without_a_daily_charge', async () => {
  const x = await fixture(); const { f } = x;
  try {
    await x.event({ type: 'input', input });
    const request = f.store.snapshot().attention.find(a => a.nativeInputId)!;
    const settings = f.store.getSettings(); f.store.patchSettings({ paused: true, limits: { ...settings.config.limits, startsPerDay: 1 } }, settings.revision);
    await x.lifecycle.resumeInput(request.id, { name: 'chosen' }, 'pending');
    assert.equal(x.sent.length, 0); assert.equal(f.store.pendingActions().length, 1);
    x.reopen(); f.store.patchSettings({ paused: false }, f.store.getSettings().revision);
    f.store.createManualTasks(f.request, 'new-work');
    const scheduler = createScheduler({ store: f.store, clock: x.clock, materialize: materializeFixture,
      readiness: async task => x.deps().readiness(task, x.attempt), start: async () => { throw new Error('New work must not launch'); },
      continuations: () => x.lifecycle.dispatchPending(),
    });
    assert.equal((await scheduler.dispatch('resume')).kind, 'started');
    assert.equal(x.sent.length, 1); assert.equal(f.store.getQuotaState().confirmed, 1);
    assert.equal(f.store.pendingActions().length, 0);
  } finally { f.close(); }
});

test('reconnect_reconciles_before_replaying_only_lifecycle_actions_and_retains_unknown_writers', async () => {
  const x = await fixture(); const { f } = x;
  try {
    await x.event({ type: 'input', input });
    const request = f.store.snapshot().attention.find(a => a.nativeInputId)!;
    x.setAvailable(false); await x.lifecycle.resumeInput(request.id, { name: 'chosen' }, 'queued');
    f.store.enqueueAction({ key: 'future', kind: 'closeout.merge', payload: {} });
    x.setAvailable(true); x.setState('lost'); x.reopen();
    await x.lifecycle.reconnect();
    assert.equal(x.sent.length, 0); assert.equal(f.store.pendingActions().length, 2);
    x.setState('waiting'); await x.lifecycle.reconnect();
    assert.equal(x.sent.length, 1); assert.deepEqual(f.store.pendingActions().map(a => a.kind), ['closeout.merge']);
  } finally { f.close(); }
});

test('native_idle_keeps_accounting_but_proven_ci_wait_stops_it_and_restart_never_resets_budget', async () => {
  const x = await fixture(); const { f } = x;
  try {
    x.clock.advance(60000);
    await x.event({ type: 'snapshot', snapshot: { identity: x.native, state: 'idle', inputs: [] } });
    x.clock.advance(600000); await x.lifecycle.checkBudgets();
    assert.equal(f.store.snapshot().attempts[0]!.activeDurationMs, 660000);
    await x.event({ type: 'activity', active: true });
    x.clock.advance(60000); await x.lifecycle.waitForCI(x.attempt.id);
    assert.equal(f.store.getTask(f.task.id)!.status, 'waiting_ci');
    assert.equal(f.store.snapshot().attempts[0]!.activeDurationMs, 720000);
    x.clock.advance(36000000); await x.lifecycle.checkBudgets();
    assert.equal(f.store.snapshot().attempts[0]!.activeDurationMs, 720000);
  } finally { f.close(); }
  const y = await fixture();
  try {
    y.clock.advance(60000); y.reopen(); await y.lifecycle.reconnect();
    assert.equal(y.f.store.getTask(y.f.task.id)!.status, 'needs_attention');
    assert.equal(y.f.store.snapshot().attempts[0]!.activeDurationMs, 1800000);
    assert.equal(y.f.store.getAdmissionState().activeLeases.length, 0);
  } finally { y.f.close(); }
});

test('workflow_unknown_blocks_release_even_when_native_is_waiting', async () => {
  const x = await fixture();
  try {
    x.setWorkflowQuiet('unknown');
    await assert.rejects(x.event({ type: 'input', input }), { code: 'quiescence_unknown' });
    assert.equal(x.f.store.getAdmissionState().activeLeases.length, 1);
    x.setWorkflowQuiet('waiting'); x.setState('waiting');
    await x.lifecycle.reconnect();
    assert.equal(x.f.store.getTask(x.f.task.id)!.status, 'waiting_input');
    assert.equal(x.f.store.getAdmissionState().activeLeases.length, 0);
  } finally { x.f.close(); }
});

test('continuation_does_not_send_when_workflow_resume_changes_repository_control', async () => {
  const x = await fixture(); const { f } = x;
  try {
    await x.event({ type: 'input', input });
    const request = f.store.snapshot().attention.find(a => a.nativeInputId)!;
    const deps = x.deps(); deps.workflow.resume = async () => { const repo = f.store.getRepository('repo-1')!; f.store.setRepositoryControl(repo.id, 'human', repo.revision); };
    await createLifecycle(deps).resumeInput(request.id, { name: 'chosen' }, 'interrupted');
    assert.equal(x.sent.length, 0);
    assert.equal(f.store.getAdmissionState().activeLeases.length, 1);
    assert.equal(f.store.pendingActions().filter(a => a.kind === 'lifecycle.send').length, 1);
  } finally { f.close(); }
});

test('queued_answer_claims_request_and_cannot_be_replaced_by_a_second_key', async () => {
  const x = await fixture();
  try {
    await x.event({ type: 'input', input }); x.setAvailable(false);
    const request = x.f.store.snapshot().attention.find(a => a.nativeInputId)!;
    await x.lifecycle.resumeInput(request.id, { name: 'first' }, 'first-key');
    await assert.rejects(x.lifecycle.resumeInput(request.id, { name: 'second' }, 'second-key'), { code: 'request_closed' });
    assert.equal(x.f.store.pendingActions().filter(a => a.kind === 'lifecycle.send').length, 1);
  } finally { x.f.close(); }
});

test('return_control_requires_current_grants_and_snapshot_input_creates_a_native_request', async () => {
  const x = await fixture(); const { f } = x;
  try {
    await x.event({ type: 'snapshot', snapshot: { identity: x.native, state: 'waiting', inputs: [input] } });
    assert.equal(f.store.getTask(f.task.id)!.status, 'waiting_input');
    await x.lifecycle.requestTakeover(f.task.id); f.store.revokeGrant('grant-1');
    await assert.rejects(x.lifecycle.returnControl('repo-1'), { code: 'capability_blocked' });
    assert.equal(f.store.getRepository('repo-1')!.controlMode, 'human');
  } finally { f.close(); }
});

test('takeover_of_waiting_task_quiesces_the_repository_current_writer', async () => {
  const x = await fixture(); const { f } = x;
  try {
    await x.event({ type: 'input', input });
    f.store.createManualTasks(f.request, 'other-task');
    assert.equal((await x.scheduler.dispatch('manual')).kind, 'started');
    assert.equal(f.store.getAdmissionState().activeLeases.length, 1);
    await x.lifecycle.requestTakeover(f.task.id);
    assert.equal(f.store.getAdmissionState().activeLeases.length, 0);
    assert.equal(x.opened.length, 1);
    await x.lifecycle.returnControl('repo-1');
    assert.ok(f.store.getAdmissionState().tasks.every(t => t.controlMode === 'factory'));
  } finally { f.close(); }
});

test('return_control_releases_a_previously_unknown_writer_only_after_proof', async () => {
  const x = await fixture();
  try {
    x.setQuiet('unknown'); await assert.rejects(x.lifecycle.requestTakeover(x.f.task.id));
    x.setQuiet('waiting'); await x.lifecycle.returnControl('repo-1');
    assert.equal(x.f.store.getAdmissionState().activeLeases.length, 0);
    assert.equal(x.f.store.getRepository('repo-1')!.controlMode, 'factory');
  } finally { x.f.close(); }
});

test('first_native_identity_is_bound_once_to_the_started_owner_and_provider', async () => {
  const x = await fixture(true); const { f } = x;
  try {
    const reservation = f.store.getReservations()[0]!;
    await x.event({ type: 'identity' });
    assert.deepEqual(f.store.snapshot().attempts[0]!.native, x.native);
    f.store.confirmStart(reservation.id, reservation.externalIdentity!);
    assert.deepEqual(f.store.snapshot().attempts[0]!.native, x.native);
    await assert.rejects(x.lifecycle.applyOwnerEvent(x.attempt.id, { type: 'identity', identity: { ...x.native, sessionId: 'replacement' }, at: x.clock.wallNow().toISOString() }), { code: 'identity_conflict' });
    await x.event({ type: 'input', input });
    assert.equal(f.store.getTask(f.task.id)!.status, 'waiting_input');
  } finally { f.close(); }
});

test('v2_upgrade_preserves_running_attempt_and_treats_its_active_time_as_uncertain', async () => {
  const x = await fixture(); const { f } = x;
  try {
    f.store.close();
    const db = new DatabaseSync(f.path);
    db.exec('DROP TABLE broker_revocations; DROP TABLE broker_artifacts; DROP TABLE broker_results; DROP TABLE broker_writes; DROP TABLE broker_capabilities; DROP TABLE api_requests; DROP TABLE lifecycle_actions; DROP TABLE lifecycle_state; PRAGMA user_version = 2'); db.close();
    x.reopen(); await x.lifecycle.reconnect();
    assert.equal(f.store.snapshot().attempts[0]!.activeDurationMs, 1800000);
    assert.equal(f.store.getTask(f.task.id)!.status, 'needs_attention');
    assert.equal(f.store.getQuotaState().confirmed, 1);
  } finally { f.close(); }
});

test('time_spent_awaiting_native_send_is_charged_and_transport_loss_keeps_a_durable_segment', async () => {
  const x = await fixture(); const { f } = x;
  try {
    await x.event({ type: 'input', input });
    const request = f.store.snapshot().attention.find(a => a.nativeInputId)!;
    const deps = x.deps(); const owner = deps.owner(x.native); const send = owner.send;
    owner.send = async (...args) => { x.clock.advance(31 * 60000); await send(...args); };
    await createLifecycle(deps).resumeInput(request.id, { name: 'chosen' }, 'slow-send');
    assert.equal(f.store.getTask(f.task.id)!.status, 'needs_attention');
    assert.ok(f.store.snapshot().attempts[0]!.activeDurationMs >= 1800000);
    assert.equal(f.store.getAdmissionState().activeLeases.length, 0);
  } finally { f.close(); }
  const y = await fixture();
  try {
    await y.event({ type: 'input', input });
    const request = y.f.store.snapshot().attention.find(a => a.nativeInputId)!;
    const deps = y.deps(); deps.owner(y.native).send = async () => { throw new Error('transport loss'); };
    await assert.rejects(createLifecycle(deps).resumeInput(request.id, { name: 'chosen' }, 'unknown-send'));
    assert.ok(y.f.store.getLifecycle(y.attempt.id).state.active);
    assert.equal(y.f.store.getAdmissionState().activeLeases.length, 1);
  } finally { y.f.close(); }
});

test('lost_or_unproven_waiting_writers_keep_accruing_until_quiescence_is_proven', async () => {
  for (const lost of [true, false]) {
    const x = await fixture();
    try {
      x.clock.advance(5 * 60000); x.setQuiet('unknown');
      if (lost) await x.event({ type: 'connection_lost', reason: 'offline' });
      else await assert.rejects(x.event({ type: 'input', input }), { code: 'quiescence_unknown' });
      x.clock.advance(25 * 60000); x.setQuiet('waiting'); await x.lifecycle.checkBudgets();
      assert.equal(x.f.store.snapshot().attempts[0]!.activeDurationMs, 1800000);
      assert.equal(x.f.store.getAdmissionState().activeLeases.length, 0);
      assert.equal(x.f.store.getTask(x.f.task.id)!.status, 'needs_attention');
    } finally { x.f.close(); }
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('I1_pending_uncertain_retry_accrues_and_cannot_replay_after_its_deadline', async () => {
  for (const tickBeforeReplay of [true, false]) {
    const x = await fixture(); const { f } = x;
    try {
      const deps = x.deps(); const owner = deps.owner(x.native); let sends = 0; let quiesces = 0;
      const quiesce = owner.quiesce;
      owner.quiesce = async identity => { quiesces++; return quiesce(identity); };
      owner.send = async () => { sends++; throw new Error('uncertain send outcome'); };
      const lifecycle = createLifecycle(deps);
      await assert.rejects(lifecycle.retryTransient(x.attempt.id, { transient: true, reason: 'temporary' }));
      const retry = f.store.getReservations().find(r => r.attempt.retryOfAttemptId)!;
      const before = quiesces; x.clock.advance(31 * 60000);
      if (tickBeforeReplay) await lifecycle.checkBudgets();
      owner.send = async () => { sends++; };
      await lifecycle.dispatchPending();
      const after = f.store.getLifecycle(retry.attempt.id).reservation;
      assert.ok(after.attempt.activeDurationMs >= 1800000);
      assert.ok(quiesces > before);
      assert.equal(sends, 1);
      assert.equal(after.status, 'pending'); assert.equal(after.lease.active, true);
      assert.equal(after.lease.fence, retry.lease.fence);
      assert.equal(f.store.getQuotaState().confirmed, 1); assert.equal(f.store.getQuotaState().pending, 1);
    } finally { f.close(); }
  }
});

test('I2_bound_replay_rechecks_persisted_readiness_recipe_activation_and_tag_archival', async () => {
  for (const policy of ['readiness', 'recipe', 'tag'] as const) {
    const x = await fixture(); const { f } = x;
    try {
      await x.event({ type: 'input', input });
      const request = f.store.snapshot().attention.find(a => a.nativeInputId)!;
      const deps = x.deps();
      deps.workflow.resume = async () => {
        const recipe = f.store.snapshot().recipes[0]!;
        if (policy === 'readiness') f.store.setRecipeReadiness(recipe.id, recipe.currentRevision, { hash: f.recipe.hash, ready: false, reasons: ['Revoked'] }, recipe.revision);
        if (policy === 'recipe') f.store.patchRecipe(recipe.id, { active: false }, recipe.revision);
        if (policy === 'tag') { const replacement = f.store.createTag({ displayName: 'Replacement' }); f.store.archiveTag(f.recipe.tagId, replacement.id); }
      };
      const lifecycle = createLifecycle(deps);
      await lifecycle.resumeInput(request.id, { name: 'chosen' }, `bound-${policy}`);
      assert.equal(x.sent.length, 0);
      deps.workflow.resume = async () => {};
      await lifecycle.dispatchPending();
      assert.equal(x.sent.length, 0, policy);
      assert.equal(f.store.pendingActions().filter(a => a.kind === 'lifecycle.send').length, 1);
      assert.equal(f.store.getAdmissionState().activeLeases.length, 1);
    } finally { f.close(); }
  }
});

test('I3_deferred_send_allows_deadline_quiescence_and_takeover_without_releasing_its_fence', async () => {
  const x = await fixture(); const { f } = x;
  const accepted = deferred<void>(); const entered = deferred<void>(); const quietRequested = deferred<void>();
  let pending: Promise<void> | undefined;
  try {
    await x.event({ type: 'input', input });
    const request = f.store.snapshot().attention.find(a => a.nativeInputId)!;
    const deps = x.deps(); const owner = deps.owner(x.native); const quiesce = owner.quiesce;
    owner.send = async () => { entered.resolve(); await accepted.promise; };
    owner.quiesce = async identity => { quietRequested.resolve(); return quiesce(identity); };
    const lifecycle = createLifecycle(deps);
    pending = lifecycle.resumeInput(request.id, { name: 'chosen' }, 'deferred'); await entered.promise;
    x.clock.advance(31 * 60000);
    const tick = lifecycle.checkBudgets();
    const requested = await Promise.race([quietRequested.promise.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))]);
    assert.equal(requested, true, 'deadline must request quiescence before native send resolves');
    await tick;
    await assert.rejects(lifecycle.requestTakeover(f.task.id), { code: 'effect_unresolved' });
    assert.equal(f.store.getRepository('repo-1')!.controlMode, 'human');
    assert.equal(f.store.getAdmissionState().activeLeases.length, 1); assert.equal(x.opened.length, 0);
    assert.equal(f.store.pendingActions().filter(a => a.kind === 'lifecycle.send').length, 1);
    accepted.resolve(); await pending;
    assert.equal(f.store.getTask(f.task.id)!.status, 'needs_attention');
    assert.equal(f.store.getAdmissionState().activeLeases.length, 1);
    assert.equal(f.store.pendingActions().filter(a => a.kind === 'lifecycle.send').length, 1);
  } finally { accepted.resolve(); await pending?.catch(() => {}); f.close(); }
});

test('I3_late_retry_acceptance_is_charged_once_and_requires_fresh_post_acceptance_quiescence', async () => {
  const x = await fixture(); const { f } = x;
  const accepted = deferred<void>(); const entered = deferred<void>();
  let pending: Promise<unknown> | undefined;
  try {
    const deps = x.deps(); const owner = deps.owner(x.native); const quietKeys: string[] = [];
    owner.send = async () => { entered.resolve(); await accepted.promise; };
    deps.workflow.quiesce = async (_attempt, key) => { quietKeys.push(key); return 'waiting'; };
    const lifecycle = createLifecycle(deps);
    pending = lifecycle.retryTransient(x.attempt.id, { transient: true, reason: 'temporary' }); await entered.promise;
    const retry = f.store.getReservations().find(r => r.attempt.retryOfAttemptId)!;
    x.clock.advance(31 * 60000); await lifecycle.checkBudgets();
    assert.equal(f.store.getQuotaState().confirmed, 1); assert.equal(f.store.getQuotaState().pending, 1);
    assert.equal(f.store.getLifecycle(retry.attempt.id).reservation.lease.active, true);
    const beforeAcceptKey = quietKeys.at(-1)!;
    accepted.resolve(); await pending;
    const after = f.store.getLifecycle(retry.attempt.id).reservation;
    assert.equal(after.status, 'confirmed'); assert.equal(after.lease.active, true);
    assert.equal(f.store.getQuotaState().confirmed, 2); assert.equal(f.store.getQuotaState().pending, 0);
    assert.equal(f.store.getTask(f.task.id)!.status, 'needs_attention');
    await lifecycle.checkBudgets();
    assert.equal(f.store.getQuotaState().confirmed, 2);
    assert.equal(f.store.getLifecycle(retry.attempt.id).reservation.lease.active, false);
    assert.notEqual(quietKeys.at(-1), beforeAcceptKey);
    assert.equal(f.store.pendingActions().filter(a => a.kind === 'lifecycle.retry').length, 1);
  } finally { accepted.resolve(); await pending?.catch(() => {}); f.close(); }
});

test('I3_late_workflow_resume_cannot_send_after_budget_interruption', async () => {
  const x = await fixture(); const { f } = x;
  const resumed = deferred<void>(); const entered = deferred<void>(); let pending: Promise<void> | undefined;
  try {
    await x.event({ type: 'input', input });
    const request = f.store.snapshot().attention.find(a => a.nativeInputId)!;
    const deps = x.deps(); deps.workflow.resume = async () => { entered.resolve(); await resumed.promise; };
    const lifecycle = createLifecycle(deps);
    pending = lifecycle.resumeInput(request.id, { name: 'chosen' }, 'deferred-workflow'); await entered.promise;
    x.clock.advance(31 * 60000); await lifecycle.checkBudgets();
    assert.equal(f.store.getAdmissionState().activeLeases.length, 1);
    resumed.resolve(); await pending;
    assert.equal(x.sent.length, 0);
    assert.equal(f.store.getTask(f.task.id)!.status, 'needs_attention');
    assert.equal(f.store.getAdmissionState().activeLeases.length, 1);
  } finally { resumed.resolve(); await pending?.catch(() => {}); f.close(); }
});

test('I3_durable_effect_guard_blocks_a_second_controller_while_send_is_inflight', async () => {
  const x = await fixture(); const { f } = x;
  const accepted = deferred<void>(); const entered = deferred<void>(); let pending: Promise<void> | undefined;
  try {
    await x.event({ type: 'input', input });
    const request = f.store.snapshot().attention.find(a => a.nativeInputId)!;
    const deps = x.deps(); let sends = 0;
    deps.owner(x.native).send = async () => { sends++; entered.resolve(); await accepted.promise; };
    pending = createLifecycle(deps).resumeInput(request.id, { name: 'chosen' }, 'same-key'); await entered.promise;
    await createLifecycle(deps).resumeInput(request.id, { name: 'chosen' }, 'same-key');
    assert.equal(sends, 1);
    assert.equal(f.store.getAdmissionState().activeLeases.length, 1);
    accepted.resolve(); await pending;
    assert.equal(f.store.pendingActions().filter(a => a.kind === 'lifecycle.send').length, 0);
    assert.equal(f.store.getQuotaState().confirmed, 1);
  } finally { accepted.resolve(); await pending?.catch(() => {}); f.close(); }
});

test('ordinary_release_uses_persisted_metadata_guard_and_stale_state_cannot_remove_it', async () => {
  const x = await fixture(); const { f } = x;
  try {
    const stale = f.store.getLifecycle(x.attempt.id).state;
    const result = { attemptId: x.attempt.id, summary: 'Report', evidence: [], createdTaskIds: [], outcome: 'result' as const };
    await x.lifecycle.prepareCloseout(x.attempt.id, result);
    // Direct persistence regression: rejection must use current state, not caller's old patch.
    assert.throws(() => f.store.updateLifecycle(x.attempt.id, x.attempt.fence,
      { state: stale, status: 'waiting_ci', release: 'stopped' }), { code: 'closeout_inflight' });
    // A prior accounting/pause snapshot cannot erase or downgrade the closeout phase in a
    // separate non-release update and thereby make the next release appear safe.
    f.store.updateLifecycle(x.attempt.id, x.attempt.fence, { state: stale });
    f.store.updateLifecycle(x.attempt.id, x.attempt.fence,
      { state: { ...stale, closeout: { phase: 'monitoring', fence: x.attempt.fence } } });
    assert.equal(f.store.getLifecycle(x.attempt.id).state.closeout!.phase, 'metadata');
    assert.throws(() => f.store.updateLifecycle(x.attempt.id, x.attempt.fence, { release: 'waiting' }), { code: 'closeout_inflight' });
    assert.equal(f.store.getAdmissionState().activeLeases.length, 1);
    assert.equal(f.store.getLifecycle(x.attempt.id).reservation.lease.fence, x.attempt.fence);
    // Only the deliberate trusted closeout path may advance its guard and release ownership.
    await x.lifecycle.finishCloseout(x.attempt.id, result, { kind: 'completed', attemptId: x.attempt.id, headSha: 'a'.repeat(40) });
    assert.equal(f.store.getTask(f.task.id)!.status, 'completed');
    assert.equal(f.store.getAdmissionState().activeLeases.length, 0);
  } finally { f.close(); }
});

test('E4 I3 retry opens the unique current reservation retaining native identity',async()=>{
 const x=await fixture();try{const retry=await x.lifecycle.retryTransient(x.attempt.id,{transient:true,reason:'retry'});assert.ok(retry);assert.deepEqual(retry.native,x.native);await x.lifecycle.requestTakeover(x.f.task.id);assert.deepEqual(x.opened,[x.native]);}finally{x.f.close();}
});
test('E4 I4 separate human control cycles each open once and same handoff replay is idempotent',async()=>{
 const x=await fixture();try{await x.lifecycle.requestTakeover(x.f.task.id);await x.lifecycle.requestTakeover(x.f.task.id);assert.equal(x.opened.length,1);await x.lifecycle.returnControl('repo-1');await x.lifecycle.requestTakeover(x.f.task.id);await x.lifecycle.requestTakeover(x.f.task.id);assert.equal(x.opened.length,2);}finally{x.f.close();}
});

test('E4 I3 rejects a native identity ambiguous across distinct current tasks',async()=>{
 const x=await fixture();try{await x.event({type:'input',input});x.f.store.createManualTasks(x.f.request,'ambiguous-other');await createScheduler({store:x.f.store,clock:x.clock,materialize:materializeFixture,readiness:async()=>({ready:true,baseSha:'base',workspacePath:'/original/worktree',profileId:'profile'}),start:async()=>({kind:'started',identity:{native:x.native,workflow:{executionId:'other',namespace:'sf',flowId:'quality',revision:'1'}}})}).dispatch('manual');await assert.rejects(x.lifecycle.requestTakeover(x.f.task.id),/one current reservation/);assert.equal(x.opened.length,0);}finally{x.f.close();}
});

test('native idle without result keeps background writer budget until physical stop', async () => {
  const x = await fixture();
  try {
    x.clock.advance(60_000);
    await x.event({ type: 'snapshot', snapshot: { identity: x.native, state: 'idle', inputs: [] } });
    x.clock.advance(29 * 60_000);
    await x.lifecycle.checkBudgets();
    assert.equal(x.f.store.getTask(x.f.task.id)!.status, 'needs_attention');
    assert.equal(x.f.store.getLifecycle(x.attempt.id).reservation.attempt.activeDurationMs, 1_800_000);
    assert.equal(x.f.store.getAdmissionState().activeLeases.length, 0);
  } finally { x.f.close(); }
});

test('explicit human return queues original unfinished task before new automatic work', async () => {
  const x=await fixture();
  try {
    await x.lifecycle.requestTakeover(x.f.task.id);
    await x.lifecycle.returnControl('repo-1');
    const pending=x.f.store.pendingActions().find(a=>a.kind==='lifecycle.send'&&a.payload.attemptId===x.attempt.id);
    assert.ok(pending,'return must retain an explicit continuation for the unfinished original task');
    await x.lifecycle.dispatchPending();
    assert.equal(x.sent.length,1);
    assert.deepEqual(x.sent[0]!.identity,x.native);
    assert.equal(x.f.store.getQuotaState().confirmed,1);
  } finally{x.f.close()}
});

test('retry retains exact parent child ownership without widening to unrelated tasks', async () => {
  const x=await fixture();
  try {
    const {createAttemptBroker}=await import('../../src/broker/operations.ts');
    const {createFactoryToolGate}=await import('../../src/owners/tools.ts');
    const broker=createAttemptBroker({store:x.f.store,clock:x.clock,signingKey:Buffer.alloc(32,7)});
    const gate=createFactoryToolGate({store:x.f.store,broker});
    gate.prepare(broker.nativeStart(x.attempt.id,'start'),'first');
    const child=await gate.invoke(x.native,'child-create','sf_factory_operation',{operation:'task.create',payload:{...x.f.task,id:'requested-child',source:'recipe',title:'Child'}});
    const childId=(child.result as {spec:{id:string}}).spec.id;
    const retry=await x.lifecycle.retryTransient(x.attempt.id,{transient:true,reason:'provider disconnect'});assert.ok(retry);
    gate.prepare(broker.nativeStart(retry.id,'retry'),'second');
    const result=await gate.invoke(x.native,'read-child','sf_factory_operation',{operation:'task.read',payload:{taskId:childId}});
    assert.equal((result.result as {spec:{id:string}}).spec.id,childId);
    const [unrelated]=x.f.store.createManualTasks(x.f.request,'unrelated');
    await assert.rejects(gate.invoke(x.native,'read-unrelated','sf_factory_operation',{operation:'task.read',payload:{taskId:unrelated!.id}}));
  } finally{x.f.close()}
});

test('pending broker native writer prevents lease release even after a physical freeze',async()=>{
 const x=await fixture();try{
  x.f.store.broker.claim({attemptId:x.attempt.id,fence:x.attempt.fence,key:'native-inflight',payload:{}});
  await assert.rejects(x.lifecycle.requestTakeover(x.f.task.id),{code:'effect_unresolved'});
  assert.equal(x.f.store.getAdmissionState().activeLeases.length,1);
 }finally{x.f.close()}
});

test('unknown original native navigation is never reissued by reconnect or same-key open',async()=>{
 const x=await fixture();try{
  let opens=0;const owner=x.deps().owner(x.native);owner.open=async()=>{opens++;x.setQuiet('unknown');throw Error('OS navigation acceptance unknown')};
  x.setQuiet('waiting');
  await assert.rejects(x.lifecycle.requestTakeover(x.f.task.id));
  assert.equal(opens,1);
  x.setQuiet('waiting');
  await x.lifecycle.reconnect();
  assert.equal(opens,1,'reconnect must not repeat uncertain OS navigation');
 }finally{x.f.close()}
});
