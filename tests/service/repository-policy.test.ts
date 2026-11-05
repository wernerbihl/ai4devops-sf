import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixture } from '../helpers/store.ts';
import { authorizePath } from '../../src/github/capabilities.ts';
import { createRepositoryPolicy } from '../../src/service/repository-policy.ts';

test('explicit_catalog_selection_restores_actual_allowlist_and_resolver_after_restart', async () => {
  const fixture = createFixture();
  const item = { githubId: '123', owner: 'octo', name: 'project', url: 'https://github.com/octo/project.git', defaultBranch: 'main' };
  const backend = { async listRepositories() { return [item]; }, async resolveGitHubAuth() { return { status: 'ready' as const, accountId: '9', login: 'operator', reasons: [] }; } };
  const config = { repositories: [] };
  try {
    let policy = createRepositoryPolicy(fixture.store, config, backend);
    assert.throws(() => authorizePath(config.repositories, 'GET', '/repos/octo/project'));
    const selected = await policy.select('123', 'request-key');
    assert.equal(selected.active, false);
    assert.equal(authorizePath(config.repositories, 'GET', '/repos/octo/project').repository.id, selected.id);
    assert.deepEqual(policy.resolve(selected.id), { id: selected.id, url: item.url, baseRef: 'refs/heads/main' });
    assert.throws(() => authorizePath(config.repositories, 'GET', '/repos/octo/unselected'));
    fixture.reopen(); const restarted = { repositories: [] };
    policy = createRepositoryPolicy(fixture.store, restarted, backend);
    assert.equal(authorizePath(restarted.repositories, 'GET', '/repos/octo/project').repository.id, selected.id);
    assert.deepEqual(policy.resolve(selected.id), { id: selected.id, url: item.url, baseRef: 'refs/heads/main' });
    assert.deepEqual(policy.reconcile('request-key'), selected);
  } finally { fixture.close(); }
});

test('selected_repository_rejects_a_name_reused_by_another_immutable_id', async () => {
  const { repositoryFacts } = await import('../../src/github/capabilities.ts');
  const allowed = { id: 'github:123', owner: 'octo', name: 'project', operations: ['read' as const] };
  const response = { data: { id: 456, full_name: 'octo/project', private: false, permissions: { pull: true } }, headers: new Headers(), status: 200 };
  assert.throws(() => repositoryFacts(allowed, '9', response));
});

test('unavailable_catalog_refuses_selection_without_creating_an_unknown_effect', async () => {
  const fixture = createFixture();
  try {
    const policy = createRepositoryPolicy(fixture.store, { repositories: [] }, { async listRepositories() { throw Error('offline'); }, async resolveGitHubAuth() { throw Error('offline'); } });
    await assert.rejects(policy.select('123', 'failure-key'), (error: any) => error.name === 'DefinitiveNoEffect');
    assert.equal(fixture.store.repositorySelectionReceipt('failure-key'), undefined);
    assert.equal(fixture.store.getRepository('github:123'), undefined);
  } finally { fixture.close(); }
});

test('selected_repository_reaches_current_grant_and_lease_authorizer_but_unselected_is_denied', async () => {
  const { createRepositoryOperationAuthorizer } = await import('../../src/service/repository-authorization.ts');
  const { recipeFixture, grantFixture, materializeFixture } = await import('../helpers/fixtures.ts');
  const { createScheduler } = await import('../../src/scheduling/admission.ts');
  const { createHash } = await import('node:crypto');
  const f = createFixture(); const config = { repositories: [] };
  const backend = { async listRepositories() { return [{ githubId:'123', owner:'octo', name:'project', url:'https://github.com/octo/project.git', defaultBranch:'main' }]; }, async resolveGitHubAuth() { return { status:'ready' as const, accountId:'9', login:'operator', reasons:[] }; } };
  try {
    const policy = createRepositoryPolicy(f.store, config, backend); await policy.select('123', 'select');
    const recipe = recipeFixture(f.recipe.tagId, 'rev-2'); recipe.repositoryIds = ['github:123'];
    f.store.saveRecipeRevision(recipe, 1); const summary = f.store.snapshot().recipes[0]!;
    f.store.setRecipeReadiness(summary.id, summary.currentRevision, { hash:recipe.hash, ready:true, reasons:[] }, summary.revision);
    f.store.saveGrant({ ...grantFixture(recipe), id:'grant-selected', repositoryIds:['github:123'] });
    f.store.patchTask(f.task.id, { status:'cancelled' }, 1);
    const [created] = f.store.createManualTasks({ ...f.request, repositoryIds:['github:123'] }, 'selected-task');
    f.store.patchTask(created!.id, { finishPolicy:'pr' }, 1);
    const task = f.store.getTask(created!.id)!.spec; const preparing = new Map([[task.id, task]]);
    const authorize = createRepositoryOperationAuthorizer(f.store, config.repositories, preparing, f.clock);
    const workspaceKey = 'workspace-prepare:any:' + createHash('sha256').update(task.id).digest('hex');
    assert.equal(await authorize('github:123', 'read', workspaceKey), true);
    assert.equal(await authorize('github:999', 'read', workspaceKey), false);
    const scheduler = createScheduler({ store:f.store, clock:f.clock, materialize:materializeFixture, readiness:async () => ({ ready:true, baseSha:'base', workspacePath:'/fixture/workspace', profileId:'fixture-profile' }), start:async reservation => ({ kind:'started', identity:{ workflow:{ executionId:reservation.attempt.id, namespace:'fixture', flowId:'quality', revision:'1' } } }) });
    assert.equal((await scheduler.dispatch('manual')).kind, 'started');
    assert.equal(f.store.getReservations().some(entry => entry.lease.active), true);
    assert.equal(authorizePath(config.repositories, 'POST', '/repos/octo/project/pulls').repository.id, 'github:123');
    assert.equal(await authorize('github:123', 'pull_requests_write'), true);
    assert.equal(await authorize('github:123', 'merge'), false);
    assert.equal(await authorize('github:999', 'pull_requests_write'), false);
    f.store.revokeGrant('grant-selected');
    assert.equal(await authorize('github:123', 'pull_requests_write'), false);
  } finally { f.close(); }
});

test('conflicting_preexisting_row_refuses_selection_without_pending_effect', async () => {
  const f = createFixture(); const config = { repositories: [] };
  const item = { githubId:'123', owner:'octo', name:'project', url:'https://github.com/octo/project.git', defaultBranch:'main' };
  const backend = { async listRepositories() { return [item]; }, async resolveGitHubAuth() { return { status:'ready' as const, accountId:'9', login:'operator', reasons:[] }; } };
  try {
    f.store.createRepository({ id:'github:123', name:'other/name', url:item.url });
    const policy = createRepositoryPolicy(f.store, config, backend);
    await assert.rejects(policy.select('123','conflict-key'), (error: any) => error.name === 'DefinitiveNoEffect');
    assert.equal(policy.reconcile('conflict-key'), undefined); assert.equal(config.repositories.length, 0);
  } finally { f.close(); }
});
