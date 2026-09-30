#!/usr/bin/env bash
set -u

project_dir="$(cd "$(dirname "$0")" && pwd)"
cd "$project_dir" || exit 1

# Finder 启动的终端可能没有加载用户的开发工具 PATH。
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

echo "========================================"
echo " P4Deck 开发环境快速启动"
echo "========================================"

if ! command -v node >/dev/null 2>&1 || ! command -v pnpm >/dev/null 2>&1; then
  echo "缺少 Node.js 或 pnpm。请先运行 scripts/setup-macos.sh。"
  read -r -p "按回车关闭..." _
  exit 1
fi

if [[ ! -d node_modules/.pnpm ]]; then
  echo "项目依赖尚未安装，正在按锁文件安装..."
  pnpm install --frozen-lockfile || { read -r -p "安装失败，按回车关闭..." _; exit 1; }
fi

echo
echo "1) 浏览器预览（默认，Mock Backend）"
echo "2) 桌面客户端（Tauri + 本机 p4）"
read -r -p "请选择 [1/2，直接回车选 1]：" mode

if [[ "${mode:-1}" == "2" ]]; then
  if ! command -v cargo >/dev/null 2>&1; then
    echo "缺少 Rust/Cargo。请先运行 scripts/setup-macos.sh。"
    read -r -p "按回车关闭..." _
    exit 1
  fi
  echo "正在启动 P4Deck 桌面客户端..."
  exec pnpm tauri dev
else
  echo "正在启动浏览器预览：http://localhost:1420/"
  (sleep 1; open "http://localhost:1420/") &
  exec pnpm dev
fi
