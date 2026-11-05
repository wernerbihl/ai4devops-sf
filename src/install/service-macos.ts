import { spawn } from 'node:child_process';
import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { LinuxServiceSpec } from './service-linux.ts';

function xml(value:string):string {
  if(!value||/[\x00-\x1f\x7f]/.test(value))throw new Error('Invalid LaunchAgent argument');
  return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
}
export function launchdPlist(spec:LinuxServiceSpec):string {
  if(![spec.node,spec.entry,spec.root].every(isAbsolute)||!/^[A-Za-z0-9_-]{1,100}$/.test(spec.id)||(spec.dockerExecutable!==undefined&&!isAbsolute(spec.dockerExecutable)))throw new Error('Absolute service paths and an installation ID are required');
  const args=[spec.node,spec.entry,spec.id,spec.root].map(value=>`    <string>${xml(value)}</string>`).join('\n');
  const env=spec.dockerExecutable===undefined?'':`  <key>EnvironmentVariables</key>\n  <dict><key>SF_DOCKER_EXECUTABLE</key><string>${xml(spec.dockerExecutable)}</string></dict>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>ai4devops-sf.${xml(spec.id)}</string>\n  <key>ProgramArguments</key>\n  <array>\n${args}\n  </array>\n${env}  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n</dict></plist>\n`;
}
export class MacOSStartup {
  readonly label:string;readonly plistPath:string;private readonly spec:LinuxServiceSpec;private readonly launchctl:string;private readonly domain:string;
  constructor(input:LinuxServiceSpec & {home?:string;launchctl?:string;uid?:number}) {
    launchdPlist(input);this.spec={node:input.node,entry:input.entry,id:input.id,root:input.root,...(input.dockerExecutable?{dockerExecutable:input.dockerExecutable}:{})};
    const home=input.home??homedir();if(!isAbsolute(home))throw new Error('Absolute user home required');
    const uid=input.uid??process.getuid?.();if(!Number.isSafeInteger(uid)||uid!<=0)throw new Error('Logged-in nonroot user required');
    this.domain=`gui/${uid}`;this.label=`ai4devops-sf.${input.id}`;this.plistPath=join(home,'Library','LaunchAgents',`${this.label}.plist`);this.launchctl=input.launchctl??'/bin/launchctl';
  }
  private command(...args:string[]):Promise<{code:number;output:string}> {
    return new Promise((resolve,reject)=>{const child=spawn(this.launchctl,args,{shell:false,stdio:['ignore','pipe','ignore']});let done=false;let output='';
      const finish=(code?:number)=>{if(done)return;done=true;clearTimeout(timer);code===undefined?reject(new Error('User launch service unavailable')):resolve({code,output})};
      const timer=setTimeout(()=>{child.kill();finish()},30000);child.stdout.on('data',b=>{output+=b.toString();if(output.length>65536){child.kill();finish()}});child.once('error',()=>finish());child.once('exit',code=>finish(code??undefined));});
  }
  private async requireCommand(...args:string[]):Promise<void>{if((await this.command(...args)).code!==0)throw new Error('User launch service did not confirm the operation')}
  private verify():void{const stat=lstatSync(this.plistPath);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid!()||realpathSync(this.plistPath)!==this.plistPath||readFileSync(this.plistPath,'utf8')!==launchdPlist(this.spec))throw new Error('Owned LaunchAgent changed; retain it for attention')}
  async install():Promise<void>{
    if(process.platform!=='darwin')throw new Error('LaunchAgent installation requires macOS');
    const directory=resolve(this.plistPath,'..');mkdirSync(directory,{recursive:true,mode:0o700});const stat=lstatSync(directory);if(!stat.isDirectory()||stat.uid!==process.getuid!()||realpathSync(directory)!==directory)throw new Error('Unsafe LaunchAgent directory');
    let fd:number;try{fd=openSync(this.plistPath,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o644)}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;this.verify();throw new Error('Existing LaunchAgent requires reconciliation before reinstallation')}
    try{writeFileSync(fd,launchdPlist(this.spec));fsyncSync(fd)}finally{closeSync(fd)}
    const dir=openSync(directory,constants.O_RDONLY);try{fsyncSync(dir)}finally{closeSync(dir)}
    await this.requireCommand('bootstrap',this.domain,this.plistPath);await this.requireCommand('enable',`${this.domain}/${this.label}`);
  }
  async start():Promise<void>{this.verify();const result=await this.command('print',`${this.domain}/${this.label}`);if(result.code===113){await this.requireCommand('bootstrap',this.domain,this.plistPath);return}if(result.code!==0)throw new Error('LaunchAgent status is unknown');if(!/\bstate\s*=\s*running\b/.test(result.output))await this.requireCommand('kickstart',`${this.domain}/${this.label}`)}
  async stop():Promise<void>{this.verify();await this.requireCommand('bootout',this.domain,this.plistPath)}
  async status():Promise<'running'|'stopped'>{this.verify();const result=await this.command('print',`${this.domain}/${this.label}`);if(result.code===113)return 'stopped';if(result.code!==0)throw new Error('LaunchAgent status is unknown');return /\bstate\s*=\s*running\b/.test(result.output)?'running':'stopped'}
  async remove():Promise<void>{
    this.verify();const current=await this.command('print',`${this.domain}/${this.label}`);
    if(current.code===0){await this.requireCommand('bootout',this.domain,this.plistPath);const after=await this.command('print',`${this.domain}/${this.label}`);if(after.code!==113)throw new Error('LaunchAgent removal is unconfirmed')}
    else if(current.code!==113)throw new Error('LaunchAgent status is unknown');
    this.verify();unlinkSync(this.plistPath);
  }
}
