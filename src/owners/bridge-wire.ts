/** Private, versioned backend transport. Vendored byte-for-byte in Canvas. No HTTP/browser surface. */
import { createConnection, createServer, type Socket } from 'node:net';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, writeFile, mkdir, chmod, unlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface Pairing { version: 1; installationId: string; backendId: string; socketPath: string; secret: string }
export interface OwnerPeer {
  call(method: string, params: unknown): Promise<unknown>;
  handle(handler: (method: string, params: unknown) => Promise<unknown>): void;
  publish(event: unknown): void;
  subscribe(listener: (event: unknown) => void): () => void;
  disconnected(listener: () => void): () => void;
  close(): void;
}
const fail = () => new Error('Private BB owner channel unavailable or authentication failed; start the paired BB backend');
const mac = (key: string, value: unknown) => createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
const equals = (a: unknown, b: string) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function privateDirectory(path: string) {
  if (process.platform === 'win32') throw new Error('BB private IPC requires an installation-provisioned Windows ACL transport; unavailable');
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0 || await realpath(path) !== resolve(path)) throw fail();
}
export async function createOwnerPairing(directory: string, installationId: string, backendId: string): Promise<string> {
  if (!isAbsolute(directory) || !installationId.trim() || !backendId.trim()) throw fail();
  await mkdir(directory, { recursive: true, mode: 0o700 }); await privateDirectory(directory);
  const path = join(directory, 'bb-owner-pairing.json');
  const value: Pairing = { version: 1, installationId, backendId, socketPath: join(directory, 'owner.sock'), secret: randomBytes(32).toString('hex') };
  await writeFile(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  return path;
}
export async function readOwnerPairing(path: string): Promise<Pairing> {
  if (!isAbsolute(path)) throw fail();
  await privateDirectory(dirname(path)); const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw fail();
  const p = JSON.parse(await readFile(path, 'utf8')) as Pairing;
  if (p.version !== 1 || !p.installationId || !p.backendId || !/^[a-f0-9]{64}$/.test(p.secret) || p.socketPath !== join(dirname(path), 'owner.sock')) throw fail();
  return p;
}
function protocol(socket: Socket, pairing: Pairing, server: boolean): Promise<OwnerPeer> {
  return new Promise((resolvePeer, reject) => {
    let buffer: Buffer = Buffer.alloc(0);
    let session = '', sent = 0, received = 0, closed = false, ready = false;
    const frameLimit = 1048576;
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    const nonce = randomBytes(32).toString('hex'); let clientNonce = '';
    const listeners = new Set<(value: unknown) => void>(), disconnects = new Set<() => void>();
    const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
    let handler: ((method: string, params: unknown) => Promise<unknown>) | undefined;
    const awaitingHandler: (() => void)[] = [];
    const timeout = setTimeout(() => socket.destroy(), 5000); timeout.unref();
    function encode(value: unknown) {
      if (closed) throw fail();
      const data = JSON.stringify(value);
      if (Buffer.byteLength(data) > frameLimit) throw fail();
      return data + '\n';
    }
    function raw(value: unknown) { socket.write(encode(value)); }
    function frame(payload: unknown) {
      const sequence = sent + 1;
      const body = { session, sequence, payload };
      // Validate serialization and the complete byte bound before consuming this sequence.
      const data = encode({ ...body, signature: mac(pairing.secret, body) });
      sent = sequence;
      try { socket.write(data); } catch (error) { socket.destroy(); throw error; }
    }
    const peer: OwnerPeer = {
      call(method, params) { return new Promise((res, rej) => { if (closed) { rej(fail()); return; } const id = randomBytes(16).toString('hex'); const timer = setTimeout(() => { pending.delete(id); rej(new Error('BB owner outcome unknown; reconcile original identity before retry')); }, 15000); pending.set(id, { resolve: res, reject: rej, timer }); try { frame({ kind: 'request', id, method, params }); } catch { clearTimeout(timer); pending.delete(id); rej(fail()); } }); },
      handle(fn) { handler = fn; for (const invoke of awaitingHandler.splice(0)) invoke(); }, publish(event) { frame({ kind: 'event', event }); },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      disconnected(fn) { disconnects.add(fn); return () => disconnects.delete(fn); }, close() { socket.destroy(); },
    };
    function complete() { ready = true; clearTimeout(timeout); resolvePeer(peer); }
    socket.on('close', () => { closed = true; awaitingHandler.length = 0; clearTimeout(timeout); reject(fail()); for (const value of pending.values()) { clearTimeout(value.timer); value.reject(new Error('BB owner outcome unknown; reconnect and reconcile original identity')); } pending.clear(); for (const fn of disconnects) fn(); });
    socket.on('error', () => { socket.destroy(); });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      let end: number;
      while ((end = buffer.indexOf(0x0a)) >= 0) {
        if (end > frameLimit) { socket.destroy(); return; }
        const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
        try {
          // Decode only complete frames, so socket chunks may split any UTF-8 code point.
          const value = JSON.parse(utf8.decode(line));
          if (!ready) {
            if (server) {
              if (session) {
                if (value.kind !== 'confirm' || !equals(value.signature, mac(pairing.secret, [session, 'client-ready']))) throw fail();
                raw({ kind: 'ready', signature: mac(pairing.secret, [session, 'server-ready']) }); complete(); continue;
              }
              const hello = { kind: 'hello', version: 1, installationId: pairing.installationId, backendId: pairing.backendId, nonce: value.nonce };
              if (value.kind !== 'hello' || value.installationId !== pairing.installationId || value.backendId !== pairing.backendId || !/^[a-f0-9]{64}$/.test(value.nonce) || !equals(value.signature, mac(pairing.secret, hello))) throw fail();
              clientNonce = value.nonce; session = mac(pairing.secret, [clientNonce, nonce]);
              const ack = { kind: 'paired', clientNonce, nonce, installationId: pairing.installationId, backendId: pairing.backendId };
              raw({ ...ack, signature: mac(pairing.secret, ack) });
            } else {
              if (session) {
                if (value.kind !== 'ready' || !equals(value.signature, mac(pairing.secret, [session, 'server-ready']))) throw fail();
                complete(); continue;
              }
              const ack = { kind: 'paired', clientNonce: nonce, nonce: value.nonce, installationId: pairing.installationId, backendId: pairing.backendId };
              if (value.kind !== 'paired' || value.clientNonce !== nonce || value.installationId !== pairing.installationId || value.backendId !== pairing.backendId || !/^[a-f0-9]{64}$/.test(value.nonce) || !equals(value.signature, mac(pairing.secret, ack))) throw fail();
              session = mac(pairing.secret, [nonce, value.nonce]); raw({ kind: 'confirm', signature: mac(pairing.secret, [session, 'client-ready']) });
            }
            continue;
          }
          const body = { session: value.session, sequence: value.sequence, payload: value.payload };
          if (value.session !== session || value.sequence !== ++received || !equals(value.signature, mac(pairing.secret, body))) throw fail();
          const p = value.payload;
          if (p.kind === 'response') { const request = pending.get(p.id); if (!request) continue; clearTimeout(request.timer); pending.delete(p.id); p.ok ? request.resolve(p.value) : request.reject(new Error(typeof p.error === 'string' ? p.error : 'BB owner refused')); }
          else if (p.kind === 'event') { for (const fn of listeners) fn(p.event); }
          else if (p.kind === 'request' && typeof p.id === 'string' && typeof p.method === 'string') {
            const invoke = () => { void Promise.resolve().then(() => { if (!handler || closed) throw fail(); return handler(p.method, p.params); }).then(value => { if (!closed) frame({ kind: 'response', id: p.id, ok: true, value: value ?? null }); }, () => { if (!closed) frame({ kind: 'response', id: p.id, ok: false, error: 'BB owner refused; admission, profile or original identity unavailable' }); }).catch(() => {
              // A handler may already have acted. Close: pending callers settle as unknown, never replay.
              socket.destroy();
            }); };
            if (handler) invoke(); else { if (awaitingHandler.length >= 16) throw fail(); awaitingHandler.push(invoke); }
          } else throw fail();
        } catch { socket.destroy(); return; }
      }
      if (buffer.length > frameLimit) socket.destroy();
    });
    if (!server) { const hello = { kind: 'hello', version: 1, installationId: pairing.installationId, backendId: pairing.backendId, nonce }; raw({ ...hello, signature: mac(pairing.secret, hello) }); }
  });
}
export async function connectOwnerPeer(pairingPath: string): Promise<OwnerPeer> {
  const pairing = await readOwnerPairing(pairingPath);
  const stat = await lstat(pairing.socketPath); if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw fail();
  return protocol(createConnection(pairing.socketPath), pairing, false);
}
export async function listenOwnerPeers(pairingPath: string, accept: (peer: OwnerPeer) => void): Promise<() => Promise<void>> {
  const pairing = await readOwnerPairing(pairingPath); const sockets = new Set<Socket>();
  // Never unlink a pre-existing socket: its owning process/outcome may still be live.
  const server = createServer(socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); void protocol(socket, pairing, true).then(accept, () => socket.destroy()); });
  await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(pairing.socketPath, () => { server.off('error', rej); res(); }); });
  await chmod(pairing.socketPath, 0o600);
  return async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(res => server.close(() => res())); await unlink(pairing.socketPath).catch(() => {}); };
}
