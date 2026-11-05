import { closeSync, constants, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Installation } from './locator.ts';
import { loadOwnedService } from './owned-service.ts';
/** Journal explicit intent; E8 must prove physical quiescence before destructive cleanup. */
export async function uninstallInstallation(installation:Installation,options:{systemctl?:string}={}):Promise<void> {
  await loadOwnedService(installation,options);
  const path=join(installation.root,'uninstall-pending.json');
  let fd:number;try{fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600)}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('Uninstall intent is already pending; inspect the retained installation');throw error}
  try{writeFileSync(fd,JSON.stringify({schemaVersion:1,installationId:installation.id,state:'pending'}));fsyncSync(fd)}finally{closeSync(fd)}
  const dir=openSync(installation.root,constants.O_RDONLY);try{fsyncSync(dir)}finally{closeSync(dir)}
}
