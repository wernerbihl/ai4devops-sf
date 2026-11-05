import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import type { NativeIdentity } from '../contracts/domain.ts';
import { readPrivateFileAsync } from '../service/config.ts';
import { launchCompanion } from '../install/companion-launch.ts';
import { startDesktopRegistration } from '../install/desktop-registration.ts';
import type { ManagedOwnerLauncher } from './vscode.ts';
import { startHumanRelay } from './human-relay.ts';
const exec=promisify(execFile);

/** Register an actual guarded relay in the factory-owned desktop profile for one admitted open. */
export async function createDesktopNavigation(options:{root:string;installationId:string;runtimeOwnerId:string;identity:NativeIdentity;assertCurrent():void;beforeHumanAction(action:Record<string,unknown>):string|void;humanActionAcknowledged(key:string):void;launcher:ManagedOwnerLauncher}) {
  options.assertCurrent();const startup=JSON.parse((await readPrivateFileAsync(join(options.root,'startup.json'))).toString());
  if(startup.schemaVersion!==1||startup.installationId!==options.installationId||typeof startup.codeExecutable!=='string'||startup.requestDir!==join(options.root,'auth-request'))throw new Error('Private desktop profile configuration unavailable');
  const profileRoot=join(options.root,'vscode-profile');const profile={root:profileRoot,userDataDir:join(profileRoot,'user-data'),extensionsDir:join(profileRoot,'extensions')};
  const relay=await startHumanRelay({runtimeOwnerId:options.runtimeOwnerId,identity:options.identity,assertCurrent:options.assertCurrent,beforeHumanAction:options.beforeHumanAction,humanActionAcknowledged:options.humanActionAcknowledged,async connect(){options.assertCurrent();const connection=await options.launcher.ensureStarted();options.assertCurrent();if(!('connect' in connection))throw new Error('Managed native transport unavailable');return connection.connect()}});
  let launcher:Awaited<ReturnType<typeof launchCompanion>>|undefined;
  try {
    options.assertCurrent();const registration=await startDesktopRegistration({requestDir:startup.requestDir,profileRoot,installationId:options.installationId,runtimeOwnerId:options.runtimeOwnerId,address:relay.address,capability:relay.token,expiresAt:relay.expiresAt});
    try {options.assertCurrent();launcher=await launchCompanion({profile,installationId:options.installationId,codeExecutable:startup.codeExecutable,requestPath:registration.requestPath});await registration.completed;options.assertCurrent()}
    finally {await registration.close()}
    // Pinned VS Code agentHostUri.ts encodes lowercase host:port by replacing ':' with '__'.
    const connectionAuthority=relay.address.replaceAll(':','__');
    return {connectionAuthority,async launch(uri:string){options.assertCurrent();const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>name!=='SF_COMPANION_REQUEST'&&!/(TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY)/i.test(name)));try{await exec(startup.codeExecutable,['--user-data-dir',profile.userDataDir,'--extensions-dir',profile.extensionsDir,'--open-url',uri],{env,timeout:30000})}catch{throw new Error('Private VS Code navigation could not be confirmed')}options.assertCurrent()},async close(){await relay.close()}};
  } catch(error){launcher?.stop();await relay.close();throw error}
}
