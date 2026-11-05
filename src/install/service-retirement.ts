import { constants, openSync, closeSync, fsyncSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Installation } from './locator.ts';
import type { LinuxStartup } from './service-linux.ts';
import type { MacOSStartup } from './service-macos.ts';
import type { WindowsStartup } from './service-windows.ts';
import { readPrivateFileAsync } from '../service/config.ts';
import { writeWindowsPrivateFileAsync, replaceWindowsPrivateFileAsync } from '../platform/windows-private.ts';
import { acquireInstallationSingletonAsync } from '../service/singleton.ts';
import { ensure } from '../storage/database.ts';

/** Called only after the original controller confirms uninstall quiescence and Docker cleanup. */
export async function retireOwnedService(installation:Installation,service:LinuxStartup|MacOSStartup|WindowsStartup,resources:string[]=[]):Promise<{removed:string;release():void}>{
 const path=join(installation.root,'uninstall-service.json');const serviceName='service:'+('unitName' in service?service.unitName:'label' in service?service.label:'AI4DevOps-SF-'+installation.id);
 async function journal(state:'pending'|'complete'){
  const bytes=Buffer.from(JSON.stringify({schemaVersion:1,installationId:installation.id,root:installation.root,service:serviceName,resources,state}));
  if(process.platform==='win32'){if(state==='pending')await writeWindowsPrivateFileAsync(path,bytes);else await replaceWindowsPrivateFileAsync(path,bytes);return}
  const target=state==='pending'?path:join(installation.root,'.uninstall-service.tmp');const fd=openSync(target,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,bytes);fsyncSync(fd)}finally{closeSync(fd)}if(state==='complete')renameSync(target,path);const dir=openSync(installation.root,constants.O_RDONLY);try{fsyncSync(dir)}finally{closeSync(dir)}
 }
 await readPrivateFileAsync(join(installation.root,'controller-lock.sqlite'));
 await journal('pending');
 if(await service.status()==='running')await service.stop();
 let stopped=false;for(let i=0;i<100;i++){if(await service.status()==='stopped'){stopped=true;break}await new Promise(resolve=>setTimeout(resolve,100))}ensure(stopped,'cleanup_service','Service stop remains unconfirmed');
 const lock=await acquireInstallationSingletonAsync(installation.root);try{await service.remove();await journal('complete');return {removed:serviceName,release:()=>lock.close()}}catch(error){lock.close();throw error}
}
