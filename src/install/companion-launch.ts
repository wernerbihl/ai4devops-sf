import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readPrivateFileAsync } from '../service/config.ts';
import { assertWindowsPrivateDirectoryAsync, protectWindowsDirectoryAsync, writeWindowsPrivateFileAsync } from '../platform/windows-private.ts';
import { verifyCompanionPackage } from './companion-package.ts';

export interface CompanionProfile { root:string; userDataDir:string; extensionsDir:string }
async function privateDir(path:string):Promise<void> {
  if(process.platform==='win32'){await assertWindowsPrivateDirectoryAsync(path);return}
  const s=lstatSync(path);if(resolve(path)!==path||realpathSync(path)!==path||!s.isDirectory()||s.uid!==process.getuid!()||(s.mode&0o077)!==0)throw new Error('Private owned companion profile required');
}
async function ownedProfile(root:string,id:string):Promise<CompanionProfile> {
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(id))throw new Error('Invalid installation identity');
  await privateDir(root);const profileRoot=join(root,'vscode-profile');const marker=join(profileRoot,'owner.json');let created=false;
  try{mkdirSync(profileRoot,{mode:0o700});created=true}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error}
  if(created&&process.platform==='win32')await protectWindowsDirectoryAsync(profileRoot);
  await privateDir(profileRoot);const expected={schemaVersion:1,installationId:id,component:'companion-profile'};
  if(created){if(process.platform==='win32')await writeWindowsPrivateFileAsync(marker,Buffer.from(JSON.stringify(expected)));else writeFileSync(marker,JSON.stringify(expected),{mode:0o600,flag:'wx'})}
  else if(JSON.stringify(JSON.parse((await readPrivateFileAsync(marker)).toString()))!==JSON.stringify(expected))throw new Error('Existing companion profile ownership mismatch');
  const userDataDir=join(profileRoot,'user-data');const extensionsDir=join(profileRoot,'extensions');
  for(const directory of [userDataDir,extensionsDir]){let created=false;try{mkdirSync(directory,{mode:0o700});created=true}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error}if(created&&process.platform==='win32')await protectWindowsDirectoryAsync(directory);await privateDir(directory)}
  const user=join(userDataDir,'User');let createdUser=false;try{mkdirSync(user,{mode:0o700});createdUser=true}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error}if(createdUser&&process.platform==='win32')await protectWindowsDirectoryAsync(user);await privateDir(user);
  const settings=join(user,'settings.json');if(process.platform==='win32'&&existsSync(settings)){await readPrivateFileAsync(settings);return {root:profileRoot,userDataDir,extensionsDir}}try{const data=JSON.stringify({'settingsSync.ignoredSettings':['chat.remoteAgentHosts','chat.workspaceRemoteAgentHosts']});if(process.platform==='win32')await writeWindowsPrivateFileAsync(settings,Buffer.from(data));else writeFileSync(settings,data,{mode:0o600,flag:'wx'})}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;await readPrivateFileAsync(settings)}
  return {root:profileRoot,userDataDir,extensionsDir};
}
function executable(path:string):string {
  if(!path||resolve(path)!==path)throw new Error('An absolute VS Code executable is required');
  const actual=realpathSync(path);if(!lstatSync(actual).isFile())throw new Error('VS Code executable unavailable');accessSync(actual,constants.X_OK);return actual;
}
function environment(extra:NodeJS.ProcessEnv={}):NodeJS.ProcessEnv {
  return {...Object.fromEntries(Object.entries(process.env).filter(([name])=>name!=='SF_COMPANION_REQUEST'&&!/(TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY)/i.test(name))),...extra};
}
function run(binary:string,args:string[]):Promise<void> {
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,args,{shell:false,stdio:'ignore',env:environment()});let done=false;
    const finish=(ok:boolean)=>{if(done)return;done=true;clearTimeout(timer);ok?resolve():reject(new Error('Private VS Code companion installation failed'))};
    const timer=setTimeout(()=>{child.kill();finish(false)},60000);
    child.once('error',()=>finish(false));child.once('exit',code=>finish(code===0));
  });
}
/** Installs the verified local VSIX using a factory-owned isolated profile and extensions directory. */
export async function installCompanion(input:{root:string;installationId:string;codeExecutable:string}):Promise<CompanionProfile> {
  const vsix=verifyCompanionPackage();const code=executable(input.codeExecutable);const profile=await ownedProfile(input.root,input.installationId);
  await run(code,['--user-data-dir',profile.userDataDir,'--extensions-dir',profile.extensionsDir,'--install-extension',vsix,'--force']);
  return profile;
}
/** Launches the same private profile; the protected request path contains no user token. */
export async function launchCompanion(input:{profile:CompanionProfile;installationId:string;codeExecutable:string;requestPath:string}):Promise<{pid:number;stop():void}> {
  await privateDir(input.profile.root);await privateDir(input.profile.userDataDir);await privateDir(input.profile.extensionsDir);
  const marker=JSON.parse((await readPrivateFileAsync(join(input.profile.root,'owner.json'))).toString());
  if(input.profile.userDataDir!==join(input.profile.root,'user-data')||input.profile.extensionsDir!==join(input.profile.root,'extensions')||marker.schemaVersion!==1||marker.installationId!==input.installationId||marker.component!=='companion-profile')throw new Error('Companion profile ownership mismatch');
  await readPrivateFileAsync(input.requestPath);
  const child=spawn(executable(input.codeExecutable),['--user-data-dir',input.profile.userDataDir,'--extensions-dir',input.profile.extensionsDir,'--new-window'],{shell:false,stdio:'ignore',detached:true,env:environment({SF_COMPANION_REQUEST:input.requestPath})});
  await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(new Error('Private VS Code companion launch failed')))});
  if(!child.pid)throw new Error('Private VS Code companion launch failed');const pid=child.pid;child.unref();
  return {pid,stop(){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM')}};
}

/** Runs the supported UI sign-in flow; the VS Code process must remain available for later refresh. */
export async function authenticateViaCompanion(input:{root:string;requestDir:string;installationId:string;codeExecutable:string;interactive:boolean;account?:{id:string;label:string}}) {
  const {startCompanionAuth}=await import('./companion-auth.ts');
  const broker=await startCompanionAuth({root:input.root,requestDir:input.requestDir,interactive:input.interactive,...(input.account?{account:input.account}:{})});
  let launcher:Awaited<ReturnType<typeof launchCompanion>>|undefined;
  try {
    const profile=await installCompanion({root:input.root,installationId:input.installationId,codeExecutable:input.codeExecutable});
    launcher=await launchCompanion({profile,installationId:input.installationId,codeExecutable:input.codeExecutable,requestPath:broker.requestPath});
    const credential=await broker.completed;
    return {...credential,profile,launcher};
  } catch {launcher?.stop();throw new Error('Companion authentication did not complete; inspect the private profile and selected account')}
  finally {await broker.close()}
}

/** Refresh only the already selected account through the isolated VS Code provider. */
export async function refreshCompanionCredential(input:{root:string;requestDir:string;installationId:string;codeExecutable:string}):Promise<void> {
  const {loadCompanionCredentialAsync}=await import('./companion-auth.ts');
  const existing=await loadCompanionCredentialAsync(input.root,{ref:'native-copilot',resource:'https://api.github.com',scopes:['read:user','user:email']});
  await authenticateViaCompanion({...input,interactive:false,account:existing.account});
  const updated=await loadCompanionCredentialAsync(input.root,{ref:'native-copilot',resource:'https://api.github.com',scopes:['read:user','user:email']});
  if(updated.account.id!==existing.account.id)throw new Error('Refreshed native account changed');
}
