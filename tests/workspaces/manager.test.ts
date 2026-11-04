import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import type { TaskSpec } from '../../src/contracts/domain.ts';
import { createWorkspaceManager } from '../../src/workspaces/manager.ts';
import { createLocalGit } from '../../src/workspaces/git.ts';

const exec = promisify(execFile);
const task = (id = 'task /../一; $(touch injected)'): TaskSpec => ({
  id, repositoryId: 'repo /../一; `touch injected`', recipeId: 'recipe', recipeRevision: '1', tagId: 'tag',
  source: 'manual', title: 'Task', description: 'Task', goal: 'Task', acceptanceCriteria: ['Done'],
  skills: [], tools: [], context: {}, finishPolicy: 'result', ownerId: 'vscode', providerId: 'copilot',
  required: { paths: [], tools: [], networkDestinations: [], credentialRefs: [], allowedFinishPolicies: ['result'] },
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sf workspace 一 ; $() '));
  const source = join(root, 'ordinary user checkout ; `touch injected`');
  const factoryRoot = join(root, 'factory 一 ; $(touch injected)');
  await mkdir(source); await mkdir(factoryRoot);
  const env = { PATH: process.env.PATH!, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = async (cwd: string, args: readonly string[]) => (await exec('git', [...args], { cwd, env, shell: false })).stdout.trim();
  await git(source, ['init', '--initial-branch=main']);
  await writeFile(join(source, 'file.txt'), 'base\n');
  await git(source, ['add', '--', 'file.txt']); await git(source, ['commit', '-m', 'base']);
  const base = await git(source, ['rev-parse', 'HEAD']);
  const invocations: { args: readonly string[]; options: { shell: false } }[] = [];
  const localGit = createLocalGit({ onInvocation: invocation => invocations.push(invocation) });
  const repository = { id: task().repositoryId, url: 'https://github.com/fixture/project.git', baseRef: 'refs/heads/main' };
  let protectedMetadata = true;
  const options = { factoryRoot, resolveRepository: async () => repository, localGit,
    metadataBoundary: { assertProtected: async () => { if (!protectedMetadata) throw new Error('metadata writable'); } },
    // Only this explicit fixture boundary uses local transport. Production consumes backend.git.fetch unchanged.
    gitAuth: { fetch: async (input: { repositoryId: string; cwd: string; ref?: string }) => {
      assert.equal(input.repositoryId, repository.id); assert.equal(input.ref, 'refs/heads/main');
      await git(input.cwd, ['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--', source, input.ref!]);
    } },
  };
  return { root, source, factoryRoot, base, git, invocations, repository, options,
    manager: createWorkspaceManager(options), unprotect: () => { protectedMetadata = false; },
    close: () => rm(root, { recursive: true, force: true }) };
}

test('handles_hostile_paths_without_shell_interpolation', async () => {
  const f = await fixture();
  try {
    const workspace = await f.manager.prepareWorkspace(task());
    assert.equal(await readFile(join(workspace.path, 'file.txt'), 'utf8'), 'base\n');
    assert.equal(workspace.baseSha, f.base);
    assert.equal(isAbsolute(relative(f.factoryRoot, workspace.path)), false);
    assert.equal(relative(f.factoryRoot, workspace.path).startsWith('..'), false);
    assert.ok(f.invocations.some(i => i.args.includes(workspace.path)));
    for (const gitInvocation of f.invocations) assert.equal(gitInvocation.options.shell, false);
    const injectedMarkerExists = (await readdir(f.root, { recursive: true })).some(path => path.split('/').at(-1) === 'injected');
    assert.equal(injectedMarkerExists, false);
    assert.equal(await f.git(f.source, ['status', '--porcelain']), '');
    assert.equal(await f.git(f.source, ['rev-parse', 'HEAD']), f.base);
  } finally { await f.close(); }
});

test('resume_preserves_changes_and_rejects_escape_or_conflict', async () => {
  const f = await fixture();
  try {
    const first = await f.manager.prepareWorkspace(task());
    const second = await f.manager.prepareWorkspace(task('second'));
    assert.notEqual(first.path, second.path);
    await writeFile(join(first.path, 'file.txt'), 'retained edit\n');
    await writeFile(join(first.path, 'untracked.txt'), 'retained untracked');
    const restarted = createWorkspaceManager(f.options);
    assert.deepEqual(await restarted.prepareWorkspace(task()), first);
    assert.equal((await restarted.revalidateWorkspace(first, f.base)).kind, 'ready');
    assert.equal(await readFile(join(second.path, 'file.txt'), 'utf8'), 'base\n');
    await writeFile(join(f.source, 'file.txt'), 'new base\n');
    await f.git(f.source, ['commit', '-am', 'base moved']);
    const resumeValidation = await restarted.revalidateWorkspace(first, f.base);
    assert.equal(resumeValidation.kind, 'needs_attention');
    assert.equal(await readFile(join(first.path, 'file.txt'), 'utf8'), 'retained edit\n');
    assert.equal(await readFile(join(first.path, 'untracked.txt'), 'utf8'), 'retained untracked');
    assert.equal((await restarted.revalidateWorkspace({ ...first, path: f.source }, f.base)).kind, 'needs_attention');
    await rm(second.path, { recursive: true });
    await symlink(f.source, second.path, 'junction');
    assert.equal((await restarted.revalidateWorkspace(second, f.base)).kind, 'needs_attention');
    assert.equal(await f.git(f.source, ['status', '--porcelain']), '');
  } finally { await f.close(); }
});

test('conflicts_and_remote_identity_changes_require_attention_without_discarding_work', async () => {
  const f = await fixture();
  try {
    const workspace = await f.manager.prepareWorkspace(task());
    const blob = await f.git(f.source, ['rev-parse', 'HEAD:file.txt']);
    const stages = [1, 2, 3].map(stage => `100644 ${blob} ${stage}\tfile.txt`).join('\n') + '\n';
    const { spawn } = await import('node:child_process');
    await new Promise<void>((resolve, reject) => {
      const p = spawn('git', ['update-index', '--index-info'], { cwd: workspace.path, shell: false, stdio: ['pipe', 'ignore', 'pipe'] });
      p.on('error', reject); p.on('close', code => code === 0 ? resolve() : reject(new Error('fixture index'))); p.stdin.end(stages);
    });
    assert.equal((await f.manager.revalidateWorkspace(workspace, f.base)).kind, 'needs_attention');
    assert.equal(await readFile(join(workspace.path, 'file.txt'), 'utf8'), 'base\n');
    await f.git(workspace.commonGitDirectory, ['config', 'remote.origin.url', 'https://github.com/foreign/project.git']);
    await assert.rejects(f.manager.prepareWorkspace(task()));
  } finally { await f.close(); }
});

test('refuses_untrusted_metadata_and_managed_root_symlinks_before_git', async () => {
  const f = await fixture();
  try {
    f.unprotect(); await assert.rejects(f.manager.prepareWorkspace(task()), /metadata/);
    assert.equal(f.invocations.length, 0);
    const otherRoot = join(f.root, 'other factory'); await mkdir(otherRoot);
    await symlink(f.source, join(otherRoot, 'repositories'), 'junction');
    const manager = createWorkspaceManager({ ...f.options, factoryRoot: otherRoot, metadataBoundary: { assertProtected: async () => {} } });
    await assert.rejects(manager.prepareWorkspace(task()));
    assert.equal(await f.git(f.source, ['status', '--porcelain']), '');
  } finally { await f.close(); }
});

test('reconciles_completed_worktree_add_after_uncertain_result_without_replacing_dirty_files', async () => {
  const f = await fixture();
  try {
    const localGit = createLocalGit();
    const manager = createWorkspaceManager({ ...f.options, localGit: async request => {
      const result = await localGit(request);
      if (request.args[0] === 'worktree') throw new Error('lost completion acknowledgement');
      return result;
    } });
    await assert.rejects(manager.prepareWorkspace(task()));
    const manifests = join(f.factoryRoot, 'workspace-manifests');
    const name = (await readdir(manifests)).find(name => name.startsWith('task-'))!;
    const interrupted = JSON.parse(await readFile(join(manifests, name), 'utf8'));
    assert.equal(interrupted.status, 'preparing');
    const path = interrupted.workspace.path as string;
    await writeFile(join(path, 'file.txt'), 'retained during recovery\n');
    const recovered = await createWorkspaceManager(f.options).prepareWorkspace(task());
    assert.equal(recovered.path, path);
    assert.equal(await readFile(join(path, 'file.txt'), 'utf8'), 'retained during recovery\n');
    assert.equal(JSON.parse(await readFile(join(manifests, name), 'utf8')).status, 'ready');
  } finally { await f.close(); }
});

test('cross_process_lock_is_never_expired_or_removed_by_a_competing_manager', async () => {
  const f = await fixture();
  try {
    const lock = join(f.factoryRoot, '.workspace-manager.lock'); await mkdir(lock);
    await writeFile(join(lock, 'owner.json'), '{"operationId":"unknown-old-operation"}');
    await assert.rejects(f.manager.prepareWorkspace(task()), /recovery|active/);
    assert.equal((await readFile(join(lock, 'owner.json'), 'utf8')).includes('unknown-old-operation'), true);
    assert.equal(f.invocations.length, 0);
    // Test-owned fixture proves there is no writer; production recovery must establish this separately.
    await rm(lock, { recursive: true });
    const workspace = await f.manager.prepareWorkspace(task());
    assert.equal((await f.manager.revalidateWorkspace(workspace, f.base)).kind, 'ready');
  } finally { await f.close(); }
});

test('refuses_changed_git_pointers_config_and_unowned_managed_directories', async () => {
  const f = await fixture();
  try {
    const workspace = await f.manager.prepareWorkspace(task());
    const pointer = join(workspace.path, '.git'); const original = await readFile(pointer, 'utf8');
    await writeFile(pointer, `gitdir: ${f.source}/.git\n`);
    assert.equal((await f.manager.revalidateWorkspace(workspace, f.base)).kind, 'needs_attention');
    await writeFile(pointer, original.replace(/\n$/, '\r\n'));
    assert.equal((await f.manager.revalidateWorkspace(workspace, f.base)).kind, 'ready');
    await writeFile(pointer, original);
    for (const key of ['url.https://foreign.example/.insteadOf', 'url.https://foreign.example/.pushInsteadOf', 'remote.origin.pushurl']) {
      await f.git(workspace.commonGitDirectory, ['config', '--local', key, 'https://github.com/fixture/project.git']);
      assert.equal((await f.manager.revalidateWorkspace(workspace, f.base)).kind, 'needs_attention');
      await f.git(workspace.commonGitDirectory, ['config', '--local', '--unset-all', key]);
    }
    await writeFile(join(workspace.hooksDirectory, 'post-checkout'), '# unapproved');
    await assert.rejects(f.manager.prepareWorkspace(task()));
    await rm(join(workspace.hooksDirectory, 'post-checkout'));
    assert.equal((await f.manager.revalidateWorkspace(workspace, f.base)).kind, 'ready');
    const manifests = join(f.factoryRoot, 'workspace-manifests');
    const taskManifest = (await readdir(manifests)).find(name => name.startsWith('task-'))!;
    await rm(join(manifests, taskManifest));
    await assert.rejects(f.manager.prepareWorkspace(task()), /Unowned/);
    assert.equal(await readFile(join(workspace.path, 'file.txt'), 'utf8'), 'base\n');
  } finally { await f.close(); }
});

test('requires_owned_clone_manifest_before_resuming_a_workspace', async () => {
  const f = await fixture();
  try {
    const workspace = await f.manager.prepareWorkspace(task());
    const manifests = join(f.factoryRoot, 'workspace-manifests');
    const repoManifest = (await readdir(manifests)).find(name => name.startsWith('repository-'))!;
    await rm(join(manifests, repoManifest));
    assert.equal((await f.manager.revalidateWorkspace(workspace, f.base)).kind, 'needs_attention');
    await assert.rejects(f.manager.prepareWorkspace(task()));
    assert.equal(await readFile(join(workspace.path, 'file.txt'), 'utf8'), 'base\n');
  } finally { await f.close(); }
});

test('local_git_ignores_inherited_environment_config_and_bounds_child_output', async () => {
  const f = await fixture();
  const keys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_DIR', 'GIT_WORK_TREE'];
  const previous = keys.map(key => process.env[key]);
  try {
    process.env.GIT_CONFIG_COUNT = '1'; process.env.GIT_CONFIG_KEY_0 = 'injected.flag'; process.env.GIT_CONFIG_VALUE_0 = 'should-not-inherit';
    process.env.GIT_DIR = join(f.root, 'foreign'); process.env.GIT_WORK_TREE = join(f.root, 'foreign');
    const localGit = createLocalGit();
    const result = await localGit({ cwd: f.source, hooksDirectory: f.factoryRoot, args: ['config', '--get', 'injected.flag'], allowedExitCodes: [1] });
    assert.equal(result.code, 1); assert.equal(result.stdout, '');
    await assert.rejects(createLocalGit({ maxBytes: 1 })({ cwd: f.source, hooksDirectory: f.factoryRoot, args: ['rev-parse', 'HEAD'] }), /I\/O limit/);
    assert.throws(() => createLocalGit({ timeoutMs: 0 }));
    assert.throws(() => createLocalGit({ maxBytes: Infinity }));
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    await f.close();
  }
});

test('trusted_closeout_scope_shares_the_manager_lock_and_expires_after_use', async () => {
  const f = await fixture();
  try {
    const workspace = await f.manager.prepareWorkspace(task());
    let escaped: (() => Promise<unknown>) | undefined;
    const other = createWorkspaceManager(f.options);
    await f.manager.withTrustedMetadata(async scope => {
      assert.equal((await scope.revalidateWorkspace(workspace, f.base)).kind, 'ready');
      assert.equal((await other.revalidateWorkspace(workspace, f.base)).kind, 'needs_attention');
      await assert.rejects(other.prepareWorkspace(task()), /active|recovery/);
      escaped = () => scope.revalidateWorkspace(workspace, f.base);
    });
    await assert.rejects(escaped!(), /expired/);
    await assert.rejects(f.manager.withTrustedMetadata(async () => { throw new Error('closeout failed'); }), /closeout failed/);
    assert.equal((await other.revalidateWorkspace(workspace, f.base)).kind, 'ready');
  } finally { await f.close(); }
});
