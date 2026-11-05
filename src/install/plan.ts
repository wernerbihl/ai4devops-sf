import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { assertWindowsPrivateDirectory } from '../platform/windows-private.ts';
import { ProcessDocker, type DockerPort } from '../kestra/deployment.ts';
import { loadCompanionCredential } from './companion-auth.ts';
import { checkDockerPreflight } from './docker-preflight.ts';

export interface SetupAnswers { directory:string; taktSeconds:number; ownerId:'vscode'; providers:('copilot'|'codex')[]; stagedAuthRoot:string; codeExecutable:string; sourceRoot:string; dockerExecutable?:string }
export interface InstallPlan extends SetupAnswers { id:string; account:{id:string;label:string}; daemonVersion:string; baseAvailable:boolean; bindProof:'passed'|'pending'; notices:string[] }
/** Pure/read-only preview except for an owned temporary bind sentinel, removed before return. */
export async function planInstall(answers:SetupAnswers,options:{docker?:DockerPort}={}):Promise<InstallPlan> {
  if(answers.ownerId!=='vscode'||!Array.isArray(answers.providers)||!answers.providers.includes('copilot')||new Set(answers.providers).size!==answers.providers.length||answers.providers.some(p=>!['copilot','codex'].includes(p)))throw new Error('Select at least the supported VS Code Copilot provider');
  if(!Number.isSafeInteger(answers.taktSeconds)||answers.taktSeconds<1||answers.taktSeconds>86400)throw new Error('Takt must be between 1 and 86400 seconds');
  if(resolve(answers.directory)!==answers.directory||!existsSync(dirname(answers.directory)))throw new Error('Select an absolute installation directory with an existing parent');
  if(resolve(answers.sourceRoot)!==answers.sourceRoot||realpathSync(answers.sourceRoot)!==answers.sourceRoot||!existsSync(join(answers.sourceRoot,'dist','service','main.js')))throw new Error('Built factory runtime is unavailable');
  if(resolve(answers.codeExecutable)!==answers.codeExecutable)throw new Error('Select an absolute VS Code executable');
  const executable=realpathSync(answers.codeExecutable);if(!lstatSync(executable).isFile())throw new Error('VS Code executable unavailable');accessSync(executable,constants.X_OK);
  let dockerExecutable=answers.dockerExecutable;
  if(dockerExecutable===undefined&&!options.docker){
    for(const directory of (process.env.PATH??'').split(process.platform==='win32'?';':':')){const candidate=resolve(directory||'.',process.platform==='win32'?'docker.exe':'docker');try{accessSync(candidate,constants.X_OK);dockerExecutable=realpathSync(candidate);break}catch{}}
    if(!dockerExecutable)throw new Error('Docker executable unavailable; select its absolute path');
  }
  if(dockerExecutable!==undefined){if(resolve(dockerExecutable)!==dockerExecutable)throw new Error('Select an absolute Docker executable');dockerExecutable=realpathSync(dockerExecutable);accessSync(dockerExecutable,constants.X_OK)}
  if(process.platform==='win32')assertWindowsPrivateDirectory(answers.stagedAuthRoot);else {const staging=lstatSync(answers.stagedAuthRoot);if(realpathSync(answers.stagedAuthRoot)!==answers.stagedAuthRoot||!staging.isDirectory()||staging.uid!==process.getuid!()||(staging.mode&0o077)!==0)throw new Error('Protected staged provider authentication is unavailable');}
  const credential=loadCompanionCredential(answers.stagedAuthRoot,{ref:'native-copilot',resource:'https://api.github.com',scopes:['read:user','user:email']});
  const id=randomUUID();const docker=options.docker??new ProcessDocker(dockerExecutable??'docker');const check=await checkDockerPreflight(answers.directory,docker,id);
  return {...answers,...(dockerExecutable?{dockerExecutable}:{}),codeExecutable:executable,id,account:credential.account,...check,notices:[...(check.bindProof==='pending'?['Selected-root Docker bind proof is pending and will run immediately after confirmation']:[]),...(answers.providers.includes('codex')?['Codex execution remains unavailable until its host capability is verified']:[])]};
}
