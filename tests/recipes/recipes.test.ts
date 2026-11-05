import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApi } from '../../src/service/api.ts';
import { sanitize } from '../../src/service/snapshot.ts';
import { fakePorts } from '../helpers/fake-ports.ts';
import { openStore } from '../../src/storage/store.ts';
import { validateContract } from '../../src/contracts/schemas.ts';
import { validateRecipe } from '../../src/recipes/validate.ts';
import { RecipeRegistry, C5RecipePort, recipePayloadHash } from '../../src/recipes/registry.ts';
import { materializeTask, recipeMaterializer } from '../../src/recipes/materialize.ts';
import { parse } from 'yaml';
import type { RecipeContract } from '../../src/contracts/domain.ts';

function flow(tagId = 'tag') {
  const value = parse(readFileSync(new URL('../../recipes/starter/focused-feature.yaml', import.meta.url), 'utf8')) as RecipeContract;
  value.variables.sf.recipeId = 'recipe-test';
  value.variables.sf.tagId = tagId;
  value.variables.sf.compatibleOwners = ['vscode', 'bb'];
  value.variables.sf.defaultFinishPolicy = 'pr';
  value.variables.sf.required.allowedFinishPolicies = ['pr', 'result'];
  value.variables.sf.taskTemplate.context = {};
  value.variables.sf.taskTemplate.goal = 'Deliver {{ inputs.area }}: {{ title }}';
  value.variables.sf.inputSchema = { type: 'object', properties: { area: { type: 'string', default: 'feature' } }, additionalProperties: false };
  return value;
}
function setup() {
  const store = openStore(':memory:', { materialize: recipeMaterializer });
  const tag = store.snapshot().tags[0]!;
  store.createRepository({ id: 'repo', name: 'Repo', url: 'https://example.test/repo' });
  const registry = new RecipeRegistry(store, { resolveReference: () => true, executionReadiness: () => [] });
  const input = { yaml: JSON.stringify(flow(tag.id)), repositoryIds: ['repo'] };
  const port = new C5RecipePort(registry);
  return { store, registry, input, port };
}

test('materializes_one_tag_and_complete_task_without_extra_model_call', async () => {
  const f = setup();
  try {
    const context = { notes: 'x'.repeat(90000), files: ['src/main.ts'] };
    const source = flow(f.store.snapshot().tags[0]!.id); source.variables.sf.taskTemplate.context = context;
    const rev = await f.port.create({ ...f.input, yaml: JSON.stringify(source), inputDefaults: { area: 'payments' } }, { key: 'create' });
    const request = { recipeId: rev.recipeId, repositoryIds: ['repo'], title: 'A title', description: 'A description' };
    const task = materializeTask(request, rev, 'repo', { ownerId: 'vscode', providerId: 'copilot', finishPolicy: 'pr' });
    validateContract('TaskSpec', task);
    assert.equal(task.goal, 'Deliver payments: A title'); assert.equal(task.description, request.description);
    assert.equal(task.tagId, rev.tagId); assert.deepEqual(task.context, context); assert.equal('contextBudget' in task, false);
    assert.equal(task.finishPolicy, 'pr');
    assert.deepEqual(task, materializeTask(request, rev, 'repo', { ownerId: 'vscode', providerId: 'copilot', finishPolicy: 'pr' }));
    assert.throws(() => materializeTask({ ...request, ownerId: 'unsupported' }, rev, 'repo', { ownerId: 'vscode', providerId: 'copilot', finishPolicy: 'pr' }), /compatible/);
  } finally { f.store.close(); }
});

test('rejects_recipe_control_plane_escape', () => {
  const base = flow();
  const hostile = [
    { ...base, taskRunner: { type: 'docker' } }, { ...base, triggers: [] },
    { ...base, tasks: [{ id: 'evil', type: 'io.kestra.plugin.scripts.shell.Commands', commands: ['id'] }] },
    { ...base, tasks: [{ id: 'evil', type: 'io.kestra.plugin.core.flow.Subflow', namespace: 'admin', flowId: 'evil' }] },
    { ...base, tasks: [{ ...base.tasks[0], mounts: ['/var/run/docker.sock'] }] },
    { ...base, variables: { ...base.variables, evil: "{{ envs.SECRET }}" } },
    { ...base, variables: { sf: { ...base.variables.sf, privileged: true } } },
    { ...base, variables: { sf: { ...base.variables.sf, taskTemplate: { ...base.variables.sf.taskTemplate, goal: "{{ secret('KEY') }}" } } } },
  ];
  for (const value of hostile) assert.throws(() => validateRecipe(JSON.stringify(value), []));
  for (const yaml of ['a: &a [*a]', 'a: !evil value', 'id: one\nid: two', 'a: 1\n---\nb: 2', 'x'.repeat(512 * 1024 + 1)]) assert.throws(() => validateRecipe(yaml, []));
  assert.throws(() => validateRecipe(JSON.stringify({ ...base, variables: { sf: { ...base.variables.sf, inputSchema: { $ref: 'https://evil.test/schema' } } } }), []));
});

test('explicit_hash_bound_approval_atomic_activation_and_immutable_history', async () => {
  const f = setup();
  try {
    const rev = await f.port.create({ ...f.input, inputDefaults: { area: 'payments' } }, { key: 'create' });
    let summary = f.store.snapshot().recipes[0]!;
    assert.equal(summary.ready, false); assert.equal(summary.active, false); assert.equal(f.store.getAdmissionState().grants.length, 0);
    const approval = { recipeHash: rev.hash, payloadHash: recipePayloadHash(rev), repositoryIds: rev.repositoryIds, capabilities: rev.contract.variables.sf.required };
    await assert.rejects(f.port.patch(rev.recipeId, { active: true }, { key: 'no-approval', expectedRevision: summary.revision }));
    await assert.rejects(f.port.patch(rev.recipeId, { active: true, approval: { ...approval, recipeHash: 'sha256:stale' } }, { key: 'stale', expectedRevision: summary.revision }));
    assert.equal(f.store.getAdmissionState().grants.length, 0);
    summary = await f.port.patch(rev.recipeId, { active: true, approval }, { key: 'approve', expectedRevision: summary.revision });
    assert.equal(summary.ready, true); assert.equal(summary.active, true);
    assert.equal(f.store.getAdmissionState().grants.length, 1);
    assert.deepEqual(await f.port.patch(rev.recipeId, { active: true, approval }, { key: 'approve', expectedRevision: summary.revision - 2 }), summary);
    const draft = await f.port.validate({ yaml: f.input.yaml + '\n' }, { key: 'draft' });
    assert.equal(draft.payloadHash, recipePayloadHash({ yaml: f.input.yaml + '\n', inputDefaults: rev.inputDefaults, repositoryIds: rev.repositoryIds }));
    const edited = await f.port.revise(rev.recipeId, { ...f.input, yaml: f.input.yaml.replace('Verify boundaries', 'New goal') + '\n' }, { key: 'edit', expectedRevision: summary.revision });
    assert.deepEqual(edited.inputDefaults, { area: 'payments' });
    assert.notEqual(edited.hash, rev.hash); assert.deepEqual(f.store.getRecipeRevision(rev.recipeId, rev.revision), rev);
    assert.equal(f.store.snapshot().recipes[0]!.ready, false);
    assert.equal(f.store.getAdmissionState().grants[0]!.recipeRevision, rev.revision);
    assert.deepEqual(await f.port.reconcile({ key: 'create', method: 'POST', path: '/v1/recipes' }), { state: 'complete', body: rev });
    assert.deepEqual(await f.port.reconcile({ key: 'missing', method: 'POST', path: '/v1/recipes' }), { state: 'pending' });
  } finally { f.store.close(); }
});

test('validation_returns_actionable_errors_hash_and_missing_references_without_grants', async () => {
  const f = setup();
  try {
    const valid = await f.port.validate(f.input, { key: 'validate' });
    assert.equal(valid.valid, true); assert.equal(valid.hash, `sha256:${createHash('sha256').update(f.input.yaml).digest('hex')}`);
    assert.equal(valid.readiness?.ready, false);
    const invalid = await f.port.validate({ yaml: 'a: &a [*a]' }, { key: 'invalid' });
    assert.equal(invalid.valid, false); assert.ok(invalid.issues?.[0]?.line); assert.equal(f.store.snapshot().recipes.length, 0);
    const source = flow(f.store.snapshot().tags[0]!.id); source.variables.sf.taskTemplate.skills = ['review'];
    assert.throws(() => validateRecipe(JSON.stringify(source), []), /version/);
  } finally { f.store.close(); }
});

test('repository_owner_and_recipe_provider_overrides_persist_clear_and_freeze', async () => {
  const f = setup();
  try {
    const source = flow(f.store.snapshot().tags[0]!.id); source.variables.sf.defaultProviderId = 'codex';
    const rev = await f.port.create({ ...f.input, yaml: JSON.stringify(source) }, { key: 'create' });
    const summary = f.store.snapshot().recipes[0]!;
    await f.port.patch(rev.recipeId, { active: true, approval: { recipeHash: rev.hash, payloadHash: recipePayloadHash(rev), repositoryIds: ['repo'], capabilities: rev.contract.variables.sf.required } }, { key: 'approve', expectedRevision: summary.revision });
    f.store.patchRepository('repo', { defaultOwnerId: 'bb' }, 1);
    const request = { recipeId: rev.recipeId, repositoryIds: ['repo'], title: 'Title', description: 'Description' };
    const [task] = f.store.createManualTasks(request, 'task');
    assert.equal(task!.ownerId, 'bb'); assert.equal(task!.providerId, 'codex');
    f.store.patchRepository('repo', { defaultOwnerId: null }, 2);
    assert.equal(f.store.getRepository('repo')!.defaultOwnerId, undefined);
    assert.equal(f.store.getTask(task!.id)!.spec.ownerId, 'bb');
    const [override] = f.store.createManualTasks({ ...request, ownerId: 'vscode', providerId: 'copilot' }, 'override');
    assert.equal(override!.ownerId, 'vscode'); assert.equal(override!.providerId, 'copilot');
  } finally { f.store.close(); }
});

test('tag_archive_preserves_user_display_name', async () => {
  const f = setup();
  try {
    const rev = await f.port.create(f.input, { key: 'create' });
    let summary = f.store.snapshot().recipes[0]!;
    summary = await f.port.patch(rev.recipeId, { active: true, displayName: 'My alias', approval: { recipeHash: rev.hash, payloadHash: recipePayloadHash(rev), repositoryIds: ['repo'], capabilities: rev.contract.variables.sf.required } }, { key: 'approve', expectedRevision: summary.revision });
    const replacement = f.store.createTag({ displayName: 'Replacement' });
    f.store.archiveTag(rev.tagId, replacement.id);
    assert.equal(f.store.snapshot().recipes[0]!.displayName, 'My alias');
    assert.equal(f.store.getRecipeRevision(rev.recipeId, rev.revision)!.name, rev.name);
    validateRecipe(f.store.getRecipe(rev.recipeId)!.yaml, []);
  } finally { f.store.close(); }
});

test('activation_failure_rolls_back_grant_and_events_and_replays_exact_failure', async () => {
  const f = setup();
  try {
    const rev = await f.port.create(f.input, { key: 'create' });
    const summary = f.store.snapshot().recipes[0]!;
    const unavailable = new C5RecipePort(new RecipeRegistry(f.store));
    const before = f.store.snapshot();
    const input = { active: true, approval: { recipeHash: rev.hash, payloadHash: recipePayloadHash(rev), repositoryIds: ['repo'], capabilities: rev.contract.variables.sf.required } };
    await assert.rejects(unavailable.patch(rev.recipeId, input, { key: 'unavailable', expectedRevision: summary.revision }), /Definitive/);
    assert.deepEqual({ ...f.store.snapshot(), at: before.at }, before); assert.equal(f.store.getAdmissionState().grants.length, 0);
    const outcome = await unavailable.reconcile({ key: 'unavailable', method: 'PATCH', path: `/v1/recipes/${rev.recipeId}` });
    assert.equal(outcome.state, 'failed');
    await assert.rejects(f.port.patch(rev.recipeId, input, { key: 'unavailable', expectedRevision: summary.revision }), /Definitive/);
    assert.equal(f.store.getAdmissionState().grants.length, 0);
  } finally { f.store.close(); }
});

test('revocation_updates_exact_revision_readiness_and_prevents_reactivation', async () => {
  const f = setup();
  try {
    const rev = await f.port.create(f.input, { key: 'create' }); const summary = f.store.snapshot().recipes[0]!;
    await f.port.patch(rev.recipeId, { active: true, approval: { recipeHash: rev.hash, payloadHash: recipePayloadHash(rev), repositoryIds: ['repo'], capabilities: rev.contract.variables.sf.required } }, { key: 'approve', expectedRevision: summary.revision });
    const grant = f.store.getAdmissionState().grants[0]!;
    f.registry.revokeGrant(grant.id, 'revoke');
    const blocked = f.store.snapshot().recipes[0]!; assert.equal(blocked.ready, false);
    assert.ok(f.store.getAdmissionState().grants[0]!.revokedAt);
    await assert.rejects(f.port.patch(rev.recipeId, { active: true }, { key: 'reactivate', expectedRevision: blocked.revision }));
  } finally { f.store.close(); }
});

test('typed_inputs_reject_reserved_defaults_and_expand_context_once_without_evaluation', async () => {
  const f = setup();
  try {
    await assert.rejects(f.port.create({ ...f.input, inputDefaults: { sf_capability: 'stolen' } }, { key: 'reserved' }));
    const source = flow(f.store.snapshot().tags[0]!.id);
    source.variables.sf.taskTemplate.context = '{{ inputs.area }}';
    const rev = await f.port.create({ ...f.input, yaml: JSON.stringify(source) }, { key: 'create' });
    const task = materializeTask({ recipeId: rev.recipeId, repositoryIds: ['repo'], title: 'literal {{ secret() }}', description: 'Description', inputs: { area: '{{ envs.SECRET }}' } }, rev, 'repo', { ownerId: 'vscode', providerId: 'copilot', finishPolicy: 'pr' });
    assert.equal(task.context, '{{ envs.SECRET }}'); assert.equal(task.goal, 'Deliver {{ envs.SECRET }}: literal {{ secret() }}');
    assert.throws(() => materializeTask({ recipeId: rev.recipeId, repositoryIds: ['repo'], title: 'Title', description: 'Description', inputs: { area: 42 } }, rev, 'repo', { ownerId: 'vscode', providerId: 'copilot', finishPolicy: 'pr' }), /schema/);
  } finally { f.store.close(); }
});

test('starter_flows_use_only_fixed_broker_native_and_fresh_result_capability_graph', () => {
  for (const name of ['focused-feature', 'focused-bug-fix', 'scoped-quality']) {
    const recipe = validateRecipe(readFileSync(new URL(`../../recipes/starter/${name}.yaml`, import.meta.url), 'utf8'), []);
    const [start, pause, result] = recipe.contract.tasks;
    assert.equal(start!.uri, 'http://sf-broker:8080/worker/v1/native/start');
    assert.equal(result!.uri, 'http://sf-broker:8080/worker/v1/results');
    assert.equal((result!.headers as Record<string, string>).Authorization, 'Bearer {{ outputs.await_result.onResume.sf_result_capability }}');
    assert.equal((pause!.onResume as Record<string, unknown>[]).find(input => input.id === 'sf_result_capability')!.type, 'SECRET');
    for (const mutation of [
      { ...start, uri: 'http://evil.test/steal' }, { ...start, options: { followRedirects: true } },
      { ...start, headers: { Authorization: '{{ secret("ROOT") }}' } },
      { ...start, body: '{{ render(inputs.sf_native_start) }}' }, { ...start, taskRunner: { type: 'docker' } },
    ]) assert.throws(() => validateRecipe(JSON.stringify({ ...recipe.contract, tasks: [mutation, pause, result] }), []));
    assert.throws(() => validateRecipe(JSON.stringify({ ...recipe.contract, inputs: [...recipe.contract.inputs!, { id: 'sf_fence', type: 'INT', defaults: 1 }] }), []));
  }
});

test('reference_resolution_and_expired_grants_keep_valid_recipes_unready', async () => {
  const f = setup();
  try {
    const source = flow(f.store.snapshot().tags[0]!.id);
    source.variables.sf.taskTemplate.skills = ['review']; source.variables.sf.skillVersions = { review: '1.2.3' };
    const rev = await f.port.create({ ...f.input, yaml: JSON.stringify(source) }, { key: 'create' });
    const missing = new RecipeRegistry(f.store, { resolveReference: () => false, executionReadiness: () => [] });
    assert.ok(missing.readiness(rev).reasons.includes('Missing skill reference review@1.2.3'));
    f.store.saveGrant({ id: 'expired', recipeId: rev.recipeId, recipeRevision: rev.revision, repositoryIds: ['repo'], required: rev.contract.variables.sf.required, grantedAt: '2000-01-01T00:00:00Z', expiresAt: '2001-01-01T00:00:00Z' });
    assert.equal(f.registry.readiness(rev).approved, false);
    const summary = f.store.snapshot().recipes[0]!;
    await assert.rejects(f.port.patch(rev.recipeId, { active: true, approval: { recipeHash: rev.hash, payloadHash: 'sha256:stale-defaults', repositoryIds: ['repo'], capabilities: rev.contract.variables.sf.required } }, { key: 'bad-payload', expectedRevision: summary.revision }));
    await assert.rejects(f.port.patch(rev.recipeId, { active: true, approval: { recipeHash: rev.hash, payloadHash: recipePayloadHash(rev), repositoryIds: ['repo'], capabilities: { ...rev.contract.variables.sf.required, paths: [] } } }, { key: 'bad-caps', expectedRevision: summary.revision }));
    assert.equal(f.store.getAdmissionState().grants.length, 1);
  } finally { f.store.close(); }
});

test('actual_store_generated_children_inherit_one_tag_and_per_repository_hosts', async () => {
  const f = setup();
  try {
    f.store.createRepository({ id: 'repo2', name: 'Two', url: 'https://example.test/two' });
    f.store.patchRepository('repo2', { defaultOwnerId: 'bb' }, 1);
    const rev = await f.port.create({ ...f.input, repositoryIds: ['repo', 'repo2'] }, { key: 'create' });
    const summary = f.store.snapshot().recipes[0]!;
    await f.port.patch(rev.recipeId, { active: true, approval: { recipeHash: rev.hash, payloadHash: recipePayloadHash(rev), repositoryIds: rev.repositoryIds, capabilities: rev.contract.variables.sf.required } }, { key: 'approve', expectedRevision: summary.revision });
    const request = { title: 'Parent', description: 'Parent work', recipeId: rev.recipeId, repositoryIds: ['repo', 'repo2'] };
    const tasks = f.store.createManualTasks(request, 'multi');
    assert.deepEqual(tasks.map(task => task.ownerId), ['vscode', 'bb']);
    assert.ok(tasks.every(task => task.tagId === rev.tagId && task.parentId === tasks[0]!.parentId));
    const actor = { attemptId: 'attempt', repositoryIds: ['repo'], recipeId: rev.recipeId, recipeRevision: rev.revision, grantIds: [f.store.getAdmissionState().grants[0]!.id], expiresAt: '2099-01-01T00:00:00Z', fence: 1 };
    f.store.registerActor(actor, tasks[0]!.id);
    const [child] = f.store.createTasks({ ...request, title: 'Child', repositoryIds: ['repo'] }, actor, 'child');
    assert.equal(child!.tagId, rev.tagId); assert.equal(child!.parentId, tasks[0]!.id); assert.equal(child!.source, 'recipe');
    assert.deepEqual(f.store.getTask(tasks[0]!.id)!.childTaskIds, [child!.id]);
  } finally { f.store.close(); }
});

test('C5_actual_adapter_reconciles_committed_lost_reply_after_sqlite_restart_without_reimport', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sf-e1-')); const path = join(directory, 'state.sqlite');
  let store = openStore(path); let api: Awaited<ReturnType<typeof startApi>> | undefined;
  const origin = 'http://127.0.0.1:5173';
  try {
    store.createRepository({ id: 'repo', name: 'Repo', url: 'https://example.test/repo' });
    const input = { yaml: JSON.stringify(flow(store.snapshot().tags[0]!.id)), repositoryIds: ['repo'] };
    let port = new C5RecipePort(new RecipeRegistry(store, { executionReadiness: () => [] }));
    let effects = 0;
    api = await startApi({ ...fakePorts(store).deps, recipes: { ...port,
      create: async (input, ctx) => { effects++; await port.create(input, ctx); throw new Error('reply lost after commit'); },
      revise: (...args) => port.revise(...args), patch: (...args) => port.patch(...args), validate: (...args) => port.validate(...args),
    } });
    const call = async () => {
      const session = api!.sessions.provision(origin);
      return fetch(api!.url + '/v1/recipes', { method: 'POST', headers: { origin, cookie: session.cookie, 'x-sf-csrf': session.csrfToken, 'content-type': 'application/json', 'idempotency-key': 'lost-import' }, body: JSON.stringify(input) });
    };
    assert.equal((await call()).status, 503); assert.equal(store.snapshot().recipes.length, 1);
    const saved = store.getRecipe('recipe-test')!;
    store.patchRepository('repo', { defaultOwnerId: 'bb' }, 1);
    await api.close(); store.close(); store = openStore(path);
    assert.equal(store.getRepository('repo')!.defaultOwnerId, 'bb');
    store.patchRepository('repo', { defaultOwnerId: null }, 2);
    store.close(); store = openStore(path);
    assert.equal(store.getRepository('repo')!.defaultOwnerId, undefined);
    port = new C5RecipePort(new RecipeRegistry(store));
    api = await startApi({ ...fakePorts(store).deps, recipes: port, reconcileRequest: request => port.reconcile(request) });
    const recovered = await call(); assert.equal(recovered.status, 200); assert.deepEqual(await recovered.json(), saved);
    assert.equal((await call()).status, 200); assert.equal(effects, 1); assert.equal(store.snapshot().recipes.length, 1);
    assert.deepEqual(await port.reconcile({ key: 'lost-import', method: 'PATCH', path: '/v1/recipes/recipe-test' }), { state: 'pending' });
  } finally { await api?.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('refreshing_historical_readiness_preserves_current_unapproved_revision', async () => {
  const f = setup();
  try {
    const rev = await f.port.create(f.input, { key: 'create' }); let summary = f.store.snapshot().recipes[0]!;
    summary = await f.port.patch(rev.recipeId, { active: true, approval: { recipeHash: rev.hash, payloadHash: recipePayloadHash(rev), repositoryIds: rev.repositoryIds, capabilities: rev.contract.variables.sf.required } }, { key: 'approve', expectedRevision: summary.revision });
    const edited = await f.port.revise(rev.recipeId, { ...f.input, yaml: f.input.yaml + '\n' }, { key: 'edit', expectedRevision: summary.revision });
    f.registry.refreshReadiness(rev.recipeId, rev.revision, 'refresh-old');
    assert.equal(f.store.snapshot().recipes[0]!.currentRevision, edited.revision); assert.equal(f.store.snapshot().recipes[0]!.ready, false);
    assert.equal(f.store.getAdmissionState().recipeReadiness.find(record => record.recipeRevision === rev.revision)!.ready, true);
  } finally { f.store.close(); }
});

test('public_broker_template_redaction_preserves_editor_yaml_but_never_real_credentials', () => {
  const start = 'Bearer {{ inputs.sf_capability }}'; const result = 'Bearer {{ outputs.await_result.onResume.sf_result_capability }}';
  assert.equal(sanitize({ Authorization: start }).Authorization, start);
  assert.equal(sanitize({ Authorization: result }).Authorization, result);
  for (const value of ['Bearer real-token', 'Bearer {{ secret("TOKEN") }}', start + ' real-token', 'Bearer {{ inputs.attacker }}']) {
    assert.equal(sanitize({ Authorization: value }).Authorization, '[redacted]');
  }
  assert.equal(sanitize(`header: ${start}\nother: Bearer real-token`), `header: ${start}\nother: Bearer [redacted]`);
  assert.equal(sanitize('real-secret', ['real-secret']), '[redacted]');
});

test('reserved_authorization_scalar_spelling_is_canonical_for_lossless_redaction', () => {
  const yaml = readFileSync(new URL('../../recipes/starter/focused-feature.yaml', import.meta.url), 'utf8');
  const folded = yaml.replace('Authorization: Bearer {{ inputs.sf_capability }}', 'Authorization: >-\n        Bearer {{ inputs.sf_capability }}');
  assert.notEqual(folded, yaml);
  assert.throws(() => validateRecipe(folded, []), /canonical/);
  assert.equal(sanitize({ Authorization: 'Bearer {{ inputs.sf_capability }}' }, ['inputs.sf_capability']).Authorization, 'Bearer {{ [redacted] }}');
});
