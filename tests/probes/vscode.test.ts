import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { InMemoryTransport, type AhpTransport } from '@microsoft/agent-host-protocol/client';
import { chatReducer, type ActionType, type ChatInputRequest, type ChatState, type SessionState, type StateAction } from '@microsoft/agent-host-protocol';
import { discoverEndpoint } from '../../probes/common.ts';
import { windowsFileUri } from '../../probes/windows.ts';
import { probeVsCode, VsCodeProbeOwner, nativeOpenUri } from '../../probes/vscode.ts';
import type { NativeIdentity, NativeStart } from '../../src/contracts/domain.ts';
import { validTask } from '../fixtures/contracts.ts';

const commit = '3c0ec3a089398503a462029e7cc2a5749df5169a';
const now = '2026-11-04T00:00:00.000Z';

// Real official client on both halves; this peer deliberately drops the create reply.
function fakeHost(options: { dropCreate?: boolean; hideCatalog?: boolean; provisional?: boolean; normalizeWindows?: boolean; toolActivity?: boolean; toolName?: string; toolContributor?: object; provider?: string; refuseCancel?: boolean; wrongWorkspace?: boolean } = {}) {
  const sessions = new Map<string, SessionState>();
  const chats = new Map<string, ChatState>();
  const createdSessionIds = new Set<string>();
  const methods: string[] = [];
  const actions: string[] = [];
  let creates = 0;
  let seq = 0;
  async function connect(): Promise<AhpTransport> {
    const [client, server] = InMemoryTransport.pair();
    void (async () => {
      for (;;) {
        const frame = await server.recv();
        if (!frame) break;
        assert.equal(frame.kind, 'text');
        if (frame.kind !== 'text') throw new Error('expected text');
        const message = JSON.parse(frame.text);
        const p = message.params;
        methods.push(message.method);
        let result: unknown;
        if (message.method === 'initialize') result = {
          protocolVersion: '1.0.0', serverSeq: seq,
          serverInfo: { name: 'fixture', version: '1' },
          snapshots: [{ resource: 'ahp-root://', fromSeq: seq, state: {
            agents: [{ provider: options.provider ?? 'copilotcli', displayName: 'Fixture', description: 'fixture', models: [] }],
            _meta: { hostBuild: { version: '1.145.0-insider', commit } },
          } }],
        };
        else if (message.method === 'resolveSessionConfig') result = {
          schema: { type: 'object', properties: { isolation: { type: 'string', enum: ['none'] } } }, values: {},
        };
        else if (message.method === 'listSessions') result = { items: (options.hideCatalog ? [] : [...sessions]).map(([resource, s]) => ({ ...s, resource, createdAt: now, modifiedAt: now })) };
        else if (message.method === 'createSession') {
          creates++;
          createdSessionIds.add(p.channel);
          const chat = 'ahp-chat:/opaque-chat';
          sessions.set(p.channel, { provider: p.provider, title: 'probe', status: 1, lifecycle: (options.provisional ? 'creating' : 'ready') as SessionState['lifecycle'],
            activeClients: [], chats: [{ resource: chat, title: 'probe', modifiedAt: now, status: 1 }], defaultChat: chat,
            workingDirectories: options.wrongWorkspace ? ['file:///other'] : options.normalizeWindows ? ['file:///c%3A/probe'] : p.workingDirectories });
          chats.set(chat, { resource: chat, title: 'probe', status: 1, modifiedAt: now, turns: [] });
          if (options.dropCreate && creates === 1) continue;
          result = null;
        } else if (message.method === 'subscribe') {
          const state = sessions.get(p.channel) ?? chats.get(p.channel);
          if (!state) { await server.send({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'missing' } }); continue; }
          result = { snapshot: { resource: p.channel, fromSeq: seq, state } };
        } else if (message.method === 'dispatchAction') {
          const action = p.action as StateAction;
          actions.push(action.type);
          if (action.type === 'chat/turnStarted') for (const session of sessions.values()) session.lifecycle = 'ready' as SessionState['lifecycle'];
          const state = chats.get(p.channel)!;
          if (action.type === 'chat/turnCancelled' && options.refuseCancel) continue;
          const next = chatReducer(state, action as Parameters<typeof chatReducer>[1]);
          chats.set(p.channel, next);
          if (action.type === 'chat/turnStarted' && options.toolActivity) {
            await server.send({ jsonrpc: '2.0', method: 'action', params: { channel: p.channel, serverSeq: ++seq, action: { type: 'chat/toolCallStart', turnId: action.turnId, toolCallId: 'unexpected-1', toolName: options.toolName ?? 'probe_unexpected_tool', displayName: 'Unexpected', ...(options.toolContributor ? { contributor: options.toolContributor } : {}) } } });
          }
          if (action.type === 'chat/turnStarted' && actions.filter(a => a === 'chat/turnStarted').length === 1) {
            chats.set(p.channel, chatReducer(next, { type: 'chat/inputRequested' as ActionType.ChatInputRequested, request: { id: 'question-1', message: 'Ready?', questions: [], _meta: { purpose: 'askUser' } } as ChatInputRequest }));
          }
          await server.send({ jsonrpc: '2.0', method: 'action', params: { channel: p.channel, action, serverSeq: ++seq, origin: { clientId: 'probe', clientSeq: p.clientSeq } } });
          continue;
        } else if (message.method === 'unsubscribe') continue;
        else throw new Error(`Unexpected method: ${message.method}`);
        await server.send({ jsonrpc: '2.0', id: message.id, result });
      }
    })();
    return client;
  }
  return { connect, sessions, chats, createdSessionIds, methods, actions, get creates() { return creates; } };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sf-vscode-test-'));
  return { scratchRepo: root, outputDir: join(root, 'evidence'), mode: 'fixture' as const, allowLive: false };
}
function start(root: string): NativeStart {
  return { idempotencyKey: 'start-1', attemptId: 'attempt-1', task: validTask(), workspacePath: root,
    baseSha: 'a'.repeat(40), fence: 1, profileId: 'scratch-no-tools' };
}

test('dropped create reply reconciles the original native identity through input, cancel, continuation and owner restart', async () => {
  const options = await fixture();
  const host = fakeHost({ dropCreate: true });
  const opened: NativeIdentity[] = [];
  const report = await probeVsCode(options, { connect: host.connect, timeoutMs: 80,
    navigation: { hostCommit: commit, open: async (_uri, identity) => { opened.push(identity); return identity; } } });
  assert.equal(report.status, 'passed');
  assert.equal(host.createdSessionIds.size, 1);
  assert.equal(host.creates, 1);
  assert.deepEqual(opened[1], opened[0]);
  assert.ok(opened[0]?.sessionId.startsWith('ahp-session:/'));
  assert.equal(opened[0]?.chatId, 'ahp-chat:/opaque-chat');
  for (const method of ['initialize', 'resolveSessionConfig', 'createSession', 'listSessions', 'subscribe']) assert.ok(host.methods.includes(method));
  for (const action of ['chat/turnStarted', 'chat/inputCompleted', 'chat/turnCancelled']) assert.ok(host.actions.includes(action));
  const saved = JSON.parse(await readFile(report.artifacts[0]!, 'utf8'));
  assert.equal(saved.mode, 'fixture');
  assert.ok(report.assertions.every(a => a.passed));
});

test('unsupported profile rejects before native allocation', async () => {
  const options = await fixture();
  const host = fakeHost();
  const owner = new VsCodeProbeOwner(options, { connect: host.connect });
  await assert.rejects(owner.ensureSession({ ...start(options.scratchRepo), profileId: 'container-isolated' }), /profile/i);
  assert.equal(host.creates, 0);
  const capabilities = await owner.capabilities(validTask().required);
  assert.deepEqual(capabilities.verifiedProfileIds, []);
  await owner.close();
});

test('provider discovery blocks an unavailable provider without creating a fallback session', async () => {
  const options = await fixture();
  const host = fakeHost({ provider: 'copilot' });
  const report = await probeVsCode({ ...options, provider: 'codex' }, { connect: host.connect, timeoutMs: 80 });
  assert.equal(report.status, 'blocked');
  assert.equal(host.creates, 0);
});

test('launching a native URI alone cannot prove the native-open assertion', async () => {
  const options = await fixture();
  const host = fakeHost();
  const report = await probeVsCode(options, { connect: host.connect, timeoutMs: 80,
    navigation: { hostCommit: commit, open: async () => undefined } });
  assert.equal(report.status, 'blocked');
  assert.equal(report.assertions.find(a => a.name === 'native-open')?.passed, false);
});

test('wrong restored workspace fails exact-session reconciliation', async () => {
  const options = await fixture();
  const host = fakeHost({ wrongWorkspace: true });
  const report = await probeVsCode(options, { connect: host.connect, timeoutMs: 80 });
  assert.equal(report.status, 'failed');
});

test('host that ignores cancellation never earns quiescence evidence', async () => {
  const options = await fixture();
  const host = fakeHost({ refuseCancel: true });
  const report = await probeVsCode(options, { connect: host.connect, timeoutMs: 80,
    navigation: { hostCommit: commit, open: async (_uri, id) => id } });
  assert.equal(report.status, 'blocked');
  assert.equal(report.assertions.find(a => a.name === 'quiescence')?.passed, false);
});

test('native opening preserves opaque chat identity and rejects an unverified host version', () => {
  const id = { ownerId: 'vscode', providerId: 'codex' as const, sessionId: 'ahp-session:/session-1', chatId: 'ahp-chat:/chat-1' };
  assert.equal(nativeOpenUri(id, commit), 'vscode-insiders://agents/agent-host-session/ahp-session/session-1/chat/ahp-chat%253A%252Fchat-1');
  assert.throws(() => nativeOpenUri(id, 'unverified'), /version|commit/i);
});

test('live mode without explicit permission is rejected by the shared contract', async () => {
  const options = await fixture();
  await assert.rejects(probeVsCode({ ...options, mode: 'live', allowLive: false } as never), /ProbeOptions/);
});

test('Windows helper maps the UNC scratch workspace without dropping its authority', () => {
  assert.equal(windowsFileUri(String.raw`\\wsl.localhost\Ubuntu-22.04\home\probe`), 'file://wsl.localhost/Ubuntu-22.04/home/probe');
});

test('unavailable transport is blocked evidence rather than a passing skip or protocol failure', async () => {
  const options = await fixture();
  const report = await probeVsCode(options, { timeoutMs: 20, connect: async () => InMemoryTransport.pair()[0] });
  assert.equal(report.status, 'blocked');
  assert.equal(report.assertions.find(a => a.name === 'create')?.passed, false);
});

test('fixture mode cannot accidentally connect to a native endpoint', async () => {
  const options = await fixture();
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const report = await probeVsCode({ ...options, endpoint: `ws://127.0.0.1:${address.port}` });
    assert.equal(report.status, 'blocked');
    assert.equal(connections, 0);
  } finally { server.close(); }
});

test('endpoint discovery ignores a dead editor registry entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-registry-'));
  const entries = join(root, 'agent-host', 'local-endpoint', 'entries');
  await mkdir(entries, { recursive: true });
  const entry = { schemaVersion: 2, type: 'editor', pid: process.pid, endpoint: { type: 'socket', path: '/fixture' }, connectionToken: 'fixture' };
  await writeFile(join(entries, 'alive.json'), JSON.stringify(entry));
  await writeFile(join(entries, 'dead.json'), JSON.stringify({ ...entry, pid: 2147483647 }));
  assert.equal(await discoverEndpoint(root), join(entries, 'alive.json'));
});

test('native creation is reconciled by exact subscription even before the host lists a pristine session', async () => {
  const options = await fixture();
  const host = fakeHost({ hideCatalog: true });
  const owner = new VsCodeProbeOwner(options, { connect: host.connect });
  try {
    const identity = await owner.ensureSession(start(options.scratchRepo));
    assert.equal(identity.chatId, 'ahp-chat:/opaque-chat');
    assert.equal(host.creates, 1);
    assert.deepEqual(await owner.ensureSession(start(options.scratchRepo)), identity);
    assert.equal(host.creates, 1);
  } finally { await owner.close(); }
});

test('the owner sends into the host-owned provisional session before native materialization', async () => {
  const options = await fixture();
  const host = fakeHost({ provisional: true, hideCatalog: true });
  const owner = new VsCodeProbeOwner(options, { connect: host.connect, timeoutMs: 40 });
  try {
    const identity = await owner.ensureSession(start(options.scratchRepo));
    await owner.send(identity, { text: 'No tools. Reply READY.' }, 'provisional-turn');
    assert.equal((await owner.snapshot(identity)).state, 'waiting');
    assert.equal(host.sessions.get(identity.sessionId)?.lifecycle, 'ready');
    assert.equal(host.creates, 1);
  } finally { await owner.close(); }
});

test('equivalent native Windows drive URI encoding preserves the same workspace', async () => {
  const options = await fixture();
  const host = fakeHost({ normalizeWindows: true });
  const owner = new VsCodeProbeOwner(options, { connect: host.connect, workspaceUri: async () => 'file:///C:/probe' });
  try {
    const identity = await owner.ensureSession(start(options.scratchRepo));
    assert.equal(identity.providerId, 'copilot');
    assert.equal(host.creates, 1);
  } finally { await owner.close(); }
});

test('unexpected native tool activity cancels the diagnostic and records verified final quiescence', async () => {
  const options = await fixture();
  const host = fakeHost({ toolActivity: true });
  const report = await probeVsCode(options, { connect: host.connect, timeoutMs: 80, navigation: { hostCommit: commit, open: async (_uri, id) => id } });
  assert.equal(report.status, 'blocked');
  assert.ok(host.actions.includes('chat/turnCancelled'));
  assert.equal(report.assertions.find(a => a.name === 'quiescence')?.passed, true);
  const details = JSON.parse(await readFile(report.artifacts[1]!, 'utf8'));
  assert.deepEqual(details.diagnostics.toolNames, ['probe_unexpected_tool']);
});

test('native structured input forwards submitted answers and ignores a duplicate completion', async () => {
  const options = await fixture();
  const host = fakeHost();
  const owner = new VsCodeProbeOwner(options, { connect: host.connect });
  try {
    const identity = await owner.ensureSession(start(options.scratchRepo));
    await owner.send(identity, { text: 'Question diagnostic' }, 'input-turn');
    const answers = { ready: { state: 'submitted', value: { kind: 'boolean', value: true } } };
    await owner.send(identity, { requestId: 'question-1', answers }, 'input-answer');
    await owner.send(identity, { requestId: 'question-1', answers }, 'input-answer');
    const chat = await owner.chat(identity);
    const part = chat.activeTurn?.responseParts.find(p => p.kind === 'inputRequest');
    assert.equal(part?.kind, 'inputRequest');
    if (part?.kind === 'inputRequest') assert.deepEqual(part.request.answers, answers);
    assert.equal(host.actions.filter(a => a === 'chat/inputCompleted').length, 1);
  } finally { await owner.close(); }
});

test('Codex discovery uses its advertised native provider and preserves identity across owner restart', async () => {
  const options = await fixture();
  const host = fakeHost({ provider: 'codex', dropCreate: true });
  const observed: NativeIdentity[] = [];
  const report = await probeVsCode({ ...options, provider: 'codex' }, { connect: host.connect, timeoutMs: 80,
    navigation: { hostCommit: commit, open: async (_uri, identity) => { observed.push(identity); return identity; } } });
  assert.equal(report.status, 'passed');
  assert.equal(report.versions.nativeProvider, 'codex');
  assert.equal(host.creates, 1);
  assert.equal(observed[0]?.providerId, 'codex');
  assert.deepEqual(observed[1], observed[0]);
});

test('the explicit native input exception permits only built-in ask_user on the tested Copilot host', async () => {
  const options = await fixture();
  const host = fakeHost({ toolActivity: true, toolName: 'ask_user' });
  const report = await probeVsCode(options, { connect: host.connect, timeoutMs: 80, allowNativeAskUser: true,
    navigation: { hostCommit: commit, open: async (_uri, identity) => identity } });
  assert.equal(report.status, 'passed');
  assert.equal(report.assertions.find(a => a.name === 'send-input')?.passed, true);
  const details = JSON.parse(await readFile(report.artifacts[1]!, 'utf8'));
  assert.deepEqual(details.diagnostics.permittedInputTools, ['ask_user']);
});

for (const [name, contributor] of [['read_file', undefined], ['shell', undefined], ['ask_user', { kind: 'mcp', serverId: 'foreign' }]] as const) {
  test(`native input exception still cancels ${name} with contributor ${contributor ? 'external' : 'none'}`, async () => {
    const options = await fixture();
    const host = fakeHost({ toolActivity: true, toolName: name, ...(contributor ? { toolContributor: contributor } : {}) });
    const report = await probeVsCode(options, { connect: host.connect, timeoutMs: 80, allowNativeAskUser: true,
      navigation: { hostCommit: commit, open: async (_uri, id) => id } });
    assert.equal(report.status, 'blocked');
    assert.ok(host.actions.includes('chat/turnCancelled'));
    assert.equal(report.assertions.find(a => a.name === 'send-input')?.passed, false);
  });
}
