import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createFileCredentialStore } from '../../src/github/store.ts';
import { mkdtempSync, rmSync, readFileSync, statSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitHubBackend } from '../../src/github/auth.ts';
import { runProcess } from '../../src/github/gh.ts';
import type { ProcessPort, ProcessRequest } from '../../src/github/gh.ts';
import { DefinitiveNoEffect } from '../../src/service/api.ts';
const user = { id: 42, login: 'selected-user' };
const repository = {
  id: 101,
  full_name: 'owner/repo',
  private: true,
  permissions: { pull: true, push: true, admin: false },
};
const ghStatus = (login = user.login, state = 'success', error?: string) =>
  JSON.stringify({
    hosts: {
      'github.com': [
        {
          state,
          active: true,
          host: 'github.com',
          login,
          tokenSource: 'keyring',
          ...(error ? { error } : {}),
        },
      ],
    },
  });
function fixture(
  options: {
    status?: string;
    ghMissing?: boolean;
    apiStatus?: number;
    headers?: Record<string, string>;
    helpers?: string;
    helperOutput?: string;
    app?: boolean;
    fetch?: typeof fetch;
    now?: () => number;
    selectedIdentity?: { accountId: string; login: string };
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'sf-c6-'));
  const calls: ProcessRequest[] = [];
  const http: { url: string; init?: RequestInit }[] = [];
  const process: ProcessPort = async (request) => {
    calls.push(request);
    if (request.command === 'gh') {
      if (options.ghMissing) return { code: 127, stdout: '', stderr: 'not installed', missing: true };
      if (request.args[0] === 'auth' && request.args[1] === 'status')
        return { code: 0, stdout: options.status ?? ghStatus(), stderr: '' };
      if (request.args[0] === 'auth' && request.args[1] === 'token')
        return { code: 0, stdout: 'gho_private-fixture-token\n', stderr: '' };
      const path = request.args.find((a) => a.startsWith('/'));
      const status = options.apiStatus ?? 200;
      return {
        code: status === 200 ? 0 : 1,
        stdout: `HTTP/2.0 ${status} Test\r\n${Object.entries(options.headers ?? { 'x-oauth-scopes': 'repo' })
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n')}\r\n\r\n${JSON.stringify(path === '/user' ? user : repository)}`,
        stderr: 'private-fixture-token must not leak',
      };
    }
    if (request.args.includes('--get-url'))
      return { code: 0, stdout: 'https://github.com/owner/repo.git\n', stderr: '' };
    if (request.args[0] === 'config')
      return { code: options.helpers ? 0 : 1, stdout: options.helpers ?? '', stderr: '' };
    return { code: 0, stdout: options.helperOutput ?? '', stderr: '' };
  };
  const fetchPort: typeof fetch =
    options.fetch ??
    (async (input, init) => {
      const url = String(input);
      http.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith('/user')) return Response.json(user, { headers: { 'x-oauth-scopes': 'repo' } });
      if (url.includes('/repos/owner/repo'))
        return Response.json(repository, { headers: { 'x-oauth-scopes': 'repo' } });
      throw new Error('unexpected external URL');
    });
  const config = {
    storageDirectory: join(directory, 'auth'),
    process,
    fetch: fetchPort,
    repositories: [
      {
        id: 'repo-1',
        owner: 'owner',
        name: 'repo',
        operations: ['read', 'contents_write', 'pull_requests_write', 'merge'] as const,
      },
    ],
    ...(options.app ? { app: { clientId: 'Iv1.publisher-public-client' } } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.selectedIdentity ? { selectedIdentity: options.selectedIdentity } : {}),
  };
  const backend = createGitHubBackend(config);
  return {
    backend,
    config,
    directory,
    calls,
    http,
    close() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test('keeps_identity_and_distinguishes_failures', async () => {
  for (const [options, status] of [
    [
      { status: ghStatus('other-user'), selectedIdentity: { accountId: '42', login: user.login } },
      'identity_changed',
    ],
    [{ status: ghStatus(user.login, 'error', 'bad credentials private-fixture-token') }, 'expired'],
    [{ apiStatus: 401 }, 'expired'],
    [{ apiStatus: 403, headers: { 'x-github-sso': 'required; url=private' } }, 'denied'],
    [{ apiStatus: 403 }, 'denied'],
    [{ apiStatus: 429 }, 'unavailable'],
    [{ apiStatus: 503 }, 'unavailable'],
  ] as const) {
    const f = fixture({ ...options, app: true });
    try {
      const state = await f.backend.resolveGitHubAuth({});
      assert.equal(state.status, status);
      assert.equal(JSON.stringify(state).includes('private-fixture-token'), false);
      assert.equal(
        f.http.some((c) => c.url.includes('/login/')),
        false,
      );
      await assert.rejects(f.backend.authApi.startDeviceFlow({ key: 'api:blocked' }), DefinitiveNoEffect);
    } finally {
      f.close();
    }
  }
});
test('reuses_gh_without_exposing_tokens_and_persists_selected_identity', async () => {
  const f = fixture();
  try {
    const state = await f.backend.authApi.probe({ key: 'api:probe' });
    assert.equal(state.status, 'ready');
    assert.equal(state.accountId, '42');
    assert.equal(state.source, 'gh');
    assert.equal((await f.backend.probeRepositoryAccess('repo-1')).operations.contents_write, true);
    const result = await f.backend.github.request<{ id: number }>('GET', '/repos/owner/repo');
    assert.equal(result.id, 101);
    assert.equal(JSON.stringify(state).includes('token'), false);
    assert.equal(
      f.calls.some(
        (c) => c.args.includes('login') || c.args.includes('switch') || c.args.includes('--show-token'),
      ),
      false,
    );
    const persisted = readFileSync(join(f.config.storageDirectory, 'auth.json'), 'utf8');
    assert.equal(persisted.includes('gho_private'), false);
    assert.equal(statSync(join(f.config.storageDirectory, 'auth.json')).mode & 0o777, 0o600);
    const restarted = createGitHubBackend({
      ...f.config,
      process: async (request) =>
        request.args[1] === 'status'
          ? { code: 0, stdout: ghStatus('other-user'), stderr: '' }
          : { code: 0, stdout: '', stderr: '' },
    });
    assert.equal((await restarted.resolveGitHubAuth({})).status, 'identity_changed');
    assert.equal((await restarted.authApi.state()).accountId, '42');
    assert.deepEqual(
      await restarted.reconcileRequest({ key: 'probe', method: 'POST', path: '/v1/auth/probe' }),
      { state: 'complete', body: state },
    );
  } finally {
    f.close();
  }
});
test('helper_protocol_is_noninteractive_and_credentials_never_reach_dtos_errors_or_disk', async () => {
  const f = fixture({
    ghMissing: true,
    helpers: 'cache\0',
    helperOutput: 'username=selected-user\npassword=opaque-helper-secret\n\n',
  });
  try {
    assert.equal((await f.backend.resolveGitHubAuth({})).source, 'git_helper');
    const helper = f.calls.find((c) => c.args.includes('credential-cache'));
    assert.ok(helper);
    assert.equal(helper.input, 'protocol=https\nhost=github.com\n\n');
    assert.equal(helper.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(JSON.stringify(await f.backend.authApi.state()).includes('opaque-helper-secret'), false);
    assert.equal(
      readFileSync(join(f.config.storageDirectory, 'auth.json'), 'utf8').includes('opaque-helper-secret'),
      false,
    );
    assert.equal(
      f.http[0]?.init?.headers && new Headers(f.http[0].init.headers).get('authorization'),
      'Bearer opaque-helper-secret',
    );
  } finally {
    f.close();
  }
  const broken = fixture({
    ghMissing: true,
    helpers: 'cache\0',
    helperOutput: 'password=opaque-helper-secret\nprotocol=http\nhost=evil.test\n\n',
  });
  try {
    assert.equal((await broken.backend.resolveGitHubAuth({})).status, 'unavailable');
    assert.equal(broken.http.length, 0);
  } finally {
    broken.close();
  }
});
test('ssh_only_and_unsupported_helpers_are_not_api_readiness', async () => {
  const f = fixture({ ghMissing: true });
  try {
    assert.equal((await f.backend.resolveGitHubAuth({})).status, 'missing');
  } finally {
    f.close();
  }
  const unsupported = fixture({ ghMissing: true, helpers: '!echo password=secret\0' });
  try {
    assert.equal((await unsupported.backend.resolveGitHubAuth({})).status, 'unavailable');
    assert.equal(unsupported.calls.length, 2);
  } finally {
    unsupported.close();
  }
});
test('repository_allowlist_operation_grants_and_denied_writes_are_enforced', async () => {
  const f = fixture();
  try {
    await f.backend.resolveGitHubAuth({});
    await assert.rejects(f.backend.github.request('GET', 'https://evil.test/repos/owner/repo'));
    await assert.rejects(f.backend.github.request('GET', '/repos/owner/other'));
    await assert.rejects(f.backend.github.request('POST', '/repos/owner/repo/issues', {}, 'write'));
    await assert.rejects(f.backend.github.request('GET', '/repos/owner/repo/../other'));
    const restricted = createGitHubBackend({
      ...f.config,
      repositories: [{ id: 'repo-1', owner: 'owner', name: 'repo', operations: ['read'] }],
    });
    await assert.rejects(
      restricted.github.request('PUT', '/repos/owner/repo/contents/file', { content: 'safe' }, 'write'),
    );
    const denied = createGitHubBackend({
      ...f.config,
      fetch: async (url, init) =>
        init?.method === 'PUT'
          ? Response.json({ message: 'opaque-helper-secret' }, { status: 403 })
          : Response.json(String(url).endsWith('/user') ? user : repository, {
              headers: { 'x-oauth-scopes': 'repo' },
            }),
    });
    await assert.rejects(
      denied.github.request('PUT', '/repos/owner/repo/contents/file', { content: 'safe' }, 'write'),
      (e) => e instanceof Error && !e.message.includes('opaque-helper-secret'),
    );
  } finally {
    f.close();
  }
});
test('missing_publisher_app_config_is_definitive_actionable_and_replays_after_restart', async () => {
  const f = fixture({ ghMissing: true });
  try {
    await assert.rejects(
      f.backend.authApi.startDeviceFlow({ key: 'api:no-app' }),
      (e) =>
        e instanceof DefinitiveNoEffect &&
        e.status === 503 &&
        e.error.code === 'APP_NOT_CONFIGURED' &&
        e.error.recovery?.includes('gh auth login') === true,
    );
    const restarted = createGitHubBackend({ ...f.config, app: { clientId: 'Iv1.now-configured' } });
    const prior = await restarted.reconcileRequest({
      key: 'no-app',
      method: 'POST',
      path: '/v1/auth/device-flow',
    });
    assert.equal(prior.state, 'failed');
    await assert.rejects(restarted.authApi.startDeviceFlow({ key: 'api:no-app' }), DefinitiveNoEffect);
    assert.equal(f.http.length, 0);
  } finally {
    f.close();
  }
});
test('device_flow_refresh_needs_no_distributed_secret_and_respects_poll_interval', async () => {
  let now = Date.parse('2026-11-05T12:00:00Z');
  let starts = 0;
  let polls = 0;
  let refreshes = 0;
  const bodies: string[] = [];
  const fetchPort: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = String(init?.body ?? '');
    bodies.push(body);
    if (url.endsWith('/login/device/code')) {
      starts++;
      return Response.json({
        device_code: 'private-device-code',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      });
    }
    if (url.endsWith('/login/oauth/access_token')) {
      if (body.includes('refresh_token')) {
        refreshes++;
        return Response.json({
          access_token: 'ghu_rotated-private',
          refresh_token: 'ghr_rotated-private',
          expires_in: 28800,
          refresh_token_expires_in: 15897600,
          token_type: 'bearer',
        });
      }
      polls++;
      return Response.json({
        access_token: 'ghu_initial-private',
        refresh_token: 'ghr_initial-private',
        expires_in: 1,
        refresh_token_expires_in: 15897600,
        token_type: 'bearer',
      });
    }
    return Response.json(url.endsWith('/user') ? user : repository);
  };
  const f = fixture({ ghMissing: true, app: true, fetch: fetchPort, now: () => now });
  try {
    const flow = await f.backend.authApi.startDeviceFlow({ key: 'api:start' });
    assert.equal(flow.status, 'pending');
    assert.equal(starts, 1);
    assert.equal(JSON.stringify(flow).includes('private-device-code'), false);
    assert.equal(
      (await f.backend.authApi.completeDeviceFlow(flow.id, { key: 'api:early' })).status,
      'missing',
    );
    assert.equal(polls, 0);
    now += 5000;
    assert.equal(
      (await f.backend.authApi.completeDeviceFlow(flow.id, { key: 'api:complete' })).status,
      'ready',
    );
    assert.equal(polls, 1);
    now += 2000;
    const restarted = createGitHubBackend(f.config);
    const states = await Promise.all([restarted.resolveGitHubAuth({}), restarted.resolveGitHubAuth({})]);
    assert.ok(states.every((s) => s.status === 'ready'));
    assert.equal(refreshes, 1);
    assert.equal(
      bodies.some((b) => b.includes('client_secret')),
      false,
    );
    assert.ok(bodies.some((b) => b.includes('scope=offline_access')));
    assert.equal((await restarted.authApi.deviceFlow(flow.id)).status, 'authorized');
    assert.equal(
      JSON.stringify(
        await restarted.reconcileRequest({
          key: 'complete',
          method: 'POST',
          path: `/v1/auth/device-flow/${flow.id}/complete`,
        }),
      ).includes('ghu_'),
      false,
    );
  } finally {
    f.close();
  }
});
test('unknown_device_authorization_is_durable_pending_and_never_reexecuted', async () => {
  let starts = 0;
  const f = fixture({
    ghMissing: true,
    app: true,
    fetch: async () => {
      starts++;
      throw new Error('private-device-code');
    },
  });
  try {
    await assert.rejects(
      f.backend.authApi.startDeviceFlow({ key: 'api:unknown' }),
      (e) =>
        e instanceof Error &&
        !(e instanceof DefinitiveNoEffect) &&
        !e.message.includes('private-device-code'),
    );
    const restarted = createGitHubBackend(f.config);
    assert.deepEqual(
      await restarted.reconcileRequest({ key: 'unknown', method: 'POST', path: '/v1/auth/device-flow' }),
      { state: 'pending' },
    );
    await assert.rejects(restarted.authApi.startDeviceFlow({ key: 'api:unknown' }));
    assert.equal(starts, 1);
  } finally {
    f.close();
  }
});
test('protected_auth_store_refuses_symlink_directories', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.directory, 'target'));
    symlinkSync(join(f.directory, 'target'), f.config.storageDirectory);
    await assert.rejects(f.backend.resolveGitHubAuth({}));
    assert.equal(statSync(join(f.directory, 'target')).mode & 0o777, 0o755);
  } finally {
    f.close();
  }
});
test('production_process_port_bounds_output_timeout_and_sanitizes_errors', async () => {
  const env = { PATH: process.env.PATH ?? '' };
  const result = await runProcess({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("ok")'],
    env,
    timeoutMs: 1000,
    maxBytes: 32,
  });
  assert.equal(result.stdout, 'ok');
  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("private".repeat(100))'],
      env,
      timeoutMs: 1000,
      maxBytes: 32,
    }),
    (e) => e instanceof Error && !e.message.includes('private'),
  );
  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: ['-e', 'setTimeout(()=>{},10000)'],
      env,
      timeoutMs: 20,
      maxBytes: 32,
    }),
  );
});
test('real_empty_gh_json_is_absent_and_network_status_is_unavailable', async () => {
  const f = fixture({ status: '{"hosts":{}}' });
  try {
    assert.equal((await f.backend.resolveGitHubAuth({})).status, 'missing');
  } finally {
    f.close();
  }
  const network = fixture({
    status: ghStatus(user.login, 'error', 'network connection reset private-fixture-token'),
  });
  try {
    assert.equal((await network.backend.resolveGitHubAuth({})).status, 'unavailable');
  } finally {
    network.close();
  }
});
test('selected_account_token_mismatch_never_performs_repository_actions', async () => {
  let repositoryCalls = 0;
  const f = fixture({
    fetch: async (url) => {
      if (String(url).includes('/repos/')) repositoryCalls++;
      return Response.json({ id: 99, login: 'other-user' });
    },
  });
  try {
    assert.equal((await f.backend.resolveGitHubAuth({})).status, 'identity_changed');
    await assert.rejects(
      f.backend.github.request('PUT', '/repos/owner/repo/contents/file', { content: 'safe' }, 'key'),
    );
    assert.equal(repositoryCalls, 0);
  } finally {
    f.close();
  }
});
test('private_git_bridge_scopes_credential_to_child_and_rechecks_recipe_grants', async () => {
  const f = fixture();
  try {
    await f.backend.git.fetch({ repositoryId: 'repo-1', cwd: f.directory, ref: 'refs/heads/main' });
    const git = f.calls.find((c) => c.args.includes('fetch'));
    assert.ok(git);
    assert.ok(git.env.GIT_CONFIG_VALUE_0?.startsWith('AUTHORIZATION: basic '));
    assert.equal(git.args.join(' ').includes('gho_private'), false);
    assert.equal(git.args.includes('https://github.com/owner/repo.git'), true);
    assert.ok(git.args.includes('protocol.allow=never'));
    assert.ok(git.args.some((a) => a.startsWith('core.hooksPath=')));
    assert.equal(git.env.GH_TOKEN, undefined);
    assert.equal(JSON.stringify(await f.backend.authApi.state()).includes('AUTHORIZATION'), false);
    const denied = createGitHubBackend({ ...f.config, authorizeOperation: async () => false });
    await assert.rejects(
      denied.git.push({ repositoryId: 'repo-1', cwd: f.directory, ref: 'refs/heads/work', key: 'push' }),
    );
  } finally {
    f.close();
  }
});
test('windows_metadata_store_keeps_gh_usable_but_refuses_app_secrets_before_authorization', async () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const f = fixture({ ghMissing: true, app: true });
  try {
    Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
    const app = createGitHubBackend(f.config);
    await assert.rejects(
      app.authApi.startDeviceFlow({ key: 'api:windows' }),
      (e) => e instanceof DefinitiveNoEffect && e.error.code === 'PROTECTED_STORE_REQUIRED',
    );
    assert.equal(f.http.length, 0);
    const gh = fixture();
    try {
      assert.equal((await gh.backend.resolveGitHubAuth({})).status, 'ready');
    } finally {
      gh.close();
    }
  } finally {
    Object.defineProperty(process, 'platform', original);
    f.close();
  }
});
test('unknown_token_exchange_blocks_new_poll_keys', async () => {
  let now = 0;
  let polls = 0;
  const f = fixture({
    ghMissing: true,
    app: true,
    now: () => now,
    fetch: async (url) => {
      if (String(url).endsWith('/login/device/code'))
        return Response.json({
          device_code: 'private',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        });
      polls++;
      throw new Error('private');
    },
  });
  try {
    const flow = await f.backend.authApi.startDeviceFlow({ key: 'api:start-unknown-poll' });
    now = 5000;
    await assert.rejects(f.backend.authApi.completeDeviceFlow(flow.id, { key: 'api:poll-one' }));
    const restarted = createGitHubBackend(f.config);
    await assert.rejects(restarted.authApi.completeDeviceFlow(flow.id, { key: 'api:poll-two' }));
    assert.equal(polls, 1);
  } finally {
    f.close();
  }
});

test('git_bridge_rejects_effective_remote_rewrites_before_attaching_credentials', async () => {
  const f = fixture();
  try {
    let authenticatedInvocations = 0;
    const backend = createGitHubBackend({
      ...f.config,
      process: async (request) => {
        if (request.env.GIT_CONFIG_VALUE_0) authenticatedInvocations++;
        if (request.args.includes('--get-url'))
          return { code: 0, stdout: 'https://github.com/other/repo.git\n', stderr: '' };
        return f.config.process(request);
      },
    });
    await assert.rejects(backend.git.fetch({ repositoryId: 'repo-1', cwd: f.directory }));
    assert.equal(authenticatedInvocations, 0);
  } finally {
    f.close();
  }
});
test('credential_store_lock_is_released_by_kernel_after_process_crash', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sf-c6-lock-'));
  const storage = join(directory, 'private');
  const script = `import {createFileCredentialStore} from ${JSON.stringify(new URL('../../src/github/store.ts', import.meta.url).href)};await createFileCredentialStore(${JSON.stringify(storage)}).run(async(record,save)=>{record.state={status:'missing',reasons:['Saved before crash']};save();process.stdout.write('locked\\n');setInterval(()=>{},1000);await new Promise(()=>{});});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('lock child timeout')), 3000);
      child.stdout.once('data', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`lock child exited ${code}`));
      });
    });
    await assert.rejects(createFileCredentialStore(storage).run(async () => true));
    const exited = new Promise<string | null>((resolve) =>
      child.once('exit', (_code, signal) => resolve(signal)),
    );
    assert.equal(child.kill('SIGKILL'), true);
    assert.equal(await exited, 'SIGKILL');
    const state = await createFileCredentialStore(storage).run(async (record) => record.state);
    assert.deepEqual(state, { status: 'missing', reasons: ['Saved before crash'] });
  } finally {
    child.kill('SIGKILL');
    rmSync(directory, { force: true, recursive: true });
  }
});
test('readonly_reconciliation_sees_durable_pending_during_an_inflight_request', async () => {
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = fixture({
    ghMissing: true,
    app: true,
    fetch: async () => {
      entered();
      await pending;
      throw new Error('lost response');
    },
  });
  try {
    const action = f.backend.authApi.startDeviceFlow({ key: 'api:inflight' });
    action.catch(() => {});
    await started;
    const second = createGitHubBackend(f.config);
    const result = await Promise.race([
      second.reconcileRequest({ key: 'inflight', method: 'POST', path: '/v1/auth/device-flow' }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('read blocked behind external effect')), 100),
      ),
    ]);
    assert.deepEqual(result, { state: 'pending' });
    release();
    await assert.rejects(action);
  } finally {
    release();
    f.close();
  }
});
test('git_bridge_rejects_pushinsteadof_and_local_include_configuration', async () => {
  for (const output of [
    'url.https://github.com/evil/.pushinsteadof\nhttps://github.com/owner/\0',
    'include.path\n/tmp/untrusted\0',
  ]) {
    const f = fixture();
    try {
      let sends = 0;
      const backend = createGitHubBackend({
        ...f.config,
        process: async (request) => {
          if (request.env.GIT_CONFIG_VALUE_0) sends++;
          if (request.args[0] === 'config' && request.args.includes('--get-regexp'))
            return { code: 0, stdout: output, stderr: '' };
          return f.config.process(request);
        },
      });
      await assert.rejects(
        backend.git.push({ repositoryId: 'repo-1', cwd: f.directory, ref: 'refs/heads/work', key: 'push' }),
      );
      assert.equal(sends, 0);
    } finally {
      f.close();
    }
  }
});
test('app_permission_intersection_and_fine_grained_unknown_writes_stay_truthful', async () => {
  let now = 0;
  const app = fixture({
    ghMissing: true,
    app: true,
    now: () => now,
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith('/login/device/code'))
        return Response.json({
          device_code: 'private',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        });
      if (url.endsWith('/login/oauth/access_token'))
        return Response.json({
          access_token: 'ghu_private',
          refresh_token: 'ghr_private',
          expires_in: 28800,
          refresh_token_expires_in: 15897600,
          token_type: 'bearer',
        });
      if (url.includes('/user/installations/7/repositories'))
        return Response.json({ repositories: [repository], total_count: 1 });
      if (url.includes('/user/installations'))
        return Response.json({
          installations: [{ id: 7, permissions: { contents: 'read', pull_requests: 'write' } }],
          total_count: 1,
        });
      return Response.json(url.endsWith('/user') ? user : repository);
    },
  });
  try {
    const flow = await app.backend.authApi.startDeviceFlow({ key: 'api:start-permissions' });
    now = 5000;
    await app.backend.authApi.completeDeviceFlow(flow.id, { key: 'api:finish-permissions' });
    const facts = await app.backend.probeRepositoryAccess('repo-1');
    assert.deepEqual(facts.operations, {
      read: true,
      contents_write: false,
      pull_requests_write: true,
      merge: false,
    });
    assert.equal(facts.bypass, 'unproven');
  } finally {
    app.close();
  }
  const fine = fixture({
    fetch: async (input) => Response.json(String(input).endsWith('/user') ? user : repository),
  });
  try {
    const facts = await fine.backend.probeRepositoryAccess('repo-1');
    assert.equal(facts.operations.read, true);
    assert.equal(facts.operations.contents_write, false);
    assert.ok(facts.reasons.length > 0);
  } finally {
    fine.close();
  }
});
test('device_flow_slowdown_denial_and_expiry_follow_provider_interval', async () => {
  let now = 0;
  let polls = 0;
  const f = fixture({
    ghMissing: true,
    app: true,
    now: () => now,
    fetch: async (input) => {
      if (String(input).endsWith('/login/device/code'))
        return Response.json({
          device_code: 'private',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://github.com/login/device',
          expires_in: 30,
          interval: 5,
        });
      polls++;
      return Response.json(polls === 1 ? { error: 'slow_down', interval: 10 } : { error: 'access_denied' });
    },
  });
  try {
    const flow = await f.backend.authApi.startDeviceFlow({ key: 'api:start-interval' });
    now = 5000;
    await f.backend.authApi.completeDeviceFlow(flow.id, { key: 'api:slow' });
    assert.equal((await f.backend.authApi.deviceFlow(flow.id)).pollIntervalMs, 10000);
    now = 14000;
    await f.backend.authApi.completeDeviceFlow(flow.id, { key: 'api:too-soon' });
    assert.equal(polls, 1);
    now = 15000;
    assert.equal(
      (await f.backend.authApi.completeDeviceFlow(flow.id, { key: 'api:denied' })).status,
      'denied',
    );
    assert.equal((await f.backend.authApi.deviceFlow(flow.id)).status, 'denied');
    const other = await f.backend.authApi.startDeviceFlow({ key: 'api:restart-absent' });
    now = 46000;
    assert.equal((await f.backend.authApi.deviceFlow(other.id)).status, 'expired');
  } finally {
    f.close();
  }
});
test('unknown_refresh_is_not_retried_and_explicit_reauthorization_remains_available', async () => {
  let now = 0;
  let refreshes = 0;
  const f = fixture({
    ghMissing: true,
    app: true,
    now: () => now,
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/login/device/code'))
        return Response.json({
          device_code: 'private',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        });
      if (url.endsWith('/login/oauth/access_token')) {
        if (String(init?.body).includes('grant_type=refresh_token')) {
          refreshes++;
          throw new Error('private refresh lost');
        }
        return Response.json({
          access_token: 'ghu_private',
          refresh_token: 'ghr_private',
          expires_in: 1,
          refresh_token_expires_in: 15897600,
          token_type: 'bearer',
        });
      }
      return Response.json(user);
    },
  });
  try {
    const flow = await f.backend.authApi.startDeviceFlow({ key: 'api:start-refresh' });
    now = 5000;
    await f.backend.authApi.completeDeviceFlow(flow.id, { key: 'api:complete-refresh' });
    now = 7000;
    assert.equal((await f.backend.resolveGitHubAuth({})).status, 'unavailable');
    const restarted = createGitHubBackend(f.config);
    assert.equal((await restarted.resolveGitHubAuth({})).status, 'unavailable');
    assert.equal(refreshes, 1);
    assert.equal((await restarted.authApi.startDeviceFlow({ key: 'api:reauthorize' })).status, 'pending');
    assert.equal(refreshes, 1);
  } finally {
    f.close();
  }
});
test('explicit_app_reauthorization_does_not_refresh_before_no_effect_preflight', async () => {
  let now = 0;
  let refreshes = 0;
  const f = fixture({
    ghMissing: true,
    app: true,
    now: () => now,
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/login/device/code'))
        return Response.json({
          device_code: 'private',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        });
      if (url.endsWith('/login/oauth/access_token')) {
        if (String(init?.body).includes('grant_type=refresh_token')) refreshes++;
        return Response.json({
          access_token: 'ghu_private',
          refresh_token: 'ghr_private',
          expires_in: 1,
          refresh_token_expires_in: 15897600,
          token_type: 'bearer',
        });
      }
      return Response.json(user);
    },
  });
  try {
    const first = await f.backend.authApi.startDeviceFlow({ key: 'api:start-first' });
    now = 5000;
    await f.backend.authApi.completeDeviceFlow(first.id, { key: 'api:complete-first' });
    now = 7000;
    assert.equal((await f.backend.authApi.startDeviceFlow({ key: 'api:explicit-repair' })).status, 'pending');
    assert.equal(refreshes, 0);
  } finally {
    f.close();
  }
});
