import type { Attempt, NativeSnapshot } from '../contracts/domain.ts';
import { canonical, ensure } from '../storage/database.ts';

/** Snapshot reconciliation never creates a replacement session or assumes transport loss means stop. */
export function verifySnapshot(attempt: Attempt, snapshot: NativeSnapshot): boolean {
  ensure(canonical(attempt.native) === canonical(snapshot.identity), 'identity_conflict', 'Snapshot returned a different native session');
  return snapshot.state !== 'lost';
}
export const lifecycleActionKinds = new Set(['lifecycle.send', 'lifecycle.retry']);
