import type { DockerPort } from '../kestra/deployment.ts';
import { kestraImagePins } from '../kestra/deployment.ts';
import type { FactoryStore } from '../storage/store.ts';
import { canonical, ensure, fingerprint } from '../storage/database.ts';
/** Inspect a recorded relay and its exact generation without starting or adopting it. */
export async function inspectOwnedBrokerRelay(input:{id:string;networkId:string;docker:DockerPort;store:FactoryStore}):Promise<{containerId:string;stopped:boolean;startedAt?:string}> {
  const {id,networkId,docker,store}=input;ensure(/^[a-f0-9]{64}$/.test(networkId),'bridge_owner','Exact engine network identity required');
  ensure(!store.pendingActions().some(a=>['broker.relay_create','broker.relay_start','broker.relay_stop'].includes(a.kind)),'bridge_unknown','Original broker relay operation remains unresolved');
  const name='sf-broker-'+fingerprint({installation:id,network:networkId}).slice(0,24);const owner=store.getActionByKey('broker:relay:owner:'+name);
  ensure(owner?.kind==='broker.relay_owner'&&owner.completedAt&&owner.payload.installationId===id&&owner.payload.networkId===networkId&&owner.payload.name===name&&typeof owner.payload.containerId==='string'&&/^[a-f0-9]{64}$/.test(owner.payload.containerId),'bridge_owner','Original broker ownership receipt is unavailable');
  const containerId=owner.payload.containerId;const listed=(await docker.command(['container','ls','--all','--no-trunc','--filter','name=^'+name+'$','--format','{{.ID}}'])).trim();
  ensure(listed===containerId,'bridge_owner','Original broker relay is missing or ambiguous');
  const values=JSON.parse(await docker.command(['container','inspect',containerId]));const image=JSON.parse(await docker.command(['image','inspect',kestraImagePins.worker.image]));const c=values?.[0],h=c?.HostConfig,base=image?.[0];
  ensure(values?.length===1&&image?.length===1&&c.Id===containerId&&c.Name==='/'+name&&c.Image===base?.Id&&base.RepoDigests?.includes(kestraImagePins.worker.image)&&base.Os==='linux'&&base.Architecture==='amd64'&&c.Config?.Image===kestraImagePins.worker.image&&c.Config.User==='1000:1000'&&canonical(c.Config.Cmd)===canonical(['node','-e','setInterval(()=>{},2147483647)'])&&canonical(c.Config.Entrypoint??null)===canonical(base.Config?.Entrypoint??null)&&canonical(c.Config.Env??[])===canonical(base.Config?.Env??[])&&c.Config.Labels?.['sf.installation']===id&&c.Config.Labels?.['sf.component']==='attempt-broker'&&c.Config.Labels?.['sf.network']===networkId,'bridge_owner','Broker relay image or identity changed');
  ensure(h?.NetworkMode===networkId&&h.ReadonlyRootfs&&!h.Privileged&&canonical(h.CapDrop)===canonical(['ALL'])&&canonical(h.SecurityOpt)===canonical(['no-new-privileges'])&&h.RestartPolicy?.Name==='no'&&h.AutoRemove===false&&h.PidsLimit===64&&h.Memory===268435456&&h.NanoCpus===1000000000&&Array.isArray(c.Mounts)&&c.Mounts.length===0,'bridge_owner','Broker relay containment changed');
  ensure(!h.CapAdd?.length&&!h.PidMode&&(!h.IpcMode||h.IpcMode==='private')&&!h.Devices?.length&&!h.DeviceRequests?.length&&!h.ExtraHosts?.length&&!h.Dns?.length&&!h.Links?.length&&!h.VolumesFrom?.length&&!Object.keys(h.PortBindings??{}).length&&!Object.keys(h.Sysctls??{}).length&&!h.Binds?.length,'bridge_owner','Broker relay effective restrictions changed');
  ensure(c.State&&typeof c.State.Running==='boolean'&&c.State.Paused===false,'bridge_owner','Broker relay state is unknown');
  const networks=JSON.parse(await docker.command(['network','inspect',networkId]));const network=networks?.[0],attached=c.NetworkSettings?.Networks;
  ensure(networks?.length===1&&network?.Id===networkId&&network.Internal===true&&network.Driver==='bridge'&&network.Labels?.['sf.installation']===id&&attached&&Object.keys(attached).length===1&&attached[network.Name]&&(attached[network.Name].NetworkID===networkId||!c.State.Running&&attached[network.Name].NetworkID==='')&&attached[network.Name].Aliases?.includes('sf-broker'),'bridge_owner','Broker relay network changed');
  if(c.State.Running||c.State.Status==='exited'){const startedAt=c.State.StartedAt;const generation=typeof startedAt==='string'?store.getActionByKey('broker:relay:generation:'+containerId+':'+startedAt):undefined;ensure(generation?.kind==='broker.relay_generation'&&generation.completedAt&&generation.payload.installationId===id&&generation.payload.containerId===containerId&&generation.payload.networkId===networkId&&generation.payload.startedAt===startedAt,'bridge_unknown','Broker relay generation is unrecorded');}
  return {containerId,stopped:c.State.Running===false&&c.State.Pid===0&&['created','exited'].includes(c.State.Status),...(typeof c.State.StartedAt==='string'?{startedAt:c.State.StartedAt}:{})};
}
/** Caller must first close/drain the private bridge. A lost stop reply retains exclusion. */
export async function stopOwnedBrokerRelay(input:{id:string;networkId:string;docker:DockerPort;store:FactoryStore}):Promise<void>{
  const before=await inspectOwnedBrokerRelay(input);if(before.stopped)return;
  ensure(before.startedAt,'bridge_unknown','Broker process generation unavailable');
  const action=input.store.enqueueAction({key:'broker:relay:stop:'+before.containerId+':'+before.startedAt,kind:'broker.relay_stop',payload:{installationId:input.id,containerId:before.containerId,networkId:input.networkId,startedAt:before.startedAt}});
  ensure(!action.completedAt,'bridge_unknown','Previously stopped broker generation reappeared');
  await input.docker.command(['container','stop','--time','10',before.containerId]);
  const after=JSON.parse(await input.docker.command(['container','inspect',before.containerId]));const state=after?.[0]?.State;
  ensure(after?.length===1&&after[0].Id===before.containerId&&state?.Running===false&&state.Paused===false&&state.Pid===0&&state.Status==='exited','bridge_unknown','Broker stop is not proven');
  input.store.completeAction(action.id);
}
