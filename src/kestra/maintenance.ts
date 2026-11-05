import { join, resolve } from 'node:path';
import { readPrivateFileAsync } from '../service/config.ts';
import { canonical, ensure, fingerprint } from '../storage/database.ts';
import type { DockerPort } from './deployment.ts';
import type { FactoryStore, OutboxAction } from '../storage/store.ts';
import { kestraImagePins } from './deployment.ts';

interface EngineInstallation { id:string; root:string; docker:DockerPort }
const cleanH2Url='jdbc:h2:file:/app/data/database;TIME ZONE=UTC;DB_CLOSE_DELAY=0;DB_CLOSE_ON_EXIT=TRUE;LOCK_TIMEOUT=30000';
async function cleanH2Evidence(installation:EngineInstallation,store:FactoryStore,container:any):Promise<{configHash:string;imageId:string;startedAt:string}|undefined>{
  try{
    const startedAt=container.State?.StartedAt;ensure(typeof startedAt==='string'&&startedAt.length>0,'engine_h2','Original engine generation missing');
    const generation=store.getActionByKey('kestra:generation:'+container.Id+':'+startedAt);const config=JSON.parse((await readPrivateFileAsync(join(installation.root,'kestra','config','application.yaml'))).toString());
    const configHash=fingerprint(config);const images=JSON.parse(await installation.docker.command(['image','inspect',kestraImagePins.kestra.image]));const image=images?.[0];
    ensure(generation?.kind==='kestra.generation'&&generation.completedAt&&generation.payload.installationId===installation.id&&generation.payload.containerId===container.Id&&generation.payload.startedAt===startedAt&&generation.payload.configHash===configHash&&generation.payload.h2Lifecycle==='jvm-exit'&&config.datasources?.h2?.url===cleanH2Url&&config.datasources.h2.username==='sa'&&config.datasources.h2.password===''&&images?.length===1&&image?.RepoDigests?.includes(kestraImagePins.kestra.image)&&image.Os==='linux'&&image.Architecture==='amd64'&&image.Id===container.Image&&generation.payload.imageId===image.Id,'engine_h2','H2 clean lifecycle is unrecorded');
    return {configHash,imageId:image.Id,startedAt};
  }catch{return undefined}
}
export interface OwnedKestraInspection { installationId:string; owner:string; networkId:string; containerId:string; transportContainerId:string }
const hexId = (value:unknown):value is string => typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
/** Read only: never create, start, attach, or infer absence from a failed inspection. */
export async function inspectOwnedKestra(installation:EngineInstallation,store:FactoryStore):Promise<OwnedKestraInspection> {
  const {id,root,docker}=installation;
  ensure(/^[A-Za-z0-9_-]{1,100}$/.test(id)&&resolve(root)===root,'engine_owner','Invalid installation identity');
  const value=JSON.parse((await readPrivateFileAsync(join(root,'kestra','owned-resources.json'))).toString());
  const owner=fingerprint({id,root});
  ensure(value.installationId===id&&value.owner===owner&&hexId(value.networkId)&&hexId(value.containerId)&&hexId(value.transportContainerId)&&value.containerId!==value.transportContainerId,'engine_owner','Owned engine manifest is unavailable or mismatched');
  const inspection:OwnedKestraInspection={installationId:id,owner,networkId:value.networkId,containerId:value.containerId,transportContainerId:value.transportContainerId};
  ensure(!store.pendingActions().some(action=>['kestra.deployment','kestra.maintenance_stop'].includes(action.kind)),'engine_owner','An engine deployment or stop action remains unresolved');
  const prefix='sf-'+owner.slice(0,24); const labels={'sf.installation':id,'sf.owner':owner,'sf.component':'kestra'};
  const exactLabels=(actual:any)=>Object.entries(labels).every(([key,expected])=>actual?.[key]===expected);
  const read=async(kind:string,key:string)=>{const values=JSON.parse(await docker.command([kind,'inspect',key]));ensure(Array.isArray(values)&&values.length===1&&values[0]?.Id===key,'engine_owner','Exact owned engine resource inspection required');return values[0]};
  const network=await read('network',inspection.networkId);
  ensure(network.Name===prefix+'-engine'&&network.Internal===true&&network.Driver==='bridge'&&exactLabels(network.Labels),'engine_owner','Owned engine network changed');
  const engine=await read('container',inspection.containerId); const transport=await read('container',inspection.transportContainerId);
  for(const [container,name] of [[engine,prefix+'-kestra'],[transport,prefix+'-transport']] as const) {
    ensure(container.Name==='/'+name&&exactLabels(container.Config?.Labels)&&container.HostConfig?.RestartPolicy?.Name==='no'&&container.State&&typeof container.State.Running==='boolean'&&container.State.Paused===false,'engine_owner','Owned engine container changed or has unknown state');
    const ownerReceipt=store.getActionByKey('kestra:owner:'+name);
    ensure(ownerReceipt?.kind==='kestra.owner'&&ownerReceipt.completedAt&&ownerReceipt.payload.installationId===id&&ownerReceipt.payload.name===name&&ownerReceipt.payload.containerId===container.Id&&ownerReceipt.payload.owner===owner,'engine_owner','Original engine creation receipt unavailable');
    if(container.State.Running||container.State.Status==='exited'){
      const startedAt=container.State.StartedAt;const generation=typeof startedAt==='string'?store.getActionByKey('kestra:generation:'+container.Id+':'+startedAt):undefined;
      ensure(generation?.kind==='kestra.generation'&&generation.completedAt&&generation.payload.installationId===id&&generation.payload.containerId===container.Id&&generation.payload.startedAt===startedAt,'engine_owner','Original engine generation is unrecorded');
    }
  }
  const mounts=engine.Mounts;
  ensure(Array.isArray(mounts)&&mounts.length===2&&mounts.some((m:any)=>m.Type==='bind'&&m.Source===join(root,'kestra','data')&&m.Destination==='/app/data'&&m.RW===true)&&mounts.some((m:any)=>m.Type==='bind'&&m.Source===join(root,'kestra','config')&&m.Destination==='/app/confs'&&m.RW===false)&&Array.isArray(transport.Mounts)&&transport.Mounts.length===0&&transport.HostConfig.NetworkMode==='container:'+inspection.containerId,'engine_owner','Owned engine mounts or transport changed');
  return inspection;
}
/** Call only after controller admission and external workflow effects are fenced. Unknown stop outcomes throw. */
export async function stopOwnedKestra(installation:EngineInstallation,prior:OwnedKestraInspection,store:FactoryStore):Promise<void> {
  ensure(!store.pendingActions().some(action=>action.kind==='kestra.maintenance_stop'), 'engine_stop', 'An earlier engine stop is unresolved');
  const now=await inspectOwnedKestra(installation,store);
  ensure(canonical(now)===canonical(prior),'engine_owner','Owned engine identity changed before stop');
  for(const id of [now.transportContainerId,now.containerId]) {
    const values=JSON.parse(await installation.docker.command(['container','inspect',id]));const state=values?.[0]?.State;
    ensure(values?.length===1&&values[0].Id===id&&state&&state.Paused===false,'engine_stop','Engine state unavailable');
    let action:ReturnType<FactoryStore['enqueueAction']> | undefined;
    if(state.Running===true){
      ensure(typeof state.StartedAt==='string'&&state.StartedAt.length>0,'engine_stop','Engine process generation unavailable');
      action=store.enqueueAction({key:'kestra:maintenance-stop:'+id+':'+state.StartedAt,kind:'kestra.maintenance_stop',payload:{containerId:id,startedAt:state.StartedAt}});
      ensure(!action.completedAt,'engine_stop','Previously stopped engine restarted; retain for recovery');
      await installation.docker.command(['container','stop','--time','10',id]);
    }
    const after=JSON.parse(await installation.docker.command(['container','inspect',id]));const stopped=after?.[0]?.State;
    ensure(after?.length===1&&after[0].Id===id&&stopped?.Running===false&&stopped.Paused===false&&stopped.Pid===0&&stopped.Status==='exited','engine_stop','Engine stop not proven');
    if(action&&id===now.containerId&&[0,143].includes(stopped.ExitCode)&&stopped.OOMKilled===false&&stopped.Error===''&&typeof stopped.FinishedAt==='string'&&stopped.FinishedAt){
      const evidence=await cleanH2Evidence(installation,store,after[0]);
      if(evidence){const receipt=store.enqueueAction({key:'kestra:h2-closed:'+id+':'+evidence.startedAt,kind:'kestra.h2_closed',payload:{installationId:installation.id,containerId:id,...evidence,exitCode:stopped.ExitCode,stopActionId:action.id}});store.completeAction(receipt.id)}
    }
    if(action)store.completeAction(action.id);
  }
}
/** Existing legacy or forced exits cannot manufacture a clean-close receipt. */
export async function requireCleanH2Close(installation:EngineInstallation,store:FactoryStore):Promise<OutboxAction>{
  const owned=await inspectOwnedKestra(installation,store);const values=JSON.parse(await installation.docker.command(['container','inspect',owned.containerId]));const c=values?.[0],state=c?.State;
  ensure(values?.length===1&&c.Id===owned.containerId&&state?.Running===false&&state.Paused===false&&state.Pid===0&&state.Status==='exited'&&[0,143].includes(state.ExitCode)&&state.OOMKilled===false&&state.Error===''&&typeof state.FinishedAt==='string'&&state.FinishedAt,'engine_h2','A graceful engine exit is unconfirmed');
  const evidence=await cleanH2Evidence(installation,store,c);ensure(evidence,'engine_h2','H2 close lifecycle is unverified');const receipt=store.getActionByKey('kestra:h2-closed:'+c.Id+':'+evidence.startedAt);
  ensure(receipt?.kind==='kestra.h2_closed'&&receipt.completedAt&&receipt.payload.installationId===installation.id&&receipt.payload.containerId===c.Id&&receipt.payload.configHash===evidence.configHash&&receipt.payload.imageId===evidence.imageId&&receipt.payload.startedAt===evidence.startedAt&&receipt.payload.exitCode===state.ExitCode,'engine_h2','Original H2 close receipt is unavailable');
  const stop=store.getActionByKey('kestra:maintenance-stop:'+c.Id+':'+evidence.startedAt);ensure(stop?.kind==='kestra.maintenance_stop'&&stop.completedAt&&stop.id===receipt.payload.stopActionId&&stop.payload.containerId===c.Id&&stop.payload.startedAt===evidence.startedAt,'engine_h2','Original engine stop is unresolved');return receipt;
}
/** Read-only stopped-state check; an unknown operation still causes inspection to reject. */
export async function areOwnedKestraStopped(installation:EngineInstallation,store:FactoryStore):Promise<boolean>{
  const owned=await inspectOwnedKestra(installation,store);
  for(const id of [owned.containerId,owned.transportContainerId]){const values=JSON.parse(await installation.docker.command(['container','inspect',id]));const state=values?.[0]?.State;if(values?.length!==1||values[0].Id!==id||state?.Running!==false||state.Paused!==false||state.Pid!==0||state.Status!=='exited')return false}
  return true;
}
