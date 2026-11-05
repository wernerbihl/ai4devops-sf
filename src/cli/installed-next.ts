import type { Installation } from '../install/locator.ts';
import { loadOwnedService } from '../install/owned-service.ts';
import { dispatchNext, probeController, type NextResult } from './next.ts';
import { acquireAdministrationLock, assertNoPendingStart, assertNoPendingReconfiguration, assertNoUninstall, recordServiceStart } from '../install/administration.ts';

/** Starts only the registered service, then requests one dispatch from its existing controller. */
export async function nextInstallation(installation:Installation,options:{systemctl?:string;adminDirectory?:string}={}):Promise<NextResult> {
  const lock=await acquireAdministrationLock(installation.id,options.adminDirectory);try{
  await assertNoUninstall(installation.root);await assertNoPendingReconfiguration(installation.root,installation.id,options.adminDirectory);await assertNoPendingStart(installation.root,installation.id,options.adminDirectory);
  const service=await loadOwnedService(installation,options);
  const start=await service.status()==='stopped';if(start){await recordServiceStart(installation.root,installation.id,'pending',options.adminDirectory);await service.start()}
  let available=false;for(let i=0;i<30;i++){try{await probeController(installation.root);available=true;break}catch{await new Promise(resolve=>setTimeout(resolve,1000))}}
  if(!available)throw new Error('Installed service did not expose its protected controller; inspect the owned service before retrying');
  if(start)await recordServiceStart(installation.root,installation.id,'complete',options.adminDirectory);
  return await dispatchNext(installation.root);
  }finally{lock.close()}
}
