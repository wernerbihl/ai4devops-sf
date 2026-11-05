import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DockerPort } from './deployment.ts';
import { ensure } from '../storage/database.ts';
const contains=(parent:string,child:string)=>{const r=relative(parent,child);return r===''||r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r)};
/** Read-only Docker mount survey. Never stop or modify an unrelated container. */
export async function inspectProtectedMounts(root:string,engineId:string,docker:DockerPort):Promise<string[]> {
  ensure(resolve(root)===root&&/^[a-f0-9]{64}$/.test(engineId),'mount_survey','Valid installation and engine identity required');
  const protectedPaths=['factory.sqlite','kestra','vault','auth','repositories','workspace-manifests','runtime.json'].map(name=>join(root,name));
  const ids=(await docker.command(['container','ls','--all','--no-trunc','--format','{{.ID}}'])).split('\n').map(s=>s.trim()).filter(Boolean);
  ensure(ids.includes(engineId)&&new Set(ids).size===ids.length&&ids.every(id=>/^[a-f0-9]{64}$/.test(id)),'mount_survey','Docker container inventory is uncertain');
  const blocked:string[]=[];
  for(const id of ids){
    const values=JSON.parse(await docker.command(['container','inspect',id]));const c=values?.[0];
    ensure(values?.length===1&&c?.Id===id&&Array.isArray(c.Mounts),'mount_survey','Container mount inspection is uncertain');
    if(id===engineId)continue; // Exact engine mounts are verified separately against its protected manifest.
    for(const mount of c.Mounts){
      if(mount.Type==='tmpfs')continue;
      ensure(mount.Type==='bind'||mount.Type==='volume','mount_survey','Container mount type is uncertain');
      ensure(typeof mount.Source==='string'&&isAbsolute(mount.Source)&&resolve(mount.Source)===mount.Source,'mount_survey','Container source path is uncertain');
      if(protectedPaths.some(path=>contains(mount.Source,path)||contains(path,mount.Source))){blocked.push(id);break}
    }
  }
  return blocked.sort();
}
