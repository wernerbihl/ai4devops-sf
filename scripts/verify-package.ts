import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyInstall } from './verify-install.ts';
export interface PackageReport { artifact:string; version:string; platform:string; node:string; requiresSiblingCheckout:false; requiresBun:false; commands:string[]; privateDaemon:'passed'; install:Awaited<ReturnType<typeof verifyInstall>> }
export async function verifyPackage(tarball:string,scratchRoot:string):Promise<PackageReport>{
  tarball=resolve(tarball);scratchRoot=resolve(scratchRoot);mkdirSync(scratchRoot,{recursive:true});
  const cache=join(scratchRoot,'empty npm cache');mkdirSync(cache);
  const project=join(scratchRoot,'consumer 工場');mkdirSync(project);execFileSync(process.platform==='win32'?'npm.cmd':'npm',['install','--offline','--omit=dev','--ignore-scripts','--no-audit','--no-fund','--cache',cache,'--prefix',project,tarball],{stdio:'pipe',env:{...process.env,NODE_PATH:'',npm_config_cache:cache},timeout:120_000});
  const root=join(project,'node_modules/ai4devops-sf');
  if(existsSync(join(root,'src'))||existsSync(join(root,'node_modules/@vscode/vsce'))||existsSync(join(root,'node_modules/typescript')))throw Error('Development source/dependencies leaked into runtime');
  const manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  const verifier=pathToFileURL(join(root,'dist/release/provenance.js')).href;
  execFileSync(process.execPath,['--input-type=module','-e',`const {verifyReleaseProvenance}=await import(${JSON.stringify(verifier)});verifyReleaseProvenance(${JSON.stringify(root)});`],{cwd:project,env:{...process.env,NODE_PATH:''}});
  const commands=['setup','next','uninstall'];
  for(const command of commands){const output=execFileSync(process.execPath,[join(root,'bin/ai4devops-sf.mjs'),command,'--help'],{cwd:project,encoding:'utf8'});if(!output.includes('setup|next|uninstall'))throw Error('Missing public command');}
  const install=await verifyInstall({packageRoot:root,scratchRoot});
  return {artifact:tarball,version:manifest.version,platform:process.platform,node:process.versions.node,requiresSiblingCheckout:false,requiresBun:false,commands,privateDaemon:install.privateDaemon,install};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify(await verifyPackage(process.argv[2]!,process.argv[3]!),null,2));
