@echo off
rem checkin-task.cmd — 计划任务用的签到包装脚本（避免在任务 Action 里做引号与重定向）
rem 也可手动双击运行，用于验证签到是否正常。

setlocal
cd /d "%~dp0.."

rem node 解析：安装版自带 runtime\node.exe（新机器无需装 Node.js），否则回退 PATH
set "NODE=node"
if exist "runtime\node.exe" set "NODE=%CD%\runtime\node.exe"

set "LOG=%TEMP%\buddy2api-checkin.log"

echo. >> "%LOG%"
echo ============================================ >> "%LOG%"
"%NODE%" scripts\checkin.js >> "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
    echo [%DATE% %TIME%] 签到脚本返回 %RC% >> "%LOG%"
)

endlocal & exit /b %RC%
