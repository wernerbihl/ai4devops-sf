import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { nativeCanaryProgram } from '../../src/owners/canary.ts';
async function execute(defaultDnsEscapes = false, denyAllProxy = false) {
    const nonce = 'a'.repeat(32), entrypoint = '/opt/vscode/out/vs/platform/agentHost/node/agentHostServerMain.js';
    const files = new Map<string, string>();
    const opened: {
        path: string;
        flags: string;
    }[] = [];
    const writes: string[] = [];
    let output = '';
    const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
    const fs = { constants: { R_OK: 4, W_OK: 2 }, openSync(p: string, flags: string) {
            opened.push({ path: p, flags });
            if (flags === 'wx' && p.startsWith('/var/lib/software-factory/native-state/.sf-native-canary-')) {
                files.set(p, '');
                return 42;
            }
            throw missing();
        }, writeFileSync(_fd: number, value: string) { const p = [...files.keys()][0]!; writes.push(p); files.set(p, value); }, closeSync() { }, unlinkSync(p: string) { files.delete(p); }, readFileSync(p: string) {
            if (p === '/proc/12/cmdline')
                return 'node\0' + entrypoint + '\0';
            if (p === '/proc/12/stat') {
                const fields = Array(20).fill('0');
                fields[0] = 'S';
                fields[1] = '1';
                fields[19] = '123';
                return '12 (node) ' + fields.join(' ');
            }
            if (p === '/proc/sys/kernel/random/boot_id')
                return 'boot';
            if (files.has(p))
                return files.get(p);
            throw Error('Sensitive contents must never be read');
        }, readlinkSync(p: string) { return p.endsWith('/net') ? 'net:1' : p.endsWith('/mnt') ? 'mnt:1' : 'pid:1'; }, accessSync(p: string, mode: number) {
            if (p === '/workspace' && mode === 4)
                return;
            throw Object.assign(new Error('denied'), { code: 'EROFS' });
        } };
    const net = { connect(options: {
            host: string;
        }) { const socket = new EventEmitter() as any; socket.destroy = () => { }; socket.setTimeout = () => socket; socket.write = (value: string) => queueMicrotask(() => socket.emit('data', Buffer.from(!denyAllProxy && value.startsWith('CONNECT api.githubcopilot.com:443 ') ? 'HTTP/1.1 200 Connection Established\r\n\r\n' : 'HTTP/1.1 403 Forbidden\r\n\r\n'))); queueMicrotask(() => options.host === 'sf-model-proxy' ? socket.emit('connect') : socket.emit('error', { code: 'ENETUNREACH' })); return socket; } };
    const tls = { connect(options: {
            servername: string;
            rejectUnauthorized: boolean;
        }) { assert.equal(options.servername, 'api.githubcopilot.com'); assert.equal(options.rejectUnauthorized, true); const socket = new EventEmitter() as any; socket.authorized = true; socket.destroy = () => { }; socket.setTimeout = () => socket; queueMicrotask(() => socket.emit('secureConnect')); return socket; } };
    class Resolver {
        alternate = false;
        setServers() { this.alternate = true; }
        async resolve4() {
            if (defaultDnsEscapes && !this.alternate)
                return ['93.184.216.34'];
            throw { code: 'ETIMEOUT' };
        }
        cancel() { }
    }
    const input = { nonce, entrypoint, modelProxyUrl: 'http://sf-model-proxy:3128', modelAuthority: 'api.githubcopilot.com:443', workspacePath: '/workspace', workspaceWritable: false, controlPath: '/var/lib/software-factory/native-state', protectedPaths: ['/factory', '/host-auth', '/var/run/docker.sock'] };
    const process = { ppid: 12, argv: ['node', Buffer.from(JSON.stringify(input)).toString('base64')], stdout: { write(v: string) { output += v; } }, stderr: { write() { } }, exitCode: 0 };
    await runInNewContext(nativeCanaryProgram, { require: (name: string) => ({ 'node:fs': fs, 'node:path': path, 'node:net': net, 'node:tls': tls, 'node:dns': { promises: { Resolver } } }[name]), process, Buffer, Set, Promise, URL });
    assert.equal(process.exitCode, 0);
    const encoded = output.match(/SF_CANARY_[a-z0-9]+=([A-Za-z0-9+/=]+)/)![1]!;
    return { result: JSON.parse(Buffer.from(encoded, 'base64').toString()), opened, writes, files };
}
test('fixed native canary program checks actual process ancestry and only writes its owned state positive control', async () => { const r = await execute(); assert.equal(r.result.native.pid, 12); assert.equal(r.result.native.startTime, '123'); assert.equal(r.result.workspaceWriteDenied, true); assert.equal(r.result.defaultDnsDenied, true); assert.ok(r.writes.every(p => p.startsWith('/var/lib/software-factory/native-state/.sf-native-canary-'))); assert.equal(r.files.size, 0); assert.ok(r.opened.filter(p => p.flags === 'r').every(p => ['/factory', '/host-auth', '/var/run/docker.sock'].includes(p.path))); });
test('fixed native canary reports default DNS forwarding as escape even if all direct sockets and alternate DNS are denied', async () => { assert.equal((await execute(true)).result.defaultDnsDenied, false); });
test('fixed native path requires approved proxy CONNECT plus authenticated TLS positive control', async () => { assert.equal((await execute()).result.modelProxyReachable, true); });
test('deny-all proxy fails the required positive native TLS control', async () => { assert.equal((await execute(false, true)).result.modelProxyReachable, false); });
