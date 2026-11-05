import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import type { AhpTransport, TransportFrame } from '@microsoft/agent-host-protocol/client';
// Keep the owning-OS helper pure JavaScript plus ws; no runner database/native addons.
function ensure(condition: unknown, _code: string, message: string): asserts condition {
    if (!condition)
        throw new Error(message);
}
export type AhpEndpoint = {
    registryPath: string;
} | {
    url: string;
    tokenFile: string;
};
/** Authenticated local endpoint only. Provider authentication stays on the native host. */
export async function connectAhp(endpoint: AhpEndpoint): Promise<AhpTransport> {
    let ws: WebSocket;
    if ('registryPath' in endpoint) {
        const entry = JSON.parse(await readFile(endpoint.registryPath, 'utf8'));
        ensure(entry.schemaVersion === 2 && entry.type === 'editor' && typeof entry.connectionToken === 'string' && entry.connectionToken.length > 0, 'owner_endpoint', 'Expected authenticated schema-2 editor endpoint');
        if (entry.endpoint?.type === 'socket' && typeof entry.endpoint.path === 'string') {
            ensure(!entry.endpoint.path.startsWith('\\\\') || process.platform === 'win32', 'owner_endpoint', 'Windows native pipe requires an owning-OS transport');
            ws = new WebSocket(`ws://localhost/?tkn=${encodeURIComponent(entry.connectionToken)}`, { createConnection: () => connect({ path: entry.endpoint.path }), handshakeTimeout: 5000 });
        }
        else {
            ensure(entry.endpoint?.type === 'tcp' && ['localhost', '127.0.0.1', '::1'].includes(entry.endpoint.host) && Number.isInteger(entry.endpoint.port), 'owner_endpoint', 'Unsupported local endpoint');
            const host = entry.endpoint.host === '::1' ? '[::1]' : entry.endpoint.host;
            ws = new WebSocket(`ws://${host}:${entry.endpoint.port}/?tkn=${encodeURIComponent(entry.connectionToken)}`, { handshakeTimeout: 5000 });
        }
    }
    else {
        const url = new URL(endpoint.url);
        ensure(url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash, 'owner_endpoint', 'Managed endpoint must be an explicit local authenticated address');
        const token = (await readFile(endpoint.tokenFile, 'utf8')).trim();
        ensure(/^[\w-]{32,}$/.test(token), 'owner_endpoint', 'Managed connection token is missing or too short');
        url.searchParams.set('tkn', token);
        ws = new WebSocket(url, { handshakeTimeout: 5000 });
    }
    const queue: (TransportFrame | null)[] = [];
    let pending: ((value: TransportFrame | null) => void) | undefined;
    let closed = false;
    const deliver = (value: TransportFrame | null) => {
        if (pending) {
            const next = pending;
            pending = undefined;
            next(value);
        }
        else
            queue.push(value);
    };
    ws.on('message', data => deliver({ kind: 'text', text: data.toString() }));
    ws.on('close', () => { closed = true; deliver(null); });
    ws.on('error', () => { closed = true; deliver(null); });
    try {
        await once(ws, 'open');
    }
    catch {
        ws.terminate();
        throw new Error('Native endpoint unavailable or authentication rejected');
    }
    return { send(message) { ensure(!closed, 'owner_connection', 'Native connection closed'); ws.send(typeof message === 'string' ? message : JSON.stringify(message)); }, async recv() {
            if (queue.length)
                return queue.shift()!;
            if (closed)
                return null;
            return new Promise(resolve => { pending = resolve; });
        }, close() { closed = true; ws.terminate(); deliver(null); } };
}
