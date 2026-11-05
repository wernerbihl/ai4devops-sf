import { randomUUID } from 'node:crypto';
import { accessSync, constants, mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { protectWindowsDirectory } from '../platform/windows-private.ts';
import { ProcessDocker, type DockerPort } from '../kestra/deployment.ts';
import { authenticateViaCompanion } from '../install/companion-launch.ts';
import { checkDockerPreflight } from '../install/docker-preflight.ts';
import { loadDefaults, saveDefaults, type SetupDefaults } from '../install/defaults.ts';
import { clearStagedCredential } from '../install/staging-cleanup.ts';
import { planInstall, type SetupAnswers } from '../install/plan.ts';
import { applyInstall } from '../install/install.ts';
import { locateInstallation } from '../install/locator.ts';
import { reconfigureInstallation } from '../install/reconfigure.ts';

export interface SetupIo {out(text:string):void;err(text:string):void;ask(prompt:string):Promise<string>}
function defaultCode():string {
  for(const directory of (process.env.PATH??'').split(process.platform==='win32'?';':':'))for(const name of (process.platform==='win32'?['Code.exe','Code - Insiders.exe']:['code','code-insiders'])){const path=resolve(directory||'.',name);try{accessSync(path,constants.X_OK);return path}catch{}}
  return process.platform==='win32'?join(process.env.LOCALAPPDATA??homedir(),'Programs','Microsoft VS Code','Code.exe'):'/usr/bin/code';
}
export async function runSetup(io:SetupIo,options:{docker?:DockerPort;defaultsPath?:string;locatorPath?:string;sourceRoot?:string;tempParent?:string;authenticate?:typeof authenticateViaCompanion;systemctl?:string}={}):Promise<number> {
  const saved=loadDefaults(options.defaultsPath);const defaults:SetupDefaults=saved??{directory:join(homedir(),'.ai4devops-sf'),taktSeconds:60,ownerId:'vscode',providers:['copilot'],codeExecutable:defaultCode()};
  const ask=async(label:string,value:string)=>{const answer=(await io.ask(`${label} [${value}]: `)).trim();return answer||value};
  const existing=await locateInstallation(options.locatorPath);if(existing){
    const directory=await ask('Installation directory',existing.root);const taktSeconds=Number(await ask('Takt seconds',String(defaults.taktSeconds)));if(!Number.isSafeInteger(taktSeconds)||taktSeconds<1||taktSeconds>86400)throw new Error('Takt must be between 1 and 86400 seconds');
    io.out(`Reconfigure installation ${existing.id} at ${directory}; existing native sessions and data are retained. Takt: ${taktSeconds} seconds.\n`);const answer=(await io.ask('Reconfigure (Y/n): ')).trim().toLowerCase();if(answer&&answer!=='y'&&answer!=='yes'){io.out('Reconfiguration cancelled.\n');return 0}
    const result=await reconfigureInstallation(existing,{directory,sourceRoot:options.sourceRoot??resolve(fileURLToPath(new URL('../../',import.meta.url))),taktSeconds},{...(options.locatorPath?{locatorPath:options.locatorPath}:{}),...(options.docker?{docker:options.docker}:{}),...(options.systemctl?{systemctl:options.systemctl}:{})});io.out(`Reconfigured installation: ${result.root}\n`);return 0;
  }
  const directory=await ask('Installation directory',defaults.directory);
  const takt=Number(await ask('Takt seconds',String(defaults.taktSeconds)));
  const providerText=await ask('Providers (copilot,codex)',defaults.providers.join(','));
  const codeExecutable=await ask('VS Code executable',defaults.codeExecutable);
  const dockerText=await ask('Docker executable (absolute path, or docker)',''+(defaults.dockerExecutable??'docker'));
  const providers=providerText.split(',').map(v=>v.trim()) as ('copilot'|'codex')[];
  if(!providers.includes('copilot')||providers.some(v=>!['copilot','codex'].includes(v))||new Set(providers).size!==providers.length)throw new Error('Select Copilot; Codex may be selected but is not yet available');
  if(!Number.isSafeInteger(takt)||takt<1||takt>86400)throw new Error('Takt must be between 1 and 86400 seconds');
  const dockerExecutable=dockerText==='docker'?undefined:dockerText;
  const docker=options.docker??new ProcessDocker(dockerExecutable??'docker');
  await checkDockerPreflight(directory,docker,'preview-'+randomUUID());
  const stage=mkdtempSync(join(options.tempParent??tmpdir(),'sf-setup-'));if(process.platform==='win32')protectWindowsDirectory(stage);mkdirSync(join(stage,'vault'),{mode:0o700});mkdirSync(join(stage,'request'),{mode:0o700});if(process.platform==='win32'){protectWindowsDirectory(join(stage,'vault'));protectWindowsDirectory(join(stage,'request'))}
  let launcher:{stop():void}|undefined;
  try {
    io.out('Sign in to the selected Copilot account in the private VS Code profile.\n');
    const auth=await (options.authenticate??authenticateViaCompanion)({root:stage,requestDir:join(stage,'request'),installationId:'preview-'+randomUUID(),codeExecutable,interactive:true});launcher=auth.launcher;
    const answers:SetupAnswers={directory,taktSeconds:takt,ownerId:'vscode',providers,stagedAuthRoot:stage,codeExecutable,sourceRoot:options.sourceRoot??resolve(fileURLToPath(new URL('../../',import.meta.url))),...(dockerExecutable?{dockerExecutable}:{})};
    const plan=await planInstall(answers,{docker});
    const serviceName=process.platform==='darwin'?`ai4devops-sf.${plan.id}`:process.platform==='win32'?`AI4DevOps-SF-${plan.id}`:`ai4devops-sf-${plan.id}`;
    io.out(`Installation: ${plan.directory}\nRuntime: ${join(plan.directory,'runtime')}\nVault: ${join(plan.directory,'vault')}\nLogin service: ${serviceName}\nProvider: VS Code / Copilot (${plan.account.label})\nTakt: ${plan.taktSeconds} seconds\nLimits: 1 active run, 30 active minutes, 100 starts/day, 2 transient retries\nCopilot grants: read:user, user:email; repository capabilities require separate approval\nLocal API origin: http://127.0.0.1:43117\n${plan.notices.join('\n')}${plan.notices.length?'\n':''}A second sign-in in the installed private profile may be required for refresh.\n`);
    const answer=(await io.ask('Install (Y/n): ')).trim().toLowerCase();if(answer&&answer!=='y'&&answer!=='yes'){io.out('Installation cancelled.\n');return 0}
    const installed=await applyInstall(plan,{docker,...(options.locatorPath?{locatorPath:options.locatorPath}:{})});
    const nextDefaults:SetupDefaults={directory,taktSeconds:takt,ownerId:'vscode',providers,codeExecutable,...(dockerExecutable?{dockerExecutable}:{})};saveDefaults(nextDefaults,options.defaultsPath);
    io.out(`Installation files are at ${installed.root}; user-service startup was requested. Desktop connection, provider isolation and repository activation still require verification.\n`);return 0;
  } finally {
    launcher?.stop();
    try{clearStagedCredential(stage)}catch{io.err('A staged credential could not be removed safely; inspect the retained private directory.\n')}
    io.err(`The temporary sign-in profile is retained at ${stage}. Close its VS Code window, then remove this owned directory manually.\n`);
  }
}
