import { lstat, realpath, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, join, sep } from 'node:path';
import type { LocalGit } from './git.ts';

export interface ManagedRepository { id: string; url: string; baseRef: string }
export interface Workspace {
  repositoryId: string;
  taskId: string;
  path: string;
  baseSha: string;
  baseRef: string;
  repositoryUrl: string;
  commonGitDirectory: string;
  gitDirectory: string;
  hooksDirectory: string;
}
export type WorkspaceValidation =
  | { kind: 'ready'; workspace: Workspace; retainedChanges: boolean }
  | { kind: 'needs_attention'; workspace: Workspace; retainedChanges: true; reasons: string[] };
export class WorkspaceAttention extends Error {
  readonly code = 'workspace_needs_attention';
  readonly workspace: Workspace | undefined;
  constructor(reason: string, workspace?: Workspace) {
    super(reason); this.name = 'WorkspaceAttention'; this.workspace = workspace;
  }
}
export function attention(workspace: Workspace, reason: string): WorkspaceValidation {
  return { kind: 'needs_attention', workspace, retainedChanges: true, reasons: [reason] };
}
export const opaqueSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

/** Reject links/junctions even when they happen to resolve back inside the managed root. */
export async function assertManagedPath(root: string, path: string, allowMissing = false): Promise<void> {
  const rel = relative(root, path);
  if (!isAbsolute(root) || !isAbsolute(path) || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new WorkspaceAttention('Workspace path escapes the factory installation');
  const pieces = [root, ...rel.split(sep).filter(Boolean)];
  let current = pieces[0]!;
  for (let index = 0; index < pieces.length; index++) {
    if (index) current = join(current, pieces[index]!);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new WorkspaceAttention('Managed path is missing or cannot be inspected');
    }
    if (stat.isSymbolicLink() || await realpath(current) !== current)
      throw new WorkspaceAttention('Managed symlink, junction or noncanonical path refused');
  }
}
export async function readPrivateJson(root: string, path: string): Promise<unknown> {
  await assertManagedPath(root, path);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 64 * 1024) throw new WorkspaceAttention('Invalid managed manifest');
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new WorkspaceAttention('Invalid managed manifest; preserve it for recovery'); }
}
export async function validateWorkspaceFiles(
  root: string, workspace: Workspace, repository: ManagedRepository, git: LocalGit,
): Promise<{ retainedChanges: boolean }> {
  if (!opaqueSha.test(workspace.baseSha) || workspace.repositoryId !== repository.id
    || workspace.repositoryUrl !== repository.url || workspace.baseRef !== repository.baseRef)
    throw new WorkspaceAttention('Repository, remote or base-ref identity changed', workspace);
  for (const path of [workspace.path, workspace.gitDirectory, workspace.commonGitDirectory, workspace.hooksDirectory])
    await assertManagedPath(root, path);
  if ((await readdir(workspace.hooksDirectory)).length)
    throw new WorkspaceAttention('Disabled hooks directory must remain empty and trusted', workspace);
  const dotgit = join(workspace.path, '.git');
  await assertManagedPath(root, dotgit);
  const pointerStat = await lstat(dotgit);
  if (!pointerStat.isFile() || pointerStat.size > 64 * 1024)
    throw new WorkspaceAttention('Worktree Git metadata pointer changed', workspace);
  // Git for Windows emits forward slashes/CRLF; compare canonical path identity, not spelling.
  const pointer = /^gitdir: ([^\r\n]+)(?:\r?\n)?$/.exec(await readFile(dotgit, 'utf8'));
  if (!pointer || !isAbsolute(pointer[1]!) || resolve(pointer[1]!) !== workspace.gitDirectory)
    throw new WorkspaceAttention('Worktree Git metadata pointer changed', workspace);
  const run = async (args: string[], allowedExitCodes?: number[]) => git({ cwd: workspace.path, args,
    gitDirectory: workspace.gitDirectory, workTree: workspace.path, hooksDirectory: workspace.hooksDirectory,
    ...(allowedExitCodes ? { allowedExitCodes } : {}),
  });
  const top = (await run(['rev-parse', '--show-toplevel'])).stdout.trim();
  const common = (await run(['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim();
  if (resolve(top) !== workspace.path || resolve(common) !== workspace.commonGitDirectory)
    throw new WorkspaceAttention('Foreign worktree or shared Git metadata refused', workspace);
  const remote = await run(['config', '--local', '--get-all', 'remote.origin.url']);
  if (remote.stdout.trim() !== repository.url)
    throw new WorkspaceAttention('Stored repository remote changed', workspace);
  const dangerous = await run(['config', '--local', '--get-regexp',
    '^(include|includeif)\\.|^url\\..*\\.(insteadof|pushinsteadof)$|^remote\\..*\\.pushurl$'], [0, 1]);
  if (dangerous.code !== 1 || dangerous.stdout)
    throw new WorkspaceAttention('Unapproved Git URL rewriting, includes or push destinations', workspace);
  // A trusted closeout may have committed on the task branch. HEAD must still descend from the pinned base.
  await run(['merge-base', '--is-ancestor', workspace.baseSha, 'HEAD']);
  if ((await run(['ls-files', '--unmerged', '-z'])).stdout)
    throw new WorkspaceAttention('Resolve the retained worktree conflicts before continuing', workspace);
  const status = (await run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'])).stdout;
  return { retainedChanges: status.length > 0 };
}
