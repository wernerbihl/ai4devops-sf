import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { readPrivateFile } from '../service/config.ts';
import { assertWindowsPrivateDirectory, replaceWindowsPrivateFile, writeWindowsPrivateFile } from '../platform/windows-private.ts';
import { installationLocatorPath } from './locator.ts';
export interface SetupDefaults {directory:string;taktSeconds:number;ownerId:'vscode';providers:('copilot'|'codex')[];codeExecutable:string;dockerExecutable?:string}
function check(value:SetupDefaults):SetupDefaults {
 if(!value||typeof value!=='object'||Object.keys(value).some(k=>!['directory','taktSeconds','ownerId','providers','codeExecutable','dockerExecutable'].includes(k))||typeof value.directory!=='string'||!isAbsolute(value.directory)||!Number.isSafeInteger(value.taktSeconds)||value.taktSeconds<1||value.taktSeconds>86400||value.ownerId!=='vscode'||!Array.isArray(value.providers)||!value.providers.includes('copilot')||new Set(value.providers).size!==value.providers.length||value.providers.some(p=>!['copilot','codex'].includes(p))||typeof value.codeExecutable!=='string'||!isAbsolute(value.codeExecutable)||(value.dockerExecutable!==undefined&&(typeof value.dockerExecutable!=='string'||!isAbsolute(value.dockerExecutable))))throw new Error('Invalid stored setup defaults');return value;
}
export function loadDefaults(path=join(dirname(installationLocatorPath()),'defaults.json')):SetupDefaults|null {
 if(process.platform==='win32'&&!existsSync(path))return null;
 try{return check(JSON.parse(readPrivateFile(path).toString()) as SetupDefaults)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error}
}
/** Persist nonsecret defaults only after a successful confirmed installation. */
export function saveDefaults(value:SetupDefaults,path=join(dirname(installationLocatorPath()),'defaults.json')):void {
 check(value);if(process.platform==='win32'){assertWindowsPrivateDirectory(dirname(path));const data=Buffer.from(JSON.stringify(value));if(existsSync(path))replaceWindowsPrivateFile(path,data);else writeWindowsPrivateFile(path,data);return}
 const directory=dirname(path);const stat=lstatSync(directory);
 if(realpathSync(directory)!==directory||!stat.isDirectory()||stat.uid!==process.getuid!()||(stat.mode&0o077)!==0)throw new Error('Private defaults directory required');
 try{readPrivateFile(path)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
 const temp=join(directory,`.defaults-${randomUUID()}.tmp`);const fd=openSync(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);let opened=true;let renamed=false;
 try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);closeSync(fd);opened=false;renameSync(temp,path);renamed=true;const dir=openSync(directory,constants.O_RDONLY);try{fsyncSync(dir)}finally{closeSync(dir)}}finally{if(opened)closeSync(fd);if(!renamed)try{unlinkSync(temp)}catch{}}
}
