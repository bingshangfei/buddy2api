# checkin-task-status.ps1 — 显示自动签到计划任务的状态
#
# 被 scripts/checkin-schedule.cmd 调用；也可单独运行。
# 单独写文件而不是在 cmd 里内联 PowerShell：cmd 的 ^ 续行在嵌入多行
# PowerShell 时不可靠（实测报 '^' 不是可识别的命令）。

$TaskName = 'buddy2api 每日签到'
$LogFile = Join-Path $env:TEMP 'buddy2api-checkin.log'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($task) {
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  $state = switch ($task.State) {
    'Ready'    { '已就绪' }
    'Running'  { '正在运行' }
    'Disabled' { '已禁用' }
    default    { $task.State }
  }
  Write-Host '  [已启用] 自动签到'
  Write-Host "     状态：$state"
  try { Write-Host "     下次运行：$($info.NextRunTime)" } catch { }
  if ($info.LastRunTime -and $info.LastRunTime.Year -gt 2000) {
    Write-Host "     上次运行：$($info.LastRunTime)（结果码 $($info.LastTaskResult)）"
  }
  Write-Host "     日志文件：$LogFile"
} else {
  Write-Host '  [未启用] 自动签到（当前只能手动运行）'
  Write-Host '     启用后每天 09:30 自动为所有账号领取积分'
}
