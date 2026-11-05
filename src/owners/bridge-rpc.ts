import type { OwnerRpc, OwnerRpcResponse, OwnerEvent, NativeIdentity, OwnerReadiness, RequiredCapabilities } from '../contracts/domain.ts';
import { canonical } from '../storage/database.ts';
import { validateContract } from '../contracts/schemas.ts';
import { listenOwnerPeers, type OwnerPeer } from './bridge-wire.ts';
export { createOwnerPairing, connectOwnerPeer } from './bridge-wire.ts';
export type { OwnerPeer } from './bridge-wire.ts';
export interface OwnerChannel {
  rpc(request: OwnerRpc): Promise<OwnerRpcResponse>;
  readiness?(required: RequiredCapabilities): Promise<OwnerReadiness>;
  subscribe(listener: (event: OwnerEvent) => void): () => void;
}
/** One trusted installation/backend, with no browser registration or HTTP route. */
export async function listenBbOwner(options: { pairingPath: string; authority: (method: string, params: unknown) => Promise<unknown> }): Promise<OwnerChannel & { close(): Promise<void> }> {
  let current: OwnerPeer | undefined;
  const listeners = new Set<(event: OwnerEvent) => void>();
  const identities = new Map<string, NativeIdentity>();
  let closed = false;
  const stop = await listenOwnerPeers(options.pairingPath, peer => {
    if (current) { peer.close(); return; } current = peer;
    peer.handle(options.authority);
    peer.subscribe(value => { if (current !== peer) return; const event = validateContract('OwnerEvent', value); for (const fn of listeners) fn(event); });
    peer.disconnected(() => { if (current !== peer) return; current = undefined; if (!closed) for (const identity of identities.values()) for (const fn of listeners) fn({ type: 'connection_lost', identity, at: new Date().toISOString(), reason: 'BB backend disconnected; reconcile the original native snapshot' }); });
  });
  function connected() { if (!current) throw new Error('BB backend unavailable; start the paired BB backend. Automatic launch is unsupported'); return current; }
  return {
    async rpc(request) { validateContract('OwnerRpc', request); const response = validateContract('OwnerRpcResponse', await connected().call('owner', request)); if (response.requestId !== request.requestId || (response.ok && response.method !== request.method)) throw new Error('BB owner response mismatch'); if (response.ok && (response.method === 'snapshot' || response.method === 'ensureSession')) { const identity = response.method === 'snapshot' ? response.result.identity : response.result; identities.set(canonical(identity), identity); } return response; },
    async readiness(required) { return validateContract('OwnerReadiness', await connected().call('readiness', validateContract('RequiredCapabilities', required))); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async close() { if (closed) return; closed = true; current?.close(); current = undefined; listeners.clear(); await stop(); },
  };
}

/** Only navigation is supported by the pinned BB SDK. E6 passes this actual-store authority. */
export function createBbNavigationAuthority(store: import('../storage/store.ts').FactoryStore) {
  return async (method: string, params: unknown): Promise<null> => {
    if (method !== 'open') throw new Error('BB execution method unsupported by current SDK');
    if (!params || typeof params !== 'object' || Object.keys(params).join(',') !== 'identity') throw new Error('Invalid BB navigation request');
    const identity = validateContract('NativeIdentity', (params as { identity: unknown }).identity);
    if (identity.ownerId !== 'bb' || identity.chatId) throw new Error('Invalid BB navigation identity');
    const equal = (value: unknown) => canonical(value) === canonical(identity);
    const rows = store.getReservations().filter(r => r.attempt.native && equal(r.attempt.native) && store.getTask(r.attempt.taskId)?.attemptIds.at(-1) === r.attempt.id);
    if (rows.length !== 1) throw new Error('BB navigation requires one original current identity');
    const r = rows[0]!; const task = store.getTask(r.attempt.taskId)!; const repo = store.getRepository(task.spec.repositoryId);
    if (repo?.controlMode !== 'human' || task.status === 'cancelled' || store.getAdmissionState().activeLeases.some(l => l.repositoryId === repo.id)) throw new Error('BB navigation requires current human control and no repository writers');
    if (!store.pendingActions().some(a => a.kind === 'lifecycle.human_open' && a.payload.attemptId === r.attempt.id && a.payload.repositoryId === repo.id && equal(a.payload.identity))) throw new Error('BB navigation requires the pending C4 original-identity action');
    return null;
  };
}
