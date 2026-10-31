@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo  P4Deck 开发环境快速启动
echo ========================================

where node >nul 2>nul
if errorlevel 1 goto :missing_node
where pnpm >nul 2>nul
if errorlevel 1 goto :missing_node

if not exist "node_modules\.pnpm" (
  echo 项目依赖尚未安装，正在按锁文件安装...
  call pnpm install --frozen-lockfile
  if errorlevel 1 goto :failed
)

if /i "%~1"=="browser" goto :browser
set "p4deck_dev_command=dev:desktop"
if /i "%~1"=="qa" set "p4deck_dev_command=dev:desktop:qa"

:desktop
where cargo >nul 2>nul
if errorlevel 1 (
  echo 缺少 Rust/Cargo。请先运行 scripts\setup-windows.ps1。
  goto :failed
)
call :check_port 1422 "桌面开发前端"
echo 正在启动 P4Deck 桌面开发模式...
echo 前端修改会热更新；Rust 修改会自动重编译并重启。
echo 请保持此窗口运行，按 Ctrl+C 停止。
call pnpm %p4deck_dev_command%
goto :end

:browser
call :check_port 1420 "浏览器开发服务"
echo 正在启动浏览器预览：http://localhost:1420/
start "" "http://localhost:1420/"
call pnpm dev
goto :end

:missing_node
echo 缺少 Node.js 或 pnpm。请先运行 scripts\setup-windows.ps1。

:failed
echo.
echo [启动失败] 窗口保持打开，请把上面的错误信息发给 LEAD。
pause
exit /b 1

:end
echo.
echo 开发进程已退出（错误码 %errorlevel%）。窗口保持打开以便查看日志；关闭窗口即可。
pause
endlocal
exit /b 0

:check_port
netstat -ano | findstr /R /C:":%~1 " >nul 2>nul
if not errorlevel 1 (
  echo [提示] 端口 %~1 已被占用（%~2）。如果这是上次未退出的进程，请先结束，否则启动会失败。
)
exit /b 0
