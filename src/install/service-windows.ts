import { spawnSync } from 'node:child_process';
import { win32 } from 'node:path';
import type { LinuxServiceSpec } from './service-linux.ts';

// Windows command-line quoting for CommandLineToArgvW / the Node executable.
function quote(value:string):string {
  if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid task argument');
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}
export function windowsServiceDefinition(spec:LinuxServiceSpec):{taskName:string;executable:string;arguments:string} {
  if (![spec.node,spec.entry,spec.root].every(win32.isAbsolute) || !/^[A-Za-z0-9_-]{1,100}$/.test(spec.id)) throw new Error('Absolute service paths and an installation ID are required');
  if(spec.dockerExecutable&&!win32.isAbsolute(spec.dockerExecutable))throw new Error('Absolute Docker executable required');
  return {taskName:`AI4DevOps-SF-${spec.id}`,executable:spec.node,arguments:[spec.entry,spec.id,spec.root,...(spec.dockerExecutable?[spec.dockerExecutable]:[])].map(quote).join(' ')};
}

// The existing task is compared with the complete definition before any control operation.
// Inputs travel on stdin, never through an interpolated PowerShell command line.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$x = [Console]::In.ReadToEnd() | ConvertFrom-Json
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$t = Get-ScheduledTask -TaskPath '\' -TaskName $x.taskName -ErrorAction SilentlyContinue
if ($x.operation -eq 'install') {
  if ($null -ne $t) { throw 'Existing task requires reconciliation' }
  $action = New-ScheduledTaskAction -Execute $x.executable -Argument $x.arguments
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $sid
  $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskPath '\' -TaskName $x.taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
  exit 0
}
if ($null -eq $t -or $t.Actions.Count -ne 1 -or $t.Triggers.Count -ne 1 -or $t.Actions[0].Execute -cne $x.executable -or $t.Actions[0].Arguments -cne $x.arguments -or $t.Principal.UserId -cne $sid -or $t.Principal.LogonType -ne 'Interactive' -or $t.Principal.RunLevel -ne 'Limited' -or $t.Triggers[0].CimClass.CimClassName -ne 'MSFT_TaskLogonTrigger' -or $t.Triggers[0].UserId -cne $sid) { throw 'Owned task definition is unknown or changed' }
switch ($x.operation) {
  'start' { Start-ScheduledTask -InputObject $t }
  'status' { if ($t.State -eq 'Running') { [Console]::Out.Write('running') } elseif ($t.State -eq 'Ready') { [Console]::Out.Write('stopped') } else { throw 'Task state unknown' } }
  'stop' { Stop-ScheduledTask -InputObject $t }
  'remove' { Unregister-ScheduledTask -InputObject $t -Confirm:$false }
  default { throw 'Unknown operation' }
}`;
export class WindowsStartup {
  private readonly definition:ReturnType<typeof windowsServiceDefinition>;
  constructor(spec:LinuxServiceSpec){this.definition=windowsServiceDefinition(spec)}
  private run(operation:'install'|'start'|'status'|'stop'|'remove'):string {
    if(process.platform!=='win32'||!process.env.SystemRoot||!win32.isAbsolute(process.env.SystemRoot))throw new Error('Windows logged-in user task service unavailable');
    const executable=win32.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
    const result=spawnSync(executable,['-NoProfile','-NonInteractive','-Command',SCRIPT],{input:JSON.stringify({...this.definition,operation}),encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:65536});
    if(result.error||result.status!==0)throw new Error('Windows user task operation could not be verified');
    return result.stdout;
  }
  async install():Promise<void>{this.run('install')}
  async start():Promise<void>{this.run('start')}
  async stop():Promise<void>{this.run('stop')}
  async remove():Promise<void>{this.run('remove')}
  async status():Promise<'running'|'stopped'>{const result=this.run('status');if(result!=='running'&&result!=='stopped')throw new Error('Windows user task status unknown');return result}
}
