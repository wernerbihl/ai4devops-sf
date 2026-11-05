import assert from 'node:assert/strict';
import test from 'node:test';
import { openStore } from '../../src/storage/store.ts';
import { createScheduler } from '../../src/scheduling/admission.ts';
import type { SchedulerDeps, StartOutcome } from '../../src/scheduling/admission.ts';
import { createFixture } from '../helpers/store.ts';
import { materializeFixture, recipeFixture } from '../helpers/fixtures.ts';
import type { Clock, TaskSpec } from '../../src/contracts/domain.ts';

function ready(f: ReturnType<typeof createFixture>, recipeId = f.recipe.recipeId) {
  const summary = f.store.snapshot().recipes.find(recipe => recipe.id === recipeId)!;
  f.store.setRecipeReadiness(recipeId, summary.currentRevision, { hash: f.store.getRecipeRevision(recipeId, summary.currentRevision)!.hash, ready: true, reasons: [] }, summary.revision);
}
function activate(f: ReturnType<typeof createFixture>, id = 'repo-1', weights = { [f.recipe.tagId]: 100 }) {
  let repo = f.store.getRepository(id)!;
  repo = f.store.patchRepository(id, { active: true }, repo.revision);
  f.store.patchWeights(id, { weights }, repo.revision);
}
function scheduler(f: ReturnType<typeof createFixture>, overrides: Partial<SchedulerDeps> = {}) {
  return createScheduler({ store: f.store, clock: f.clock, materialize: materializeFixture,
    readiness: async () => ({ ready: true, baseSha: 'base-sha', workspacePath: '/fixture/workspace', profileId: 'fixture-profile' }),
    start: async reservation => ({ kind: 'started', identity: { workflow: { executionId: reservation.attempt.id, namespace: 'fixture', flowId: 'quality', revision: '1' } } }),
    ...overrides,
  });
}
function finish(f: ReturnType<typeof createFixture>, attemptId: string) {
  const reservation = f.store.getReservations().find(value => value.attempt.id === attemptId)!;
  const task = f.store.getTask(reservation.task.spec.id)!;
  f.store.setTaskStatus(task.spec.id, 'completed', task.revision);
  f.store.releaseAdmissionLease(reservation.id, reservation.lease.fence);
}
function cancelSeed(f: ReturnType<typeof createFixture>) {
  const task = f.store.getTask(f.task.id)!;
  f.store.patchTask(task.spec.id, { status: 'cancelled' }, task.revision);
}

test('concurrent_dispatch_starts_one_manual_task', async () => {
  const f = createFixture(); const other = openStore(f.path, { clock: f.clock, materialize: materializeFixture });
  try {
    ready(f); activate(f);
    const before = f.store.getRotationState('repo-1');
    const runners = [scheduler(f), scheduler(f, { store: other })];
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => runners[i % 2]!.dispatch(i % 2 ? 'manual' : 'takt')));
    assert.equal(results.filter(result => result.kind === 'started').length, 1);
    const state = f.store.snapshot();
    assert.equal(state.attempts.length, 1);
    assert.equal(state.attempts[0]!.taskId, f.task.id);
    assert.equal(f.store.getReservations().filter(value => value.status !== 'released').length, 1);
    assert.equal(f.store.getAdmissionState().activeLeases.length, 1);
    assert.deepEqual(f.store.getQuotaState(), { dayKey: '2026-11-04', confirmed: 1, pending: 0 });
    assert.deepEqual(f.store.getRotationState('repo-1'), before);
    assert.throws(() => f.store.patchTask(f.task.id, { title: 'Changed' }, f.store.getTask(f.task.id)!.revision));
  } finally { other.close(); f.close(); }
});

test('selects_oldest_serviced_repo_then_oldest_task_or_recipe', async () => {
  const f = createFixture();
  try {
    const unused = f.store.createTag({ displayName: 'Weighted unavailable' });
    const weights = { [f.recipe.tagId]: 90, [unused.id]: 10 };
    ready(f); activate(f, 'repo-1', weights); activate(f, 'repo-2', weights); cancelSeed(f);
    // A second same-tag recipe shares explicit capability grants, not an always-ready fallback.
    const second = recipeFixture(f.recipe.tagId); second.id = 'recipe-2:rev-1'; second.recipeId = 'recipe-2';
    second.contract.variables.sf.recipeId = 'recipe-2'; second.name = 'Second';
    f.store.saveRecipeRevision(second); ready(f, 'recipe-2');
    f.store.saveGrant({ ...f.store.getAdmissionState().grants[0]!, id: 'grant-2', recipeId: 'recipe-2' });
    const s = scheduler(f); const selected: TaskSpec[] = [];
    for (let i = 0; i < 4; i++) {
      const result = await s.dispatch('takt'); assert.equal(result.kind, 'started');
      if (result.kind !== 'started') throw new Error('Expected start');
      selected.push(f.store.getTask(f.store.snapshot().attempts.find(a => a.id === result.attemptId)!.taskId)!.spec);
      finish(f, result.attemptId);
    }
    assert.deepEqual(selected.map(task => [task.repositoryId, task.recipeId]), [
      ['repo-1', 'recipe-1'], ['repo-2', 'recipe-1'], ['repo-1', 'recipe-2'], ['repo-2', 'recipe-2'],
    ]);
    // A real queued automatic child wins over either fresh same-tag recipe, even on manual trigger.
    const [holder] = f.store.createManualTasks(f.request, 'holder');
    const actor = { ...f.actor, attemptId: 'actor-child' };
    f.store.registerActor(actor, holder!.id);
    const [queued] = f.store.createTasks({ ...f.request, title: 'Queued automatic' }, actor, 'queued');
    f.store.patchTask(holder!.id, { status: 'cancelled' }, f.store.getTask(holder!.id)!.revision);
    const before = f.store.getRotationState('repo-1').cursor;
    const result = await s.dispatch('manual'); assert.equal(result.kind, 'started');
    assert.equal(f.store.snapshot().attempts.at(-1)!.taskId, queued!.id);
    assert.notDeepEqual(f.store.getRotationState('repo-1').cursor, before);
  } finally { f.close(); }
});

test('manual_inactive_is_eligible_human_control_is_excluded_and_owner_failure_does_not_block_others', async () => {
  const f = createFixture();
  try {
    ready(f);
    f.store.setRepositoryControl('repo-1', 'human', f.store.getRepository('repo-1')!.revision);
    const [second] = f.store.createManualTasks({ ...f.request, repositoryIds: ['repo-2'] }, 'second');
    const result = await scheduler(f).dispatch('manual'); assert.equal(result.kind, 'started');
    assert.equal(f.store.snapshot().attempts[0]!.taskId, second!.id);
    assert.equal(f.store.getRepository('repo-2')!.active, false);
    if (result.kind !== 'started') throw new Error('Expected start'); finish(f, result.attemptId);
    f.store.setRepositoryControl('repo-1', 'factory', f.store.getRepository('repo-1')!.revision);
    const [third] = f.store.createManualTasks({ ...f.request, repositoryIds: ['repo-2'] }, 'third');
    const result2 = await scheduler(f, { readiness: async task => task.repositoryId === 'repo-1'
      ? { ready: false, code: 'owner_unavailable', recovery: 'Open the assigned VS Code owner' }
      : { ready: true, baseSha: 'base', workspacePath: '/fixture/two', profileId: 'fixture-profile' } }).dispatch('lease_released');
    assert.equal(result2.kind, 'started');
    assert.equal(f.store.snapshot().attempts.at(-1)!.taskId, third!.id);
    assert.equal(f.store.getTask(f.task.id)!.status, 'needs_attention');
    assert.equal(f.store.snapshot().attention[0]!.recovery, 'Open the assigned VS Code owner');
    assert.deepEqual(f.store.getQuotaState(), { dayKey: '2026-11-04', confirmed: 2, pending: 0 });
  } finally { f.close(); }
});

test('unknown_start_keeps_capacity_and_quota_until_reconciliation_and_confirmation_is_exactly_once', async () => {
  const f = createFixture();
  try {
    ready(f); activate(f);
    const before = f.store.getRotationState('repo-1');
    const result = await scheduler(f, { start: async () => { throw new Error('connection lost'); } }).dispatch('manual');
    assert.equal(result.kind, 'noop');
    const reservation = f.store.getReservations()[0]!;
    assert.equal(reservation.status, 'pending');
    assert.equal(f.store.snapshot().attempts[0]!.startedAt, undefined);
    assert.deepEqual(f.store.getQuotaState(), { dayKey: '2026-11-04', confirmed: 0, pending: 1 });
    assert.equal((await scheduler(f).dispatch('takt')).kind, 'noop');
    assert.deepEqual(f.store.getRotationState('repo-1'), before);
    const identity = { workflow: { executionId: 'reconciled', namespace: 'fixture', flowId: 'quality', revision: '1' } };
    f.store.confirmStart(reservation.id, identity); f.store.confirmStart(reservation.id, identity);
    assert.deepEqual(f.store.getQuotaState(), { dayKey: '2026-11-04', confirmed: 1, pending: 0 });
    assert.throws(() => f.store.confirmStart(reservation.id, { workflow: { ...identity.workflow, executionId: 'different' } }));
    assert.throws(() => f.store.releaseUnstarted(reservation.id));
    f.reopen();
    assert.equal(f.store.getReservations()[0]!.externalIdentity!.workflow.executionId, 'reconciled');
    assert.equal(f.store.getAdmissionState().activeLeases.length, 1);
  } finally { f.close(); }
});

test('definitive_no_launch_releases_without_charge_or_rotation_and_preflight_is_free', async () => {
  const f = createFixture();
  try {
    ready(f); activate(f); cancelSeed(f);
    const before = f.store.getRotationState('repo-1');
    const result = await scheduler(f, { start: async (): Promise<StartOutcome> => ({ kind: 'not_started', code: 'rejected', recovery: 'Fix workflow setup' }) }).dispatch('takt');
    assert.equal(result.kind, 'noop');
    assert.deepEqual(f.store.getQuotaState(), { dayKey: '2026-11-04', confirmed: 0, pending: 0 });
    assert.deepEqual(f.store.getRotationState('repo-1'), before);
    assert.equal(f.store.getAdmissionState().activeLeases.length, 0);
    assert.equal(f.store.getReservations()[0]!.status, 'released');
    const again = await scheduler(f, { readiness: async () => ({ ready: false, code: 'owner_unavailable', recovery: 'Open owner' }) }).dispatch('takt');
    assert.equal(again.kind, 'noop');
    assert.equal(f.store.getReservations().length, 1);
    assert.deepEqual(f.store.getRotationState('repo-1'), before);
  } finally { f.close(); }
});

test('activation_readiness_grants_and_versions_are_rechecked_after_async_preflight', async () => {
  for (const mutate of ['pause', 'deactivate', 'readiness', 'grant', 'task', 'weights', 'human'] as const) {
    const f = createFixture();
    try {
      ready(f); activate(f);
      if (mutate === 'deactivate') cancelSeed(f); // This branch must select automatic work: inactive manual work is allowed.
      const result = await scheduler(f, { readiness: async () => {
        switch (mutate) {
          case 'pause': f.store.patchSettings({ paused: true }, f.store.getSettings().revision); break;
          case 'deactivate': f.store.patchRepository('repo-1', { active: false }, f.store.getRepository('repo-1')!.revision); break;
          case 'readiness': { const summary = f.store.snapshot().recipes[0]!; f.store.setRecipeReadiness(summary.id, summary.currentRevision, { hash: f.recipe.hash, ready: false, reasons: ['Revoked'] }, summary.revision); break; }
          case 'grant': f.store.revokeGrant('grant-1'); break;
          case 'task': f.store.patchTask(f.task.id, { title: 'Edited' }, f.store.getTask(f.task.id)!.revision); break;
          case 'weights': f.store.patchWeights('repo-1', { weights: { [f.recipe.tagId]: 90 } }, f.store.getRepository('repo-1')!.revision); break;
          case 'human': f.store.setRepositoryControl('repo-1', 'human', f.store.getRepository('repo-1')!.revision); break;
        }
        return { ready: true, baseSha: 'base', workspacePath: '/fixture', profileId: 'profile' };
      }, start: async () => { throw new Error('Must never launch stale preflight'); } }).dispatch('manual');
      assert.equal(result.kind, 'noop', mutate);
      assert.equal(f.store.getReservations().length, 0, mutate);
    } finally { f.close(); }
  }
});

test('unverified_recipe_and_missing_capability_grants_fail_closed', async () => {
  const f = createFixture();
  try {
    activate(f);
    assert.equal((await scheduler(f).dispatch('manual')).kind, 'noop');
    assert.equal(f.store.getReservations().length, 0);
    ready(f); f.store.revokeGrant('grant-1');
    assert.equal((await scheduler(f).dispatch('manual')).kind, 'noop');
    assert.equal(f.store.getReservations().length, 0);
    const summary = f.store.snapshot().recipes[0]!;
    assert.throws(() => f.store.setRecipeReadiness(summary.id, 'obsolete', { hash: 'wrong-hash', ready: true, reasons: [] }, summary.revision));
  } finally { f.close(); }
});

test('rotation_survives_restart_and_only_effective_weights_or_tag_membership_change_its_version', async () => {
  const f = createFixture();
  try {
    const extra = f.store.createTag({ displayName: 'Extra' });
    ready(f); activate(f, 'repo-1', { [f.recipe.tagId]: 90, [extra.id]: 10 }); cancelSeed(f);
    const s = scheduler(f);
    const result = await s.dispatch('manual'); assert.equal(result.kind, 'started');
    if (result.kind !== 'started') throw new Error('Expected start'); finish(f, result.attemptId);
    const first = f.store.getRotationState('repo-1');
    assert.equal(first.cursor!.remainingQuota, 8);
    f.reopen(); assert.deepEqual(f.store.getRotationState('repo-1'), first);
    let repo = f.store.getRepository('repo-1')!;
    repo = f.store.patchRepository('repo-1', { active: false }, repo.revision);
    f.store.patchRepository('repo-1', { active: true }, repo.revision);
    f.store.patchWeights('repo-1', { weights: { [f.recipe.tagId]: 90 } }, f.store.getRepository('repo-1')!.revision);
    f.store.patchTag(extra.id, { displayName: 'Renamed' }, extra.revision);
    assert.deepEqual(f.store.getRotationState('repo-1'), first);
    f.store.patchWeights('repo-1', { weights: { [f.recipe.tagId]: 80 } }, f.store.getRepository('repo-1')!.revision);
    assert.equal(f.store.getRotationState('repo-1').weights.revision, first.weights.revision + 1);
    const newTag = f.store.createTag({ displayName: 'New membership' });
    assert.equal(f.store.getRotationState('repo-1').weights.revision, first.weights.revision + 2);
    f.store.deleteTag(newTag.id, newTag.revision);
    assert.equal(f.store.getRotationState('repo-1').weights.revision, first.weights.revision + 3);
  } finally { f.close(); }
});

class LocalClock implements Clock {
  at = new Date('2026-03-28T23:00:00Z'); elapsed = 0;
  wallNow() { return new Date(this.at); }
  monotonicMs() { return this.elapsed; }
  localDayKey(at: Date) { return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at); }
  set(value: string) { this.elapsed += Math.max(0, Date.parse(value) - this.at.getTime()); this.at = new Date(value); }
}

test('local_day_limits_and_sleep_do_not_replay', async () => {
  for (const [start, end, next] of [
    ['2026-03-28T23:00:00Z', '2026-03-29T21:59:59Z', '2026-03-29T22:00:00Z'], // 23-hour local day
    ['2026-10-24T22:00:00Z', '2026-10-25T22:59:59Z', '2026-10-25T23:00:00Z'], // 25-hour local day
  ]) {
    const clock = new LocalClock(); clock.set(start!);
    const f = createFixture({ clock });
    try {
      ready(f); activate(f); cancelSeed(f);
      const s = scheduler(f, { clock });
      for (let i = 0; i < 99; i++) {
        const result = await s.dispatch('takt'); assert.equal(result.kind, 'started');
        if (result.kind !== 'started') throw new Error('Expected start'); finish(f, result.attemptId);
      }
      const settings = f.store.getSettings();
      f.store.patchSettings({ limits: { ...settings.config.limits, concurrency: 2 } }, settings.revision);
      const pending = await scheduler(f, { clock, start: async () => ({ kind: 'unknown', code: 'lost', recovery: 'Reconcile workflow identity' }) }).dispatch('takt');
      assert.equal(pending.kind, 'noop');
      clock.set(end!);
      assert.equal((await s.dispatch('takt')).kind, 'noop');
      const held = f.store.getReservations().find(value => value.status === 'pending')!;
      f.store.confirmStart(held.id, { workflow: { executionId: 'hundredth', namespace: 'fixture', flowId: 'quality', revision: '1' } });
      finish(f, held.attempt.id);
      assert.equal(f.store.getQuotaState().confirmed, 100);
      clock.set(start!); // reversal within the same day
      assert.equal((await s.dispatch('takt')).kind, 'noop');
      clock.set(new Date(Date.parse(start!) - 48 * 3600000).toISOString()); // reversal into an older date
      assert.equal((await s.dispatch('takt')).kind, 'noop');
      clock.set(next!);
      const result = await s.dispatch('takt'); assert.equal(result.kind, 'started');
      if (result.kind !== 'started') throw new Error('Expected start'); finish(f, result.attemptId);
      clock.set(new Date(Date.parse(next!) + 7 * 86400000).toISOString());
      assert.equal((await s.dispatch('takt')).kind, 'started');
      assert.equal(f.store.getQuotaState().confirmed, 1); // one current dispatch, no missed-tick replay
      assert.equal(f.store.snapshot().attempts.filter(attempt => attempt.startedAt).length, 102);
    } finally { f.close(); }
  }
});

test('post_launch_gate_changes_account_for_actual_starts_without_overwriting_newer_rotation', async () => {
  for (const gate of ['pause', 'activation', 'grant', 'readiness', 'weights', 'control'] as const) {
    const f = createFixture();
    try {
      ready(f); activate(f); cancelSeed(f);
      const before = f.store.getRotationState('repo-1');
      const result = await scheduler(f, { start: async reservation => {
        if (gate === 'pause') f.store.patchSettings({ paused: true }, f.store.getSettings().revision);
        if (gate === 'control') f.store.setRepositoryControl('repo-1', 'human', f.store.getRepository('repo-1')!.revision);
        if (gate === 'activation') f.store.patchRepository('repo-1', { active: false }, f.store.getRepository('repo-1')!.revision);
        if (gate === 'grant') f.store.revokeGrant('grant-1');
        if (gate === 'readiness') { const recipe = f.store.snapshot().recipes[0]!; f.store.setRecipeReadiness(recipe.id, recipe.currentRevision, { hash: f.recipe.hash, ready: false, reasons: ['Revalidation required'] }, recipe.revision); }
        if (gate === 'weights') f.store.patchWeights('repo-1', { weights: { [f.recipe.tagId]: 90 } }, f.store.getRepository('repo-1')!.revision);
        return { kind: 'started', identity: { workflow: { executionId: reservation.attempt.id, namespace: 'fixture', flowId: 'quality', revision: '1' } } };
      } }).dispatch('takt');
      assert.equal(result.kind, 'started', gate);
      const reservation = f.store.getReservations()[0]!;
      assert.equal(reservation.status, 'confirmed', gate);
      assert.equal(reservation.externalIdentity!.workflow.executionId, reservation.attempt.id, gate);
      assert.ok(reservation.attempt.startedAt, gate);
      assert.deepEqual(f.store.getQuotaState(), { dayKey: '2026-11-04', confirmed: 1, pending: 0 }, gate);
      if (gate === 'weights') assert.deepEqual(f.store.getRotationState('repo-1').cursor, before.cursor, gate);
      else assert.ok(f.store.getRotationState('repo-1').cursor, gate);
      assert.equal(f.store.snapshot().attention.length, 1, gate);
      f.store.confirmStart(reservation.id, reservation.externalIdentity!);
      assert.equal(f.store.getQuotaState().confirmed, 1, gate);
      assert.throws(() => f.store.releaseUnstarted(reservation.id), { code: 'already_started' }, gate);
      f.reopen(); assert.equal(f.store.getReservations()[0]!.externalIdentity!.workflow.executionId, reservation.attempt.id);
    } finally { f.close(); }
  }
});

test('global_capacity_and_pending_day_quota_are_enforced_across_repositories', async () => {
  const f = createFixture();
  try {
    ready(f); activate(f); activate(f, 'repo-2');
    const settings = f.store.getSettings();
    f.store.patchSettings({ limits: { ...settings.config.limits, concurrency: 2, startsPerDay: 1 } }, settings.revision);
    const result = await scheduler(f, { start: async () => ({ kind: 'unknown', code: 'unknown', recovery: 'Reconcile' }) }).dispatch('manual');
    assert.equal(result.kind, 'noop');
    const blocked = await scheduler(f).dispatch('manual');
    assert.equal(blocked.kind === 'noop' && blocked.code, 'day_limit');
    const reservation = f.store.getReservations()[0]!;
    f.store.releaseUnstarted(reservation.id); // explicit reconciliation establishes no external launch
    const started = await scheduler(f).dispatch('manual'); assert.equal(started.kind, 'started');
    assert.equal(f.store.getReservations()[1]!.lease.fence, 2);
    assert.throws(() => f.store.releaseAdmissionLease(f.store.getReservations()[1]!.id, 1));
    assert.throws(() => f.store.releaseAdmissionLease(f.store.getReservations()[1]!.id, 2));
  } finally { f.close(); }
});

test('queued_task_order_is_oldest_first_and_manual_priority_crosses_repository_fairness', async () => {
  const f = createFixture();
  try {
    ready(f); activate(f); activate(f, 'repo-2');
    const first = await scheduler(f).dispatch('manual'); assert.equal(first.kind, 'started');
    if (first.kind !== 'started') throw new Error('Expected start'); finish(f, first.attemptId);
    const [oldest] = f.store.createManualTasks(f.request, 'oldest');
    f.clock.advance(1000);
    f.store.createManualTasks(f.request, 'newer');
    const next = await scheduler(f).dispatch('takt'); assert.equal(next.kind, 'started');
    assert.equal(f.store.snapshot().attempts.at(-1)!.taskId, oldest!.id); // repo-2 is less serviced but manual repo-1 wins
    assert.equal(f.store.getQuotaState().confirmed, 2);
  } finally { f.close(); }
});

test('a_validated_pinned_queue_survives_current_recipe_update_and_requires_exact_revision_grants', async () => {
  const f = createFixture();
  try {
    ready(f);
    const summary = f.store.snapshot().recipes[0]!;
    assert.throws(() => f.store.setRecipeReadiness(summary.id, 'rev-1', { hash: 'wrong-hash', ready: true, reasons: [] }, summary.revision));
    const oldSummary = f.store.snapshot().recipes[0]!;
    const newer = recipeFixture(f.recipe.tagId, 'rev-2');
    f.store.saveRecipeRevision(newer, oldSummary.revision);
    assert.equal(f.store.snapshot().recipes[0]!.ready, false);
    const result = await scheduler(f).dispatch('manual');
    assert.equal(result.kind, 'started');
    assert.equal(f.store.snapshot().attempts[0]!.taskId, f.task.id);
    assert.equal(f.store.snapshot().attempts[0]!.recipeRevision, 'rev-1');
    if (result.kind !== 'started') throw new Error('Expected pinned start'); finish(f, result.attemptId);
    const [other] = f.store.createManualTasks(f.request, 'new-revision');
    assert.equal((await scheduler(f).dispatch('manual')).kind, 'noop'); // new revision is unready
    ready(f);
    assert.equal((await scheduler(f).dispatch('manual')).kind, 'noop'); // only rev-1 grant exists
    f.store.saveGrant({ ...f.store.getAdmissionState().grants[0]!, id: 'grant-new', recipeRevision: 'rev-2' });
    const next = await scheduler(f).dispatch('manual'); assert.equal(next.kind, 'started');
    assert.equal(f.store.snapshot().attempts.at(-1)!.taskId, other!.id);
  } finally { f.close(); }
});

test('pending_prior_day_launches_hold_the_new_day_budget_and_confirm_on_observed_day', async () => {
  const f = createFixture();
  try {
    ready(f); activate(f); activate(f, 'repo-2');
    const settings = f.store.getSettings();
    f.store.patchSettings({ limits: { ...settings.config.limits, concurrency: 2, startsPerDay: 2 } }, settings.revision);
    await scheduler(f, { start: async () => ({ kind: 'unknown', code: 'lost', recovery: 'Reconcile' }) }).dispatch('manual');
    const pending = f.store.getReservations()[0]!;
    f.clock.advance(24 * 3600000);
    assert.deepEqual(f.store.getQuotaState(), { dayKey: '2026-11-05', confirmed: 0, pending: 1 });
    f.reopen();
    const result = await scheduler(f).dispatch('takt'); assert.equal(result.kind, 'started');
    if (result.kind !== 'started') throw new Error('Expected start'); finish(f, result.attemptId);
    const blocked = await scheduler(f).dispatch('takt'); assert.equal(blocked.kind === 'noop' && blocked.code, 'day_limit');
    f.store.confirmStart(pending.id, { workflow: { executionId: 'found-next-day', namespace: 'fixture', flowId: 'quality', revision: '1' } });
    assert.deepEqual(f.store.getQuotaState(), { dayKey: '2026-11-05', confirmed: 2, pending: 0 });
    assert.equal(f.store.getReservations()[0]!.quota.dayKey, '2026-11-04');
    assert.equal(f.store.getReservations()[0]!.quota.confirmedDayKey, '2026-11-05');
    f.clock.advance(-48 * 3600000);
    assert.equal((await scheduler(f).dispatch('takt')).kind, 'noop');
    assert.deepEqual(f.store.getQuotaState(), { dayKey: '2026-11-05', confirmed: 2, pending: 0 });
  } finally { f.close(); }
});

test('pending_launch_keeps_its_pinned_revision_when_its_tag_is_archived', async () => {
  const f = createFixture();
  try {
    ready(f);
    await scheduler(f, { start: async () => ({ kind: 'unknown', code: 'lost', recovery: 'Reconcile' }) }).dispatch('manual');
    const reservation = f.store.getReservations()[0]!;
    const replacement = f.store.createTag({ displayName: 'Replacement' });
    f.store.archiveTag(f.recipe.tagId, replacement.id);
    const task = f.store.getTask(f.task.id)!;
    assert.equal(task.spec.tagId, f.recipe.tagId);
    assert.equal(task.spec.recipeRevision, 'rev-1');
    f.store.confirmStart(reservation.id, { workflow: { executionId: 'found', namespace: 'fixture', flowId: 'quality', revision: '1' } });
    assert.equal(f.store.getQuotaState().confirmed, 1);
    assert.equal(f.store.snapshot().attention.length, 1);
  } finally { f.close(); }
});

test('pending_reservation_freezes_user_edits_and_cancellation_until_definitive_no_launch', async () => {
  const f = createFixture();
  try {
    ready(f);
    await scheduler(f, { start: async () => ({ kind: 'unknown', code: 'lost', recovery: 'Reconcile' }) }).dispatch('manual');
    const before = f.store.getTask(f.task.id)!;
    const reservation = f.store.getReservations()[0]!;
    assert.equal(before.status, 'queued');
    for (const patch of [{ title: 'Edited' }, { ownerId: 'other' }, { providerId: 'codex' as const }, { status: 'cancelled' as const }]) {
      assert.throws(() => f.store.patchTask(f.task.id, patch, before.revision), { code: 'task_reserved' });
    }
    assert.deepEqual(f.store.getTask(f.task.id), before);
    assert.deepEqual(f.store.getReservations()[0], reservation);
    f.store.releaseUnstarted(reservation.id); // a trusted reconciler has established no external execution
    const edited = f.store.patchTask(f.task.id, { title: 'Safe edit' }, before.revision);
    assert.equal(edited.spec.title, 'Safe edit');
    assert.equal(f.store.getQuotaState().confirmed, 0);
  } finally { f.close(); }
});
