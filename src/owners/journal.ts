import { assertWindowsPrivateFile, writeWindowsPrivateFile } from '../platform/windows-private.ts';
import { privateDirectory } from '../kestra/executions.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { NativeIdentity, NativeStart } from '../contracts/domain.ts';
import { canonical, ensure } from '../storage/database.ts';
export interface SessionIntent {
    taskId: string;
    sessionId: string;
    workspacePath: string;
    directory: string;
    baseSha: string;
    ownerId: string;
    providerId: NativeIdentity['providerId'];
    identity?: NativeIdentity;
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
/** Protected runner metadata; never mounted into native workspaces. Intent precedes wire I/O. */
export class OwnerJournal {
    private db: DatabaseSync;
    constructor(path: string) { if(process.platform==='win32'){privateDirectory(dirname(path));if(!existsSync(path))writeWindowsPrivateFile(path,Buffer.alloc(0));assertWindowsPrivateFile(path)}else mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); this.db = new DatabaseSync(path); if(process.platform!=='win32')chmodSync(path, 0o600); this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS sessions (task_key TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS actions (key TEXT PRIMARY KEY, hash TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS stopped (identity TEXT PRIMARY KEY, stopped_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS paused (identity TEXT PRIMARY KEY, paused_at TEXT NOT NULL);'); }
    session(start: NativeStart, directory: string): {
        intent: SessionIntent;
        fresh: boolean;
    } {
        const key = canonical([start.task.ownerId, start.task.id]);
        const previous = this.db.prepare('SELECT body FROM sessions WHERE task_key=?').get(key);
        if (previous) {
            const intent = JSON.parse(previous.body as string) as SessionIntent;
            ensure(intent.workspacePath === start.workspacePath && intent.directory === directory && intent.baseSha === start.baseSha && intent.providerId === start.task.providerId, 'owner_identity', 'Native provider/workspace/base identity conflict');
            return { intent, fresh: false };
        }
        const intent: SessionIntent = { taskId: start.task.id, sessionId: `ahp-session:/${digest([key, start.idempotencyKey])}`, workspacePath: start.workspacePath, directory, baseSha: start.baseSha, ownerId: start.task.ownerId, providerId: start.task.providerId };
        const result = this.db.prepare('INSERT OR IGNORE INTO sessions(task_key,body) VALUES (?,?)').run(key, JSON.stringify(intent));
        if (!result.changes)
            return this.session(start, directory);
        return { intent, fresh: true };
    }
    find(ownerId: string, taskId: string): SessionIntent | undefined { const row = this.db.prepare('SELECT body FROM sessions WHERE task_key=?').get(canonical([ownerId, taskId])); return row ? JSON.parse(row.body as string) as SessionIntent : undefined; }
    bind(intent: SessionIntent, identity: NativeIdentity) { ensure(!intent.identity || canonical(intent.identity) === canonical(identity), 'owner_identity', 'Native chat identity changed'); intent.identity = identity; this.db.prepare('UPDATE sessions SET body=? WHERE task_key=?').run(JSON.stringify(intent), canonical([intent.ownerId, intent.taskId])); }
    owned(identity: NativeIdentity): SessionIntent {
        for (const row of this.db.prepare('SELECT body FROM sessions').all()) {
            const intent = JSON.parse(row.body as string) as SessionIntent;
            if (intent.identity && canonical(intent.identity) === canonical(identity))
                return intent;
        }
        throw new Error('Unknown native identity; refusing unowned session');
    }
    claim(identity: NativeIdentity, key: string, input: object) { const id = digest([identity, key]); const hash = digest(input); const changed = this.db.prepare('INSERT OR IGNORE INTO actions(key,hash) VALUES (?,?)').run(id, hash).changes; const row = this.db.prepare('SELECT hash,done FROM actions WHERE key=?').get(id)!; ensure(row.hash === hash, 'owner_idempotency', 'Native action idempotency conflict'); return { id, fresh: !!changed, done: row.done === 1 }; }
    done(id: string) { this.db.prepare('UPDATE actions SET done=1 WHERE key=?').run(id); }
    stopped(identity: NativeIdentity): {
        identity: NativeIdentity;
        stoppedAt: string;
    } | undefined { this.owned(identity); const row = this.db.prepare('SELECT stopped_at FROM stopped WHERE identity=?').get(canonical(identity)); return row ? { identity, stoppedAt: String(row.stopped_at) } : undefined; }
    paused(identity: NativeIdentity): {
        identity: NativeIdentity;
        stoppedAt: string;
    } | undefined { this.owned(identity); const row = this.db.prepare('SELECT paused_at FROM paused WHERE identity=?').get(canonical(identity)); return row ? { identity, stoppedAt: String(row.paused_at) } : undefined; }
    recordPaused(identity: NativeIdentity) { this.owned(identity); this.db.prepare('INSERT OR REPLACE INTO paused(identity,paused_at) VALUES (?,?)').run(canonical(identity), new Date().toISOString()); }
    recordStopped(identity: NativeIdentity) { this.owned(identity); this.db.prepare('INSERT OR REPLACE INTO stopped(identity,stopped_at) VALUES (?,?)').run(canonical(identity), new Date().toISOString()); }
    close() { this.db.close(); }
}
