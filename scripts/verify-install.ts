import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export interface PlatformSmokeOptions { packageRoot: string; scratchRoot: string; node?: string }
export interface InstallReport { platform: string; node: string; privateDaemon: 'passed'; gates: Record<string,string> }
/** Owned nonsecret service fixture; never launches a provider or alters login/global installation state. */
export async function verifyInstall(options: PlatformSmokeOptions): Promise<InstallReport> {
  const script=join(options.scratchRoot,'installed-smoke.mjs');
  writeFileSync(script,`import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
const windows=await import(${JSON.stringify(pathToFileURL(join(options.packageRoot,'dist/platform/windows-private.js')).href)});
const root=${JSON.stringify(join(options.scratchRoot,'owned service 工場'))};mkdirSync(root,{mode:0o700});if(process.platform==='win32')windows.protectWindowsDirectory(root);mkdirSync(join(root,'vault'),{mode:0o700});if(process.platform==='win32')windows.protectWindowsDirectory(join(root,'vault'));
const privateWrite=(path,value)=>process.platform==='win32'?windows.writeWindowsPrivateFile(path,Buffer.from(value)):writeFileSync(path,value,{mode:0o600});
privateWrite(join(root,'runtime.json'),JSON.stringify({schemaVersion:1,installationId:'release-smoke',apiPort:0,allowedOrigins:['http://127.0.0.1:4000'],repositories:[],providerCredentials:[],native:[]}));
for(const name of ['broker-signing','private-control']){const path=join(root,'vault',name);if(process.platform==='win32')windows.writeWindowsSecret(path,Buffer.alloc(32,9));else writeFileSync(path,Buffer.alloc(32,9),{mode:0o600});}
const {startRuntime}=await import(${JSON.stringify(pathToFileURL(join(options.packageRoot,'dist/service/runtime.js')).href)});
const installation={id:'release-smoke',root,docker:{async command(){throw Error('No live Docker changes in cold service smoke')}},secrets:{async loadOrCreate(){throw Error('No live credentials')}}};
const service=await startRuntime(installation);
try{
assert.equal((await service.health()).ready,false);
const session=service.api.sessions.provision('http://127.0.0.1:4000');
const headers={origin:'http://127.0.0.1:4000',cookie:session.cookie};
assert.equal((await fetch(service.api.url+'/v1/snapshot',{headers})).status,200);
assert.equal((await fetch(service.api.url+'/factory/factory-ui.js')).status,200);
assert.equal((await fetch(service.controlUrl+'/health')).status,401);
assert.equal((await fetch(service.controlUrl+'/health',{headers:{authorization:'Bearer '+Buffer.alloc(32,9).toString('base64url')}})).status,200);
assert.equal(service.store.getReservations().length,0);
await assert.rejects(startRuntime(installation),/controller|lock/);
}finally{await service.stop();}
console.log('PRIVATE_DAEMON_PASSED');
`);
  const result=spawnSync(options.node??process.execPath,[script],{cwd:options.scratchRoot,encoding:'utf8',timeout:60_000,env:{...process.env,HOME:options.scratchRoot,USERPROFILE:options.scratchRoot,NODE_PATH:'',SF_DOCKER_EXECUTABLE:undefined}});
  if(result.status!==0||!result.stdout.includes('PRIVATE_DAEMON_PASSED'))throw Error('Installed service smoke failed: '+result.stderr+' '+result.stdout);
  return {platform:process.platform,node:process.versions.node,privateDaemon:'passed',gates:{service:'passed (real runtime, no provisioned native owner)',loginStartup:'requires native OS user-login smoke',nativeExecution:'requires actual verified owned runtime/provider',githubWrites:'blocked: no designated disposable repository',appDeviceFlow:'blocked: no publisher App configuration'}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify(await verifyInstall({packageRoot:resolve(process.argv[2]!),scratchRoot:resolve(process.argv[3]!)}),null,2));
