import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { connectAhp } from '../../src/owners/ahp.ts';
test('default production transport authenticates exact schema-2 endpoint and carries official JSON frames', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sf-ahp-auth-'));
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const token = 'fixture-private-admission-token';
    const endpoint = join(dir, 'endpoint.json');
    await writeFile(endpoint, JSON.stringify({ schemaVersion: 2, type: 'editor', connectionToken: token, endpoint: { type: 'tcp', host: '127.0.0.1', port: address.port } }), { mode: 0o600 });
    server.on('connection', (ws, request) => { assert.equal(new URL(request.url!, 'http://localhost').searchParams.get('tkn'), token); ws.on('message', data => ws.send(data)); });
    try {
        const transport = await connectAhp({ registryPath: endpoint });
        await transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { channel: 'ahp-root://', clientId: 'fixture', protocolVersions: ['1.0.0'] } });
        const frame = await transport.recv();
        assert.equal(frame?.kind, 'text');
        if (frame?.kind === 'text')
            assert.equal(JSON.parse(frame.text).method, 'initialize');
        await transport.close();
        await assert.rejects(connectAhp({ url: 'ws://example.com', tokenFile: endpoint }), /local/i);
    }
    finally {
        for (const client of server.clients)
            client.terminate();
        await new Promise<void>(r => server.close(() => r()));
        await rm(dir, { recursive: true, force: true });
    }
});
test('owning-OS helper uses production transport without probes or credentials crossing stdout', async () => {
    const m = await import('../../src/owners/ipc.ts').catch(() => undefined);
    assert.ok(m?.createAhpProcessConnector, 'production owning-OS helper connector is required');
    const dir = await mkdtemp(join(tmpdir(), 'sf-ahp-helper-'));
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const endpoint = join(dir, 'entry.json');
    await writeFile(endpoint, JSON.stringify({ schemaVersion: 2, type: 'editor', connectionToken: 'fixture-private-token', endpoint: { type: 'tcp', host: '127.0.0.1', port: address.port } }), { mode: 0o600 });
    server.on('connection', ws => ws.on('message', data => ws.send(data)));
    try {
        const connect = m.createAhpProcessConnector({ executable: process.execPath, helperPath: new URL('../../src/owners/ipc-helper.ts', import.meta.url).pathname, endpoint: { registryPath: endpoint } });
        const transport = await connect();
        await transport.send({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} } as any);
        const frame = await transport.recv();
        assert.equal(frame?.kind, 'text');
        if (frame?.kind === 'text')
            assert.equal(JSON.parse(frame.text).method, 'ping');
        await transport.close();
    }
    finally {
        for (const client of server.clients)
            client.terminate();
        await new Promise<void>(r => server.close(() => r()));
        await rm(dir, { recursive: true, force: true });
    }
});
