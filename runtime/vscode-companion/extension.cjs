'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {spawnSync} = require('node:child_process');
const SCOPES = ['read:user','user:email'];

// Validate Windows ACLs in the companion process itself; paths use stdin, never shell interpolation.
const WINDOWS_ACL = String.raw`
$ErrorActionPreference='Stop'; $r=[Console]::In.ReadToEnd() | ConvertFrom-Json
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User; $system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
function checkPath($p) { $x=Get-Item -LiteralPath $p -Force; while($null -ne $x) { if(($x.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'reparse'}; if($x.PSIsContainer){$x=$x.Parent}else{$x=$x.Directory} } }
function checkAcl($p,$dir) { checkPath $p; $x=Get-Item -LiteralPath $p -Force; if($x.PSIsContainer -ne $dir){throw 'type'}; $a=Get-Acl -LiteralPath $p; if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value -or ($dir -and !$a.AreAccessRulesProtected)){throw 'owner'}; $rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); if($rules.Count -ne 2){throw 'rules'}; $seen=@{}; foreach($rule in $rules){$id=$rule.IdentityReference.Value;if(($id -ne $user.Value -and $id -ne $system.Value) -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl){throw 'rights'};$seen[$id]=$true};if(!$seen.ContainsKey($user.Value) -or !$seen.ContainsKey($system.Value)){throw 'missing'}}
$p=[IO.Path]::GetFullPath([string]$r.path);$parent=[IO.Path]::GetDirectoryName($p);checkAcl $parent $true;checkAcl $p $false
if($r.protect){$a=New-Object Security.AccessControl.FileSecurity;$a.SetOwner($user);$a.SetAccessRuleProtection($true,$false);foreach($id in @($user,$system)){$rule=New-Object Security.AccessControl.FileSystemAccessRule($id,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow);$a.AddAccessRule($rule)};Set-Acl -LiteralPath $p -AclObject $a;checkAcl $p $false}
`;
function windowsPrivate(file,protect=false) {
  const root=process.env.SystemRoot;if(!root||!path.win32.isAbsolute(root))throw Error('Windows protection unavailable');
  const result=spawnSync(path.win32.join(root,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',WINDOWS_ACL],{input:JSON.stringify({path:file,protect}),encoding:'utf8',windowsHide:true,timeout:30000,stdio:['pipe','ignore','ignore']});
  if(result.error||result.status!==0)throw Error('Windows private path unavailable');
}

function readRequest(file) {
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== file) throw Error('Protected companion request unavailable');
  if(process.platform==='win32')windowsPrivate(file);
  const dir = fs.lstatSync(path.dirname(file)); const stat = fs.lstatSync(file);
  if (!dir.isDirectory() || !stat.isFile() || stat.isSymbolicLink() || stat.size > 8192 || (process.platform!=='win32' && (dir.uid !== process.getuid() || (dir.mode & 0o077) || stat.uid !== process.getuid() || (stat.mode & 0o077)))) throw Error('Protected companion request unavailable');
  const r = JSON.parse(fs.readFileSync(file,'utf8'));
  const u = new URL(r.url);
  if (r.schemaVersion !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(r.bearer) || !/^[A-Za-z0-9_-]{16,100}$/.test(r.nonce) || !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= Date.now() || r.expiresAt > Date.now()+300000 || u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || u.username || u.password || u.search || u.hash) throw Error('Invalid protected companion request');
  if(r.action==='register') {
    if(u.pathname!=='/registration'||r.expiresAt>Date.now()+60000||!/^127\.0\.0\.1:[1-9]\d{0,4}$/.test(r.address)||Number(r.address.split(':')[1])>65535||!/^[A-Za-z0-9_-]{43}$/.test(r.capability)||!/^[A-Za-z0-9_-]{1,100}$/.test(r.runtimeOwnerId)||typeof r.settingsPath!=='string'||!path.isAbsolute(r.settingsPath))throw Error('Invalid desktop registration');
  } else if(r.action===undefined) {
    if(u.pathname!=='/provider'||r.resource!=='https://api.github.com'||JSON.stringify(r.scopes)!==JSON.stringify(SCOPES)||typeof r.interactive!=='boolean'||(r.account!==undefined&&(!r.account||typeof r.account.id!=='string'||typeof r.account.label!=='string')))throw Error('Invalid provider request');
  } else throw Error('Unsupported companion request');
  return r;
}
async function runAuthentication(vscode, file) {
  const r = readRequest(file);
  if(r.action!==undefined)throw Error('Invalid provider request');
  const options = r.interactive ? {createIfNone:true,...(r.account ? {account:r.account} : {})} : {silent:true,...(r.account ? {account:r.account} : {})};
  const session = await vscode.authentication.getSession('github', SCOPES, options);
  if (!session || typeof session.accessToken !== 'string' || !session.accessToken || session.accessToken.length > 16384 || !session.account || typeof session.account.id !== 'string' || typeof session.account.label !== 'string' || (r.account && session.account.id !== r.account.id) || !Array.isArray(session.scopes) || session.scopes.length !== SCOPES.length || !SCOPES.every(s=>session.scopes.includes(s))) throw Error('Selected Copilot account or scopes unavailable');
  const body = JSON.stringify({nonce:r.nonce,resource:r.resource,scopes:SCOPES,account:{id:session.account.id,label:session.account.label},token:session.accessToken});
  await new Promise((resolve,reject)=>{
    const req=http.request(r.url,{method:'POST',headers:{authorization:'Bearer '+r.bearer,'content-type':'application/json','content-length':Buffer.byteLength(body)},timeout:10000},res=>{res.resume();res.on('end',()=>res.statusCode===200?resolve():reject(Error('Companion authentication not accepted')))});
    req.on('timeout',()=>req.destroy()); req.on('error',()=>reject(Error('Companion authentication unavailable')));req.end(body);
  });
}
async function runRegistration(vscode,file) {
  const r=readRequest(file);if(r.action!=='register')throw Error('Invalid desktop registration');
  const parent=path.dirname(r.settingsPath);const directory=fs.lstatSync(parent);const settings=fs.lstatSync(r.settingsPath);
  if(process.platform==='win32')windowsPrivate(r.settingsPath);
  if(fs.realpathSync(parent)!==parent||!directory.isDirectory()||fs.realpathSync(r.settingsPath)!==r.settingsPath||!settings.isFile()||settings.isSymbolicLink()||(process.platform!=='win32'&&(directory.uid!==process.getuid()||(directory.mode&0o077)||settings.uid!==process.getuid()||(settings.mode&0o077))))throw Error('Private desktop settings unavailable');
  const config=vscode.workspace.getConfiguration();const target=vscode.ConfigurationTarget.Global;
  const ignored=config.inspect('settingsSync.ignoredSettings')?.globalValue;if(ignored!==undefined&&!Array.isArray(ignored))throw Error('Invalid settings sync policy');
  const names=['chat.remoteAgentHosts','chat.workspaceRemoteAgentHosts'];
  const safeIgnored=[...new Set([...(ignored||[]).filter(value=>typeof value==='string'&&!names.some(name=>value==='-'+name)),...names])];
  await config.update('settingsSync.ignoredSettings',safeIgnored,target);
  const checked=config.inspect('settingsSync.ignoredSettings')?.globalValue;if(!Array.isArray(checked)||!names.every(name=>checked.includes(name)))throw Error('Settings sync exclusion unavailable');
  const entries=config.inspect('chat.remoteAgentHosts')?.globalValue;if(entries!==undefined&&!Array.isArray(entries))throw Error('Invalid remote host settings');
  const name='Software Factory '+r.runtimeOwnerId;
  const next=[...(entries||[]).filter(entry=>entry&&typeof entry==='object'&&entry.name!==name),{address:r.address,name,connectionToken:r.capability}];
  await config.update('chat.remoteAgentHostsEnabled',true,target);
  await config.update('chat.remoteAgentHosts',next,target);
  const current=fs.lstatSync(r.settingsPath);if(!current.isFile()||current.isSymbolicLink()||(process.platform!=='win32'&&current.uid!==process.getuid())||fs.realpathSync(r.settingsPath)!==r.settingsPath)throw Error('Private desktop settings changed');
  if(process.platform==='win32')windowsPrivate(r.settingsPath,true);else fs.chmodSync(r.settingsPath,0o600);
  const body=JSON.stringify({nonce:r.nonce,registered:true});
  await new Promise((resolve,reject)=>{const req=http.request(r.url,{method:'POST',headers:{authorization:'Bearer '+r.bearer,'content-type':'application/json','content-length':Buffer.byteLength(body)},timeout:10000},res=>{res.resume();res.on('end',()=>res.statusCode===200?resolve():reject(Error('Desktop registration not accepted')))});req.on('timeout',()=>req.destroy());req.on('error',()=>reject(Error('Desktop registration unavailable')));req.end(body)});
}
let timer;
function activate(context) {
  const vscode=require('vscode'); const file=process.env.SF_COMPANION_REQUEST;
  if (!file) return;
  let last='', busy=false;
  const poll=async()=>{if(busy)return;let request;try{request=readRequest(file)}catch{return}if(request.nonce===last)return;last=request.nonce;busy=true;try{if(request.action==='register')await runRegistration(vscode,file);else await runAuthentication(vscode,file)}catch{void vscode.window.showErrorMessage('Software Factory could not complete the private desktop request.')}finally{busy=false}};
  timer=setInterval(()=>void poll(),1000);void poll();context.subscriptions.push({dispose(){clearInterval(timer)}});
}
function deactivate(){if(timer)clearInterval(timer)}
module.exports={activate,deactivate,runAuthentication,runRegistration,readRequest};
