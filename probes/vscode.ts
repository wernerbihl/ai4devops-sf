import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AhpClient, RpcError, RpcTimeoutError, TransportError, type AhpTransport } from '@microsoft/agent-host-protocol/client';
import { MessageKind, SUPPORTED_PROTOCOL_VERSIONS,
  type ChatInputResponseKind,
  type ActionType,
  type ChatInputAnswer, type ChatInputQuestion, type ChatState, type RootState, type SessionState } from '@microsoft/agent-host-protocol';
import type { NativeOwner } from '../src/contracts/owner.ts';
import type { NativeIdentity, NativeStart, NativeSnapshot, OwnerEvent, ProbeEvidence, ProbeOptions, RequiredCapabilities } from '../src/contracts/domain.ts';
import { validateContract } from '../src/contracts/schemas.ts';
import { assertLiveScratch, connectEndpoint, discoverEndpoint, ProbeBlocked, writeEvidence } from './common.ts';

function workspaceKey(uri: string): string {
  const value = new URL(uri);
  const path = decodeURIComponent(value.pathname).replace(/^\/([A-Z]):/, (_, drive: string) => `/${drive.toLowerCase()}:`);
  return `${value.protocol}//${value.host}${path}`;
}

const testedCommit = '3c0ec3a089398503a462029e7cc2a5749df5169a';
export interface ProbeRuntime {
  connect?: () => Promise<AhpTransport>;
  timeoutMs?: number;
  allowNativeAskUser?: boolean;
  inputIdempotencyKey?: string;
  workspaceUri?: (path: string) => Promise<string>;
  navigation?: {
    hostCommit: string;
    /** Returns the identity actually observed in the native UI, not the requested URI. */
    open(uri: string, requested: NativeIdentity): Promise<NativeIdentity | undefined>;
  };
}

/** Port of the external URL builder at the exact tested VS Code commit's openSessionLink.ts. */
export function nativeOpenUri(identity: NativeIdentity, hostCommit: string): string {
  if (hostCommit !== testedCommit) throw new ProbeBlocked('Native opening is not verified for this host commit');
  const uri = new URL(identity.sessionId);
  if (uri.protocol !== 'ahp-session:' || uri.host || uri.search || uri.hash || !/^\/[\w-]+$/.test(uri.pathname)) {
    throw new ProbeBlocked('Opening route is unverified for this native session URI shape');
  }
  const chatPath = identity.chatId && identity.chatId !== 'default'
    ? `/chat/${encodeURIComponent(encodeURIComponent(identity.chatId))}` : '';
  return `vscode-insiders://agents/agent-host-session/ahp-session${uri.pathname}${chatPath}`;
}

/** Diagnostic adapter only: no scheduler, dispatch authorization, or verified isolation profile. */
export class VsCodeProbeOwner implements NativeOwner {
  private client: AhpClient | undefined;
  private root: RootState | undefined;
  private readonly listeners = new Set<(event: OwnerEvent) => void>();
  readonly versions: Record<string, string> = { node: process.version, ahpPackage: '1.0.0' };
  unexpectedToolActivity = false;
  readonly diagnostics: Record<string, unknown> = {};
  readonly actionTypes = new Set<string>();
  readonly timeoutMs: number;
  readonly options: ProbeOptions;
  readonly runtime: ProbeRuntime;
  constructor(options: ProbeOptions, runtime: ProbeRuntime = {}) {
    this.options = options; this.runtime = runtime; this.timeoutMs = runtime.timeoutMs ?? 15_000;
  }

  async ensureStarted(): Promise<void> {
    if (this.client) return;
    if (this.options.mode === 'fixture' && !this.runtime.connect) throw new ProbeBlocked('Fixture mode requires an injected fixture transport');
    const transport = this.runtime.connect ? await this.runtime.connect() : await connectEndpoint(this.options.endpoint ?? await discoverEndpoint());
    const client = new AhpClient(transport, { requestTimeoutMs: this.timeoutMs });
    this.client = client;
    const events = client.events();
    client.connect();
    void (async () => {
      for await (const event of events) {
        if (event.event.type === 'action') {
          const action = event.event.params.action;
          this.actionTypes.add(action.type);
          if (action.type === 'chat/toolCallStart' && this.permittedInputTool(action.toolName, action.contributor)) {
            this.diagnostics.permittedInputTools = ['ask_user'];
          } else if (action.type === 'chat/toolCallStart') {
            this.unexpectedToolActivity = true;
            this.diagnostics.toolNames = [...new Set([...(this.diagnostics.toolNames as string[] | undefined ?? []), action.toolName])];
            client.dispatch(event.channel, { type: 'chat/turnCancelled' as ActionType.ChatTurnCancelled, turnId: action.turnId, duration: 0 });
          }
        }
      }
    })();
    const init = await client.request('initialize', { channel: 'ahp-root://', clientId: 'software-factory-native-probe', protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS], initialSubscriptions: ['ahp-root://'],
      clientInfo: { name: 'software-factory-native-probe', version: '0.1.0' },
      _meta: { 'vscode.ahpSessionUris': true, 'vscode.ahpChatUris': true } });
    this.versions.protocol = init.protocolVersion;
    if (init.serverInfo) this.versions.server = `${init.serverInfo.name}@${init.serverInfo.version ?? 'unknown'}`;
    this.root = init.snapshots.find(s => s.resource === 'ahp-root://')?.state as RootState | undefined;
    if (!this.root?.agents) throw new ProbeBlocked('Host did not publish provider discovery');
    const build = this.root._meta?.hostBuild as { version?: string; commit?: string } | undefined;
    if (build?.version) this.versions.host = build.version;
    if (build?.commit) this.versions.hostCommit = build.commit;
  }
  async capabilities(_required: RequiredCapabilities) {
    await this.ensureStarted();
    const providers = (['copilot', 'codex'] as const).filter(p => this.root!.agents.some(a => a.provider === (p === 'copilot' ? 'copilotcli' : 'codex')));
    return { ready: providers.includes(this.options.provider ?? 'copilot'), supportedProviders: providers,
      reasons: ['Lifecycle-only diagnostic; no isolation profile has been verified'], verifiedProfileIds: [], version: this.versions.protocol! };
  }
  async close(): Promise<void> { await this.client?.shutdown(); this.client = undefined; this.root = undefined; }
  private async rpc() { await this.ensureStarted(); return this.client!; }
  private async session(channel: string): Promise<SessionState> {
    const client = await this.rpc();
    const { result } = await client.subscribe(channel);
    await client.unsubscribe(channel);
    if (!result.snapshot) throw new ProbeBlocked('No native session snapshot');
    return result.snapshot.state as SessionState;
  }
  async chat(identity: NativeIdentity): Promise<ChatState> {
    this.checkIdentity(identity);
    const client = await this.rpc();
    const { result } = await client.subscribe(identity.chatId!);
    await client.unsubscribe(identity.chatId!);
    if (!result.snapshot) throw new ProbeBlocked('No native chat snapshot');
    const state = result.snapshot.state as ChatState;
    if (state.activeTurn?.responseParts.some(p => p.kind === 'toolCall' && !this.permittedInputTool(p.toolCall.toolName, p.toolCall.contributor))) this.unexpectedToolActivity = true;
    if (state.resource !== identity.chatId) throw new Error('Native chat identity changed');
    return state;
  }
  private permittedInputTool(name: string, contributor: unknown): boolean {
    return this.runtime.allowNativeAskUser === true && (this.options.provider ?? 'copilot') === 'copilot'
      && this.versions.hostCommit === testedCommit && name === 'ask_user' && contributor === undefined;
  }
  private checkIdentity(identity: NativeIdentity) {
    if (identity.ownerId !== 'vscode' || identity.providerId !== (this.options.provider ?? 'copilot') || !identity.chatId) throw new Error('Native owner/provider/chat identity mismatch');
  }
  async ensureSession(start: NativeStart): Promise<NativeIdentity> {
    validateContract('NativeStart', start);
    if (start.profileId !== 'scratch-no-tools') throw new ProbeBlocked('Unsupported isolation profile');
    if (resolve(start.workspacePath) !== resolve(this.options.scratchRepo)) throw new Error('Scratch workspace mismatch');
    const client = await this.rpc();
    const provider = this.options.provider ?? 'copilot';
    const nativeProvider = provider === 'copilot' ? 'copilotcli' : 'codex';
    this.versions.nativeProvider = nativeProvider;
    if (!this.root!.agents.some(a => a.provider === nativeProvider)) throw new ProbeBlocked(`Provider ${provider} is unavailable on the native host`);
    const directory = this.runtime.workspaceUri ? await this.runtime.workspaceUri(start.workspacePath) : pathToFileURL(resolve(start.workspacePath)).href;
    const config = await client.request('resolveSessionConfig', { channel: 'ahp-root://', provider: nativeProvider, workingDirectory: directory });
    // Only advertised properties are supplied. Deny escalation and restrict writes on hosts that expose these native settings.
    const values = { ...config.values };
    const properties = config.schema.properties;
    for (const [key, value] of [['codex.approvalPolicy', 'never'], ['codex.sandboxMode', 'read-only'], ['codex.permissionsPreset', 'default'], ['autoApprove', 'default'], ['mode', 'interactive'], ['isolation', 'folder']] as const) {
      if (properties[key]?.enum?.includes(value)) values[key] = value;
    }
    const sessionId = `ahp-session:/${createHash('sha256').update(`${provider}\0${start.workspacePath}\0${start.idempotencyKey}\0${start.attemptId}`).digest('hex')}`;
    const journal = join(this.options.outputDir, `${provider}-start.json`);
    await mkdir(this.options.outputDir, { recursive: true });
    const persisted = { sessionId, workspacePath: resolve(start.workspacePath), providerId: provider, attemptId: start.attemptId, baseSha: start.baseSha };
    let previousIntent = false;
    try {
      const previous = JSON.parse(await readFile(journal, 'utf8'));
      if (JSON.stringify(previous) !== JSON.stringify(persisted)) throw new Error('Native start journal conflict');
      previousIntent = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeFile(journal, `${JSON.stringify(persisted)}\n`, { mode: 0o600, flag: 'wx' });
    }
    const found = await this.findSession(sessionId);
    let state: SessionState | undefined;
    if (found || previousIntent) {
      try { state = await this.session(sessionId); }
      catch (error) {
        if (!(error instanceof RpcError && error.code === -32001)) throw error;
        throw new ProbeBlocked('Previous native create outcome is unknown; refusing another allocation');
      }
    }
    if (!state) {
      try { await client.request('createSession', { channel: sessionId, provider: nativeProvider, workingDirectories: [directory], config: values }); }
      catch (error) {
        if (!(error instanceof RpcTimeoutError || error instanceof TransportError || error instanceof RpcError && error.code === -32003)) throw error;
        // RF3: reconnect and subscribe to the original client-chosen URI. Never issue another create.
        await this.close();
        await this.ensureStarted();
      }
      try { state = await this.session(sessionId); }
      catch (error) {
        if (!(error instanceof RpcError && error.code === -32001)) throw error;
        throw new ProbeBlocked('Create outcome unknown; original native identity not found; refusing to create again');
      }
    }
    Object.assign(this.diagnostics, { requestedWorkspace: directory, nativeWorkingDirectories: state.workingDirectories, nativeProvider: state.provider, lifecycle: state.lifecycle, defaultChat: state.defaultChat, chatIds: state.chats.map(c => c.resource) });
    // The tested host intentionally keeps sessions provisional until their first native turn.
    if (state.lifecycle === 'failed') throw new ProbeBlocked('Native session creation failed on the owning host');
    if (state.provider !== nativeProvider || (state.workingDirectories?.length !== 1 || workspaceKey(state.workingDirectories[0]!) !== workspaceKey(directory))) throw Object.assign(new Error('Native provider/workspace changed'), { code: 'NATIVE_WORKSPACE_MISMATCH' });
    if (!state.defaultChat || !state.chats.some(c => c.resource === state.defaultChat)) throw new ProbeBlocked('Host did not publish an exact default chat identity');
    const identity = { ownerId: 'vscode', providerId: provider, sessionId, chatId: state.defaultChat };
    for (const listener of this.listeners) listener({ type: 'identity', identity, at: new Date().toISOString() });
    return identity;
  }
  private async findSession(sessionId: string) {
    const client = await this.rpc();
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await client.request('listSessions', { channel: 'ahp-root://', limit: 100, ...(cursor ? { cursor } : {}) });
      const match = page.items.find(s => s.resource === sessionId);
      if (match) return match;
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('Native session catalog cursor loop');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return undefined;
  }
  async snapshot(identity: NativeIdentity): Promise<NativeSnapshot> {
    const state = await this.chat(identity);
    if (this.unexpectedToolActivity) throw new ProbeBlocked('Unexpected native tool activity; diagnostic cancelled');
    const inputs = state.activeTurn?.responseParts.flatMap(p => p.kind === 'inputRequest' && !p.response
      ? [{ id: p.request.id, schema: { questions: p.request.questions ?? [], purpose: (p.request as { _meta?: { purpose?: string } })._meta?.purpose }, prompt: p.request.message ?? 'Native input' }] : []) ?? [];
    const snapshot: NativeSnapshot = { identity, state: inputs.length ? 'waiting' : state.activeTurn ? 'active' : 'idle', inputs };
    for (const listener of this.listeners) listener({ type: 'snapshot', identity, snapshot, at: new Date().toISOString() });
    return snapshot;
  }
  async send(identity: NativeIdentity, input: object, idempotencyKey: string): Promise<void> {
    this.checkIdentity(identity);
    const client = await this.rpc();
    const payload = input as { text?: string; requestId?: string; response?: string; answers?: Record<string, ChatInputAnswer> };
    if (payload.requestId) {
      const current = await this.chat(identity);
      const parts = [...(current.activeTurn?.responseParts ?? []), ...current.turns.flatMap(t => t.responseParts)];
      const part = parts.find(p => p.kind === 'inputRequest' && p.request.id === payload.requestId);
      if (part?.kind !== 'inputRequest') throw new ProbeBlocked('Native input request not found');
      if (part.response) return;
      const response = payload.response ?? 'accept';
      if (!['accept', 'decline', 'cancel'].includes(response)) throw new Error('Unsupported native input response');
      client.dispatch(identity.chatId!, { type: 'chat/inputCompleted' as ActionType.ChatInputCompleted, requestId: payload.requestId,
        response: response as ChatInputResponseKind, ...(payload.answers ? { answers: payload.answers } : {}) });
    } else {
      if (!payload.text) throw new Error('Probe text is required');
      const turnId = createHash('sha256').update(idempotencyKey).digest('hex');
      const current = await this.chat(identity);
      if (current.activeTurn?.id === turnId || current.turns.some(t => t.id === turnId)) return;
      client.dispatch(identity.chatId!, { type: 'chat/turnStarted' as ActionType.ChatTurnStarted, turnId, startedAt: new Date().toISOString(),
        message: { text: payload.text, origin: { kind: MessageKind.User } } });
    }
  }
  async quiesce(identity: NativeIdentity): Promise<'stopped' | 'waiting' | 'unknown'> {
    const client = await this.rpc();
    let state = await this.chat(identity);
    if (state.activeTurn) client.dispatch(identity.chatId!, { type: 'chat/turnCancelled' as ActionType.ChatTurnCancelled, turnId: state.activeTurn.id, duration: 0 });
    const until = Date.now() + this.timeoutMs;
    do {
      state = await this.chat(identity);
      if (!state.activeTurn && !state.backgroundWork?.length && !state.queuedMessages?.length && !(state.status & 8)) return 'stopped';
      await delay(10);
    } while (Date.now() < until);
    return 'unknown';
  }
  async open(identity: NativeIdentity): Promise<{ uri?: string }> {
    this.checkIdentity(identity);
    const navigation = this.runtime.navigation;
    if (!navigation) throw new ProbeBlocked('Native UI navigation observer is unavailable');
    if (navigation.hostCommit !== this.versions.hostCommit) throw new ProbeBlocked('Native navigation host commit does not match the connected owner');
    const uri = nativeOpenUri(identity, navigation.hostCommit);
    const observed = await navigation.open(uri, identity);
    if (JSON.stringify(observed) !== JSON.stringify(identity)) throw new ProbeBlocked('Native opening has no independently observed exact session/chat identity');
    return { uri };
  }
  subscribe(onEvent: (event: OwnerEvent) => void) { this.listeners.add(onEvent); return () => { this.listeners.delete(onEvent); }; }
}

export async function probeVsCode(options: ProbeOptions, runtime: ProbeRuntime = {}): Promise<ProbeEvidence> {
  validateContract('ProbeOptions', options);
  const report: ProbeEvidence = { name: `vscode-${options.provider ?? 'copilot'}`, mode: options.mode, status: 'blocked', versions: {}, assertions: [], artifacts: [] };
  const details: { blockers: string[]; identities: NativeIdentity[]; observedActions: string[]; isolation: string; diagnostics: Record<string, unknown> } = {
    blockers: [], identities: [], observedActions: [], diagnostics: {}, isolation: 'UNVERIFIED: lifecycle-only diagnostic; no isolation profile is registered' };
  let owner = new VsCodeProbeOwner(options, runtime);
  let identity: NativeIdentity | undefined;
  const record = (name: string, passed: boolean) => report.assertions.push({ name, passed });
  try {
    if (options.mode === 'live') await assertLiveScratch(options);
    await owner.ensureStarted();
    const capability = await owner.capabilities({ paths: [], tools: [], networkDestinations: [], credentialRefs: [], allowedFinishPolicies: ['result'] });
    if (!capability.ready) throw new ProbeBlocked('Requested provider is unavailable');
    const provider = options.provider ?? 'copilot';
    const start: NativeStart = { idempotencyKey: `native-lifecycle-probe-v1:${resolve(options.outputDir)}`, attemptId: 'probe-v1',
      workspacePath: resolve(options.scratchRepo), baseSha: '0'.repeat(40), fence: 1, profileId: 'scratch-no-tools', task: {
        id: 'probe-task', repositoryId: 'probe-repo', recipeId: 'probe', recipeRevision: '1', tagId: 'probe', source: 'manual',
        title: 'Native lifecycle diagnostic', description: 'Trusted no-tool lifecycle probe', goal: 'Verify exact identity', acceptanceCriteria: ['Native identity remains fixed'],
        skills: [], tools: [], context: {}, finishPolicy: 'result', ownerId: 'vscode', providerId: provider,
        required: { paths: [], tools: [], networkDestinations: [], credentialRefs: [], allowedFinishPolicies: ['result'] },
      } };
    identity = await owner.ensureSession(start);
    record('provider-schema-discovery', true);
    details.identities.push(identity);
    record('create', true);
    try { await owner.open(identity); record('native-open', true); }
    catch (error) { if (!(error instanceof ProbeBlocked)) throw error; details.blockers.push(error.message); record('native-open', false); }
    await owner.send(identity, { text: 'Trusted lifecycle diagnostic. Use only the built-in ask_user input mechanism to ask a free-text question with no choices: May the diagnostic continue? Then wait for the answer. Do not use any filesystem, shell, network, or other tools; do not read or change files.' }, runtime.inputIdempotencyKey ?? (runtime.allowNativeAskUser ? 'probe-first-ask-user-v1' : 'probe-first'));
    const until = Date.now() + owner.timeoutMs;
    let snapshot = await owner.snapshot(identity);
    while (snapshot.state !== 'waiting' && Date.now() < until) { await delay(10); snapshot = await owner.snapshot(identity); }
    if (!snapshot.inputs[0]) throw new ProbeBlocked('Native structured input was not observed');
    const nativeInput = snapshot.inputs[0];
    const answers: Record<string, ChatInputAnswer> = {};
    if (runtime.allowNativeAskUser) {
      const schema = nativeInput.schema as { questions: ChatInputQuestion[]; purpose?: string };
      if (schema.purpose !== 'askUser') throw new ProbeBlocked('Native input is not classified as built-in ask_user');
      for (const question of schema.questions) {
        if (question.kind === 'text') answers[question.id] = { state: 'submitted', value: { kind: 'text', value: 'Continue this diagnostic only. Do not use filesystem, shell, or network tools. Reply READY.' } } as ChatInputAnswer;
        else if (question.kind === 'single-select') {
          const option = question.options.find(o => /^(yes|continue|proceed)$/i.test(o.id));
          if (!option) throw new ProbeBlocked('Native diagnostic input has no recognized safe answer');
          answers[question.id] = { state: 'submitted', value: { kind: 'selected', value: option.id } } as ChatInputAnswer;
        } else throw new ProbeBlocked('Native diagnostic input question kind is unsupported');
      }
    }
    await owner.send(identity, { requestId: nativeInput.id, response: runtime.allowNativeAskUser ? 'accept' : 'decline', ...(runtime.allowNativeAskUser ? { answers } : {}) }, 'probe-input');
    record('send-input', true);
    if (await owner.quiesce(identity) !== 'stopped') throw new ProbeBlocked('Cancellation did not establish quiescence');
    record('pause', true);
    await owner.send(identity, { text: 'Continue the trusted no-tool diagnostic in this exact chat. Do not use tools. Reply only READY.' }, 'probe-continuation');
    record('resume', (await owner.chat(identity)).activeTurn !== undefined);
    if (await owner.quiesce(identity) !== 'stopped') throw new ProbeBlocked('Continuation did not stop');
    Object.assign(details.diagnostics, owner.diagnostics);
    Object.assign(report.versions, owner.versions);
    details.observedActions.push(...owner.actionTypes);
    if (owner.unexpectedToolActivity) details.observedActions.push('UNEXPECTED_TOOL_ACTIVITY');
    await owner.close();
    owner = new VsCodeProbeOwner(options, runtime);
    const restored = await owner.ensureSession(start);
    details.identities.push(restored);
    record('restart-reconcile', JSON.stringify(restored) === JSON.stringify(identity));
    try { await owner.open(restored); }
    catch (error) { if (!(error instanceof ProbeBlocked)) throw error; details.blockers.push(error.message); }
    record('quiescence', await owner.quiesce(restored) === 'stopped');
    report.status = report.assertions.every(a => a.passed) && !details.blockers.length ? 'passed' : 'blocked';
  } catch (error) {
    report.status = error instanceof ProbeBlocked || error instanceof RpcTimeoutError || error instanceof TransportError ? 'blocked' : 'failed';
    const blocker = error instanceof TransportError && error.cause instanceof ProbeBlocked ? error.cause : error;
    details.blockers.push(blocker instanceof ProbeBlocked ? blocker.message : `Native protocol/identity failure: ${error instanceof Error ? error.name : 'unknown'} (${String((error as { code?: unknown }).code ?? 'no-code')})`);
  } finally {
    if (identity) {
      try {
        const stopped = await owner.quiesce(identity) === 'stopped';
        const existing = report.assertions.find(a => a.name === 'quiescence');
        if (existing) existing.passed = stopped; else record('quiescence', stopped);
        if (!stopped) { report.status = 'blocked'; details.blockers.push('Final quiescence unproven'); }
      }
      catch { report.status = 'blocked'; details.blockers.push('Final native cleanup could not be established'); }
    }
    for (const required of ['provider-schema-discovery', 'create', 'native-open', 'send-input', 'pause', 'resume', 'restart-reconcile', 'quiescence']) {
      if (!report.assertions.some(a => a.name === required)) record(required, false);
    }
    Object.assign(details.diagnostics, owner.diagnostics);
    Object.assign(report.versions, owner.versions);
    details.observedActions.push(...owner.actionTypes);
    if (owner.unexpectedToolActivity) details.observedActions.push('UNEXPECTED_TOOL_ACTIVITY');
    await owner.close();
  }
  return writeEvidence(options.outputDir, report, details);
}
