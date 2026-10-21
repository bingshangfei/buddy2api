# install-autostart-task.ps1 — 注册/移除 Windows 计划任务：登录后自动拉起 buddy2api 服务
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart-task.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart-task.ps1 -Remove
#
# 为什么是「计划任务」而不是往「启动」文件夹塞快捷方式：
#   启动文件夹里的项目会在登录瞬间弹一个控制台窗口；计划任务配合 wscript
#   执行 .vbs 可以做到全程无窗口（wscript 本身没有控制台）。
#   而且计划任务能查状态、能一键开关，启动文件夹只能靠删文件。
#
# 为什么触发器是 AtLogOn（登录后）而不是 AtStartup（开机时）：
#   服务要读用户目录下的 data/accounts 凭据，开机时尚未装载用户配置；
#   且这个服务本来就只在用户使用它时才需要。
#
# 日志：%TEMP%\buddy2api-autostart.log（追加写入，含每次执行的结果）

param(
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$TaskName     = 'buddy2api 开机启动'
$ProjectRoot  = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$AutostartVbs = Join-Path $ProjectRoot 'scripts\autostart.vbs'
$LogFile      = Join-Path $env:TEMP 'buddy2api-autostart.log'

if ($Remove) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "已移除计划任务：$TaskName"
    Write-Host '  （服务本身仍在运行，需停止请用 npm run stop 或控制台 [2]）'
  } else {
    Write-Host "未找到计划任务：$TaskName（本来就没启用）"
  }
  return
}

if (-not (Test-Path $AutostartVbs)) { throw "找不到 $AutostartVbs" }

# node 解析：安装版自带 runtime\node.exe（新机器无需装 Node.js），其次 PATH。
# 这里只是可拉性检查——任务 Action 走 wscript + autostart.vbs，vbs 内部
# 会按同样规则解析 node。
$BundledNode = Join-Path $ProjectRoot 'runtime\node.exe'
$NodeExe = if ($env:BUDDY2API_NODE -and (Test-Path $env:BUDDY2API_NODE)) {
  $env:BUDDY2API_NODE
} elseif (Test-Path $BundledNode) {
  $BundledNode
} else {
  (Get-Command node -ErrorAction SilentlyContinue).Source
}
if (-not $NodeExe) { throw '找不到 node，且未内置 runtime\node.exe' }

# 动作：wscript.exe + 完整路径的 vbs。
# 用 wscript 而不是 cscript —— cscript 会弹一个黑框控制台，wscript 不会。
# 不需要 cmd 包装脚本：本任务没有输出重定向，引号只有一处（vbs 路径），
# 不像自动签到那样踩到「引号 + 重定向」的解析问题。
$Action = New-ScheduledTaskAction `
  -Execute 'wscript.exe' `
  -Argument "`"$AutostartVbs`"" `
  -WorkingDirectory $ProjectRoot

$Trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

# -StartWhenAvailable：登录时若因故错过，之后尽快补跑
$Settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

# 以当前用户身份运行（需要访问该用户目录下的凭据 data/accounts）
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Principal $Principal `
  -Description 'buddy2api 开机启动：登录后静默拉起服务（已在运行则跳过，全程无窗口）' `
  -Force | Out-Null

Write-Host "[完成] 已注册计划任务：$TaskName"
Write-Host '   触发时机：每次登录（已登录时不会重复启动）'
Write-Host "   执行命令：wscript.exe `"$AutostartVbs`""
Write-Host "   日志文件：$LogFile"
Write-Host ''
Write-Host '查看任务：  Get-ScheduledTask -TaskName ''buddy2api 开机启动'''
Write-Host '立即测试：  Start-ScheduledTask -TaskName ''buddy2api 开机启动'''
Write-Host '移除任务：  powershell -File scripts\install-autostart-task.ps1 -Remove（或控制台 [9]）'
