import { isAbsolute } from 'node:path';

export interface LinuxServiceSpec { node: string; entry: string; id: string; root: string; dockerExecutable?: string }

/** Systemd performs its own specifier and environment expansion even without a shell. */
function unitArgument(value: string): string {
  if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid service argument');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$') + '"';
}

export function linuxUnit(spec: LinuxServiceSpec): string {
  if (![spec.node, spec.entry, spec.root].every(isAbsolute) || !/^[A-Za-z0-9_-]{1,100}$/.test(spec.id)) throw new Error('Absolute service paths and an installation ID are required');
  const command = [spec.node, spec.entry, spec.id, spec.root].map(unitArgument).join(' ');
  let dockerEnv='';
  if(spec.dockerExecutable!==undefined){if(!isAbsolute(spec.dockerExecutable)||/[\x00-\x1f\x7f]/.test(spec.dockerExecutable))throw new Error('Absolute Docker executable required');const value=('SF_DOCKER_EXECUTABLE='+spec.dockerExecutable).replaceAll('\\','\\\\').replaceAll('\"','\\\"').replaceAll('%','%%');dockerEnv=`Environment=\"${value}\"\n`;}
  return `[Unit]\nDescription=AI4DevOps Software Factory\nAfter=default.target\n\n[Service]\nType=simple\n${dockerEnv}ExecStart=${command}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
}

import { spawn } from 'node:child_process';
import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export class LinuxStartup {
  readonly unitName:string; readonly unitPath:string; private readonly spec:LinuxServiceSpec; private readonly systemctl:string;
  constructor(input:LinuxServiceSpec & {configHome?:string;systemctl?:string}) {
    linuxUnit(input);this.spec={node:input.node,entry:input.entry,id:input.id,root:input.root,...(input.dockerExecutable?{dockerExecutable:input.dockerExecutable}:{})};
    const base=input.configHome??process.env.XDG_CONFIG_HOME??join(homedir(),'.config');
    if(!isAbsolute(base))throw new Error('Absolute user configuration path required');
    this.unitName=`ai4devops-sf-${input.id}.service`;this.unitPath=join(base,'systemd','user',this.unitName);this.systemctl=input.systemctl??'systemctl';
  }
  private async command(...args:string[]):Promise<number> {
    return new Promise((resolve,reject)=>{const child=spawn(this.systemctl,['--user',...args],{shell:false,stdio:'ignore'});let done=false;
      const finish=(value?:number)=>{if(done)return;done=true;clearTimeout(timer);value===undefined?reject(new Error('User service manager unavailable')):resolve(value)};
      const timer=setTimeout(()=>{child.kill();finish()},30000);child.once('error',()=>finish());child.once('exit',code=>finish(code??undefined));});
  }
  private async requireCommand(...args:string[]):Promise<void> {if(await this.command(...args)!==0)throw new Error('User service manager did not confirm the operation')}
  private verify():void {
    const stat=lstatSync(this.unitPath);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid!()||realpathSync(this.unitPath)!==this.unitPath||readFileSync(this.unitPath,'utf8')!==linuxUnit(this.spec))throw new Error('Owned user service changed; retain it for attention');
  }
  async install():Promise<void> {
    if(process.platform!=='linux')throw new Error('Linux user service requires Linux');
    const directory=resolve(this.unitPath,'..');mkdirSync(directory,{recursive:true,mode:0o700});
    const stat=lstatSync(directory);if(!stat.isDirectory()||stat.uid!==process.getuid!()||realpathSync(directory)!==directory)throw new Error('Unsafe user service directory');
    let fd:number;try{fd=openSync(this.unitPath,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o644)}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;this.verify();await this.requireCommand('daemon-reload');await this.requireCommand('enable',this.unitName);return}
    try{writeFileSync(fd,linuxUnit(this.spec));fsyncSync(fd)}finally{closeSync(fd)}
    const dir=openSync(directory,constants.O_RDONLY);try{fsyncSync(dir)}finally{closeSync(dir)}
    await this.requireCommand('daemon-reload');await this.requireCommand('enable',this.unitName);
  }
  async start():Promise<void>{this.verify();await this.requireCommand('start',this.unitName)}
  async stop():Promise<void>{this.verify();await this.requireCommand('stop',this.unitName)}
  async status():Promise<'running'|'stopped'>{this.verify();const code=await this.command('is-active','--quiet',this.unitName);if(code===0)return 'running';if(code===3)return 'stopped';throw new Error('User service status is unknown')}
  async remove():Promise<void>{this.verify();await this.requireCommand('disable','--now',this.unitName);this.verify();unlinkSync(this.unitPath);await this.requireCommand('daemon-reload')}
}
