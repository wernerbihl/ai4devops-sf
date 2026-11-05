import { randomUUID } from 'node:crypto';
import type { NativeOwner } from '../contracts/owner.ts';
import type { OwnerRpc, OwnerRpcResponse, OwnerReadiness, RequiredCapabilities } from '../contracts/domain.ts';
import type { OwnerChannel } from './bridge-rpc.ts';
import { validateContract } from '../contracts/schemas.ts';
export function createBbOwner(channel: OwnerChannel): NativeOwner & { readiness(required: RequiredCapabilities): Promise<OwnerReadiness> } {
  type Result<M extends OwnerRpc['method']> = Extract<OwnerRpcResponse, { ok: true; method: M }>['result'];
  async function call<M extends OwnerRpc['method']>(method: M, params: Extract<OwnerRpc, { method: M }>['params']): Promise<Result<M>> {
    const request = validateContract('OwnerRpc', { requestId: randomUUID(), method, params });
    const response = validateContract('OwnerRpcResponse', await channel.rpc(request));
    if (response.requestId !== request.requestId || response.ok && response.method !== method) throw new Error('BB owner response mismatch');
    if (!response.ok) throw new Error(response.error.message);
    return response.result as Result<M>;
  }
  const unavailable = (): OwnerReadiness => ({ ownerId: 'bb', ready: false, reasons: ['BB backend unavailable; start the paired backend. Automatic launch is unsupported'], supportedProviders: [], verifiedProfileIds: [], providers: [], version: 'unavailable' });
  return {
    async readiness(required) { try { return channel.readiness ? await channel.readiness(required) : unavailable(); } catch { return unavailable(); } },
    async capabilities(required) { try { return await call('capabilities', { required }); } catch { const { ownerId: _, providers: __, ...report } = unavailable(); return report; } },
    async ensureStarted() { await call('ensureStarted', {}); },
    ensureSession(start) { return call('ensureSession', { start }); }, snapshot(identity) { return call('snapshot', { identity }); },
    async send(identity, input, idempotencyKey) { await call('send', { identity, input: input as Record<string, unknown>, idempotencyKey }); },
    quiesce(identity) { return call('quiesce', { identity }); }, open(identity) { return call('open', { identity }); },
    subscribe(fn) { return channel.subscribe(fn); },
  };
}
