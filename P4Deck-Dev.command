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

# 端口被上次残留进程占用时给一条可读提示，而不是只留 Vite 的 strictPort 报错。
check_port() {
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[提示] 端口 $1 已被占用（$2）。如果这是上次未退出的进程，请先结束，否则启动会失败。"
  fi
}

mode="${1:-desktop}"
case "$mode" in
  browser)
    check_port 1420 "浏览器开发服务"
    echo "正在启动浏览器预览：http://localhost:1420/"
    (sleep 1; open "http://localhost:1420/") &
    exec pnpm dev
    ;;
  qa)
    if ! command -v cargo >/dev/null 2>&1; then
      echo "缺少 Rust/Cargo。请先运行 scripts/setup-macos.sh。"
      read -r -p "按回车关闭..." _
      exit 1
    fi
    check_port 1423 "QA 桌面开发前端"
    echo "正在启动 P4Deck QA 桌面开发模式（独立标识 + 独立 debug target）..."
    exec pnpm dev:desktop:qa
    ;;
  *)
    if ! command -v cargo >/dev/null 2>&1; then
      echo "缺少 Rust/Cargo。请先运行 scripts/setup-macos.sh。"
      read -r -p "按回车关闭..." _
      exit 1
    fi
    check_port 1422 "桌面开发前端"
    echo "正在启动 P4Deck 桌面开发模式..."
    echo "前端修改会热更新；Rust 修改会自动重编译并重启。"
    echo "请保持此窗口运行，按 Ctrl+C 停止。"
    exec pnpm dev:desktop
    ;;
esac
