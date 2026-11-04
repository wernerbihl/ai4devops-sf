import { ensure, fingerprint } from './database.ts';
import type { StoreDatabase } from './database.ts';
export interface ApiRequestResult { status: number; body: unknown }
export interface ApiRequestClaim { fresh: boolean; result?: ApiRequestResult }
/** Trusted request journal. Input is hashed; only sanitized public DTOs may be completed. */
export class ApiRequests {
  private db: StoreDatabase;
  constructor(db: StoreDatabase) { this.db = db; }
  claim(key: string, input: unknown): ApiRequestClaim {
    const hash = fingerprint(input);
    const prior = this.db.sql.prepare('SELECT fingerprint, state, result FROM api_requests WHERE key = ?').get(key);
    if (prior) {
      ensure(prior.fingerprint === hash, 'idempotency_conflict', 'Idempotency key conflicts');
      return { fresh: false, ...(prior.state === 'complete' ? { result: JSON.parse(String(prior.result)) as ApiRequestResult } : {}) };
    }
    this.db.sql.prepare("INSERT INTO api_requests(key, fingerprint, state) VALUES (?, ?, 'pending')").run(key, hash);
    return { fresh: true };
  }
  finish(key: string, input: unknown, result: ApiRequestResult): void {
    const prior = this.claim(key, input);
    ensure(!prior.fresh, 'not_found', 'Request must be claimed');
    if (prior.result) {
      ensure(fingerprint(prior.result) === fingerprint(result), 'idempotency_conflict', 'Completed request is immutable'); return;
    }
    this.db.sql.prepare("UPDATE api_requests SET state = 'complete', result = ? WHERE key = ?").run(JSON.stringify(result), key);
  }
}
