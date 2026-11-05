import { randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, fsyncSync, lstatSync, realpathSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readPrivateFile, readVaultSecret } from '../service/config.ts';

function privateEndpoint(root:string):{url:URL;secret:Buffer} {
  const control = JSON.parse(readPrivateFile(join(root, 'control.json')).toString()) as { schemaVersion?: unknown; url?: unknown };
  if (control.schemaVersion !== 1 || typeof control.url !== 'string') throw new Error('Invalid private controller address');
  const url = new URL(control.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid private controller address');
  const secret = readVaultSecret(root, 'private-control');
  if (secret.length < 32) throw new Error('Invalid private controller key');
  return {url,secret};
}
/** Read-only proof that the installed controller, not a second adopter, is responding. */
export async function probeController(root:string):Promise<void> {
  const {url,secret}=privateEndpoint(root);
  const response=await fetch(new URL('/health',url),{headers:{authorization:`Bearer ${secret.toString('base64url')}`},redirect:'error',signal:AbortSignal.timeout(2000)});
  if(!response.ok)throw new Error('Private controller is unavailable');
}
async function privateRequest(root: string, path: '/next' | '/dispatch-status', key: string): Promise<unknown> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(key)) throw new Error('A stable dispatch key is required');
  const {url,secret}=privateEndpoint(root);
  const response = await fetch(new URL(path, url), {
    method: 'POST', headers: { authorization: `Bearer ${secret.toString('base64url')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ key }), redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Private dispatch was not confirmed; inspect retained actions before retrying');
  return response.json();
}
/** Sends one request only. A lost reply is uncertain and must not be retried blindly. */
export async function requestNext(root: string, key: string): Promise<unknown> { return privateRequest(root, '/next', key); }

interface NextRecord { schemaVersion: 1; state: 'pending' | 'complete'; key: string; body?: unknown }
function lockNext(root: string): () => void {
  if (process.platform === 'win32') throw new Error('Windows protected CLI state is unavailable');
  const directory = lstatSync(root);
  if (resolve(root) !== root || realpathSync(root) !== root || !directory.isDirectory() || directory.uid !== process.getuid!() || (directory.mode & 0o077) !== 0) throw new Error('Unsafe installation directory');
  const path = join(root,'cli-next-lock.sqlite');
  try { const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);closeSync(fd); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; readPrivateFile(path); }
  const db = new DatabaseSync(path);
  try { chmodSync(path,0o600); db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE'); }
  catch { db.close(); throw new Error('Another next command is already in progress'); }
  return () => { try {db.exec('ROLLBACK')} finally {db.close()} };
}
function readRecord(root: string): NextRecord | undefined {
  let bytes: Buffer;
  try { bytes=readPrivateFile(join(root,'cli-next.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const value=JSON.parse(bytes.toString()) as NextRecord;
  if (!value || typeof value!=='object' || Array.isArray(value) || value.schemaVersion!==1 || !['pending','complete'].includes(value.state) || typeof value.key!=='string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value.key) || Object.keys(value).some(k=>!['schemaVersion','state','key','body'].includes(k)) || value.state==='pending' && Object.hasOwn(value,'body') || value.state==='complete' && !Object.hasOwn(value,'body')) throw new Error('Unrecognized next journal; retain it for inspection');
  return value;
}
function writeRecord(root: string, record: NextRecord): void {
  const path=join(root,'cli-next.json'); const temp=join(root,`.cli-next-${randomUUID()}.tmp`);
  const fd=openSync(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  let renamed=false;
  try {writeFileSync(fd,JSON.stringify(record));fsyncSync(fd);closeSync(fd);renameSync(temp,path);renamed=true;const dir=openSync(root,constants.O_RDONLY);try{fsyncSync(dir)}finally{closeSync(dir)}}
  finally {if(!renamed){try{closeSync(fd)}catch{} try{unlinkSync(temp)}catch{}}}
}
export type NextResult = {state:'pending';key:string} | {state:'complete';key:string;body:unknown};
/** Persist one key before sending; subsequent invocations only reconcile an uncertain prior key. */
export async function dispatchNext(root: string): Promise<NextResult> {
  const unlock=lockNext(root);
  try {
    let record=readRecord(root); let lookup=true;
    if (!record || record.state==='complete') {record={schemaVersion:1,state:'pending',key:randomUUID()};writeRecord(root,record);lookup=false;}
    let result: unknown;
    try {result=await privateRequest(root,lookup?'/dispatch-status':'/next',record.key)}
    catch {throw new Error('Private dispatch was not confirmed; retain its key and reconcile before another dispatch')}
    if (!result || typeof result!=='object' || !('state' in result)) throw new Error('Private dispatch was not confirmed; retain its key and reconcile before another dispatch');
    const value=result as {state:unknown;body?:unknown};
    if (value.state==='pending') return {state:'pending',key:record.key};
    if (value.state!=='complete' || !Object.hasOwn(value,'body')) throw new Error('Private dispatch was not confirmed; retain its key and reconcile before another dispatch');
    writeRecord(root,{schemaVersion:1,state:'complete',key:record.key,body:value.body});
    return {state:'complete',key:record.key,body:value.body};
  } finally {unlock()}
}
