import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloseout } from '../../src/github/closeout.ts';
import { createGitHubBackend } from '../../src/github/auth.ts';
import { GitWriterFailure } from '../../src/github/gh.ts';
import { openStore } from '../../src/storage/store.ts';
import { createScheduler } from '../../src/scheduling/admission.ts';
import { validateContract } from '../../src/contracts/schemas.ts';
import { createLifecycle } from '../../src/scheduling/lifecycle.ts';
import { createWorkspaceManager } from '../../src/workspaces/manager.ts';
import { FakeClock } from '../helpers/clock.ts';
import { recipeFixture, grantFixture, materializeFixture } from '../helpers/fixtures.ts';
import type { FinishPolicy, NativeIdentity, TaskResult } from '../../src/contracts/domain.ts';
import type { NativeOwner } from '../../src/contracts/owner.ts';

const exec = promisify(execFile);
async function fixture(policy: FinishPolicy = 'pr') {
  const root = await mkdtemp(join(tmpdir(), 'sf-closeout-'));
  const source = join(root, 'remote'); const factoryRoot = join(root, 'factory');
  await mkdir(source); await mkdir(factoryRoot);
  const env = { PATH: process.env.PATH!, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = async (cwd: string, args: string[]) => (await exec('git', args, { cwd, env, shell: false })).stdout.trim();
  await git(source, ['init', '--initial-branch=main']); await writeFile(join(source, 'file.txt'), 'base\n');
  await git(source, ['add', '.']); await git(source, ['commit', '-m', 'base']);
  const clock = new FakeClock(); const storePath = join(root, 'factory.sqlite');
  let store = openStore(storePath, { clock, materialize: materializeFixture });
  const tag = store.snapshot().tags[0]!;
  store.createRepository({ id: 'repo-1', name: 'Fixture', url: 'https://github.com/fixture/project.git' });
  store.createRepository({ id: 'repo-2', name: 'Other', url: 'https://github.com/fixture/other.git' });
  const recipe = recipeFixture(tag.id); recipe.contract.variables.sf.required.allowedFinishPolicies = ['result', 'pr', 'merge_ci', 'merge_bypass'];
  store.saveRecipeRevision(recipe); store.saveGrant(grantFixture(recipe));
  const summary = store.snapshot().recipes[0]!;
  store.setRecipeReadiness(summary.id, summary.currentRevision, { hash: recipe.hash, ready: true, reasons: [] }, summary.revision);
  const [task] = store.createManualTasks({ recipeId: recipe.recipeId, repositoryIds: ['repo-1'], title: 'Implement feature', description: 'Implementation', finishPolicy: policy }, 'task');
  const repository = { id: 'repo-1', url: 'https://github.com/fixture/project.git', baseRef: 'refs/heads/main' };
  let quiet: 'stopped' | 'unknown' = 'stopped'; let pushFailure: 'unknown' | 'stopped' | undefined;
  const gitAuth = {
    fetch: async (input: { cwd: string; ref?: string }) => { await git(input.cwd, ['fetch', '--no-tags', source, input.ref!]); },
    push: async (input: { cwd: string; ref: string }) => {
      await pushGate?.();
      await git(input.cwd, ['push', source, input.ref]);
      if (pushFailure) throw new GitWriterFailure(pushFailure, 'Fixture lost push acknowledgement');
    },
  };
  const manager = createWorkspaceManager({ factoryRoot, resolveRepository: async () => repository, gitAuth, metadataBoundary: { assertProtected: async () => {} } });
  const workspace = await manager.prepareWorkspace(task!);
  const native: NativeIdentity = { ownerId: 'vscode', providerId: 'copilot', sessionId: 'original', chatId: 'original-chat' };
  const owner: NativeOwner = {
    capabilities: async () => ({ ready: true, reasons: [], supportedProviders: ['copilot'], verifiedProfileIds: ['profile'], version: 'fixture' }),
    ensureStarted: async () => {}, ensureSession: async () => { throw Error('no replacement'); },
    snapshot: async () => ({ identity: native, state: 'idle', inputs: [] }), send: async () => { throw Error('no continuation'); },
    quiesce: async () => quiet, open: async () => ({}), subscribe: () => () => {},
  };
  const readiness = async () => ({ ready: true as const, baseSha: workspace.baseSha, workspacePath: workspace.path, profileId: 'profile' });
  const scheduler = createScheduler({ store, clock, materialize: materializeFixture, readiness,
    start: async () => ({ kind: 'started', identity: { native, workflow: { executionId: 'workflow', namespace: 'sf', flowId: 'quality', revision: '1' } } }) });
  assert.equal((await scheduler.dispatch('manual')).kind, 'started');
  const attempt = store.snapshot().attempts[0]!;
  let lifecycle = createLifecycle({ store, clock, owner: () => owner, readiness, workspace: async () => true,
    workflow: { snapshot: async () => 'present', quiesce: async () => quiet, resume: async () => {} } });
  const result: TaskResult = { attemptId: attempt.id, summary: 'Feature implemented', evidence: ['fixture assertion'], createdTaskIds: [], outcome: policy === 'result' ? 'result' : 'changes' };
  type PR = { number: number; html_url: string; body: string; state: string; draft: boolean; merged: boolean; merge_commit_sha: string | null;
    head: { ref: string; sha: string; repo: { full_name: string } }; base: { ref: string; sha: string; repo: { full_name: string } }; mergeable: boolean; mergeable_state: string };
  let pr: PR | undefined; let createdPrCount = 0; const mergeRequests: Record<string, unknown>[] = [];
  let checks = 'success'; let queue = false; let dropPr = false; let dropMerge = false; let refuse = false; let refusalStatus = 403; let unavailable = false;
  const writes: string[] = []; let changeHeadOnCheck = false; let mergePending = false; let mergeState = 'pending'; let lostReadback = false; let revokeAfterMerge = false; let classic = false; let runApp = 9; let extraRule = false; let losePrReadback = false; let prNoEffect = false; let pushGate: (() => Promise<void>) | undefined;
  const backend = createGitHubBackend({ storageDirectory: join(root, 'auth'), repositories: [{ id: 'repo-1', owner: 'fixture', name: 'project', operations: ['read', 'contents_write', 'pull_requests_write', 'merge'] }],
    process: async request => ({ code: 0, stderr: '', stdout: request.args[1] === 'status'
      ? JSON.stringify({ hosts: { 'github.com': [{ state: 'success', active: true, host: 'github.com', login: 'fixture-user', tokenSource: 'keyring' }] } })
      : request.args[1] === 'token' ? 'fixture-secret' : 'HTTP/2.0 200 OK\r\nx-oauth-scopes: repo\r\n\r\n' + JSON.stringify({ id: 42, login: 'fixture-user' }) }),
    fetch: async (input, init) => {
      if (unavailable) throw Error('fixture transient transport');
      const url = new URL(String(input)); const p = url.pathname; const method = init?.method ?? 'GET';
      const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'x-oauth-scopes': 'repo' } });
      if (p === '/user') return json({ id: 42, login: 'fixture-user' });
      if (p === '/repos/fixture/project') return json({ full_name: 'fixture/project', private: true, permissions: { pull: true, push: true } });
      if (method !== 'GET') writes.push(p);
      if (p.endsWith('/pulls') && method === 'POST') {
        const body = JSON.parse(String(init!.body)); createdPrCount++;
        if (prNoEffect) throw Error('unknown transport before effect');
        const sha = await git(source, ['rev-parse', `refs/heads/${body.head}`]);
        pr = { number: 17, html_url: 'https://github.com/fixture/project/pull/17', body: body.body, state: 'open', draft: false, merged: false, merge_commit_sha: null,
          head: { ref: body.head, sha, repo: { full_name: 'fixture/project' } }, base: { ref: body.base, sha: workspace.baseSha, repo: { full_name: 'fixture/project' } }, mergeable: true, mergeable_state: 'clean' };
        if (losePrReadback) { unavailable = true; throw Error('lost PR response and connection'); }
        if (dropPr) { dropPr = false; throw Error('lost PR reply'); } return json(pr, 201);
      }
      if (p.endsWith('/pulls')) return json(pr ? [pr] : []);
      if (p.endsWith('/pulls/17')) { if (lostReadback && mergeRequests.length) throw Error('readback offline'); return json(pr); }
      if (p.endsWith('/merge-async') && method === 'PUT') {
        const body = JSON.parse(String(init!.body)); mergeRequests.push(body);
        assert.equal(new Headers(init!.headers).get('x-github-api-version'), '2026-03-10');
        if (refuse) { if (lostReadback) unavailable = true; return json({ message: 'Rules refuse this actor' }, refusalStatus); }
        if (body.sha !== pr!.head.sha) return json({}, 422);
        if (revokeAfterMerge) store.revokeGrant('grant-1');
        if (mergePending) return json({ status: 'pending', details: { uuid: '12345678-1234-1234-1234-123456789abc', expected_head_sha: body.sha, bypass_rules: body.bypass_rules } }, 202);
        if (!queue) { pr!.merged = true; pr!.state = 'closed'; pr!.merge_commit_sha = 'a'.repeat(40); }
        if (dropMerge) { dropMerge = false; if (lostReadback) unavailable = true; throw Error('lost merge reply'); }
        return json({ status: queue ? 'enqueued' : 'merged', details: { sha: pr!.merge_commit_sha } });
      }
      if (p.includes('/merge-async/')) return mergeState === 'expired' ? json({}, 404) : json({ status: mergeState, details: { uuid: '12345678-1234-1234-1234-123456789abc', expected_head_sha: pr!.head.sha, bypass_rules: policy === 'merge_bypass' } });
      if (p.includes('/git/matching-refs/heads/')) {
        const ref = p.split('/git/matching-refs/')[1]!;
        try { return json([{ ref: `refs/${ref}`, object: { sha: await git(source, ['rev-parse', `refs/${ref}`]) } }]); } catch { return json([]); }
      }
      if (p.includes('/rules/branches/')) return json([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci', integration_id: 9 }, ...(extraRule ? [{ context: 'security', integration_id: 9 }] : [])], strict_required_status_checks_policy: false } }, ...(queue ? [{ type: 'merge_queue', parameters: {} }] : [])]);
      if (p.endsWith('/check-runs')) {
        const sha = p.split('/commits/')[1]!.split('/')[0]!;
        if (changeHeadOnCheck) { changeHeadOnCheck = false; pr!.head.sha = 'f'.repeat(40); }
        return json({ total_count: 1, check_runs: [{ id: 1, name: 'ci', head_sha: sha, status: checks === 'pending' ? 'in_progress' : 'completed', conclusion: checks === 'pending' ? null : checks, app: { id: runApp } }] });
      }
      if (p.endsWith('/status')) return json({ sha: p.split('/commits/')[1]!.split('/')[0], total_count: 0, state: 'pending', statuses: [] });
      if (p.includes('/branches/')) return json({ name: 'main', protected: classic, ...(classic ? { protection: { required_status_checks: { enforcement_level: 'everyone', contexts: ['classic-ci'] } } } : {}), commit: { sha: workspace.baseSha } });
      throw Error(`Unexpected fixture operation ${method} ${p}`);
    },
  });
  const deps = () => ({ store, clock, lifecycle, workspace: manager, github: backend.github, git: gitAuth });
  let closeout = createCloseout(deps());
  return { root, source, clock, recipe, owner, gitAuth, workspace, manager, attempt, native, task: task!, result, git, backend, writes, mergeRequests,
    get store() { return store; }, get lifecycle() { return lifecycle; }, get closeout() { return closeout; },
    get createdPrCount() { return createdPrCount; }, get pr() { return pr; },
    setChecks(value: string) { checks = value; }, setQueue() { queue = true; }, dropReplies() { dropPr = true; dropMerge = true; },
    setRefusal(status = 403) { refuse = true; refusalStatus = status; }, setQuietUnknown() { quiet = 'unknown'; }, setPushFailure(value: 'unknown' | 'stopped') { pushFailure = value; },
    setPendingMerge(state = 'pending') { mergePending = true; mergeState = state; }, setMergeState(state: string) { mergeState = state; },
    setLostReadback() { lostReadback = true; dropMerge = true; }, restoreReadback() { lostReadback = false; unavailable = false; },
    setRevokeAfterMerge() { revokeAfterMerge = true; }, setClassic() { classic = true; }, setRunApp(id: number) { runApp = id; }, addRule() { extraRule = true; },
    losePrReplyAndReadback() { losePrReadback = true; }, setPrNoEffect() { prNoEffect = true; }, setPushGate(gate: () => Promise<void>) { pushGate = gate; },
    setHeadRace() { changeHeadOnCheck = true; }, setUnavailable(value: boolean) { unavailable = value; },
    async edit() { await writeFile(join(workspace.path, 'file.txt'), 'feature\n'); },
    reopen() { store.close(); store = openStore(storePath, { clock, materialize: materializeFixture });
      lifecycle = createLifecycle({ store, clock, owner: () => owner, readiness, workspace: async () => true, workflow: { snapshot: async () => 'present', quiesce: async () => quiet, resume: async () => {} } });
      closeout = createCloseout(deps()); },
    async close() { store.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test('enforces_four_finish_policies_on_exact_head', async () => {
  for (const policy of ['result', 'pr', 'merge_ci', 'merge_bypass'] as const) {
    const f = await fixture(policy);
    try {
      if (policy !== 'result') await f.edit();
      const done = await f.closeout.finishTask(f.task, f.result);
      assert.equal(done.kind, 'completed', JSON.stringify(done));
      const head = await f.git(f.workspace.path, ['rev-parse', 'HEAD']);
      assert.equal(done.headSha, head);
      assert.equal(f.createdPrCount, policy === 'result' ? 0 : 1);
      assert.equal(f.mergeRequests.length, policy.startsWith('merge_') ? 1 : 0);
      if (f.mergeRequests[0]) { assert.equal(f.mergeRequests[0].sha, head); assert.equal(f.mergeRequests[0].bypass_rules, policy === 'merge_bypass'); }
      assert.equal(f.store.getTask(f.task.id)!.status, 'completed');
      assert.equal(f.store.getAdmissionState().activeLeases.length, 0);
      assert.deepEqual(f.store.snapshot().attempts[0]!.native, f.native);
      assert.equal(f.store.snapshot().attempts[0]!.workspacePath, f.workspace.path);
      assert.deepEqual(f.store.getTask(f.task.id)!.closeout, done);
      assert.equal(f.store.pendingActions().filter(action => action.kind.startsWith('closeout.')).length, 0);
    } finally { await f.close(); }
  }
});

test('reconciles_lost_pr_and_merge_replies', async () => {
  const f = await fixture('merge_ci');
  try {
    await f.edit(); f.dropReplies();
    assert.equal((await f.closeout.finishTask(f.task, f.result)).kind, 'completed');
    f.reopen();
    const done = await f.closeout.finishTask(f.task, f.result);
    assert.equal(done.kind, 'completed', JSON.stringify(done)); assert.equal(f.createdPrCount, 1); assert.equal(f.mergeRequests.length, 1);
    assert.equal(done.mergeSha, 'a'.repeat(40));
  } finally { await f.close(); }
});

test('waits_for_current_checks_and_queue_acceptance_is_not_completion', async () => {
  const f = await fixture('merge_ci');
  try {
    await f.edit(); f.setChecks('pending');
    assert.equal((await f.closeout.finishTask(f.task, f.result)).kind, 'waiting_ci');
    assert.equal(f.mergeRequests.length, 0); assert.equal(f.store.getAdmissionState().activeLeases.length, 0);
    f.reopen(); f.setChecks('success'); f.setQueue();
    const queued = await f.closeout.finishTask(f.task, f.result);
    assert.equal(queued.kind, 'waiting_ci'); assert.equal(f.mergeRequests.length, 1); assert.equal(f.store.getTask(f.task.id)!.status, 'waiting_ci');
    assert.equal((await f.closeout.finishTask(f.task, f.result)).kind, 'waiting_ci'); assert.equal(f.mergeRequests.length, 1);
    f.pr!.merged = true; f.pr!.state = 'closed'; f.pr!.merge_commit_sha = 'b'.repeat(40);
    assert.equal((await f.closeout.finishTask(f.task, f.result)).kind, 'completed');
  } finally { await f.close(); }
});

test('changed_head_invalidates_checks_and_github_bypass_refusal_needs_attention', async () => {
  for (const race of [true, false]) {
    const f = await fixture(race ? 'merge_ci' : 'merge_bypass');
    try {
      await f.edit(); if (race) f.setHeadRace(); else f.setRefusal();
      assert.equal((await f.closeout.finishTask(f.task, f.result)).kind, 'needs_attention');
      assert.equal(f.mergeRequests.length, race ? 0 : 1);
      assert.equal(f.store.getTask(f.task.id)!.status, 'needs_attention');
      if (!race) assert.equal(f.store.getTask(f.task.id)!.closeout!.pullRequest!.number, 17);
    } finally { await f.close(); }
  }
});

test('native_idle_and_untrusted_output_cannot_supply_authority_or_release_unknown_writers', async () => {
  const f = await fixture('result');
  try {
    await f.lifecycle.applyOwnerEvent(f.attempt.id, { type: 'activity', identity: f.native, at: new Date().toISOString(), active: false });
    assert.equal(f.store.getTask(f.task.id)!.status, 'running');
    assert.equal((await f.closeout.finishTask(f.task, { ...f.result, finishPolicy: 'merge_bypass' } as TaskResult)).kind, 'needs_attention');
    assert.equal(f.writes.length, 0);
    f.setQuietUnknown();
    assert.equal((await f.closeout.finishTask(f.task, f.result)).kind, 'needs_attention');
    assert.equal(f.store.getAdmissionState().activeLeases.length, 1);
  } finally { await f.close(); }
});

test('unknown_git_push_completion_escapes_metadata_scope_and_retains_real_exclusion', async () => {
  const f = await fixture();
  try {
    await f.edit(); f.setPushFailure('unknown');
    assert.equal((await f.closeout.finishTask(f.task, f.result)).kind, 'needs_attention');
    const lock = JSON.parse(await readFile(join(f.root, 'factory/.workspace-manager.lock/owner.json'), 'utf8'));
    assert.equal(lock.state, 'writer_completion_unknown');
    await assert.rejects(f.manager.withTrustedMetadata(async () => {}));
    assert.equal(f.store.getAdmissionState().activeLeases.length, 1); assert.equal(f.createdPrCount, 0);
  } finally { await f.close(); }
});


test('refused_merge_stays_attention_after_restart_without_another_request', async () => {
  const f = await fixture('merge_bypass');
  try {
    await f.edit(); f.setRefusal();
    assert.equal((await f.closeout.finishTask(f.task, f.result)).kind, 'needs_attention'); f.reopen();
    assert.equal((await f.closeout.finishTask(f.task, f.result)).kind, 'needs_attention');
    assert.equal(f.mergeRequests.length, 1);
  } finally { await f.close(); }
});

test('pending_merge_failed_or_expired_result_never_resubmits_and_actual_merge_wins', async () => {
  for (const state of ['failed', 'expired']) {
    const f = await fixture('merge_ci');
    try {
      await f.edit(); f.setPendingMerge();
      assert.equal((await f.closeout.finishTask(f.task, f.result)).kind, 'waiting_ci'); f.reopen();
      f.setMergeState(state);
      assert.equal((await f.closeout.finishTask(f.task, f.result)).kind, 'needs_attention');
      assert.equal(f.mergeRequests.length, 1);
      f.pr!.merged = true; f.pr!.state = 'closed'; f.pr!.merge_commit_sha = 'c'.repeat(40);
      assert.equal((await f.closeout.finishTask(f.task, f.result)).kind, 'completed');
    } finally { await f.close(); }
  }
});

test('restart_reconciles_lost_merge_after_grant_revocation_without_new_writes', async () => {
  const f = await fixture('merge_ci');
  try {
    await f.edit(); f.setRevokeAfterMerge(); f.setLostReadback();
    assert.equal((await f.closeout.finishTask(f.task, f.result)).kind, 'needs_attention');
    assert.equal(f.mergeRequests.length, 1);
    assert.ok(f.store.getAdmissionState().grants[0]!.revokedAt);
    f.restoreReadback(); f.reopen();
    assert.equal((await f.closeout.finishTask(f.task, f.result)).kind, 'completed');
    assert.equal(f.mergeRequests.length, 1); assert.equal(f.createdPrCount, 1);
  } finally { await f.close(); }
});

test('current_rule_sources_and_classic_protection_require_their_own_checks', async () => {
  for (const mode of ['classic', 'wrong-app', 'new-rule']) {
    const f = await fixture('merge_ci');
    try {
      await f.edit(); if (mode === 'classic') f.setClassic(); else if (mode === 'wrong-app') f.setRunApp(4); else f.addRule();
      const out = await f.closeout.finishTask(f.task, f.result);
      assert.equal(out.kind, 'waiting_ci', JSON.stringify(out)); assert.equal(f.mergeRequests.length, 0);
    } finally { await f.close(); }
  }
});


test('explicit_server_refusal_is_distinct_from_unknown_transport', async () => {
  for (const status of [400, 409, 422]) {
    const f = await fixture('merge_bypass');
    try {
      await f.edit(); f.setRefusal(status);
      assert.equal((await f.closeout.finishTask(f.task, f.result)).kind, 'needs_attention');
      f.reopen(); assert.equal((await f.closeout.finishTask(f.task, f.result)).kind, 'needs_attention');
      assert.equal(f.mergeRequests.length, 1);
    } finally { await f.close(); }
  }
});


test('lost_pr_restart_reuses_marker_and_unknown_no_effect_never_repeats_post', async () => {
  for (const actualEffect of [true, false]) {
    const f = await fixture('pr');
    try {
      await f.edit(); if (actualEffect) f.losePrReplyAndReadback(); else f.setPrNoEffect();
      assert.equal((await f.closeout.finishTask(f.task, f.result)).kind, 'needs_attention');
      assert.equal(f.createdPrCount, 1);
      f.setUnavailable(false); f.reopen();
      assert.equal((await f.closeout.finishTask(f.task, f.result)).kind, actualEffect ? 'completed' : 'needs_attention');
      assert.equal(f.createdPrCount, 1);
    } finally { await f.close(); }
  }
});

test('proven_stopped_lost_push_reply_is_reconciled_on_actual_remote_head', async () => {
  const f = await fixture('pr');
  try {
    await f.edit(); f.setPushFailure('stopped');
    assert.equal((await f.closeout.finishTask(f.task, f.result)).kind, 'completed');
    assert.equal(f.pr!.head.sha, await f.git(f.workspace.path, ['rev-parse', 'HEAD']));
    await f.manager.withTrustedMetadata(async () => {});
  } finally { await f.close(); }
});

test('unresolved_metadata_blocks_takeover_and_keeps_current_fence', async () => {
  const f = await fixture('pr');
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const start = new Promise<void>(resolve => { entered = resolve; });
  let pending: Promise<unknown> | undefined;
  try {
    await f.edit(); f.setPushGate(async () => { entered(); await gate; });
    pending = f.closeout.finishTask(f.task, f.result); await start;
    await assert.rejects(f.lifecycle.requestTakeover(f.task.id), { code: 'closeout_inflight' });
    assert.equal(f.store.getAdmissionState().activeLeases.length, 1);
    release(); const result = await pending as { kind: string };
    assert.equal(result.kind, 'needs_attention'); assert.equal(f.createdPrCount, 0);
    assert.equal(f.store.snapshot().attempts[0]!.fence, f.attempt.fence);
    assert.equal(f.store.getAdmissionState().activeLeases.length, 1);
  } finally { release(); await pending; await f.close(); }
});

test('ci_monitoring_can_finish_while_a_second_real_workspace_owns_capacity', async () => {
  const f = await fixture('merge_ci');
  try {
    await f.edit(); f.setChecks('pending');
    assert.equal((await f.closeout.finishTask(f.task, f.result)).kind, 'waiting_ci');
    const [second] = f.store.createManualTasks({ recipeId: f.recipe.recipeId, repositoryIds: ['repo-1'], title: 'Second', description: 'Second task' }, 'second');
    const secondWorkspace = await f.manager.prepareWorkspace(second!);
    const scheduler = createScheduler({ store: f.store, clock: f.clock, materialize: materializeFixture,
      readiness: async () => ({ ready: true, baseSha: secondWorkspace.baseSha, workspacePath: secondWorkspace.path, profileId: 'profile' }),
      start: async () => ({ kind: 'started', identity: { native: { ...f.native, sessionId: 'second' }, workflow: { executionId: 'second-workflow', namespace: 'sf', flowId: 'quality', revision: '1' } } }) });
    assert.equal((await scheduler.dispatch('manual')).kind, 'started');
    f.setChecks('success'); assert.equal((await f.closeout.finishTask(f.task, f.result)).kind, 'completed');
    const leases = f.store.getAdmissionState().activeLeases;
    assert.equal(leases.length, 1); assert.notEqual(leases[0]!.attemptId, f.attempt.id);
    assert.equal(f.store.getTask(second!.id)!.status, 'running');
    assert.equal(f.store.getQuotaState().confirmed, 2);
  } finally { await f.close(); }
});

test('result_and_browser_worker_inputs_cannot_forge_verified_closeout_or_authority', async () => {
  const f = await fixture('result');
  try {
    const closeout = { kind: 'completed', attemptId: f.attempt.id, headSha: 'f'.repeat(40) };
    assert.throws(() => validateContract('TaskResult', { ...f.result, closeout }));
    assert.throws(() => validateContract('TaskPatch', { closeout }));
    assert.throws(() => validateContract('CreateTaskRequest', { recipeId: f.recipe.recipeId, repositoryIds: ['repo-1'], title: 'X', description: 'X', closeout }));
    const scope = { attemptId: f.attempt.id, repositoryIds: ['repo-1'], recipeId: f.recipe.recipeId, recipeRevision: f.recipe.revision, grantIds: ['grant-1'], expiresAt: '2026-11-05T10:00:00Z', fence: f.attempt.fence };
    assert.throws(() => validateContract('WorkerRequest', { requestId: 'r', idempotencyKey: 'k', scope, operation: 'result.submit', payload: { ...f.result, closeout } }));
    assert.equal((await f.closeout.finishTask({ ...f.task, finishPolicy: 'merge_bypass' }, f.result)).kind, 'needs_attention');
    assert.equal((await f.closeout.finishTask(f.task, { ...f.result, attemptId: 'foreign' })).kind, 'needs_attention');
    assert.equal((await f.closeout.finishTask(f.task, { ...f.result, headSha: 'f'.repeat(40) })).kind, 'needs_attention');
    assert.equal(f.writes.length, 0); assert.equal(f.store.getAdmissionState().activeLeases.length, 1);
  } finally { await f.close(); }
});


test('a_proven_refusal_survives_later_readback_connection_loss', async () => {
  const f = await fixture('merge_bypass');
  try {
    await f.edit(); f.setRefusal(); f.setLostReadback();
    assert.equal((await f.closeout.finishTask(f.task, f.result)).kind, 'needs_attention');
    f.restoreReadback(); f.reopen();
    assert.equal((await f.closeout.finishTask(f.task, f.result)).kind, 'needs_attention');
    assert.equal(f.mergeRequests.length, 1);
  } finally { await f.close(); }
});
