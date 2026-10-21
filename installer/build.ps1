# build.ps1 - Build the buddy2api Windows installer.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\build.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\build.ps1 -Version 1.0.1
#
# Steps: stage payload (app + portable node.exe) -> run ISCC
# -> installer\dist\buddy2api-setup-<version>.exe
#
# The codebuddy CLI is NOT bundled: it is Tencent proprietary software and must
# come from the user's own WorkBuddy installation. The onboarding wizard
# (scripts/onboarding.js) copies it into <app>\vendor\codebuddy-cli on first
# setup; source builds can do the same via `npm run vendor:update`.
#
# Requirements (all vendored in installer\toolchain\, no system setup):
#   - toolchain\innosetup-portable\  (Inno Setup command-line compiler)
#   - toolchain\ChineseSimplified.isl

param(
  [string]$Version = ""
)

$ErrorActionPreference = 'Stop'
$InstallerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $InstallerDir
$Payload = Join-Path $InstallerDir 'payload'
$Toolchain = Join-Path $InstallerDir 'toolchain'
$Iscc = Join-Path $Toolchain 'innosetup-portable\bin\ISCC.exe'

if (-not $Version) {
  $Version = (Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).version
}
if (-not (Test-Path $Iscc)) { throw "ISCC not found: $Iscc" }
$NodeSrc = (Get-Command node -ErrorAction Stop).Source

Write-Host "[1/4] Staging payload -> $Payload"
if (Test-Path $Payload) { Remove-Item $Payload -Recurse -Force }
New-Item -ItemType Directory -Path $Payload | Out-Null

# app code (src is the whole server; scripts is a curated list: everything the
# console and scheduled tasks can invoke, nothing dev-only)
Copy-Item (Join-Path $Root 'src') (Join-Path $Payload 'src') -Recurse
New-Item (Join-Path $Payload 'scripts') -ItemType Directory | Out-Null
$Scripts = @(
  'console.ps1', 'service.js', 'login.js', 'status.js', 'kill.js',
  'models.js', 'accounts.js', 'isolated-login.js', 'account.js', 'checkin.js',
  'onboarding.js', 'vendor-cli.js', 'uninstall.ps1',
  'install-shortcuts.ps1', 'install-autostart-task.ps1', 'install-checkin-task.ps1',
  'autostart-status.ps1', 'checkin-task-status.ps1',
  'autostart.vbs', 'checkin-task.cmd', 'start.vbs', 'stop.vbs'
)
foreach ($s in $Scripts) {
  $src = Join-Path $Root "scripts\$s"
  if (-not (Test-Path $src)) { throw "missing script: $src" }
  Copy-Item $src (Join-Path $Payload "scripts\$s")
}
New-Item (Join-Path $Payload 'assets') -ItemType Directory | Out-Null
Copy-Item (Join-Path $Root 'assets\buddy2api.ico') (Join-Path $Payload 'assets\buddy2api.ico')
Copy-Item (Join-Path $Root 'package.json') $Payload
Copy-Item (Join-Path $Root 'README.md') $Payload

# portable node runtime: target machines need no Node.js installed
New-Item (Join-Path $Payload 'runtime') -ItemType Directory | Out-Null
Copy-Item $NodeSrc (Join-Path $Payload 'runtime\node.exe')
# assert arch + minimum version: src/ needs global fetch / AbortSignal.timeout (Node 18+),
# and an ARM node.exe bundled here would silently break every x64 target machine
$nodeInfo = & (Join-Path $Payload 'runtime\node.exe') -p "process.versions.node + ' ' + process.arch"
$nodeVer, $nodeArch = "$nodeInfo" -split ' '
if ($nodeArch -ne 'x64') { throw "unexpected node arch '$nodeArch' (targets are x64): $NodeSrc" }
if ([version]($nodeVer -replace '^v','') -lt [version]'18.0.0') { throw "node $nodeVer too old (src/ needs Node 18+): $NodeSrc" }
Write-Host "  node runtime: $NodeSrc ($nodeVer x64)"

# sanity: installer scripts must compile with the bundled runtime
& (Join-Path $Payload 'runtime\node.exe') --check (Join-Path $Payload 'scripts\onboarding.js')
if ($LASTEXITCODE -ne 0) { throw 'onboarding.js syntax check failed' }
& (Join-Path $Payload 'runtime\node.exe') --check (Join-Path $Payload 'scripts\vendor-cli.js')
if ($LASTEXITCODE -ne 0) { throw 'vendor-cli.js syntax check failed' }

Write-Host "[2/4] Compiling installer (lzma2 on payload, takes a while)..."
& $Iscc "/DAppVersion=$Version" (Join-Path $InstallerDir 'buddy2api.iss')
if ($LASTEXITCODE -ne 0) { throw "ISCC failed with $LASTEXITCODE" }

$out = Join-Path $InstallerDir "dist\buddy2api-setup-$Version.exe"
if (-not (Test-Path $out)) { throw "expected output missing: $out" }
$mb = [math]::Round((Get-Item $out).Length / 1MB, 1)
Write-Host "[3/4] Built: $out ($mb MB)"

Write-Host "[4/4] Quick smoke test: list installer version info"
$verInfo = (Get-Item $out).VersionInfo
Write-Host "  ProductName=$($verInfo.ProductName) ProductVersion=$($verInfo.ProductVersion)"
