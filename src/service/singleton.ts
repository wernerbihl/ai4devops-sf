import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { privateDirectory } from '../kestra/executions.ts';
/** A separate rollback-journal database owns a kernel file lock for the process lifetime.
 * Never hold a transaction on domain state or infer ownership from age/PID files. */
export function acquireInstallationSingleton(root: string): { close(): void } {
  const path = join(privateDirectory(root), 'controller-lock.sqlite');
  const db = new DatabaseSync(path);
  let closed = false;
  try {
    if (process.platform !== 'win32') chmodSync(path, 0o600);
    db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
  } catch {
    db.close(); throw new Error('Another installation controller holds the kernel lock');
  }
  return { close() { if (!closed) { closed = true; db.exec('ROLLBACK'); db.close(); } } };
}
