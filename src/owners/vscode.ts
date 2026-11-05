import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AhpClient, RpcError, type AhpTransport } from '@microsoft/agent-host-protocol/client';
import { MessageKind, type ActionType, type ChatState, type RootState, type SessionState, type ToolDefinition } from '@microsoft/agent-host-protocol';
import type { NativeOwner } from '../contracts/owner.ts';
import type { CapabilityReport, NativeIdentity, NativeSnapshot, NativeStart, OwnerEvent, OwnerReadiness, ProfileEvidence, ProviderId, RequiredCapabilities } from '../contracts/domain.ts';
import { validateContract } from '../contracts/schemas.ts';
import { canonical, ensure } from '../storage/database.ts';
import { requireVerifiedProfile } from '../isolation/verify.ts';
import { nativeInputSchema, nativeInputReply, pendingNativeInput } from './input.ts';
import { connectAhp, type AhpEndpoint } from './ahp.ts';
import { OwnerJournal, digest, type SessionIntent } from './journal.ts';
import { createNativeNavigation, nativeOpenUri, navigationCommits, type NativeNavigation } from './navigation.ts';
export const factoryClientId = 'software-factory';
export interface VsCodeCompatibility {
    protocol: '1.0.0';
    commits: readonly string[];
}
export interface ManagedOwnerLauncher {
    /** Must stop every contained process and inspect the kernel runtime state. */
    stop?(): Promise<void>;
    stopped?(): Promise<boolean>;
    pause?(): Promise<void>;
    paused?(): Promise<boolean>;
    ensureStarted(): Promise<AhpEndpoint | {
        connect: () => Promise<AhpTransport>;
    }>;
}
export interface NativeClientTools {
    definitions: ToolDefinition[];
    /** Trusted dispatch context, never accepted from the model's tool input. */
    invoke(identity: NativeIdentity, callId: string, name: string, input: unknown): Promise<Record<string, unknown>>;
}
export interface VsCodeOptions {
    ownerId?: string;
    journalPath: string;
    journalProtection?: object;
    endpoint?: AhpEndpoint;
    launcher?: ManagedOwnerLauncher;
    /** Trusted transport injection also supports owning-OS relays; default is authenticated IPC. */
    connect?: () => Promise<AhpTransport>;
    timeoutMs?: number;
    compatibility?: VsCodeCompatibility;
    requireVerifiedProfile?: (start: NativeStart) => Promise<ProfileEvidence>;
    /** Current provisioned scopes only; final dispatch independently verifies again. */
    readinessStarts?: (required: RequiredCapabilities) => Promise<readonly NativeStart[]>;
    workspaceUri?: (path: string) => Promise<string>;
    navigation?: NativeNavigation;
    tools?: NativeClientTools;
}
const workspaceKey = (uri: string) => { const u = new URL(uri); return `${u.protocol}//${u.host}${decodeURIComponent(u.pathname).replace(/^\/([A-Z]):/, (_, drive: string) => `/${drive.toLowerCase()}:`)}`; };
const nativeActive = (state: ChatState) => !!state.activeTurn || !!state.backgroundWork?.length || !!state.queuedMessages?.length || !!(state.status & 8);
const missing = (error: unknown) => error instanceof RpcError && error.code === -32001;
export function createVsCodeOwner(options: VsCodeOptions): VsCodeOwner { return new VsCodeOwner(options); }
/** Real native conversations from their first allocation; never imports provider SDK sessions. */
export class VsCodeOwner implements NativeOwner {
    readonly ownerId: string;
    readonly timeoutMs: number;
    readonly metadataDirectory: string;
    private closed = false;
    private intentionalStop = false;
    private humanOpen: {
        identity: NativeIdentity;
        assertCurrent: () => void;
    } | undefined;
    private authentications = new Map<ProviderId, {
        resource: string;
        expiresAt: number;
    }>();
    private readonly options: VsCodeOptions;
    private readonly journal: OwnerJournal;
    private client: AhpClient | undefined;
    private root: RootState | undefined;
    private starting: Promise<void> | undefined;
    private version = 'unavailable';
    private commit = '';
    private listeners = new Set<(event: OwnerEvent) => void>();
    private identities = new Map<string, NativeIdentity>();
    private processing = new Map<string, Promise<void>>();
    private serial: Promise<unknown> = Promise.resolve();
    constructor(options: VsCodeOptions) { this.options = options; this.metadataDirectory = dirname(resolve(options.journalPath)); this.ownerId = options.ownerId ?? 'vscode'; this.timeoutMs = options.timeoutMs ?? 15000; this.journal = new OwnerJournal(options.journalPath,options.journalProtection); }
    async ensureStarted(): Promise<void> {
        ensure(!this.closed, 'owner_closed', 'Native owner is closed');
        if (this.client && this.root)
            return;
        if (!this.starting)
            this.starting = this.connect().finally(() => { this.starting = undefined; });
        return this.starting;
    }
    private async connect() {
        let connector = this.options.connect;
        if (!connector) {
            let endpoint = this.options.endpoint;
            if (!endpoint && this.options.launcher) {
                const launched = await this.options.launcher.ensureStarted();
                if ('connect' in launched)
                    connector = launched.connect;
                else
                    endpoint = launched;
            }
            ensure(connector || endpoint, 'owner_endpoint', 'Configure an authenticated native endpoint or managed launcher');
            if (!connector)
                connector = () => connectAhp(endpoint!);
        }
        this.authentications.clear();
        const client = new AhpClient(await connector(), { requestTimeoutMs: this.timeoutMs });
        // No host filesystem/network/credential service is exported to the native process.
        client.setResourceRequestHandlers({});
        const events = client.events();
        client.connect();
        try {
            const init = await client.request('initialize', { channel: 'ahp-root://', clientId: factoryClientId, protocolVersions: ['1.0.0'], initialSubscriptions: ['ahp-root://'], clientInfo: { name: 'software-factory', version: '0.1.0' }, _meta: { 'vscode.ahpSessionUris': true, 'vscode.ahpChatUris': true } });
            const root = init.snapshots.find(s => s.resource === 'ahp-root://')?.state as RootState | undefined;
            const build = root?._meta?.hostBuild as {
                commit?: string;
            } | undefined;
            const compatibility = this.options.compatibility ?? { protocol: '1.0.0', commits: navigationCommits };
            ensure(init.protocolVersion === compatibility.protocol && !!build?.commit && compatibility.commits.includes(build.commit), 'owner_version', 'Unsupported native host commit or AHP protocol');
            ensure(Array.isArray(root?.agents), 'owner_provider', 'Native provider discovery unavailable');
            this.intentionalStop = false;
            this.client = client;
            this.root = root;
            this.version = init.protocolVersion;
            this.commit = build.commit;
            void (async () => {
                try {
                    for await (const event of events) {
                        if (event.event.type === 'action') {
                            const id = this.identities.get(event.channel);
                            if (id)
                                this.scheduleObserve(id, client);
                        }
                    }
                }
                catch { /* Connection details can contain credentials; publish a fixed reason. */ }
                finally {
                    if (this.client === client) {
                        this.client = undefined;
                        this.root = undefined;
                        for (const identity of this.identities.values())
                            this.emit({ type: 'connection_lost', identity, reason: 'Native host connection lost', at: new Date().toISOString() });
                    }
                }
            })();
        }
        catch (error) {
            await client.shutdown();
            throw error;
        }
    }
    async rpc(): Promise<AhpClient> { await this.ensureStarted(); return this.client!; }
    private emit(event: OwnerEvent) {
        if (event.type === 'connection_lost' && this.intentionalStop)
            return;
        for (const listener of this.listeners) {
            try {
                listener(event);
            }
            catch { /* A consumer cannot break native control. */ }
        }
    }
    private scheduleObserve(identity: NativeIdentity, source: AhpClient) {
        const key = identity.chatId!;
        const previous = this.processing.get(key) ?? Promise.resolve();
        const next = previous.then(async () => {
            if (this.client !== source)
                return;
            const state = await this.readChat(identity);
            if (this.client !== source)
                return;
            await this.processTools(identity, state, source);
            if (this.client === source)
                this.publish(identity, state);
        }).catch(() => {
            if (this.client === source)
                this.emit({ type: 'connection_lost', identity, reason: 'Native observation failed; reconcile before continuing', at: new Date().toISOString() });
        });
        this.processing.set(key, next);
        void next.finally(() => {
            if (this.processing.get(key) === next)
                this.processing.delete(key);
        });
    }
    /** Trusted E7 provider OAuth delivery only; no token enters journal, model context, or public DTO. */
    async authenticateProvider(provider: ProviderId, credential: {
        resource: string;
        token: string;
        expiresIn?: number;
        scopes?: string[];
    }): Promise<void> {
        await this.ensureStarted();
        const root = await this.read<RootState>('ahp-root://');
        const nativeProvider = provider === 'copilot' ? 'copilotcli' : 'codex';
        const advertised = root.agents.find(a => a.provider === nativeProvider)?.protectedResources?.find(r => r.resource === credential.resource);
        ensure(advertised, 'owner_auth', 'Provider did not advertise this protected resource');
        ensure(!credential.scopes || credential.scopes.every(scope => advertised.scopes_supported?.includes(scope)), 'owner_auth', 'Provider did not advertise the requested credential scopes');
        ensure(credential.token.length > 0 && (credential.expiresIn === undefined || Number.isInteger(credential.expiresIn) && credential.expiresIn > 0), 'owner_auth', 'Provider credential is invalid');
        try {
            await (await this.rpc()).request('authenticate', { channel: 'ahp-root://', ...credential });
        }
        catch {
            throw new Error('Native provider authentication was not accepted');
        }
        this.authentications.set(provider, { resource: credential.resource, expiresAt: Date.now() + Math.min(credential.expiresIn ?? 300, 3600) * 1000 });
        this.root = await this.read<RootState>('ahp-root://');
    }
    requireModelAuthentication(provider: ProviderId): void { const proof = this.authentications.get(provider); ensure(proof && proof.expiresAt > Date.now(), 'owner_auth', 'Managed native provider requires current acknowledged OAuth authentication'); }
    /** Native read-only reconciliation; local immutable receipt binding is safe after an uncertain create. */
    async reconcile(start: NativeStart): Promise<{
        state: 'unknown';
    } | {
        state: 'done';
        identity: NativeIdentity;
    }> {
        validateContract('NativeStart', start);
        const intent = this.journal.find(start.task.ownerId, start.task.id);
        if (!intent)
            return { state: 'unknown' };
        ensure(intent.providerId === start.task.providerId && intent.workspacePath === start.workspacePath && intent.baseSha === start.baseSha, 'owner_identity', 'Original native reconciliation identity conflict');
        try {
            const state = await this.read<SessionState>(intent.sessionId);
            this.verifySession(intent, state);
            const identity = intent.identity ?? (state.defaultChat && state.chats.length === 1 ? { ownerId: intent.ownerId, providerId: intent.providerId, sessionId: intent.sessionId, chatId: state.defaultChat } : undefined);
            if (!identity || !state.chats.some(c => c.resource === identity.chatId))
                return { state: 'unknown' };
            this.journal.bind(intent, identity);
            this.identities.set(identity.chatId!, identity);
            await this.readChat(identity);
            return { state: 'done', identity };
        }
        catch (error) {
            if (missing(error))
                return { state: 'unknown' };
            throw error;
        }
    }
    async reconcileInput(identity: NativeIdentity, input: object, key: string): Promise<'done' | 'unknown'> {
        const state = await this.chat(identity);
        const p = input as {
            text?: string;
            requestId?: string;
            response?: unknown;
            answers?: unknown;
        };
        if (p.requestId) {
            const part = [...(state.activeTurn?.responseParts ?? []), ...state.turns.flatMap(t => t.responseParts)].find(p2 => p2.kind === 'inputRequest' && p2.request.id === p.requestId);
            if (part?.kind !== 'inputRequest')
                return 'unknown';
            const reply = nativeInputReply(part.request, p);
            return part.response === reply.response && Object.entries(reply.answers).every(([id, value]) => canonical(part.request.answers?.[id]) === canonical(value)) ? 'done' : 'unknown';
        }
        const turnId = digest([identity, key]);
        const turn = state.activeTurn?.id === turnId ? state.activeTurn : state.turns.find(t => t.id === turnId);
        return turn && turn.message.text === p.text ? 'done' : 'unknown';
    }
    private async read<T>(channel: string): Promise<T> { const { result, subscription } = await (await this.rpc()).subscribe(channel); await subscription.close(); ensure(result.snapshot?.resource === channel, 'owner_snapshot', 'Missing or mismatched native snapshot'); return result.snapshot.state as T; }
    async nativeSession(identity: NativeIdentity): Promise<SessionState> { const intent = this.journal.owned(identity); const state = await this.read<SessionState>(identity.sessionId); this.verifySession(intent, state); ensure(state.chats.some(c => c.resource === identity.chatId), 'owner_identity', 'Original native chat is missing'); return state; }
    private verifySession(intent: SessionIntent, state: SessionState) { ensure(state.lifecycle !== 'failed', 'owner_failed', 'Native session materialization failed'); ensure(state.provider === (intent.providerId === 'copilot' ? 'copilotcli' : 'codex') && state.workingDirectories?.length === 1 && workspaceKey(state.workingDirectories[0]!) === workspaceKey(intent.directory), 'owner_identity', 'Native provider/workspace identity changed'); }
    private async readChat(identity: NativeIdentity): Promise<ChatState> { this.journal.owned(identity); const state = await this.read<ChatState>(identity.chatId!); ensure(state.resource === identity.chatId, 'owner_identity', 'Native chat identity changed'); return state; }
    async chat(identity: NativeIdentity): Promise<ChatState> {
        await this.nativeSession(identity);
        let state = await this.readChat(identity);
        const seen = new Set<string>();
        while (state.turnsNextCursor) {
            ensure(!seen.has(state.turnsNextCursor), 'owner_history', 'Native history pagination is incomplete');
            seen.add(state.turnsNextCursor);
            await (await this.rpc()).request('fetchTurns', { channel: identity.chatId!, cursor: state.turnsNextCursor });
            state = await this.readChat(identity);
        }
        return state;
    }
    async readiness(required: RequiredCapabilities): Promise<OwnerReadiness> {
        try {
            await this.ensureStarted();
            this.root = await this.read<RootState>('ahp-root://');
        }
        catch {
            return { ownerId: this.ownerId, ready: false, reasons: ['Native host unavailable, unauthenticated or unsupported'], supportedProviders: [], verifiedProfileIds: [], providers: [], version: 'unavailable' };
        }
        const supported = (['copilot', 'codex'] as const).filter(p => this.root!.agents.some(a => a.provider === (p === 'copilot' ? 'copilotcli' : 'codex') && a.models.length > 0));
        const verified = new Map<ProviderId, Set<string>>([['copilot', new Set()], ['codex', new Set()]]);
        for (const start of await this.options.readinessStarts?.(required) ?? []) {
            if (start.task.ownerId !== this.ownerId || !supported.includes(start.task.providerId) || canonical(start.task.required) !== canonical(required))
                continue;
            try {
                const proof = await (this.options.requireVerifiedProfile ?? requireVerifiedProfile)(start);
                this.checkProof(start, proof);
                verified.get(start.task.providerId)!.add(proof.profileId);
            }
            catch { /* A failed effective profile stays unadvertised. */ }
        }
        const providers = (['copilot', 'codex'] as const).map(providerId => { const ids = [...verified.get(providerId)!]; return { providerId, ready: ids.length > 0, reasons: ids.length ? [] : [supported.includes(providerId) ? 'No verified isolated native runtime for the requested capabilities' : 'No authenticated native models available'], verifiedProfileIds: ids }; });
        const verifiedProfileIds = providers.flatMap(p => p.verifiedProfileIds);
        return { ownerId: this.ownerId, ready: verifiedProfileIds.length > 0, reasons: verifiedProfileIds.length ? [] : ['No provider has a verified isolated native runtime'], supportedProviders: supported, verifiedProfileIds, providers, version: this.version };
    }
    async capabilities(required: RequiredCapabilities): Promise<CapabilityReport> { const { ownerId: _id, providers: _providers, ...report } = await this.readiness(required); return report; }
    private checkProof(start: NativeStart, proof: ProfileEvidence) { ensure(proof.profileId === start.profileId && proof.ownerId === start.task.ownerId && proof.providerId === start.task.providerId && canonical(proof.required) === canonical(start.task.required), 'owner_profile', 'Verified profile does not match native authority'); }
    private exclusive<T>(fn: () => Promise<T>): Promise<T> { const next = this.serial.then(fn, fn); this.serial = next.catch(() => { }); return next; }
    async ensureSession(start: NativeStart): Promise<NativeIdentity> {
        return this.exclusive(async () => {
            validateContract('NativeStart', start);
            ensure(start.task.ownerId === this.ownerId, 'owner_identity', 'Native owner mismatch');
            await this.ensureStarted();
            const provider = start.task.providerId === 'copilot' ? 'copilotcli' : 'codex';
            ensure(this.root!.agents.some(a => a.provider === provider && a.models.length > 0), 'owner_provider', 'Native provider has no authenticated model');
            this.checkProof(start, await (this.options.requireVerifiedProfile ?? requireVerifiedProfile)(start));
            const directory = this.options.workspaceUri ? await this.options.workspaceUri(start.workspacePath) : pathToFileURL(resolve(start.workspacePath)).href;
            const { intent, fresh } = this.journal.session(start, directory);
            let state: SessionState;
            try {
                state = await this.read<SessionState>(intent.sessionId);
            }
            catch (error) {
                if (!missing(error))
                    throw error;
                ensure(fresh, 'owner_history_lost', 'Original native session is missing or create outcome unknown; needs attention');
                const config = await (await this.rpc()).request('resolveSessionConfig', { channel: 'ahp-root://', provider, workingDirectory: directory });
                // Host-returned defaults only. Never invent security settings absent from provider schemas.
                const values = Object.fromEntries(Object.entries(config.values).filter(([key]) => Object.hasOwn(config.schema.properties, key)));
                try {
                    await (await this.rpc()).request('createSession', { channel: intent.sessionId, provider, workingDirectories: [directory], config: values });
                }
                catch { /* Reconcile the original URI after any uncertain create; never allocate again. */ }
                try {
                    state = await this.read<SessionState>(intent.sessionId);
                }
                catch {
                    throw new Error('Original native create outcome unknown; needs attention');
                }
            }
            this.verifySession(intent, state);
            ensure(state.defaultChat && state.chats.some(c => c.resource === state.defaultChat), 'owner_identity', 'Native default chat unavailable');
            const identity = intent.identity ?? { ownerId: this.ownerId, providerId: start.task.providerId, sessionId: intent.sessionId, chatId: state.defaultChat };
            ensure(state.chats.some(c => c.resource === identity.chatId), 'owner_history_lost', 'Original native chat is missing; needs attention');
            this.journal.bind(intent, identity);
            this.identities.set(identity.chatId!, identity);
            await this.readChat(identity);
            if (this.options.tools) {
                const client = await this.rpc();
                client.dispatch(identity.sessionId, { type: 'session/activeClientSet' as ActionType.SessionActiveClientSet, activeClient: { clientId: factoryClientId, displayName: 'Software Factory', tools: this.options.tools.definitions } });
                await this.wait(async () => canonical((await this.nativeSession(identity)).activeClients.find(c => c.clientId === factoryClientId)?.tools) === canonical(this.options.tools!.definitions), 'Native client tool registration was not observed');
            }
            this.emit({ type: 'identity', identity, at: new Date().toISOString() });
            return identity;
        });
    }
    private publish(identity: NativeIdentity, state: ChatState): NativeSnapshot {
        const inputs = state.activeTurn?.responseParts.flatMap(p => p.kind === 'inputRequest' && !p.response ? [{ id: p.request.id, prompt: p.request.message ?? 'Native input', schema: nativeInputSchema(p.request) }] : []) ?? [];
        const snapshot: NativeSnapshot = { identity, state: inputs.length ? 'waiting' : nativeActive(state) ? 'active' : 'idle', inputs };
        const at = new Date().toISOString();
        this.emit({ type: 'snapshot', identity, snapshot, at });
        for (const input of inputs)
            this.emit({ type: 'input', identity, input, at });
        this.emit({ type: 'activity', identity, active: nativeActive(state), at });
        return snapshot;
    }
    async snapshot(identity: NativeIdentity): Promise<NativeSnapshot> {
        try {
            return this.publish(identity, await this.chat(identity));
        }
        catch (error) {
            if (!missing(error) && !(error instanceof Error && /Original native chat/.test(error.message)))
                throw error;
            const snapshot: NativeSnapshot = { identity, state: 'lost', inputs: [] };
            this.emit({ type: 'snapshot', identity, snapshot, at: new Date().toISOString() });
            return snapshot;
        }
    }
    async send(identity: NativeIdentity, input: object, idempotencyKey: string): Promise<void> {
        return this.exclusive(async () => {
            const current = await this.chat(identity);
            const payload = input as {
                text?: string;
                requestId?: string;
                response?: unknown;
                answers?: unknown;
            };
            const client = await this.rpc();
            const receipt = this.journal.claim(identity, idempotencyKey, input);
            if (receipt.done)
                return;
            if (payload.requestId) {
                const find = (state: ChatState) => [...(state.activeTurn?.responseParts ?? []), ...state.turns.flatMap(t => t.responseParts)].find(p => p.kind === 'inputRequest' && p.request.id === payload.requestId);
                const part = find(current);
                ensure(part?.kind === 'inputRequest', 'owner_input', 'Native input request not found');
                const { response, answers } = nativeInputReply(part.request, payload);
                ensure(part.response || current.activeTurn?.responseParts.includes(part), 'owner_input', 'Original question is no longer active; cannot restore cancelled history');
                if (!part.response && receipt.fresh)
                    client.dispatch(identity.chatId!, { type: 'chat/inputCompleted' as ActionType.ChatInputCompleted, requestId: payload.requestId, response, answers });
                await this.wait(async () => { const p = find(await this.chat(identity)); return p?.kind === 'inputRequest' && p.response === response && Object.entries(answers).every(([key, value]) => canonical(p.request.answers?.[key]) === canonical(value)); }, 'Exact native input completion was not observed; outcome unknown');
            }
            else {
                ensure(typeof payload.text === 'string' && payload.text.length > 0, 'owner_input', 'Native message text is required');
                const turnId = digest([identity, idempotencyKey]);
                const observed = (state: ChatState) => state.activeTurn?.id === turnId || state.turns.some(t => t.id === turnId);
                if (!observed(current)) {
                    ensure(receipt.fresh, 'owner_send_unknown', 'Previous native send outcome unknown; refusing duplicate dispatch');
                    ensure(!nativeActive(current), 'owner_busy', 'Native turn is still active');
                    client.dispatch(identity.chatId!, { type: 'chat/turnStarted' as ActionType.ChatTurnStarted, turnId, startedAt: new Date().toISOString(), message: { text: payload.text, origin: { kind: MessageKind.User } } });
                    await this.wait(async () => observed(await this.chat(identity)), 'Native turn acknowledgement was not observed; outcome unknown');
                }
            }
            this.journal.done(receipt.id);
        });
    }
    /** Pre-admission eligibility only; never asserts that post-restart native history exists. */
    async stoppedReceipt(identity: NativeIdentity): Promise<{
        identity: NativeIdentity;
        stoppedAt: string;
        mode: 'paused' | 'stopped';
    } | undefined> {
        const frozen = this.journal.paused(identity);
        if (frozen && await this.options.launcher?.paused?.())
            return { ...frozen, mode: 'paused' };
        const receipt = this.journal.stopped(identity);
        return receipt && await this.options.launcher?.stopped?.() ? { ...receipt, mode: 'stopped' } : undefined;
    }
    async quiesce(identity: NativeIdentity): Promise<'stopped' | 'waiting' | 'unknown'> {
        try {
            this.journal.owned(identity);
            const receipt = await this.stoppedReceipt(identity);
            if (receipt)
                return receipt.mode === 'paused' ? 'waiting' : 'stopped';
            try {
                const state = await this.chat(identity);
                if (pendingNativeInput(state)) {
                    if (!this.options.launcher?.pause)
                        return 'unknown';
                    try {
                        await this.options.launcher.pause();
                        this.journal.recordPaused(identity);
                        return 'waiting';
                    }
                    catch {
                        return 'unknown';
                    }
                }
                if (state.activeTurn)
                    (await this.rpc()).dispatch(identity.chatId!, { type: 'chat/turnCancelled' as ActionType.ChatTurnCancelled, turnId: state.activeTurn.id, duration: 0 });
                await this.wait(async () => !nativeActive(await this.chat(identity)), 'Native cancellation was not observed');
            }
            catch { /* Even an unresponsive AHP process must be stopped at the container boundary. */ }
            if (!this.options.launcher?.stop)
                return 'unknown';
            this.intentionalStop = true;
            await this.options.launcher.stop();
            this.journal.recordStopped(identity);
            const client = this.client;
            this.client = undefined;
            this.root = undefined;
            this.authentications.clear();
            await client?.shutdown();
            return 'stopped';
        }
        catch {
            this.intentionalStop = false;
            return 'unknown';
        }
    }
    admitHumanOpen(identity: NativeIdentity, assertCurrent: () => void) { this.journal.owned(identity); assertCurrent(); this.humanOpen = { identity, assertCurrent }; }
    async open(identity: NativeIdentity): Promise<{
        uri?: string;
    }> {
        const admission = this.humanOpen;
        this.humanOpen = undefined;
        ensure(!this.options.launcher || admission && canonical(admission.identity) === canonical(identity), 'owner_navigation', 'Managed native opening requires admitted human control');
        admission?.assertCurrent();
        await this.nativeSession(identity);
        admission?.assertCurrent();
        const navigation = this.options.navigation ?? createNativeNavigation();
        ensure(!this.options.launcher || navigation.connectionAuthority, 'owner_navigation', 'Managed native opening requires its registered connection authority');
        const uri = nativeOpenUri(identity, this.commit, navigation.connectionAuthority);
        admission?.assertCurrent();
        await navigation.launch(uri);
        return { uri };
    }
    subscribe(listener: (event: OwnerEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    private async wait(check: () => Promise<boolean>, message: string) {
        const deadline = Date.now() + this.timeoutMs;
        do {
            if (await check())
                return;
            await delay(5);
        } while (Date.now() < deadline);
        throw new Error(message);
    }
    private async processTools(identity: NativeIdentity, state: ChatState, source: AhpClient) {
        if (!state.activeTurn)
            return;
        const client = await this.rpc();
        if (client !== source)
            return;
        for (const part of state.activeTurn.responseParts) {
            if (part.kind !== 'toolCall')
                continue;
            const tool = part.toolCall;
            if (tool.contributor?.kind !== 'client' || tool.contributor.clientId !== factoryClientId || tool.status !== 'running')
                continue;
            if (this.client !== source)
                return;
            let result: Record<string, unknown>;
            let success = false;
            try {
                ensure(this.options.tools && typeof tool.toolInput === 'string', 'owner_tool', 'Unsupported native client tool');
                result = await this.options.tools.invoke(identity, tool.toolCallId, tool.toolName, JSON.parse(tool.toolInput));
                success = true;
            }
            catch {
                result = { error: 'Factory operation denied or outcome unknown; inspect factory attention' };
            }
            if (this.client !== source)
                return;
            client.dispatch(identity.chatId!, { type: 'chat/toolCallComplete' as ActionType.ChatToolCallComplete, turnId: state.activeTurn.id, toolCallId: tool.toolCallId, result: { success, pastTenseMessage: success ? 'Factory operation recorded' : 'Factory operation refused', structuredContent: result } });
        }
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        const client = this.client;
        this.client = undefined;
        this.root = undefined;
        await client?.shutdown();
        await Promise.all(this.processing.values());
        this.processing.clear();
        this.journal.close();
    }
}
