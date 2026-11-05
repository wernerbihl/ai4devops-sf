import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { constants, openSync, closeSync, writeFileSync, fsyncSync, fstatSync, lstatSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readPrivateFile } from '../service/config.ts';

const scopes = ['read:user','user:email'];
const resource = 'https://api.github.com';
export interface Account { id: string; label: string }
export interface Metadata { schemaVersion:1; resource:string; scopes:string[]; account:Account; ref:'native-copilot' }
function validAccount(value: unknown): value is Account {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const a=value as Account;
  return typeof a.id==='string' && a.id.length>0 && a.id.length<=256 && typeof a.label==='string' && a.label.length>0 && a.label.length<=256 && !/[\x00-\x1f\x7f]/.test(a.id+a.label);
}
function privateDir(path: string): void {
  if (process.platform==='win32') throw new Error('Windows protected companion storage is unavailable');
  const s=lstatSync(path);
  if (resolve(path)!==path || realpathSync(path)!==path || !s.isDirectory() || s.uid!==process.getuid!() || (s.mode&0o077)!==0) throw new Error('Private companion directory required');
}
function lock(root: string):()=>void {
  const path=join(root,'companion-auth-lock.sqlite');
  try {const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);closeSync(fd)}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;readPrivateFile(path)}
  const db=new DatabaseSync(path);
  try{db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE')}catch{db.close();throw new Error('Another companion authentication is active')}
  return ()=>{try{db.exec('ROLLBACK')}finally{db.close()}};
}
function atomicPrivate(path:string, value:string):void {
  const directory=path.slice(0,path.lastIndexOf('/'));const temp=join(directory,`.sf-auth-${randomUUID()}.tmp`);
  const fd=openSync(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);let renamed=false;
  try {writeFileSync(fd,value);fsyncSync(fd);closeSync(fd);renameSync(temp,path);renamed=true;const dir=openSync(directory,constants.O_RDONLY);try{fsyncSync(dir)}finally{closeSync(dir)}}
  finally {if(!renamed){try{closeSync(fd)}catch{}try{unlinkSync(temp)}catch{}}}
}
/** Read only credentials minted by the protected companion flow for the exact pinned resource. */
export function loadCompanionCredential(root:string, reference:{ref:string;resource:string;scopes:string[]}): {account:Account;token:string} {
  if(reference.ref!=='native-copilot'||reference.resource!==resource||JSON.stringify(reference.scopes)!==JSON.stringify(scopes))throw new Error('Native Copilot credential reference does not match the selected resource and scopes');
  const metadata=JSON.parse(readPrivateFile(join(root,'native-copilot.json')).toString()) as Metadata;
  if(metadata.schemaVersion!==1||metadata.ref!==reference.ref||metadata.resource!==resource||JSON.stringify(metadata.scopes)!==JSON.stringify(scopes)||!validAccount(metadata.account))throw new Error('Protected native Copilot account metadata is invalid');
  const token=readPrivateFile(join(root,'vault','native-copilot')).toString();
  if(!token||token.length>16384||/[\x00-\x20\x7f]/.test(token))throw new Error('Protected native Copilot credential is invalid');
  return {account:metadata.account,token};
}
function optionalPrivate(path:string):Buffer|undefined {try{return readPrivateFile(path)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}}
/** One-use loopback broker. The caller owns the private temporary profile and starts the companion. */
export async function startCompanionAuth(options:{root:string;requestDir:string;interactive:boolean;account?:Account}) {
  privateDir(options.root);privateDir(options.requestDir);privateDir(join(options.root,'vault'));
  if(options.account && !validAccount(options.account))throw new Error('Invalid selected account');
  const unlock=lock(options.root);let closed=false;
  const metadataPath=join(options.root,'native-copilot.json');const tokenPath=join(options.root,'vault','native-copilot');
  let prior:Metadata|undefined;
  try {
    const metadataBytes=optionalPrivate(metadataPath);const priorToken=optionalPrivate(tokenPath);
    if(Boolean(metadataBytes)!==Boolean(priorToken))throw new Error('Incomplete native credential state requires attention');
    if(metadataBytes){prior=JSON.parse(metadataBytes.toString()) as Metadata;if(prior.schemaVersion!==1||prior.resource!==resource||JSON.stringify(prior.scopes)!==JSON.stringify(scopes)||prior.ref!=='native-copilot'||!validAccount(prior.account))throw new Error('Invalid native credential metadata');}
    if(prior&&options.account&&prior.account.id!==options.account.id)throw new Error('Selected native account changed');
  } catch(error){unlock();throw error}
  const account=prior?.account??options.account;const bearer=randomBytes(32).toString('base64url');const expected=Buffer.from('Bearer '+bearer);const nonce=randomBytes(24).toString('base64url');const expiresAt=Date.now()+300000;
  let succeed!:(result:Metadata)=>void;let fail!:(error:Error)=>void;const completed=new Promise<Metadata>((resolve,reject)=>{succeed=resolve;fail=reject});void completed.catch(()=>{});
  let used=false;let finished=false;
  const server=createServer(async(req,res)=>{
    const supplied=Buffer.from(typeof req.headers.authorization==='string'?req.headers.authorization:'');
    if(used||req.method!=='POST'||req.url!=='/provider'||req.headers.origin||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)||Date.now()>=expiresAt){res.writeHead(401).end();return}
    used=true;
    try {
      let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>32768)throw Error('bounded request')}
      const input=JSON.parse(raw) as {nonce?:unknown;resource?:unknown;scopes?:unknown;account?:unknown;token?:unknown};
      if(input.nonce!==nonce||input.resource!==resource||JSON.stringify(input.scopes)!==JSON.stringify(scopes)||!validAccount(input.account)||account&&input.account.id!==account.id||typeof input.token!=='string'||!input.token||input.token.length>16384)throw Error('Invalid companion credential');
      const metadata:Metadata={schemaVersion:1,resource,scopes,account:input.account,ref:'native-copilot'};
      atomicPrivate(tokenPath,input.token);atomicPrivate(metadataPath,JSON.stringify(metadata));
      finished=true;res.writeHead(200,{'cache-control':'no-store'}).end();succeed(metadata);
    } catch {finished=true;res.writeHead(409,{'cache-control':'no-store'}).end();fail(new Error('Companion credential was not accepted'))}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;
  let requestPath='';let identity:{dev:number;ino:number}|undefined;
  try {
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
    const address=server.address();if(!address||typeof address==='string')throw Error('Private companion listener unavailable');
    requestPath=join(options.requestDir,'companion-request.json');
    const fd=openSync(requestPath,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    try {const s=fstatSync(fd);identity={dev:s.dev,ino:s.ino};writeFileSync(fd,JSON.stringify({schemaVersion:1,url:`http://127.0.0.1:${address.port}/provider`,bearer,nonce,expiresAt,resource,scopes,interactive:options.interactive,...(account?{account}:{})}));fsyncSync(fd)}finally{closeSync(fd)}
    const timer=setTimeout(()=>{if(!finished){finished=true;fail(new Error('Companion authentication timed out'))}},300000);timer.unref();
    return {requestPath,completed,async close(){if(closed)return;closed=true;clearTimeout(timer);if(!finished){finished=true;fail(new Error('Companion authentication cancelled'))}await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections()});try{const current=lstatSync(requestPath);if(identity&&current.dev===identity.dev&&current.ino===identity.ino)unlinkSync(requestPath)}catch{}unlock()}};
  } catch(error){server.close();if(identity&&requestPath){try{const current=lstatSync(requestPath);if(current.dev===identity.dev&&current.ino===identity.ino)unlinkSync(requestPath)}catch{}}unlock();throw error}
}
