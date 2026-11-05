import { readdir } from 'node:fs/promises';
import { lstatSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyNativeStateMount, NATIVE_STATE_TARGET } from '../isolation/native-state.ts';
import { imageMatches } from '../isolation/image.ts';
import { resolveNativeMounts } from '../isolation/mounts.ts';
import type { NativeStart } from '../contracts/domain.ts';
import { readPrivateFileAsync } from './config.ts';
import type { DockerPort } from '../kestra/deployment.ts';
import type { FactoryStore } from '../storage/store.ts';
import { canonical, ensure, fingerprint } from '../storage/database.ts';

export interface NativeInventoryItem { taskId:string; ownerId:string; pending:string[]; containers:{role:'native'|'worker'|'proxy';id:string;fingerprint:string;stopped:boolean}[]; networks:{id:string;fingerprint:string}[] }
/** Read-only inventory of retained task runtimes. No adoption, profile setup, authentication or starts. */
export async function inspectNativeInventory(input:{id:string;root:string;docker:DockerPort;store:FactoryStore;images:{native:string;worker:string;proxy:string}}):Promise<NativeInventoryItem[]> {
  const {id,root,docker,store,images}=input;
  ensure(resolve(root)===root&&/^[A-Za-z0-9_-]{1,100}$/.test(id),'native_inventory','Invalid installation identity');
  const stateRoot=join(root,'native-state');let names:string[]=[];
  try{names=await readdir(stateRoot)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  const reservations=store.getReservations();const result:NativeInventoryItem[]=[];
  for(const name of names) {
    const matches=reservations.filter(r=>'rt-'+fingerprint({installation:id,task:r.attempt.taskId}).slice(0,24)===name);
    ensure(matches.length>0,'native_inventory','Unrecognized native state retains recovery');
    const taskId=matches[0]!.attempt.taskId;const workspaces=[...new Set(matches.map(r=>r.attempt.workspacePath))];
    ensure(matches.every(r=>r.attempt.taskId===taskId)&&workspaces.length===1,'native_inventory','Native task or workspace identity is ambiguous');
    const parent=join(stateRoot,name),source=join(parent,'data'),markerPath=join(parent,'owner.json');
    await verifyNativeStateMount({installationId:id,runtimeOwnerId:name,taskId,source,target:NATIVE_STATE_TARGET,markerPath},taskId,{installationId:id,root:stateRoot});
    const workspace=workspaces[0]!;
    const workerMounts=await resolveNativeMounts({workspacePath:workspace,task:matches[0]!.task.spec} as NativeStart,[{source:workspace,target:'/workspaces/task'}]);
    const policyPath=join(parent,'proxy.json');const policyAction=store.getActionByKey('runtime:proxy-policy:'+name);
    await readPrivateFileAsync(policyPath);const policyStat=statSync(policyPath);
    ensure(policyAction?.kind==='runtime.proxy-policy'&&policyAction.completedAt&&policyAction.payload.path===policyPath&&policyAction.payload.dev===policyStat.dev&&policyAction.payload.ino===policyStat.ino,'native_inventory','Proxy policy identity changed or is unresolved');
    const networks:NativeInventoryItem['networks']=[];
    for(const suffix of ['internal','model-egress'] as const){
      const networkName=name+'-'+suffix;const values=JSON.parse(await docker.command(['network','inspect',networkName]));const network=values?.[0];
      ensure(values?.length===1&&/^[a-f0-9]{64}$/.test(network?.Id??'')&&network.Name===networkName&&network.Internal===(suffix==='internal')&&network.Driver==='bridge'&&network.Labels?.['sf.installation']===id,'native_inventory','Native network identity or configuration changed');
      networks.push({id:network.Id,fingerprint:fingerprint({id:network.Id,name:network.Name,internal:network.Internal,driver:network.Driver,labels:network.Labels,options:network.Options??{}})});
    }
    const containers:NativeInventoryItem['containers']=[];
    for(const role of ['native','worker','proxy'] as const) {
      const containerName=name+'-'+role;const expectedImage=images[role];const action=store.getActionByKey('runtime:container:'+containerName);
      ensure(action?.kind==='runtime.container'&&action.completedAt&&action.payload.name===containerName&&action.payload.owner===name&&action.payload.image===expectedImage,'native_inventory','Original container creation is unresolved');
      const actual=JSON.parse(await docker.command(['container','inspect',containerName]));const image=JSON.parse(await docker.command(['image','inspect',expectedImage]));
      const c=actual?.[0];ensure(actual?.length===1&&image?.length===1&&/^[a-f0-9]{64}$/.test(c?.Id??'')&&c.Name==='/'+containerName&&c.Config?.Labels?.['sf.installation']===id&&c.Config.Labels['sf.runtime-owner']===name&&c.Config.Image===expectedImage&&c.Image===image[0]?.Id&&imageMatches(expectedImage,image[0])&&c.HostConfig?.RestartPolicy?.Name==='no'&&c.HostConfig.AutoRemove===false,'native_inventory','Native resource identity or configuration changed');
      const mounts=role==='native'?[{source,target:NATIVE_STATE_TARGET,writable:true}]:role==='worker'?workerMounts:[{source:policyPath,target:'/etc/software-factory/proxy.json',writable:false}];
      ensure(Array.isArray(c.Mounts)&&canonical(c.Mounts.map((m:any)=>({source:m.Source,target:m.Destination,writable:m.RW})))===canonical(mounts)&&c.Mounts.every((m:any)=>m.Type==='bind'),'native_inventory','Native runtime mount changed');
      ensure(c.State&&typeof c.State.Running==='boolean'&&typeof c.State.Paused==='boolean'&&typeof c.State.Pid==='number','native_inventory','Native runtime state unknown');
      containers.push({role,id:c.Id,fingerprint:fingerprint({id:c.Id,image:c.Image,config:c.Config,host:c.HostConfig,mounts:c.Mounts}),stopped:c.State.Running===false&&c.State.Paused===false&&c.State.Pid===0&&c.State.Status==='exited'});
    }
    // Some effects are bound to a repository or container rather than an attempt. Keep
    // them visible for every inventory item instead of guessing their ownership scope.
    const pending=store.pendingActions().filter(a=>['human.relay','lifecycle.human_open','lifecycle.send','lifecycle.quiesce','lifecycle.pause','runtime.api_lifecycle','runtime.native','runtime.start','runtime.container','runtime.proxy-policy','runtime.closeout','worker.execute','worker.pause','worker.resume','worker.maintenance_stop'].includes(a.kind)).map(a=>a.id);
    try {lstatSync(join(parent,'control-start.json'));pending.push('native-control:'+name)} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    result.push({taskId,ownerId:name,pending,containers,networks});
  }
  const listed=(await docker.command(['container','ls','--all','--no-trunc','--filter','label=sf.installation='+id,'--filter','label=sf.runtime-owner','--format','{{.ID}}'])).split('\n').map(v=>v.trim()).filter(Boolean).sort();
  const inspected=result.flatMap(r=>r.containers.map(c=>c.id)).sort();
  ensure(canonical(listed)===canonical(inspected),'native_inventory','Unrecognized or missing labeled native containers retain recovery');
  const listedNetworks=(await docker.command(['network','ls','--no-trunc','--filter','label=sf.installation='+id,'--filter','name=rt-','--format','{{.ID}}'])).split('\n').map(v=>v.trim()).filter(Boolean).sort();
  ensure(canonical(listedNetworks)===canonical(result.flatMap(r=>r.networks.map(n=>n.id)).sort()),'native_inventory','Unrecognized or missing labeled native networks retain recovery');
  ensure(reservations.filter(r=>r.attempt.native).every(r=>result.some(item=>item.taskId===r.attempt.taskId)),'native_inventory','Original native history has no inspectable runtime');
  return result;
}
