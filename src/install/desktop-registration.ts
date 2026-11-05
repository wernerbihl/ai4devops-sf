import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertWindowsPrivateDirectory, writeWindowsPrivateFile } from '../platform/windows-private.ts';
import { readPrivateFile } from '../service/config.ts';
function privateDir(path:string):void {if(process.platform==='win32'){assertWindowsPrivateDirectory(path);return}const s=lstatSync(path);if(resolve(path)!==path||realpathSync(path)!==path||!s.isDirectory()||s.uid!==process.getuid!()||(s.mode&0o077)!==0)throw new Error('Private desktop directory required')}
/** One-use private IPC request to the locally installed VS Code companion. */
export async function startDesktopRegistration(options:{requestDir:string;profileRoot:string;installationId:string;runtimeOwnerId:string;address:string;capability:string;expiresAt:number}) {
 privateDir(options.requestDir);privateDir(options.profileRoot);const marker=JSON.parse(readPrivateFile(join(options.profileRoot,'owner.json')).toString());
 if(marker.schemaVersion!==1||marker.installationId!==options.installationId||marker.component!=='companion-profile'||!/^[A-Za-z0-9_-]{1,100}$/.test(options.runtimeOwnerId)||!/^127\.0\.0\.1:[1-9]\d{0,4}$/.test(options.address)||Number(options.address.split(':')[1])>65535||!/^[A-Za-z0-9_-]{43}$/.test(options.capability)||!Number.isSafeInteger(options.expiresAt)||options.expiresAt<=Date.now()||options.expiresAt>Date.now()+60000)throw new Error('Invalid private desktop registration');
 const user=join(options.profileRoot,'user-data','User');privateDir(join(options.profileRoot,'user-data'));privateDir(user);const settingsPath=join(user,'settings.json');readPrivateFile(settingsPath);
 const bearer=randomBytes(32).toString('base64url');const expected=Buffer.from('Bearer '+bearer);const nonce=randomBytes(24).toString('base64url');let used=false;let closed=false;let finished=false;
 let succeed!:()=>void;let fail!:(error:Error)=>void;const completed=new Promise<void>((resolve,reject)=>{succeed=resolve;fail=reject});void completed.catch(()=>{});
 const server=createServer(async(req,res)=>{const supplied=Buffer.from(typeof req.headers.authorization==='string'?req.headers.authorization:'');
  if(used||req.method!=='POST'||req.url!=='/registration'||req.headers.origin||Date.now()>=options.expiresAt||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){res.writeHead(401).end();return}used=true;
  try{let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>4096)throw Error('bounded')}const input=JSON.parse(raw);if(input.nonce!==nonce||input.registered!==true)throw Error('invalid');finished=true;res.writeHead(200,{'cache-control':'no-store'}).end();succeed()}catch{finished=true;res.writeHead(409).end();fail(new Error('Desktop registration was not confirmed'))}
 });
 let requestPath='';let identity:{dev:number;ino:number}|undefined;
 try{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});const address=server.address();if(!address||typeof address==='string')throw Error('Private registration listener unavailable');
  requestPath=join(options.requestDir,'companion-request.json');const request=JSON.stringify({schemaVersion:1,action:'register',url:`http://127.0.0.1:${address.port}/registration`,bearer,nonce,expiresAt:options.expiresAt,settingsPath,runtimeOwnerId:options.runtimeOwnerId,address:options.address,capability:options.capability});
  if(process.platform==='win32'){writeWindowsPrivateFile(requestPath,Buffer.from(request));const s=lstatSync(requestPath);identity={dev:s.dev,ino:s.ino}}else {const fd=openSync(requestPath,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{const s=fstatSync(fd);identity={dev:s.dev,ino:s.ino};writeFileSync(fd,request);fsyncSync(fd)}finally{closeSync(fd)}}
  const timer=setTimeout(()=>{if(!finished){finished=true;fail(new Error('Desktop registration expired'))}},Math.max(1,options.expiresAt-Date.now()));timer.unref();
  return {requestPath,completed,async close(){if(closed)return;closed=true;clearTimeout(timer);if(!finished){finished=true;fail(new Error('Desktop registration cancelled'))}await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections()});try{const s=lstatSync(requestPath);if(identity&&s.dev===identity.dev&&s.ino===identity.ino)unlinkSync(requestPath)}catch{}}};
 }catch(error){server.close();if(identity&&requestPath){try{const s=lstatSync(requestPath);if(s.dev===identity.dev&&s.ino===identity.ino)unlinkSync(requestPath)}catch{}}throw error}
}
