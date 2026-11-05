import { randomBytes } from 'node:crypto';
import type { RootState, ActionType } from '@microsoft/agent-host-protocol';
import { setTimeout as delay } from 'node:timers/promises';
import type { NativeStart, TaskSpec } from '../contracts/domain.ts';
import type { NativeBoundary } from '../isolation/profiles.ts';
import { denialChecks } from '../isolation/profiles.ts';
import { verifyNativeStateMount } from '../isolation/native-state.ts';
import { canonical, ensure, fingerprint } from '../storage/database.ts';
import type { VsCodeOwner } from './vscode.ts';
import type { FactoryToolGate } from './tools.ts';
import type { IsolatedToolWorker } from './worker.ts';
import type { createManagedVsCodeLauncher } from './managed.ts';
import { MODEL_PROXY_URL, inspectModelProxy, type NativeModelProxyControl } from './model-proxy.ts';
import type { DockerPort } from '../kestra/deployment.ts';
export function isolatedToolAllowlist(task: TaskSpec): string[] {
  ensure(task.providerId === 'copilot' && task.skills.length === 0 && task.required.networkDestinations.length === 0 && task.required.credentialRefs.length === 0
    && task.required.tools.every(tool => ['native-files','native-terminal'].includes(tool)) && task.tools.every(tool => task.required.tools.includes(tool)), 'isolated_tools', 'Unsupported isolated worker capabilities');
  const tools = ['custom:sf_factory_operation'];
  if (task.required.tools.includes('native-files')) { tools.push('custom:sf_read_file'); if (task.required.paths.some(p => p.mode === 'write')) tools.push('custom:sf_write_file'); }
  if (task.required.tools.includes('native-terminal')) tools.push('custom:sf_terminal');
  return tools.sort();
}
/** Composite evidence retains both runtime identities. The repo is mounted ONLY in the worker;
 * the pristine AgentHost CWD is a logical native navigation location, not a repository filesystem view. */
export function createIsolatedNativeBoundary(options: {
  owner: VsCodeOwner; gate: FactoryToolGate; worker: IsolatedToolWorker;
  launcher: ReturnType<typeof createManagedVsCodeLauncher>; docker: DockerPort;
  modelProxy: NativeModelProxyControl; image: string; networks: string[]; protectedPaths: string[];
}): NativeBoundary & { prepare(start: NativeStart, key: string, authenticate: () => Promise<void>): Promise<void>; prepareHuman(start: NativeStart, authenticate: () => Promise<void>, assertCurrent: () => void, configure?: boolean): Promise<void> } {
  const root = async () => { const value = await (await options.owner.rpc()).subscribe('ahp-root://'); await value.subscription.close(); return value.result.snapshot?.state as RootState; };
  const policy = (start: NativeStart) => ({ '*': { availableTools: isolatedToolAllowlist(start.task), excludedTools: ['builtin:*','mcp:*'] } });
  async function assertPolicy(start: NativeStart) {
    const state = await root(); options.owner.requireModelAuthentication(start.task.providerId);
    ensure(state.config?.schema.properties.modelCapabilityOverrides?.type === 'object' && canonical(state.config.values.modelCapabilityOverrides) === canonical(policy(start))
      && state.config.values['http.proxy'] === MODEL_PROXY_URL && canonical(state.config.values['http.noProxy']) === canonical([]) && state.config.values.systemProxyEnabled === false,
    'isolated_policy', 'Observed native default-deny client-tool/model transport policy changed');
  }
  async function inspectNative(start: NativeStart) {
    const launcher = options.launcher; const process = await launcher.inspect();
    const c = JSON.parse(await options.docker.command(['container','inspect', launcher.options.containerId]))[0];
    const h = c?.HostConfig; const state = await verifyNativeStateMount(launcher.options.nativeState, start.task.id, launcher.options.nativeStateOwnership);
    ensure(c?.Id === process.runtimeId && c.Config.Image === options.image && canonical(c.Mounts.map((m: any) => ({ source: m.Source, target: m.Destination, writable: m.RW }))) === canonical([state])
      && c.Mounts.every((m: any) => m.Type === 'bind') && c.Config.WorkingDir === '/workspaces/task'
      && canonical(c.Config.Env) === canonical(['PATH=/usr/local/bin:/usr/bin:/bin','HOME=/opt/software-factory/empty-home','LANG=C.UTF-8','SF_CONTROL_SENTINEL=sf-nonsecret-control-sentinel'])
      && h.ReadonlyRootfs && !h.Privileged && canonical(h.CapDrop) === canonical(['ALL']) && !h.CapAdd?.length && canonical(h.SecurityOpt) === canonical(['no-new-privileges'])
      && !h.PidMode && (!h.IpcMode || h.IpcMode === 'private') && !h.Devices?.length && !h.DeviceRequests?.length && !h.VolumesFrom?.length && !h.ExtraHosts?.length && !h.Dns?.length
      && !Object.keys(h.PortBindings ?? {}).length && h.RestartPolicy?.Name === 'no' && h.AutoRemove === false && h.PidsLimit > 0 && h.Memory > 0 && h.NanoCpus > 0
      && canonical(Object.values(c.NetworkSettings.Networks).map((n: any) => n.NetworkID).sort()) === canonical([...options.networks].sort()), 'isolated_native', 'Native host must retain only pristine image/CWD/home and its own private state');
    const clean = JSON.parse(await options.docker.command(['exec', c.Id, 'node', '-e', `const fs=require('node:fs');const paths=['/workspaces/task','/opt/software-factory/empty-home'];console.log(JSON.stringify(paths.every(p=>fs.readdirSync(p).length===0&&!(fs.statSync(p).mode&0o222))))`]));
    ensure(clean === true, 'isolated_discovery', 'Native startup discovery roots must be empty immutable image directories');
    const proxy = await inspectModelProxy(options.modelProxy, start, c.Id);
    return { process, state, proxy };
  }
  async function controls(start: NativeStart, authenticate: () => Promise<void>, assertCurrent: () => void) {
      isolatedToolAllowlist(start.task);
      assertCurrent(); await options.owner.ensureStarted();
      assertCurrent(); await inspectNative(start);
      const state = await root();
      ensure(state.config?.schema.properties.modelCapabilityOverrides?.type === 'object' && state.config.schema.properties['http.proxy']?.type === 'string'
        && state.config.schema.properties['http.noProxy']?.type === 'array' && state.config.schema.properties.systemProxyEnabled?.type === 'boolean', 'isolated_policy', 'Native policy schema unsupported');
      (await options.owner.rpc()).dispatch('ahp-root://', { type: 'root/configChanged' as ActionType.RootConfigChanged, config: { modelCapabilityOverrides: policy(start), 'http.proxy': MODEL_PROXY_URL, 'http.noProxy': [], systemProxyEnabled: false } });
      assertCurrent(); await authenticate();
      const deadline = Date.now() + options.owner.timeoutMs;
      while (true) { try { await assertPolicy(start); break; } catch (error) { if (Date.now() >= deadline) throw error; await delay(10); } }
      assertCurrent();
  }
  const boundary: NativeBoundary & { prepare(start: NativeStart, key: string, authenticate: () => Promise<void>): Promise<void>; prepareHuman(start: NativeStart, authenticate: () => Promise<void>, assertCurrent: () => void, configure?: boolean): Promise<void> } = {
    async prepare(start, key, authenticate) {
      await controls(start, authenticate, () => { options.gate.nativeIdentity(start); });
      options.gate.prepare(start, key);
    },
    async prepareHuman(start, authenticate, assertCurrent, configure = true) {
      ensure(options.gate.isSuspended(), 'isolated_human', 'Factory gate must remain suspended');
      if (configure) await controls(start, authenticate, assertCurrent); else { assertCurrent(); await assertPolicy(start); }
      const before=await inspectNative(start); assertCurrent();
      await options.worker.challenge(start,randomBytes(24).toString('base64url'),[...options.protectedPaths,options.launcher.options.nativeState.source,options.launcher.options.nativeState.target]);
      assertCurrent(); await assertPolicy(start);
      ensure(canonical(before)===canonical(await inspectNative(start)),'isolated_human','Human runtime epoch changed during verification');
      assertCurrent();
    },
    async inspect(start) {
      ensure(canonical(options.gate.currentStart()) === canonical(start), 'isolated_binding', 'Current admitted binding required');
      await assertPolicy(start); const native = await inspectNative(start); const worker = await options.worker.inspect(start);
      return { runtimeId: native.process.runtimeId, processIdentity: fingerprint({ native: native.process.processIdentity, worker: worker.processIdentity, workerRuntime: worker.runtimeId, proxy: native.proxy }),
        ownerId: start.task.ownerId, providerId: start.task.providerId, image: options.image,
        mounts: [...worker.mounts, native.state], networks: options.networks, tools: [...start.task.required.tools], credentialRefs: [], networkDestinations: [], protectedPaths: options.protectedPaths,
        unapprovedToolsDenied: true, alternateEgressDenied: true, metadataProtected: true };
    },
    async challenge(start, nonce, protectedPaths) {
      const before = await boundary.inspect(start);
      await options.worker.challenge(start, nonce, [...protectedPaths, options.launcher.options.nativeState.source, options.launcher.options.nativeState.target]);
      const after = await boundary.inspect(start);
      ensure(canonical(before) === canonical(after), 'isolated_epoch', 'Native/worker/proxy epoch changed during challenge');
      return { nonce, runtimeId: before.runtimeId, processIdentity: before.processIdentity, denied: true, checks: denialChecks };
    },
  };
  return boundary;
}
