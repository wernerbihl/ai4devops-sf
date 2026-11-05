import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { ActionType, RootState, TerminalState, TerminalClaimKind } from '@microsoft/agent-host-protocol';
import type { NativeStart } from '../contracts/domain.ts';
import type { NativeToolBoundary, NativeToolSettings } from '../isolation/docker.ts';
import { denialChecks } from '../isolation/profiles.ts';
import { resolveNativeMounts, pathContains, type NativeMountTarget } from '../isolation/mounts.ts';
import { verifyNativeStateMount } from '../isolation/native-state.ts';
import { resolveProtectedPaths } from '../isolation/paths.ts';
import { canonical, ensure } from '../storage/database.ts';
import { factoryClientId, type VsCodeOwner } from './vscode.ts';
import type { FactoryToolGate } from './tools.ts';
import { nativeProcessIdentity, type createManagedVsCodeLauncher, type NativeProcess } from './managed.ts';
import { MODEL_PROXY_URL, inspectModelProxy, type NativeModelProxyControl, type ModelProxyInspection } from './model-proxy.ts';
import { nativeCanaryProgram } from './canary.ts';
import { nativeToolAllowlist } from './toolkits.ts';
interface CanaryResult {
    nonce: string;
    native: NativeProcess;
    workspaceControl: boolean;
    workspaceReadable: boolean;
    workspaceWriteDenied: boolean;
    paths: string[];
    pathsDenied: boolean;
    metadataDenied: boolean;
    ipv4Denied: boolean;
    ipv6Denied: boolean;
    alternateDnsDenied: boolean;
    defaultDnsDenied: boolean;
    modelProxyDenied: boolean;
    modelProxyReachable: boolean;
}
/** Concrete closed native/client-tool boundary. Only managed Linux Copilot currently has the source-pinned controls. */
export function createVsCodeNativeToolBoundary(options: {
    owner: VsCodeOwner;
    gate: FactoryToolGate;
    launcher: ReturnType<typeof createManagedVsCodeLauncher>;
    protectedPaths: string[];
    mountTargets?: readonly NativeMountTarget[];
    modelProxy?: NativeModelProxyControl;
}): NativeToolBoundary & {
    prepareModelTransport(start: NativeStart): Promise<void>;
} {
    let receipt: {
        processIdentity: string;
        runtimeId: string;
        attemptId: string;
        fence: number;
        result: CanaryResult;
        proxy: ModelProxyInspection;
    } | undefined;
    const { owner, gate, launcher } = options;
    ensure(options.protectedPaths.some(p => pathContains(p, owner.metadataDirectory)), 'owner_boundary', 'Owner journal metadata directory must be protected');
    async function root() { const { result, subscription } = await (await owner.rpc()).subscribe('ahp-root://'); await subscription.close(); ensure(result.snapshot?.resource === 'ahp-root://', 'owner_boundary', 'Missing native root snapshot'); return result.snapshot.state as RootState; }
    function policy(start: NativeStart) {
        ensure(start.task.providerId === 'copilot', 'owner_boundary', 'No verified managed Codex tool policy is registered');
        // Native model authentication remains host-owned. General worker networking/credentials need a separate verified profile implementation.
        ensure(start.task.required.networkDestinations.length === 0 && start.task.required.credentialRefs.length === 0, 'owner_boundary', 'Managed worker network/credential grants are not provisioned');
        return { '*': { availableTools: nativeToolAllowlist(start.task), excludedTools: ['mcp:*'] } };
    }
    async function assertPolicy(start: NativeStart) { const state = await root(); owner.requireModelAuthentication(start.task.providerId); ensure(state.config?.values['http.proxy'] === MODEL_PROXY_URL && canonical(state.config.values['http.noProxy']) === canonical([]) && state.config.values.systemProxyEnabled === false, 'owner_model_proxy', 'Native model proxy root configuration was not observed'); ensure(state.config?.schema.properties.modelCapabilityOverrides?.type === 'object' && canonical(state.config.values.modelCapabilityOverrides) === canonical(policy(start)), 'owner_boundary', 'Effective native tool policy changed or was not applied'); }
    async function fixedCanary(start: NativeStart, nonce: string, protectedPaths: readonly string[]): Promise<CanaryResult> {
        ensure(/^[A-Za-z0-9_-]{16,128}$/.test(nonce) && protectedPaths.length >= 3, 'owner_canary', 'Invalid fixed native canary targets');
        const client = await owner.rpc();
        const channel = `ahp-terminal:/sf-boundary-${nonce}`;
        const mounts = await resolveNativeMounts(start, options.mountTargets);
        const workspace = mounts.find(m => m.source === start.workspacePath)!;
        await verifyNativeStateMount(launcher.options.nativeState, start.task.id, launcher.options.nativeStateOwnership);
        const input = { nonce, modelProxyUrl: MODEL_PROXY_URL, modelAuthority: options.modelProxy!.policy.allowedAuthorities[0], workspacePath: workspace.target, workspaceWritable: workspace.writable, controlPath: launcher.options.nativeState.target, protectedPaths: [...protectedPaths], entrypoint: launcher.options.entrypoint };
        const command = `node -e 'eval(Buffer.from("${Buffer.from(nativeCanaryProgram).toString('base64')}","base64").toString())' '${Buffer.from(JSON.stringify(input)).toString('base64')}'\n`;
        let created = false;
        try {
            await client.request('createTerminal', { channel, claim: { kind: 'client' as TerminalClaimKind.Client, clientId: factoryClientId }, name: 'Software Factory fixed boundary verification', cwd: pathToFileURL(input.controlPath).href });
            created = true;
            const initial = await client.subscribe(channel);
            await initial.subscription.close();
            client.dispatch(channel, { type: 'terminal/input' as ActionType.TerminalInput, data: command });
            const deadline = Date.now() + Math.max(owner.timeoutMs, 5000);
            do {
                const { result, subscription } = await client.subscribe(channel);
                await subscription.close();
                const state = result.snapshot?.state as TerminalState | undefined;
                ensure(state?.claim.kind === 'client' && state.claim.clientId === factoryClientId, 'owner_canary', 'Native canary terminal ownership changed');
                const output = state.content.map(p => p.type === 'command' ? p.output : p.value).join('');
                const match = output.match(new RegExp(`(?:^|[\\r\\n])SF_CANARY_${nonce}=([A-Za-z0-9+/=]+)(?:[\\r\\n]|$)`));
                if (match) {
                    const value = JSON.parse(Buffer.from(match[1]!, 'base64').toString('utf8')) as CanaryResult;
                    ensure(value.nonce === nonce && canonical(value.paths) === canonical(protectedPaths), 'owner_canary', 'Native canary receipt provenance/targets mismatch');
                    return value;
                }
                await delay(20);
            } while (Date.now() < deadline);
            throw new Error('Native terminal canary did not produce a bounded receipt');
        }
        finally {
            if (created)
                await client.request('disposeTerminal', { channel });
        }
    }
    async function challenge(start: NativeStart, nonce: string, protectedPaths: readonly string[]) {
        ensure(canonical({ ...gate.currentStart(), idempotencyKey: '' }) === canonical({ ...start, idempotencyKey: '' }), 'owner_binding', 'Native boundary is bound to another reservation');
        await assertPolicy(start);
        const before = await launcher.inspect();
        const proxyBefore = await inspectModelProxy(options.modelProxy, start, before.runtimeId);
        const result = await fixedCanary(start, nonce, protectedPaths);
        const after = await launcher.inspect();
        ensure(canonical(before) === canonical(after) && nativeProcessIdentity(result.native) === before.processIdentity && result.workspaceControl && result.workspaceReadable && result.workspaceWriteDenied === !(await resolveNativeMounts(start, options.mountTargets)).find(m => m.source === start.workspacePath)!.writable && result.pathsDenied && result.metadataDenied && result.ipv4Denied && result.ipv6Denied && result.alternateDnsDenied && result.defaultDnsDenied && result.modelProxyDenied && result.modelProxyReachable && canonical(proxyBefore) === canonical(await inspectModelProxy(options.modelProxy, start, after.runtimeId)), 'owner_canary', 'Actual native process, protected paths or alternate-egress denial canary failed');
        // Same closed entry point as AHP client tool execution, with fixed harmless inputs only.
        const identity = { ownerId: start.task.ownerId, providerId: start.task.providerId, sessionId: 'ahp-session:/boundary', chatId: 'ahp-chat:/boundary' };
        for (const path of protectedPaths)
            for (const name of ['resourceRead', 'resourceWrite', 'metadata.write']) {
                let denied = false;
                try {
                    await gate.invoke(identity, nonce, name, { path });
                }
                catch {
                    denied = true;
                }
                ensure(denied, 'owner_canary', 'Native client path bypass detected');
            }
        for (const name of ['shell', 'fetch', 'dns', 'external-tool']) {
            let denied = false;
            try {
                await gate.invoke(identity, nonce, name, { target: 'fixed-denial-check' });
            }
            catch {
                denied = true;
            }
            ensure(denied, 'owner_canary', 'External native client tool bypass detected');
        }
        await assertPolicy(start);
        ensure(canonical({ ...gate.currentStart(), idempotencyKey: '' }) === canonical({ ...start, idempotencyKey: '' }), 'owner_binding', 'Native binding changed during challenge');
        receipt = { runtimeId: before.runtimeId, processIdentity: before.processIdentity, attemptId: start.attemptId, fence: start.fence, result, proxy: proxyBefore };
        return { nonce, runtimeId: before.runtimeId, processIdentity: before.processIdentity, denied: true, checks: denialChecks };
    }
    async function prepareModelTransport(start: NativeStart): Promise<void> {
        const actual = await launcher.inspect();
        await inspectModelProxy(options.modelProxy, start, actual.runtimeId);
        const identity = gate.nativeIdentity?.(start);
        if (identity) {
            const state = await owner.chat(identity);
            ensure(!state.activeTurn && !state.backgroundWork?.length && !state.queuedMessages?.length && !(state.status & 8), 'owner_binding', 'Native runtime must be quiescent before model transport preparation');
        }
        const config = (await root()).config;
        ensure(config?.schema.properties['http.proxy']?.type === 'string' && config.schema.properties['http.noProxy']?.type === 'array' && config.schema.properties.systemProxyEnabled?.type === 'boolean', 'owner_model_proxy', 'Native host did not advertise supported proxy configuration');
        const matches = (state: RootState) => state.config?.values['http.proxy'] === MODEL_PROXY_URL && canonical(state.config.values['http.noProxy']) === canonical([]) && state.config.values.systemProxyEnabled === false;
        if (!matches(await root())) {
            ensure(!identity, 'owner_model_proxy', 'Existing native session model transport cannot be replaced');
            (await owner.rpc()).dispatch('ahp-root://', { type: 'root/configChanged' as ActionType.RootConfigChanged, config: { 'http.proxy': MODEL_PROXY_URL, 'http.noProxy': [], systemProxyEnabled: false } });
            const deadline = Date.now() + owner.timeoutMs;
            while (Date.now() < deadline) {
                if (matches(await root()))
                    return;
                await delay(10);
            }
            throw new Error('Native model proxy configuration was not observed');
        }
    }
    return { prepareModelTransport, async prepareBinding(start, key) {
            receipt = undefined;
            await prepareModelTransport(start);
            const runtime = await launcher.inspect();
            await inspectModelProxy(options.modelProxy, start, runtime.runtimeId);
            owner.requireModelAuthentication(start.task.providerId);
            policy(start);
            const identity = gate.nativeIdentity?.(start);
            if (identity) {
                const state = await owner.chat(identity);
                ensure(!state.activeTurn && !state.backgroundWork?.length && !state.queuedMessages?.length && !(state.status & 8), 'owner_binding', 'Native runtime must already be quiescent before rebinding');
            }
            const state = await root();
            ensure(state.config?.schema.properties.modelCapabilityOverrides?.type === 'object' && state.config.schema.properties['http.proxy']?.type === 'string' && state.config.schema.properties['http.noProxy']?.type === 'array' && state.config.schema.properties.systemProxyEnabled?.type === 'boolean', 'owner_boundary', 'Native provider did not advertise the required tool control');
            if (canonical(state.config.values.modelCapabilityOverrides) !== canonical(policy(start)) || state.config.values['http.proxy'] !== MODEL_PROXY_URL || canonical(state.config.values['http.noProxy']) !== canonical([]) || state.config.values.systemProxyEnabled !== false) {
                ensure(!identity, 'owner_boundary', 'Existing native session tool policy cannot be changed during rebinding');
                (await owner.rpc()).dispatch('ahp-root://', { type: 'root/configChanged' as ActionType.RootConfigChanged, config: { modelCapabilityOverrides: policy(start), 'http.proxy': MODEL_PROXY_URL, 'http.noProxy': [], systemProxyEnabled: false } });
                const deadline = Date.now() + owner.timeoutMs;
                while (Date.now() < deadline) {
                    try {
                        await assertPolicy(start);
                        break;
                    }
                    catch {
                        await delay(10);
                    }
                }
            }
            await assertPolicy(start);
            gate.prepare(start, key);
            await challenge(start, randomBytes(24).toString('base64url'), await resolveProtectedPaths(options.protectedPaths));
        }, async inspect(start): Promise<NativeToolSettings> {
            ensure(canonical({ ...gate.currentStart(), idempotencyKey: '' }) === canonical({ ...start, idempotencyKey: '' }), 'owner_binding', 'Native runtime is not bound to this attempt');
            const binding = gate.binding();
            const actual = await launcher.inspect();
            await assertPolicy(start);
            const proxy = await inspectModelProxy(options.modelProxy, start, actual.runtimeId);
            ensure(receipt && receipt.attemptId === binding.attemptId && receipt.fence === binding.fence && receipt.runtimeId === actual.runtimeId && receipt.processIdentity === actual.processIdentity && canonical(receipt.proxy) === canonical(proxy), 'owner_boundary', 'Native boundary requires current actual process canary proof');
            return { ...binding, runtimeId: actual.runtimeId, processIdentity: actual.processIdentity, ownerId: start.task.ownerId, providerId: start.task.providerId, tools: [...start.task.required.tools], credentialRefs: [], networkDestinations: [], unapprovedToolsDenied: true, alternateEgressDenied: receipt.result.ipv4Denied && receipt.result.ipv6Denied && receipt.result.alternateDnsDenied && receipt.result.defaultDnsDenied, metadataProtected: receipt.result.metadataDenied };
        }, challenge };
}
