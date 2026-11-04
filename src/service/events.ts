import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiDeps } from './api.ts';
import { ApiFault } from './routes.ts';
import type { Sessions } from './session.ts';
import { sanitize } from './snapshot.ts';
/** Durable events are currently retained for the installation lifetime; the HTTP replay window is bounded. */
export function eventStream(deps: ApiDeps, sessions: Sessions, req: IncomingMessage, res: ServerResponse, onClose: () => void): () => void {
  const latest = deps.store.snapshot().sequence;
  const raw = req.headers['last-event-id'];
  const window = deps.events?.retention ?? 1000;
  const floor = Math.max(0, latest - window);
  let cursor = raw === undefined ? latest : typeof raw === 'string' && /^(0|[1-9]\d*)$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(cursor) || cursor < floor || cursor > latest) throw new ApiFault(409, 'STALE_CURSOR', 'Reset required: fetch /v1/snapshot and reconnect with its cursor; do not replay mutations');
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(': connected\n\n');
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const close = () => { if (closed) return; closed = true; if (timer) clearInterval(timer); res.end(); onClose(); };
  const flush = () => {
    try {
      // Expired sessions must not keep a long-lived authenticated stream alive.
      sessions.authenticate(req, false);
      const now = deps.store.snapshot().sequence;
      if (now - cursor > window) { close(); return; }
      for (const event of deps.store.eventsAfter(cursor)) {
        const safe = sanitize(event, deps.secrets?.()); cursor = event.sequence;
        if (!res.write(`id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(safe)}\n\n`)) {
          // Slow readers reconnect using their last fully received ID; never queue an unbounded stream.
          close(); return;
        }
      }
    } catch { close(); }
  };
  flush();
  if (!closed) { timer = setInterval(flush, deps.events?.pollMs ?? 100); timer.unref(); }
  req.once('close', close); res.once('close', close);
  return close;
}
