import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { assertWindowsPrivateDirectoryAsync, assertWindowsPrivateFileAsync } from '../platform/windows-private.ts';
import { readPrivateFileAsync } from '../service/config.ts';
import { canonical } from '../storage/database.ts';
import type { NativeIdentity } from '../contracts/domain.ts';
import { nativeProcessIdentity } from './managed.ts';
/** Read a retained receipt without connecting to, starting, or unpausing its native owner. */
export async function inspectRecordedOwnerReceipt(input:{directory:string;identity:NativeIdentity;taskId:string;workspacePath:string;baseSha:string;container:{id:string;stopped:boolean;frozen:boolean;pid:number;startedAt?:string};entrypoint?:string}):Promise<'stopped'|'waiting'|'unknown'> {
  try {
    const {directory,identity,taskId,workspacePath,baseSha,container}=input;
    if(resolve(directory)!==directory||realpathSync(directory)!==directory)return 'unknown';
    const dir=lstatSync(directory);if(!dir.isDirectory()||dir.isSymbolicLink())return 'unknown';
    if(process.platform==='win32')await assertWindowsPrivateDirectoryAsync(directory);else if(dir.uid!==process.getuid!()||(dir.mode&0o077)!==0)return 'unknown';
    const control=join(directory,'control-start.json');
    const absent=(path:string)=>{try{lstatSync(path);return false}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return true;throw error}};
    if(!absent(control))return 'unknown';
    const path=join(directory,'owner.sqlite');
    const verifyFile=async(file:string)=>{const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||realpathSync(file)!==file)throw Error('unsafe');if(process.platform==='win32')await assertWindowsPrivateFileAsync(file);else if(stat.uid!==process.getuid!()||(stat.mode&0o077)!==0)throw Error('unsafe')};
    await verifyFile(path);const wal=!absent(path+'-wal'),shm=!absent(path+'-shm');if(wal&&!shm)return 'unknown';if(wal)await verifyFile(path+'-wal');if(shm)await verifyFile(path+'-shm');
    const db=new DatabaseSync(path,{readOnly:true});let hasReceipt=false;
    try {
      const sessions=db.prepare('SELECT body FROM sessions').all().map(row=>JSON.parse(String(row.body))).filter(value=>canonical(value.identity)===canonical(identity));
      if(sessions.length!==1||sessions[0].taskId!==taskId||sessions[0].sessionId!==identity.sessionId||sessions[0].directory!==pathToFileURL('/workspaces/task').href||sessions[0].workspacePath!==workspacePath||sessions[0].baseSha!==baseSha||sessions[0].ownerId!==identity.ownerId||sessions[0].providerId!==identity.providerId||Number(db.prepare('SELECT COUNT(*) AS count FROM actions WHERE done=0').get()!.count)!==0)return 'unknown';
      const table=container.stopped?'stopped':container.frozen?'paused':undefined;if(!table)return 'unknown';
      hasReceipt=!!db.prepare(`SELECT identity FROM ${table} WHERE identity=?`).get(canonical(identity));
    } finally {db.close()}
    if(!hasReceipt||!absent(control))return 'unknown';
    if(container.stopped&&container.pid===0)return 'stopped';
    if(!container.frozen||!container.startedAt||!input.entrypoint)return 'unknown';
    const proof=JSON.parse((await readPrivateFileAsync(join(directory,'control-pause.json'))).toString());
    if(proof.schemaVersion!==1||proof.runtimeId!==container.id||proof.containerPid!==container.pid||proof.startedAt!==container.startedAt||!proof.native||proof.native.entrypoint!==input.entrypoint||proof.processIdentity!==nativeProcessIdentity(proof.native)||!absent(control))return 'unknown';
    return 'waiting';
  } catch {return 'unknown'}
}
