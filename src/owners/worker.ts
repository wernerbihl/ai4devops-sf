import { imageMatches } from '../isolation/image.ts';
import { hasCapabilityGrants } from '../scheduling/eligibility.ts';
import type { ToolDefinition } from '@microsoft/agent-host-protocol';
import type { NativeIdentity, NativeStart } from '../contracts/domain.ts';
import type { DockerPort } from '../kestra/deployment.ts';
import type { FactoryStore } from '../storage/store.ts';
import type { FactoryToolGate } from './tools.ts';
import type { NativeClientTools } from './vscode.ts';
import { canonical, ensure, fingerprint, systemClock } from '../storage/database.ts';
import { resolveNativeMounts, type NativeMountTarget } from '../isolation/mounts.ts';

export type WorkerOperation = { kind: 'read'; path: string } | { kind: 'write'; path: string; content: string } | { kind: 'terminal'; command: string };
/** Runs only inside the isolated worker. The controller chooses roots/cwd; model input chooses a finite operation. */
import { workerProgram } from './worker-program.ts';
export { workerProgram } from './worker-program.ts';

export const isolatedToolDefinitions: ToolDefinition[] = [
  { name: 'sf_read_file', description: 'Read a UTF-8 file from the approved task workspace, at most 128 KiB.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'sf_write_file', description: 'Write a UTF-8 file in an approved writable task root, at most 128 KiB.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'sf_terminal', description: 'Run a command in the isolated task worktree. No networking, credentials or native control access. Bounded to 60 seconds and 128 KiB output.', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
];
/** Trusted AHP context supplies identity/callId; model input never supplies execution authority. */
export function createIsolatedClientTools(gate: FactoryToolGate, worker: IsolatedToolWorker): NativeClientTools {
  return {
    definitions: [...gate.definitions, ...isolatedToolDefinitions],
    invoke: (identity, callId, name, input) => name === 'sf_factory_operation'
      ? gate.invoke(identity, callId, name, input)
      : worker.invoke(identity, callId, name, input),
  };
}
export interface WorkerConfiguration { containerId: string; image: string; runtimeOwnerId: string; nativeContainerId: string; mountTargets: NativeMountTarget[]; }
export class IsolatedToolWorker {
  readonly config: WorkerConfiguration;
  private human: { start: NativeStart; identity: NativeIdentity; enabled: boolean; assertCurrent(): void } | undefined;
  admitHuman(start: NativeStart, identity: NativeIdentity, assertCurrent: () => void, enabled = true) { assertCurrent(); ensure(this.gate.isSuspended(), 'worker_human', 'Factory gate must be suspended'); this.human = { start, identity, assertCurrent, enabled }; }
  enableHuman() { ensure(this.human, 'worker_human', 'Human admission is missing'); this.human.assertCurrent(); this.human.enabled = true; }
  closeAdmission() { this.gate.suspend(); this.human = undefined; }
  private docker: DockerPort; private store: FactoryStore; private gate: FactoryToolGate;
  constructor(options: { config: WorkerConfiguration; docker: DockerPort; store: FactoryStore; gate: FactoryToolGate }) { this.config = options.config; this.docker = options.docker; this.store = options.store; this.gate = options.gate; }
  private async container() {
    const c = JSON.parse(await this.docker.command(['container', 'inspect', this.config.containerId]))[0];
    const image = JSON.parse(await this.docker.command(['image', 'inspect', this.config.image]))[0]; const h = c?.HostConfig;
    ensure(c?.Id === this.config.containerId && c.Id !== this.config.nativeContainerId && c.Image === image?.Id && imageMatches(this.config.image,image)
      && c.Config?.Labels?.['sf.runtime-owner'] === this.config.runtimeOwnerId && c.Config.User && !/^(root|0)(:|$)/.test(c.Config.User)
      && h?.NetworkMode === 'none' && h.ReadonlyRootfs && !h.Privileged && canonical(h.CapDrop) === canonical(['ALL']) && !h.CapAdd?.length
      && canonical(h.SecurityOpt) === canonical(['no-new-privileges']) && !h.PidMode && (!h.IpcMode || h.IpcMode === 'private')
      && !h.Devices?.length && !h.DeviceRequests?.length && !h.ExtraHosts?.length && !h.Dns?.length && !h.Links?.length && !h.VolumesFrom?.length
      && !Object.keys(h.PortBindings ?? {}).length && !Object.keys(h.Sysctls ?? {}).length && h.PidsLimit > 0 && h.Memory > 0 && h.NanoCpus > 0
      && h.RestartPolicy?.Name === 'no' && h.AutoRemove === false && c.Config.WorkingDir === '/workspaces/task'
      && canonical(c.Config.Env) === canonical(['PATH=/usr/local/bin:/usr/bin:/bin','HOME=/tmp','LANG=C.UTF-8'])
      && Object.keys(c.NetworkSettings.Networks ?? {}).every(name => name === 'none'), 'worker_boundary', 'Isolated worker container configuration changed');
    return c;
  }
  async inspect(start: NativeStart) {
    const c = await this.container(); const mounts = await resolveNativeMounts(start, this.config.mountTargets);
    ensure(c.State?.Running && !c.State.Paused && c.State.Pid > 0 && c.State.StartedAt, 'worker_stopped', 'Worker is not running');
    ensure(Array.isArray(c.Mounts) && c.Mounts.length === mounts.length && c.Mounts.every((m: any) => m.Type === 'bind' && ['private','rprivate',undefined].includes(m.Propagation))
      && canonical(c.Mounts.map((m: any) => ({ source: m.Source, target: m.Destination, writable: m.RW }))) === canonical(mounts), 'worker_mount', 'Worker must mount only exact approved task roots');
    return { runtimeId: c.Id as string, processIdentity: fingerprint({ pid: c.State.Pid, started: c.State.StartedAt }), mounts };
  }
  private current(start: NativeStart, identity?: NativeIdentity) {
    if (this.gate.isSuspended() && this.human) {
      this.human.assertCurrent();
      ensure(hasCapabilityGrants(start.task, this.store.getAdmissionState().grants, systemClock), 'worker_grant', 'Current exact-recipe grants are required for human tool execution');
      ensure(canonical(this.human.start) === canonical(start) && (!identity || canonical(identity) === canonical(this.human.identity)), 'worker_human', 'Human worker identity changed');
      return;
    }
    this.store.assertLifecycleAuthority(start.attemptId, start.fence);
    ensure(canonical(this.gate.currentStart()) === canonical(start), 'worker_binding', 'Worker binding changed');
    const r = this.store.getLifecycle(start.attemptId);
    ensure(!r.state.stopRequested && !r.state.closeout, 'worker_stopped', 'Worker admission is closed');
    if (identity) ensure(canonical(r.reservation.attempt.native) === canonical(identity), 'worker_identity', 'Worker tool belongs to another native session');
  }
  private async dispatch(start: NativeStart, operation: WorkerOperation) {
    const actual = await this.inspect(start);
    this.current(start);
    const input = { roots: actual.mounts.map(m => ({ target: m.target, writable: m.writable })), cwd: '/workspaces/task', operation };
    return JSON.parse(await this.docker.command(['exec', '-i', this.config.containerId, 'node', '-e', workerProgram], { stdin: JSON.stringify(input) })) as Record<string, unknown>;
  }
  async invoke(identity: NativeIdentity, callId: string, name: string, input: unknown) {
    if (this.gate.isSuspended()) ensure(this.human?.enabled, 'worker_human', 'Human tool dispatch waits for actual boundary verification');
    const start = this.gate.isSuspended() && this.human ? this.human.start : this.gate.currentStart(); this.current(start, identity);
    ensure(callId && callId.length <= 1024 && input && typeof input === 'object' && !Array.isArray(input), 'worker_input', 'Invalid worker invocation');
    const value = input as Record<string, unknown>; let operation: WorkerOperation;
    const fileGrant = start.task.required.tools.includes('native-files');
    if (name === 'sf_read_file' && fileGrant && Object.keys(value).sort().join(',') === 'path' && typeof value.path === 'string') operation = { kind: 'read', path: value.path };
    else if (name === 'sf_write_file' && fileGrant && start.task.required.paths.some(p => p.mode === 'write') && Object.keys(value).sort().join(',') === 'content,path' && typeof value.path === 'string' && typeof value.content === 'string') operation = { kind: 'write', path: value.path, content: value.content };
    else if (name === 'sf_terminal' && start.task.required.tools.includes('native-terminal') && Object.keys(value).join(',') === 'command' && typeof value.command === 'string') operation = { kind: 'terminal', command: value.command };
    else throw new Error('Worker operation exceeds approved toolkit');
    const key = `worker:${fingerprint({ identity, callId })}`;
    const receipt = this.store.getActionByKey(key + ':result');
    const claim = this.store.claimAction({ key, kind: 'worker.execute', payload: { attemptId: start.attemptId, fence: start.fence, human: this.gate.isSuspended(), identity, operation } });
    if (receipt) return receipt.payload;
    ensure(claim.fresh, 'worker_unknown', 'Prior worker effect is unknown; never execute it twice');
    try {
      const result = await this.dispatch(start, operation); this.current(start, identity);
      const saved = this.store.enqueueAction({ key: key + ':result', kind: 'worker.result', payload: result });
      this.store.completeAction(saved.id); this.store.completeAction(claim.action.id); return result;
    } catch (error) {
      this.gate.suspend(); this.human = undefined;
      const record=this.store.getLifecycle(start.attemptId);
      if(record.reservation.lease.active&&record.reservation.lease.fence===start.fence){
        const attention={kind:'blocked' as const,prompt:'Isolated tool outcome is unknown',recovery:'Inspect retained original worker/workspace; the exact tool call will not be executed twice'};
        this.store.updateLifecycle(start.attemptId,start.fence,{status:'needs_attention',state:{...record.state,stopRequested:true},attention});
        this.store.enqueueAction({key:'worker:unknown:'+claim.action.id,kind:'lifecycle.pause',payload:{attemptId:start.attemptId,fence:start.fence,status:'needs_attention',attention,human:false}});
      }
      // Close admission synchronously, then independently freeze all detached worker children.
      void this.pause(); throw error;
    }
  }
  async challenge(start: NativeStart, nonce: string, paths: readonly string[]) {
    this.current(start); const before = await this.inspect(start);
    // Access-only negatives. No real credential contents are read. Positive control runs in the exact terminal dispatcher.
    const program = `const fs=require('node:fs'),net=require('node:net');(async()=>{const paths=${JSON.stringify([...paths, '/var/lib/software-factory/native-state/connection-token', '/proc/1/root/var/lib/software-factory/native-state/connection-token'])};let denied=true;for(const p of paths){try{fs.accessSync(p);denied=false}catch{}}const blocked=host=>new Promise(r=>{const s=net.connect({host,port:443});s.setTimeout(500);s.on('connect',()=>{s.destroy();r(false)});s.on('error',()=>r(true));s.on('timeout',()=>{s.destroy();r(true)})});const workspace=fs.statSync('/workspaces/task').isDirectory();console.log(JSON.stringify({nonce:${JSON.stringify(nonce)},workspace,denied,environment:!Object.keys(process.env).some(n=>/TOKEN|SECRET|PASSWORD|SF_CONTROL_SENTINEL/.test(n)),egress:await blocked('1.1.1.1')&&await blocked('127.0.0.1')&&await blocked('::1')}))})()`;
    const command = "node -e 'eval(Buffer.from(\"" + Buffer.from(program).toString('base64') + "\",\"base64\").toString())'";
    const result = await this.dispatch(start, { kind: 'terminal', command });
    const proof = JSON.parse(String(result.stdout));
    ensure(result.exitCode === 0 && proof.nonce === nonce && proof.workspace && proof.denied && proof.environment && proof.egress && canonical(before) === canonical(await this.inspect(start)), 'worker_canary', 'Actual isolated worker challenge failed');
    return before;
  }
  async pause(): Promise<'waiting' | 'unknown'> {
    const key = `worker:pause:${this.config.containerId}`;
    try {
      const c = await this.container();
      if (c.State.Paused) return 'waiting';
      const claim = this.store.claimAction({ key: key + ':' + c.State.StartedAt, kind: 'worker.pause', payload: { containerId: c.Id } });
      if (!claim.fresh && !claim.action.completedAt) return 'unknown';
      await this.docker.command(['container', 'pause', c.Id]);
      const after = await this.container(); ensure(after.State.Running && after.State.Paused && after.State.Pid === c.State.Pid, 'worker_pause', 'Worker freeze is unknown');
      this.store.completeAction(claim.action.id); return 'waiting';
    } catch { return 'unknown'; }
  }
  /** Physically stop this exact worker only when no earlier worker effect may still accept. */
  async stopForMaintenance(): Promise<void> {
    this.closeAdmission();
    const unsettled = () => this.store.pendingActions().some(action => ['worker.execute','worker.pause','worker.resume','worker.maintenance_stop'].includes(action.kind));
    ensure(!unsettled(), 'worker_unknown', 'An unresolved worker effect retains exclusion');
    const before = await this.container();
    ensure(!unsettled(), 'worker_unknown', 'A worker effect began during inspection');
    if (!before.State?.Running) {
      ensure(before.State?.Paused===false && before.State.Pid===0 && before.State.Status==='exited', 'worker_stop', 'Worker stopped state is unknown');
      return;
    }
    ensure(before.State.StartedAt && before.State.Pid > 0, 'worker_stop', 'Worker process identity unavailable');
    const action=this.store.enqueueAction({key:'worker:maintenance-stop:'+this.config.containerId+':'+before.State.StartedAt,kind:'worker.maintenance_stop',payload:{containerId:this.config.containerId,startedAt:before.State.StartedAt}});
    ensure(!action.completedAt, 'worker_stop', 'Previously stopped worker restarted; retain for recovery');
    await this.docker.command(['container','kill','--signal','KILL',this.config.containerId]);
    const after=await this.container();
    ensure(after.State?.Running===false&&after.State.Paused===false&&after.State.Pid===0&&after.State.Status==='exited', 'worker_stop', 'Worker physical stop is unknown');
    this.store.completeAction(action.id);
  }
  async resume(start: NativeStart, key: string) {
    this.current(start); const c = await this.container();
    if (!c.State.Paused) { await this.inspect(start); return; }
    const claim = this.store.claimAction({ key: 'worker:resume:' + key, kind: 'worker.resume', payload: { containerId: c.Id, attemptId: start.attemptId, fence: start.fence } });
    ensure(claim.fresh, 'worker_unknown', 'Worker resume outcome requires inspection, not replay');
    await this.docker.command(['container', 'unpause', c.Id]); this.current(start); await this.inspect(start); this.store.completeAction(claim.action.id);
  }
}
