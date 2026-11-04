import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/storage/store.ts';
import { validateContract } from '../../src/contracts/schemas.ts';
import { createFixture } from '../helpers/store.ts';
import { materializeFixture, recipeFixture } from '../helpers/fixtures.ts';

test('persists_revisions_and_deduplicates_open_findings', () => {
  const f = createFixture();
  try {
    const request = { ...f.request, repositoryIds: ['repo-1', 'repo-2'] };
    const tasks = f.store.createTasks(request, f.actor, 'children');
    assert.deepEqual(f.store.createTasks(request, f.actor, 'children'), tasks);
    assert.equal(tasks.length, 2);
    assert.ok(tasks[0]!.parentId);
    assert.equal(tasks[0]!.parentId, tasks[1]!.parentId);
    assert.deepEqual(f.store.getSubmission(tasks[0]!.parentId!)!.childTaskIds, tasks.map(task => task.id));
    const input = { repositoryId: 'repo-1', recipeId: 'recipe-1', findingKey: 'quality:one', task: { ...tasks[0]!, id: 'finding-1' } };
    const firstFinding = f.store.upsertFinding(input, f.actor, 'finding');
    const repeatedFinding = f.store.upsertFinding({ ...input, task: { ...input.task, id: 'ignored', acceptanceCriteria: ['Different'] } }, f.actor, 'finding-again');
    assert.equal(repeatedFinding.id, firstFinding.id);
    assert.deepEqual(repeatedFinding.acceptanceCriteria, ['Checks pass']);
    f.store.setTaskStatus(firstFinding.id, 'completed', 1);
    const closedRecurrence = f.store.upsertFinding({ ...input, task: { ...input.task, id: 'finding-2' } }, f.actor, 'recurrence');
    assert.notEqual(closedRecurrence.id, firstFinding.id);
    assert.equal(closedRecurrence.parentId, firstFinding.id);
    const originalRevision = tasks[0]!.recipeRevision;
    f.store.saveRecipeRevision(recipeFixture(f.recipe.tagId, 'rev-2'), 1);
    const reopenedTask = f.reopen().getTask(tasks[0]!.id)!;
    assert.equal(reopenedTask.spec.recipeRevision, originalRevision);
    assert.equal(f.store.getRecipeRevision('recipe-1', 'rev-1')!.revision, 'rev-1');
    assert.equal(f.store.getTaskHistory(firstFinding.id).length, 2);
    assert.equal(f.store.getTaskHistory(firstFinding.id)[0]!.status, 'queued');
    assert.equal(f.store.upsertFinding(input, f.actor, 'finding').id, firstFinding.id);
    validateContract('FactorySnapshot', f.store.snapshot());
  } finally { f.close(); }
});

test('archives_used_tags_without_rewriting_history', () => {
  const f = createFixture();
  try {
    const queued = f.store.createTasks(f.request, f.actor, 'queued')[0]!;
    const running = f.store.createTasks(f.request, f.actor, 'running')[0]!;
    const completed = f.store.createTasks(f.request, f.actor, 'completed')[0]!;
    f.store.setTaskStatus(running.id, 'running', 1);
    f.store.setTaskStatus(completed.id, 'completed', 1);
    const replacement = f.store.createTag({ displayName: 'Custom category' });
    assert.throws(() => f.store.archiveTag(f.recipe.tagId, 'absent'));
    assert.throws(() => f.store.archiveTag(f.recipe.tagId, f.recipe.tagId));
    const before = f.store.snapshot().sequence;
    f.store.archiveTag(f.recipe.tagId, replacement.id);
    assert.equal(f.store.getTask(queued.id)!.spec.tagId, replacement.id);
    const queuedRevision = f.store.getRecipeRevision('recipe-1', f.store.getTask(queued.id)!.spec.recipeRevision)!;
    assert.equal(queuedRevision.tagId, replacement.id);
    assert.equal(f.store.getTaskHistory(queued.id)[0]!.spec.tagId, f.recipe.tagId);
    assert.equal(f.store.getTask(running.id)!.spec.tagId, f.recipe.tagId);
    assert.equal(f.store.getTask(completed.id)!.spec.tagId, f.recipe.tagId);
    const recipe = f.store.getRecipe('recipe-1')!;
    assert.equal(recipe.tagId, replacement.id);
    assert.notEqual(recipe.revision, 'rev-1');
    assert.equal(f.store.getRecipeRevision('recipe-1', 'rev-1')!.tagId, f.recipe.tagId);
    assert.equal(f.store.getRecipeRevision('recipe-1', 'rev-1')!.yaml, f.recipe.yaml);
    assert.deepEqual(recipe.contract, { ...f.recipe.contract, variables: { ...f.recipe.contract.variables, sf: { ...f.recipe.contract.variables.sf, tagId: replacement.id } } });
    assert.deepEqual(JSON.parse(recipe.yaml), recipe.contract);
    assert.equal(f.store.snapshot().recipes[0]!.ready, false);
    assert.throws(() => f.store.createTasks(f.request, f.actor, 'scope-after-reassignment'), /scope|revision|archived/i);
    assert.ok(f.store.snapshot().sequence > before);
    assert.throws(() => f.store.patchTask(f.task.id, { title: 'Unrelated' }, 2, { ...f.actor, recipeId: 'other' }, 'bad'));
    f.reopen();
    assert.equal(f.store.getTask(queued.id)!.spec.tagId, replacement.id);

  } finally { f.close(); }
});

test('seeds_default_tags_without_reserving_categories', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sf-tags-'));
  const path = join(directory, 'factory.sqlite');
  let store = openStore(path);
  try {
    assert.deepEqual(store.snapshot().tags.map(tag => tag.displayName), ['Performance', 'Bug Fixes', 'Features', 'Wiz Fixes', 'SonarQube Fixes', 'Research', 'Improve Codebase Quality']);
    const tag = store.snapshot().tags[0]!;
    store.patchTag(tag.id, { displayName: 'My own category' }, 1);
    const custom = store.createTag({ displayName: 'My custom' });
    store.close(); store = openStore(path);
    assert.equal(store.snapshot().tags.length, 8);
    assert.equal(store.snapshot().tags.find(tag => tag.id === custom.id)!.displayName, 'My custom');
    assert.equal(store.snapshot().tags.find(item => item.id === tag.id)!.displayName, 'My own category');
    store.deleteTag(custom.id, 1);
    assert.equal(store.snapshot().tags.length, 7);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('rolls back all children and events when materialization fails or changes inherited authority', () => {
  let failRepo: string | undefined;
  const f = createFixture({ materialize(context) { const task = materializeFixture(context); return context.repository.id === failRepo ? { ...task, tagId: 'invented' } : task; } });
  try {
    failRepo = 'repo-2';
    const before = f.store.snapshot();
    assert.throws(() => f.store.createTasks({ ...f.request, repositoryIds: ['repo-1', 'repo-2'] }, f.actor, 'atomic'), /tag|materializ/i);
    assert.deepEqual(f.store.snapshot(), before);
    failRepo = undefined;
    assert.equal(f.store.createTasks({ ...f.request, repositoryIds: ['repo-1', 'repo-2'] }, f.actor, 'atomic').length, 2);
    assert.throws(() => f.store.createTasks({ ...f.request, title: 'Changed' }, f.actor, 'atomic'), /idempotency/i);
    assert.throws(() => f.store.saveRecipeRevision({ ...f.recipe, description: 'Mutate history' }, 1), /immutable|revision/i);
  } finally { f.close(); }
});

test('enforces persisted actor scope expiry fence grants and ownership before replay', () => {
  const f = createFixture();
  try {
    const child = f.store.createTasks(f.request, f.actor, 'child')[0]!;
    const unrelated = f.store.createManualTasks(f.request, 'unrelated')[0]!;
    assert.throws(() => f.store.patchTask(unrelated.id, { title: 'Hijack' }, 1, f.actor, 'hijack'), /scope|unrelated|owned/i);
    assert.throws(() => f.store.createTasks({ ...f.request, repositoryIds: ['absent'] }, f.actor, 'outside'), /scope/i);
    assert.throws(() => f.store.createTasks(f.request, { ...f.actor, fence: 2 }, 'child'), /scope|fence/i);
    assert.throws(() => f.store.createTasks(f.request, { ...f.actor, grantIds: [] }, 'child'), /scope|grant/i);
    const updated = f.store.patchTask(child.id, { title: 'Updated' }, 1, f.actor, 'edit');
    assert.equal(updated.spec.title, 'Updated');
    assert.deepEqual(f.store.patchTask(child.id, { title: 'Updated' }, 1, f.actor, 'edit'), updated);
    assert.throws(() => f.store.patchTask(child.id, { description: 'Stale' }, 1, f.actor, 'stale'), /revision/i);
    assert.throws(() => f.store.patchTask(child.id, { finishPolicy: 'merge_bypass' }, 2, f.actor, 'elevate'), /authority|finish|worker/i);
    f.store.revokeGrant('grant-1');
    assert.throws(() => f.store.createTasks(f.request, f.actor, 'child'), /grant/i);
    f.clock.advance(2 * 24 * 60 * 60 * 1000);
    assert.throws(() => f.store.getTask(child.id, f.actor), /expired/i);
  } finally { f.close(); }
});

test('rejects malformed materializer output and absent materializer without invented tasks', () => {
  const f = createFixture();
  try {
    f.store.close();
    const noMaterializer = openStore(f.path, { clock: f.clock });
    assert.throws(() => noMaterializer.createManualTasks(f.request, 'missing'), /materializ/i);
    noMaterializer.close();
    const malformed = openStore(f.path, { clock: f.clock, materialize(context) { return { ...materializeFixture(context), goal: '' }; } });
    assert.throws(() => malformed.createManualTasks(f.request, 'invalid'), /Invalid TaskSpec/i);
    malformed.close();
    f.reopen();
  } finally { f.close(); }
});

test('preserves independent weights and rejects stale CRUD and invalid references', () => {
  const f = createFixture();
  try {
    const [first, second] = f.store.snapshot().tags;
    const a = f.store.patchWeights('repo-1', { weights: { [first!.id]: 90, [second!.id]: 10 } }, 1);
    const b = f.store.patchWeights('repo-1', { weights: { [first!.id]: 80 } }, a.revision);
    assert.equal(b.weights[second!.id], 10);
    assert.throws(() => f.store.patchWeights('repo-1', { weights: { [first!.id]: 110 } }, b.revision));
    assert.throws(() => f.store.patchRepository('repo-1', { active: false }, 1), /revision/i);
    assert.equal(f.store.patchRepository('repo-1', { active: false }, b.revision).active, false);
    const settings = f.store.getSettings();
    assert.deepEqual(settings.config.limits, { concurrency: 1, activeMinutes: 30, startsPerDay: 100, transientRetries: 2 });
    assert.equal(f.store.patchSettings({ paused: true }, settings.revision).paused, true);
    assert.throws(() => f.store.patchSettings({ paused: false }, settings.revision), /revision/i);
    assert.throws(() => f.store.deleteTag(f.recipe.tagId, 1), /referenc|used/i);
    assert.throws(() => f.store.saveRecipeRevision(recipeFixture('absent', 'new'), 1));
    assert.equal(f.store.getRecipe('recipe-1')!.revision, 'rev-1');
    f.store.patchRecipe('recipe-1', { active: false }, 1);
    assert.throws(() => f.store.createManualTasks(f.request, 'inactive'), /active/i);
    f.store.setTaskStatus(f.task.id, 'running', 1);
    assert.throws(() => f.store.patchTask(f.task.id, { ownerId: 'another' }, 2), /running|immutable|queued/i);
  } finally { f.close(); }
});

test('persists durable events and idempotent outbox actions independently of delivery', () => {
  const f = createFixture();
  try {
    const snapshot = f.store.snapshot();
    const action = f.store.enqueueAction({ key: 'launch-1', kind: 'workflow.start', payload: { taskId: f.task.id } });
    assert.equal(f.store.enqueueAction({ key: 'launch-1', kind: 'workflow.start', payload: { taskId: f.task.id } }).id, action.id);
    assert.throws(() => f.store.enqueueAction({ key: 'launch-1', kind: 'native.start', payload: {} }), /idempotency/i);
    f.reopen();
    assert.equal(f.store.pendingActions()[0]!.id, action.id);
    f.store.completeAction(action.id);
    assert.equal(f.store.pendingActions().length, 0);
    const changed = f.store.patchTask(f.task.id, { title: 'After restart' }, 1);
    const events = f.store.eventsAfter(snapshot.sequence);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'task');
    assert.deepEqual(events[0]!.data, changed);
    assert.equal(f.store.snapshot().sequence, events[0]!.sequence);
    f.reopen();
    assert.equal(f.store.eventsAfter(snapshot.sequence)[0]!.cursor, events[0]!.cursor);
  } finally { f.close(); }
});

test('uses SQLite WAL foreign keys and immutable history with exclusive optimistic updates', () => {
  const f = createFixture();
  try {
    const second = openStore(f.path, { clock: f.clock, materialize: materializeFixture });
    f.store.patchTask(f.task.id, { title: 'First writer' }, 1);
    assert.throws(() => second.patchTask(f.task.id, { title: 'Stale writer' }, 1), /revision/i);
    second.close();
    const db = new DatabaseSync(f.path);
    assert.equal(db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.throws(() => db.prepare("UPDATE task_revisions SET payload = '{}' WHERE task_id = ?").run(f.task.id), /immutable/i);
    assert.throws(() => db.prepare("DELETE FROM recipe_revisions WHERE recipe_id = ?").run('recipe-1'), /immutable/i);
    db.close();
  } finally { f.close(); }
});

// Protects pinned queued revisions when the current recipe has changed independently.
test('retags_queued_pinned_revisions_without_replacing_the_current_recipe_template', () => {
  const f = createFixture();
  try {
    const queued = f.store.createTasks(f.request, f.actor, 'queued-old')[0]!;
    const newer = recipeFixture(f.recipe.tagId, 'rev-2');
    newer.contract.variables.sf.taskTemplate.goal = 'A new goal';
    f.store.saveRecipeRevision(newer, 1);
    const replacement = f.store.createTag({ displayName: 'Replacement' });
    f.store.archiveTag(f.recipe.tagId, replacement.id);
    const task = f.store.getTask(queued.id)!;
    assert.equal(task.spec.goal, 'Improve code quality');
    assert.equal(f.store.getRecipeRevision('recipe-1', task.spec.recipeRevision)!.tagId, replacement.id);
    assert.equal(f.store.getRecipeRevision('recipe-1', task.spec.recipeRevision)!.contract.variables.sf.taskTemplate.goal, 'Improve code quality');
    assert.equal(f.store.getRecipe('recipe-1')!.contract.variables.sf.taskTemplate.goal, 'A new goal');
  } finally { f.close(); }
});

test('a_registered_scope_cannot_outlive_its_pinned_task_revision_or_revoked_fence', () => {
  const f = createFixture();
  try {
    f.store.registerActor({ ...f.actor, fence: 2 }, f.task.id);
    assert.throws(() => f.store.createTasks(f.request, f.actor, 'stale-fence'), /scope|fence/i);
    assert.equal(f.store.createTasks(f.request, { ...f.actor, fence: 2 }, 'current-fence').length, 1);
    const replacement = f.store.createTag({ displayName: 'Replacement' });
    f.store.archiveTag(f.recipe.tagId, replacement.id);
    assert.throws(() => f.store.getTask(f.task.id, { ...f.actor, fence: 2 }), /scope|revision/i);
  } finally { f.close(); }
});

test('task_archive_retains_history_and_submission_status_is_derived_from_children', () => {
  const f = createFixture();
  try {
    const tasks = f.store.createManualTasks({ ...f.request, repositoryIds: ['repo-1', 'repo-2'] }, 'group');
    const group = tasks[0]!.parentId!;
    assert.equal(f.store.getSubmission(group)!.status, 'queued');
    assert.throws(() => f.store.archiveTask(tasks[0]!.id, 1), /live/i);
    f.store.setTaskStatus(tasks[0]!.id, 'running', 1);
    assert.equal(f.store.getSubmission(group)!.status, 'in_progress');
    f.store.setTaskStatus(tasks[0]!.id, 'completed', 2);
    f.store.setTaskStatus(tasks[1]!.id, 'completed', 1);
    assert.equal(f.store.getSubmission(group)!.status, 'completed');
    const archived = f.store.archiveTask(tasks[0]!.id, 3);
    assert.ok(archived.archivedAt);
    assert.equal(f.store.getTaskHistory(tasks[0]!.id).length, 4);
    f.reopen();
    assert.equal(f.store.getSubmission(group)!.status, 'completed');
  } finally { f.close(); }
});

test('archive_compare_and_swap_rejects_a_stale_tag_revision', () => {
  const f = createFixture();
  try {
    const tag = f.store.snapshot().tags.find(tag => tag.id === f.recipe.tagId)!;
    const replacement = f.store.createTag({ displayName: 'Replacement' });
    f.store.patchTag(tag.id, { displayName: 'Renamed meanwhile' }, tag.revision);
    assert.throws(() => f.store.archiveTag(tag.id, replacement.id, tag.revision), /revision/i);
    assert.equal(f.store.getTask(f.task.id)!.spec.tagId, tag.id);
    assert.equal(f.store.snapshot().tags.find(item => item.id === tag.id)!.archivedAt, undefined);
  } finally { f.close(); }
});

test('repository_creation_requires_explicit_autonomous_activation', () => {
  const f = createFixture();
  try {
    assert.equal(f.store.getRepository('repo-1')!.active, false);
    const explicitlyInactive = f.store.createRepository({ id: 'repo-off', name: 'Off', url: 'https://example.test/off.git', active: false });
    assert.equal(explicitlyInactive.active, false);
    const explicitlyActive = f.store.createRepository({ id: 'repo-on', name: 'On', url: 'https://example.test/on.git', active: true });
    assert.equal(explicitlyActive.active, true);
    const activated = f.store.patchRepository('repo-1', { active: true }, 1);
    assert.equal(activated.active, true);
    f.reopen();
    assert.equal(f.store.getRepository('repo-off')!.active, false);
    assert.equal(f.store.getRepository('repo-on')!.active, true);
    assert.equal(f.store.getRepository('repo-1')!.active, true);
  } finally { f.close(); }
});

test('manual_submission_to_inactive_repository_does_not_enable_autonomous_work', () => {
  const f = createFixture();
  try {
    f.store.patchRepository('repo-1', { active: false }, 1);
    const task = f.store.createManualTasks(f.request, 'manual-while-inactive')[0]!;
    assert.equal(task.repositoryId, 'repo-1');
    assert.equal(task.source, 'manual');
    assert.equal(f.store.getTask(task.id)!.status, 'queued');
    assert.equal(f.store.getRepository('repo-1')!.active, false);
    f.reopen();
    assert.equal(f.store.getRepository('repo-1')!.active, false);
    assert.equal(f.store.getTask(task.id)!.status, 'queued');
  } finally { f.close(); }
});
