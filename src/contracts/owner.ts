import type {
  CapabilityReport, NativeIdentity, NativeSnapshot, NativeStart, OwnerEvent, RequiredCapabilities,
} from './domain.ts';

/** Trusted host bridge. Idle ends a native turn and never implies task completion. */
export interface NativeOwner {
  capabilities(required: RequiredCapabilities): Promise<CapabilityReport>;
  ensureStarted(): Promise<void>;
  ensureSession(start: NativeStart): Promise<NativeIdentity>;
  snapshot(identity: NativeIdentity): Promise<NativeSnapshot>;
  send(identity: NativeIdentity, input: object, idempotencyKey: string): Promise<void>;
  quiesce(identity: NativeIdentity): Promise<'stopped' | 'waiting' | 'unknown'>;
  open(identity: NativeIdentity): Promise<{ uri?: string }>;
  subscribe(onEvent: (event: OwnerEvent) => void): () => void;
}

export type { OwnerEvent, OwnerRpc, OwnerRpcResponse } from './domain.ts';
