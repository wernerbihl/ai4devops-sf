import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { protectWindowsDirectory, protectWindowsDirectoryAsync, assertWindowsPrivateFile, assertWindowsPrivateFileAsync, writeWindowsPrivateFile, writeWindowsPrivateFileAsync } from '../platform/windows-private.ts';
import { fingerprint } from '../storage/database.ts';
import type { NativeIdentity, TaskResult, WorkflowIdentity, WorkflowStart } from '../contracts/domain.ts';

export interface EngineRequest { method: 'GET' | 'POST' | 'DELETE'; path: string; body?: string | Record<string, string>; }
export interface EngineResponse { status: number; body: any; }
/** Trusted backend-only port; it must not be reachable through the browser or broker protocol. */
export type EngineTransport = (request: EngineRequest) => Promise<EngineResponse>;
export class KestraError extends Error { constructor(message: string) { super(message); this.name = 'KestraError'; } }
export function check(condition: unknown, message: string): asserts condition { if (!condition) throw new KestraError(message); }
export async function checked(request: EngineTransport, input: EngineRequest): Promise<any> {
  const r = await request(input); check(r.status >= 200 && r.status < 300, `Kestra request failed (${r.status}); reconcile before retry`); return r.body;
}
/** E7 must establish a canonical, private installation root before passing it here. No symlink adoption. */
export function privateDirectory(path: string): string {
  const absolute = resolve(path); mkdirSync(absolute, { recursive: true, mode: 0o700 });
  check(realpathSync(absolute) === absolute, 'Private directory must be canonical, without symlinks');
  const stat = lstatSync(absolute); check(stat.isDirectory(), 'Private directory required');
  if (process.platform === 'win32') protectWindowsDirectory(absolute);
  else {
    check(stat.uid === process.getuid!(), 'Private directory ownership mismatch');
    check((stat.mode & 0o077) === 0, 'Private directory permissions must be 0700');
  }
  return absolute;
}
export async function privateDirectoryAsync(path:string):Promise<string> {
  if(process.platform!=='win32')return privateDirectory(path);
  const absolute=resolve(path);mkdirSync(absolute,{recursive:true,mode:0o700});check(realpathSync(absolute)===absolute&&lstatSync(absolute).isDirectory(),'Private canonical directory required');await protectWindowsDirectoryAsync(absolute);return absolute;
}
export interface ResumeIntent { key: string; hash: string; input: TaskResult; phase: 'pending' | 'sent' | 'done'; taskRunId?: string; wire?: string; requestId?: string; }
export interface ContinuationBinding { attemptId: string; fence: number; taskId: string; recipeId: string; recipeRevision: string; native: NativeIdentity; previousAttemptId: string; }
export interface ExecutionIntent { binding?: ContinuationBinding; bindingGeneration?: number; continuationKeys?: Record<string, string>; nativeTaskId?: string; nativeRequestId?: string; start: WorkflowStart; hash: string; namespace: string; flowId: string; engineRevision: number; phase: 'prepared' | 'sent' | 'known'; identity?: WorkflowIdentity; resume?: ResumeIntent; stopRequested?: boolean; }
const preparedJournals=new WeakMap<object,string>();
export async function prepareExecutionJournal(directory:string):Promise<object|undefined>{if(process.platform!=='win32')return;const parent=await privateDirectoryAsync(directory);const path=join(parent,'execution-intents.sqlite');if(!existsSync(path))await writeWindowsPrivateFileAsync(path,Buffer.alloc(0));await assertWindowsPrivateFileAsync(path);const token={};preparedJournals.set(token,path);return token}
export class ExecutionJournal {
  private db: DatabaseSync;
  constructor(directory: string,token?:object) {
    const path = join(process.platform==='win32'?resolve(directory):privateDirectory(directory), 'execution-intents.sqlite');
    if(process.platform==='win32'){if(!token||preparedJournals.get(token)!==path)throw new Error('Execution journal protection is not initialized');preparedJournals.delete(token)}
    else {try { const s = lstatSync(path); check(s.isFile() && !s.isSymbolicLink() && s.uid === process.getuid!() && (s.mode & 0o077) === 0, 'Unsafe execution journal'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }}
    this.db = new DatabaseSync(path); if(process.platform!=='win32')chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS intents (attempt TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL);');
  }
  get(attempt: string): ExecutionIntent | undefined { const r = this.db.prepare('SELECT body FROM intents WHERE attempt=?').get(attempt); return r ? JSON.parse(String(r.body)) : undefined; }
  identity(identity: WorkflowIdentity): ExecutionIntent {
    const row = this.db.prepare("SELECT body FROM intents WHERE json_extract(body, '$.identity.executionId')=?").get(identity.executionId);
    check(row, 'Unknown execution identity'); const value = JSON.parse(String(row.body)) as ExecutionIntent;
    check(fingerprint(value.identity) === fingerprint(identity), 'Execution identity conflict'); return value;
  }
  create(value: ExecutionIntent): ExecutionIntent {
    this.db.prepare('INSERT OR IGNORE INTO intents VALUES (?, ?, 0, ?)').run(value.start.attemptId, value.start.idempotencyKey, JSON.stringify(value));
    const current = this.get(value.start.attemptId); check(current && current.hash === value.hash, 'Execution attempt/key conflict'); return current;
  }
  update(attempt: string, change: (value: ExecutionIntent) => void): ExecutionIntent {
    this.db.exec('BEGIN IMMEDIATE');
    try { const v = this.get(attempt); check(v, 'Unknown execution intent'); change(v); this.db.prepare('UPDATE intents SET version=version+1, body=? WHERE attempt=?').run(JSON.stringify(v), attempt); this.db.exec('COMMIT'); return v; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close(): void { this.db.close(); }
}
export interface EngineExecution { id: string; namespace: string; flowId: string; flowRevision: number; labels: { key: string; value: string }[]; state: { current: string }; taskRunList?: { id: string; taskId: string; state: { current: string } }[]; }
export function verifyExecution(e: EngineExecution, record: ExecutionIntent): WorkflowIdentity {
  check(e && typeof e.id === 'string' && /^[A-Za-z0-9_-]+$/.test(e.id) && e.namespace === record.namespace && e.flowId === record.flowId && e.flowRevision === record.engineRevision &&
    e.labels?.some(l => l.key === 'sf_attempt' && l.value === fingerprint(record.start.attemptId)) && e.labels?.some(l => l.key === 'sf_revision' && l.value === fingerprint(record.start.recipe.revision)), 'Engine execution identity/revision mismatch');
  return { executionId: e.id, namespace: e.namespace, flowId: e.flowId, revision: record.start.recipe.revision };
}
