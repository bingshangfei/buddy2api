# autostart-status.ps1 — 显示开机启动计划任务的状态

$TaskName = 'buddy2api 开机启动'
$LogFile  = Join-Path $env:TEMP 'buddy2api-autostart.log'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($task) {
  $info  = Get-ScheduledTaskInfo -TaskName $TaskName
  $state = switch ($task.State) {
    'Ready'    { '已就绪' }
    'Running'  { '正在运行' }
    'Disabled' { '已禁用' }
    default    { $task.State }
  }
  Write-Host '  [已启用] 开机启动'
  Write-Host "     状态：$state"
  # AtLogOn 触发器通常没有确定的 NextRunTime（取决于下次登录时间），空值不展示
  if ($info.NextRunTime -and $info.NextRunTime.Year -gt 2000) {
    Write-Host "     下次运行：$($info.NextRunTime)"
  }
  if ($info.LastRunTime -and $info.LastRunTime.Year -gt 2000) {
    Write-Host "     上次运行：$($info.LastRunTime)（结果码 $($info.LastTaskResult)）"
  }
  Write-Host "     日志文件：$LogFile"
} else {
  Write-Host '  [未启用] 开机启动（每次开机需手动启动服务）'
  Write-Host '     启用后每次登录会自动在后台拉起服务，无窗口、无弹窗'
}
