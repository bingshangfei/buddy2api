# install-shortcuts.ps1 — 创建/重建 buddy2api 快捷方式
#
# 设计：
#   桌面    → 只放 1 个「buddy2api」图标（打开控制台菜单）
#   开始菜单 → 细分动作，通过 console.ps1 -Action xxx 直达（同一脚本，无重复实现）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\install-shortcuts.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-shortcuts.ps1 -Remove

param(
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ScriptsDir  = Join-Path $ProjectRoot 'scripts'
$IconPath    = Join-Path $ProjectRoot 'assets\buddy2api.ico'
$ConsolePs1  = Join-Path $ScriptsDir 'console.ps1'

if (-not (Test-Path $ConsolePs1)) { throw "找不到 $ConsolePs1" }
if (-not (Test-Path $IconPath)) { Write-Warning "图标不存在：$IconPath" }

$Desktop   = [Environment]::GetFolderPath('Desktop')
$StartMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'buddy2api'
$WshShell  = New-Object -ComObject WScript.Shell

$PsExe = 'powershell.exe'
$BaseArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$ConsolePs1`""

# 桌面：单一入口（交互菜单）
$DesktopTargets = @(
  @{ Path = (Join-Path $Desktop 'buddy2api.lnk'); Arg = $BaseArgs; Desc = 'buddy2api 控制台：启动/停止、账号、签到' }
)

# 开始菜单：细分动作直达
$MenuTargets = @(
  @{ Name = 'buddy2api 控制台'; Arg = $BaseArgs;                              Desc = '交互式控制台菜单' },
  @{ Name = '启动服务';         Arg = "$BaseArgs -Action start";              Desc = '启动 buddy2api 服务' },
  @{ Name = '停止服务';         Arg = "$BaseArgs -Action stop";               Desc = '停止 buddy2api 及其托管的后端进程' },
  @{ Name = '账号管理';         Arg = "$BaseArgs -Action accounts";           Desc = '账号管理：查看余额、添加账号（多账号轮转 + 故障转移）' },
  @{ Name = '模型清单（计费）';  Arg = "$BaseArgs -Action models";            Desc = '可配置的模型 id：免费/收费与计费系数，附各 agent 接入配置（URL/Key/模型 id）' },
  @{ Name = '签到';             Arg = "$BaseArgs -Action checkin";            Desc = '查看签到状态并领取每日积分（多账号）' },
  @{ Name = '自动签到设置';     Arg = "$BaseArgs -Action schedule";           Desc = '自动签到设置：启用/关闭每日自动签到、查看日志' },
  @{ Name = '开机启动设置';     Arg = "$BaseArgs -Action autostart";          Desc = '开机启动设置：启用/关闭登录后自动拉起服务（无窗口后台运行）' },
  @{ Name = '登录';             Arg = "$BaseArgs -Action login";              Desc = '检查登录状态；未登录时引导登录' },
  @{ Name = '查看服务日志';     Arg = "$BaseArgs -Action log";                Desc = '查看服务日志（最近 40 行）' }
)

# 旧版本遗留的快捷方式（本次要清理）
$LegacyNames = @(
  'buddy2api 启动.lnk','buddy2api 停止.lnk','buddy2api 登录.lnk',
  'buddy2api 账号.lnk','buddy2api 签到.lnk','buddy2api 自动签到设置.lnk'
)

if ($Remove) {
  foreach ($t in $DesktopTargets) { if (Test-Path $t.Path) { Remove-Item $t.Path -Force; Write-Host "已删除: $($t.Path)" } }
  foreach ($t in $MenuTargets) {
    $p = Join-Path $StartMenu "$($t.Name).lnk"
    if (Test-Path $p) { Remove-Item $p -Force; Write-Host "已删除: $($p)" }
  }
  foreach ($name in $LegacyNames) {
    foreach ($dir in @($Desktop, $StartMenu)) {
      $p = Join-Path $dir $name
      if (Test-Path $p) { Remove-Item $p -Force; Write-Host "已删除: $($p)" }
    }
  }
  if (Test-Path $StartMenu) {
    $remaining = Get-ChildItem $StartMenu -Force -ErrorAction SilentlyContinue
    if (-not $remaining) { Remove-Item $StartMenu -Force }
  }
  Write-Host ''
  Write-Host '卸载完成。'
  return
}

if (-not (Test-Path $StartMenu)) { New-Item -ItemType Directory -Path $StartMenu -Force | Out-Null }

# 清理旧版本遗留（桌面与开始菜单）
foreach ($name in $LegacyNames) {
  foreach ($dir in @($Desktop, $StartMenu)) {
    $p = Join-Path $dir $name
    if (Test-Path $p) { Remove-Item $p -Force; Write-Host "已清理旧快捷方式: $name" }
  }
}

function New-Lnk {
    # 注意：参数名不能叫 $Args —— PowerShell 里 $Args 是自动变量（未绑定参数数组），
    # 会遮蔽同名形参，导致快捷方式的 Arguments 被写空（踩过）。
    param([string]$Path, [string]$ArgLine, [string]$Desc)
    $lnk = $WshShell.CreateShortcut($Path)
    $lnk.TargetPath       = $PsExe
    $lnk.Arguments        = $ArgLine
    $lnk.WorkingDirectory = $ProjectRoot
    $lnk.Description      = $Desc
    $lnk.WindowStyle      = 1
    if (Test-Path $IconPath) { $lnk.IconLocation = "$IconPath,0" }
    $lnk.Save()
    Write-Host "已创建: $Path"
}

foreach ($t in $DesktopTargets) { New-Lnk -Path $t.Path -ArgLine $t.Arg -Desc $t.Desc }
foreach ($t in $MenuTargets)    { New-Lnk -Path (Join-Path $StartMenu "$($t.Name).lnk") -ArgLine $t.Arg -Desc $t.Desc }

Write-Host ''
Write-Host '完成。'
Write-Host '  桌面    ：buddy2api（单一入口，打开控制台菜单）'
Write-Host '  开始菜单：buddy2api 文件夹下有 控制台/启动/停止/账号/模型清单/签到/自动签到/开机启动/登录/日志'
Write-Host "  图标    ：$IconPath"
Write-Host "  项目目录：$ProjectRoot"
