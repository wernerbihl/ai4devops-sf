import type { Installation } from '../install/locator.ts';
import { loadOwnedService } from '../install/owned-service.ts';
import { dispatchNext, probeController, type NextResult } from './next.ts';

/** Starts only the registered service, then requests one dispatch from its existing controller. */
export async function nextInstallation(installation:Installation,options:{systemctl?:string}={}):Promise<NextResult> {
  const service=await loadOwnedService(installation,options);
  if(await service.status()==='stopped')await service.start();
  let available=false;for(let i=0;i<30;i++){try{await probeController(installation.root);available=true;break}catch{await new Promise(resolve=>setTimeout(resolve,1000))}}
  if(!available)throw new Error('Installed service did not expose its protected controller; inspect the owned service before retrying');
  return dispatchNext(installation.root);
}
