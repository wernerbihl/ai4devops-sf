import { join, resolve } from 'node:path';
import { readPrivateFileAsync } from '../service/config.ts';
import { canonical, ensure, fingerprint } from '../storage/database.ts';
import type { DockerPort } from './deployment.ts';

interface EngineInstallation { id:string; root:string; docker:DockerPort }
export interface OwnedKestraInspection { installationId:string; owner:string; networkId:string; containerId:string; transportContainerId:string }
const hexId = (value:unknown):value is string => typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
/** Read only: never create, start, attach, or infer absence from a failed inspection. */
export async function inspectOwnedKestra(installation:EngineInstallation):Promise<OwnedKestraInspection> {
  const {id,root,docker}=installation;
  ensure(/^[A-Za-z0-9_-]{1,100}$/.test(id)&&resolve(root)===root,'engine_owner','Invalid installation identity');
  const value=JSON.parse((await readPrivateFileAsync(join(root,'kestra','owned-resources.json'))).toString());
  const owner=fingerprint({id,root});
  ensure(value.installationId===id&&value.owner===owner&&hexId(value.networkId)&&hexId(value.containerId)&&hexId(value.transportContainerId)&&value.containerId!==value.transportContainerId,'engine_owner','Owned engine manifest is unavailable or mismatched');
  const inspection:OwnedKestraInspection={installationId:id,owner,networkId:value.networkId,containerId:value.containerId,transportContainerId:value.transportContainerId};
  const prefix='sf-'+owner.slice(0,24); const labels={'sf.installation':id,'sf.owner':owner,'sf.component':'kestra'};
  const exactLabels=(actual:any)=>Object.entries(labels).every(([key,expected])=>actual?.[key]===expected);
  const read=async(kind:string,key:string)=>{const values=JSON.parse(await docker.command([kind,'inspect',key]));ensure(Array.isArray(values)&&values.length===1&&values[0]?.Id===key,'engine_owner','Exact owned engine resource inspection required');return values[0]};
  const network=await read('network',inspection.networkId);
  ensure(network.Name===prefix+'-engine'&&network.Internal===true&&network.Driver==='bridge'&&exactLabels(network.Labels),'engine_owner','Owned engine network changed');
  const engine=await read('container',inspection.containerId); const transport=await read('container',inspection.transportContainerId);
  for(const [container,name] of [[engine,prefix+'-kestra'],[transport,prefix+'-transport']] as const) {
    ensure(container.Name==='/'+name&&exactLabels(container.Config?.Labels)&&container.HostConfig?.RestartPolicy?.Name==='no'&&container.State&&typeof container.State.Running==='boolean'&&container.State.Paused===false,'engine_owner','Owned engine container changed or has unknown state');
  }
  const mounts=engine.Mounts;
  ensure(Array.isArray(mounts)&&mounts.length===2&&mounts.some((m:any)=>m.Type==='bind'&&m.Source===join(root,'kestra','data')&&m.Destination==='/app/data'&&m.RW===true)&&mounts.some((m:any)=>m.Type==='bind'&&m.Source===join(root,'kestra','config')&&m.Destination==='/app/confs'&&m.RW===false)&&Array.isArray(transport.Mounts)&&transport.Mounts.length===0&&transport.HostConfig.NetworkMode==='container:'+inspection.containerId,'engine_owner','Owned engine mounts or transport changed');
  return inspection;
}
/** Call only after controller admission and external workflow effects are fenced. Unknown stop outcomes throw. */
export async function stopOwnedKestra(installation:EngineInstallation,prior:OwnedKestraInspection):Promise<void> {
  const now=await inspectOwnedKestra(installation);
  ensure(canonical(now)===canonical(prior),'engine_owner','Owned engine identity changed before stop');
  for(const id of [now.transportContainerId,now.containerId]) {
    const values=JSON.parse(await installation.docker.command(['container','inspect',id]));const state=values?.[0]?.State;
    ensure(values?.length===1&&values[0].Id===id&&state&&state.Paused===false,'engine_stop','Engine state unavailable');
    if(state.Running===true)await installation.docker.command(['container','stop','--time','10',id]);
    const after=JSON.parse(await installation.docker.command(['container','inspect',id]));const stopped=after?.[0]?.State;
    ensure(after?.length===1&&after[0].Id===id&&stopped?.Running===false&&stopped.Paused===false&&stopped.Pid===0&&stopped.Status==='exited','engine_stop','Engine stop not proven');
  }
}
