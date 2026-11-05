import { randomUUID } from 'node:crypto';
import type { FactoryStore, OutboxAction } from '../storage/store.ts';
import { ensure, fingerprint } from '../storage/database.ts';
import type { DockerPort } from '../kestra/deployment.ts';
export type NativeMutation = 'network-create'|'container-create'|'container-start'|'network-connect'|'container-stop';
function assertSettled(store:FactoryStore){ensure(!store.pendingActions().some(a=>a.kind==='runtime.native_mutation'||a.kind==='runtime.container'),'native_unknown','Original native resource mutation remains unresolved')}
/** A durable intent precedes each native provisioning mutation; unknown actions retain exclusion. */
export function beginNativeMutation(store:FactoryStore,operation:NativeMutation,identity:string):OutboxAction {
  assertSettled(store);
  return store.enqueueAction({key:'runtime:native-mutation:'+randomUUID(),kind:'runtime.native_mutation',payload:{operation,identity}});
}
/** Stop only the previously inventoried proxy, retaining uncertain acknowledgement. */
export async function stopOwnedProxy(input:{store:FactoryStore;docker:DockerPort;installationId:string;ownerId:string;containerId:string;fingerprint:string;startedAt:string}):Promise<void> {
  const {store,docker,installationId,ownerId,containerId,startedAt}=input;assertSettled(store);
  const inspect=async()=>{const values=JSON.parse(await docker.command(['container','inspect',containerId]));const c=values?.[0];ensure(values?.length===1&&c?.Id===containerId&&c.Config?.Labels?.['sf.installation']===installationId&&c.Config.Labels['sf.runtime-owner']===ownerId&&c.HostConfig?.RestartPolicy?.Name==='no'&&c.HostConfig.AutoRemove===false&&fingerprint({id:c.Id,image:c.Image,config:c.Config,host:c.HostConfig,mounts:c.Mounts})===input.fingerprint&&c.State?.StartedAt===startedAt,'native_unknown','Original proxy identity changed');return c};
  const before=await inspect();assertSettled(store);
  if(!before.State.Running){const receipt=store.getActionByKey('runtime:proxy-stop:'+containerId+':'+startedAt);ensure(before.State.Paused===false&&before.State.Pid===0&&before.State.Status==='exited'&&receipt?.kind==='runtime.proxy_stop'&&receipt.completedAt,'native_unknown','Proxy stopped state lacks a receipt');return}
  ensure(before.State.Paused===false&&before.State.Pid>0,'native_unknown','Proxy state unavailable');
  const intent=beginNativeMutation(store,'container-stop',containerId);await docker.command(['container','stop','--time','10',containerId]);
  const after=await inspect();ensure(after.State.Running===false&&after.State.Paused===false&&after.State.Pid===0&&after.State.Status==='exited','native_unknown','Proxy stop is not confirmed');
  const receipt=store.enqueueAction({key:'runtime:proxy-stop:'+containerId+':'+startedAt,kind:'runtime.proxy_stop',payload:{installationId,ownerId,containerId,startedAt}});store.completeAction(receipt.id);store.completeAction(intent.id);
}
