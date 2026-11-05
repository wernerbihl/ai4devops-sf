import type { DockerPort } from '../kestra/deployment.ts';
import type { FactoryStore } from '../storage/store.ts';
import { ensure, fingerprint } from '../storage/database.ts';

export type InventoriedResource = {kind:'container';id:string;fingerprint:string;startedAt:string}|{kind:'network';id:string;fingerprint:string};
/** Caller must hold the maintenance singleton and supply a fresh, fully verified inventory. */
export async function removeInventoriedResources(input:{id:string;docker:DockerPort;store:FactoryStore;resources:InventoriedResource[]}):Promise<string[]>{
 const removed:string[]=[];ensure(new Set(input.resources.map(r=>r.id)).size===input.resources.length,'cleanup_owner','Duplicate resource identity');
 for(const resource of input.resources){
  ensure(/^[a-f0-9]{64}$/.test(resource.id)&&/^[a-f0-9]{64}$/.test(resource.fingerprint),'cleanup_owner','Invalid resource identity');
  const key='maintenance:remove:'+resource.kind+':'+resource.id;ensure(!input.store.getActionByKey(key),'cleanup_unknown','A prior removal requires recovery');
  const values=JSON.parse(await input.docker.command([resource.kind,'inspect',resource.id]));const actual=values?.[0];ensure(values?.length===1&&actual?.Id===resource.id,'cleanup_owner','Inventoried resource changed');
  if(resource.kind==='container'){
   ensure(actual.Config?.Labels?.['sf.installation']===input.id&&actual.State?.Running===false&&actual.State.Paused===false&&actual.State.Pid===0&&actual.State.Status==='exited'&&actual.State.StartedAt===resource.startedAt&&actual.HostConfig?.RestartPolicy?.Name==='no'&&fingerprint({id:actual.Id,image:actual.Image,config:actual.Config,host:actual.HostConfig,mounts:actual.Mounts})===resource.fingerprint,'cleanup_owner','Original container is not proven stopped');
  }else ensure(actual.Labels?.['sf.installation']===input.id&&fingerprint({id:actual.Id,name:actual.Name,internal:actual.Internal,driver:actual.Driver,labels:actual.Labels,options:actual.Options??{}})===resource.fingerprint,'cleanup_owner','Original network changed');
  const action=input.store.enqueueAction({key,kind:'maintenance.remove',payload:{installationId:input.id,...resource}});
  await input.docker.command([resource.kind,'rm',resource.id]);
  const ids=(await input.docker.command([resource.kind,'ls','--no-trunc',...(resource.kind==='container'?['--all']:[]),'--format','{{.ID}}'])).split('\n').map(v=>v.trim()).filter(Boolean);
  ensure(ids.every(id=>/^[a-f0-9]{64}$/.test(id))&&!ids.includes(resource.id),'cleanup_unknown','Removal not confirmed');input.store.completeAction(action.id);removed.push(resource.kind+':'+resource.id);
 }
 return removed;
}
