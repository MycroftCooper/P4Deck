# P4Deck

P4Deck 是一个面向 Windows 和 macOS 的现代 Helix Core 桌面客户端，专注于快速、清晰地完成 Workspace、文件状态、Changelist、Diff、Sync 和 Submit 工作流。

核心目标是让 P4 后台操作永不拖卡前端，在超大 CL 和文件列表下依然流畅；通过缓存与请求治理降低服务器负载，并以现代 UI、低资源占用和 Windows/macOS 一致体验作为长期约束。完整定义见 [项目立项书](ForAIDoc/PM/项目立项书.md#核心目标)。

> 当前状态：Alpha 骨架阶段。浏览器支持 Mock 演示，Tauri 已接入部分真实 P4 能力，但核心工作流和跨平台验收尚未闭环，不能用于生产环境。详见 [项目状态总览](ForAIDoc/PM/项目状态总览.md)。

## 技术栈

- Tauri 2
- React 19 + TypeScript + Vite
- Rust
- 官方 `p4` CLI
- pnpm

## P4VFS 虚拟 Workspace

P4VFS 是 Windows 客户端上的虚拟文件代理，不是 P4 Server 内置功能。服务端和 `p4` CLI 仍需支持 `altsync`，当前最低版本均为 2023.1；客户端还必须安装 P4VFS，并使 P4Deck 进程可见 `P4ALTSYNC` 环境变量。

P4Deck 当前支持在“新建 Workspace”时选择标准同步或 P4VFS 虚拟同步，并在 Workspace 页显示当前同步方式与 P4VFS 就绪/缺失条件。普通 Sync 仍走现有 `p4 sync`，由 P4 CLI/P4VFS 透明处理元数据同步和按需下载。

当前不提供已有标准 Workspace 的原地转换，也不捆绑 P4VFS 安装器或修改系统环境变量。完整边界见 [P4VFS 虚拟 Workspace](ForAIDoc/Coder/P4VFS虚拟Workspace.md)。

## 开始开发

前端 Mock 开发需要 Node.js 24 和 pnpm 11；Tauri 桌面开发还需要 Rust 1.97.1、操作系统编译工具和官方 `p4` CLI 2023.1+。完整说明参见 [开发环境](ForAIDoc/Coder/开发环境.md)。

```bash
# 新设备先检查；不会安装或修改环境
./scripts/setup-macos.sh --check

# 缺失组件逐项确认安装
./scripts/setup-macos.sh

pnpm install --frozen-lockfile
./scripts/doctor.sh
pnpm dev          # 浏览器开发预览
pnpm dev:desktop # 桌面开发：前端热更新，Rust 改动自动重启
```

Windows 使用 `.\scripts\setup-windows.ps1 -Check` 和 `.\scripts\setup-windows.ps1`。当前机器只做前端 Mock 开发时，可用 `.\scripts\doctor.ps1 -FrontendOnly`。初始化脚本会跳过兼容的已有工具，遇到不兼容版本时停止，不会擅自覆盖。详见 [开发环境与新设备部署](ForAIDoc/Coder/开发环境.md)。

从 macOS 换到全新 Windows 设备时，先按 [Windows 迁移与环境恢复手册](ForAIDoc/Coder/Windows迁移与环境恢复.md) 保存当前源码基线。当前仓库没有首个 Git Commit 和 Remote，不能直接假设新设备可通过 `git clone` 恢复现有成果。

## 日常调试（热更新）

当前 AI 开发仅允许项目本地假 P4，禁止连接公司生产 P4，包括只读查询。启动桌面、fixture 或 P4 集成测试前，先完成 [本地假 P4 安全核验](ForAIDoc/Coder/本地假P4安全核验.md)；以下命令是入口说明，不表示已通过安全核验。

Windows 直接双击根目录的 `P4Deck-Dev.cmd`；macOS 双击 `P4Deck-Dev.command`。默认启动真实 Tauri 桌面开发模式，也可在项目目录运行：

```powershell
pnpm dev:desktop
```

保持启动终端运行，按 Ctrl+C 停止。修改 React、CSS、前端文案会直接热更新；修改 Rust 后由 Tauri 自动重编译并重启桌面窗口。首次启动需要编译 Debug 程序，后续使用增量编译。日常修改无需执行 `build:desktop:win`，也无需更换 exe。

桌面开发使用 `127.0.0.1:1422`；`pnpm dev` 的浏览器 Mock 和浏览器测试仍使用 `1420`，两者可同时运行，并各自使用独立的 Vite 依赖缓存。Windows 启动器也支持 `P4Deck-Dev.cmd browser`。如果启动时前端脚本加载失败，窗口会显示错误和重新加载按钮；加载超过 10 秒也会提供重试入口。

桌面开发服务为前端资源返回完整响应并禁用 HTTP 磁盘缓存，避免 WebView2 遇到损坏的缓存正文时因 `304 / ERR_CACHE_READ_FAILURE` 启动失败。Vite 的编译与依赖缓存、热更新以及 IndexedDB 中的业务快照继续保留；此规则只用于桌面开发服务。依赖预构建从 `index.html` 入口扫描，避免遍历 Rust 的 `target` 构建产物。可用 `pnpm exec playwright test tests/browser/desktop-dev-server.spec.ts` 回归这一启动路径。

涉及提交、删除、还原的自动测试使用隔离 QA 开发实例：

```powershell
pnpm dev:desktop:qa
# 或 P4Deck-Dev.cmd qa
```

此 Windows 命令先启动仓库的本地 P4 fixture，再使用独立的 QA 设置目录启动桌面开发窗口；保留现有 QA 配置的应用标识以便继续使用原隔离工作区。首次使用时在 QA 窗口连接 `127.0.0.1:16661`，用户 `p4deck-fixture-admin`，工作区 `p4deck-fixture`，字符集 `none`；CLI、Tickets、Trust 文件路径见 `.tools/p4d-fixture/env.ps1`。本机已有的 `p4deck-qa-ui-20261020` 隔离工作区可以继续使用。普通桌面开发和 QA 开发共用一个调试构建，同一时间运行其中一个。

## Windows 独立包（交付时使用）

```powershell
pnpm build:desktop:win
.\artifacts\desktop\P4Deck.exe
```

此命令生成内嵌前端资源的独立 exe，关闭终端和开发服务器后仍可直接双击运行。输出固定为 `artifacts\desktop\P4Deck.exe`，后续 `pnpm tauri dev` 不会覆盖它。

`pnpm dev:desktop` 生成的 `src-tauri\target\debug\p4deck.exe` 依赖本地开发服务器，仅用于开发；请通过启动器或开发命令启动整个环境，不要单独双击这个 Debug exe。

## 检查

```bash
pnpm build
pnpm test:web     # 当前机器可执行
pnpm check:web    # 当前机器可执行
pnpm test         # 前端 + Rust，需要完整桌面环境
pnpm check        # TypeScript + Cargo，需要完整桌面环境
```

## 文档

- [项目文档入口](ForAIDoc/README.md)
- [项目状态总览](ForAIDoc/PM/项目状态总览.md)
- [项目立项书](ForAIDoc/PM/项目立项书.md)
- [开发路线图](ForAIDoc/PM/开发路线图.md)
- [技术架构](ForAIDoc/Coder/技术架构.md)
- [开发环境](ForAIDoc/Coder/开发环境.md)
- [P4VFS 虚拟 Workspace](ForAIDoc/Coder/P4VFS虚拟Workspace.md)
- [体验与界面规范](ForAIDoc/Designer/体验与界面规范.md)

## 架构边界

React 只负责界面和交互状态，不能直接启动进程或读取任意文件。前端通过受限的 Tauri Commands 调用 Rust；Rust 负责命令策略、并发、取消、脱敏和 P4 输出解析。首版通过 `p4 -ztag -Mj` 读取结构化输出。
