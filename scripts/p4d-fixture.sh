#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_dir="${P4DECK_FIXTURE_DIR:-$repo_dir/.tools/p4d-fixture}"
server_root="$fixture_dir/server"
client_root="$fixture_dir/workspace"
port="${P4DECK_FIXTURE_PORT:-16661}"
env_file="$fixture_dir/env.sh"
pid_file="$fixture_dir/p4d.pid"

find_tool() {
  local name="$1" explicit="$2"
  if [[ -n "$explicit" && -x "$explicit" ]]; then printf '%s\n' "$explicit"; return; fi
  command -v "$name" 2>/dev/null || true
}

download_p4d() {
  : "${P4D_DOWNLOAD_URL:?设置 P4D_DOWNLOAD_URL 后才能下载}"
  : "${P4D_DOWNLOAD_SHA256:?设置官方 SHA-256 后才能下载}"
  mkdir -p "$fixture_dir/bin"
  local target="$fixture_dir/bin/p4d" temporary="$fixture_dir/bin/p4d.download"
  curl --fail --location --proto '=https' --tlsv1.2 "$P4D_DOWNLOAD_URL" --output "$temporary"
  local actual
  actual="$(shasum -a 256 "$temporary" | awk '{print $1}')"
  [[ "$actual" == "$P4D_DOWNLOAD_SHA256" ]] || { rm -f "$temporary"; echo "SHA-256 校验失败" >&2; exit 1; }
  mv "$temporary" "$target"
  chmod 755 "$target"
  printf '%s\n' "$target"
}

resolve_tools() {
  p4_bin="$(find_tool p4 "${P4_PATH:-}")"
  p4d_bin="$(find_tool p4d "${P4D_PATH:-}")"
  [[ -n "$p4_bin" ]] || { echo "未找到 p4，请先运行环境初始化脚本" >&2; exit 1; }
  if [[ -z "$p4d_bin" ]]; then
    [[ "${P4D_ALLOW_DOWNLOAD:-0}" == "1" ]] || { echo "未找到 p4d。可设置 P4D_PATH，或显式设置 P4D_ALLOW_DOWNLOAD=1、P4D_DOWNLOAD_URL、P4D_DOWNLOAD_SHA256。" >&2; exit 1; }
    p4d_bin="$(download_p4d)"
  fi
}

p4_fixture() { P4PORT="localhost:$port" P4USER=super "$p4_bin" "$@"; }

start() {
  resolve_tools
  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then echo "Fixture 已运行：localhost:$port"; return; fi
  mkdir -p "$server_root" "$client_root"
  "$p4d_bin" -r "$server_root" -p "localhost:$port" -L "$fixture_dir/p4d.log" -J "$fixture_dir/journal" -d
  for _ in {1..40}; do p4_fixture info >/dev/null 2>&1 && break; sleep 0.1; done
  pgrep -f "p4d.*localhost:$port" | head -n 1 > "$pid_file" || true
  cat > "$env_file" <<EOF
export P4PORT=localhost:$port
export P4USER=super
export P4CLIENT=p4deck-fixture
export P4CHARSET=none
EOF
  seed
  echo "Fixture 已启动并 Seed：source $env_file"
}

seed() {
  resolve_tools
  p4_fixture protect -o >/dev/null 2>&1 || true
  printf 'Client: p4deck-fixture\nOwner: super\nRoot: %s\nOptions: noallwrite noclobber nocompress unlocked nomodtime normdir\nLineEnd: local\nView:\n\t//depot/... //p4deck-fixture/...\n' "$client_root" | p4_fixture client -i >/dev/null
  mkdir -p "$client_root/main"
  printf 'P4Deck fixture\n' > "$client_root/main/README.txt"
  P4CLIENT=p4deck-fixture p4_fixture add "$client_root/main/README.txt" >/dev/null
  P4CLIENT=p4deck-fixture p4_fixture submit -d 'Seed normal changelist' >/dev/null
  printf 'pending\n' >> "$client_root/main/README.txt"
  P4CLIENT=p4deck-fixture p4_fixture edit "$client_root/main/README.txt" >/dev/null
  local change
  change="$(printf 'Change: new\nClient: p4deck-fixture\nUser: super\nDescription:\n\tFixture shelf\n' | p4_fixture change -i | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
  P4CLIENT=p4deck-fixture p4_fixture reopen -c "$change" "$client_root/main/README.txt" >/dev/null
  P4CLIENT=p4deck-fixture p4_fixture shelve -c "$change" >/dev/null
}

stop() {
  resolve_tools
  p4_fixture admin stop >/dev/null 2>&1 || true
  rm -f "$pid_file"
  echo "Fixture 已停止；数据保留在 $fixture_dir，可用 destroy 清理。"
}

destroy() {
  stop || true
  [[ "$fixture_dir" == "$repo_dir/.tools/p4d-fixture" || "$fixture_dir" == /private/tmp/* || "$fixture_dir" == /tmp/* ]] || { echo "拒绝删除未验证路径：$fixture_dir" >&2; exit 1; }
  rm -rf "$fixture_dir"
  echo "Fixture 已销毁。"
}

case "${1:-}" in
  start) start ;;
  seed) seed ;;
  stop) stop ;;
  destroy) destroy ;;
  *) echo "用法：$0 {start|seed|stop|destroy}" >&2; exit 2 ;;
esac
