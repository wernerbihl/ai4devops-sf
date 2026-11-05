import { boundRecipe, boundPatch, fixtureExecutionProfile } from '../helpers/recipe-validation.ts';
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
  const registry = new RecipeRegistry(store, { resolveReference: () => true, executionProfile: fixtureExecutionProfile, executionReadiness: () => [] });
  const input = { yaml: JSON.stringify(flow(tag.id)), repositoryIds: ['repo'] };
  const port = new C5RecipePort(registry);
  return { store, registry, input, port };
}

test('materializes_one_tag_and_complete_task_without_extra_model_call', async () => {
  const f = setup();
  try {
    const context = { notes: 'x'.repeat(90000), files: ['src/main.ts'] };
    const source = flow(f.store.snapshot().tags[0]!.id); source.variables.sf.taskTemplate.context = context;
    const rev = await f.port.create(boundRecipe(f.registry, { ...f.input, yaml: JSON.stringify(source), inputDefaults: { area: 'payments' } }), { key: 'create' });
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
    const rev = await f.port.create(boundRecipe(f.registry, { ...f.input, inputDefaults: { area: 'payments' } }), { key: 'create' });
    let summary = f.store.snapshot().recipes[0]!;
    assert.equal(summary.ready, false); assert.equal(summary.active, false); assert.equal(f.store.getAdmissionState().grants.length, 0);
    const approval = { recipeHash: rev.hash, payloadHash: recipePayloadHash(rev), repositoryIds: rev.repositoryIds, capabilities: rev.contract.variables.sf.required };
    await assert.rejects(f.port.patch(rev.recipeId, boundPatch(f.registry, rev.recipeId, { active: true }), { key: 'no-approval', expectedRevision: summary.revision }));
    await assert.rejects(f.port.patch(rev.recipeId, boundPatch(f.registry, rev.recipeId, { active: true, approval: { ...approval, recipeHash: 'sha256:stale' } }), { key: 'stale', expectedRevision: summary.revision }));
    assert.equal(f.store.getAdmissionState().grants.length, 0);
    summary = await f.port.patch(rev.recipeId, boundPatch(f.registry, rev.recipeId, { active: true, approval }), { key: 'approve', expectedRevision: summary.revision });
    assert.equal(summary.ready, true); assert.equal(summary.active, true);
    assert.equal(f.store.getAdmissionState().grants.length, 1);
    assert.deepEqual(await f.port.patch(rev.recipeId, boundPatch(f.registry, rev.recipeId, { active: true, approval }), { key: 'approve', expectedRevision: summary.revision - 2 }), summary);
    const draft = await f.port.validate({ yaml: f.input.yaml + '\n' }, { key: 'draft' });
    assert.equal(draft.payloadHash, recipePayloadHash({ yaml: f.input.yaml + '\n', inputDefaults: rev.inputDefaults, repositoryIds: rev.repositoryIds }));
    const edited = await f.port.revise(rev.recipeId, boundRecipe(f.registry, { ...f.input, yaml: f.input.yaml.replace('Verify boundaries', 'New goal') + '\n' }), { key: 'edit', expectedRevision: summary.revision });
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
    const rev = await f.port.create(boundRecipe(f.registry, { ...f.input, yaml: JSON.stringify(source) }), { key: 'create' });
    const summary = f.store.snapshot().recipes[0]!;
    await f.port.patch(rev.recipeId, boundPatch(f.registry, rev.recipeId, { active: true, approval: { recipeHash: rev.hash, payloadHash: recipePayloadHash(rev), repositoryIds: ['repo'], capabilities: rev.contract.variables.sf.required } }), { key: 'approve', expectedRevision: summary.revision });
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
    const rev = await f.port.create(boundRecipe(f.registry, f.input), { key: 'create' });
    let summary = f.store.snapshot().recipes[0]!;
    summary = await f.port.patch(rev.recipeId, boundPatch(f.registry, rev.recipeId, { active: true, displayName: 'My alias', approval: { recipeHash: rev.hash, payloadHash: recipePayloadHash(rev), repositoryIds: ['repo'], capabilities: rev.contract.variables.sf.required } }), { key: 'approve', expectedRevision: summary.revision });
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
    const rev = await f.port.create(boundRecipe(f.registry, f.input), { key: 'create' });
    const summary = f.store.snapshot().recipes[0]!;
    const unavailable = new C5RecipePort(new RecipeRegistry(f.store));
    const before = f.store.snapshot();
    const input = boundPatch(unavailable.registry, rev.recipeId, { active: true, approval: { recipeHash: rev.hash, payloadHash: recipePayloadHash(rev), repositoryIds: ['repo'], capabilities: rev.contract.variables.sf.required } });
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
    const rev = await f.port.create(boundRecipe(f.registry, f.input), { key: 'create' }); const summary = f.store.snapshot().recipes[0]!;
    await f.port.patch(rev.recipeId, boundPatch(f.registry, rev.recipeId, { active: true, approval: { recipeHash: rev.hash, payloadHash: recipePayloadHash(rev), repositoryIds: ['repo'], capabilities: rev.contract.variables.sf.required } }), { key: 'approve', expectedRevision: summary.revision });
    const grant = f.store.getAdmissionState().grants[0]!;
    f.registry.revokeGrant(grant.id, 'revoke');
    const blocked = f.store.snapshot().recipes[0]!; assert.equal(blocked.ready, false);
    assert.ok(f.store.getAdmissionState().grants[0]!.revokedAt);
    await assert.rejects(f.port.patch(rev.recipeId, boundPatch(f.registry, rev.recipeId, { active: true }), { key: 'reactivate', expectedRevision: blocked.revision }));
  } finally { f.store.close(); }
});

test('typed_inputs_reject_reserved_defaults_and_expand_context_once_without_evaluation', async () => {
  const f = setup();
  try {
    await assert.rejects(f.port.create(boundRecipe(f.registry, { ...f.input, inputDefaults: { sf_capability: 'stolen' } }), { key: 'reserved' }));
    const source = flow(f.store.snapshot().tags[0]!.id);
    source.variables.sf.taskTemplate.context = '{{ inputs.area }}';
    const rev = await f.port.create(boundRecipe(f.registry, { ...f.input, yaml: JSON.stringify(source) }), { key: 'create' });
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
    assert.equal(recipe.contract.inputs!.find(input => input.id === 'sf_native_start')!.type, 'STRING');
    assert.equal(start!.body, '{{ inputs.sf_native_start }}');
    assert.equal(result!.body, '{{ outputs.await_result.onResume.sf_result }}');
    assert.equal((pause!.onResume as Record<string, unknown>[]).find(input => input.id === 'sf_result')!.type, 'STRING');
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
    const rev = await f.port.create(boundRecipe(f.registry, { ...f.input, yaml: JSON.stringify(source) }), { key: 'create' });
    const missing = new RecipeRegistry(f.store, { resolveReference: () => false, executionProfile: fixtureExecutionProfile, executionReadiness: () => [] });
    assert.ok(missing.readiness(rev).reasons.includes('Missing skill reference review@1.2.3'));
    f.store.saveGrant({ id: 'expired', recipeId: rev.recipeId, recipeRevision: rev.revision, repositoryIds: ['repo'], required: rev.contract.variables.sf.required, grantedAt: '2000-01-01T00:00:00Z', expiresAt: '2001-01-01T00:00:00Z' });
    assert.equal(f.registry.readiness(rev).approved, false);
    const summary = f.store.snapshot().recipes[0]!;
    await assert.rejects(f.port.patch(rev.recipeId, boundPatch(f.registry, rev.recipeId, { active: true, approval: { recipeHash: rev.hash, payloadHash: 'sha256:stale-defaults', repositoryIds: ['repo'], capabilities: rev.contract.variables.sf.required } }), { key: 'bad-payload', expectedRevision: summary.revision }));
    await assert.rejects(f.port.patch(rev.recipeId, boundPatch(f.registry, rev.recipeId, { active: true, approval: { recipeHash: rev.hash, payloadHash: recipePayloadHash(rev), repositoryIds: ['repo'], capabilities: { ...rev.contract.variables.sf.required, paths: [] } } }), { key: 'bad-caps', expectedRevision: summary.revision }));
    assert.equal(f.store.getAdmissionState().grants.length, 1);
  } finally { f.store.close(); }
});

test('actual_store_generated_children_inherit_one_tag_and_per_repository_hosts', async () => {
  const f = setup();
  try {
    f.store.createRepository({ id: 'repo2', name: 'Two', url: 'https://example.test/two' });
    f.store.patchRepository('repo2', { defaultOwnerId: 'bb' }, 1);
    const rev = await f.port.create(boundRecipe(f.registry, { ...f.input, repositoryIds: ['repo', 'repo2'] }), { key: 'create' });
    const summary = f.store.snapshot().recipes[0]!;
    await f.port.patch(rev.recipeId, boundPatch(f.registry, rev.recipeId, { active: true, approval: { recipeHash: rev.hash, payloadHash: recipePayloadHash(rev), repositoryIds: rev.repositoryIds, capabilities: rev.contract.variables.sf.required } }), { key: 'approve', expectedRevision: summary.revision });
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
    let port = new C5RecipePort(new RecipeRegistry(store, { executionProfile: fixtureExecutionProfile, executionReadiness: () => [] }));
    const input = boundRecipe(port.registry, { yaml: JSON.stringify(flow(store.snapshot().tags[0]!.id)), repositoryIds: ['repo'] });
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
    const rev = await f.port.create(boundRecipe(f.registry, f.input), { key: 'create' }); let summary = f.store.snapshot().recipes[0]!;
    summary = await f.port.patch(rev.recipeId, boundPatch(f.registry, rev.recipeId, { active: true, approval: { recipeHash: rev.hash, payloadHash: recipePayloadHash(rev), repositoryIds: rev.repositoryIds, capabilities: rev.contract.variables.sf.required } }), { key: 'approve', expectedRevision: summary.revision });
    const edited = await f.port.revise(rev.recipeId, boundRecipe(f.registry, { ...f.input, yaml: f.input.yaml + '\n' }), { key: 'edit', expectedRevision: summary.revision });
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

test('unmaterializable_default_templates_cannot_validate_import_or_activate', async () => {
  const cases = [
    { name: 'optional-absent', schema: { type: 'string' }, field: 'goal' },
    { name: 'integer-goal', schema: { type: 'integer', default: 42 }, field: 'goal' },
    { name: 'empty-goal', schema: { type: 'string', default: '' }, field: 'goal' },
    { name: 'blank-criterion', schema: { type: 'string', default: ' ' }, field: 'acceptanceCriteria' },
    { name: 'object-goal', schema: { type: 'object', properties: {}, additionalProperties: false, default: {} }, field: 'goal' },
    { name: 'null-criterion', schema: { type: 'null', default: null }, field: 'acceptanceCriteria' },
  ];
  for (const scenario of cases) {
    const f = setup();
    try {
      const source = flow(f.store.snapshot().tags[0]!.id);
      source.variables.sf.inputSchema = { type: 'object', properties: { value: scenario.schema }, additionalProperties: false };
      source.variables.sf.taskTemplate.goal = 'A valid goal';
      if (scenario.field === 'goal') source.variables.sf.taskTemplate.goal = '{{ inputs.value }}';
      else source.variables.sf.taskTemplate.acceptanceCriteria = ['{{ inputs.value }}'];
      const input = { ...f.input, yaml: JSON.stringify(source) };
      assert.equal((await f.port.validate(input, { key: 'validate' })).valid, false, scenario.name);
      await assert.rejects(f.port.create(boundRecipe(f.registry, input), { key: 'invalid-import' }), scenario.name);
      assert.equal(f.store.snapshot().recipes.length, 0);
      // A revision persisted by an earlier trusted producer must not bypass the new readiness gate.
      const good = await f.port.create(boundRecipe(f.registry, f.input), { key: 'good' });
      const summary = f.store.snapshot().recipes[0]!;
      const invalid = { ...good, id: 'old-invalid', revision: 'old-invalid', yaml: input.yaml, contract: source,
        hash: `sha256:${createHash('sha256').update(input.yaml).digest('hex')}` };
      const stored = f.store.saveRecipeRevision(invalid, summary.revision);
      assert.equal(f.registry.readiness(invalid).ready, false, scenario.name);
      assert.ok(f.registry.readiness(invalid).reasons.some(reason => reason.startsWith('Default task cannot be materialized:')), scenario.name);
      await assert.rejects(f.port.patch(good.recipeId, boundPatch(f.registry, good.recipeId, { active: true, approval: {
        recipeHash: invalid.hash, payloadHash: recipePayloadHash(invalid), repositoryIds: invalid.repositoryIds, capabilities: invalid.contract.variables.sf.required,
      } }), { key: 'invalid-approval', expectedRevision: stored.revision }), scenario.name);
      assert.equal(f.store.snapshot().recipes[0]!.active, false); assert.equal(f.store.getAdmissionState().grants.length, 0);
    } finally { f.store.close(); }
  }
});

test('explicit_defaults_complete_the_template_and_task_input_overrides_still_validate', async () => {
  const f = setup();
  try {
    const source = flow(f.store.snapshot().tags[0]!.id);
    source.variables.sf.inputSchema = { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false };
    source.variables.sf.taskTemplate.goal = '{{ inputs.value }}';
    const input = { ...f.input, yaml: JSON.stringify(source), inputDefaults: { value: 'Stored goal' } };
    assert.equal((await f.port.validate(input, { key: 'validate' })).valid, true);
    const rev = await f.port.create(boundRecipe(f.registry, input), { key: 'create' }); const summary = f.store.snapshot().recipes[0]!;
    await f.port.patch(rev.recipeId, boundPatch(f.registry, rev.recipeId, { active: true, approval: { recipeHash: rev.hash, payloadHash: recipePayloadHash(rev), repositoryIds: rev.repositoryIds, capabilities: rev.contract.variables.sf.required } }), { key: 'approve', expectedRevision: summary.revision });
    const request = { recipeId: rev.recipeId, repositoryIds: ['repo'], title: 'Title', description: 'Description' };
    assert.equal(f.store.createManualTasks(request, 'default-task')[0]!.goal, 'Stored goal');
    assert.equal(f.store.createManualTasks({ ...request, inputs: { value: 'Task goal' } }, 'override-task')[0]!.goal, 'Task goal');
    assert.throws(() => f.store.createManualTasks({ ...request, inputs: { value: '' } }, 'bad-task'));
    assert.equal(f.store.snapshot().tasks.length, 2);
  } finally { f.store.close(); }
});


test('api_requires_exact_current_content_payload_and_profile_binding_before_any_write', async () => {
  const f = setup(); let api: Awaited<ReturnType<typeof startApi>> | undefined;
  let profile = { available: true, profileId: 'fixture-v2', hostCommit: 'reviewed-host-a' };
  const registry = new RecipeRegistry(f.store, { resolveReference: () => true, executionReadiness: () => [], executionProfile: () => profile });
  const port = new C5RecipePort(registry);
  try {
    api = await startApi({ ...fakePorts(f.store).deps, recipes: port, reconcileRequest: request => port.reconcile(request) });
    const origin = 'http://127.0.0.1:5173'; const session = api.sessions.provision(origin);
    const call = (path: string, body: unknown, key: string, revision?: number, method = 'POST') => fetch(api!.url + path, { method,
      headers: { origin, cookie: session.cookie, 'x-sf-csrf': session.csrfToken, 'content-type': 'application/json', 'idempotency-key': key,
        ...(revision === undefined ? {} : { 'if-match': String(revision) }) }, body: JSON.stringify(body) });
    const validation = await (await call('/v1/recipes/validate', f.input, 'validate')).json();
    assert.equal(validation.valid, true);
    const binding = { recipeHash: validation.hash, payloadHash: validation.payloadHash, executionProfileHash: validation.executionProfileHash };
    const before = f.store.snapshot();
    for (const [key, input] of [
      ['missing', f.input], ['content', { ...f.input, validation: { ...binding, recipeHash: 'wrong' } }],
      ['payload', { ...f.input, validation: { ...binding, payloadHash: 'wrong' } }],
      ['edited', { ...f.input, yaml: f.input.yaml + '\n', validation: binding }],
      ['scope', { ...f.input, repositoryIds: [], validation: binding }],
      ['defaults', { ...f.input, inputDefaults: { area: 'changed' }, validation: binding }],
    ] as const) {
      assert.equal((await call('/v1/recipes', input, key)).status, 400, key);
      assert.deepEqual({ ...f.store.snapshot(), at: before.at }, before, key);
      assert.equal(f.store.getAdmissionState().grants.length, 0);
    }
    assert.match(validation.executionProfileHash, /^sha256:[a-f0-9]{64}$/);
    profile = { ...profile, hostCommit: 'reviewed-host-b' };
    assert.equal((await call('/v1/recipes', { ...f.input, validation: binding }, 'profile')).status, 400);
    assert.equal(f.store.snapshot().recipes.length, 0);
    const fresh = await (await call('/v1/recipes/validate', f.input, 'fresh')).json();
    const proof = { ...binding, executionProfileHash: fresh.executionProfileHash };
    const created = await call('/v1/recipes', { ...f.input, validation: proof }, 'create');
    assert.equal(created.status, 200); const recipe = await created.json();
    let summary = f.store.snapshot().recipes[0]!;
    const approval = { recipeHash: recipe.hash, payloadHash: fresh.payloadHash, repositoryIds: recipe.repositoryIds, capabilities: recipe.contract.variables.sf.required };
    for (const [key, validation] of [['missing-active', undefined], ['stale-active', binding]] as const) {
      assert.equal((await call('/v1/recipes/recipe-test', { active: true, approval, validation }, key, summary.revision, 'PATCH')).status, 400);
      assert.equal(f.store.getAdmissionState().grants.length, 0); assert.equal(f.store.snapshot().recipes[0]!.active, false);
    }
    assert.equal((await call('/v1/recipes/recipe-test', { active: true, approval, validation: proof }, 'activate', summary.revision, 'PATCH')).status, 200);
    summary = f.store.snapshot().recipes[0]!; assert.equal(summary.ready, true);
    profile = { ...profile, hostCommit: 'reviewed-host-c' };
    assert.equal(registry.readiness(recipe).approved, false, 'Approval cannot cover a changed profile even if provisionability reasons stay empty');
    assert.equal((await call('/v1/recipes/recipe-test', { active: true, validation: proof }, 'changed-profile', summary.revision, 'PATCH')).status, 400);
    const current = await (await call('/v1/recipes/validate', f.input, 'current')).json();
    const currentProof = { ...proof, executionProfileHash: current.executionProfileHash };
    assert.equal((await call('/v1/recipes/recipe-test', { active: true, validation: currentProof }, 'old-grant', summary.revision, 'PATCH')).status, 400);
    assert.equal(f.store.getAdmissionState().grants.length, 1);
    assert.equal((await call('/v1/recipes/recipe-test', { active: false }, 'deactivate', summary.revision, 'PATCH')).status, 200);
    summary = f.store.snapshot().recipes[0]!;
    assert.equal((await call('/v1/recipes/recipe-test/revisions', { ...f.input, validation: proof }, 'stale-revision', summary.revision)).status, 400);
    assert.equal(f.store.getRecipe('recipe-test')!.revision, recipe.revision);
    const editInput = { ...f.input, yaml: f.input.yaml + '\n' };
    const edit = await (await call('/v1/recipes/validate', editInput, 'edit-validate')).json();
    const edited = await call('/v1/recipes/recipe-test/revisions', { ...editInput, validation: { recipeHash: edit.hash, payloadHash: edit.payloadHash, executionProfileHash: edit.executionProfileHash } }, 'revise', summary.revision);
    assert.equal(edited.status, 200); assert.equal(f.store.snapshot().recipes[0]!.active, false);
    assert.equal((await call('/v1/recipes', { ...f.input, validation: proof }, 'create')).status, 200, 'Exact caller-key receipt must survive changed authority without executing again');
    assert.equal(f.store.getRecipe('recipe-test')!.hash, edit.hash);
    const rejected = await port.reconcile({ key: 'profile', method: 'POST', path: '/v1/recipes' }); assert.equal(rejected.state, 'failed');
    assert.deepEqual(await port.reconcile({ key: 'profile', method: 'PATCH', path: '/v1/recipes/recipe-test' }), { state: 'pending' });
  } finally { await api?.close(); f.store.close(); }
});


test('unknown_unavailable_and_legacy_profile_authority_cannot_be_approved_by_a_readiness_bypass', async () => {
  for (const profile of [undefined, { available: false, isolatedProfileId: 'unavailable-v2' }]) {
    const f = setup();
    const registry = new RecipeRegistry(f.store, { resolveReference: () => true, executionReadiness: () => [], executionProfile: () => profile });
    const port = new C5RecipePort(registry);
    try {
      const recipe = await port.create(boundRecipe(registry, f.input), { key: 'inactive' });
      const before = f.store.snapshot();
      const approval = { recipeHash: recipe.hash, payloadHash: recipePayloadHash(recipe), repositoryIds: recipe.repositoryIds, capabilities: recipe.contract.variables.sf.required };
      await assert.rejects(port.patch(recipe.recipeId, boundPatch(registry, recipe.recipeId, { active: true, approval }), { key: 'approve-unavailable', expectedRevision: before.recipes[0]!.revision }));
      assert.deepEqual({ ...f.store.snapshot(), at: before.at }, before); assert.equal(f.store.getAdmissionState().grants.length, 0);
    } finally { f.store.close(); }
  }
  const f = setup();
  try {
    const recipe = await f.port.create(boundRecipe(f.registry, f.input), { key: 'create' });
    f.store.saveGrant({ id: 'legacy', recipeId: recipe.recipeId, recipeRevision: recipe.revision, repositoryIds: recipe.repositoryIds, required: recipe.contract.variables.sf.required, grantedAt: new Date().toISOString() });
    assert.equal(f.registry.readiness(recipe).approved, false, 'Legacy missing-profile grants remain historical and cannot qualify current activation');
    const summary = f.store.snapshot().recipes[0]!;
    await assert.rejects(f.port.patch(recipe.recipeId, boundPatch(f.registry, recipe.recipeId, { active: true }), { key: 'legacy', expectedRevision: summary.revision }));
  } finally { f.store.close(); }
});
