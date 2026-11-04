$ErrorActionPreference='Stop'
$root=Join-Path $env:LOCALAPPDATA 'Temp\sf-p5-20261104-7bd29a'
$code=Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code Insiders\Code - Insiders.exe'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$args=@('--new-window','--verbose','--user-data-dir',(Join-Path $root 'profile'),'--extensions-dir',(Join-Path $root 'extensions'),'--extensionDevelopmentPath',(Join-Path $root 'dev-extension'),(Join-Path $root 'repo'))
$p=Start-Process -FilePath $code -ArgumentList $args -PassThru -RedirectStandardOutput (Join-Path $root 'launch-stdout.txt') -RedirectStandardError (Join-Path $root 'launch-stderr.txt')
$exited=$p.WaitForExit(15000)
@{pid=$p.Id;exited=$exited;exitCode=if($exited){$p.ExitCode}else{$null};root=$root}|ConvertTo-Json -Compress
