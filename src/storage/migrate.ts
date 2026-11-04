import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

/** Every migration and its version stamp commit together, including on first install. */
export function migrate(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    const version = Number(database.prepare('PRAGMA user_version').get()!.user_version);
    if (version > 1) throw new Error(`Unsupported factory database version ${version}`);
    if (version === 0) {
      database.exec(readFileSync(new URL('./migrations/001_initial.sql', import.meta.url), 'utf8'));
      database.exec('PRAGMA user_version = 1');
    }
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}
