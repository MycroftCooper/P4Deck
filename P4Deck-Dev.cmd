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
echo 正在启动 P4Deck 桌面开发模式...
echo 前端修改会热更新；Rust 修改会自动重编译并重启。
echo 请保持此窗口运行，按 Ctrl+C 停止。
call pnpm %p4deck_dev_command%
goto :end

:browser
echo 正在启动浏览器预览：http://localhost:1420/
start "" "http://localhost:1420/"
call pnpm dev
goto :end

:missing_node
echo 缺少 Node.js 或 pnpm。请先运行 scripts\setup-windows.ps1。

:failed
echo.
pause
exit /b 1

:end
if errorlevel 1 pause
endlocal
