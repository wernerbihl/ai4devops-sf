import { constants, closeSync, fsyncSync, lstatSync, openSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { DockerPort } from '../kestra/deployment.ts';
import { ensure } from '../storage/database.ts';
import { readCreatedPaths } from './ownership.ts';
import { replaceWindowsPrivateFileAsync, writeWindowsPrivateFileAsync } from '../platform/windows-private.ts';

/** Caller holds the controller singleton after uninstall writer proof and service removal. */
export async function removeOwnedRuntime(input:{id:string;root:string;docker:DockerPort}):Promise<{removed:string[];blocked:{kind:string;identity:string}[]}>{
 const entry=(await readCreatedPaths(input)).find(item=>item.path==='runtime'&&item.kind==='directory');ensure(entry,'cleanup_owner','Original runtime ownership unavailable');const ownedEntry=entry;const path=join(input.root,'runtime');
 const ids=(await input.docker.command(['container','ls','--all','--no-trunc','--format','{{.ID}}'])).split('\n').map(s=>s.trim()).filter(Boolean);ensure(new Set(ids).size===ids.length&&ids.every(id=>/^[a-f0-9]{64}$/.test(id)),'cleanup_mount','Container inventory unavailable');const blocked:{kind:string;identity:string}[]=[];
 const contains=(parent:string,child:string)=>{const r=relative(parent,child);return r===''||r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r)};
 for(const id of ids){const values=JSON.parse(await input.docker.command(['container','inspect',id]));const c=values?.[0];ensure(values?.length===1&&c?.Id===id&&Array.isArray(c.Mounts),'cleanup_mount','Container mount inventory unavailable');for(const mount of c.Mounts){if(mount.Type==='tmpfs')continue;ensure((mount.Type==='bind'||mount.Type==='volume')&&typeof mount.Source==='string'&&isAbsolute(mount.Source),'cleanup_mount','Unknown container mount');if(contains(mount.Source,path)||contains(path,mount.Source)){blocked.push({kind:'mount',identity:id});break}}}
 if(blocked.length)return {removed:[],blocked};
 function inspectTree(current:string){const s=lstatSync(current);ensure(!s.isSymbolicLink()&&s.dev===ownedEntry.dev&&realpathSync(current)===current&&(s.isDirectory()||s.isFile())&&(process.platform==='win32'||s.uid===process.getuid!()),'cleanup_path','Owned runtime contains an unsafe entry');if(s.isDirectory())for(const name of readdirSync(current))inspectTree(join(current,name))}inspectTree(path);
 const journalPath=join(input.root,'uninstall-runtime.json');async function journal(state:'pending'|'complete'){const bytes=Buffer.from(JSON.stringify({schemaVersion:1,installationId:input.id,path,dev:ownedEntry.dev,ino:ownedEntry.ino,state}));if(process.platform==='win32'){if(state==='pending')await writeWindowsPrivateFileAsync(journalPath,bytes);else await replaceWindowsPrivateFileAsync(journalPath,bytes);return}const target=state==='pending'?journalPath:join(input.root,'.uninstall-runtime.tmp');const fd=openSync(target,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,bytes);fsyncSync(fd)}finally{closeSync(fd)}if(state==='complete')renameSync(target,journalPath);const dir=openSync(input.root,constants.O_RDONLY);try{fsyncSync(dir)}finally{closeSync(dir)}}
 await journal('pending');const current=lstatSync(path);ensure(current.dev===ownedEntry.dev&&current.ino===ownedEntry.ino&&current.isDirectory()&&!current.isSymbolicLink(),'cleanup_path','Owned runtime changed');rmSync(path,{recursive:true});await journal('complete');return {removed:['path:'+path],blocked:[]};
}
