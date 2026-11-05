import type { ActorScope, Artifact, TaskResult, WorkerResponse } from '../contracts/domain.ts';
import { StoreDatabase, canonical, ensure, fingerprint } from './database.ts';
export interface CapabilityRecord { id: string; scope: ActorScope; taskId: string; reservationId: string; expiresAt: string; operations: string[] }
export interface NativeWrite { attemptId: string; fence: number; key: string; payload: unknown; state: 'pending' | 'unknown' | 'done'; result?: WorkerResponse }
/** Private factory SQLite state; never expose this object through a worker route. */
export class BrokerStorage {
  private db: StoreDatabase;
  constructor(db: StoreDatabase) { this.db = db; }
  transaction<T>(callback: () => T): T {
    return this.db.transaction(() => { const result = callback(); ensure(!(result instanceof Promise), 'async_transaction', 'Broker local transactions must be synchronous'); return result; });
  }
  scope(attemptId: string): ActorScope | undefined {
    const row = this.db.sql.prepare('SELECT payload FROM actor_scopes WHERE attempt_id = ?').get(attemptId);
    return row ? JSON.parse(String(row.payload)).scope : undefined;
  }
  saveCapability(value: CapabilityRecord): void { this.db.sql.prepare('INSERT INTO broker_capabilities(id,payload) VALUES (?,?)').run(value.id, JSON.stringify(value)); }
  capability(id: string): CapabilityRecord | undefined {
    const row = this.db.sql.prepare('SELECT payload FROM broker_capabilities WHERE id = ? AND revoked = 0').get(id);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  revoke(attemptId: string): void {
    this.db.sql.prepare("UPDATE broker_capabilities SET revoked = 1 WHERE json_extract(payload,'$.scope.attemptId') = ?").run(attemptId);
  }
  mutation<T>(key: string, input: unknown, callback: () => T): T { return this.db.idempotent('broker', key, input, callback); }
  proposal(attemptId: string): TaskResult | undefined {
    const row = this.db.sql.prepare('SELECT payload FROM broker_results WHERE attempt_id = ?').get(attemptId); return row ? JSON.parse(String(row.payload)) : undefined;
  }
  saveProposal(value: TaskResult): void {
    const old = this.proposal(value.attemptId); ensure(!old || canonical(old) === canonical(value), 'result_conflict', 'An attempt result proposal is immutable');
    this.db.sql.prepare('INSERT INTO broker_results(attempt_id,payload) VALUES (?,?) ON CONFLICT DO NOTHING').run(value.attemptId, JSON.stringify(value));
  }
  artifact(id: string, attemptId: string): Artifact | undefined {
    const row = this.db.sql.prepare('SELECT payload FROM broker_artifacts WHERE id = ? AND attempt_id = ?').get(id, attemptId); return row ? JSON.parse(String(row.payload)) : undefined;
  }
  saveArtifact(value: Artifact): void { this.db.sql.prepare('INSERT INTO broker_artifacts(id,attempt_id,payload) VALUES (?,?,?)').run(value.id, value.attemptId, JSON.stringify(value)); }
  write(attemptId: string, fence: number): NativeWrite | undefined {
    const row = this.db.sql.prepare('SELECT * FROM broker_writes WHERE attempt_id = ? AND fence = ?').get(attemptId, fence);
    return row ? { attemptId, fence, key: String(row.key), payload: JSON.parse(String(row.payload)), state: row.state as NativeWrite['state'], ...(row.result ? { result: JSON.parse(String(row.result)) } : {}) } : undefined;
  }
  claim(input: Omit<NativeWrite, 'state' | 'result'>): { fresh: boolean; write: NativeWrite } {
    const prior = this.write(input.attemptId, input.fence);
    if (prior) {
      ensure(prior.key === input.key && fingerprint(prior.payload) === fingerprint(input.payload), 'native_writer_busy', 'This fence already owns a native write; reconcile or obtain a trusted continuation fence');
      return { fresh: false, write: prior };
    }
    this.db.sql.prepare('INSERT INTO broker_writes(attempt_id,fence,key,fingerprint,payload,state) VALUES (?,?,?,?,?,?)').run(input.attemptId,input.fence,input.key,fingerprint(input.payload),JSON.stringify(input.payload),'pending');
    return { fresh: true, write: { ...input, state: 'pending' } };
  }
  settle(attemptId: string, fence: number, key: string, result?: WorkerResponse): void {
    const prior = this.write(attemptId, fence); ensure(prior?.key === key, 'write_missing', 'Native write intent missing');
    ensure(prior.state !== 'done' || canonical(prior.result) === canonical(result), 'write_conflict', 'Native write completion is immutable');
    this.db.sql.prepare('UPDATE broker_writes SET state = ?, result = ? WHERE attempt_id = ? AND fence = ?').run(result ? 'done' : 'unknown', result ? JSON.stringify(result) : null, attemptId, fence);
  }
}
