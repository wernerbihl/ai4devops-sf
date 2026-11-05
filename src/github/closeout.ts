import { createHash } from 'node:crypto';
import type { Attempt, Clock, CloseoutResult, TaskResult, TaskSpec } from '../contracts/domain.ts';
import { validateContract } from '../contracts/schemas.ts';
import type { FactoryStore } from '../storage/store.ts';
import { canonical, ensure, fingerprint, StoreError } from '../storage/database.ts';
import type { Lifecycle } from '../scheduling/lifecycle.ts';
import { hasCapabilityGrants } from '../scheduling/eligibility.ts';
import type { WorkspaceManager, Workspace } from '../workspaces/manager.ts';
import { createLocalGit } from '../workspaces/git.ts';
import type { LocalGit } from '../workspaces/git.ts';
import { opaqueSha } from '../workspaces/revalidate.ts';
import type { GitAuthPort } from './auth.ts';
import type { GitHubPort } from './capabilities.ts';
import { GitHubFailure, GitHubHttpFailure, GitWriterFailure } from './gh.ts';
import { currentChecks } from './checks.ts';
import { findPull, object, readPull, remoteHead, repositoryPath } from './pull-requests.ts';
import type { PullTarget, VerifiedPull } from './pull-requests.ts';

export type { CloseoutResult } from '../contracts/domain.ts';
export interface CloseoutOptions {
  store: FactoryStore; clock: Clock; lifecycle: Lifecycle; workspace: WorkspaceManager;
  github: GitHubPort; git: Pick<GitAuthPort, 'push'>;
  localGit?: LocalGit;
}
export interface Closeout { finishTask(task: TaskSpec, result: TaskResult): Promise<CloseoutResult> }

/** Trusted server composition only. TaskResult is data, never repository/actor/finish authority. */
export function createCloseout(options: CloseoutOptions): Closeout {
  const { store, lifecycle, github } = options; const localGit = options.localGit ?? createLocalGit();
  const key = (id: string, name: string) => `closeout:${id}:${name}`;
  function receipt(id: string, name: string): Record<string, unknown> | undefined { return store.getActionByKey(key(id, name))?.payload; }
  function remember(id: string, name: string, payload: Record<string, unknown>): void {
    const action = store.enqueueAction({ key: key(id, name), kind: `closeout.${name}`, payload }); store.completeAction(action.id);
  }
  function authority(task: TaskSpec, attempt: Attempt): void {
    const current = store.getTask(task.id); const state = store.getAdmissionState();
    ensure(current && canonical(current.spec) === canonical(task) && current.attemptIds.at(-1) === attempt.id
      && current.controlMode === 'factory' && !current.archivedAt && !['completed', 'failed', 'cancelled'].includes(current.status), 'stale_attempt', 'Only the current frozen factory task can finish');
    ensure(state.repositories.find(repo => repo.id === task.repositoryId)?.controlMode === 'factory' && !state.settings.paused,
      'paused', 'Closeout is paused while the repository or factory is under human control');
    ensure(hasCapabilityGrants(task, state.grants, options.clock)
      && state.recipes.some(recipe => recipe.id === task.recipeId && recipe.active)
      && state.recipeReadiness.some(r => r.recipeId === task.recipeId && r.recipeRevision === task.recipeRevision && r.ready)
      && state.tags.some(tag => tag.id === task.tagId && !tag.archivedAt), 'capability_blocked', 'Revalidate the pinned recipe and current explicit finish grants');
    const currentAttempt = store.getLifecycle(attempt.id);
    ensure(currentAttempt.reservation.attempt.fence === attempt.fence, 'stale_fence', 'Closeout attempt fence changed');
    if (currentAttempt.reservation.lease.active) store.assertLifecycleAuthority(attempt.id, attempt.fence);
    else ensure(currentAttempt.state.quiescent && currentAttempt.state.closeout?.phase === 'monitoring', 'stale_fence', 'Only verified quiescent CI monitoring can proceed without a lease');
  }
  function targetFor(task: TaskSpec, workspace: Workspace): PullTarget {
    const url = store.getRepository(task.repositoryId)?.url;
    const parts = /^https:\/\/github\.com\/([A-Za-z\d_.-]+)\/([A-Za-z\d_.-]+)\.git$/.exec(url ?? '');
    ensure(parts && workspace.repositoryUrl === url && /^refs\/heads\/[A-Za-z\d_./-]+$/.test(workspace.baseRef), 'repository_changed', 'Restore the trusted repository URL and base branch');
    return { repositoryId: task.repositoryId, owner: parts[1]!, name: parts[2]!, baseRef: workspace.baseRef.slice('refs/heads/'.length), branch: `sf/task/${createHash('sha256').update(task.id).digest('hex')}` };
  }
  async function metadata(task: TaskSpec, attempt: Attempt, result: TaskResult): Promise<string> {
    return options.workspace.withTrustedMetadata(async scope => {
      const workspace = await scope.readWorkspace(task.repositoryId, task.id);
      ensure(workspace.path === attempt.workspacePath && workspace.baseSha === attempt.baseSha && workspace.taskId === task.id && workspace.repositoryId === task.repositoryId,
        'workspace_changed', 'Result must use the original pinned task workspace');
      const target = targetFor(task, workspace);
      const validation = await scope.revalidateWorkspace(workspace, attempt.baseSha);
      ensure(validation.kind === 'ready', 'workspace_changed', 'Workspace validation failed; retain files and establish trusted writer quiescence');
      authority(task, attempt);
      const run = async (args: string[]) => {
        try { return (await localGit({ cwd: workspace.path, args, gitDirectory: workspace.gitDirectory, workTree: workspace.path, hooksDirectory: workspace.hooksDirectory })).stdout.trim(); }
        catch (error) { throw error instanceof GitWriterFailure ? error : new GitWriterFailure('unknown', 'Local Git writer completion is unknown'); }
      };
      const branch = await run(['symbolic-ref', '--quiet', 'HEAD']);
      ensure(branch === `refs/heads/${target.branch}`, 'branch_changed', 'The managed task branch changed');
      let head = await run(['rev-parse', '--verify', 'HEAD^{commit}']);
      ensure(opaqueSha.test(head), 'head_unverified', 'The actual task head is invalid');
      const priorHead = receipt(attempt.id, 'head');
      if (priorHead) ensure(priorHead.sha === head, 'head_changed', 'Task head changed after closeout verification');
      else {
        const priorCommit = receipt(attempt.id, 'commit');
        const marker = `Software Factory closeout ${fingerprint({ taskId: task.id, attemptId: attempt.id })}`;
        if (!priorCommit) {
          ensure(!result.headSha || result.headSha === head, 'head_changed', 'TaskResult head does not match the actual workspace head');
          const dirty = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
          if (dirty && task.finishPolicy !== 'result') {
            const claim = store.claimAction({ key: key(attempt.id, 'commit'), kind: 'closeout.commit', payload: { parent: head, marker } });
            ensure(claim.fresh, 'operation_unknown', 'Reconcile the existing commit intent before writing');
            authority(task, attempt);
            try {
              await run(['add', '--all', '--', '.']);
              authority(task, attempt);
              await run(['-c', 'user.name=Software Factory', '-c', 'user.email=software-factory@users.noreply.github.com', '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', marker]);
            } catch (error) {
              if (!(error instanceof GitWriterFailure) || error.writerCompletion === 'unknown') throw error;
              // A normal completed Git process may have committed before its acknowledgement was lost.
              ensure((await run(['log', '-1', '--format=%B'])).trim() === marker, 'operation_unknown', 'Commit outcome is unresolved; retain the workspace');
            }
          }
        } else ensure(priorCommit.marker === (await run(['log', '-1', '--format=%B'])).trim(), 'operation_unknown', 'Interrupted commit has no matching readback; retain the workspace');
        head = await run(['rev-parse', '--verify', 'HEAD^{commit}']);
        ensure(opaqueSha.test(head), 'head_unverified', 'The resulting task head is invalid');
        if (receipt(attempt.id, 'commit')) {
          ensure((await run(['rev-parse', 'HEAD^'])) === receipt(attempt.id, 'commit')!.parent, 'head_changed', 'Commit parent changed during closeout');
          store.completeAction(store.getActionByKey(key(attempt.id, 'commit'))!.id);
        }
        remember(attempt.id, 'head', { sha: head });
      }
      if (task.finishPolicy !== 'result') {
        ensure(!(await run(['status', '--porcelain=v1', '-z', '--untracked-files=all'])), 'workspace_changed', 'Task files changed after the verified commit');
        const remote = await remoteHead(github, target);
        if (remote !== head) {
          ensure(remote === undefined, 'remote_changed', 'Existing task branch has a different remote head; do not overwrite it');
          const claim = store.claimAction({ key: key(attempt.id, 'push'), kind: 'closeout.push', payload: { sha: head, branch: target.branch } });
          ensure(claim.fresh, 'operation_unknown', 'Push outcome is unknown; reconcile the exact remote head before retrying');
          authority(task, attempt);
          try { await options.git.push({ repositoryId: task.repositoryId, cwd: workspace.path, ref: `refs/heads/${target.branch}`, key: claim.action.key }); }
          catch (error) {
            // This MUST escape the callback so C7 retains the actual installation exclusion.
            if (!(error instanceof GitWriterFailure) || error.writerCompletion === 'unknown') throw error instanceof GitWriterFailure ? error : new GitWriterFailure('unknown', 'Authenticated Git writer completion is unknown');
          }
          ensure(await remoteHead(github, target) === head, 'operation_unknown', 'Remote push could not be verified on the exact head'); store.completeAction(claim.action.id);
        }
      }
      const pushIntent = store.getActionByKey(key(attempt.id, 'push')); if (pushIntent) store.completeAction(pushIntent.id);
      authority(task, attempt);
      remember(attempt.id, 'metadata', { head, target, workspace }); return head;
    });
  }
  function publicPull(target: PullTarget, pull: VerifiedPull): NonNullable<CloseoutResult['pullRequest']> {
    return { repositoryId: target.repositoryId, number: pull.number, url: pull.url, headSha: pull.headSha, baseRef: target.baseRef };
  }
  async function remoteCloseout(task: TaskSpec, attempt: Attempt, target: PullTarget, head: string): Promise<CloseoutResult> {
    const marker = `<!-- sf-closeout:${fingerprint({ taskId: task.id, attemptId: attempt.id })} -->`;
    const base = { attemptId: attempt.id, headSha: head };
    let pull = await findPull(github, target, head, marker);
    if (!pull) {
      const claim = store.claimAction({ key: key(attempt.id, 'pr'), kind: 'closeout.pr', payload: { target, head, marker } });
      ensure(claim.fresh, 'operation_unknown', 'PR creation outcome is unknown; reconcile the existing operation, do not create another PR');
      authority(task, attempt);
      ensure(await remoteHead(github, target) === head, 'head_changed', 'Remote task head changed before PR creation');
      authority(task, attempt);
      let failure: unknown;
      try { await github.request('POST', `${repositoryPath(target)}/pulls`, { title: task.title, body: marker, head: target.branch, base: target.baseRef }, claim.action.key); }
      catch (error) { failure = error; }
      pull = await findPull(github, target, head, marker);
      if (!pull) { if (failure) throw failure; throw new StoreError('operation_unknown', 'PR creation has no verified readback'); }
      store.completeAction(claim.action.id);
    }
    const prIntent = store.getActionByKey(key(attempt.id, 'pr')); if (prIntent) store.completeAction(prIntent.id);
    remember(attempt.id, 'pr-identity', { number: pull.number, head, marker, target });
    const verified = { ...base, pullRequest: publicPull(target, pull) };
    if (pull.merged) {
      const mergeIntent = store.getActionByKey(key(attempt.id, 'merge')); if (mergeIntent) store.completeAction(mergeIntent.id);
      return { ...verified, kind: 'completed', mergeSha: pull.mergeSha! };
    }
    ensure(pull.state === 'open', 'pull_closed', 'Task PR closed without merging');
    if (task.finishPolicy === 'pr') return { ...verified, kind: 'completed' };
    const prior = receipt(attempt.id, 'merge');
    if (prior) {
      const received = receipt(attempt.id, 'merge-reply');
      ensure(received?.status !== 'refused' && received?.status !== 'failed', 'merge_refused', 'GitHub refused the requested merge; inspect current PR rules');
      if (typeof received?.uuid === 'string') {
        const value = object(await github.request('GET', `${repositoryPath(target)}/pulls/${pull.number}/merge-async/${received.uuid}`));
        if (value.status === 'failed') throw new StoreError('merge_refused', 'GitHub refused the requested merge; inspect current PR rules');
        ensure(['pending', 'enqueued', 'merged'].includes(String(value.status)), 'merge_unverified', 'Merge request result is unverified');
        if (value.status === 'pending') {
          const details = object(value.details);
          ensure(details.expected_head_sha === head && details.bypass_rules === (task.finishPolicy === 'merge_bypass'), 'merge_unverified', 'Pending merge has different authority or head');
        }
        pull = await readPull(github, target, pull.number, head, marker);
        if (pull.merged) return { ...verified, kind: 'completed', mergeSha: pull.mergeSha! };
      }
      return { ...verified, kind: 'waiting_ci', reason: received ? 'Waiting for the requested merge or merge queue' : 'Merge request outcome is unknown; reconcile without resubmission' };
    }
    authority(task, attempt);
    if (task.finishPolicy === 'merge_ci') {
      const checks = await currentChecks(github, target, pull);
      if (!checks.ready) return { ...verified, kind: 'waiting_ci', reason: checks.reason! };
    }
    const fresh = await readPull(github, target, pull.number, head, marker);
    ensure(fresh.baseSha === pull.baseSha, 'base_changed', 'PR base changed after check verification');
    if (fresh.merged) return { ...verified, kind: 'completed', mergeSha: fresh.mergeSha! };
    authority(task, attempt);
    const input = { sha: head, merge_action: task.finishPolicy === 'merge_bypass' ? 'direct_merge' : 'default', bypass_rules: task.finishPolicy === 'merge_bypass' };
    const claim = store.claimAction({ key: key(attempt.id, 'merge'), kind: 'closeout.merge', payload: { number: pull.number, ...input } });
    if (!claim.fresh) return { ...verified, kind: 'waiting_ci', reason: 'Reconciling an existing merge request' };
    let reply: unknown; let failure: unknown;
    try { reply = await github.request('PUT', `${repositoryPath(target)}/pulls/${pull.number}/merge-async`, input, claim.action.key); }
    catch (error) { failure = error; }
    if (reply) {
      const value = object(reply); const details = object(value.details);
      ensure(['merged', 'pending', 'enqueued', 'failed'].includes(String(value.status)), 'merge_unverified', 'GitHub merge response is unverified');
      const uuid = details.uuid;
      ensure(uuid === undefined || typeof uuid === 'string' && /^[a-f\d-]{36}$/i.test(uuid), 'merge_unverified', 'GitHub returned an invalid merge request identity');
      remember(attempt.id, 'merge-reply', { status: value.status, ...(uuid ? { uuid } : {}) });
    }
    const refused = failure instanceof GitHubFailure && (['denied', 'expired', 'identity_changed'].includes(failure.kind)
      || failure instanceof GitHubHttpFailure && [400, 409, 422].includes(failure.status));
    if (refused) remember(attempt.id, 'merge-reply', { status: 'refused' });
    // Readback wins over a lost response or authority change after the effect was issued.
    pull = await readPull(github, target, pull.number, head, marker);
    if (pull.merged) { store.completeAction(claim.action.id); return { ...verified, kind: 'completed', mergeSha: pull.mergeSha! }; }
    if (refused) throw new StoreError('merge_refused', 'GitHub refused or conflicted with the requested merge; inspect the existing operation and current PR rules');
    if (receipt(attempt.id, 'merge-reply')?.status === 'failed') throw new StoreError('merge_refused', 'GitHub refused the merge request');
    return { ...verified, kind: 'waiting_ci', reason: failure ? 'Merge request outcome is unknown; reconcile without resubmission' : 'Waiting for verified merge completion' };
  }
  return {
    async finishTask(task, result) {
      let attempt: Attempt | undefined;
      try {
        validateContract('TaskSpec', task); validateContract('TaskResult', result);
        const stored = store.getTask(task.id);
        ensure(stored && canonical(task) === canonical(stored.spec), 'authority_changed', 'Task authority differs from the frozen specification');
        ensure(stored.attemptIds.at(-1) === result.attemptId, 'stale_attempt', 'Result belongs to another attempt');
        attempt = store.getLifecycle(result.attemptId).reservation.attempt;
        ensure(attempt.taskId === task.id && attempt.recipeRevision === task.recipeRevision && attempt.native?.ownerId === task.ownerId
          && attempt.native.providerId === task.providerId && attempt.workflow, 'identity_changed', 'Result requires the original native and workflow identity');
        const input = receipt(attempt.id, 'input');
        ensure(!input || canonical(input.result) === canonical(result), 'result_changed', 'Result changed after closeout began');
        if (stored.status === 'completed' && stored.closeout) return stored.closeout;
        const monitoring = store.getLifecycle(attempt.id).state.closeout?.phase === 'monitoring';
        if (!monitoring) authority(task, attempt);
        ensure(result.outcome !== 'needs_input', 'result_incomplete', 'Workflow still requires input; it has not supplied a completed result');
        for (const id of result.createdTaskIds) ensure(store.getTask(id)?.spec.parentId === task.id, 'result_invalid', 'Reported child task does not belong to this task');
        await lifecycle.prepareCloseout(attempt.id, result);
        let saved = receipt(attempt.id, 'metadata');
        if (!saved) {
          await metadata(task, attempt, result); saved = receipt(attempt.id, 'metadata')!;
        }
        const head = String(saved.head); const target = saved.target as unknown as PullTarget;
        if (task.finishPolicy === 'result') {
          const outcome: CloseoutResult = { kind: 'completed', attemptId: attempt.id, headSha: head };
          await lifecycle.finishCloseout(attempt.id, result, outcome); return outcome;
        }
        // Local work is durably complete. Release proven native capacity before any CI/API waiting.
        if (store.getLifecycle(attempt.id).reservation.lease.active) await lifecycle.finishCloseout(attempt.id, result,
          { kind: 'waiting_ci', attemptId: attempt.id, headSha: head, reason: 'Verifying pull request closeout' });
        // Frozen monitoring may reconcile already-issued effects after grants/control change.
        // remoteCloseout checks live authority again before every new write.
        const outcome = await remoteCloseout(task, attempt, target, head);
        await lifecycle.finishCloseout(attempt.id, result, outcome); return outcome;
      } catch (error) {
        const reason = error instanceof GitWriterFailure && error.writerCompletion === 'unknown'
          ? 'Git writer completion is unknown; retain the repository lease and metadata exclusion until trusted quiescence is proven'
          : error instanceof StoreError || error instanceof GitHubFailure ? error.message : 'Closeout could not be verified; retain the workspace and reconcile the original operation';
        const knownHead = attempt && receipt(attempt.id, 'head');
        const knownPull = attempt && receipt(attempt.id, 'pr-identity');
        const knownTarget = knownPull?.target as PullTarget | undefined;
        const outcome: CloseoutResult = { kind: 'needs_attention', attemptId: attempt?.id ?? (typeof result?.attemptId === 'string' ? result.attemptId : 'unverified'), reason,
          ...(knownHead ? { headSha: String(knownHead.sha) } : {}),
          ...(knownPull && knownTarget ? { pullRequest: { repositoryId: knownTarget.repositoryId, number: Number(knownPull.number),
            url: `https://github.com/${knownTarget.owner}/${knownTarget.name}/pull/${knownPull.number}`, headSha: String(knownPull.head), baseRef: knownTarget.baseRef } } : {}),
        };
        if (attempt) { try { await lifecycle.rejectCloseout(attempt.id, outcome); } catch { /* Stale/terminal attempts must not be overwritten. */ } }
        return outcome;
      }
    },
  };
}
