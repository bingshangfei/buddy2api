# uninstall.ps1 - Uninstall cleanup for buddy2api.
# Called by the installer's uninstaller ([UninstallRun]) BEFORE files are
# removed; can also be run manually. Keeps user data (data/, ~/.codebuddy).
#
# Steps:
#   1. Stop the API service (port 8000)
#   2. Kill leftover codebuddy backend children (spawned detached, they
#      survive the listener being killed)
#   3. Remove scheduled tasks (autostart / daily checkin)
#   4. Remove desktop + start-menu shortcuts
#
# Output is ASCII on purpose: this file is written BOM-less, and PowerShell
# 5.1 decodes BOM-less files with the system ANSI codepage (GBK on zh-CN).

$ErrorActionPreference = 'Continue'
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Scripts = Join-Path $ProjectRoot 'scripts'

# Node resolution: bundled runtime first, then PATH (same rule as console.ps1)
$BundledNode = Join-Path $ProjectRoot 'runtime\node.exe'
$NodeExe = $null
if (Test-Path $BundledNode) { $NodeExe = $BundledNode }
else { $NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source }

Write-Host '[1/4] Stopping buddy2api service...'
if ($NodeExe) {
  & $NodeExe (Join-Path $Scripts 'service.js') stop 2>$null
} else {
  Write-Host '  node not found, skipping graceful stop'
}

Write-Host '[2/4] Cleaning up leftover codebuddy backend processes...'
try {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'codebuddy-cli' } |
    ForEach-Object {
      Write-Host ("  stopping backend PID {0}" -f $_.ProcessId)
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
} catch { }

Write-Host '[3/4] Removing scheduled tasks...'
$RemoveScripts = @('install-autostart-task.ps1', 'install-checkin-task.ps1')
foreach ($s in $RemoveScripts) {
  $p = Join-Path $Scripts $s
  if (Test-Path $p) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p -Remove 2>$null
  }
}

Write-Host '[4/4] Removing shortcuts...'
$Shortcuts = Join-Path $Scripts 'install-shortcuts.ps1'
if (Test-Path $Shortcuts) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Shortcuts -Remove 2>$null
}

Write-Host ''
Write-Host 'Cleanup done. User data kept:'
Write-Host "  $ProjectRoot\data  (account records, usage stats)"
Write-Host '  ~/.codebuddy       (login credentials)'
