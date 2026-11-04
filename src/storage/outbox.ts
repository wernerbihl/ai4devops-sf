import { randomUUID } from 'node:crypto';
import type { FactoryEvent } from '../contracts/domain.ts';
import { StoreDatabase, canonical, ensure } from './database.ts';

export interface ActionInput { key: string; kind: string; payload: Record<string, unknown> }
export interface OutboxAction extends ActionInput { id: string; createdAt: string; completedAt?: string }
export class Outbox {
  private db: StoreDatabase;
  constructor(db: StoreDatabase) { this.db = db; }
  enqueue(input: ActionInput): OutboxAction {
    ensure(typeof input.key === 'string' && input.key.trim() && typeof input.kind === 'string' && input.kind.trim(), 'invalid_action', 'Action key and kind are required');
    ensure(input.payload !== null && typeof input.payload === 'object' && !Array.isArray(input.payload), 'invalid_action', 'Action payload must be an object');
    const old = this.db.sql.prepare('SELECT * FROM outbox WHERE key = ?').get(input.key);
    if (old) {
      ensure(old.kind === input.kind && canonical(JSON.parse(String(old.payload))) === canonical(input.payload), 'idempotency_conflict', 'Outbox idempotency key was used with a different action');
      return fromRow(old);
    }
    const action = { ...structuredClone(input), id: randomUUID(), createdAt: this.db.now() };
    this.db.sql.prepare('INSERT INTO outbox(id, key, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)').run(action.id, action.key, action.kind, JSON.stringify(action.payload), action.createdAt);
    return action;
  }
  find(id: string): OutboxAction | undefined { const row = this.db.sql.prepare('SELECT * FROM outbox WHERE id = ?').get(id); return row ? fromRow(row) : undefined; }
  pending(): OutboxAction[] { return this.db.sql.prepare('SELECT * FROM outbox WHERE completed_at IS NULL ORDER BY rowid').all().map(fromRow); }
  complete(id: string): void {
    ensure(this.db.sql.prepare('SELECT id FROM outbox WHERE id = ?').get(id), 'not_found', 'Outbox action not found');
    this.db.sql.prepare('UPDATE outbox SET completed_at = COALESCE(completed_at, ?) WHERE id = ?').run(this.db.now(), id);
  }
  eventsAfter(sequence: number): FactoryEvent[] {
    ensure(Number.isSafeInteger(sequence) && sequence >= 0, 'invalid_cursor', 'Invalid event sequence');
    return this.db.sql.prepare('SELECT payload FROM events WHERE sequence > ? ORDER BY sequence').all(sequence).map(row => JSON.parse(String(row.payload)) as FactoryEvent);
  }
}
function fromRow(row: Record<string, unknown>): OutboxAction {
  return { id: String(row.id), key: String(row.key), kind: String(row.kind), payload: JSON.parse(String(row.payload)) as Record<string, unknown>, createdAt: String(row.created_at), ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}) };
}
