# P4VFS 虚拟 Workspace

> 当前范围：Windows 客户端检测、新建虚拟 Workspace 与状态展示
> 当前验证：TypeScript/Rust 自动化；尚未在真实 P4VFS Agent、Windows Tauri 原生窗口或公司 P4 Server 上验收

## 功能定位

P4VFS 是 Helix Core 的 Windows 客户端虚拟文件代理。Workspace 使用 `altsync` 后，`p4 sync` 先同步文件元数据，具体文件内容在首次读取时由 P4VFS 按需下载。它不是一个可由 P4Deck 独立替代的服务端同步模式。

启用条件：

- Windows 客户端。
- P4 Server 2023.1 或更高版本。
- P4 CLI 2023.1 或更高版本。
- Workspace 的 `Options` 包含 `altsync`。
- 已安装 P4VFS Agent，且 P4Deck 进程可见非空 `P4ALTSYNC` 环境变量。

安装 P4VFS 后通常需要完全退出并重启 P4Deck，才能让新的用户/系统环境变量进入应用进程。

## P4Deck 当前能力

- 新建 Workspace 时可显式选择“P4VFS 虚拟同步”；默认仍是标准同步，不改变旧行为。
- 虚拟同步 preflight 在写服务器前检查 Windows、Server 版本、CLI 版本、`P4ALTSYNC`、连接身份及 Workspace 名称是否已存在。
- 创建表单仅对虚拟 Workspace 写入 `altsync`；创建后重新读取 Client spec，并验证实际 Sync Mode。
- Workspace 页面读取当前 Client 的 `Options` 展示 `SYNC MODE`，并检查 Server/CLI/Agent 条件。虚拟 Workspace 未就绪时显示具体缺失原因。
- 普通 Sync 保持现有受控 `preflightSync -> confirmSync` 流程；P4 CLI 根据 Client 的 `altsync` 选项与 P4VFS 交互，P4Deck 不自行下载占位文件。

## 明确非范围

- 不把已有标准 Workspace 原地转换为虚拟 Workspace。原地修改会影响 Workspace 中已有文件与缓存，当前没有经过验证的安全迁移流程。
- 不提供“切回标准同步”的原地操作。
- 不安装、升级或修复 P4VFS Agent，不写入 `PATH`/`P4ALTSYNC`，也不读取或修改其安装目录。
- 不绕过 Server/CLI 的最小版本限制；缺少版本或 Agent 时必须阻断虚拟 Workspace 创建。
- 不承诺所有文件按需下载状态都可见。P4Deck 只展示官方 P4 命令提供的 Workspace 与版本信息。

## 实现落点

- `src-tauri/src/p4/vfs.rs`：版本判定、`altsync`/`noaltsync` 解析、Agent 环境检查与就绪原因。
- `src-tauri/src/app/vfs_service.rs`：绑定 connection generation 的 `inspect_p4vfs` 服务。
- `src-tauri/src/p4/connection_setup.rs`：读取 `serverVersion`、Workspace `Options` 并生成 Sync Mode。
- `src-tauri/src/app/connection_setup_service.rs`：虚拟 Workspace preflight、`altsync` form、写后回读验证。
- `src/features/settings/ConnectionSpecCreateDialog.tsx`：新建 Workspace 的虚拟同步选项、风险说明和 review 摘要。
- `src/features/workspaces/WorkspacePage.tsx`：当前 Workspace 的 Sync Mode、P4VFS 就绪状态与缺失原因。

## 验证

```powershell
pnpm check:web
pnpm exec vitest run src/features/settings/SettingsPage.test.tsx src/features/workspaces/WorkspacePage.test.tsx src/infrastructure/backend/tauriBackend.test.ts
cargo test --manifest-path src-tauri/Cargo.toml vfs
cargo check --manifest-path src-tauri/Cargo.toml
```

真实验收必须使用隔离测试 Server 与测试 Workspace，至少覆盖：虚拟 Workspace 创建、`altsync` 回读、首次读取触发下载、离线占位状态、Agent 缺失阻断和 Server/CLI 版本不足阻断。不得在真实生产 Workspace 上执行模式切换或清理占位文件。
