import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readPrivateFile } from '../service/config.ts';
import { LinuxStartup } from './service-linux.ts';
import { MacOSStartup } from './service-macos.ts';
import type { Installation } from './locator.ts';

export async function loadOwnedService(installation:Installation,options:{systemctl?:string}={}):Promise<LinuxStartup|MacOSStartup> {
  if(!['linux','darwin'].includes(process.platform))throw new Error('This platform does not yet have a protected login-service adapter');
  const owner=JSON.parse(readPrivateFile(join(installation.root,'install-owner.json')).toString());
  if(owner.schemaVersion!==1||owner.installationId!==installation.id||owner.root!==installation.root)throw new Error('Installation ownership does not match');
  const runtime=dirname(installation.node);if(installation.serviceEntry!==join(runtime,'dist','service','main.js')||runtime!==join(installation.root,'runtime',installation.version))throw new Error('Installed runtime path mismatch');
  const record=JSON.parse(readPrivateFile(join(runtime,'runtime-owned.json')).toString());
  if(record.schemaVersion!==1||record.state!=='ready'||record.version!==installation.version||!/^[a-f0-9]{64}$/.test(record.nodeSha256))throw new Error('Installed runtime manifest is unavailable');
  for(const path of [installation.node,installation.serviceEntry]){const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid!()||(s.mode&0o022)!==0||realpathSync(path)!==path)throw new Error('Installed runtime file is unsafe')}
  const hash=createHash('sha256');for await(const chunk of createReadStream(installation.node))hash.update(chunk as Buffer);if(hash.digest('hex')!==record.nodeSha256)throw new Error('Installed Node executable changed');
  const startup=JSON.parse(readPrivateFile(join(installation.root,'startup.json')).toString());
  if(startup.schemaVersion!==1||startup.installationId!==installation.id||Object.keys(startup).some(k=>!['schemaVersion','installationId','kind','unitPath','plistPath','codeExecutable','requestDir','dockerExecutable'].includes(k)))throw new Error('Installed service manifest is invalid');
  const spec={node:installation.node,entry:installation.serviceEntry,id:installation.id,root:installation.root,...(startup.dockerExecutable?{dockerExecutable:startup.dockerExecutable}:{})};
  if(process.platform==='darwin'){
    if(startup.kind!=='launchagent'||typeof startup.plistPath!=='string')throw new Error('Installed LaunchAgent manifest is invalid');
    const home=dirname(dirname(dirname(startup.plistPath)));const service=new MacOSStartup({...spec,home});
    if(service.plistPath!==startup.plistPath)throw new Error('Installed LaunchAgent path changed');return service;
  }
  if(startup.kind!=='systemd-user'||typeof startup.unitPath!=='string')throw new Error('Installed service manifest is invalid');
  const configHome=dirname(dirname(dirname(startup.unitPath)));
  const service=new LinuxStartup({...spec,configHome,...(options.systemctl?{systemctl:options.systemctl}:{})});
  if(service.unitPath!==startup.unitPath)throw new Error('Installed service path changed');
  return service;
}
