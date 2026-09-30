#!/usr/bin/env bash
set -u

failures=0
warnings=0
frontend_only=0

if [[ "${1:-}" == "--frontend-only" ]]; then
  frontend_only=1
elif [[ $# -gt 0 ]]; then
  printf '未知参数: %s\n' "$1" >&2
  exit 2
fi

if command -v node >/dev/null 2>&1; then
  node_version="$(node --version)"
  if [[ "$node_version" == v24.* ]]; then printf '✓ %-12s %s\n' "Node.js" "$node_version"; else printf '✗ %-12s %s（需要 24.x）\n' "Node.js" "$node_version"; failures=$((failures + 1)); fi
else printf '✗ %-12s missing\n' "Node.js"; failures=$((failures + 1)); fi

if command -v pnpm >/dev/null 2>&1; then
  pnpm_version="$(pnpm --version)"
  if [[ "$pnpm_version" == "11.19.0" ]]; then printf '✓ %-12s %s\n' "pnpm" "$pnpm_version"; else printf '✗ %-12s %s（需要 11.19.0）\n' "pnpm" "$pnpm_version"; failures=$((failures + 1)); fi
else printf '✗ %-12s missing\n' "pnpm"; failures=$((failures + 1)); fi

if (( ! frontend_only )); then
  if command -v rustup >/dev/null 2>&1; then
    if rustup toolchain list | grep -Eq '^1\.97\.1(-|[[:space:]])'; then printf '✓ %-12s 1.97.1\n' "Rust"; else printf '✗ %-12s 缺少 Toolchain 1.97.1\n' "Rust"; failures=$((failures + 1)); fi
  else printf '✗ %-12s missing rustup\n' "Rust"; failures=$((failures + 1)); fi

  if command -v cargo >/dev/null 2>&1; then printf '✓ %-12s %s\n' "Cargo" "$(cargo --version)"; else printf '✗ %-12s missing\n' "Cargo"; failures=$((failures + 1)); fi
fi

if command -v p4 >/dev/null 2>&1; then
  revision="$(p4 -V 2>&1 | awk '/^Rev\./ {print $0; exit}')"
  p4_year="$(printf '%s' "$revision" | sed -nE 's#.*P4/[^/]*/([0-9]{4})\.([0-9]+).*#\1#p')"
  p4_minor="$(printf '%s' "$revision" | sed -nE 's#.*P4/[^/]*/([0-9]{4})\.([0-9]+).*#\2#p')"
  if [[ -n "$p4_year" && -n "$p4_minor" ]] && (( p4_year > 2023 || (p4_year == 2023 && p4_minor >= 1) )); then printf '✓ %-12s %s\n' "P4 CLI" "$revision"; else printf '✗ %-12s %s（需要 2023.1+）\n' "P4 CLI" "$revision"; failures=$((failures + 1)); fi
else printf '△ %-12s missing；仅 UI 开发可继续\n' "P4 CLI"; warnings=$((warnings + 1)); fi

if (( ! frontend_only )) && [[ "$(uname -s)" == "Darwin" ]]; then
  if xcode-select -p >/dev/null 2>&1; then printf '✓ %-12s %s\n' "Xcode tools" "$(xcode-select -p)"; else printf '✗ %-12s 运行 xcode-select --install\n' "Xcode tools"; failures=$((failures + 1)); fi
fi

printf '\n检查完成：%d 个错误，%d 个警告。\n' "$failures" "$warnings"
if (( failures > 0 )); then printf '%s\n' "参见 ForAIDoc/Coder/开发环境.md。"; exit 1; fi
if (( frontend_only )); then printf '%s\n' "前端 Mock 开发环境已就绪；Tauri 桌面开发仍需 Rust 和系统编译工具。"
else printf '%s\n' "桌面开发环境已就绪。"; fi
