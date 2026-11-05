import { isIP } from 'node:net';
import type { NativeStart } from '../contracts/domain.ts';
import { ensure, fingerprint } from '../storage/database.ts';
export const MODEL_PROXY_URL = 'http://sf-model-proxy:3128' as const;
/** E7's pinned CONNECT proxy implements this exact policy; task networking remains separate. */
export interface ModelProxyPolicy {
    schemaVersion: 2;
    kind: 'copilot-model-connect';
    listenPort: 3128;
    nativeRuntimeId: string;
    internalNetworkId: string;
    nativeAddress: string;
    listenAddress: string;
    allowedAuthorities: readonly string[];
}
export interface ModelProxyInspection {
    runtimeId: string;
    processIdentity: string;
    image: string;
    policySha256: string;
    nativeRuntimeId: string;
    internalNetworkId: string;
    egressNetworkId: string;
}
export interface NativeModelProxyControl {
    readonly policy: ModelProxyPolicy;
    /** Trusted E7 source inspects pinned proxy image/process, readonly effective policy, exact peer/network topology and public-address DNS pinning implementation. Never a worker route. */
    inspect(start: NativeStart): Promise<ModelProxyInspection>;
}
export async function inspectModelProxy(control: NativeModelProxyControl | undefined, start: NativeStart, nativeRuntimeId: string): Promise<ModelProxyInspection> {
    ensure(control, 'owner_model_proxy', 'Managed native model proxy inspection is required');
    const p = control.policy;
    ensure(p.schemaVersion === 2 && isIP(p.nativeAddress) === 4 && isIP(p.listenAddress) === 4 && p.nativeAddress !== p.listenAddress && p.kind === 'copilot-model-connect' && p.listenPort === 3128 && p.nativeRuntimeId === nativeRuntimeId && p.internalNetworkId && p.allowedAuthorities.length > 0 && new Set(p.allowedAuthorities).size === p.allowedAuthorities.length && p.allowedAuthorities.every(a => /^[a-z0-9][a-z0-9.-]+:443$/.test(a) && !isIP(a.slice(0, -4)) && a.slice(0, -4).includes('.') && !a.endsWith('.local:443')), 'owner_model_proxy', 'Exact reviewed public provider host:443 allowlist and owned native network required');
    const actual = await control.inspect(start);
    ensure(actual.runtimeId && actual.runtimeId !== nativeRuntimeId && actual.processIdentity && /@sha256:[a-f0-9]{64}$/.test(actual.image) && actual.policySha256 === fingerprint(p) && actual.nativeRuntimeId === nativeRuntimeId && actual.internalNetworkId === p.internalNetworkId && actual.egressNetworkId && actual.egressNetworkId !== actual.internalNetworkId, 'owner_model_proxy', 'Actual model proxy policy/image/process/topology does not match');
    return actual;
}
