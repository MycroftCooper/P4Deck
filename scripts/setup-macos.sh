#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION="24.16.0"
PNPM_VERSION="11.19.0"
P4_RELEASE="r26.1"
P4_MIN_YEAR="2023"
P4_MIN_MINOR="1"
CHECK_ONLY=0
ASSUME_YES=0

usage() {
  printf '%s\n' "用法: ./scripts/setup-macos.sh [--check] [--yes]"
  printf '%s\n' "  --check  只检查，不安装或修改任何内容"
  printf '%s\n' "  --yes    自动安装缺失组件；绝不覆盖不兼容的已有组件"
}

for argument in "$@"; do
  case "$argument" in
    --check) CHECK_ONLY=1 ;;
    --yes) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf '未知参数: %s\n' "$argument" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '%s\n' "错误：该脚本仅支持 macOS。" >&2
  exit 1
fi

confirm_install() {
  local label="$1"
  if (( CHECK_ONLY )); then return 1; fi
  if (( ASSUME_YES )); then return 0; fi
  printf '缺少 %s，是否安装？[y/N] ' "$label"
  read -r answer
  [[ "$answer" == "y" || "$answer" == "Y" ]]
}

version_major() {
  printf '%s' "$1" | sed -E 's/^[^0-9]*([0-9]+).*/\1/'
}

append_shell_path_once() {
  local rc_file="$HOME/.zshrc"
  local marker="# >>> P4Deck toolchain >>>"
  if [[ -f "$rc_file" ]] && grep -Fq "$marker" "$rc_file"; then
    return
  fi
  {
    printf '\n%s\n' "$marker"
    printf '%s\n' 'export PATH="$HOME/.local/bin:$HOME/.local/node-v24.16.0/bin:$HOME/.cargo/bin:$PATH"'
    printf '%s\n' 'export npm_config_cache="$HOME/.local/npm-cache"'
    printf '%s\n' '# <<< P4Deck toolchain <<<'
  } >> "$rc_file"
  printf '%s\n' "已向 ~/.zshrc 追加 P4Deck PATH 配置（未覆盖原内容）。"
}

download_verified() {
  local url="$1"
  local checksum_url="$2"
  local checksum_name="$3"
  local output="$4"
  local checksum_file="${output}.sha256sums"
  curl --proto '=https' --tlsv1.2 -fL "$url" -o "$output"
  curl --proto '=https' --tlsv1.2 -fL "$checksum_url" -o "$checksum_file"
  local expected actual
  expected="$(awk -v name="$checksum_name" '$2 == name || $2 == "./" name {print $1}' "$checksum_file" | head -n 1)"
  actual="$(shasum -a 256 "$output" | awk '{print $1}')"
  if [[ -z "$expected" || "$expected" != "$actual" ]]; then
    printf '错误：%s 的 SHA-256 校验失败。\n' "$checksum_name" >&2
    exit 1
  fi
  printf '✓ SHA-256 已验证：%s\n' "$checksum_name"
}

missing=0
incompatible=0
needs_path=0

printf '%s\n' "P4Deck macOS 环境检查"
printf '系统：%s %s\n\n' "$(sw_vers -productVersion)" "$(uname -m)"

if xcode-select -p >/dev/null 2>&1; then
  printf '✓ Xcode Command Line Tools: %s\n' "$(xcode-select -p)"
else
  printf '%s\n' "✗ 缺少 Xcode Command Line Tools"
  missing=$((missing + 1))
  if confirm_install "Xcode Command Line Tools"; then
    xcode-select --install || true
    printf '%s\n' "已打开系统安装程序。安装完成后请重新运行本脚本。"
  fi
fi

if command -v node >/dev/null 2>&1; then
  node_version="$(node --version)"
  if [[ "$(version_major "$node_version")" == "24" ]]; then
    printf '✓ Node.js: %s（兼容）\n' "$node_version"
  else
    printf '✗ Node.js: %s；项目要求 24.x。不会覆盖现有安装。\n' "$node_version"
    incompatible=$((incompatible + 1))
  fi
elif [[ -x "$HOME/.local/node-v${NODE_VERSION}/bin/node" ]]; then
  printf '✓ Node.js: v%s（用户目录，等待 PATH 生效）\n' "$NODE_VERSION"
  needs_path=1
else
  printf '✗ 缺少 Node.js %s\n' "$NODE_VERSION"
  missing=$((missing + 1))
  if confirm_install "Node.js ${NODE_VERSION}"; then
    architecture="$(uname -m)"
    case "$architecture" in arm64) node_arch="arm64" ;; x86_64) node_arch="x64" ;; *) printf '不支持的架构: %s\n' "$architecture" >&2; exit 1 ;; esac
    temp_dir="$(mktemp -d /private/tmp/p4deck-node.XXXXXX)"
    archive="node-v${NODE_VERSION}-darwin-${node_arch}.tar.gz"
    download_verified "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" "$archive" "$temp_dir/$archive"
    mkdir -p "$HOME/.local"
    tar -xzf "$temp_dir/$archive" -C "$HOME/.local"
    mv "$HOME/.local/node-v${NODE_VERSION}-darwin-${node_arch}" "$HOME/.local/node-v${NODE_VERSION}"
    needs_path=1
  fi
fi

effective_path="$HOME/.local/bin:$HOME/.local/node-v${NODE_VERSION}/bin:$HOME/.cargo/bin:$PATH"

if PATH="$effective_path" command -v pnpm >/dev/null 2>&1; then
  pnpm_version="$(PATH="$effective_path" pnpm --version)"
  if [[ "$pnpm_version" == "$PNPM_VERSION" ]]; then
    printf '✓ pnpm: %s\n' "$pnpm_version"
  else
    printf '✗ pnpm: %s；项目固定为 %s。不会覆盖现有安装。\n' "$pnpm_version" "$PNPM_VERSION"
    incompatible=$((incompatible + 1))
  fi
else
  printf '✗ 缺少 pnpm %s\n' "$PNPM_VERSION"
  missing=$((missing + 1))
  if PATH="$effective_path" command -v npm >/dev/null 2>&1 && confirm_install "pnpm ${PNPM_VERSION}"; then
    mkdir -p "$HOME/.local/npm-cache" "$HOME/.local"
    PATH="$effective_path" npm_config_cache="$HOME/.local/npm-cache" npm install --global --prefix "$HOME/.local" "pnpm@${PNPM_VERSION}"
    needs_path=1
  fi
fi

if command -v rustup >/dev/null 2>&1 || [[ -x "$HOME/.cargo/bin/rustup" ]]; then
  rustup_command="$(command -v rustup 2>/dev/null || printf '%s' "$HOME/.cargo/bin/rustup")"
  if "$rustup_command" toolchain list | grep -Eq '^1\.97\.1(-|[[:space:]])'; then
    printf '%s\n' "✓ Rust Toolchain: 1.97.1（已安装）"
    installed_components="$("$rustup_command" component list --toolchain 1.97.1 --installed)"
    if ! grep -q '^rustfmt-' <<< "$installed_components" || ! grep -q '^clippy-' <<< "$installed_components"; then
      printf '%s\n' "✗ Toolchain 缺少 rustfmt 或 clippy。"
      missing=$((missing + 1))
      if confirm_install "Rust 组件 rustfmt 和 clippy"; then "$rustup_command" component add --toolchain 1.97.1 rustfmt clippy; fi
    else
      printf '%s\n' "✓ Rust 组件: rustfmt、clippy"
    fi
    command -v rustc >/dev/null 2>&1 || needs_path=1
  else
    printf '%s\n' "✗ 已有 rustup，但缺少项目 Toolchain 1.97.1；不会替换其他 Toolchain。"
    missing=$((missing + 1))
    if confirm_install "Rust Toolchain 1.97.1、rustfmt 和 clippy"; then
      "$rustup_command" toolchain install 1.97.1 --profile default --component rustfmt --component clippy
      needs_path=1
    fi
  fi
elif command -v rustc >/dev/null 2>&1 && command -v cargo >/dev/null 2>&1; then
  printf '✗ 检测到非 rustup Rust：%s；项目固定为 1.97.1，不会覆盖。\n' "$(rustc --version)"
  incompatible=$((incompatible + 1))
else
  printf '%s\n' "✗ 缺少 Rust/Cargo"
  missing=$((missing + 1))
  if confirm_install "Rust stable、Cargo、rustfmt 和 clippy"; then
    temp_dir="$(mktemp -d /private/tmp/p4deck-rust.XXXXXX)"
    curl --proto '=https' --tlsv1.2 -fL https://sh.rustup.rs -o "$temp_dir/rustup-init.sh"
    sh "$temp_dir/rustup-init.sh" -y --profile default --default-toolchain 1.97.1 --no-modify-path
    "$HOME/.cargo/bin/rustup" component add rustfmt clippy
    needs_path=1
  fi
fi

if command -v p4 >/dev/null 2>&1; then
  p4_revision="$(p4 -V 2>&1 | awk '/^Rev\./ {print $0; exit}')"
  p4_year="$(printf '%s' "$p4_revision" | sed -nE 's#.*P4/[^/]*/([0-9]{4})\.([0-9]+).*#\1#p')"
  p4_minor="$(printf '%s' "$p4_revision" | sed -nE 's#.*P4/[^/]*/([0-9]{4})\.([0-9]+).*#\2#p')"
  if [[ -n "$p4_year" && -n "$p4_minor" ]] &&
    (( p4_year > P4_MIN_YEAR || (p4_year == P4_MIN_YEAR && p4_minor >= P4_MIN_MINOR) )); then
    printf '✓ P4 CLI: %s\n' "$p4_revision"
  else
    printf '✗ P4 CLI 版本过旧或无法识别：%s；不会覆盖。\n' "$p4_revision"
    incompatible=$((incompatible + 1))
  fi
elif [[ -x "$HOME/.local/bin/p4" ]]; then
  printf '✓ P4 CLI: 已安装在 ~/.local/bin（等待 PATH 生效）\n'
  needs_path=1
else
  printf '%s\n' "✗ 缺少 P4 CLI"
  missing=$((missing + 1))
  if confirm_install "P4 CLI ${P4_RELEASE}"; then
    architecture="$(uname -m)"
    case "$architecture" in arm64) p4_platform="bin.macosx12arm64" ;; x86_64) p4_platform="bin.macosx12x86_64" ;; *) printf '不支持的架构: %s\n' "$architecture" >&2; exit 1 ;; esac
    temp_dir="$(mktemp -d /private/tmp/p4deck-p4.XXXXXX)"
    base_url="https://ftp.perforce.com/perforce/${P4_RELEASE}/${p4_platform}"
    download_verified "$base_url/p4" "$base_url/SHA256SUMS" "p4" "$temp_dir/p4"
    mkdir -p "$HOME/.local/bin"
    install -m 755 "$temp_dir/p4" "$HOME/.local/bin/p4"
    needs_path=1
  fi
fi

if (( needs_path )) && (( ! CHECK_ONLY )); then append_shell_path_once; fi

printf '\n检查结果：缺失 %d 项，不兼容 %d 项。\n' "$missing" "$incompatible"
if (( incompatible > 0 )); then
  printf '%s\n' "请先决定如何处理不兼容版本；脚本未修改它们。" >&2
  exit 1
fi
if (( CHECK_ONLY && missing > 0 )); then exit 1; fi
if (( needs_path )); then printf '%s\n' "请打开新终端后运行：./scripts/doctor.sh"; fi
printf '%s\n' "初始化完成。再次运行本脚本不会重复安装兼容组件。"
