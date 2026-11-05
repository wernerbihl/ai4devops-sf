import { closeSync, constants, fsyncSync, openSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Installation } from './locator.ts';
import { writeWindowsPrivateFile } from '../platform/windows-private.ts';
import { loadOwnedService } from './owned-service.ts';
import { readPrivateFileAsync } from '../service/config.ts';
import { requestMaintenance, requestOwnedCleanup, requestCleanupStatus } from './maintenance-client.ts';
export interface CleanupReport { removed:string[]; blocked:{kind:string;identity:string}[] }
/** Journal explicit intent; E8 must prove physical quiescence before destructive cleanup. */
export async function uninstallInstallation(installation:Installation,options:{systemctl?:string}={}):Promise<CleanupReport> {
  await loadOwnedService(installation,options);
  const path=join(installation.root,'uninstall-pending.json');
  const value=JSON.stringify({schemaVersion:1,installationId:installation.id,state:'pending'});
  try {if(process.platform==='win32')writeWindowsPrivateFile(path,Buffer.from(value));else {const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,value);fsyncSync(fd)}finally{closeSync(fd)}const dir=openSync(installation.root,constants.O_RDONLY);try{fsyncSync(dir)}finally{closeSync(dir)}}}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const existing=JSON.parse((await readPrivateFileAsync(path)).toString());if(existing.schemaVersion!==1||existing.installationId!==installation.id||existing.state!=='pending')throw new Error('Uninstall intent requires recovery')}
  let maintenance:Awaited<ReturnType<typeof requestMaintenance>>;try{maintenance=await requestMaintenance(installation.root,'uninstall')}catch{return {removed:[],blocked:[{kind:'control',identity:'private-controller-unconfirmed'}]}}
  if(maintenance.state!=='engine_stopped')return {removed:[],blocked:maintenance.blocked};
  let cleanup:Awaited<ReturnType<typeof requestOwnedCleanup>>;try{cleanup=await requestOwnedCleanup(installation.root)}catch{try{return await requestCleanupStatus(installation.root)}catch{return {removed:[],blocked:[{kind:'effect',identity:'cleanup-outcome-unconfirmed'}]}}}
  return {removed:cleanup.removed,blocked:readdirSync(installation.root).map(name=>({kind:'retained',identity:join(installation.root,name)}))};
}
