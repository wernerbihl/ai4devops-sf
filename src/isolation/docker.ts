import { imageMatches } from './image.ts';
import type { NativeStart } from '../contracts/domain.ts';
import type { DockerPort } from '../kestra/deployment.ts';
import { canonical, ensure, fingerprint } from '../storage/database.ts';
import type { EffectiveBoundary, NativeBoundary } from './profiles.ts';
import { resolveProtectedPaths } from './paths.ts';
import { denialChecks } from './profiles.ts';
export type NativeToolSettings = Pick<EffectiveBoundary,'runtimeId'|'processIdentity'|'ownerId'|'providerId'|'tools'|'credentialRefs'|'networkDestinations'|'unapprovedToolsDenied'|'alternateEgressDenied'|'metadataProtected'> & { attemptId: string; fence: number };
export interface NativeToolBoundary {
  /** Trusted E4/E6 control only, after C4 acquires the current reservation/fence and before readiness.
   * Idempotently rotate actual native tool authority on the current quiescent managed runtime.
   * Must validate current store authority and preserve original native session/workspace and owned persistent state.
   * A controlled stop/restart may change the PID; all process-bound evidence must then be freshly verified.
   * No native send, process launch, new/replacement session, or engine Pause resume in this method. Never exposed as a worker route.
   * E3 does not call this from inspection: an inspect implementation must never echo start as proof. */
  prepareBinding(start: NativeStart, key: string): Promise<void>;
  /** E4 must inspect the actual paired owner/client tools; declarations and Docker flags alone are insufficient. */
  inspect(start: NativeStart): Promise<NativeToolSettings>;
  /** Fixed denial requests through the actual native tool path; probe the full declared/resolved protectedPaths set. No worker commands. */
  challenge(start: NativeStart, nonce: string, protectedPaths: readonly string[]): Promise<{ nonce: string; runtimeId: string; processIdentity: string; denied: boolean; checks: readonly string[] }>;
}
const canary = `let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>s+=v);process.stdin.on('end',()=>{try{const fs=require('node:fs'),p=JSON.parse(s);let denied=true;for(const path of p.paths){try{const fd=fs.openSync(path,'r');fs.closeSync(fd);denied=false;}catch(e){if(!['ENOENT','ENOTDIR','EACCES','EPERM','ENXIO'].includes(e.code))throw e;}try{fs.accessSync(path,fs.constants.W_OK);denied=false;}catch(e){if(!['ENOENT','ENOTDIR','EACCES','EPERM','EROFS'].includes(e.code))throw e;}}process.stdout.write(JSON.stringify({nonce:p.nonce,denied}));}catch{process.exitCode=1;}});`;
/** Production effective Docker adapter, composed with E4's mandatory actual native-tool enforcement adapter. */
export function createDockerNativeBoundary(options: { docker: DockerPort; containerId: string; runtimeOwnerId: string; image: string; networks: string[]; protectedPaths: string[]; tools: NativeToolBoundary }): NativeBoundary {
  const { docker } = options;
  async function inspect(start: NativeStart): Promise<EffectiveBoundary> {
    const c = JSON.parse(await docker.command(['container','inspect',options.containerId]))[0];
    const image = JSON.parse(await docker.command(['image','inspect',options.image]))[0]; const h = c?.HostConfig;
    ensure(c?.Id === options.containerId && c.State?.Running && c.State.Pid > 0 && c.State.StartedAt
      && imageMatches(options.image,image) && c.Image === image.Id && c.Config?.User && !/^(0|root)(:|$)/.test(c.Config.User)
      && options.runtimeOwnerId && c.Config.Labels?.['sf.runtime-owner'] === options.runtimeOwnerId
      && h?.ReadonlyRootfs && !h.Privileged && canonical(h.CapDrop) === canonical(['ALL']) && !h.CapAdd?.length
      && canonical(h.SecurityOpt) === canonical(['no-new-privileges']) && !h.PidMode && (!h.IpcMode || h.IpcMode === 'private')
      && !h.Devices?.length && !h.DeviceRequests?.length && !Object.keys(h.PortBindings ?? {}).length
      && h.PidsLimit > 0 && h.Memory > 0 && h.NanoCpus > 0 && !h.ExtraHosts?.length && !h.Dns?.length
      && !Object.keys(h.Sysctls ?? {}).length && !h.Links?.length && !h.VolumesFrom?.length
      && !['host','bridge','default'].includes(h.NetworkMode), 'profile_docker', 'Unsafe effective native container restrictions');
    const networks = Object.values(c.NetworkSettings?.Networks ?? {}).map((n:any)=>String(n.NetworkID)).sort();
    ensure(canonical(networks) === canonical([...options.networks].sort()), 'profile_network','Effective network attachments changed');
    for(const id of networks) {
      const network = JSON.parse(await docker.command(['network','inspect',id]))[0];
      ensure(network?.Id === id && network.Internal === true && network.Driver === 'bridge', 'profile_network','Native runtime needs owned private networking and inspected egress boundary');
    }
    ensure(Array.isArray(c.Mounts) && c.Mounts.every((m:any)=>m.Type === 'bind' && ['private','rprivate',undefined].includes(m.Propagation)), 'profile_mount','Unexpected volumes or mount propagation');
    const tools = await options.tools.inspect(start);
    ensure(tools.attemptId === start.attemptId && tools.fence === start.fence && tools.runtimeId === c.Id && tools.processIdentity && tools.ownerId === start.task.ownerId && tools.providerId === start.task.providerId,
      'profile_native','Native/client-tool policy must belong to the inspected runtime');
    return { ...tools, processIdentity: fingerprint({ native:tools.processIdentity,pid:c.State.Pid,started:c.State.StartedAt }), image:options.image,
      mounts:c.Mounts.map((m:any)=>({source:m.Source,target:m.Destination,writable:m.RW})),networks,protectedPaths:[...options.protectedPaths] };
  }
  return { inspect, async challenge(start,nonce,protectedPaths) {
    const targets = await resolveProtectedPaths(options.protectedPaths);
    ensure(canonical(protectedPaths) === canonical(targets), 'profile_protection', 'Protected canary targets changed or are incomplete');
    const before = await inspect(start);
    const os = JSON.parse(await docker.command(['exec','-i',options.containerId,'node','-e',canary],{stdin:JSON.stringify({nonce,paths:targets})}));
    const native = await options.tools.challenge(start,nonce,targets); const actualTools = await options.tools.inspect(start);
    const after = await inspect(start); const afterTargets = await resolveProtectedPaths(options.protectedPaths);
    ensure(canonical(targets) === canonical(afterTargets) && os.nonce === nonce && os.denied === true && native.nonce === nonce && native.denied
      && native.runtimeId === before.runtimeId && native.processIdentity === actualTools.processIdentity
      && denialChecks.every(name=>native.checks.includes(name)) && canonical(before) === canonical(after), 'profile_canary','Actual native/tool or OS denial checks failed');
    return { nonce, runtimeId:before.runtimeId, processIdentity:before.processIdentity, denied:true, checks:denialChecks };
  } };
}
