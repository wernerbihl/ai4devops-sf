import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

/** Every migration and its version stamp commit together, including on first install. */
export function migrate(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    const version = Number(database.prepare('PRAGMA user_version').get()!.user_version);
    if (version > 7) throw new Error(`Unsupported factory database version ${version}`);
    if (version === 0) {
      database.exec(readFileSync(new URL('./migrations/001_initial.sql', import.meta.url), 'utf8'));
      database.exec('PRAGMA user_version = 1');
    }
    if (version < 2) {
      database.exec(readFileSync(new URL('./migrations/002_admission.sql', import.meta.url), 'utf8'));
      database.exec('PRAGMA user_version = 2');
    }
    if (version < 3) {
      database.exec(readFileSync(new URL('./migrations/003_lifecycle.sql', import.meta.url), 'utf8'));
      database.exec('PRAGMA user_version = 3');
    }
    if (version < 4) {
      database.exec(readFileSync(new URL('./migrations/004_api_requests.sql', import.meta.url), 'utf8'));
      database.exec('PRAGMA user_version = 4');
    }
    if (version < 5) {
      database.exec(readFileSync(new URL('./migrations/005_broker.sql', import.meta.url), 'utf8'));
      database.exec('PRAGMA user_version = 5');
    }
    if (version < 6) {
      database.exec(readFileSync(new URL('./migrations/006_broker_revocations.sql', import.meta.url), 'utf8'));
      database.exec('PRAGMA user_version = 6');
    }
    if (version < 7) {
      database.exec(readFileSync(new URL('./migrations/007_repository_selections.sql', import.meta.url), 'utf8'));
      database.exec('PRAGMA user_version = 7');
    }
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}
