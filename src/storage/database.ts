import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Clock, FactoryEvent } from '../contracts/domain.ts';
import { validateContract } from '../contracts/schemas.ts';
import { migrate } from './migrate.ts';

export class StoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'StoreError'; this.code = code; }
}
export function ensure(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new StoreError(code, message);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function fingerprint(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export const systemClock: Clock = {
  wallNow: () => new Date(), monotonicMs: () => performance.now(),
  localDayKey: at => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`,
};
type PayloadTable = 'settings' | 'tags' | 'repositories' | 'recipes' | 'tasks' | 'grants' | 'actor_scopes';
export class StoreDatabase {
  readonly sql: DatabaseSync;
  readonly clock: Clock;
  readonly epoch = randomUUID();
  constructor(path: string, clock: Clock) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.clock = clock;
    this.sql = new DatabaseSync(path);
    try {
      this.sql.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      migrate(this.sql);
    } catch (error) { this.sql.close(); throw error; }
  }
  now(): string { return this.clock.wallNow().toISOString(); }
  transaction<T>(fn: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.sql.exec('COMMIT'); return result; }
    catch (error) { this.sql.exec('ROLLBACK'); throw error; }
  }
  read<T>(table: PayloadTable, id: string | number): T | undefined {
    const column = table === 'actor_scopes' ? 'attempt_id' : 'id';
    const row = this.sql.prepare(`SELECT payload FROM ${table} WHERE ${column} = ?`).get(id);
    return row ? JSON.parse(String(row.payload)) as T : undefined;
  }
  all<T>(table: PayloadTable): T[] {
    return this.sql.prepare(`SELECT payload FROM ${table} ORDER BY rowid`).all().map(row => JSON.parse(String(row.payload)) as T);
  }
  emit(type: FactoryEvent['type'], data: unknown): FactoryEvent {
    const sequence = Number(this.sql.prepare('INSERT INTO events(payload) VALUES (?)').run('{}').lastInsertRowid);
    const event = validateContract('FactoryEvent', { sequence, cursor: String(sequence), at: this.now(), type, data });
    this.sql.prepare('UPDATE events SET payload = ? WHERE sequence = ?').run(JSON.stringify(event), sequence);
    return event;
  }
  idempotent<T>(namespace: string, key: string, input: unknown, fn: () => T): T {
    ensure(typeof key === 'string' && key.trim().length > 0, 'invalid_key', 'Idempotency key is required');
    const hash = fingerprint(input);
    const prior = this.sql.prepare('SELECT fingerprint, result FROM idempotency WHERE namespace = ? AND key = ?').get(namespace, key);
    if (prior) {
      ensure(prior.fingerprint === hash, 'idempotency_conflict', 'Idempotency key was used with a different request');
      return JSON.parse(String(prior.result)) as T;
    }
    const result = fn();
    this.sql.prepare('INSERT INTO idempotency(namespace, key, fingerprint, result) VALUES (?, ?, ?, ?)').run(namespace, key, hash, JSON.stringify(result));
    return result;
  }
}
