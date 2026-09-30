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

echo.
echo 1^) 浏览器预览（默认，Mock Backend）
echo 2^) 桌面客户端（Tauri + 本机 p4）
set /p mode="请选择 [1/2，直接回车选 1]："

if "%mode%"=="2" goto :desktop
echo 正在启动浏览器预览：http://localhost:1420/
start "" "http://localhost:1420/"
call pnpm dev
goto :end

:desktop
where cargo >nul 2>nul
if errorlevel 1 (
  echo 缺少 Rust/Cargo。请先运行 scripts\setup-windows.ps1。
  goto :failed
)
echo 正在启动 P4Deck 桌面客户端...
call pnpm tauri dev
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
