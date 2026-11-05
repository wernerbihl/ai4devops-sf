import { join } from 'node:path';
import type { Installation } from '../kestra/deployment.ts';
import type { FactoryStore } from '../storage/store.ts';
import type { AttemptBroker } from '../broker/operations.ts';
import type { RuntimeConfig } from './config.ts';
import { ensure } from '../storage/database.ts';
import { inspectNativeInventory } from './native-inventory.ts';
import { createManagedVsCodeLauncher } from '../owners/managed.ts';
import { stopRecordedNativeOwner } from '../owners/maintenance-receipt.ts';
import { NATIVE_STATE_TARGET } from '../isolation/native-state.ts';
import { createFactoryToolGate } from '../owners/tools.ts';
import { IsolatedToolWorker } from '../owners/worker.ts';
import { stopOwnedProxy } from './native-effects.ts';
/** Uninstall only, after controller-wide admission and human relay drain. Never removes resources. */
export async function stopUninstallNativeResources(input:{installation:Installation;store:FactoryStore;broker:AttemptBroker;config:RuntimeConfig}):Promise<string[]> {
  const {installation,store,broker,config}=input;const template=config.native[0];
  const inventory=()=>inspectNativeInventory({id:installation.id,root:installation.root,docker:installation.docker,store,images:{native:template?.nativeImage??'',worker:template?.workerImage??'',proxy:template?.proxy.image??''}});
  const items=await inventory();const stopped:string[]=[];
  for(const item of items){
    ensure(template&&!item.pending.length,'native_unknown','Native effects must be reconciled before uninstall');
    const attempts=store.getReservations().filter(r=>r.attempt.taskId===item.taskId&&r.attempt.native);
    ensure(attempts.length>0,'native_unknown','Original native history is unavailable');
    const native=item.containers.find(c=>c.role==='native')!,worker=item.containers.find(c=>c.role==='worker')!;
    const workerReceipt=worker.startedAt?store.getActionByKey((worker.frozen?'worker:pause:':'worker:maintenance-stop:')+worker.id+':'+worker.startedAt):undefined;
    ensure(workerReceipt?.completedAt&&((worker.frozen&&workerReceipt.kind==='worker.pause')||(worker.stopped&&workerReceipt.kind==='worker.maintenance_stop')),'native_unknown','Original worker is not proven quiescent');
    const parent=join(installation.root,'native-state',item.ownerId),state={installationId:installation.id,runtimeOwnerId:item.ownerId,taskId:item.taskId,source:join(parent,'data'),target:NATIVE_STATE_TARGET,markerPath:join(parent,'owner.json')};
    const launcher=createManagedVsCodeLauncher({containerId:native.id,runtimeOwnerId:item.ownerId,image:template.nativeImage,entrypoint:template.entrypoint,entrypointSha256:template.entrypointSha256,nativeState:state,nativeStateOwnership:{installationId:installation.id,root:join(installation.root,'native-state')},userDataDir:NATIVE_STATE_TARGET+'/user-data',tokenFile:NATIVE_STATE_TARGET+'/connection-token',port:4317,docker:installation.docker});
    await stopRecordedNativeOwner({directory:parent,launcher,identities:attempts.map(r=>({identity:r.attempt.native!,taskId:r.attempt.taskId,workspacePath:r.attempt.workspacePath,baseSha:r.attempt.baseSha})),container:native,entrypoint:template.entrypoint});stopped.push(native.id);
    const refreshed=(await inventory()).find(value=>value.taskId===item.taskId);ensure(refreshed&&!refreshed.pending.length,'native_unknown','Native resources changed during uninstall');
    const actualWorker=refreshed.containers.find(c=>c.role==='worker')!,proxy=refreshed.containers.find(c=>c.role==='proxy')!;
    ensure(actualWorker.id===worker.id&&actualWorker.fingerprint===worker.fingerprint,'native_unknown','Worker identity changed');
    const gate=createFactoryToolGate({store,broker});const isolated=new IsolatedToolWorker({config:{containerId:actualWorker.id,image:template.workerImage,runtimeOwnerId:item.ownerId,nativeContainerId:native.id,mountTargets:[{source:attempts[0]!.attempt.workspacePath,target:'/workspaces/task'}]},docker:installation.docker,store,gate});
    await isolated.stopForMaintenance();stopped.push(actualWorker.id);
    ensure(proxy.startedAt,'native_unknown','Proxy generation is unavailable');await stopOwnedProxy({store,docker:installation.docker,installationId:installation.id,ownerId:item.ownerId,containerId:proxy.id,fingerprint:proxy.fingerprint,startedAt:proxy.startedAt});stopped.push(proxy.id);
  }
  return stopped;
}
