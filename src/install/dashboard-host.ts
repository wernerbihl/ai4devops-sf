import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requestDashboardPair } from './dashboard.ts';
import type { Installation } from './locator.ts';
export interface DashboardPair { apiUrl: string; origin: string; token: string; expiresAt: string }
export interface DashboardBackend {
  repair(): Promise<void>;
  request(operation: string, request: unknown): Promise<unknown>;
  subscribe(cursor: string, observer: { open(): void; event(value: unknown): void; error(error: unknown): void }): () => void;
  close(): void;
}
interface OpenApi { paths: Record<string, Record<string, { operationId: string; parameters?: { name: string }[] }>> }
/** Canonical public operations only. Private control and credentials never cross this boundary. */
export function createDashboardBackend(options: { pair(): Promise<DashboardPair>; document?: OpenApi; fetch?: typeof fetch }): DashboardBackend {
  const document: OpenApi = options.document ?? JSON.parse(readFileSync(new URL('../runtime/dashboard/openapi.json', import.meta.url), 'utf8'));
  const operations = new Map<string, { path: string; method: string; versioned: boolean }>();
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, spec] of Object.entries(methods)) {
      if (path.startsWith('/v1/') && path !== '/v1/events' && path !== '/v1/session/pair' && ['get', 'post', 'patch', 'delete'].includes(method)) operations.set(spec.operationId, { path, method: method.toUpperCase(), versioned: !!spec.parameters?.some(p => p.name.toLowerCase() === 'if-match') });
    }
  }
  const fetcher = options.fetch ?? fetch;
  let session: { apiUrl: string; origin: string; cookie: string; csrf: string; expires: number } | undefined;
  let closed = false; const streams = new Set<AbortController>(); const requests = new Set<AbortController>();
  let pairing: Promise<void> | undefined;
  const current = () => { if (closed || !session || session.expires <= Date.now()) throw Error('UNPAIRED: Reopen the dashboard through the trusted host'); return session; };
  const backend: DashboardBackend = {
    async repair() {
      if (closed) throw Error('Dashboard disposed');
      if (pairing) return pairing;
      const pending = (async () => {
        const proof = await options.pair();
        const url = new URL(proof.apiUrl);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash || !proof.token || Date.parse(proof.expiresAt) <= Date.now()) throw Error('Invalid trusted pairing');
        const response = await fetcher(new URL('/v1/session/pair', url), { method: 'POST', headers: { origin: proof.origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: proof.token }), redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw Error('Dashboard pairing unavailable');
        const value = await response.json() as { csrfToken?: unknown; expiresAt?: unknown };
        const cookie = response.headers.get('set-cookie')?.split(';')[0];
        if (!cookie?.match(/^sf_session=[A-Za-z0-9_-]{43}$/) || typeof value.csrfToken !== 'string' || !value.csrfToken || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) throw Error('Invalid dashboard session');
        if (closed) throw Error('Dashboard disposed');
        // Commit only after a complete successful exchange. A failed repair preserves prior authority.
        session = { apiUrl: url.origin, origin: proof.origin, cookie, csrf: value.csrfToken, expires: Date.parse(value.expiresAt) };
      })();
      pairing = pending; try { await pending; } finally { if (pairing === pending) pairing = undefined; }
    },
    async request(operation, input) {
      const spec = operations.get(operation);
      if (!spec || !input || typeof input !== 'object' || Array.isArray(input)) throw Error('Unsupported public operation');
      const request = input as Record<string, unknown>; const mutation = spec.method !== 'GET';
      const allowed = [...(spec.path.includes('{id}') ? ['id'] : []), ...(mutation ? ['body', 'key', ...(spec.versioned ? ['revision'] : [])] : [])];
      if (Object.keys(request).some(key => !allowed.includes(key))) throw Error('Unexpected public request field');
      let path = spec.path;
      if (path.includes('{id}')) { if (typeof request.id !== 'string' || !request.id || request.id.length > 512 || /[\/\x00-\x1f]/.test(request.id)) throw Error('Invalid public identity'); path = path.replace('{id}', encodeURIComponent(request.id)); }
      const active = current(); const headers: Record<string, string> = { origin: active.origin, cookie: active.cookie };
      if (mutation) {
        if (typeof request.key !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(request.key)) throw Error('Stable action key required');
        headers['x-sf-csrf'] = active.csrf; headers['idempotency-key'] = request.key; headers['content-type'] = 'application/json';
        if (spec.versioned) { if (!Number.isSafeInteger(request.revision) || (request.revision as number) < 1) throw Error('Current revision required'); headers['if-match'] = String(request.revision); }
      }
      const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 30_000); requests.add(controller);
      try {
        const response = await fetcher(active.apiUrl + path, { method: spec.method, headers, ...(mutation ? { body: JSON.stringify(request.body ?? {}) } : {}), signal: controller.signal, redirect: 'error', cache: 'no-store' });
        const body: unknown = await response.json();
        if (!response.ok) throw Object.assign(Error(typeof (body as { code?: unknown })?.code === 'string' ? (body as { code: string }).code : 'Dashboard request refused'), { status: response.status, detail: body });
        return body;
      } finally { clearTimeout(timeout); requests.delete(controller); }
    },
    subscribe(cursor, observer) {
      const controller = new AbortController(); streams.add(controller); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      void (async () => { try {
        if (!/^(0|[1-9]\d*)$/.test(cursor)) throw Error('Invalid event cursor');
        const active = current(); const response = await fetcher(active.apiUrl + '/v1/events', { headers: { origin: active.origin, cookie: active.cookie, 'last-event-id': cursor }, signal: controller.signal, redirect: 'error', cache: 'no-store' });
        if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) throw Error('Dashboard stream unavailable');
        reader = response.body.getReader(); if (controller.signal.aborted) return; observer.open();
        let pending = ''; const decoder = new TextDecoder();
        while (!controller.signal.aborted) {
          const chunk = await reader.read(); if (chunk.done) throw Error('Dashboard stream disconnected');
          pending += decoder.decode(chunk.value, { stream: true }); if (pending.length > 2 * 1024 * 1024) throw Error('Event frame too large');
          let end: number; while ((end = pending.indexOf('\n\n')) >= 0) { const frame = pending.slice(0, end); pending = pending.slice(end + 2); const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'); if (data && !controller.signal.aborted) observer.event(JSON.parse(data)); }
        }
      } catch (error) { if (!controller.signal.aborted) observer.error(error); }
      finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); streams.delete(controller); } })();
      return () => { controller.abort(); streams.delete(controller); };
    },
    close() { if (closed) return; closed = true; session = undefined; for (const controller of [...streams, ...requests]) controller.abort(); streams.clear(); requests.clear(); },
  };
  return backend;
}
/** Called only by a trusted installed host backend after protected locator verification. */
export async function connectInstalledDashboard(installation: Installation): Promise<DashboardBackend> {
  const backend = createDashboardBackend({ pair: () => requestDashboardPair(installation.root) });
  try { await backend.repair(); return backend; } catch (error) { backend.close(); throw error; }
}
