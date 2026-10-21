# install-checkin-task.ps1 — 注册/移除 Windows 计划任务：每天自动签到领积分
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\install-checkin-task.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-checkin-task.ps1 -Time 09:30
#   powershell -ExecutionPolicy Bypass -File scripts\install-checkin-task.ps1 -Remove
#
# 为什么要用计划任务而不是服务内置定时器：
#   buddy2api 服务不一定 24 小时运行（多数是用时才启动），内置定时器会漏签。
#   计划任务独立于服务，只要机器开着（且用户已登录）就会执行。
#
# 日志：%TEMP%\buddy2api-checkin.log（追加写入，含每次执行的结果）

param(
  [string]$Time = '09:30',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$TaskName = 'buddy2api 每日签到'
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$CheckinScript = Join-Path $ProjectRoot 'scripts\checkin.js'
$CheckinWrapper = Join-Path $ProjectRoot 'scripts\checkin-task.cmd'
$LogFile = Join-Path $env:TEMP 'buddy2api-checkin.log'

if ($Remove) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "已移除计划任务：$TaskName"
  } else {
    Write-Host "未找到计划任务：$TaskName"
  }
  return
}

if (-not (Test-Path $CheckinScript)) { throw "找不到 $CheckinScript" }
if (-not (Test-Path $CheckinWrapper)) { throw "找不到 $CheckinWrapper" }

# node 解析：安装版自带 runtime\node.exe（新机器无需装 Node.js），其次 PATH。
$BundledNode = Join-Path $ProjectRoot 'runtime\node.exe'
$NodeExe = if ($env:BUDDY2API_NODE -and (Test-Path $env:BUDDY2API_NODE)) {
  $env:BUDDY2API_NODE
} elseif (Test-Path $BundledNode) {
  $BundledNode
} else {
  (Get-Command node -ErrorAction SilentlyContinue).Source
}
if (-not $NodeExe) { throw '找不到 node，且未内置 runtime\node.exe' }

# 先跑一次，确认签到逻辑本身可用
Write-Host '先手动执行一次签到，确认可用…'
& $NodeExe $CheckinScript
Write-Host ''

# 用 cmd 包装脚本收口（计划任务的 Action 里做引号+重定向实测不可靠，
# 会因引号解析问题静默失败并返回退出码 1）
$Action = New-ScheduledTaskAction -Execute $CheckinWrapper -WorkingDirectory $ProjectRoot

$Trigger = New-ScheduledTaskTrigger -Daily -At $Time

# 默认设置：错过时间后尽快补跑（机器关机/睡眠导致错过时，开机后会补）
$Settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

# 以当前用户身份运行（需要访问该用户目录下的凭据 data/accounts）
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Principal $Principal `
  -Description 'buddy2api 每日签到：为账号池里的所有账号领取每日积分（已签到自动跳过）' `
  -Force | Out-Null

Write-Host "[完成] 已注册计划任务：$TaskName"
Write-Host "   执行时间：每天 $Time（错过会在开机后补跑）"
Write-Host "   执行命令：$NodeExe scripts\checkin.js"
Write-Host "   日志文件：$LogFile"
Write-Host ''
Write-Host '查看任务：  Get-ScheduledTask -TaskName ''buddy2api 每日签到'''
Write-Host '立即测试：  Start-ScheduledTask -TaskName ''buddy2api 每日签到'''
Write-Host '移除任务：  powershell -File scripts\install-checkin-task.ps1 -Remove（或控制台 [5]）'
