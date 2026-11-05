import { randomBytes, randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { assertWindowsPrivateDirectory, writeWindowsPrivateFile } from '../platform/windows-private.ts';
import { dockerBind, kestraImagePins, type DockerPort } from '../kestra/deployment.ts';

function patched(version:string):boolean {
  const m=/^(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/.exec(version);if(!m||/-(?:rc|beta|alpha|dev)/i.test(version))return false;
  const major=Number(m[1]),minor=Number(m[2]),patch=Number(m[3]);
  return major>=26 || major===25 && (minor>0||patch>=5) || major===23 && (minor>0||patch>=11);
}
export function inspectSelectedRoot(root:string):{exists:boolean} {
  if(process.platform!=='win32'&&process.getuid!()===0)throw new Error('Install as a nonroot user');
  if(resolve(root)!==root)throw new Error('Select an absolute installation directory');
  let existing=root;while(!existsSync(existing)){const parent=dirname(existing);if(parent===existing)throw new Error('Installation parent unavailable');existing=parent}
  if(realpathSync(existing)!==existing||!lstatSync(existing).isDirectory())throw new Error('Installation path must not cross a symbolic link');
  accessSync(existing,constants.W_OK);
  if(existing===root){if(process.platform==='win32')assertWindowsPrivateDirectory(root);else {const s=lstatSync(root);if(s.uid!==process.getuid!()||(s.mode&0o077)!==0)throw new Error('Select an empty private installation directory owned by this user')}if(readdirSync(root).length)throw new Error('Select an empty private installation directory owned by this user')}
  return {exists:existing===root};
}
export async function pinnedBaseAvailable(docker:DockerPort):Promise<boolean> {
  let data:string;try{data=await docker.command(['image','inspect',kestraImagePins.worker.image])}catch{return false}
  const image=JSON.parse(data)[0];if(!image?.RepoDigests?.includes(kestraImagePins.worker.image)||image.Os!=='linux'||image.Architecture!=='amd64')throw new Error('Pinned Docker base image has unexpected identity or platform');
  return true;
}
/** Tests the selected host path itself with a fixed nonsecret sentinel and no network or published ports. */
export async function probeSelectedRoot(root:string,docker:DockerPort,installationId:string):Promise<void> {
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(installationId)||realpathSync(root)!==root)throw new Error('Invalid selected installation root');
  const nonce=randomBytes(24).toString('hex');const path=join(root,`.sf-bind-${randomUUID()}`);
  let fd:number|undefined;if(process.platform==='win32')writeWindowsPrivateFile(path,Buffer.from(nonce));else fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);const stat=lstatSync(path);let open=fd!==undefined;
  try {
    if(fd!==undefined){writeFileSync(fd,nonce);fsyncSync(fd);closeSync(fd);open=false;}
    const script="process.stdout.write(require('node:fs').readFileSync('/sf-bind-check','utf8'))";
    let result:string;try{result=await docker.command(['run','--rm','--pull','never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user',process.platform==='win32'?'1000:1000':`${process.getuid!()}:${process.getgid!()}`,'--label',`sf.installation=${installationId}`,'--label','sf.component=bind-preflight','--mount',dockerBind(path,'/sf-bind-check',true),'--entrypoint','node',kestraImagePins.worker.image,'-e',script])}catch{throw new Error('Docker cannot access the selected installation root; choose a root supported by the selected daemon or fix its host bind mapping')}
    if(result!==nonce)throw new Error('Docker bind proof did not match the selected installation root');
  } finally {
    if(open&&fd!==undefined)closeSync(fd);
    const current=lstatSync(path);if(current.dev!==stat.dev||current.ino!==stat.ino)throw new Error('Bind sentinel identity changed; retain it for inspection');unlinkSync(path);
  }
}
export async function checkDockerPreflight(root:string,docker:DockerPort,installationId:string):Promise<{daemonVersion:string;baseAvailable:boolean;bindProof:'passed'|'pending'}> {
  const selected=inspectSelectedRoot(root);
  let version:unknown;try{version=JSON.parse(await docker.command(['version','--format','{{json .Server.Version}}']))}catch{throw new Error('Docker daemon unavailable; start the selected Docker daemon and retry')}
  if(typeof version!=='string'||!patched(version))throw new Error('Docker daemon version is unverified or has the internal DNS isolation vulnerability; upgrade Docker');
  const baseAvailable=await pinnedBaseAvailable(docker);
  if(baseAvailable&&selected.exists){await probeSelectedRoot(root,docker,installationId);return {daemonVersion:version,baseAvailable,bindProof:'passed'}}
  return {daemonVersion:version,baseAvailable,bindProof:'pending'};
}
