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
pnpm tauri dev    # 桌面能力验证
```

Windows 使用 `.\scripts\setup-windows.ps1 -Check` 和 `.\scripts\setup-windows.ps1`。当前机器只做前端 Mock 开发时，可用 `.\scripts\doctor.ps1 -FrontendOnly`。初始化脚本会跳过兼容的已有工具，遇到不兼容版本时停止，不会擅自覆盖。详见 [开发环境与新设备部署](ForAIDoc/Coder/开发环境.md)。

从 macOS 换到全新 Windows 设备时，先按 [Windows 迁移与环境恢复手册](ForAIDoc/Coder/Windows迁移与环境恢复.md) 保存当前源码基线。当前仓库没有首个 Git Commit 和 Remote，不能直接假设新设备可通过 `git clone` 恢复现有成果。

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
- [体验与界面规范](ForAIDoc/Designer/体验与界面规范.md)

## 架构边界

React 只负责界面和交互状态，不能直接启动进程或读取任意文件。前端通过受限的 Tauri Commands 调用 Rust；Rust 负责命令策略、并发、取消、脱敏和 P4 输出解析。首版通过 `p4 -ztag -Mj` 读取结构化输出。
