import { randomBytes } from 'node:crypto';
import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProcessDocker, kestraImagePins, type DockerPort } from '../kestra/deployment.ts';
import { openStore } from '../storage/store.ts';
import { recipeMaterializer } from '../recipes/materialize.ts';
import { loadCompanionCredential } from './companion-auth.ts';
import { authenticateViaCompanion } from './companion-launch.ts';
import { inspectSelectedRoot, pinnedBaseAvailable, probeSelectedRoot } from './docker-preflight.ts';
import { copyRuntime } from './runtime-copy.ts';
import { seedStarters } from './starter-seed.ts';
import { installationLocatorPath, locateInstallation, saveInstallation, type Installation } from './locator.ts';
import { LinuxStartup } from './service-linux.ts';
import { protectWindowsDirectory, writeWindowsPrivateFile, writeWindowsSecret } from '../platform/windows-private.ts';
import { WindowsStartup } from './service-windows.ts';
import { MacOSStartup } from './service-macos.ts';
import type { InstallPlan } from './plan.ts';
import { recordCreatedPaths, snapshotCreatedPath, type CreatedPath } from './ownership.ts';
import { acquireAdministrationLock, recordServiceStart } from './administration.ts';
import { probeController } from '../cli/next.ts';

function writePrivate(path:string,value:string|Buffer):void {
  if(process.platform==='win32'){writeWindowsPrivateFile(path,Buffer.isBuffer(value)?value:Buffer.from(value));return}
  const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,value);fsyncSync(fd)}finally{closeSync(fd)}
}
/** Apply only after explicit Install (Y/n). Unknown partial work remains owned for inspection. */
export async function applyInstall(plan:InstallPlan,options:{docker?:DockerPort;locatorPath?:string;configHome?:string;systemctl?:string}={}):Promise<Installation> {
  if(!['linux','darwin','win32'].includes(process.platform))throw new Error('This platform does not yet have a protected installation adapter');
  const locator=options.locatorPath??installationLocatorPath();if(await locateInstallation(locator))throw new Error('An installation already exists');
  const administration=await acquireAdministrationLock(plan.id,dirname(locator));try {
  const credential=loadCompanionCredential(plan.stagedAuthRoot,{ref:'native-copilot',resource:'https://api.github.com',scopes:['read:user','user:email']});
  if(credential.account.id!==plan.account.id)throw new Error('Selected Copilot account changed since preview');
  const docker=options.docker??new ProcessDocker(plan.dockerExecutable??'docker');const state=inspectSelectedRoot(plan.directory);let created=false;let markerCreated=false;let bindConfirmed=false;
  const createdPaths:CreatedPath[]=[];const remember=(path:string)=>createdPaths.push(snapshotCreatedPath(plan.directory,path));
  const marker=join(plan.directory,'install-owner.json');const markerValue=JSON.stringify({schemaVersion:1,installationId:plan.id,root:plan.directory});
  try {
    if(!state.exists){mkdirSync(plan.directory,{mode:0o700});created=true;if(process.platform==='win32')protectWindowsDirectory(plan.directory)}
    writePrivate(marker,markerValue);markerCreated=true;remember('install-owner.json');
    if(!await pinnedBaseAvailable(docker)){await docker.command(['pull',kestraImagePins.worker.image]);if(!await pinnedBaseAvailable(docker))throw new Error('Pinned Docker base image is unavailable')}
    await probeSelectedRoot(plan.directory,docker,plan.id);bindConfirmed=true;
    const kestraParent=join(plan.directory,'kestra');mkdirSync(kestraParent,{mode:0o700});remember('kestra');if(process.platform==='win32')protectWindowsDirectory(kestraParent);
    const runtimeParent=join(plan.directory,'runtime');mkdirSync(runtimeParent,{mode:0o700});remember('runtime');if(process.platform==='win32')protectWindowsDirectory(runtimeParent);
    const version=JSON.parse(readFileSync(join(plan.sourceRoot,'package.json'),'utf8')).version as string;
    const runtime=await copyRuntime({sourceRoot:plan.sourceRoot,target:join(runtimeParent,version)});
    // Use the copied runtime's own builder bytes, so the protected manifest matches the installed package.
    const images=await import(pathToFileURL(join(runtime.root,'dist','install','images.js')).href) as typeof import('./images.ts');
    const archive=join(plan.directory,'native-server.tar.gz');let archiveIdentity:{dev:number;ino:number}|undefined;
    let built:Awaited<ReturnType<typeof images.buildImages>>;
    try {await images.downloadNativeServer(archive);const stat=lstatSync(archive);archiveIdentity={dev:stat.dev,ino:stat.ino};built=await images.buildImages({installationId:plan.id,installationRoot:plan.directory,archive,docker})}
    finally {if(archiveIdentity){const stat=lstatSync(archive);if(stat.dev!==archiveIdentity.dev||stat.ino!==archiveIdentity.ino)throw new Error('Owned server archive changed; retain it for inspection');unlinkSync(archive)}}
    let kestraAvailable=false;try{const inspected=JSON.parse(await docker.command(['image','inspect',kestraImagePins.kestra.image]))[0];kestraAvailable=Boolean(inspected?.RepoDigests?.includes(kestraImagePins.kestra.image)&&inspected.Os==='linux'&&inspected.Architecture==='amd64')}catch{}
    if(!kestraAvailable)await docker.command(['pull',kestraImagePins.kestra.image]);
    mkdirSync(join(plan.directory,'vault'),{mode:0o700});remember('vault');if(process.platform==='win32')protectWindowsDirectory(join(plan.directory,'vault'));
    for(const name of ['broker-signing','private-control']){const path=join(plan.directory,'vault',name);if(process.platform==='win32')writeWindowsSecret(path,randomBytes(32));else writePrivate(path,randomBytes(32))}
    const requestDir=join(plan.directory,'auth-request');mkdirSync(requestDir,{mode:0o700});remember('auth-request');if(process.platform==='win32')protectWindowsDirectory(requestDir);
    await authenticateViaCompanion({root:plan.directory,requestDir,installationId:plan.id,codeExecutable:plan.codeExecutable,interactive:true,account:credential.account});
    const config={schemaVersion:1,installationId:plan.id,allowedOrigins:['http://127.0.0.1:43117'],apiPort:43117,repositories:[],providerCredentials:[{ref:'native-copilot',providerId:'copilot',resource:'https://api.github.com',scopes:['read:user','user:email']}],native:[{kind:'vscode-isolated-worker-v2',nativeImage:built.images.native,workerImage:built.images.worker,entrypoint:built.nativeEntrypoint,entrypointSha256:built.nativeEntrypointSha256,hostCommit:built.hostCommit,pristineDirectory:'/workspaces/task',emptyHome:'/opt/software-factory/empty-home',credentialRef:'native-copilot',proxy:{image:built.images.proxy,entrypoint:'/opt/software-factory/connect.cjs',entrypointSha256:built.proxySha256,allowedAuthorities:['api.github.com:443','api.githubcopilot.com:443','copilot-proxy.githubusercontent.com:443']}}]};
    writePrivate(join(plan.directory,'runtime.json'),JSON.stringify(config));remember('runtime.json');
    writePrivate(join(plan.directory,'factory.sqlite'),Buffer.alloc(0));remember('factory.sqlite');
    const store=openStore(join(plan.directory,'factory.sqlite'),{materialize:recipeMaterializer});try{const settings=store.getSettings();if(settings.config.taktSeconds!==plan.taktSeconds)store.patchSettings({taktSeconds:plan.taktSeconds},settings.revision);seedStarters(store)}finally{store.close()}
    const installation:Installation={schemaVersion:1,id:plan.id,root:plan.directory,node:runtime.node,serviceEntry:runtime.serviceEntry,version:runtime.version};
    const spec={node:runtime.node,entry:runtime.serviceEntry,id:plan.id,root:plan.directory,...(plan.dockerExecutable?{dockerExecutable:plan.dockerExecutable}:{})};
    const service=process.platform==='win32'?new WindowsStartup(spec):process.platform==='darwin'?new MacOSStartup(spec):new LinuxStartup({...spec,...(options.configHome?{configHome:options.configHome}:{}),...(options.systemctl?{systemctl:options.systemctl}:{})});
    const serviceRecord=service instanceof WindowsStartup?{kind:'windows-task'}:service instanceof MacOSStartup?{kind:'launchagent',plistPath:service.plistPath}:{kind:'systemd-user',unitPath:service.unitPath};
    writePrivate(join(plan.directory,'startup.json'),JSON.stringify({schemaVersion:1,installationId:plan.id,...serviceRecord,codeExecutable:plan.codeExecutable,requestDir,...(plan.dockerExecutable?{dockerExecutable:plan.dockerExecutable}:{})}));
    remember('startup.json');await recordCreatedPaths({id:plan.id,root:plan.directory,paths:createdPaths});
    await service.install();await saveInstallation(installation,locator);await recordServiceStart(plan.directory,plan.id,'pending',dirname(locator));await service.start();
    let connected=false;for(let i=0;i<30;i++){try{await probeController(plan.directory);connected=true;break}catch{await new Promise(resolve=>setTimeout(resolve,1000))}}if(!connected)throw new Error('Initial service start remains unconfirmed; retain the original installation for recovery');await recordServiceStart(plan.directory,plan.id,'complete',dirname(locator));
    return installation;
  } catch(error) {
    if(!bindConfirmed&&markerCreated){
      try {const entries=readdirSync(plan.directory);if(entries.length===1&&entries[0]==='install-owner.json'&&readFileSync(marker,'utf8')===markerValue){unlinkSync(marker);if(created)rmdirSync(plan.directory)}}catch{/* Preserve uncertain or nonempty paths for attention. */}
    } else if(!bindConfirmed&&created&&!markerCreated){try{if(readdirSync(plan.directory).length===0)rmdirSync(plan.directory)}catch{}}
    throw error;
  }
  } finally {administration.close()}
}
