import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, copyFileSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export interface RuntimeCopy { root:string; node:string; serviceEntry:string; version:string }
function versionSupported(value:string):boolean {
  const parts=value.split('.').map(Number);const required=[24,22,2];
  for(let i=0;i<3;i++){if(parts[i]!>required[i]!)return true;if(parts[i]!<required[i]!)return false}return true;
}
/** Copies an already built package after confirmation; it never invokes npm or a sibling checkout. */
export async function copyRuntime(input:{sourceRoot:string;target:string}):Promise<RuntimeCopy> {
  if(!versionSupported(process.versions.node))throw new Error('Node.js >=24.22.2 required');
  const source=realpathSync(input.sourceRoot);const target=resolve(input.target);const parent=dirname(target);const stat=lstatSync(parent);
  if(input.target!==target||realpathSync(parent)!==parent||!stat.isDirectory()||(process.platform!=='win32'&&(stat.uid!==process.getuid!()||(stat.mode&0o077)!==0)))throw new Error('Private runtime parent directory required');
  if(process.platform==='win32')throw new Error('Windows protected runtime copy is unavailable');
  const pkg=JSON.parse(readFileSync(join(source,'package.json'),'utf8')) as {name:string;version:string;dependencies:Record<string,string>};
  const lock=JSON.parse(readFileSync(join(source,'package-lock.json'),'utf8')) as {packages:Record<string,{dev?:boolean;optional?:boolean;link?:boolean;version?:string}>};
  if(!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(pkg.version)||!lock.packages)throw new Error('Invalid built package manifest');
  const packages=Object.entries(lock.packages).filter(([name,entry])=>name.startsWith('node_modules/')&&!entry.dev);
  if(!packages.length)throw new Error('Production dependency manifest is empty');
  try{mkdirSync(target,{mode:0o700})}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('Runtime target already exists');throw error}
  const record=join(target,'runtime-owned.json');
  const recordFd=openSync(record,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(recordFd,JSON.stringify({schemaVersion:1,state:'copying',version:pkg.version}));fsyncSync(recordFd)}finally{closeSync(recordFd)}
  const parentFd=openSync(parent,constants.O_RDONLY);try{fsyncSync(parentFd)}finally{closeSync(parentFd)}
  const copyTree=(from:string,to:string,excludeNested:boolean)=>cpSync(from,to,{recursive:true,errorOnExist:true,force:false,filter:path=>{
    const rel=relative(from,path);if(excludeNested&&rel.split(sep).includes('node_modules'))return false;
    if(lstatSync(path).isSymbolicLink())throw new Error('Runtime source contains a symbolic link');return true;
  }});
  copyTree(join(source,'dist'),join(target,'dist'),false);
  copyTree(join(source,'bin'),join(target,'bin'),false);
  copyFileSync(join(source,'package-lock.json'),join(target,'package-lock.json'));
  for(const [name,entry] of packages){
    const segments=name.split('/');if(segments.some(part=>!part||part==='.'||part==='..')||entry.link)throw new Error('Unsupported production dependency path');
    const from=join(source,...segments);if(!existsSync(from)){if(entry.optional)continue;throw new Error('Required production dependency unavailable')}
    if(realpathSync(from)!==from)throw new Error('Production dependency must be local to this package');
    const to=join(target,...segments);mkdirSync(dirname(to),{recursive:true,mode:0o700});copyTree(from,to,true);
  }
  const node=join(target,'node');copyFileSync(realpathSync(process.execPath),node);chmodSync(node,0o755);
  const nodeSha256=createHash('sha256').update(readFileSync(node)).digest('hex');
  writeFileSync(join(target,'package.json'),JSON.stringify({name:pkg.name,version:pkg.version,type:'module',bin:{'ai4devops-sf':'bin/ai4devops-sf.mjs'},dependencies:pkg.dependencies}),{flag:'wx',mode:0o600});
  const serviceEntry=join(target,'dist','service','main.js');if(!existsSync(serviceEntry))throw new Error('Built private service entry is unavailable');
  const readyFd=openSync(record,constants.O_WRONLY|constants.O_TRUNC|constants.O_NOFOLLOW);
  try{writeFileSync(readyFd,JSON.stringify({schemaVersion:1,state:'ready',version:pkg.version,nodeSha256,packages:packages.map(([name,entry])=>({name,version:entry.version}))}));fsyncSync(readyFd)}finally{closeSync(readyFd)}
  const dirFd=openSync(target,constants.O_RDONLY);try{fsyncSync(dirFd)}finally{closeSync(dirFd)}
  return {root:target,node,serviceEntry,version:pkg.version};
}
