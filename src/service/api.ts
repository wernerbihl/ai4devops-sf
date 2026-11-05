import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiError, AuthState, Clock, DeviceFlow, Health, OwnerReadiness, NativeIdentity, NativeOpenResult, RecipeCreate, RecipePatch, RecipeSummary, RecipeRevision, RecipeValidation } from '../contracts/domain.ts';
import type { FactoryStore } from '../storage/store.ts';
import type { Scheduler } from '../scheduling/admission.ts';
import type { Lifecycle } from '../scheduling/lifecycle.ts';
import { validateContract } from '../contracts/schemas.ts';
import { SessionError, Sessions } from './session.ts';
import type { SessionPolicy } from './session.ts';
import { ApiFault, resultFor, routes, safeFailure } from './routes.ts';
import type { Route } from './routes.ts';
import { sanitize } from './snapshot.ts';
import { eventStream } from './events.ts';
import type { MaintenanceGate } from './maintenance-gate.ts';
export type { FactorySnapshot } from '../contracts/domain.ts';
export type { SessionPolicy, ProvisionedSession } from './session.ts';
export type ApiFailureStatus = 400 | 401 | 403 | 404 | 409 | 429 | 503;
function validateFailureStatus(status: number): asserts status is ApiFailureStatus {
  if (![400, 401, 403, 404, 409, 429, 503].includes(status)) throw new TypeError('Unsupported API failure status');
}
/** Trusted adapters may throw this ONLY after proving the command had no external effect.
 * Uncertain acceptance/transport errors must remain ordinary exceptions, preserving pending state. */
export class DefinitiveNoEffect extends Error {
  readonly status: ApiFailureStatus;
  readonly error: ApiError;
  constructor(status: ApiFailureStatus, error: ApiError) {
    super('Definitive external refusal'); this.name = 'DefinitiveNoEffect';
    validateFailureStatus(status); this.status = status; this.error = structuredClone(validateContract('ApiError', error));
  }
}
export interface RequestContext { /** Durable API key. Adapters must use it for external deduplication. */ key: string; expectedRevision?: number }
export interface AuthPort {
  state(): Promise<AuthState>;
  probe(context: RequestContext): Promise<AuthState>;
  startDeviceFlow(context: RequestContext): Promise<DeviceFlow>;
  deviceFlow(id: string): Promise<DeviceFlow>;
  completeDeviceFlow(id: string, context: RequestContext): Promise<AuthState>;
}
export interface RecipePort {
  /** E1 validates hash-bound explicit grants before activation; browser routes never set readiness. */
  patch(id: string, input: RecipePatch, context: RequestContext): Promise<RecipeSummary>;
  create(input: RecipeCreate, context: RequestContext): Promise<RecipeRevision>;
  validate(input: RecipeCreate, context: RequestContext): Promise<RecipeValidation>;
  revise(id: string, input: RecipeCreate, context: RequestContext): Promise<RecipeRevision>;
}
export interface OwnerPort {
  /** Focus/open this existing identity only; never create or replace a session. */
  open(identity: NativeIdentity, context: RequestContext): Promise<NativeOpenResult>;
}
export interface PendingRequest { key: string; method: string; path: string }
export type Reconciliation = { state: 'pending' } | { state: 'complete'; body: unknown }
  | { state: 'failed'; status: ApiFailureStatus; error: ApiError }; // proven definitive no-effect refusal only
export interface ApiDeps {
  catalog?: { list(): Promise<import('../github/auth.ts').RepositoryCatalogEntry[]>; select(githubId: string, key: string): Promise<import('../contracts/domain.ts').Repository>; allows?(id: string): boolean };
  maintenanceGate?: MaintenanceGate;
  store: FactoryStore; scheduler: Scheduler; session: SessionPolicy;
  lifecycle?: Pick<Lifecycle, 'requestTakeover' | 'returnControl' | 'resumeInput'>;
  auth?: AuthPort; recipes?: RecipePort; owner?: OwnerPort; clock?: Clock;
  health?(): Promise<Health>;
  /** Read-only global discovery/proof facts; never qualifies a task or allocates a native session. */
  readiness?(): Promise<OwnerReadiness[]>;
  /** Trusted credential broker supplies values for defense-in-depth redaction; never sent or journaled. */
  secrets?(): readonly string[];
  /** Read/reconcile the exact external request only. A pending response must never launch a new action. */
  reconcileRequest?(request: PendingRequest): Promise<Reconciliation>;
  listen?: { host?: '127.0.0.1' | '::1'; port?: number };
  events?: { retention?: number; pollMs?: number };
  limits?: { bodyBytes?: number };
}
export interface ApiServer { url: string; sessions: Sessions; close(): Promise<void> }
function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]; return typeof value === 'string' ? value : undefined;
}
async function body(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const data of req) {
    size += Buffer.byteLength(data); if (size > limit) throw new ApiFault(400, 'BODY_TOO_LARGE', 'Reduce the JSON request size'); chunks.push(Buffer.from(data));
  }
  if (!size) return {};
  if (header(req, 'content-type')?.split(';')[0]?.trim() !== 'application/json') throw new ApiFault(400, 'INVALID_REQUEST', 'Send application/json');
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new ApiFault(400, 'INVALID_REQUEST', 'Send valid JSON'); }
}
function match(table: Route[], method: string, path: string): { route: Route; id: string } | undefined {
  for (const route of table) {
    if (route.method !== method) continue;
    const parts = route.path.split('/'); const actual = path.split('/');
    if (parts.length !== actual.length || parts.some((part, i) => part !== ':id' && part !== actual[i])) continue;
    const raw = actual[parts.indexOf(':id')];
    let id = '';
    try { id = raw === undefined ? '' : decodeURIComponent(raw); } catch { throw new ApiFault(400, 'INVALID_REQUEST', 'Use a valid encoded entity identity'); }
    if (raw !== undefined && (!id || id.length > 512 || /[\/\x00-\x1f]/.test(id))) throw new ApiFault(400, 'INVALID_REQUEST', 'Use a valid entity identity');
    return { route, id };
  }
  return undefined;
}
export async function startApi(input: ApiDeps): Promise<ApiServer> {
  const sessions = new Sessions(input.session); const deps = { ...input };
  const host = input.listen?.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') throw new TypeError('API must bind literal loopback');
  if (input.events?.retention !== undefined && (!Number.isSafeInteger(input.events.retention) || input.events.retention < 1)) throw new TypeError('Positive event retention required');
  if (input.events?.pollMs !== undefined && (!Number.isFinite(input.events.pollMs) || input.events.pollMs < 10)) throw new TypeError('Event poll interval must be at least 10ms');
  const bodyLimit = input.limits?.bodyBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 1) throw new TypeError('Positive request size required');
  const safeErrorResult = (status: number, error: unknown) => {
    validateFailureStatus(status);
    return { status, body: validateContract('ApiError', sanitize(error, deps.secrets?.())) };
  };
  const table = routes(deps); const streams = new Set<() => void>(); let authority = '';
  const send = (res: ServerResponse, status: number, value: unknown) => {
    if (res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(sanitize(value, deps.secrets?.())));
  };
  const server = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', 'null');
    let releaseMaintenance: (() => void) | undefined;
    try {
      if (req.headers.host !== authority) throw new ApiFault(403, 'HOST_DENIED', 'Use the configured literal loopback API address');
      const origin = header(req, 'origin');
      // Preflight never provisions a session or executes a route.
      if (req.method === 'OPTIONS') {
        if (!origin || !deps.session.allowedOrigins.includes(origin)) throw new SessionError(403);
        res.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, POST, PATCH, DELETE', 'access-control-allow-headers': 'content-type, x-sf-csrf, idempotency-key, if-match, last-event-id', vary: 'Origin' }); res.end(); return;
      }
      if (req.method === 'POST' && req.url === '/v1/session/pair') {
        if (!origin || !deps.session.allowedOrigins.includes(origin)) throw new SessionError(403);
        const value = await body(req, Math.min(bodyLimit, 1024));
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !('token' in value) || typeof value.token !== 'string' || value.token.length > 200) throw new SessionError(401);
        const session = sessions.exchangePairing(origin, value.token);
        res.writeHead(200, { 'set-cookie': session.cookie, 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin', 'x-content-type-options': 'nosniff' });
        // Bootstrap proof/CSRF is intentionally delivered only here, never through generic DTOs/journal.
        res.end(JSON.stringify({ csrfToken: session.csrfToken, expiresAt: session.expiresAt })); return;
      }
      const method = req.method ?? 'GET'; const mutation = method !== 'GET';
      sessions.authenticate(req, mutation);
      if (mutation) releaseMaintenance = deps.maintenanceGate?.enter();
      res.setHeader('access-control-allow-origin', origin ?? `http://${authority}`); res.setHeader('access-control-allow-credentials', 'true'); res.setHeader('vary', 'Origin');
      // Restrict the request target; absolute-form targets and queries are not supported.
      const path = req.url ?? '';
      if (!path.startsWith('/') || path.includes('?') || path.includes('#')) throw new ApiFault(400, 'INVALID_REQUEST', 'Use an exact API path');
      if (method === 'GET' && path === '/v1/events') {
        let stop: (() => void) | undefined;
        stop = eventStream(deps, sessions, req, res, () => { if (stop) streams.delete(stop); });
        if (!res.writableEnded) streams.add(stop); return;
      }
      const found = match(table, method, path);
      if (!found) throw new ApiFault(404, 'NOT_FOUND', 'Use a documented /v1 route');
      const { route, id } = found;
      if (!mutation) { send(res, 200, resultFor(route, await route.run(undefined, id, undefined, ''))); return; }
      const key = header(req, 'idempotency-key');
      if (!key || !/^[\x21-\x7e]{1,200}$/.test(key)) throw new ApiFault(400, 'IDEMPOTENCY_REQUIRED', 'Send a unique Idempotency-Key of 1–200 printable characters');
      let expected: number | undefined;
      if (route.versioned) {
        const raw = header(req, 'if-match'); const digits = raw?.match(/^(?:"([1-9]\d*)"|([1-9]\d*))$/);
        expected = digits ? Number(digits[1] ?? digits[2]) : NaN;
        if (!Number.isSafeInteger(expected)) throw new ApiFault(400, 'REVISION_REQUIRED', 'Send the current entity revision in If-Match');
      }
      let request: unknown;
      try { request = await body(req, bodyLimit); if (route.input) validateContract(route.input, request); }
      catch (error) { if (error instanceof ApiFault) throw error; throw new ApiFault(400, 'INVALID_REQUEST', 'Send a body matching the documented request schema'); }
      const identity = { method, path, body: request, revision: expected ?? null };
      const safeResult = (value: unknown) => ({ status: 200, body: resultFor(route, sanitize(value, deps.secrets?.())) });
      if (!route.external) {
        const saved = deps.store.runApiMutation(key, identity, () => {
          const value = route.run(request, id, expected, key);
          if (value instanceof Promise) throw new Error('Local mutation must be synchronous');
          return safeResult(value);
        });
        if (saved.fresh && (typeof route.afterCreate === 'function' ? route.afterCreate(saved.result.body) : route.afterCreate)) {
          // Creation/result are already committed. Unknown dispatch is reconciled by C3/E6; replay never creates or dispatches twice.
          try { await deps.scheduler.dispatch('manual'); } catch { /* Persisted queued tasks remain available to runtime recovery. */ }
        }
        send(res, saved.result.status, saved.result.body); return;
      }
      const claimed = deps.store.claimApiRequest(key, identity);
      if (claimed.result) { send(res, claimed.result.status, claimed.result.body); return; }
      if (!claimed.fresh) {
        const reconciled = await deps.reconcileRequest?.({ key, method, path });
        if (reconciled?.state === 'complete') {
          const result = safeResult(reconciled.body); deps.store.finishApiRequest(key, identity, result); send(res, result.status, result.body); return;
        }
        if (reconciled?.state === 'failed') {
          const result = safeErrorResult(reconciled.status, reconciled.error); deps.store.finishApiRequest(key, identity, result); send(res, result.status, result.body); return;
        }
        throw new ApiFault(503, 'REQUEST_PENDING', 'Reconcile the exact pending action in the runtime; retry this same key to read its outcome');
      }
      // Only service-owned preconditions can be safely completed as failures before external effects.
      try { route.check?.(id, expected); } catch (error) {
        const reason = safeFailure(error); const failure = safeErrorResult(reason.status, reason.body); deps.store.finishApiRequest(key, identity, failure); send(res, failure.status, failure.body); return;
      }
      // Ordinary port exceptions may follow acceptance. Only explicit trusted no-effect proof settles failure.
      try {
        const result = safeResult(await route.run(request, id, expected, key)); deps.store.finishApiRequest(key, identity, result); send(res, result.status, result.body);
      } catch (error) {
        if (error instanceof DefinitiveNoEffect) {
          const failure = safeErrorResult(error.status, error.error); deps.store.finishApiRequest(key, identity, failure); send(res, failure.status, failure.body); return;
        }
        const failure = safeFailure(error);
        send(res, failure.status, failure.body);
      }
    } catch (error) {
      if (error instanceof DefinitiveNoEffect) {
        try { const failure = safeErrorResult(error.status, error.error); send(res, failure.status, failure.body); return; } catch { /* Invalid explicit failure remains an unavailable operation. */ }
      }
      const failure = error instanceof SessionError ? { status: error.status, body: { code: error.status === 401 ? 'UNPAIRED' : 'FORBIDDEN', message: 'Session authorization required', recovery: 'Pair through the trusted local host and use its approved origin and CSRF token', retryable: false } } : safeFailure(error);
      send(res, failure.status, failure.body);
    } finally { releaseMaintenance?.(); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(input.listen?.port ?? 0, host, () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Loopback listener address missing');
  authority = `${host === '::1' ? '[::1]' : host}:${address.port}`;
  return { url: `http://${authority}`, sessions, async close() { sessions.revokeAll(); for (const close of streams) close(); streams.clear(); await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }); } };
}
