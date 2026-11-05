import { spawn, spawnSync } from 'node:child_process';
import { win32 } from 'node:path';

type Operation = 'protect-directory'|'check-directory'|'protect-file'|'check-file'|'write-secret'|'replace-secret'|'read-secret'|'write-private'|'replace-private'|'read-private'|'check-owned-file';
// Constant script only. Paths and data enter via stdin; errors and stdout are never logged.
const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$r = [Console]::In.ReadToEnd() | ConvertFrom-Json
$path = [IO.Path]::GetFullPath([string]$r.path)
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
function CheckNoReparse([string]$p) {
  $item = Get-Item -LiteralPath $p -Force
  while ($null -ne $item) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unsafe path' }
    if ($item.PSIsContainer) { $item = $item.Parent } else { $item = $item.Directory }
  }
}
function ApplyPrivate([string]$p, [bool]$directory) {
  CheckNoReparse $p
  if ($directory) { $acl = New-Object Security.AccessControl.DirectorySecurity } else { $acl = New-Object Security.AccessControl.FileSecurity }
  $acl.SetOwner($user)
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [Security.AccessControl.InheritanceFlags]::None
  if ($directory) { $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit }
  foreach ($sid in @($user, $system)) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $p -AclObject $acl
}
function AssertPrivate([string]$p, [bool]$directory) {
  CheckNoReparse $p
  $item = Get-Item -LiteralPath $p -Force
  if ($directory -ne $item.PSIsContainer) { throw 'Wrong object type' }
  $acl = Get-Acl -LiteralPath $p
  if (!$acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'Unsafe owner or inheritance' }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 2) { throw 'Unexpected ACL' }
  $seen = @{}
  foreach ($rule in $rules) {
    $id = $rule.IdentityReference.Value
    if ($rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or ($id -ne $user.Value -and $id -ne $system.Value) -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'Unexpected ACL' }
    $seen[$id] = $true
  }
  if (!$seen.ContainsKey($user.Value) -or !$seen.ContainsKey($system.Value)) { throw 'Incomplete ACL' }
}
if ($r.operation -eq 'protect-directory') {
  $parent = [IO.Path]::GetDirectoryName($path); CheckNoReparse $parent
  if (Test-Path -LiteralPath $path) {
    CheckNoReparse $path; $old=Get-Acl -LiteralPath $path
    if ($old.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'Foreign owner' }
    try { AssertPrivate $path $true; return } catch {
      if (@(Get-ChildItem -LiteralPath $path -Force | Select-Object -First 1).Count -ne 0) { throw 'Existing directory is not private' }
    }
  } else { [void][IO.Directory]::CreateDirectory($path) }
  ApplyPrivate $path $true; AssertPrivate $path $true
} elseif ($r.operation -eq 'check-directory') {
  AssertPrivate $path $true
} elseif ($r.operation -eq 'protect-file') {
  $parent = [IO.Path]::GetDirectoryName($path); AssertPrivate $parent $true; CheckNoReparse $path
  $old=Get-Acl -LiteralPath $path; if ($old.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'Foreign owner' }
  ApplyPrivate $path $false; AssertPrivate $path $false
} elseif ($r.operation -eq 'check-owned-file') {
  CheckNoReparse $path; $item=Get-Item -LiteralPath $path -Force; if ($item.PSIsContainer) { throw 'Wrong object type' }
  $acl=Get-Acl -LiteralPath $path; if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'Unsafe owner' }
  $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); if ($rules.Count -ne 2) { throw 'Unexpected ACL' }; $seen=@{}
  foreach ($rule in $rules) { $id=$rule.IdentityReference.Value; if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or ($id -ne $user.Value -and $id -ne $system.Value) -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'Unexpected ACL' }; $seen[$id]=$true }; if (!$seen.ContainsKey($user.Value) -or !$seen.ContainsKey($system.Value)) { throw 'Incomplete ACL' }
} elseif ($r.operation -eq 'check-file') {
  $parent = [IO.Path]::GetDirectoryName($path); AssertPrivate $parent $true; AssertPrivate $path $false
} elseif ($r.operation -eq 'write-secret' -or $r.operation -eq 'write-private' -or $r.operation -eq 'replace-secret' -or $r.operation -eq 'replace-private') {
  $parent = [IO.Path]::GetDirectoryName($path); AssertPrivate $parent $true
  $replace = $r.operation -eq 'replace-secret' -or $r.operation -eq 'replace-private'
  if ($replace) { AssertPrivate $path $false } elseif (Test-Path -LiteralPath $path) { throw 'Destination exists' }
  $bytes = [Convert]::FromBase64String([string]$r.data)
  if ($bytes.Length -gt 4194304) { throw 'Input too large' }
  try {
    if ($r.operation -eq 'write-secret' -or $r.operation -eq 'replace-secret') { $output = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser) } else { $output = $bytes }
    $destination = $path
    if ($replace) { $destination = [IO.Path]::Combine($parent, '.sf-private-' + [Guid]::NewGuid().ToString('N') + '.tmp') }
    try {
      $stream = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try { $stream.Write($output,0,$output.Length); $stream.Flush($true) } finally { $stream.Dispose() }
      ApplyPrivate $destination $false; AssertPrivate $destination $false
      if ($replace) { AssertPrivate $path $false; [IO.File]::Replace($destination,$path,$null,$true); AssertPrivate $path $false }
    } finally { if ($replace -and (Test-Path -LiteralPath $destination)) { [IO.File]::Delete($destination) } }
  } finally { [Array]::Clear($bytes,0,$bytes.Length); if ($null -ne $output -and ![Object]::ReferenceEquals($output, $bytes)) { [Array]::Clear($output,0,$output.Length) } }
} elseif ($r.operation -eq 'read-secret' -or $r.operation -eq 'read-private') {
  $parent = [IO.Path]::GetDirectoryName($path); AssertPrivate $parent $true; AssertPrivate $path $false
  $bytes = [IO.File]::ReadAllBytes($path); if ($bytes.Length -gt 4194560) { throw 'Input too large' }
  try {
    if ($r.operation -eq 'read-secret') { $output = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser) } else { $output = $bytes }
    if ($output.Length -gt 4194304) { throw 'Output too large' }
    [Console]::Out.Write([Convert]::ToBase64String($output))
  } finally { [Array]::Clear($bytes,0,$bytes.Length); if ($null -ne $output -and ![Object]::ReferenceEquals($output, $bytes)) { [Array]::Clear($output,0,$output.Length) } }
} else { throw 'Unsupported operation' }
`;
/** This descriptor contains no secret in command arguments; the caller supplies its stdin privately. */
export function windowsPrivateInvocation(operation:Operation,path:string,data?:Buffer):{args:string[];input:string} {
  if(!win32.isAbsolute(path)||/[\x00-\x1f\x7f]/.test(path)||path.length>32760||data&&data.length>4194304)throw new Error('Invalid Windows private path or data');
  if((['write-secret','replace-secret','write-private','replace-private'].includes(operation))!==Boolean(data))throw new Error('Invalid Windows private operation');
  return {args:['-NoProfile','-NonInteractive','-Command',script],input:JSON.stringify({operation,path,...(data?{data:data.toString('base64')}:{})})};
}
function execute(operation:Operation,path:string,data?:Buffer):Buffer {
  if(process.platform!=='win32')throw new Error('Windows private storage requires Windows');
  const invocation=windowsPrivateInvocation(operation,path,data);
  const systemRoot=process.env.SystemRoot;if(!systemRoot||!win32.isAbsolute(systemRoot))throw new Error('Windows system directory unavailable');
  const powershell=win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const result=spawnSync(powershell,invocation.args,{input:invocation.input,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:8*1024*1024,stdio:['pipe','pipe','ignore']});
  if(result.error||result.status!==0)throw new Error('Windows protected storage operation failed; inspect the selected account and private ACL');
  if(operation==='read-secret'||operation==='read-private') {
    const encoded=result.stdout.trim();if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw new Error('Windows protected storage returned invalid data');
    const value=Buffer.from(encoded,'base64');if(value.length>4194304||value.toString('base64')!==encoded)throw new Error('Windows protected storage returned invalid data');return value;
  }
  return Buffer.alloc(0);
}
export function protectWindowsDirectory(path:string):void{execute('protect-directory',path)}
export function assertWindowsPrivateDirectory(path:string):void{execute('check-directory',path)}
export function protectWindowsFile(path:string):void{execute('protect-file',path)}
export function assertWindowsPrivateFile(path:string):void{execute('check-file',path)}
export function writeWindowsSecret(path:string,data:Buffer):void{execute('write-secret',path,data)}
export function replaceWindowsSecret(path:string,data:Buffer):void{execute('replace-secret',path,data)}
export function readWindowsSecret(path:string):Buffer{return execute('read-secret',path)}
export function writeWindowsPrivateFile(path:string,data:Buffer):void{execute('write-private',path,data)}
export function replaceWindowsPrivateFile(path:string,data:Buffer):void{execute('replace-private',path,data)}
export function readWindowsPrivateFile(path:string):Buffer{return execute('read-private',path)}

export function assertWindowsOwnedFile(path:string):void{execute('check-owned-file',path)}

/** Await the protected helper without blocking budget observers or other native owners. */
export function runProtectedProcess(executable:string,args:string[],input:string,timeoutMs=30000):Promise<string> {
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{windowsHide:true,stdio:['pipe','pipe','ignore']});let output='';let failure:Error|undefined;
    // Wait for process close even after timeout: a failed mutation must not continue in the background.
    const fail=(error:Error)=>{if(failure)return;failure=error;child.kill()};
    const timer=setTimeout(()=>fail(new Error('Windows protected storage operation timed out')),timeoutMs);
    child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk:string)=>{output+=chunk;if(output.length>8*1024*1024)fail(new Error('Windows protected storage response too large'))});
    child.once('error',()=>fail(new Error('Windows protected storage operation failed')));child.stdin.once('error',()=>fail(new Error('Windows protected storage operation failed')));
    child.once('close',code=>{clearTimeout(timer);if(failure)reject(failure);else if(code!==0)reject(new Error('Windows protected storage operation failed'));else resolve(output)});child.stdin.end(input);
  });
}
async function executeAsync(operation:Operation,path:string,data?:Buffer):Promise<Buffer> {
  if(process.platform!=='win32')throw new Error('Windows private storage requires Windows');
  const invocation=windowsPrivateInvocation(operation,path,data);const root=process.env.SystemRoot;
  if(!root||!win32.isAbsolute(root))throw new Error('Windows system directory unavailable');
  const encoded=(await runProtectedProcess(win32.join(root,'System32','WindowsPowerShell','v1.0','powershell.exe'),invocation.args,invocation.input)).trim();
  if(operation==='read-secret'||operation==='read-private'){
    if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw new Error('Windows protected storage returned invalid data');
    const value=Buffer.from(encoded,'base64');if(value.length>4194304||value.toString('base64')!==encoded)throw new Error('Windows protected storage returned invalid data');return value;
  }
  return Buffer.alloc(0);
}
export async function protectWindowsDirectoryAsync(path:string):Promise<void>{await executeAsync('protect-directory',path)}
export async function assertWindowsPrivateDirectoryAsync(path:string):Promise<void>{await executeAsync('check-directory',path)}
export async function assertWindowsPrivateFileAsync(path:string):Promise<void>{await executeAsync('check-file',path)}
export async function writeWindowsSecretAsync(path:string,data:Buffer):Promise<void>{await executeAsync('write-secret',path,data)}
export async function replaceWindowsSecretAsync(path:string,data:Buffer):Promise<void>{await executeAsync('replace-secret',path,data)}
export async function readWindowsSecretAsync(path:string):Promise<Buffer>{return executeAsync('read-secret',path)}
export async function writeWindowsPrivateFileAsync(path:string,data:Buffer):Promise<void>{await executeAsync('write-private',path,data)}
export async function replaceWindowsPrivateFileAsync(path:string,data:Buffer):Promise<void>{await executeAsync('replace-private',path,data)}
export async function readWindowsPrivateFileAsync(path:string):Promise<Buffer>{return executeAsync('read-private',path)}
export async function assertWindowsOwnedFileAsync(path:string):Promise<void>{await executeAsync('check-owned-file',path)}

export async function protectWindowsFileAsync(path:string):Promise<void>{await executeAsync('protect-file',path)}
