# P4Deck Windows 迁移与环境恢复手册

> 适用范围：从当前 macOS 开发机迁移到全新的 Windows 11 x64 设备。  
> 最后核对：2026-09-30。  
> 当前结论：Windows 11 x64 的 Node/pnpm/Rust/MSVC/SDK/WebView2/P4 CLI 环境已验收；桌面应用可构建，Rust 单测启动器仍有 Common Controls manifest 兼容问题。

## 1. 迁移前必须先处理的事项

### 1.1 保存源码基线

当前仓库没有首个 Git Commit，也没有配置 Git Remote，因此现在不能依赖 `git clone` 在新设备恢复项目。迁移前必须选择以下方式之一：

1. **推荐：建立 Git 基线并推送到私有远端。** 确认 `.env`、P4 Ticket、Trust、证书和内网数据未进入暂存区后再提交、推送。
2. **临时离线迁移：制作源码归档。** 归档必须包含隐藏文件和 `.git`，排除下面的可重建目录。

当前还有一项 Git LFS 风险：图片等二进制资源已按 LFS 指针暂存，`.git/lfs` 中有 44 个本地对象，但当前 macOS 环境找不到 `git lfs` 命令。选择私有远端方案时，必须先在旧设备恢复 Git LFS，并确认对象完整后再推送：

```bash
git lfs install
git lfs fsck
git lfs status
```

推送后必须从一个新的临时目录做一次干净 Clone，并确认图标不是 LFS 指针文本。仅看到 Git Push 成功，不代表 LFS 对象已经完整上传。

不要搬运：

- `node_modules/`
- `src-tauri/target/`
- `dist/`
- `.tools/`
- `.pnpm-store/`
- `.env`、P4 Ticket、Trust、密码、签名证书

当前 `src-tauri/target/` 约 9 GB，是本地编译缓存；迁移它不仅浪费空间，也不能在 Windows 上复用。

迁移前记录：

```bash
git status --short
git diff --check
git remote -v
git lfs fsck
```

如果还不能建立远端，可在 macOS 项目上级目录创建临时源码归档：

```bash
tar \
  --exclude='P4Deck/node_modules' \
  --exclude='P4Deck/src-tauri/target' \
  --exclude='P4Deck/dist' \
  --exclude='P4Deck/.tools' \
  --exclude='P4Deck/.env' \
  -czf P4Deck-source-migration.tar.gz P4Deck
```

生成后应将归档放到受控存储，并在 Windows 解压后立即检查 `git status --short`。归档不是长期版本管理方案。

离线归档必须保留 `.git/lfs`；否则当前尚未推送的二进制对象可能只剩指针。归档后至少抽查 `src-tauri/icons/icon.png` 能被图片查看器打开，而不是以 `version https://git-lfs.github.com/spec/v1` 开头的文本文件。

### 1.2 单独记录但不要提交的配置

以下数据必须通过密码管理器或公司批准的安全渠道迁移，不得写入项目文档或 Git：

- Git 私有远端凭据或 SSH 私钥；
- P4 Server 地址、用户名、Workspace 名称和 `P4CONFIG` 位置；
- P4 Ticket、SSL Trust、SSO/MFA 信息；
- Windows 代码签名证书及密码。

建议只记录非秘密的配置名称和恢复负责人，凭据在新设备上重新登录生成。

## 2. Windows 设备前置条件

基线设备：Windows 11 x64。Windows ARM64 尚未验收。

项目固定版本：

| 组件 | 要求 | 来源 |
|---|---:|---|
| Node.js | 24.16.0 / 兼容 24.x | `.node-version` |
| pnpm | 11.19.0 / 兼容 11.x | `package.json#packageManager` |
| Rust | 1.97.1，MSVC Toolchain | `rust-toolchain.toml` |
| Visual Studio Build Tools | 2022，Desktop development with C++ | Tauri Windows 编译 |
| WebView2 Runtime | 已安装 | Tauri Windows 运行 |
| P4 CLI | 2023.1+，推荐 2026.1 | 真实 P4 能力 |
| Git | 当前稳定版，启用 Git LFS | 源码恢复及仓库属性 |

`scripts/setup-windows.ps1` 可以检查或安装 Node.js、pnpm、Rust、P4 CLI、Visual Studio C++ Build Tools 和 WebView2。Git/Git LFS 应在取得源码前安装。

## 3. 最短恢复流程

### 3.1 安装 Git 并取得源码

在 PowerShell 中执行：

```powershell
winget install --id Git.Git --exact
```

重新打开 PowerShell 后：

```powershell
git lfs install
git clone <私有仓库地址> P4Deck
Set-Location .\P4Deck
```

如果使用离线归档，解压后进入项目根目录，并确认 `.git`、`.node-version`、`pnpm-lock.yaml`、`rust-toolchain.toml` 均存在。

### 3.2 检查并安装开发依赖

若 PowerShell 阻止运行本地脚本，只对当前进程放行，不修改系统级策略：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

先做只读检查：

```powershell
.\scripts\setup-windows.ps1 -Check
```

缺少组件时，二选一：

```powershell
# 每项询问后安装
.\scripts\setup-windows.ps1

# 自动安装缺失项；不会覆盖脚本识别到的不兼容版本
.\scripts\setup-windows.ps1 -Yes
```

安装完成后关闭当前 PowerShell，打开一个全新的 PowerShell，让用户 PATH 生效。

### 3.3 安装项目依赖并做环境验收

```powershell
Set-Location <P4Deck项目目录>
.\scripts\doctor.ps1
pnpm install --frozen-lockfile
```

不要从 macOS 复制 `node_modules` 或 Rust `target`；它们包含平台相关产物，必须在 Windows 重建。

## 4. 完整工程验收

以下命令必须全部通过：

```powershell
pnpm format:check
pnpm build
pnpm test
pnpm check
cargo clippy --manifest-path .\src-tauri\Cargo.toml -- -D warnings
git diff --check
```

当前 macOS 基线为前端 222 项、Rust 53 项测试通过。Windows 上测试数量可以随代码增加，但不得减少或出现跳过原因不明的测试。

### 4.1 浏览器 Mock 模式

```powershell
pnpm dev
```

浏览器打开 `http://localhost:1420/`。至少检查：首页渲染、Workspace/Files/Pending/Submitted/Shelves 页面、右键菜单、操作弹窗、深色模式和 50,000 项虚拟列表演示。

也可以双击项目根目录的 `P4Deck-Dev.cmd`，选择 `1`。

### 4.2 Tauri 桌面模式

```powershell
pnpm tauri dev
```

也可以双击 `P4Deck-Dev.cmd`，选择 `2`。至少检查：

- 主窗口正常启动，无白屏或 WebView2 错误；
- 系统菜单、键盘焦点、弹窗关闭回焦；
- “在资源管理器中定位”和 Windows Open With；
- 中文、空格和长路径；
- 诊断导出文件能够生成，内容不泄漏 Ticket、密码和原始命令参数。

## 5. P4 环境恢复

### 5.1 仅做 UI 开发

没有 P4 Server 或 P4 CLI 时，可继续运行浏览器 Mock 模式。此模式不能证明连接、Sync、Submit、Shelf、Unshelve 或 Resolve 的真实行为。

### 5.2 连接真实开发服务器

优先通过 Workspace 根目录的 `P4CONFIG` 管理非秘密连接参数。不要把真实配置文件提交到仓库。重新执行：

```powershell
p4 -V
p4 info
p4 login -s
```

如使用 SSL Server，按组织流程重新建立 Trust；不要从旧机器直接复制不明来源的 Ticket 或 Trust 文件。真实环境首次操作应使用测试 Workspace 和非关键 Changelist。

### 5.3 本地 p4d Fixture

仓库已提供原生 PowerShell Fixture：`scripts/p4d-fixture.ps1`。它使用项目内固定版本的 `p4.exe` 和 `p4d.exe`，只监听 `127.0.0.1:16661`，并将 Server Root、Workspace、日志、Ticket、Trust 和 P4ENVIRO 隔离在 `.tools/p4d-fixture`。它不会注册 Windows 服务、修改系统 PATH 或复用用户工作环境的 P4 配置。

```powershell
pnpm fixture:setup:win
pnpm fixture:start:win
pnpm fixture:status:win
pnpm fixture:stop:win
```

2026-09-30 已在 Windows 原生环境完成下载校验、启动、Seed、停止、重启和重复启动验收；端口冲突与 Server ID 不匹配时均拒绝操作。禁止把自动化测试指向生产或个人真实 P4 Server。

## 6. Windows 首轮验收记录

在 [项目状态总览](../PM/项目状态总览.md) 更新下列结果：

| 验收项 | 结果 | 证据/问题 |
|---|---|---|
| `setup-windows.ps1 -Check` | 通过 | Node 24.16.0、pnpm 11.19.0、Rust 1.97.1、P4 2023.1、MSVC、WebView2 |
| `doctor.ps1` | 通过 | 0 个错误，0 个警告 |
| 前端测试 | 通过 | 37 个测试文件、222 项通过 |
| Rust 测试与 Clippy | 部分通过 | `cargo check` 和 Clippy `-D warnings` 通过；单测编译链接成功，启动因缺 Common Controls v6 manifest 失败 |
| 生产构建 | 通过 | `pnpm build` 和 `pnpm tauri build --debug --no-bundle` 通过 |
| `pnpm tauri dev` | 待执行 | |
| Windows 原生交互冒烟 | 待执行 | Explorer/Open With/焦点/多窗口 |
| 本地 `p4d` Fixture | 通过 | P4D 2026.1；`127.0.0.1:16661`；提交与 Shelf Seed、停止/重启、幂等启动已验证 |
| Windows 安装包 | 待执行 | MSI/NSIS 尚未形成发布基线 |

## 7. 常见问题

### 找不到 `pnpm`、`cargo` 或 `p4`

初始化脚本可能刚更新了用户 PATH。关闭所有 PowerShell 窗口并重新打开，再运行 `doctor.ps1`。

### Visual Studio 已安装，但脚本仍提示缺少 C++ Build Tools

打开 Visual Studio Installer，给 VS 2022 Build Tools 增加 `Desktop development with C++`，确保包含 MSVC x64/x86 和 Windows SDK。

### `pnpm install --frozen-lockfile` 失败

先核对 Node.js 是否为 24.x、pnpm 是否为 11.19.0，不要删除或重写 `pnpm-lock.yaml` 来绕过问题。

### 中文文件名或脚本输出乱码

使用 Windows Terminal / PowerShell 7；批处理启动器会执行 `chcp 65001`。仓库已通过 `.gitattributes` 固定源码换行规则。

### 能否直接复制整个项目目录

不建议。至少应排除 `node_modules`、`src-tauri/target`、`dist` 和 `.tools`。最佳方式仍是先形成 Git Commit 并从私有远端恢复。
