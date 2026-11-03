import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultConfig } from '../../src/contracts/defaults.ts';
import { validateTask, validateRecipeContract, validateContract } from '../../src/contracts/schemas.ts';
import { validTask } from '../fixtures/contracts.ts';

test('validates_task_and_defaults', () => {
  assert.equal(validateTask(validTask()).tagId, 'features');
  assert.deepEqual(validateTask(JSON.parse(JSON.stringify(validTask()))), validTask());
  for (const invalid of [
    { tags: ['features', 'bugs'] }, { providerId: 'claude' }, { tagId: '' },
    { goal: '' }, { goal: '   ' }, { acceptanceCriteria: [] },
    { acceptanceCriteria: [''] }, { finishPolicy: 'merge' }, { contextBudget: 10 },
  ]) assert.throws(() => validateTask({ ...validTask(), ...invalid }));
  for (const providerId of ['copilot', 'codex']) {
    for (const finishPolicy of ['result', 'pr', 'merge_ci', 'merge_bypass']) {
      assert.equal(validateTask({ ...validTask(), providerId, finishPolicy, required: { ...validTask().required, allowedFinishPolicies: [finishPolicy] } }).finishPolicy, finishPolicy);
    }
  }
  const config = defaultConfig('/factory');
  assert.equal(config.factoryDir, '/factory');
  assert.equal(config.taktSeconds, 60);
  assert.deepEqual(config.limits,
    { concurrency: 1, activeMinutes: 30, startsPerDay: 100, transientRetries: 2 });
  validateContract('FactoryConfig', config);
  config.limits.concurrency = 20;
  assert.equal(defaultConfig('/factory').limits.concurrency, 1);
});

test('recipe_metadata_is_strict_and_keeps_standard_kestra_shape', () => {
  const recipe = {
    id: 'workflow-1', namespace: 'factory', tasks: [{ id: 'report', type: 'io.kestra.plugin.core.log.Log', message: 'ok' }],
    variables: { sf: {
      schemaVersion: 1, recipeId: 'recipe-1', displayName: 'Feature', tagId: 'features',
      inputSchema: { type: 'object' }, taskTemplate: {
        title: 'Feature', description: 'Description', goal: 'Working feature',
        acceptanceCriteria: ['Works'], skills: [], tools: [], context: {},
      }, required: validTask().required, compatibleOwners: ['vscode'],
      compatibleProviders: ['copilot'], defaultFinishPolicy: 'pr',
    } },
  };
  assert.deepEqual(validateRecipeContract(recipe), recipe);
  assert.throws(() => validateRecipeContract({ ...recipe, variables: { sf: { ...recipe.variables.sf, tags: ['features'] } } }));
  assert.throws(() => validateRecipeContract({ ...recipe, variables: { sf: { ...recipe.variables.sf, compatibleProviders: ['claude'] } } }));
});

test('broker_identity_events_and_errors_enforce_their_boundaries', () => {
  const scope = { attemptId: 'attempt-1', repositoryIds: ['repo-1'], recipeId: 'recipe-1', recipeRevision: 'revision-1',
    grantIds: ['grant-1'], expiresAt: '2026-11-03T12:00:00Z', fence: 1 };
  validateContract('ActorScope', scope);
  assert.throws(() => validateContract('ActorScope', { ...scope, expiresAt: 'yesterday' }));
  assert.throws(() => validateContract('ActorScope', { ...scope, fence: 0 }));
  validateContract('OwnerEvent', { type: 'activity', identity: { ownerId: 'bb', providerId: 'codex', sessionId: 'native-1' },
    at: '2026-11-03T12:00:00Z', active: false });
  assert.throws(() => validateContract('OwnerEvent', { type: 'completed', at: '2026-11-03T12:00:00Z' }));
  validateContract('ApiError', { code: 'STALE_REVISION', message: 'Revision changed', recovery: 'Refresh', retryable: false });
  assert.throws(() => validateContract('ApiError', { code: 'ERROR', message: 'Error', recovery: 'Retry', retryable: true, token: 'secret' }));
  assert.throws(() => validateContract('WorkerRequest', { requestId: 'req-1', idempotencyKey: 'key-1', scope, operation: 'settings.patch', payload: {} }));
});

test('generated_protocol_covers_browser_worker_and_trusted_owner_boundaries', async () => {
  const { readFile } = await import('node:fs/promises');
  const { spawnSync } = await import('node:child_process');
  const run = spawnSync(process.execPath, ['scripts/generate-protocol.ts', '--check'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const api = JSON.parse(await readFile(new URL('../../protocol/openapi.json', import.meta.url), 'utf8'));
  const bundle = JSON.parse(await readFile(new URL('../../protocol/schemas.json', import.meta.url), 'utf8'));
  assert.equal(api.openapi, '3.1.0');
  for (const path of ['/v1/health', '/v1/snapshot', '/v1/events', '/v1/settings', '/v1/repositories',
    '/v1/repositories/{id}', '/v1/repositories/{id}/weights', '/v1/repositories/{id}/rotation-preview',
    '/v1/tags', '/v1/tags/{id}', '/v1/tags/{id}/archive', '/v1/tasks', '/v1/tasks/{id}',
    '/v1/recipes', '/v1/recipes/validate', '/v1/recipes/{id}/revisions', '/v1/recipes/{id}',
    '/v1/dispatch', '/v1/attention/{id}/respond', '/v1/tasks/{id}/takeover',
    '/v1/repositories/{id}/return-control', '/v1/tasks/{id}/open-native', '/v1/auth/probe', '/v1/auth/device-flow']) {
    assert.ok(api.paths[path], `Missing browser operation ${path}`);
  }
  assert.deepEqual(api.paths['/owner/v1/rpc'].post.security, [{ OwnerBridge: [] }]);
  assert.deepEqual(api.paths['/worker/v1/tasks'].post.security, [{ AttemptBearer: [] }]);
  assert.deepEqual(api.paths['/v1/tasks'].post.security, [{ BrowserSession: [] }]);
  assert.ok(api.paths['/v1/settings'].patch.parameters.some((p: { name: string; required?: boolean }) => p.name === 'If-Match' && p.required));
  assert.ok(api.paths['/v1/tasks'].post.parameters.some((p: { name: string; required?: boolean }) => p.name === 'Idempotency-Key' && p.required));
  assert.ok(bundle.$defs.OwnerRpc);
  assert.ok(bundle.$defs.WorkerRequest);
  assert.ok(bundle.$defs.FactorySnapshot);
});

test('published_schema_bundle_validates_payloads_and_rejects_invalid_state', async () => {
  const { readFile } = await import('node:fs/promises');
  const { Ajv2020 } = await import('ajv/dist/2020.js');
  const { createRequire } = await import('node:module');
  const addFormats = createRequire(import.meta.url)('ajv-formats');
  const bundle = JSON.parse(await readFile(new URL('../../protocol/schemas.json', import.meta.url), 'utf8'));
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  ajv.addSchema(bundle);
  for (const name of Object.keys(bundle.$defs)) assert.ok(ajv.getSchema(`urn:ai4devops-sf:protocol:1#/$defs/${name}`));
  const validate = ajv.getSchema('urn:ai4devops-sf:protocol:1#/$defs/TaskSpec')!;
  assert.equal(validate(validTask()), true);
  assert.equal(validate({ ...validTask(), providerId: 'claude' }), false);
  const { context: _, ...missingContext } = validTask();
  assert.equal(validate(missingContext), false);
  assert.throws(() => validateContract('Repository', {
    id: 'repo-1', name: 'Repo', url: 'https://github.com/example/repo', active: true,
    controlMode: 'factory', revision: 1, createdAt: '2026-11-03T12:00:00Z', weights: { features: 101 },
  }));
});

test('fixture_evidence_cannot_claim_verified_isolation_and_live_probe_requires_consent', () => {
  const evidence = { profileId: 'profile-1', ownerId: 'bb', providerId: 'codex', verifiedAt: '2026-11-03T12:00:00Z',
    required: validTask().required, probes: [{ name: 'isolation-bb-codex', mode: 'fixture', status: 'passed',
      versions: { bb: '1' }, assertions: [{ name: 'denied_external_path', passed: true }], artifacts: ['sanitized.json'] }] };
  assert.throws(() => validateContract('ProfileEvidence', evidence));
  validateContract('ProfileEvidence', { ...evidence, probes: [{ ...evidence.probes[0], mode: 'live' }] });
  assert.throws(() => validateContract('ProfileEvidence', { ...evidence, probes: [{ ...evidence.probes[0], mode: 'live', status: 'failed' }] }));
  assert.throws(() => validateContract('ProbeOptions', { mode: 'live', allowLive: false, scratchRepo: '/scratch', outputDir: '/evidence' }));
});


test('task_and_recipe_finish_policies_cannot_exceed_their_declared_capabilities', () => {
  assert.throws(() => validateTask({ ...validTask(), finishPolicy: 'merge_bypass' }));
  const contract = {
    id: 'flow', namespace: 'factory', tasks: [{ id: 'task', type: 'example' }],
    variables: { sf: { schemaVersion: 1, recipeId: 'recipe', displayName: 'Feature', tagId: 'features',
      inputSchema: {}, taskTemplate: { title: 'Feature', description: 'Description', goal: 'Goal',
        acceptanceCriteria: ['Works'], skills: [], tools: [], context: {} },
      required: validTask().required, compatibleOwners: ['vscode'], compatibleProviders: ['copilot'],
      defaultFinishPolicy: 'merge_bypass' } },
  };
  assert.throws(() => validateRecipeContract(contract));
});

test('settings_events_carry_pause_state_and_update_revision', () => {
  const event = { sequence: 1, cursor: '1', at: '2026-11-03T12:00:00Z', type: 'settings',
    data: { config: defaultConfig('/factory'), paused: true, revision: 2 } };
  assert.deepEqual(validateContract('FactoryEvent', event), event);
  assert.throws(() => validateContract('FactoryEvent', { ...event, data: defaultConfig('/factory') }));
});
