import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeStart, ProfileEvidence } from '../../src/contracts/domain.ts';
import { validTask } from '../fixtures/contracts.ts';
import { fakeHost } from './ahp-fixture.ts';
// Missing behavior is asserted before loading the implementation (meaningful RED).
async function adapter() {
    let implementation: any;
    try {
        implementation = await import('../../src/owners/vscode.ts');
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND')
            throw e;
    }
    assert.equal(typeof implementation?.createVsCodeOwner, 'function', 'production NativeOwner factory must exist');
    return implementation as typeof import('../../src/owners/vscode.ts');
}
async function fixture(options: Parameters<typeof fakeHost>[0] = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'sf-owner-'));
    const host = fakeHost(options);
    const start: NativeStart = { idempotencyKey: 'start', attemptId: 'a1', fence: 1, workspacePath: dir, baseSha: 'a'.repeat(40), profileId: 'fixture', task: { ...validTask(), ownerId: 'vscode', providerId: options.provider === 'codex' ? 'codex' : 'copilot' } };
    const opens: string[] = [];
    const { createVsCodeOwner } = await adapter();
    const create = () => createVsCodeOwner({ journalPath: join(dir, 'owner.sqlite'), connect: host.connect, timeoutMs: 70,
        requireVerifiedProfile: async (s: NativeStart) => ({ profileId: s.profileId, ownerId: s.task.ownerId, providerId: s.task.providerId, required: s.task.required, verifiedAt: new Date().toISOString(), probes: [] }) as ProfileEvidence,
        navigation: { launch: async (uri: string) => { opens.push(uri); } },
    });
    return { dir, host, start, opens, create, owner: create() };
}
test('implements_native_owner_without_sdk_import: official P2 protocol through all NativeOwner methods', async () => {
    const { owner, start, host, opens } = await fixture({ dropCreate: true });
    const events: unknown[] = [];
    const unsubscribe = owner.subscribe(e => events.push(e));
    try {
        await owner.ensureStarted();
        const capability = await owner.capabilities(start.task.required);
        assert.deepEqual(capability.supportedProviders, ['copilot']);
        assert.equal(capability.ready, false);
        assert.deepEqual(capability.verifiedProfileIds, []);
        const identity = await owner.ensureSession(start);
        await owner.send(identity, { text: 'Question' }, 'turn1');
        const snap = await owner.snapshot(identity);
        assert.equal(snap.state, 'waiting');
        await owner.send(identity, { requestId: snap.inputs[0]!.id, response: 'accept' }, 'answer1');
        assert.equal(await owner.quiesce(identity), 'unknown');
        await owner.open(identity);
        assert.equal(opens.length, 1);
        assert.ok(opens[0]!.includes(encodeURIComponent(encodeURIComponent(identity.chatId!))));
        assert.equal(host.creates, 1);
        assert.ok(events.length);
        unsubscribe();
        const source = await readFile(new URL('../../src/owners/vscode.ts', import.meta.url), 'utf8');
        assert.doesNotMatch(source, /from\s+['"].*(?:probes|copilot-sdk|codex-sdk)/);
    }
    finally {
        await owner.close();
    }
});
test('opens_exact_identity_and_does_not_replace_missing_history across new attempt and owner restart', async () => {
    const f = await fixture();
    let owner = f.owner;
    try {
        const original = await owner.ensureSession(f.start);
        await owner.send(original, { text: 'first' }, 'turn1');
        await owner.quiesce(original);
        await owner.close();
        owner = f.create();
        const retry = await owner.ensureSession({ ...f.start, attemptId: 'a2', fence: 2, idempotencyKey: 'retry' });
        assert.deepEqual(retry, original);
        await owner.open(retry);
        assert.equal(f.opens.length, 1);
        f.host.sessions.clear();
        f.host.chats.clear();
        assert.equal((await owner.snapshot(original)).state, 'lost');
        await assert.rejects(owner.ensureSession({ ...f.start, attemptId: 'a3', fence: 3 }), /lost|missing|unknown/i);
        assert.equal(f.host.creates, 1);
    }
    finally {
        await owner.close();
    }
});
test('unsupported provider or unverified isolation refuses allocation', async () => {
    const f = await fixture();
    try {
        await assert.rejects(f.owner.ensureSession({ ...f.start, task: { ...f.start.task, providerId: 'codex' } }), /provider/i);
        assert.equal(f.host.creates, 0);
    }
    finally {
        await f.owner.close();
    }
    const { createVsCodeOwner } = await adapter();
    const owner = createVsCodeOwner({ journalPath: join(f.dir, 'denied.sqlite'), connect: f.host.connect, timeoutMs: 70 });
    try {
        await assert.rejects(owner.ensureSession(f.start), /profile|isolation/i);
        assert.equal(f.host.creates, 0);
    }
    finally {
        await owner.close();
    }
});
test('durable action receipts reject changed idempotent payload and do not duplicate a turn', async () => {
    const f = await fixture();
    let owner = f.owner;
    try {
        const id = await owner.ensureSession(f.start);
        await owner.send(id, { text: 'once' }, 'same');
        await owner.close();
        owner = f.create();
        await owner.ensureSession(f.start);
        await owner.send(id, { text: 'once' }, 'same');
        await assert.rejects(owner.send(id, { text: 'different' }, 'same'), /conflict/i);
        assert.equal(f.host.actions.filter(x => x === 'chat/turnStarted').length, 1);
    }
    finally {
        await owner.close();
    }
});
test('provider workspace drift and ignored input acknowledgement never become success', async () => {
    const f = await fixture({ wrongWorkspace: true });
    try {
        await assert.rejects(f.owner.ensureSession(f.start), /workspace/i);
    }
    finally {
        await f.owner.close();
    }
    const g = await fixture({ inputBehavior: 'ignore' });
    try {
        const id = await g.owner.ensureSession(g.start);
        await g.owner.send(id, { text: 'question' }, 'turn');
        await assert.rejects(g.owner.send(id, { requestId: 'question-1', response: 'accept' }, 'answer'), /observed|unknown/i);
    }
    finally {
        await g.owner.close();
    }
});
test('closed owner cannot reconnect or start new native work', async () => { const f = await fixture(); await f.owner.ensureStarted(); await f.owner.close(); await assert.rejects(f.owner.ensureStarted(), /closed/i); await f.owner.close(); });
test('read-only broker reconciliation recovers original identity when fresh profile is unavailable', async () => {
    const f = await fixture();
    const id = await f.owner.ensureSession(f.start);
    await f.owner.close();
    const { createVsCodeOwner } = await adapter();
    const owner = createVsCodeOwner({ journalPath: join(f.dir, 'owner.sqlite'), connect: f.host.connect, timeoutMs: 70 });
    try {
        assert.equal(typeof owner.reconcile, 'function', 'E6 requires readonly original native outcome reconciliation');
        assert.deepEqual(await owner.reconcile(f.start), { state: 'done', identity: id });
        f.host.sessions.clear();
        assert.deepEqual(await owner.reconcile(f.start), { state: 'unknown' });
        assert.equal(f.host.creates, 1);
    }
    finally {
        await owner.close();
    }
});
test('trusted provider authentication uses only advertised protected resource and refreshes model discovery', async () => {
    const f = await fixture({ noModels: true });
    try {
        await f.owner.ensureStarted();
        assert.deepEqual((await f.owner.capabilities(f.start.task.required)).supportedProviders, []);
        assert.equal(typeof f.owner.authenticateProvider, 'function', 'managed native model authentication must use public AHP');
        await assert.rejects(f.owner.authenticateProvider('copilot', { resource: 'https://foreign.test', token: 'private' }), /resource/i);
        await assert.rejects(f.owner.authenticateProvider('copilot', { resource: 'https://api.github.com', token: 'private', scopes: ['repo'] }), /scope/i);
        await f.owner.authenticateProvider('copilot', { resource: 'https://api.github.com', token: 'private', expiresIn: 60 });
        assert.deepEqual((await f.owner.capabilities(f.start.task.required)).supportedProviders, ['copilot']);
        assert.equal(f.host.methods.filter(m => m === 'authenticate').length, 1);
        assert.equal(f.host.creates, 0);
    }
    finally {
        await f.owner.close();
    }
});
test('owner readiness associates verified profiles with the actual provider rather than all discovered models', async () => {
    const f = await fixture();
    try {
        assert.equal(typeof f.owner.readiness, 'function', 'typed per-provider readiness required');
        const readiness = await f.owner.readiness(f.start.task.required);
        assert.deepEqual(readiness.providers.find(p => p.providerId === 'copilot')?.verifiedProfileIds, []);
        assert.equal(readiness.providers.find(p => p.providerId === 'copilot')?.ready, false);
    }
    finally {
        await f.owner.close();
    }
});
test('Copilot profile proof does not mark discovered Codex provider ready', async () => {
    const f = await fixture({ providers: ['copilotcli', 'codex'] });
    await f.owner.close();
    const { createVsCodeOwner } = await adapter();
    const owner = createVsCodeOwner({ journalPath: join(f.dir, 'matrix.sqlite'), connect: f.host.connect, timeoutMs: 70, readinessStarts: async () => [f.start], requireVerifiedProfile: async (s) => ({ profileId: s.profileId, ownerId: s.task.ownerId, providerId: s.task.providerId, required: s.task.required, verifiedAt: new Date().toISOString(), probes: [] }) });
    try {
        const r = await owner.readiness(f.start.task.required);
        assert.deepEqual(r.supportedProviders, ['copilot', 'codex']);
        assert.equal(r.providers.find(p => p.providerId === 'copilot')?.ready, true);
        assert.equal(r.providers.find(p => p.providerId === 'codex')?.ready, false);
        assert.deepEqual(r.providers.find(p => p.providerId === 'codex')?.verifiedProfileIds, []);
    }
    finally {
        await owner.close();
    }
});
test('background native work is active and cannot be mistaken for a safe idle continuation', async () => {
    const f = await fixture();
    try {
        const id = await f.owner.ensureSession(f.start);
        f.host.chats.get(id.chatId!)!.status = 8;
        assert.equal((await f.owner.snapshot(id)).state, 'active');
        await assert.rejects(f.owner.send(id, { text: 'must wait' }, 'busy'), /active|busy/i);
        assert.equal(await f.owner.quiesce(id), 'unknown');
    }
    finally {
        await f.owner.close();
    }
});
test('managed native open refuses a missing registered connection authority before launching', async () => {
    const f = await fixture();
    const id = await f.owner.ensureSession(f.start);
    await f.owner.close();
    const { createVsCodeOwner } = await adapter();
    let launches = 0;
    const owner = createVsCodeOwner({ journalPath: join(f.dir, 'owner.sqlite'), connect: f.host.connect, timeoutMs: 70, launcher: { ensureStarted: async () => ({ registryPath: '/unused' }) }, navigation: { launch: async () => { launches++; } } });
    try {
        owner.admitHumanOpen(id, () => { });
        await assert.rejects(owner.open(id), /connection|authority/i);
        assert.equal(launches, 0);
    }
    finally {
        await owner.close();
    }
});
test('AHP idle without contained process proof never reports quiescence', async () => {
    const f = await fixture();
    try {
        const id = await f.owner.ensureSession(f.start);
        assert.equal(await f.owner.quiesce(id), 'unknown');
    }
    finally {
        await f.owner.close();
    }
});
