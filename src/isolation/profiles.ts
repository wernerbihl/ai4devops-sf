import type { NativeStart, ProviderId } from '../contracts/domain.ts';
export const denialChecks = ['docker-socket','factory-store','host-credentials','metadata-write','alternate-egress','external-tool'] as const;
export interface EffectiveBoundary {
  runtimeId: string; processIdentity: string; ownerId: string; providerId: ProviderId; image: string;
  mounts: { source: string; target: string; writable: boolean }[]; networks: string[];
  tools: string[]; credentialRefs: string[]; networkDestinations: string[]; protectedPaths: string[];
  unapprovedToolsDenied: boolean; alternateEgressDenied: boolean; metadataProtected: boolean;
}
export interface NativeBoundary {
  /** Inspect the actual native process AND client-tool policy; never read worker assertions. */
  inspect(start: NativeStart): Promise<EffectiveBoundary>;
  /** Execute fixed harmless canaries through the same native/client-tool boundary, not a sibling shell. */
  challenge(start: NativeStart, nonce: string): Promise<{ nonce: string; runtimeId: string; processIdentity: string; denied: boolean; checks: readonly string[] }>;
}
export interface RuntimeProfile {
  id: string; ownerId: string; providerId: ProviderId; image: string; networks: string[]; protectedPaths: string[]; boundary: NativeBoundary;
}
/** No owner/provider is globally ready: E4 registers the actual owned native runtime and inspection adapter. */
export const builtinProfiles: readonly RuntimeProfile[] = [];
