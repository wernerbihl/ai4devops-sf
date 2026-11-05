import assert from 'node:assert/strict';
import { InMemoryTransport, type AhpTransport } from '@microsoft/agent-host-protocol/client';
import { chatReducer, type ActionType, type ChatInputRequest, type ChatState, type SessionState, type StateAction } from '@microsoft/agent-host-protocol';
const commit = '3c0ec3a089398503a462029e7cc2a5749df5169a';
const now = '2026-11-04T00:00:00.000Z';
// Real official client on both halves; this peer deliberately drops the create reply.
export function fakeHost(options: {
    providers?: string[];
    noModels?: boolean;
    inputQuestions?: ChatInputRequest['questions'];
    dropCreate?: boolean;
    hideCatalog?: boolean;
    provisional?: boolean;
    normalizeWindows?: boolean;
    toolActivity?: boolean;
    toolName?: string;
    toolContributor?: object;
    provider?: string;
    canary?: {
        native: object;
        deny?: boolean;
        defaultDnsDenied?: boolean;
    };
    refuseCancel?: boolean;
    wrongWorkspace?: boolean;
    completedToolAfterInput?: boolean;
    inputBehavior?: 'ignore' | 'reject' | 'wrong-answer' | 'draft-answer';
} = {}) {
    const emitters = new Set<(channel: string, action: StateAction) => Promise<void>>();
    const reverseResponses: any[] = [];
    let latest: AhpTransport | undefined;
    const sessions = new Map<string, SessionState>();
    const chats = new Map<string, ChatState>();
    const olderTurns = new Map<string, ChatState['turns']>();
    const createdSessionIds = new Set<string>();
    const methods: string[] = [];
    const actions: string[] = [];
    const terminals = new Map<string, any>();
    const canaryInputs: any[] = [];
    const config: Record<string, unknown> = {};
    let rootState: any;
    let creates = 0;
    let completedToolHadSubscriber = false;
    let seq = 0;
    async function connect(): Promise<AhpTransport> {
        const [client, server] = InMemoryTransport.pair();
        latest = server;
        const subscriptions = new Set<string>();
        const emit = async (channel: string, action: StateAction, origin?: object) => {
            if (subscriptions.has(channel))
                await server.send({ jsonrpc: '2.0', method: 'action', params: { channel, action, serverSeq: ++seq, ...(origin ? { origin } : {}) } });
        };
        emitters.add(emit);
        void (async () => {
            for (;;) {
                const frame = await server.recv();
                if (!frame)
                    break;
                assert.equal(frame.kind, 'text');
                if (frame.kind !== 'text')
                    throw new Error('expected text');
                const message = JSON.parse(frame.text);
                if (!message.method) {
                    reverseResponses.push(message);
                    continue;
                }
                const p = message.params;
                methods.push(message.method);
                let result: unknown;
                if (message.method === 'initialize') {
                    for (const channel of p.initialSubscriptions ?? [])
                        subscriptions.add(channel);
                    result = {
                        protocolVersion: '1.0.0', serverSeq: seq,
                        serverInfo: { name: 'fixture', version: '1' },
                        snapshots: [{ resource: 'ahp-root://', fromSeq: seq, state: rootState = {
                                    agents: (options.providers ?? [options.provider ?? 'copilotcli']).map(provider => ({ provider, displayName: 'Fixture', description: 'fixture', protectedResources: [{ resource: 'https://api.github.com', authorization_servers: ['https://github.com'] }], models: options.noModels ? [] : [{ id: 'fixture-model', name: 'Fixture' }] })),
                                    config: { schema: { type: 'object', properties: { modelCapabilityOverrides: { type: 'object' }, 'http.proxy': { type: 'string' }, 'http.noProxy': { type: 'array' }, systemProxyEnabled: { type: 'boolean' } } }, values: config },
                                    _meta: { hostBuild: { version: '1.145.0-insider', commit } },
                                } }],
                    };
                }
                else if (message.method === 'resolveSessionConfig')
                    result = {
                        schema: { type: 'object', properties: { isolation: { type: 'string', enum: ['none'] } } }, values: {},
                    };
                else if (message.method === 'authenticate') {
                    rootState.agents[0].models = [{ id: 'authenticated', name: 'Authenticated' }];
                    result = {};
                }
                else if (message.method === 'createTerminal') {
                    terminals.set(p.channel, { content: [], claim: p.claim, lifecycle: { status: 'running' } });
                    result = {};
                }
                else if (message.method === 'disposeTerminal') {
                    terminals.delete(p.channel);
                    result = {};
                }
                else if (message.method === 'listSessions')
                    result = { items: (options.hideCatalog ? [] : [...sessions]).map(([resource, s]) => ({ ...s, resource, createdAt: now, modifiedAt: now })) };
                else if (message.method === 'createSession') {
                    creates++;
                    createdSessionIds.add(p.channel);
                    const chat = `ahp-chat:/${p.channel.split('/').pop()}`;
                    sessions.set(p.channel, { provider: p.provider, title: 'probe', status: 1, lifecycle: (options.provisional ? 'creating' : 'ready') as SessionState['lifecycle'],
                        activeClients: [], chats: [{ resource: chat, title: 'probe', modifiedAt: now, status: 1 }], defaultChat: chat,
                        workingDirectories: options.wrongWorkspace ? ['file:///other'] : options.normalizeWindows ? ['file:///c%3A/probe'] : p.workingDirectories });
                    chats.set(chat, { resource: chat, title: 'probe', status: 1, modifiedAt: now, turns: [] });
                    if (options.dropCreate && creates === 1)
                        continue;
                    result = null;
                }
                else if (message.method === 'subscribe') {
                    subscriptions.add(p.channel);
                    const state = p.channel === 'ahp-root://' ? rootState : sessions.get(p.channel) ?? chats.get(p.channel) ?? terminals.get(p.channel);
                    if (!state) {
                        await server.send({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'missing' } });
                        continue;
                    }
                    result = { snapshot: { resource: p.channel, fromSeq: seq, state } };
                }
                else if (message.method === 'fetchTurns') {
                    const loaded = { type: 'chat/turnsLoaded', turns: olderTurns.get(p.channel) ?? [] } as StateAction;
                    chats.set(p.channel, chatReducer(chats.get(p.channel)!, loaded as Parameters<typeof chatReducer>[1]));
                    await emit(p.channel, loaded);
                    result = {};
                }
                else if (message.method === 'dispatchAction') {
                    let action = p.action as StateAction;
                    actions.push(action.type);
                    if (action.type === 'root/configChanged') {
                        Object.assign(config, action.config);
                        continue;
                    }
                    if (action.type === 'terminal/input') {
                        const match = action.data.match(/'([A-Za-z0-9+/=]+)'\n$/);
                        assert.ok(match);
                        const input = JSON.parse(Buffer.from(match[1]!, 'base64').toString());
                        canaryInputs.push(input);
                        const deny = options.canary?.deny !== false;
                        const result = { nonce: input.nonce, native: options.canary?.native, modelProxyDenied: true, modelProxyReachable: true, workspaceControl: true, workspaceReadable: true, workspaceWriteDenied: !input.workspaceWritable, paths: input.protectedPaths, pathsDenied: deny, metadataDenied: deny, ipv4Denied: deny, ipv6Denied: deny, alternateDnsDenied: deny, defaultDnsDenied: options.canary?.defaultDnsDenied !== false };
                        terminals.get(p.channel).content = [{ type: 'unclassified', value: 'SF_CANARY_' + input.nonce + '=' + Buffer.from(JSON.stringify(result)).toString('base64') + '\n' }];
                        continue;
                    }
                    if (action.type === 'chat/inputCompleted') {
                        const requestedAnswers = action.answers ?? {};
                        if (options.inputBehavior === 'ignore')
                            continue;
                        if (options.inputBehavior === 'reject')
                            action = { ...action, response: 'cancel' } as StateAction;
                        if (options.inputBehavior === 'wrong-answer')
                            action = { ...action, answers: { response: { state: 'submitted', value: { kind: 'text', value: 'Wrong native answer' } } } } as StateAction;
                        if (options.inputBehavior === 'draft-answer')
                            action = { ...action, answers: Object.fromEntries(Object.entries(requestedAnswers).map(([id, answer]) => [id, { ...answer, state: 'draft' }])) } as StateAction;
                    }
                    if (action.type === 'chat/turnStarted')
                        for (const session of sessions.values())
                            session.lifecycle = 'ready' as SessionState['lifecycle'];
                    if (action.type === 'session/activeClientSet') {
                        sessions.get(p.channel)!.activeClients = [action.activeClient];
                        await emit(p.channel, action);
                        continue;
                    }
                    const state = chats.get(p.channel)!;
                    if (action.type === 'chat/turnCancelled' && options.refuseCancel)
                        continue;
                    const next = chatReducer(state, action as Parameters<typeof chatReducer>[1]);
                    chats.set(p.channel, next);
                    if (action.type === 'chat/turnStarted' && options.toolActivity) {
                        const tool = { type: 'chat/toolCallStart', turnId: action.turnId, toolCallId: 'unexpected-1', toolName: options.toolName ?? 'probe_unexpected_tool', displayName: 'Unexpected', ...(options.toolContributor ? { contributor: options.toolContributor } : {}) } as StateAction;
                        chats.set(p.channel, chatReducer(chats.get(p.channel)!, tool as Parameters<typeof chatReducer>[1]));
                        await emit(p.channel, tool);
                    }
                    if (action.type === 'chat/turnStarted' && actions.filter(a => a === 'chat/turnStarted').length === 1) {
                        chats.set(p.channel, chatReducer(chats.get(p.channel)!, { type: 'chat/inputRequested' as ActionType.ChatInputRequested, request: { id: 'question-1', message: 'Ready?', questions: options.inputQuestions ?? (options.inputBehavior?.endsWith('answer') ? [{ kind: 'text', id: 'response', message: 'Continue?', required: true }] : []), _meta: { purpose: 'askUser' } } as ChatInputRequest }));
                    }
                    await emit(p.channel, action, { clientId: 'probe', clientSeq: p.clientSeq });
                    if (action.type === 'chat/inputCompleted' && options.completedToolAfterInput) {
                        completedToolHadSubscriber = subscriptions.has(p.channel);
                        const turnId = chats.get(p.channel)!.activeTurn!.id;
                        const tool = { type: 'chat/toolCallStart', turnId, toolCallId: 'late-shell', toolName: 'shell', displayName: 'Shell' } as StateAction;
                        const complete = { type: 'chat/turnComplete', turnId, duration: 1 } as StateAction;
                        chats.set(p.channel, chatReducer(chats.get(p.channel)!, tool as Parameters<typeof chatReducer>[1]));
                        await emit(p.channel, tool);
                        chats.set(p.channel, chatReducer(chats.get(p.channel)!, complete as Parameters<typeof chatReducer>[1]));
                        await emit(p.channel, complete);
                    }
                    continue;
                }
                else if (message.method === 'unsubscribe') {
                    subscriptions.delete(p.channel);
                    continue;
                }
                else
                    throw new Error(`Unexpected method: ${message.method}`);
                await server.send({ jsonrpc: '2.0', id: message.id, result });
            }
        })();
        return client;
    }
    async function tool(channel: string, name: string, input: object) {
        const state = chats.get(channel)!;
        const turnId = state.activeTurn!.id;
        for (const action of [{ type: 'chat/toolCallStart', turnId, toolCallId: 'actual-call', toolName: name, displayName: name, contributor: { kind: 'client', clientId: 'software-factory' } }, { type: 'chat/toolCallReady', turnId, toolCallId: 'actual-call', invocationMessage: 'Factory operation', toolInput: JSON.stringify(input), confirmed: 'not-needed' }] as StateAction[]) {
            chats.set(channel, chatReducer(chats.get(channel)!, action as Parameters<typeof chatReducer>[1]));
            for (const emit of emitters)
                await emit(channel, action);
        }
    }
    async function reverse() { await latest!.send({ jsonrpc: '2.0', id: 987, method: 'resourceRead', params: { channel: 'ahp-root://', uri: 'file:///protected-host-token' } }); }
    return { connect, sessions, chats, terminals, canaryInputs, config, tool, reverse, reverseResponses, olderTurns, createdSessionIds, methods, actions, get creates() { return creates; }, get completedToolHadSubscriber() { return completedToolHadSubscriber; } };
}
