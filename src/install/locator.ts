import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { readPrivateFile } from '../service/config.ts';
import { protectWindowsDirectory, writeWindowsPrivateFile } from '../platform/windows-private.ts';

export interface Installation { schemaVersion:1; id:string; root:string; node:string; serviceEntry:string; version:string }
export function installationLocatorPath(options:{platform?:NodeJS.Platform;home?:string;xdgConfigHome?:string;appData?:string}={}):string {
  const platform=options.platform??process.platform;const home=options.home??homedir();
  if(platform==='win32'){const base=options.appData??process.env.APPDATA;if(!base||!win32.isAbsolute(base))throw new Error('APPDATA is required');return win32.join(base,'ai4devops-sf','installation.json')}
  if(!isAbsolute(home))throw new Error('Absolute home directory required');
  const base=platform==='darwin'?join(home,'Library','Application Support'):(options.xdgConfigHome??process.env.XDG_CONFIG_HOME??join(home,'.config'));
  if(!isAbsolute(base))throw new Error('Absolute configuration directory required');return join(base,'ai4devops-sf','installation.json');
}
function validate(value:Installation):Installation {
  if(!value||typeof value!=='object'||Object.keys(value).sort().join(',')!==['schemaVersion','id','root','node','serviceEntry','version'].sort().join(',')||value.schemaVersion!==1||typeof value.id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(value.id)||typeof value.version!=='string'||!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value.version))throw new Error('Invalid installation locator');
  for(const path of [value.root,value.node,value.serviceEntry])if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path)throw new Error('Invalid installation locator path');
  for(const path of [value.node,value.serviceEntry]){const rel=relative(value.root,path);if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw new Error('Runtime path is outside the installation')}
  return value;
}
export async function locateInstallation(path=installationLocatorPath()):Promise<Installation|null> {
  if(process.platform==='win32'&&!existsSync(path))return null;
  try{return validate(JSON.parse(readPrivateFile(path).toString()) as Installation)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error}
}
/** Write only after confirmation; never replace another installation's locator. */
export async function saveInstallation(installation:Installation,path=installationLocatorPath()):Promise<void> {
  validate(installation);
  if(process.platform==='win32'){protectWindowsDirectory(dirname(path));writeWindowsPrivateFile(path,Buffer.from(JSON.stringify(installation)));return}
  if(resolve(path)!==path)throw new Error('Absolute locator path required');
  const directory=dirname(path);mkdirSync(directory,{recursive:true,mode:0o700});
  const stat=lstatSync(directory);if(realpathSync(directory)!==directory||!stat.isDirectory()||stat.uid!==process.getuid!()||(stat.mode&0o077)!==0)throw new Error('Private locator directory required');
  let fd:number;try{fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600)}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('An installation locator already exists');throw error}
  try{writeFileSync(fd,JSON.stringify(installation));fsyncSync(fd)}finally{closeSync(fd)}
  const dir=openSync(directory,constants.O_RDONLY);try{fsyncSync(dir)}finally{closeSync(dir)}
}
