import { closeSync, constants, fsyncSync, openSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Installation } from './locator.ts';
import { writeWindowsPrivateFile } from '../platform/windows-private.ts';
import { loadOwnedService } from './owned-service.ts';
import { readPrivateFileAsync } from '../service/config.ts';
import { requestMaintenance, requestOwnedCleanup, requestCleanupStatus } from './maintenance-client.ts';
import { retireOwnedService } from './service-retirement.ts';
import { removeOwnedRuntime } from './owned-file-cleanup.ts';
import { probeController } from '../cli/next.ts';
import { ProcessDocker, type DockerPort } from '../kestra/deployment.ts';
import { acquireAdministrationLock, assertNoPendingReconfiguration, assertNoPendingStart, recordServiceStart } from './administration.ts';
export interface CleanupReport { removed:string[]; blocked:{kind:string;identity:string}[] }
/** Journal explicit intent; E8 must prove physical quiescence before destructive cleanup. */
export async function uninstallInstallation(installation:Installation,options:{systemctl?:string;docker?:DockerPort;adminDirectory?:string}={}):Promise<CleanupReport> {
  const administration=await acquireAdministrationLock(installation.id,options.adminDirectory);try{await assertNoPendingReconfiguration(installation.root,installation.id,options.adminDirectory);await assertNoPendingStart(installation.root,installation.id,options.adminDirectory);
  const owner=JSON.parse((await readPrivateFileAsync(join(installation.root,'install-owner.json'))).toString());if(owner.schemaVersion!==1||owner.installationId!==installation.id||owner.root!==installation.root)throw new Error('Installation ownership does not match');
  try{const journal=JSON.parse((await readPrivateFileAsync(join(installation.root,'uninstall-service.json'))).toString());if(journal.schemaVersion!==1||journal.installationId!==installation.id||journal.root!==installation.root||typeof journal.service!=='string'||!Array.isArray(journal.resources)||!journal.resources.every((x:unknown)=>typeof x==='string'&&/^(container|network):[a-f0-9]{64}$/.test(x)))throw new Error('Service cleanup record is invalid');if(journal.state!=='complete')return {removed:journal.resources,blocked:[{kind:'effect',identity:'service-removal-unconfirmed'}]};const removed=[...journal.resources,journal.service];try{const runtime=JSON.parse((await readPrivateFileAsync(join(installation.root,'uninstall-runtime.json'))).toString());if(runtime.installationId===installation.id&&runtime.path===join(installation.root,'runtime')&&runtime.state==='complete')removed.push('path:'+runtime.path)}catch{}return {removed,blocked:readdirSync(installation.root).map(name=>({kind:name==='vscode-profile'?'unverified companion profile process':'retained',identity:join(installation.root,name)}))}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  const service=await loadOwnedService(installation,options);
  const path=join(installation.root,'uninstall-pending.json');
  const value=JSON.stringify({schemaVersion:1,installationId:installation.id,state:'pending'});
  try {if(process.platform==='win32')writeWindowsPrivateFile(path,Buffer.from(value));else {const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,value);fsyncSync(fd)}finally{closeSync(fd)}const dir=openSync(installation.root,constants.O_RDONLY);try{fsyncSync(dir)}finally{closeSync(dir)}}}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const existing=JSON.parse((await readPrivateFileAsync(path)).toString());if(existing.schemaVersion!==1||existing.installationId!==installation.id||existing.state!=='pending')throw new Error('Uninstall intent requires recovery')}
  try{if(await service.status()==='stopped'){await recordServiceStart(installation.root,installation.id,'pending',options.adminDirectory);await service.start();let available=false;for(let i=0;i<30;i++){try{await probeController(installation.root);available=true;break}catch{await new Promise(resolve=>setTimeout(resolve,1000))}}if(!available)throw Error('Uninstall controller start is unconfirmed');await recordServiceStart(installation.root,installation.id,'complete',options.adminDirectory)}}catch{return {removed:[],blocked:[{kind:'effect',identity:'service-start-unconfirmed'}]}}
  let maintenance:Awaited<ReturnType<typeof requestMaintenance>>;try{maintenance=await requestMaintenance(installation.root,'uninstall')}catch{return {removed:[],blocked:[{kind:'control',identity:'private-controller-unconfirmed'}]}}
  if(maintenance.state!=='engine_stopped'){try{const status=await requestCleanupStatus(installation.root);return {removed:status.removed,blocked:[...status.blocked,...maintenance.blocked]}}catch{return {removed:[],blocked:maintenance.blocked}}}
  let cleanup:Awaited<ReturnType<typeof requestOwnedCleanup>>;try{cleanup=await requestOwnedCleanup(installation.root)}catch{try{return await requestCleanupStatus(installation.root)}catch{return {removed:[],blocked:[{kind:'effect',identity:'cleanup-outcome-unconfirmed'}]}}}
  let retirement:Awaited<ReturnType<typeof retireOwnedService>>;try{retirement=await retireOwnedService(installation,service,cleanup.removed)}catch{return {removed:cleanup.removed,blocked:[{kind:'effect',identity:'service-removal-unconfirmed'}]}}
  const removed=[...cleanup.removed,retirement.removed],blocked:{kind:string;identity:string}[]=[];
  try{try{const startup=JSON.parse((await readPrivateFileAsync(join(installation.root,'startup.json'))).toString());const result=await removeOwnedRuntime({id:installation.id,root:installation.root,docker:options.docker??new ProcessDocker(startup.dockerExecutable??'docker')});removed.push(...result.removed);blocked.push(...result.blocked)}catch{blocked.push({kind:'retained',identity:join(installation.root,'runtime')})}}finally{retirement.release()}
  blocked.push(...readdirSync(installation.root).filter(name=>name!=='runtime'||!blocked.some(item=>item.identity===join(installation.root,name))).map(name=>({kind:name==='vscode-profile'?'unverified companion profile process':'retained',identity:join(installation.root,name)})));return {removed,blocked};
  }finally{administration.close()}
}
