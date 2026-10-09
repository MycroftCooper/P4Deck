# Swarm 基础链接

> 状态：P1 基础只读链接已实现（2026-10-09）

## 设置与持久化

每个 Connection Profile 可选配置 `Swarm 基础 URL`。连接文档 schema 已从 v2 升级为 v3；加载 v2 时只提升版本，不猜测 Swarm 地址，旧 profile 的该字段保持未配置。保存时统一规范为带尾斜杠的绝对 `http`/`https` URL，并保留反向代理部署子路径。

URL 禁止内嵌用户名/密码、query、fragment、反斜杠、控制字符、编码控制字符、编码路径分隔符/点段及非 HTTP(S) scheme。Swarm token、P4 password/ticket 内容、SSO 状态不属于 schema，也不会进入 URL、日志、通知或历史。配置不发起网络探测；登录由系统浏览器和 Swarm 自己处理。

## 支持矩阵

路由以 Perforce Swarm/P4 Code Review 官方 Quick URLs 为准：

| P4Deck 上下文 | URL | 状态与边界 |
| --- | --- | --- |
| Submitted CL | `<base>/changes/<change>` | 支持正整数编号 |
| 编号 Pending CL | `<base>/changes/<change>` | 支持；Default/未编号 CL 禁用并说明原因 |
| Shelf | `<base>/changes/<change>` | 支持来源 CL；不推断 Review ID |
| Depot 文件 | `<base>/files/<严格逐段编码的 depot path>` | 只接受完整 `//depot/...`；本地路径禁用 |
| 文件修订 | 上述文件 URL 加 `?v=<revision>` | 只接受正整数 revision；未知 revision 禁用 |
| Review | 无 | 本批不创建、不搜索也不推断 Review ID |

路径逐段进行 RFC 3986 风格编码，空格、`#`、`%`、Unicode 和保留字符不会改变路由或 query。Default CL、空/不完整 depot path、非法 revision 和未知对象不会拼猜 URL。

## 入口与打开边界

- Submitted 列表/详情、Pending 与 Shelf、Submitted 文件、History 修订、Diff/Rev Graph 页提供按钮或右键项；统一命令目录提供 `swarm.open`，命令面板和 Tauri 原生 Navigate 菜单共同使用该 ID。
- 未配置时入口显示“配置 Swarm”，打开 Settings；非法或不受支持的上下文保持禁用并显示原因。
- 前端 `SwarmLinkBuilder` 是唯一业务 URL builder。浏览器演示使用 `window.open(..., noopener,noreferrer)`；桌面应用只传强类型请求给 Rust opener。
- Rust 在调用操作系统前重新读取活动 profile、context generation 和规范化 base URL，拒绝旧窗口/旧闭包的 profile 或 generation，并再次校验同源、部署子路径及 `/changes`、`/files` allowlist。Windows 使用 `ShellExecuteW`，macOS 使用固定 `/usr/bin/open`，不调用 Shell 字符串。
- 独立 panel 从当前 RuntimeInfo 重建入口；连接代次变化会即时刷新可用状态。最终 Rust CAS 是跨窗口竞态的权威防线。

## 自动化证据与限制

Web 单测覆盖 base URL 规范化、恶意 scheme、embedded credentials、query/fragment、CRLF/编码控制字符、空格/`#`/`%`/Unicode/保留字符编码、Submitted/Pending/Shelf/File/Revision 映射、缺配置、Default CL、不同 profile/generation 和独立 panel 请求绑定。Rust 单测覆盖 schema v2→v3 迁移、最终路由 allowlist、跨 origin/部署路径逃逸、凭据、query 注入、编码分隔符、错误不回显 URL 和旧 profile/generation 拒绝。

2026-10-09 自动化复验：Web 74 个测试文件、439 项通过；Rust 150 项通过，另有 1 项 localhost E2E 在默认套件中显式 ignored；`pnpm build/check/format:check`、Cargo check/test、Clippy `--all-targets -D warnings`、rustfmt 与 `git diff --check` 通过。前端 8 项、后端 5 项性能正确性门禁通过；Windows localhost p4d 应用层 E2E 连续两轮通过（134.86 秒、135.57 秒）。

本能力不包含 Swarm REST API、可用性探测、凭据管理、登录/SSO、评论、Review 查询/创建、webhook 或 Review ID 映射。自动化测试不替代 Windows/macOS 原生浏览器实际启动、焦点、菜单点击、弹窗拦截和读屏验收；这些必须在对应桌面设备和真实 Swarm 部署上外部验证。
