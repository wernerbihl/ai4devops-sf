import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import type { OwnerPeer, Pairing } from '../../src/owners/bridge-wire.ts';

/** Deterministic stream chunking only; the protocol under test is the actual production source. */
async function peers() {
  const target = new URL('../../src/owners/bridge-wire.ts', import.meta.url).href;
  const hooks = registerHooks({ load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    return url === target ? { ...loaded, source: String(loaded.source).replace('function protocol(', 'export function protocol(') } : loaded;
  } });
  let protocol: (socket: unknown, pairing: Pairing, server: boolean) => Promise<OwnerPeer>;
  try { ({ protocol } = await import('../../src/owners/bridge-wire.ts') as unknown as { protocol: typeof protocol }); }
  finally { hooks.deregister(); }
  class ByteSocket extends EventEmitter {
    other!: ByteSocket;
    destroyed = false;
    splits = 0;
    write(value: string) {
      const bytes = Buffer.from(value);
      queueMicrotask(() => {
        if (this.destroyed || this.other.destroyed) return;
        const nonAscii = bytes.findIndex(byte => byte >= 0xc0);
        if (nonAscii >= 0) {
          this.splits++;
          this.other.emit('data', bytes.subarray(0, nonAscii + 1));
          if (!this.other.destroyed) this.other.emit('data', bytes.subarray(nonAscii + 1));
        } else this.other.emit('data', bytes);
      });
      return true;
    }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('close'); this.other.destroy(); }
  }
  const left = new ByteSocket(), right = new ByteSocket(); left.other = right; right.other = left;
  const pairing: Pairing = { version: 1, installationId: 'test-install', backendId: 'test-backend', socketPath: '/owned/unused.sock', secret: 'b'.repeat(64) };
  const [server, client] = await Promise.all([protocol(left, pairing, true), protocol(right, pairing, false)]);
  return { server, client, left, right, close() { server.close(); client.close(); } };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Caller did not settle promptly')), 300); })]); }
  finally { clearTimeout(timer); }
}

test('I1 signed UTF-8 survives deterministic socket splits inside multibyte code points', async () => {
  const f = await peers();
  try {
    f.server.handle(async (_method, params) => params);
    const payload = { prompt: 'café — 選択 🧩', path: '/owned/é', answers: ['sí', '蓝色'] };
    assert.deepEqual(await bounded(f.client.call('echo', payload)), payload);
    assert.equal(f.right.splits, 1); assert.equal(f.left.splits, 1);
  } finally { f.close(); }
});

test('I2 oversized outbound request does not consume a sequence or poison later valid traffic', async () => {
  const f = await peers(); let calls = 0;
  try {
    f.server.handle(async (_method, params) => { calls++; return params; });
    await assert.rejects(bounded(f.client.call('echo', 'x'.repeat(1048576))));
    // Character count alone would accept this; the wire bound is measured in bytes.
    await assert.rejects(bounded(f.client.call('echo', 'é'.repeat(600000))));
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    await assert.rejects(bounded(f.client.call('echo', cyclic)));
    assert.equal(calls, 0);
    assert.deepEqual(await bounded(f.client.call('echo', { valid: true })), { valid: true });
    assert.equal(calls, 1);
  } finally { f.close(); }
});

test('I2 oversized handler response settles as unknown without unhandled rejection or replay', async () => {
  const f = await peers(); let effects = 0;
  try {
    f.server.handle(async () => { effects++; return 'x'.repeat(1048576); });
    await assert.rejects(bounded(f.client.call('effect', {})), /outcome unknown/);
    assert.equal(effects, 1, 'handler already acted; transport must not claim no effect or retry');
    // The selected policy closes the channel, so no subsequent work can be dispatched here.
    await assert.rejects(bounded(f.client.call('effect', {})));
    assert.equal(effects, 1);
  } finally { f.close(); }
});
