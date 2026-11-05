import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AhpTransport, TransportFrame } from '@microsoft/agent-host-protocol/client';
import type { AhpEndpoint } from './ahp.ts';
import { ensure } from '../storage/database.ts';
export interface AhpProcessOptions {
    executable: string;
    helperPath: string;
    endpoint: AhpEndpoint | {
        registryDirectory: string;
    };
    electronRunAsNode?: boolean;
}
/** Owning-OS private stdio. Packaged ipc-helper.js and pinned dependencies must be readable in that OS. */
export function createAhpProcessConnector(options: AhpProcessOptions): () => Promise<AhpTransport> {
    return async () => {
        const child = spawn(options.executable, [options.helperPath, JSON.stringify(options.endpoint)], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, env: { ...process.env, ...(options.electronRunAsNode ? { ELECTRON_RUN_AS_NODE: '1', WSLENV: [...(process.env.WSLENV ?? '').split(':').filter(Boolean), 'ELECTRON_RUN_AS_NODE'].join(':') } : {}) } });
        const queue: (TransportFrame | null)[] = [];
        let pending: ((v: TransportFrame | null) => void) | undefined;
        let closed = false;
        const deliver = (frame: TransportFrame | null) => {
            if (pending) {
                const next = pending;
                pending = undefined;
                next(frame);
            }
            else if (queue.length < 1024)
                queue.push(frame);
            else
                child.kill();
        };
        const lines = createInterface({ input: child.stdout });
        lines.on('line', text => {
            if (Buffer.byteLength(text) > 8 * 1024 * 1024) {
                child.kill();
                return;
            }
            deliver({ kind: 'text', text });
        });
        child.stderr.resume();
        child.stdin.on('error', () => { });
        child.on('error', () => { closed = true; deliver(null); });
        child.on('close', () => { closed = true; deliver(null); });
        return { send(message) { ensure(!closed, 'owner_connection', 'Owning-OS native helper closed'); child.stdin.write((typeof message === 'string' ? message : JSON.stringify(message)) + '\n'); }, async recv() {
                if (queue.length)
                    return queue.shift()!;
                if (closed)
                    return null;
                return new Promise(resolve => { pending = resolve; });
            }, close() { closed = true; child.stdin.end(); child.kill(); deliver(null); } };
    };
}
