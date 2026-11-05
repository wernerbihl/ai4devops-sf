import { existsSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateContract } from '../contracts/schemas.ts';
import { assertWindowsPrivateFile, protectWindowsDirectory, readWindowsSecret, replaceWindowsSecret, writeWindowsPrivateFile, writeWindowsSecret } from '../platform/windows-private.ts';
import type { AuthRecord, CredentialStore } from './store.ts';

const queues=new Map<string,Promise<unknown>>();
/** CurrentUser DPAPI protects the complete record; the synchronous save callback is durably awaited by callers. */
export function createWindowsCredentialStore(directory:string):CredentialStore {
 if(!isAbsolute(directory))throw new Error('Absolute protected authentication directory required');directory=resolve(directory);const file=join(directory,'auth.dpapi');
 function prepare(){protectWindowsDirectory(directory)}
 function load():AuthRecord {
  if(!existsSync(file))return {version:1,state:{status:'unavailable',reasons:['Probe GitHub authentication to verify the selected account']},flows:{},outcomes:{}};
  try {const value=JSON.parse(readWindowsSecret(file).toString('utf8')) as AuthRecord;if(value.version!==1||!value.state||!value.flows||!value.outcomes)throw Error();validateContract('AuthState',value.state);if(value.selected&&(!/^\d+$/.test(value.selected.accountId)||!/^[a-z\d][a-z\d-]{0,38}$/i.test(value.selected.login)))throw Error();return value}
  catch{throw new Error('Protected GitHub authentication record is unavailable or invalid')}
 }
 function save(record:AuthRecord):void {
  const data=Buffer.from(JSON.stringify(record));if(data.length>4*1024*1024)throw new Error('Authentication journal capacity reached');
  try{if(existsSync(file))replaceWindowsSecret(file,data);else writeWindowsSecret(file,data)}finally{data.fill(0)}
 }
 return {protectsSecrets:true,async read(){prepare();return load()},async run<T>(action:(record:AuthRecord,save:()=>void)=>Promise<T>):Promise<T>{
  const previous=queues.get(directory)??Promise.resolve();const result=previous.catch(()=>{}).then(async()=>{
   prepare();const lock=join(directory,'.lock.sqlite');if(!existsSync(lock))writeWindowsPrivateFile(lock,Buffer.alloc(0));assertWindowsPrivateFile(lock);
   const db=new DatabaseSync(lock);let acquired=false;try{db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');acquired=true;const record=load();return await action(record,()=>save(record))}catch(error){if(!acquired)throw new Error('Authentication storage is busy or unavailable');throw error}finally{try{if(acquired)db.exec('ROLLBACK')}finally{db.close()}}
  });queues.set(directory,result);try{return await result}finally{if(queues.get(directory)===result)queues.delete(directory)}
 }};
}
