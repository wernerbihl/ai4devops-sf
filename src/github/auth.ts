import { devNull } from 'node:os';
import type { AuthState, DeviceFlow } from '../contracts/domain.ts';
import { validateContract } from '../contracts/schemas.ts';
import { DefinitiveNoEffect } from '../service/api.ts';
import type { AuthPort, PendingRequest, Reconciliation, RequestContext } from '../service/api.ts';
import {
  createGh,
  fetchJson,
  GitHubFailure,
  GitWriterFailure,
  ProcessFailure,
  jsonObject,
  processEnvironment,
  runProcess,
  safeFailure,
} from './gh.ts';
import type { GhDependencies, HttpPort, HttpResult, ProcessPort } from './gh.ts';
import { createCredentialHelper } from './credential-helper.ts';
import { createDeviceFlow } from './device-flow.ts';
import type { AppConfiguration } from './device-flow.ts';
import { createFileCredentialStore } from './store.ts';
import type { AuthRecord, CredentialStore, SelectedIdentity } from './store.ts';
import { authorizePath, repositoryFacts, validateRepositories } from './capabilities.ts';
import type {
  GitHubOperation,
  GitHubPort,
  RepositoryAccess,
  RepositoryCapabilities,
} from './capabilities.ts';
export type {
  GitHubOperation,
  GitHubPort,
  RepositoryAccess,
  RepositoryCapabilities,
  SelectedIdentity,
  CredentialStore,
};
export interface AuthRequest {
  signal?: AbortSignal;
}
export interface GitHubBackendOptions {
  storageDirectory: string;
  repositories: readonly RepositoryAccess[];
  selectedIdentity?: SelectedIdentity;
  app?: AppConfiguration;
  process?: ProcessPort;
  fetch?: HttpPort;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
  credentialStore?: CredentialStore;
  /** E1/C7/C8 supplies current exact-recipe grant checks. Static repository.operations remains mandatory. */
  authorizeOperation?(repositoryId: string, operation: GitHubOperation, key?: string): Promise<boolean>;
}
export interface GitInvocation {
  repositoryId: string;
  cwd: string;
  ref?: string;
  key?: string;
}
export interface GitAuthPort {
  /** Throws sanitized GitWriterFailure. Unknown completion requires retained metadata exclusion;
   * stopped proves no remaining managed writer, not success or absence of remote/local effects. */
  fetch(input: GitInvocation): Promise<void>;
  push(input: GitInvocation & { ref: string }): Promise<void>;
}
export interface RepositoryCatalogEntry {
  githubId: string;
  owner: string;
  name: string;
  url: string;
  defaultBranch?: string;
}
export interface GitHubBackend {
  resolveGitHubAuth(request: AuthRequest): Promise<AuthState>;
  authApi: AuthPort;
  github: GitHubPort;
  git: GitAuthPort;
  /** Trusted identity-bound metadata only; listing does not authorize repository actions. */
  listRepositories(): Promise<RepositoryCatalogEntry[]>;
  probeRepositoryAccess(repositoryId: string): Promise<RepositoryCapabilities>;
  reconcileRequest(request: PendingRequest): Promise<Reconciliation>;
  /** Trusted broker redaction only. Never expose through a DTO, worker, or health response. */
  secrets(): readonly string[];
}
interface BoundCredential {
  token: string;
  source: NonNullable<AuthState['source']>;
  request(method: string, path: string, body?: unknown): Promise<HttpResult>;
}
/** Composition creates one backend per installation. Raw credentials exist only in this trusted closure/store. */
export function createGitHubBackend(options: GitHubBackendOptions): GitHubBackend {
  validateRepositories(options.repositories);
  if (
    options.selectedIdentity &&
    (!/^\d+$/.test(options.selectedIdentity.accountId) ||
      !/^[a-z\d][a-z\d-]{0,38}$/i.test(options.selectedIdentity.login))
  )
    throw new TypeError('Selected immutable GitHub identity required');
  if (options.app && !/^Iv[\w.-]+$/.test(options.app.clientId))
    throw new TypeError('Publisher GitHub App public client ID required');
  const timeoutMs = options.timeoutMs ?? 10000;
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 16 * 1024 * 1024
  )
    throw new TypeError('Bounded GitHub I/O limits required');
  const processPort = options.process ?? runProcess;
  const fetchPort = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const deps: GhDependencies = {
    process: processPort,
    env: processEnvironment(options.env),
    timeoutMs,
    maxBytes,
  };
  const gh = createGh(deps);
  const helper = createCredentialHelper(deps);
  const store = options.credentialStore ?? createFileCredentialStore(options.storageDirectory);
  const secrets = new Set<string>();
  const registerSecret = (value: string) => {
    if (value) secrets.add(value);
  };
  const device = options.app
    ? createDeviceFlow({ app: options.app, fetch: fetchPort, now, timeoutMs, maxBytes, registerSecret })
    : undefined;
  const scope = { timeoutMs, maxBytes };
  const publicState = (
    record: AuthRecord,
    status: AuthState['status'],
    source?: AuthState['source'],
    reason?: string,
  ): AuthState =>
    validateContract('AuthState', {
      status,
      ...(source ? { source } : {}),
      ...(record.selected ? { accountId: record.selected.accountId, login: record.selected.login } : {}),
      reasons: reason ? [reason] : [],
    });
  function bind(record: AuthRecord, data: unknown): void {
    const user = jsonObject(data);
    if (
      !Number.isSafeInteger(user.id) ||
      (user.id as number) <= 0 ||
      typeof user.login !== 'string' ||
      !/^[a-z\d][a-z\d-]{0,38}$/i.test(user.login)
    )
      throw new GitHubFailure('unavailable', 'GitHub returned an invalid account identity');
    const identity = { accountId: String(user.id), login: user.login };
    if (record.selected && record.selected.accountId !== identity.accountId)
      throw new GitHubFailure(
        'identity_changed',
        'The GitHub account changed; explicitly restore or reselect the configured account',
      );
    record.selected = identity;
  }
  function configureIdentity(record: AuthRecord) {
    if (options.selectedIdentity) {
      if (record.selected && record.selected.accountId !== options.selectedIdentity.accountId)
        throw new GitHubFailure(
          'identity_changed',
          'Configured GitHub identity differs from the stored selection; explicitly migrate the selection',
        );
      record.selected = { ...options.selectedIdentity };
    }
  }
  function credential(
    token: string,
    source: BoundCredential['source'],
    signal?: AbortSignal,
  ): BoundCredential {
    registerSecret(token);
    return {
      token,
      source,
      async request(method, path, body) {
        return fetchJson(
          fetchPort,
          `https://api.github.com${path}`,
          {
            method,
            headers: {
              accept: 'application/vnd.github+json',
              'x-github-api-version': '2026-03-10',
              authorization: `Bearer ${token}`,
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
          { ...scope, ...(signal ? { signal } : {}) },
        );
      },
    };
  }
  async function resolve(
    record: AuthRecord,
    save: () => void,
    request: AuthRequest,
    preflightOnly = false,
  ): Promise<BoundCredential | undefined> {
    let source: AuthState['source'] = 'gh';
    try {
      configureIdentity(record);
      const login = await gh.active(request.signal);
      let bound: BoundCredential | undefined;
      if (login) {
        source = 'gh';
        if (record.selected && login.toLowerCase() !== record.selected.login.toLowerCase())
          throw new GitHubFailure(
            'identity_changed',
            'Active gh account changed; restore the selected account with gh auth switch',
          );
        if (!preflightOnly) {
          const discovery = await gh.user(request.signal);
          bind(record, discovery.data);
          save();
        }
        // gh api has no account selector. Extract the explicitly selected account only, then validate
        // its immutable actor before sending any action. An external gh switch cannot change this actor.
        bound = credential(await gh.selectedToken(login, request.signal), 'gh', request.signal);
      } else {
        source = 'git_helper';
        const token = await helper.token(request.signal);
        if (token) bound = credential(token, 'git_helper', request.signal);
        else if (record.app) {
          source = 'github_app';
          if (record.app.clientId !== options.app?.clientId)
            throw new GitHubFailure(
              'unavailable',
              'Restore the GitHub App client configuration used by the selected credential',
            );
          if (!device)
            throw new GitHubFailure(
              'unavailable',
              'Restore the configured publisher GitHub App client ID or use gh auth login',
            );
          registerSecret(record.app.accessToken);
          registerSecret(record.app.refreshToken);
          if (now() >= record.app.expiresAt) {
            if (preflightOnly)
              throw new GitHubFailure('expired', 'GitHub App credentials need explicit reauthorization');
            if (record.app.refreshPending)
              throw new GitHubFailure(
                'unavailable',
                'GitHub App refresh outcome is unknown; intentionally reauthorize the App',
              );
            const previous = record.app;
            record.app = { ...previous, refreshPending: true };
            save();
            try {
              record.app = await device.refresh(previous);
              save();
            } catch (error) {
              if (error instanceof GitHubFailure && error.kind === 'expired') {
                record.app = { ...previous };
                save();
              }
              throw error;
            }
          }
          bound = credential(record.app.accessToken, 'github_app', request.signal);
        }
      }
      if (!bound) {
        record.state = publicState(
          record,
          'missing',
          undefined,
          'No supported GitHub API credential was found. Use gh auth login; SSH access does not authorize API operations',
        );
        save();
        return undefined;
      }
      bind(record, (await bound.request('GET', '/user')).data);
      record.state = publicState(record, 'ready', bound.source);
      save();
      return bound;
    } catch (error) {
      const safe = safeFailure(error);
      record.state = publicState(record, safe.kind, source, safe.message);
      save();
      return undefined;
    }
  }
  async function requireCredential(record: AuthRecord, save: () => void): Promise<BoundCredential> {
    const bound = await resolve(record, save, {});
    if (!bound)
      throw new GitHubFailure(
        record.state.status === 'missing' ? 'expired' : (record.state.status as GitHubFailure['kind']),
        record.state.reasons[0] ?? 'Repair GitHub authentication',
      );
    return bound;
  }
  async function appPermissions(
    bound: BoundCredential,
    repository: RepositoryAccess,
  ): Promise<Record<string, unknown> | undefined> {
    if (bound.source !== 'github_app') return undefined;
    // GitHub App user access is the intersection of selected user, App permissions, and installed repos.
    // Bound all pages; never infer access from an installation that does not include this exact repo.
    for (let page = 1; page <= 10; page++) {
      const result = jsonObject(
        (await bound.request('GET', `/user/installations?per_page=100&page=${page}`)).data,
      );
      if (!Array.isArray(result.installations))
        throw new GitHubFailure('unavailable', 'Cannot verify GitHub App installation permissions');
      for (const raw of result.installations) {
        const installation = jsonObject(raw);
        if (!Number.isSafeInteger(installation.id))
          throw new GitHubFailure('unavailable', 'Invalid GitHub App installation');
        for (let repoPage = 1; repoPage <= 10; repoPage++) {
          const repos = jsonObject(
            (
              await bound.request(
                'GET',
                `/user/installations/${installation.id}/repositories?per_page=100&page=${repoPage}`,
              )
            ).data,
          );
          if (!Array.isArray(repos.repositories))
            throw new GitHubFailure('unavailable', 'Cannot verify GitHub App repository selection');
          if (
            repos.repositories.some(
              (rawRepo) => jsonObject(rawRepo).full_name === `${repository.owner}/${repository.name}`,
            )
          )
            return jsonObject(installation.permissions);
          if (repos.repositories.length < 100) break;
          if (repoPage === 10)
            throw new GitHubFailure(
              'unavailable',
              'GitHub App repository list exceeds the verification limit',
            );
        }
      }
      if (result.installations.length < 100) break;
      if (page === 10)
        throw new GitHubFailure('unavailable', 'GitHub App installation list exceeds the verification limit');
    }
    throw new GitHubFailure(
      'denied',
      'Install the configured GitHub App for this explicitly allowed repository',
    );
  }
  async function facts(
    record: AuthRecord,
    bound: BoundCredential,
    repository: RepositoryAccess,
  ): Promise<RepositoryCapabilities> {
    return repositoryFacts(
      repository,
      record.selected!.accountId,
      await bound.request('GET', `/repos/${repository.owner}/${repository.name}`),
      await appPermissions(bound, repository),
    );
  }
  async function grant(repository: RepositoryAccess, operation: GitHubOperation, key?: string) {
    if (
      !repository.operations.includes(operation) ||
      (options.authorizeOperation && !(await options.authorizeOperation(repository.id, operation, key)))
    )
      throw new GitHubFailure(
        'denied',
        'GitHub operation lacks the current explicit repository or recipe capability grant',
      );
  }
  function refusal(
    record: AuthRecord,
    save: () => void,
    key: string,
    operation: string,
    code: string,
    recovery: string,
    status: 400 | 403 | 404 | 409 | 503 = 503,
  ): never {
    const error = {
      code,
      message: 'GitHub authentication action was not started',
      recovery,
      retryable: false,
    };
    record.outcomes[key] = { kind: 'failed', operation, status, error };
    save();
    throw new DefinitiveNoEffect(status, error);
  }
  async function mutation<T extends AuthState | DeviceFlow>(
    context: RequestContext,
    operation: string,
    action: (record: AuthRecord, save: () => void) => Promise<T>,
  ): Promise<T> {
    if (!context.key.startsWith('api:') || context.key.length > 220)
      throw new TypeError('Stable authentication request key required');
    return store.run(async (record, save) => {
      const outcome = record.outcomes[context.key];
      if (outcome) {
        if (outcome.operation !== operation)
          throw new GitHubFailure('denied', 'Authentication key was already used for another action');
        if (outcome.kind === 'failed') throw new DefinitiveNoEffect(outcome.status, outcome.error);
        if (outcome.kind === 'complete') return structuredClone(outcome.body) as T;
        throw new GitHubFailure(
          'unavailable',
          'Authentication action outcome is unknown; reconcile this request instead of repeating it',
        );
      }
      record.outcomes[context.key] = { kind: 'pending', operation };
      save();
      try {
        const result = await action(record, save);
        const detached = structuredClone(result);
        record.outcomes[context.key] = { kind: 'complete', operation, body: detached };
        save();
        return detached;
      } catch (error) {
        if (error instanceof DefinitiveNoEffect) throw error;
        throw safeFailure(error);
      }
    });
  }
  const authApi: AuthPort = {
    async state() {
      return structuredClone((await store.read()).state);
    },
    async probe(context) {
      return mutation(context, 'probe', async (record, save) => {
        await resolve(record, save, {});
        return record.state;
      });
    },
    async startDeviceFlow(context) {
      return mutation(context, 'start', async (record, save) => {
        await resolve(record, save, {}, true);
        if (
          record.state.status !== 'missing' &&
          !(
            record.state.source === 'github_app' &&
            (record.state.status === 'expired' || record.app?.refreshPending)
          )
        )
          return refusal(
            record,
            save,
            context.key,
            'start',
            'EXISTING_AUTH_REQUIRES_ATTENTION',
            'Repair the selected existing GitHub identity; device login is only available for absent supported credentials',
            409,
          );
        if (!device)
          return refusal(
            record,
            save,
            context.key,
            'start',
            'APP_NOT_CONFIGURED',
            'Use gh auth login, or install a release configured with a publisher GitHub App public client ID',
          );
        if (!store.protectsSecrets)
          return refusal(
            record,
            save,
            context.key,
            'start',
            'PROTECTED_STORE_REQUIRED',
            'Use gh auth login, or configure an OS-protected credential store for GitHub App secrets',
          );
        const flow = await device.start();
        record.flows[flow.public.id] = flow;
        save();
        return flow.public;
      });
    },
    async deviceFlow(id) {
      const record = await store.read();
      const flow = record.flows[id];
      if (!flow)
        throw new DefinitiveNoEffect(404, {
          code: 'FLOW_NOT_FOUND',
          message: 'GitHub device flow was not found',
          recovery: 'Start a new explicit device flow',
          retryable: false,
        });
      if (flow.public.status === 'pending' && now() >= Date.parse(flow.public.expiresAt)) {
        flow.public.status = 'expired';
      }
      return structuredClone(flow.public);
    },
    async completeDeviceFlow(id, context) {
      return mutation(context, `complete:${id}`, async (record, save) => {
        if (!device)
          return refusal(
            record,
            save,
            context.key,
            `complete:${id}`,
            'APP_NOT_CONFIGURED',
            'Use gh auth login, or install a release configured with a publisher GitHub App public client ID',
          );
        const flow = record.flows[id];
        if (!flow)
          return refusal(
            record,
            save,
            context.key,
            `complete:${id}`,
            'FLOW_NOT_FOUND',
            'Start a new explicit device flow',
            404,
          );
        configureIdentity(record);
        if (flow.public.status === 'authorized') return record.state;
        const app = await device.poll(record, id, save);
        save();
        if (!app) {
          record.state = publicState(
            record,
            flow.public.status === 'denied'
              ? 'denied'
              : flow.public.status === 'expired'
                ? 'expired'
                : 'missing',
            'github_app',
            flow.public.status === 'pending'
              ? 'GitHub authorization is pending; poll with a new request key after the displayed interval'
              : 'GitHub authorization expired or was denied; intentionally restart authorization',
          );
          save();
          return record.state;
        }
        // Persist exchanged credential before validation: transport loss after exchange must not trigger re-poll.
        record.app = app;
        flow.public.status = 'authorized';
        flow.deviceCode = '';
        save();
        try {
          bind(record, (await credential(app.accessToken, 'github_app').request('GET', '/user')).data);
          record.state = publicState(record, 'ready', 'github_app');
        } catch (error) {
          const safe = safeFailure(error);
          record.state = publicState(record, safe.kind, 'github_app', safe.message);
        }
        save();
        return record.state;
      });
    },
  };
  const github: GitHubPort = {
    async request<T>(method: string, path: string, body?: unknown, key?: string) {
      method = method.toUpperCase();
      const authorization = authorizePath(options.repositories, method, path);
      if (method !== 'GET' && (!key || key.length > 220))
        throw new GitHubFailure('denied', 'Stable operation key required for a GitHub write');
      return store.run(async (record, save) => {
        await grant(authorization.repository, authorization.operation, key);
        const bound = await requireCredential(record, save);
        const capabilities = await facts(record, bound, authorization.repository);
        if (!capabilities.operations[authorization.operation])
          throw new GitHubFailure(
            'denied',
            'GitHub credentials do not prove permission for this repository operation',
          );
        // Credential/repository preflight awaits external work; recheck live grants at effect time.
        await grant(authorization.repository, authorization.operation, key);
        // The server remains authoritative: 401/403/SSO/429 are classified, never treated as absent.
        return (await bound.request(method, path, body)).data as T;
      });
    },
  };
  async function invokeGit(input: GitInvocation, push: boolean): Promise<void> {
    const writer: { completion: 'stopped' | 'unknown' } = { completion: 'stopped' };
    try { return await invokeGitOperation(input, push, writer); }
    catch (error) {
      if (error instanceof GitWriterFailure) throw error;
      // Before invocation this is stopped (no writer started). Carry the writer state outside
      // storage cleanup too, so a cleanup failure cannot erase an uncertain process outcome.
      const failure = safeFailure(error);
      throw new GitWriterFailure(writer.completion, failure.message, failure.kind);
    }
  }
  async function invokeGitOperation(input: GitInvocation, push: boolean, writer: { completion: 'stopped' | 'unknown' }): Promise<void> {
    const repository = options.repositories.find((r) => r.id === input.repositoryId);
    if (!repository) throw new GitHubFailure('denied', 'Explicitly allow this Git repository first');
    if (
      input.ref &&
      (!/^refs\/heads\/[A-Za-z\d_./-]+$/.test(input.ref) ||
        input.ref.includes('..') ||
        input.ref.endsWith('/') ||
        input.ref.includes('//') ||
        input.ref.endsWith('.lock'))
    )
      throw new GitHubFailure('denied', 'Use an explicit safe Git branch ref');
    if (push && (!input.ref || !input.key))
      throw new GitHubFailure('denied', 'Explicit branch and operation key required for Git push');
    await store.run(async (record, save) => {
      const operation = push ? 'contents_write' : 'read';
      await grant(repository, operation, input.key);
      const bound = await requireCredential(record, save);
      if (!(await facts(record, bound, repository)).operations[operation])
        throw new GitHubFailure('denied', 'GitHub repository capability does not permit this Git operation');
      // Helper/gh discovery retains the user's real HOME. Authenticated Git must never follow
      // global/system includes into a worker-writable file between preflight and credential use.
      const gitEnv = { ...deps.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull };
      for (const args of [
        ['config', '--null', '--get-regexp', '^url\\..*\\.(insteadof|pushinsteadof)$'],
        ['config', '--local', '--null', '--get-regexp', '^(include|includeif)\\.'],
      ]) {
        const config = await processPort({
          command: 'git',
          args,
          env: gitEnv,
          cwd: input.cwd,
          timeoutMs,
          maxBytes,
        });
        if (config.stdout || config.code !== 1)
          throw new GitHubFailure(
            'denied',
            'Git URL rewriting and repository-local config includes are not supported by authenticated operations',
          );
      }
      const remote = `https://github.com/${repository.owner}/${repository.name}.git`;
      const effective = await processPort({
        command: 'git',
        args: ['ls-remote', '--get-url', remote],
        env: gitEnv,
        cwd: input.cwd,
        timeoutMs,
        maxBytes,
      });
      if (effective.code !== 0 || effective.stdout.trim() !== remote)
        throw new GitHubFailure(
          'denied',
          'Git repository URL rewriting is not permitted for the allowed repository',
        );
      const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${bound.token}`).toString('base64')}`;
      registerSecret(header);
      registerSecret(header.slice(21));
      const env: Record<string, string> = {
        ...gitEnv,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
        GIT_CONFIG_VALUE_0: header,
      };
      delete env.GH_TOKEN;
      delete env.GITHUB_TOKEN;
      // Header is confined to this trusted Git child, never argv, files, remotes or worker environments.
      const args = [
        '-c',
        'credential.helper=',
        '-c',
        'core.askPass=',
        '-c',
        'http.followRedirects=false',
        '-c',
        'http.sslVerify=true',
        '-c',
        'protocol.allow=never',
        '-c',
        'protocol.https.allow=always',
        '-c',
        `core.hooksPath=${options.storageDirectory}/.disabled-hooks`,
        '-c', 'maintenance.auto=false', '-c', 'maintenance.autoDetach=false',
        '-c', 'gc.auto=0', '-c', 'gc.autoDetach=false', '-c', 'fetch.writeCommitGraph=false',
        push ? 'push' : 'fetch',
        '--no-recurse-submodules',
        ...(push ? ['--no-follow-tags'] : ['--no-tags']),
        '--',
        `https://github.com/${repository.owner}/${repository.name}.git`,
        ...(input.ref ? [input.ref] : []),
      ];
      // This refusal is still before a credential-bearing writer exists.
      await grant(repository, operation, input.key);
      try {
        writer.completion = 'unknown';
        const result = await processPort({ command: 'git', args, env, cwd: input.cwd, timeoutMs, maxBytes });
        writer.completion = 'stopped';
        if (result.code !== 0)
          throw new GitWriterFailure(
            'stopped',
            'Git repository operation failed; inspect repository state and reconcile before retrying',
          );
      } catch (error) {
        const completion = error instanceof GitWriterFailure ? error.writerCompletion
          : error instanceof ProcessFailure ? error.completion : 'unknown';
        writer.completion = completion;
        const failure = safeFailure(error);
        throw new GitWriterFailure(completion, failure.message, failure.kind);
      }
    });
  }
  return {
    async resolveGitHubAuth(request) {
      return store.run(async (record, save) => {
        await resolve(record, save, request);
        return structuredClone(record.state);
      });
    },
    authApi,
    github,
    git: { fetch: (input) => invokeGit(input, false), push: (input) => invokeGit(input, true) },
    async listRepositories() {
      return store.run(async (record, save) => {
        const bound = await requireCredential(record, save);
        let remainingRequests = 100;
        // Construct each next-page path locally. Never follow a provider Link URL with this credential.
        const pages = async (path: string, field?: string): Promise<unknown[]> => {
          const all: unknown[] = [];
          for (let page = 1; page <= 10; page++) {
            if (--remainingRequests < 0)
              throw new GitHubFailure(
                'unavailable',
                'GitHub repository catalog request limit reached; narrow App installations before retrying',
              );
            const response = await bound.request('GET', `${path}?per_page=100&page=${page}`);
            const object = field ? jsonObject(response.data) : undefined;
            const items = field ? object![field] : response.data;
            if (!Array.isArray(items) || items.length > 100)
              throw new GitHubFailure('unavailable', 'GitHub repository catalog returned invalid pagination');
            all.push(...items);
            const total = object?.total_count;
            if (total !== undefined && (!Number.isSafeInteger(total) || (total as number) < 0))
              throw new GitHubFailure('unavailable', 'GitHub repository catalog returned an invalid total');
            const more =
              /;\s*rel="?next"?(?:\s|,|$)/i.test(response.headers.get('link') ?? '') ||
              (typeof total === 'number' ? all.length < total : items.length === 100);
            if (!more) return all;
          }
          throw new GitHubFailure(
            'unavailable',
            'GitHub repository catalog pagination limit reached; results are truncated, so no partial catalog was returned',
          );
        };
        const id = (raw: unknown): string => {
          const value = jsonObject(raw).id;
          if (!Number.isSafeInteger(value) || (value as number) <= 0)
            throw new GitHubFailure('unavailable', 'GitHub repository catalog returned an invalid identity');
          return String(value);
        };
        const metadata = (raw: unknown): RepositoryCatalogEntry => {
          const value = jsonObject(raw);
          const owner = jsonObject(value.owner).login;
          const name = value.name;
          if (
            typeof owner !== 'string' ||
            !/^[a-z\d][a-z\d-]{0,38}$/i.test(owner) ||
            typeof name !== 'string' ||
            !/^[a-z\d_.-]{1,100}$/i.test(name) ||
            name === '.' ||
            name === '..' ||
            value.full_name !== `${owner}/${name}`
          )
            throw new GitHubFailure(
              'unavailable',
              'GitHub repository catalog returned invalid repository metadata',
            );
          const branch = value.default_branch;
          if ((branch === null || branch === undefined || branch === '') && value.size !== 0)
            throw new GitHubFailure(
              'unavailable',
              'GitHub repository catalog omitted the default branch for a nonempty repository',
            );
          if (
            branch !== null &&
            branch !== undefined &&
            (typeof branch !== 'string' || /[\x00-\x20\x7f]/.test(branch))
          )
            throw new GitHubFailure(
              'unavailable',
              'GitHub repository catalog returned an invalid default branch',
            );
          return {
            githubId: id(raw),
            owner,
            name,
            url: `https://github.com/${owner}/${name}.git`,
            ...(branch ? { defaultBranch: branch as string } : {}),
          };
        };
        try {
          const catalog = new Map<string, RepositoryCatalogEntry>();
          for (const raw of await pages('/user/repos')) {
            const entry = metadata(raw);
            const previous = catalog.get(entry.githubId);
            if (previous && JSON.stringify(previous) !== JSON.stringify(entry))
              throw new GitHubFailure(
                'unavailable',
                'GitHub repository metadata changed during pagination; retry the catalog',
              );
            catalog.set(entry.githubId, entry);
          }
          let entries = [...catalog.values()];
          if (bound.source === 'github_app') {
            const installed = new Set<string>();
            for (const installation of await pages('/user/installations', 'installations')) {
              const installationId = id(installation);
              for (const repository of await pages(
                `/user/installations/${installationId}/repositories`,
                'repositories',
              ))
                installed.add(id(repository));
            }
            entries = entries.filter((entry) => installed.has(entry.githubId));
          }
          // Check the exact credential actor again before releasing any collected metadata.
          bind(record, (await bound.request('GET', '/user')).data);
          save();
          return entries;
        } catch (error) {
          const safe = safeFailure(error);
          if (safe.kind === 'identity_changed' || safe.kind === 'expired') {
            record.state = publicState(record, safe.kind, bound.source, safe.message);
            save();
          }
          throw safe;
        }
      });
    },
    async probeRepositoryAccess(repositoryId) {
      const repository = options.repositories.find((r) => r.id === repositoryId);
      if (!repository) throw new GitHubFailure('denied', 'Explicitly allow this GitHub repository first');
      return store.run(async (record, save) => {
        await grant(repository, 'read');
        return facts(record, await requireCredential(record, save), repository);
      });
    },
    async reconcileRequest(request) {
      const operation =
        request.method === 'POST' && request.path === '/v1/auth/probe'
          ? 'probe'
          : request.method === 'POST' && request.path === '/v1/auth/device-flow'
            ? 'start'
            : request.method === 'POST' && /^\/v1\/auth\/device-flow\/[^/]+\/complete$/.test(request.path)
              ? `complete:${decodeURIComponent(request.path.split('/')[4]!)}`
              : undefined;
      if (!operation) return { state: 'pending' };
      const record = await store.read();
      const outcome = record.outcomes[`api:${request.key}`];
      if (!outcome || outcome.operation !== operation || outcome.kind === 'pending')
        return { state: 'pending' };
      return outcome.kind === 'complete'
        ? { state: 'complete', body: structuredClone(outcome.body) }
        : { state: 'failed', status: outcome.status, error: structuredClone(outcome.error) };
    },
    secrets: () => [...secrets],
  };
}
