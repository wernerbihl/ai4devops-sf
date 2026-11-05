import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
export interface ReleaseProvenance {
  schemaVersion: 1; version: string; sourceCommit: string;
  sourceFiles: Record<string,string>; artifacts: Record<string,string>; releaseDigest: string;
}
export const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
export function artifactFiles(root: string): string[] {
  const files: string[] = [];
  function walk(directory: string) {
    for (const entry of readdirSync(join(root,directory),{withFileTypes:true})) {
      const path=directory+'/'+entry.name;
      if (entry.isSymbolicLink()) throw Error('Release artifact symbolic link refused');
      if (entry.isDirectory()) walk(path); else if(entry.isFile()) files.push(path);
      else throw Error('Invalid release artifact');
    }
  }
  walk('dist'); walk('bin'); return files.sort();
}
/** Offline content verification. Trust comes from the reviewed release artifact, never runtime Git or a mutable stamp. */
export function verifyReleaseProvenance(root: string): ReleaseProvenance {
  const manifest=JSON.parse(readFileSync(join(root,'release/provenance.json'),'utf8')) as ReleaseProvenance;
  if (manifest.schemaVersion!==1 || !/^\d+\.\d+\.\d+$/.test(manifest.version) || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit)
    || Object.keys(manifest).sort().join(',')!==['schemaVersion','version','sourceCommit','sourceFiles','artifacts','releaseDigest'].sort().join(',')) throw Error('Invalid release provenance schema');
  for (const inventory of [manifest.sourceFiles,manifest.artifacts]) {
    if (!inventory || Array.isArray(inventory) || !Object.keys(inventory).length) throw Error('Empty release inventory');
    for (const [path,hash] of Object.entries(inventory)) if (!/^[\w./-]+$/.test(path) || path.split('/').some(part=>!part||part==='.'||part==='..') || !/^[a-f0-9]{64}$/.test(hash)) throw Error('Invalid release inventory');
  }
  const {releaseDigest,...core}=manifest;
  if (sha256(JSON.stringify(core))!==releaseDigest) throw Error('Release digest mismatch');
  const actual=artifactFiles(root);
  if (actual.join('\n')!==Object.keys(manifest.artifacts).sort().join('\n')) throw Error('Release artifact inventory mismatch');
  for(const path of actual) {
    const stat=lstatSync(join(root,path));
    if(!stat.isFile()||stat.isSymbolicLink()||sha256(readFileSync(join(root,path)))!==manifest.artifacts[path])throw Error('Release artifact hash mismatch: '+path);
  }
  return manifest;
}
export function imageReleaseMatches(labels: Record<string,unknown> | undefined, expected: Pick<ReleaseProvenance,'sourceCommit'|'releaseDigest'>): boolean {
  return labels?.['sf.source']===expected.sourceCommit && labels?.['sf.release']===expected.releaseDigest;
}
