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
    start: async () => ({ kind: 'started', identity: { ...(deferIdentity ? {} : { native }), workflow: { executionId: 'original-workflow', namespace: 'sf', flowId: 'quality', revision: '1' } } }),
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

test('idle_and_ci_wait_do_not_restart_active_segments_and_restart_never_resets_budget', async () => {
  const x = await fixture(); const { f } = x;
  try {
    x.clock.advance(60000);
    await x.event({ type: 'snapshot', snapshot: { identity: x.native, state: 'idle', inputs: [] } });
    x.clock.advance(600000); await x.lifecycle.checkBudgets();
    assert.equal(f.store.snapshot().attempts[0]!.activeDurationMs, 60000);
    await x.event({ type: 'activity', active: true });
    x.clock.advance(60000); await x.lifecycle.waitForCI(x.attempt.id);
    assert.equal(f.store.getTask(f.task.id)!.status, 'waiting_ci');
    assert.equal(f.store.snapshot().attempts[0]!.activeDurationMs, 120000);
    x.clock.advance(36000000); await x.lifecycle.checkBudgets();
    assert.equal(f.store.snapshot().attempts[0]!.activeDurationMs, 120000);
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
    db.exec('DROP TABLE lifecycle_actions; DROP TABLE lifecycle_state; PRAGMA user_version = 2'); db.close();
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
