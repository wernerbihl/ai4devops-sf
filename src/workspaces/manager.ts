import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, writeFile, rename, rm, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { TaskSpec } from '../contracts/domain.ts';
import type { GitAuthPort } from '../github/auth.ts';
import { GitWriterFailure } from '../github/gh.ts';
import { createLocalGit } from './git.ts';
import type { LocalGit } from './git.ts';
import { attention, assertManagedPath, opaqueSha, readPrivateJson, validateWorkspaceFiles, WorkspaceAttention } from './revalidate.ts';
import type { ManagedRepository, Workspace, WorkspaceValidation } from './revalidate.ts';
export { WorkspaceAttention } from './revalidate.ts';
export type { ManagedRepository, Workspace, WorkspaceValidation } from './revalidate.ts';

export interface WorkspaceManagerOptions {
  /** Absolute, canonical, existing installation directory owned by the trusted factory. */
  factoryRoot: string;
  /** Trusted store/config lookup. Never resolve URL/baseRef/path from TaskSpec.context. */
  resolveRepository(repositoryId: string): Promise<ManagedRepository | undefined>;
  gitAuth: Pick<GitAuthPort, 'fetch'>;
  localGit?: LocalGit;
  metadataBoundary: {
    /** E3/E4 must verify protected mounts or native quiescence before returning.
     * Metadata, manifests, lock and disabled-hooks directory cannot be worker-writable.
     * Protection must hold for the entire manager call, not merely this assertion. */
    assertProtected(): Promise<void>;
  };
}
export interface WorkspaceManager {
  prepareWorkspace(task: TaskSpec): Promise<Workspace>;
  revalidateWorkspace(workspace: Workspace, expectedBase: string): Promise<WorkspaceValidation>;
  /** Trusted C8/E6 capability only. Never expose callbacks to workers or public RPC.
   * Requires the same metadata protection as all manager calls; C8 separately proves native
   * worktree quiescence before Git writes/commit/push. Callback must await all its operations.
   * Nonreentrant: use scope.revalidateWorkspace inside the callback, never public manager methods.
   * Unknown GitWriterFailure must escape this callback; convert it to attention outside the scope. */
  withTrustedMetadata<T>(operation: (scope: TrustedMetadataScope) => Promise<T>): Promise<T>;
}
export interface TrustedMetadataScope {
  /** Read only the owned retained manifest. Never fetch, initialize or replace a workspace. */
  readWorkspace(repositoryId: string, taskId: string): Promise<Workspace>;
  /** Validates under the already-held installation lock; invalid once the callback completes. */
  revalidateWorkspace(workspace: Workspace, expectedBase: string): Promise<WorkspaceValidation>;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkspaceAttention('Invalid private workspace manifest');
  return value as Record<string, unknown>;
}
function validateRepository(repository: ManagedRepository | undefined, id: string): ManagedRepository {
  if (!repository || repository.id !== id
    || !/^https:\/\/github\.com\/[A-Za-z\d_.-]+\/[A-Za-z\d_.-]+\.git$/.test(repository.url)
    || !/^refs\/heads\/[A-Za-z\d_./-]+$/.test(repository.baseRef)
    || repository.baseRef.includes('..') || repository.baseRef.includes('//')
    || repository.baseRef.endsWith('/') || repository.baseRef.endsWith('.lock'))
    throw new WorkspaceAttention('Explicit trusted GitHub repository and safe base branch required');
  return repository;
}
/** One instance per installation is normal; the directory lock also excludes other processes/instances.
 * Never break a lock by age or PID absence. A crash leaves recoverable evidence and retained files. */
export function createWorkspaceManager(options: WorkspaceManagerOptions): WorkspaceManager {
  if (!isAbsolute(options.factoryRoot) || resolve(options.factoryRoot) !== options.factoryRoot)
    throw new TypeError('Canonical absolute factory root required');
  if (!options.metadataBoundary?.assertProtected) throw new TypeError('Verified metadata boundary required');
  const root = options.factoryRoot;
  const gitPort = options.localGit ?? createLocalGit();
  let heldLock: { retain: boolean } | undefined;
  async function trackWriter<T>(operation: () => Promise<T>): Promise<T> {
    const lock = heldLock;
    try { return await operation(); }
    catch (error) {
      const failure = error instanceof GitWriterFailure ? error
        : new GitWriterFailure('unknown', 'Managed Git writer completion is unproven; retain exclusion and establish trusted quiescence');
      if (lock && failure.writerCompletion === 'unknown') lock.retain = true;
      throw failure;
    }
  }
  const git: LocalGit = request => trackWriter(() => gitPort(request));
  const hooksDirectory = join(root, 'disabled-hooks');
  const repositoriesDirectory = join(root, 'repositories');
  const worktreesDirectory = join(root, 'worktrees');
  const manifestsDirectory = join(root, 'workspace-manifests');
  const lockDirectory = join(root, '.workspace-manager.lock');
  const paths = (repositoryId: string, taskId: string) => {
    const repoKey = digest(repositoryId); const taskKey = digest(taskId);
    const commonGitDirectory = join(repositoriesDirectory, `${repoKey}.git`);
    return { commonGitDirectory, gitDirectory: join(commonGitDirectory, 'worktrees', taskKey), hooksDirectory,
      path: join(worktreesDirectory, repoKey, taskKey), repoManifest: join(manifestsDirectory, `repository-${repoKey}.json`),
      manifest: join(manifestsDirectory, `task-${repoKey}-${taskKey}.json`), branch: `sf/task/${taskKey}` };
  };
  async function exists(path: string) {
    try { await lstat(path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  async function directory(path: string) {
    await assertManagedPath(root, path, true);
    if (!await exists(path)) await mkdir(path, { mode: 0o700 });
    await assertManagedPath(root, path);
    if (!(await lstat(path)).isDirectory()) throw new WorkspaceAttention('Expected owned managed directory');
  }
  async function save(path: string, value: unknown) {
    await assertManagedPath(root, path, true);
    const temporary = `${path}.${randomUUID()}.tmp`;
    // The directory itself is trusted/non-worker-writable; exclusive creation prevents accidental adoption.
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  }
  async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    await options.metadataBoundary.assertProtected();
    await assertManagedPath(root, root);
    if (!(await lstat(root)).isDirectory()) throw new WorkspaceAttention('Factory installation must be a directory');
    await assertManagedPath(root, lockDirectory, true);
    try { await mkdir(lockDirectory, { mode: 0o700 }); }
    catch { throw new WorkspaceAttention('Workspace manager is active or recovery is required; establish trusted quiescence before reconciling its lock'); }
    const lock = { retain: false }; heldLock = lock;
    const owner = { version: 1, operationId: randomUUID() };
    try {
      await writeFile(join(lockDirectory, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      for (const path of [hooksDirectory, repositoriesDirectory, worktreesDirectory, manifestsDirectory]) await directory(path);
      if ((await readdir(hooksDirectory)).length) throw new WorkspaceAttention('Disabled hooks directory must remain empty');
      return await operation();
    } catch (error) {
      if (error instanceof GitWriterFailure && error.writerCompletion === 'unknown') lock.retain = true;
      throw error;
    } finally {
      heldLock = undefined;
      if (lock.retain) {
        // The directory remains authoritative even if writing this diagnostic fails.
        await writeFile(join(lockDirectory, 'owner.json'), JSON.stringify({ ...owner, state: 'writer_completion_unknown' }), { mode: 0o600 });
      } else await rm(lockDirectory, { recursive: true });
    }
  }
  async function local(cwd: string, args: string[], allowedExitCodes?: number[]) {
    return git({ cwd, args, hooksDirectory, ...(allowedExitCodes ? { allowedExitCodes } : {}) });
  }
  async function verifyRepository(repository: ManagedRepository, common: string) {
    await assertManagedPath(root, common);
    // Inspect from the trusted bare directory, never discover metadata through worker-controlled files.
    if (resolve((await local(common, ['rev-parse', '--absolute-git-dir'])).stdout.trim()) !== common
      || (await local(common, ['rev-parse', '--is-bare-repository'])).stdout.trim() !== 'true'
      || (await local(common, ['config', '--local', '--get-all', 'remote.origin.url'])).stdout.trim() !== repository.url)
      throw new WorkspaceAttention('Foreign repository or changed managed remote refused');
    const dangerous = await local(common, ['config', '--local', '--get-regexp',
      '^(include|includeif)\\.|^url\\..*\\.(insteadof|pushinsteadof)$|^remote\\..*\\.pushurl$'], [0, 1]);
    if (dangerous.code !== 1 || dangerous.stdout) throw new WorkspaceAttention('Unapproved repository Git configuration refused');
  }
  async function fetchBase(repository: ManagedRepository, common: string, key: string) {
    await verifyRepository(repository, common);
    await trackWriter(() => options.gitAuth.fetch({ repositoryId: repository.id, cwd: common, ref: repository.baseRef, key }));
    const sha = (await local(common, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).stdout.trim();
    if (!opaqueSha.test(sha)) throw new WorkspaceAttention('Fetched base must be a full verified commit SHA');
    return sha;
  }
  async function repositoryFor(id: string) {
    return validateRepository(await options.resolveRepository(id), id);
  }
  function repositoryIdentity(repository: ManagedRepository, commonGitDirectory: string) {
    return { version: 1, repositoryId: repository.id, url: repository.url, commonGitDirectory };
  }
  async function ownedRepositoryManifest(repository: ManagedRepository, taskId: string) {
    const target = paths(repository.id, taskId);
    const stored = record(await readPrivateJson(root, target.repoManifest));
    if (stored.status !== 'ready'
      || Object.entries(repositoryIdentity(repository, target.commonGitDirectory)).some(([key, value]) => stored[key] !== value))
      throw new WorkspaceAttention('Repository creation interrupted or identity changed; reconcile trusted clone state');
  }
  async function ownedRepository(repository: ManagedRepository, taskId: string) {
    await ownedRepositoryManifest(repository, taskId);
    await verifyRepository(repository, paths(repository.id, taskId).commonGitDirectory);
  }
  async function manifestWorkspace(repository: ManagedRepository, taskId: string, allowPreparing = false): Promise<Workspace> {
    const expected = paths(repository.id, taskId);
    const manifest = record(await readPrivateJson(root, expected.manifest));
    if (manifest.version !== 1 || (manifest.status !== 'ready' && !(allowPreparing && manifest.status === 'preparing')))
      throw new WorkspaceAttention('Workspace preparation was interrupted; retain its files and reconcile the private manifest');
    const data = record(manifest.workspace);
    const identity = { repositoryId: repository.id, taskId, repositoryUrl: repository.url, baseRef: repository.baseRef,
      path: expected.path, commonGitDirectory: expected.commonGitDirectory, gitDirectory: expected.gitDirectory, hooksDirectory };
    if (Object.entries(identity).some(([key, value]) => data[key] !== value) || typeof data.baseSha !== 'string' || !opaqueSha.test(data.baseSha))
      throw new WorkspaceAttention('Stored task workspace identity changed; preserve its original files');
    return { ...identity, baseSha: data.baseSha };
  }
  async function revalidate(workspace: Workspace, expectedBase: string, allowPreparing = false): Promise<WorkspaceValidation> {
    try {
      const repository = await repositoryFor(workspace.repositoryId);
      await ownedRepository(repository, workspace.taskId);
      const retained = await manifestWorkspace(repository, workspace.taskId, allowPreparing);
      if (Object.entries(retained).some(([key, value]) => (workspace as unknown as Record<string, unknown>)[key] !== value)
        || expectedBase !== retained.baseSha)
        return attention(workspace, 'Original workspace or expected pinned base changed; retain the existing native session and files');
      const state = await validateWorkspaceFiles(root, retained, repository, git);
      const base = await fetchBase(repository, retained.commonGitDirectory, `workspace-validate:${digest(repository.id)}:${digest(workspace.taskId)}`);
      if (base !== expectedBase) return attention(retained, 'The repository base branch moved; review retained changes before continuing');
      return { kind: 'ready', workspace: retained, retainedChanges: state.retainedChanges };
    } catch (error) {
      return attention(workspace, error instanceof GitWriterFailure && error.writerCompletion === 'unknown'
        ? 'Git writer completion is unproven; retain all files and the factory lock until trusted writer quiescence is established'
        : error instanceof WorkspaceAttention ? error.message
        : 'Workspace validation or authenticated fetch failed; retain all files and repair trusted repository access');
    }
  }
  return {
    async prepareWorkspace(task) {
      return exclusive(async () => {
        if (!task.id || !task.repositoryId) throw new WorkspaceAttention('Stable task and repository identifiers required');
        const repository = await repositoryFor(task.repositoryId);
        const target = paths(repository.id, task.id);
        if (await exists(target.manifest)) {
          const retained = await manifestWorkspace(repository, task.id, true);
          const validation = await revalidate(retained, retained.baseSha, true);
          if (validation.kind !== 'ready') throw new WorkspaceAttention(validation.reasons[0]!, retained);
          // A lost completion acknowledgement is recoverable only by proving every completed postcondition.
          // Never rerun worktree add, adopt a foreign directory or discard edits to finish preparation.
          await save(target.manifest, { version: 1, status: 'ready', workspace: retained });
          return retained;
        }
        await assertManagedPath(root, target.path, true);
        if (await exists(target.path)) throw new WorkspaceAttention('Unowned existing task directory refused');
        const repoIdentity = repositoryIdentity(repository, target.commonGitDirectory);
        if (await exists(target.repoManifest)) {
          await ownedRepository(repository, task.id);
        } else {
          await assertManagedPath(root, target.commonGitDirectory, true);
          if (await exists(target.commonGitDirectory)) throw new WorkspaceAttention('Unowned existing repository directory refused');
          await save(target.repoManifest, { ...repoIdentity, status: 'preparing' });
          await local(root, ['init', '--bare', '--template=', '--', target.commonGitDirectory]);
          await local(target.commonGitDirectory, ['config', '--local', 'remote.origin.url', repository.url]);
          await verifyRepository(repository, target.commonGitDirectory);
          await save(target.repoManifest, { ...repoIdentity, status: 'ready' });
        }
        const baseSha = await fetchBase(repository, target.commonGitDirectory, `workspace-prepare:${digest(repository.id)}:${digest(task.id)}`);
        const workspace: Workspace = { repositoryId: repository.id, taskId: task.id, repositoryUrl: repository.url,
          baseRef: repository.baseRef, baseSha, path: target.path, commonGitDirectory: target.commonGitDirectory,
          gitDirectory: target.gitDirectory, hooksDirectory };
        await save(target.manifest, { version: 1, status: 'preparing', workspace });
        await directory(join(worktreesDirectory, digest(repository.id)));
        await local(target.commonGitDirectory, ['worktree', 'add', '--no-guess-remote', '-b', target.branch, '--', target.path, baseSha]);
        await validateWorkspaceFiles(root, workspace, repository, git);
        await save(target.manifest, { version: 1, status: 'ready', workspace });
        return workspace;
      });
    },
    async revalidateWorkspace(workspace, expectedBase) {
      try { return await exclusive(() => revalidate(workspace, expectedBase)); }
      catch (error) { return attention(workspace, error instanceof WorkspaceAttention ? error.message : 'Metadata protection unavailable; retain the original workspace'); }
    },
    async withTrustedMetadata(operation) {
      return exclusive(async () => {
        let active = true;
        const scope: TrustedMetadataScope = {
          async readWorkspace(repositoryId, taskId) {
            if (!active) throw new WorkspaceAttention('Trusted metadata scope expired');
            const repository = await repositoryFor(repositoryId);
            await ownedRepositoryManifest(repository, taskId);
            return manifestWorkspace(repository, taskId);
          },
          async revalidateWorkspace(workspace, expectedBase) {
            if (!active) throw new WorkspaceAttention('Trusted metadata scope expired');
            return revalidate(workspace, expectedBase);
          },
        };
        try { return await operation(scope); }
        finally { active = false; }
      });
    },
  };
}
