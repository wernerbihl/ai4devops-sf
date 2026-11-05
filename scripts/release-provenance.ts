import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { artifactFiles, sha256, verifyReleaseProvenance } from '../src/release/provenance.ts';
const roots=['src/','runtime/','bin/','scripts/','protocol/','recipes/','release/dashboard/'];
const names=['.gitattributes','package.json','package-lock.json','tsconfig.json','tsconfig.build.json','release/images.json'];
export function produceReleaseProvenance(root=process.cwd(), check=false) {
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,maxBuffer:32*1024*1024});
  const included=(path:string)=>names.includes(path)||roots.some(prefix=>path.startsWith(prefix));
  const files=git('ls-files','-z').toString().split('\0').filter(included).sort();
  const sourceCommit=git('log','-1','--format=%H','--',...roots.map(path=>path.slice(0,-1)),...names).toString().trim();
  if(!/^[a-f0-9]{40}$/.test(sourceCommit))throw Error('Committed release inputs required');
  const index=git('ls-files','--stage','-z').toString().split('\0').filter(Boolean).flatMap(record=>{
    const tab=record.indexOf('\t'),path=record.slice(tab+1);if(!included(path))return [];
    const [mode,oid,stage]=record.slice(0,tab).split(' ');
    if(stage!=='0')throw Error('Production input index has unresolved merge stages: '+path);
    return [JSON.stringify([path,mode,oid])];
  }).sort();
  const tree=git('ls-tree','-r','-z',sourceCommit).toString().split('\0').filter(Boolean).flatMap(record=>{
    const tab=record.indexOf('\t'),path=record.slice(tab+1);if(!included(path))return [];
    const [mode,,oid]=record.slice(0,tab).split(' ');return [JSON.stringify([path,mode,oid])];
  }).sort();
  if(index.join('\n')!==tree.join('\n'))throw Error('Production input index differs from committed source');
  const committed=git('ls-tree','-r','--name-only','-z',sourceCommit).toString().split('\0').filter(included).sort();
  if(files.join('\n')!==committed.join('\n'))throw Error('Release source inventory differs from commit');
  const untracked=git('ls-files','--others','-z').toString().split('\0').filter(included);
  if(untracked.length)throw Error('Uncommitted release input: '+untracked[0]);
  const sourceFiles=Object.fromEntries(files.map(path=>{
    if(!lstatSync(join(root,path)).isFile())throw Error('Release source must be a regular file');
    const bytes=readFileSync(join(root,path));
    if(!bytes.equals(git('show',sourceCommit+':'+path)))throw Error('Commit exact release input first: '+path);
    return [path,sha256(bytes)];
  }));
  if(check){if(!readFileSync(join(root,'release/runtime-lock.json')).equals(readFileSync(join(root,'package-lock.json'))))throw Error('Runtime dependency lock differs');}
  else copyFileSync(join(root,'package-lock.json'),join(root,'release/runtime-lock.json'));
  const artifacts=Object.fromEntries(artifactFiles(root).map(path=>[path,sha256(readFileSync(join(root,path)))]));
  const core={schemaVersion:1,version:JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version,sourceCommit,sourceFiles,artifacts};
  const bytes=JSON.stringify({...core,releaseDigest:sha256(JSON.stringify(core))},null,2)+'\n';
  const target=join(root,'release/provenance.json');
  if(check){if(readFileSync(target,'utf8')!==bytes)throw Error('Release provenance differs from committed inputs/build');}
  else writeFileSync(target,bytes);
  return verifyReleaseProvenance(root);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify(produceReleaseProvenance(process.cwd(),process.argv.includes('--check')),null,2));
