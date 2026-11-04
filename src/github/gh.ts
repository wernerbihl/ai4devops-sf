import { spawn } from 'node:child_process';
import type { AuthState } from '../contracts/domain.ts';
export interface ProcessRequest {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  input?: string;
  cwd?: string;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
}
export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  missing?: boolean;
}
export type ProcessPort = (request: ProcessRequest) => Promise<ProcessResult>;
/** Captured output is private and is never forwarded to logging/UI. */
export const runProcess: ProcessPort = (request) =>
  new Promise((resolve, reject) => {
    const child = spawn(request.command, [...request.args], {
      shell: false,
      env: request.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(request.cwd ? { cwd: request.cwd } : {}),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error, result?: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', abort);
      if (error) {
        child.kill('SIGKILL');
        reject(error);
      } else resolve(result!);
    };
    const abort = () =>
      finish(new GitHubFailure('unavailable', 'GitHub operation cancelled; retry intentionally'));
    const timer = setTimeout(
      () => finish(new GitHubFailure('unavailable', 'GitHub operation timed out; check connectivity')),
      request.timeoutMs,
    );
    for (const [stream, chunks] of [
      [child.stdout, out],
      [child.stderr, err],
    ] as const)
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > request.maxBytes)
          finish(new GitHubFailure('unavailable', 'GitHub output limit exceeded'));
        else chunks.push(chunk);
      });
    child.on('error', (error) => {
      if ('code' in error && error.code === 'ENOENT')
        finish(undefined, { code: 127, stdout: '', stderr: '', missing: true });
      else finish(new GitHubFailure('unavailable', 'GitHub process could not start'));
    });
    child.on('close', (code) =>
      finish(undefined, {
        code: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(request.input ?? '');
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
  });
export type FailureKind = Exclude<AuthState['status'], 'ready' | 'missing'>;
export class GitHubFailure extends Error {
  readonly kind: FailureKind;
  constructor(kind: FailureKind, recovery: string) {
    super(recovery);
    this.name = 'GitHubFailure';
    this.kind = kind;
  }
}
export function failureFor(status: number, headers: Headers): GitHubFailure {
  if (status === 401)
    return new GitHubFailure(
      'expired',
      'GitHub credentials expired or were revoked; repair the selected account with gh auth login',
    );
  if (
    status === 429 ||
    (status === 403 && (headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after')))
  )
    return new GitHubFailure('unavailable', 'GitHub rate limit reached; wait before retrying');
  if (status === 403 && headers.get('x-github-sso')?.includes('required'))
    return new GitHubFailure('denied', 'Authorize the selected GitHub credential for organization SSO');
  if (status === 403 || status === 404)
    return new GitHubFailure(
      'denied',
      'GitHub denied this repository or operation; review account, repository access and token permissions',
    );
  return new GitHubFailure('unavailable', 'GitHub is unavailable; check connectivity and retry');
}
export function safeFailure(error: unknown): GitHubFailure {
  return error instanceof GitHubFailure
    ? error
    : new GitHubFailure('unavailable', 'GitHub request failed; check connectivity and retry');
}
export function processEnvironment(input: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    'PATH',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SystemRoot',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'GH_CONFIG_DIR',
    'GH_TOKEN',
    'GITHUB_TOKEN',
  ])
    if (input[key] !== undefined) env[key] = input[key]!;
  return {
    ...env,
    GH_PROMPT_DISABLED: '1',
    GH_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    GCM_GUI_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
  };
}
export interface HttpResult {
  data: unknown;
  headers: Headers;
}
export type HttpPort = typeof fetch;
export async function fetchJson(
  fetchPort: HttpPort,
  url: string,
  init: RequestInit = {},
  options: { timeoutMs: number; maxBytes: number; signal?: AbortSignal },
): Promise<HttpResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  try {
    const response = await fetchPort(url, { ...init, redirect: 'error', signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw failureFor(response.status, response.headers);
    }
    const length = Number(response.headers.get('content-length'));
    if (length > options.maxBytes) {
      await response.body?.cancel();
      throw new GitHubFailure('unavailable', 'GitHub response limit exceeded');
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (reader)
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > options.maxBytes) {
            await reader.cancel();
            throw new GitHubFailure('unavailable', 'GitHub response limit exceeded');
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
    return {
      data: size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null,
      headers: response.headers,
    };
  } catch (error) {
    throw safeFailure(error);
  }
}
export function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GitHubFailure('unavailable', 'GitHub returned an invalid response');
  return value as Record<string, unknown>;
}
export function parseGhResponse(result: ProcessResult): HttpResult {
  const normalized = result.stdout.replaceAll('\r\n', '\n');
  const split = normalized.indexOf('\n\n');
  const first = normalized.slice(0, split);
  const status = Number(/^HTTP\/\S+\s+(\d{3})/.exec(first)?.[1]);
  const headers = new Headers();
  if (split < 0 || !status)
    throw new GitHubFailure(
      'unavailable',
      'GitHub CLI returned an invalid API response; update gh and retry',
    );
  for (const line of first.split('\n').slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
  }
  if (status < 200 || status >= 300) throw failureFor(status, headers);
  if (result.code !== 0) throw new GitHubFailure('unavailable', 'GitHub CLI request failed; retry');
  try {
    return { data: JSON.parse(normalized.slice(split + 2)), headers };
  } catch {
    throw new GitHubFailure('unavailable', 'GitHub CLI returned invalid JSON');
  }
}
export interface GhDependencies {
  process: ProcessPort;
  env: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
}
export function createGh(deps: GhDependencies) {
  const run = async (args: string[], signal?: AbortSignal) => {
    try {
      return await deps.process({
        command: 'gh',
        args,
        env: deps.env,
        timeoutMs: deps.timeoutMs,
        maxBytes: deps.maxBytes,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw safeFailure(error);
    }
  };
  return {
    async active(signal?: AbortSignal): Promise<string | undefined> {
      const result = await run(
        ['auth', 'status', '--hostname', 'github.com', '--active', '--json', 'hosts', '--no-refresh'],
        signal,
      );
      if (result.missing) return undefined;
      let value: Record<string, unknown>;
      try {
        value = jsonObject(JSON.parse(result.stdout));
      } catch {
        throw new GitHubFailure(
          'unavailable',
          'Cannot inspect GitHub CLI authentication; update gh and retry',
        );
      }
      const hosts = jsonObject(value.hosts);
      const entries = hosts['github.com'];
      if (entries === undefined && result.code === 0) return undefined;
      if (!Array.isArray(entries))
        throw new GitHubFailure('unavailable', 'Cannot inspect GitHub CLI accounts; update gh and retry');
      if (entries.length === 0) return undefined;
      const active = entries.filter((e) => jsonObject(e).active === true);
      if (active.length !== 1)
        throw new GitHubFailure('unavailable', 'Select one active GitHub account with gh auth switch');
      const account = jsonObject(active[0]);
      if (account.state !== 'success' || account.error) {
        if (account.state === 'timeout')
          throw new GitHubFailure('unavailable', 'GitHub account check timed out; retry');
        const detail = typeof account.error === 'string' ? account.error : '';
        if (
          /bad credentials|invalid token|expired|revoked|\b401\b/i.test(detail) ||
          account.state === 'refresh_expired'
        )
          throw new GitHubFailure(
            'expired',
            'GitHub CLI account requires repair; use gh auth login for the selected account',
          );
        if (/\b429\b|rate limit/i.test(detail))
          throw new GitHubFailure('unavailable', 'GitHub rate limit reached; wait before retrying');
        if (/\b403\b|forbidden|sso/i.test(detail))
          throw new GitHubFailure(
            'denied',
            'GitHub CLI account was denied; review repository and SSO authorization',
          );
        throw new GitHubFailure(
          'unavailable',
          'GitHub CLI account check failed; check connectivity and retry',
        );
      }
      if (
        result.code !== 0 ||
        typeof account.login !== 'string' ||
        !/^[a-z\d][a-z\d-]{0,38}$/i.test(account.login)
      )
        throw new GitHubFailure('unavailable', 'GitHub CLI account response is invalid');
      return account.login;
    },
    async user(signal?: AbortSignal): Promise<HttpResult> {
      return parseGhResponse(
        await run(['api', '--hostname', 'github.com', '--include', '--method', 'GET', '/user'], signal),
      );
    },
    async selectedToken(login: string, signal?: AbortSignal): Promise<string> {
      const result = await run(
        ['auth', 'token', '--hostname', 'github.com', '--user', login, '--no-refresh'],
        signal,
      );
      const token = result.stdout.trim();
      if (result.code !== 0 || !token || /\s/.test(token) || token.length > 4096)
        throw new GitHubFailure(
          'expired',
          'Cannot reuse the selected GitHub account; repair it with gh auth login',
        );
      return token;
    },
  };
}
