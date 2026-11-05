/** Private P4 transport. Never accepts runtime settings from an imported recipe. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import images from '../release/images.json' with { type: 'json' };
import { ProbeBlocked } from './common.ts';

export { images };
export type DockerCommand = (args: string[]) => Promise<string>;
const exec = promisify(execFile);
export const dockerCommand: DockerCommand = async args => {
  const bin = process.env.SF_P4_DOCKER ?? 'docker';
  try {
    const result = await exec(bin, args, { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
    return (args[0] === 'logs' ? result.stdout + result.stderr : result.stdout).trim();
  }
  catch (error) {
    // execFile errors embed command args; do not surface them or raw daemon responses.
    const code = (error as NodeJS.ErrnoException).code;
    throw new ProbeBlocked(`Docker ${args[0]} failed (${typeof code === 'number' ? code : 'transport'}); inspect the owned resource, never retry a native start blindly`);
  }
};
type Resource = { kind: 'container' | 'volume'; name: string; removed: boolean };
export class OwnedDocker {
  readonly owner = `sf-p4-${randomUUID()}`;
  readonly resources: Resource[] = [];
  readonly outputDir: string;
  readonly command: DockerCommand;
  constructor(outputDir: string, command: DockerCommand = dockerCommand) { this.outputDir = outputDir; this.command = command; }
  async checkpoint(kind: Resource['kind'], name: string): Promise<void> {
    this.resources.push({ kind, name, removed: false }); await this.save();
  }
  async save(): Promise<void> {
    await mkdir(this.outputDir, { recursive: true });
    await writeFile(join(this.outputDir, `${this.owner}-resources.json`), JSON.stringify({ owner: this.owner, resources: this.resources }, null, 2) + '\n');
  }
  async volume(suffix: string): Promise<string> {
    const name = `${this.owner}-${suffix}`;
    await this.checkpoint('volume', name);
    await this.command(['volume', 'create', '--label', `sf.p4.owner=${this.owner}`, name]); return name;
  }
  async run(suffix: string, args: string[]): Promise<string> {
    const name = `${this.owner}-${suffix}`;
    await this.checkpoint('container', name);
    await this.command(['run', '--detach', '--name', name, '--label', `sf.p4.owner=${this.owner}`, ...args]); return name;
  }
  async inspect(name: string): Promise<any> { return JSON.parse(await this.command(['container', 'inspect', name]))[0]; }
  async cleanup(): Promise<void> {
    const failures: string[] = [];
    for (const resource of [...this.resources].reverse()) {
      if (resource.removed) continue;
      let obj: any;
      try { obj = JSON.parse(await this.command([resource.kind, 'inspect', resource.name]))[0]; }
      catch { failures.push(`${resource.name}: inspection unavailable; retained`); continue; }
      if ((obj.Config?.Labels ?? obj.Labels)?.['sf.p4.owner'] !== this.owner) { failures.push(`${resource.name}: ownership mismatch`); continue; }
      try {
        await this.command([resource.kind, 'rm', ...(resource.kind === 'container' ? ['--force'] : []), resource.name]);
        resource.removed = true; await this.save();
      } catch { failures.push(`${resource.name}: removal failed`); }
    }
    if (failures.length) throw new ProbeBlocked(failures.join('; '));
  }
}
export function restrictedArgs(network = 'none'): string[] {
  return ['--pull', 'never', '--platform', images.platform, '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--network', network, '--pids-limit', '256', '--memory', '2g', '--cpus', '2', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,uid=1000,gid=1000,mode=1777'];
}
export async function verifyImagePins(docker: OwnedDocker): Promise<void> {
  for (const image of [images.kestra.image, images.worker.image]) {
    const data = JSON.parse(await docker.command(['image', 'inspect', image]))[0];
    if (!data.RepoDigests?.includes(image) || data.Os !== 'linux' || data.Architecture !== 'amd64') throw new ProbeBlocked('Pinned linux/amd64 image unavailable');
  }
}

/** Historical headless bootstrap may reuse only existing, unconsumed, exactly owned volumes. */
export async function verifyReusableVolumes(docker: Pick<OwnedDocker,'owner'|'command'>, manifest: {owner:string;resources:Resource[]}, names: string[]): Promise<void> {
  if(manifest.owner!==docker.owner||!/^sf-p4-[a-zA-Z0-9-]+$/.test(manifest.owner)||!Array.isArray(manifest.resources))throw new ProbeBlocked('Invalid setup manifest ownership');
  for(const name of names){
    const records=manifest.resources.filter(resource=>resource.kind==='volume'&&resource.name===name);
    if(records.length!==1||records[0]!.removed!==false)throw new ProbeBlocked('Setup volume manifest consumed or ambiguous; create a fresh owned setup');
  }
  for(const name of names){
    let volume:any;try{volume=JSON.parse(await docker.command(['volume','inspect',name]))[0];}catch{throw new ProbeBlocked('Setup volume absent; create a fresh owned setup');}
    if(volume?.Name!==name||volume.Labels?.['sf.p4.owner']!==docker.owner)throw new ProbeBlocked('Setup volume ownership mismatch');
  }
}
