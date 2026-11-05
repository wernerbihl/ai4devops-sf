import type { WorkflowIdentity } from '../contracts/domain.ts';
import { canonical } from '../storage/database.ts';
import { checked, verifyExecution } from './executions.ts';
import type { EngineTransport } from './executions.ts';
import { readExecutionIntent } from './maintenance-journal.ts';
/** Read only the original execution. Unknown or pending outcomes are never retried or settled. */
export async function readOnlyWorkflowQuiescence(directory:string,identity:WorkflowIdentity,request:EngineTransport):Promise<'waiting'|'stopped'|'unknown'> {
  try {
    const record=await readExecutionIntent(directory,identity);
    if(record.stopRequested||record.resume&&record.resume.phase!=='done')return 'unknown';
    const execution=await checked(request,{method:'GET',path:'/executions/'+identity.executionId});
    if(canonical(verifyExecution(execution,record))!==canonical(identity))return 'unknown';
    if(['SUCCESS','FAILED','KILLED','CANCELLED'].includes(execution.state.current))return 'stopped';
    const runs=execution.taskRunList??[];
    if(execution.state.current==='PAUSED'&&runs.some((run:any)=>run.taskId==='await_result'&&run.state.current==='PAUSED')&&runs.some((run:any)=>run.taskId==='native_start'&&run.state.current==='SUCCESS')&&runs.every((run:any)=>run.taskId==='await_result'||['SUCCESS','SKIPPED'].includes(run.state.current)))return 'waiting';
    return 'unknown';
  } catch {return 'unknown'}
}

import { join } from 'node:path';
import { readPrivateFileAsync } from '../service/config.ts';
import { readWindowsSecretAsync } from '../platform/windows-private.ts';
import { ensure, fingerprint } from '../storage/database.ts';
import type { FactoryStore } from '../storage/store.ts';
import type { DockerPort, InstallationSecrets } from './deployment.ts';
import { createEngineTransport, kestraImagePins } from './deployment.ts';
import { inspectOwnedKestra } from './maintenance.ts';
import { inspectOwnedBrokerRelay } from '../broker/maintenance.ts';

/** Reuse only an already-running verified engine/transport; never initialize or start resources. */
export async function createMaintenanceWorkflowReader(input:{id:string;root:string;docker:DockerPort;store:FactoryStore}):Promise<{quiescence(identity:WorkflowIdentity):Promise<'waiting'|'stopped'|'unknown'>}|undefined> {
  const {id,root,docker,store}=input;
  async function verify():Promise<{transportId:string;generation:string}> {
    const owned=await inspectOwnedKestra(input,store);const relay=await inspectOwnedBrokerRelay({id,networkId:owned.networkId,docker,store});
    const read=async(kind:string,key:string)=>{const values=JSON.parse(await docker.command([kind,'inspect',key]));ensure(values?.length===1,'engine_recovery','Resource inspection unavailable');return values[0]};
    const engine=await read('container',owned.containerId),transport=await read('container',owned.transportContainerId),network=await read('network',owned.networkId);
    const engineImage=await read('image',kestraImagePins.kestra.image),transportImage=await read('image',kestraImagePins.worker.image);
    for(const [image,pin] of [[engineImage,kestraImagePins.kestra.image],[transportImage,kestraImagePins.worker.image]] as const)ensure(image?.RepoDigests?.includes(pin)&&image.Os==='linux'&&image.Architecture==='amd64','engine_recovery','Pinned image unavailable');
    const user=process.platform==='win32'?'1000:1000':`${process.getuid!()}:${process.getgid!()}`;
    const valid=(c:any,base:any,pin:string,command:string[],env:string[])=>{
      const h=c?.HostConfig;return c?.Image===base?.Id&&c.Config?.Image===pin&&c.Config.User===user&&canonical(c.Config.Entrypoint)===canonical(base.Config.Entrypoint)&&c.Config.WorkingDir===base.Config.WorkingDir&&canonical(c.Config.Cmd)===canonical(command)&&canonical(c.Config.Env??[])===canonical([...(base.Config.Env??[]),...env])&&h?.ReadonlyRootfs&&!h.Privileged&&h.RestartPolicy?.Name==='no'&&h.AutoRemove===false&&h.CapDrop?.includes('ALL')&&!h.CapAdd?.length&&h.SecurityOpt?.includes('no-new-privileges')&&!h.PidMode&&(!h.IpcMode||h.IpcMode==='private')&&!h.Devices?.length&&!h.DeviceRequests?.length&&!h.VolumesFrom?.length&&!h.Binds?.length&&!Object.keys(h.PortBindings??{}).length&&h.PidsLimit===256&&h.Memory===2147483648&&h.NanoCpus===2000000000&&c.State?.Running===true&&c.State.Paused===false&&c.State.Pid>0&&typeof c.State.StartedAt==='string';
    };
    ensure(valid(engine,engineImage,kestraImagePins.kestra.image,['server','local'],['MICRONAUT_CONFIG_FILES=/app/confs/application.yaml','KESTRA_PLUGINS_AUTO_INSTALL_ENABLED=false'])&&valid(transport,transportImage,kestraImagePins.worker.image,['node','-e','setInterval(()=>{},1000)'],[]),'engine_recovery','Existing engine/transport restrictions changed');
    ensure(engine.Id===owned.containerId&&transport.Id===owned.transportContainerId&&transport.HostConfig.NetworkMode==='container:'+engine.Id&&Object.keys(transport.NetworkSettings?.Networks??{}).length===0&&engine.HostConfig.NetworkMode===network.Name&&Object.keys(engine.NetworkSettings?.Networks??{}).length===1&&engine.NetworkSettings.Networks[network.Name]?.NetworkID===network.Id&&network.Internal===true&&network.Driver==='bridge'&&network.Labels?.['sf.installation']===id&&Object.keys(network.Containers??{}).every(peer=>[engine.Id,relay.containerId].includes(peer)),'engine_recovery','Engine network identity changed');
    const generation=store.getActionByKey('kestra:generation:'+transport.Id+':'+transport.State.StartedAt);
    ensure(generation?.completedAt&&generation.payload.engineId===engine.Id&&generation.payload.engineStartedAt===engine.State.StartedAt,'engine_recovery','Transport is not bound to the current engine generation');
    return {transportId:transport.Id,generation:fingerprint({engine:engine.Id,engineStartedAt:engine.State.StartedAt,transport:transport.Id,transportStartedAt:transport.State.StartedAt,network:network.Id})};
  }
  try {
    const original=await verify();
    const bytes=process.platform==='win32'?await readWindowsSecretAsync(join(root,'kestra-secrets.dpapi')):await readPrivateFileAsync(join(root,'kestra-secrets.json'));
    const secret=JSON.parse(bytes.toString()) as InstallationSecrets & {id:string};
    ensure(secret.id===id&&typeof secret.username==='string'&&secret.username.length>0&&!secret.username.includes(':')&&typeof secret.password==='string'&&secret.password.length>=32&&typeof secret.encryptionKey==='string'&&Buffer.from(secret.encryptionKey,'base64').length===32&&Buffer.from(secret.encryptionKey,'base64').toString('base64')===secret.encryptionKey,'engine_recovery','Existing engine secrets are invalid');
    ensure((await verify()).generation===original.generation,'engine_recovery','Engine generation changed during recovery');
    const request=createEngineTransport(docker,original.transportId,secret);
    return {async quiescence(identity){try{const before=await verify();ensure(before.generation===original.generation,'engine_recovery','Engine generation changed');const result=await readOnlyWorkflowQuiescence(join(root,'kestra','journal'),identity,request);ensure((await verify()).generation===original.generation,'engine_recovery','Engine generation changed');return result}catch{return 'unknown'}}};
  } catch {return undefined}
}
