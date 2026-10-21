# console.ps1 — buddy2api 统一控制台与动作入口
#
# 用法：
#   powershell -File console.ps1                 交互式菜单（桌面快捷方式）
#   powershell -File console.ps1 -Action start   直接执行某个动作后退出
#
#   -Action: start | stop | restart | accounts | checkin | schedule | login | models | log | cli
#
# 为什么统一到一个 PowerShell 脚本（而不是一堆 .cmd）：
#   1. .cmd 按系统 ANSI 码页（GBK）解析文件，UTF-8 中文会读错位，把半行当命令执行；
#   2. node 输出 UTF-8，而 cmd 控制台是 GBK → node 那几行必然乱码。
#   PowerShell 按 UTF-8 BOM 读文件、输出走 .NET 编码转换，只要把
#   [Console]::OutputEncoding 设为 UTF-8，两边就都正确。
#   把动作都收在这里，也避免每个入口各自处理一遍编码。
#
# 存盘要求：UTF-8 with BOM。

param(
  [ValidateSet('menu','start','stop','restart','accounts','checkin','schedule','autostart','login','models','log','status','cli')]
  [string]$Action = 'menu'
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$ErrorActionPreference = 'Continue'
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ProjectRoot
$Scripts = Join-Path $ProjectRoot 'scripts'

# node 解析：安装版自带 runtime\node.exe（新机器无需装 Node.js），其次
# BUDDY2API_NODE 环境变量显式指定，最后回退 PATH 里的 node。
$BundledNode = Join-Path $ProjectRoot 'runtime\node.exe'
$NodeExe = if ($env:BUDDY2API_NODE -and (Test-Path $env:BUDDY2API_NODE)) {
    $env:BUDDY2API_NODE
} elseif (Test-Path $BundledNode) {
    $BundledNode
} else {
    (Get-Command node -ErrorAction SilentlyContinue).Source
}

function Invoke-Node {
    param([string]$Script, [string[]]$NodeArgs = @())
    if (-not $NodeExe) { Write-Host '  找不到 node（也未内置 runtime\node.exe）'; return }
    & $NodeExe (Join-Path $Scripts $Script) @NodeArgs
}

function Pause-Any {
    if ($script:Interactive) {
        Write-Host ''
        Write-Host '  按回车返回菜单…' -NoNewline
        [void](Read-Host)
    }
}

# ---------------------------------------------------------------------------
# 版本号 & 标题栏
# ---------------------------------------------------------------------------

function Get-Version {
    $pkg = Join-Path $ProjectRoot 'package.json'
    if (Test-Path $pkg) {
        $json = Get-Content $pkg -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($json.version) { return $json.version }
    }
    return 'unknown'
}

# 终端显示宽度：CJK/全角字符占 2 列（与 models.js displayWidth 同口径）。
# PowerShell 的 .Length 只数 UTF-16 码元，拿它算 padding 会让含中文的标题行
# 少算 3 列（「控制台」3 字实占 6 列）——右框线必然错位。
function Get-DisplayWidth {
    param([string]$Text)
    $n = 0
    foreach ($ch in $Text.ToCharArray()) {
        $c = [int]$ch
        if (($c -ge 0x1100 -and $c -le 0x115F) -or ($c -ge 0x2E80 -and $c -le 0xA4CF) -or
            ($c -ge 0xAC00 -and $c -le 0xD7A3) -or ($c -ge 0xF900 -and $c -le 0xFAFF) -or
            ($c -ge 0xFE30 -and $c -le 0xFE6F) -or ($c -ge 0xFF00 -and $c -le 0xFF60) -or
            ($c -ge 0xFFE0 -and $c -le 0xFFE6)) { $n += 2 } else { $n += 1 }
    }
    return $n
}

function Show-Header {
    Clear-Host
    $ver = Get-Version
    $label = "buddy2api 控制台   v${ver}"
    $width = 46
    $padLen = [Math]::Max(0, $width - (Get-DisplayWidth $label))
    $line = $label + (' ' * $padLen)

    Write-Host ''
    Write-Host "  ╔$('═' * $width)╗" -ForegroundColor DarkCyan
    Write-Host "  ║$line║" -ForegroundColor Cyan
    Write-Host "  ╚$('═' * $width)╝" -ForegroundColor DarkCyan
    Write-Host ''
    Invoke-Node 'status.js'
    Write-Host ''
    Write-Host "  $('─' * $width)" -ForegroundColor DarkGray
    Write-Host '    [1] 启动服务            [6] 模型清单 / 接入指南' -ForegroundColor White
    Write-Host '    [2] 停止服务            [7] 查看服务日志' -ForegroundColor White
    Write-Host '    [3] 账号管理            [8] 登录 / 检查登录' -ForegroundColor White
    Write-Host '    [4] 签到（领积分）      [9] 开机启动设置' -ForegroundColor White
    Write-Host '    [5] 自动签到设置        [C] CLI 检测与升级' -ForegroundColor White
    Write-Host '    [0] 退出' -ForegroundColor White
    Write-Host ''
}

# ---------------------------------------------------------------------------
# 动作实现
# ---------------------------------------------------------------------------

function Do-Start   { Invoke-Node 'service.js' @('start') }
function Do-Stop    { Invoke-Node 'service.js' @('stop') }
function Do-Restart { Invoke-Node 'service.js' @('restart') }
function Do-Login   { Invoke-Node 'login.js' @('--open') }
function Do-Models  { Invoke-Node 'models.js' }
function Do-Status  { Invoke-Node 'status.js' }

function Do-Log {
    $log = Join-Path $env:TEMP 'buddy2api.log'
    if (Test-Path $log) { Get-Content $log -Encoding UTF8 -Tail 40 } else { Write-Host '  日志还不存在（服务尚未启动过）' }
}

function Do-Accounts {
    Invoke-Node 'accounts.js' @('list')
    if (-not $script:Interactive) { return }

    Write-Host ''
    Write-Host '    [1] 添加账号（隔离登录）'
    Write-Host '    [2] 删除账号'
    Write-Host '    [3] 重新登录（凭据过期/被吊销）'
    Write-Host '    [4] 探活全部账号'
    Write-Host '    [0] 返回'
    Write-Host ''
    switch (Read-Host '  请选择') {
        '1' { Write-Host ''; Invoke-Node 'accounts.js' @('add') }
        '2' {
            Write-Host ''
            $uid = Read-Host '  输入要删除的 uid'
            if ($uid) { Invoke-Node 'accounts.js' @('remove', $uid) } else { Write-Host '  已取消' }
        }
        '3' {
            Write-Host ''
            $uid = Read-Host '  输入要重新登录的 uid'
            if ($uid) { Invoke-Node 'accounts.js' @('relogin', $uid) } else { Write-Host '  已取消' }
        }
        '4' { Write-Host ''; Invoke-Node 'accounts.js' @('check') }
    }
}

# 账号池目录（与 src/account-store.js accountsDir() 同口径，含环境变量覆盖）
function Get-AccountsDir {
    if ($env:BUDDY2API_ACCOUNTS_DIR) { return $env:BUDDY2API_ACCOUNTS_DIR }
    return (Join-Path $ProjectRoot 'data\accounts')
}

# 池是否为空：直接看目录里的 .json，不拉起 node（省 ~440ms）。
# 只判「一个都没有」这一确定态；目录里有文件但全部损坏的情形交给 checkin.js
# 自己的报错处理（宁可多跑一次，也不在这里复述存储层的过滤规则）。
function Test-AccountPoolEmpty {
    $dir = Get-AccountsDir
    if (-not (Test-Path $dir)) { return $true }
    $files = @(Get-ChildItem -LiteralPath $dir -Filter '*.json' -File -ErrorAction SilentlyContinue)
    return ($files.Count -eq 0)
}

function Do-Checkin {
    if (Test-AccountPoolEmpty) {
        Write-Host ''
        Write-Host '  账号池为空，无法签到。请先添加账号：' -ForegroundColor Yellow
        Write-Host '    1. 控制台 [3] 账号管理 → [1] 添加账号' -ForegroundColor Yellow
        Write-Host '    2. 或命令行：node scripts/accounts.js add' -ForegroundColor Yellow
        return
    }
    Invoke-Node 'checkin.js'
}

function Do-Schedule {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Scripts 'checkin-task-status.ps1')

    if (-not $script:Interactive) { return }

    Write-Host ''
    Write-Host '    [1] 查看签到状态'
    Write-Host '    [2] 启用每日自动签到（每天 09:30）'
    Write-Host '    [3] 关闭自动签到'
    Write-Host '    [4] 查看签到日志'
    Write-Host '    [0] 返回'
    Write-Host ''
    switch (Read-Host '  请选择') {
        '1' { Write-Host ''; Invoke-Node 'checkin.js' @('--status') }
        '2' { Write-Host ''; & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Scripts 'install-checkin-task.ps1') }
        '3' { Write-Host ''; & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Scripts 'install-checkin-task.ps1') -Remove }
        '4' {
            Write-Host ''
            $log = Join-Path $env:TEMP 'buddy2api-checkin.log'
            if (Test-Path $log) { Get-Content $log -Encoding UTF8 -Tail 40 } else { Write-Host '  日志还不存在（自动签到尚未运行过）' }
        }
    }
}

function Do-Autostart {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Scripts 'autostart-status.ps1')

    if (-not $script:Interactive) { return }

    Write-Host ''
    Write-Host '    [1] 启用开机启动（登录后静默自启）'
    Write-Host '    [2] 关闭开机启动'
    Write-Host '    [3] 立即测试一次'
    Write-Host '    [4] 查看启动日志'
    Write-Host '    [0] 返回'
    Write-Host ''
    switch (Read-Host '  请选择') {
        '1' { Write-Host ''; & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Scripts 'install-autostart-task.ps1') }
        '2' { Write-Host ''; & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Scripts 'install-autostart-task.ps1') -Remove }
        '3' {
            Write-Host ''
            if (Get-ScheduledTask -TaskName 'buddy2api 开机启动' -ErrorAction SilentlyContinue) {
                Start-ScheduledTask -TaskName 'buddy2api 开机启动'
                Write-Host '  已触发，稍等几秒后返回主菜单用 [7] 查看服务日志确认是否起来'
            } else {
                Write-Host '  尚未启用开机启动，请先选 [1]'
            }
        }
        '4' {
            Write-Host ''
            $log = Join-Path $env:TEMP 'buddy2api-autostart.log'
            if (Test-Path $log) { Get-Content $log -Encoding UTF8 -Tail 40 } else { Write-Host '  日志还不存在（开机启动尚未运行过）' }
        }
    }
}

# 升级/修复共用的拷贝动作：停服 → staging 换位拷贝（vendor-cli 自带完整性自检）→ 询问重启
function Update-CliCopy {
    Write-Host ''
    Write-Host '  升级需要先停止服务...'
    Do-Stop
    Invoke-Node 'vendor-cli.js'
    if ($LASTEXITCODE -ne 0) {
        Write-Host '  拷贝未完成（staging 方案下旧副本未受影响），可用 [1] 重新启动服务。'
        return
    }
    if ($script:Interactive) {
        $ans = Read-Host '  立即重新启动服务吗？(Y/n)'
        if ($ans -notmatch '^[Nn]') { Do-Start }
    } else {
        Write-Host '  拷贝完成。用控制台 [1] 启动服务（或 -Action start）即可生效。'
    }
}

# [C] CLI 检测与升级：对比安装目录与 WorkBuddy 的 CLI 版本，低则确认后覆盖拷贝。
# 检测逻辑单点在 vendor-cli.js --check（退出码 0=最新 1=可升级 2=缺失/损坏 3=未检测到
# WorkBuddy）；本函数只做编排与确认。$LASTEXITCODE 必须紧跟调用取值（PS 函数会把
# stdout 行沿管道上抛，赋值拿到的是输出不是退出码）。
function Do-Cli {
    if (-not $NodeExe) {
        Write-Host '  找不到 node（也未内置 runtime\node.exe），无法检测'
        $global:LASTEXITCODE = 1
        return
    }
    Invoke-Node 'vendor-cli.js' @('--check')
    $code = $LASTEXITCODE
    if (-not $script:Interactive) { return }
    switch ($code) {
        1 {
            Write-Host ''
            $ans = Read-Host '  检测到新版本，确认拷贝升级吗？(y/N)'
            if ($ans -match '^[Yy]') { Update-CliCopy }
        }
        2 {
            Write-Host ''
            $ans = Read-Host '  确认重新拷贝修复/安装吗？(y/N)'
            if ($ans -match '^[Yy]') { Update-CliCopy }
        }
        3 { Write-Host '  请先安装腾讯 WorkBuddy 桌面端（CLI 随它安装），装好后重新检测。' }
        default { }
    }
}

# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

if ($Action -ne 'menu') {
    $script:Interactive = $false
    switch ($Action) {
        'start'    { Do-Start }
        'stop'     { Do-Stop }
        'restart'  { Do-Restart }
        'accounts' { Do-Accounts }
        'checkin'  { Do-Checkin }
        'schedule' { Do-Schedule }
        'autostart' { Do-Autostart }
        'login'    { Do-Login }
        'models'   { Do-Models }
        'log'      { Do-Log }
        'status'   { Do-Status }
        'cli'      { Do-Cli; exit $LASTEXITCODE }
    }
    return
}

$script:Interactive = $true

while ($true) {
    Show-Header
    switch (Read-Host '  请选择') {
        '1' { Write-Host ''; Do-Start; Pause-Any }
        '2' { Write-Host ''; Do-Stop; Pause-Any }
        '3' { Write-Host ''; Do-Accounts; Pause-Any }
        '4' { Write-Host ''; Do-Checkin; Pause-Any }
        '5' { Write-Host ''; Do-Schedule; Pause-Any }
        '6' { Write-Host ''; Do-Models; Pause-Any }
        '7' { Write-Host ''; Do-Log; Pause-Any }
        '8' { Write-Host ''; Do-Login; Pause-Any }
        '9' { Write-Host ''; Do-Autostart; Pause-Any }
        'c' { Write-Host ''; Do-Cli; Pause-Any }
        '0' { return }
        default { }
    }
}
