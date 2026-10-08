# P4Deck 后端 TODO

> 负责人：后端 Agent  
> 建立日期：2026-09-29  
> 当前主线：完成“连接 → Workspace → 文件操作 → Changelist → Submit”的真实 P4 闭环  
> 排序原则：先解除用户闭环阻塞，再做性能与发布质量；不新增 P2 功能面

## 状态说明

| 状态 | 含义 |
|---|---|
| IN PROGRESS | 后端 Agent 正在执行 |
| QUEUED | 已下发给后端 Agent，等待前一项完成后继续 |
| NEXT | 后端 Agent 下一项直接领取 |
| READY | 前置条件已满足，可以顺序执行 |
| BLOCKED | 依赖产品、前端、设备或外部环境 |
| DONE | 已实现并通过约定验证 |

## 当前本机环境与可执行范围

盘点时间：2026-10-08。

| 环境 | 当前状态 | 影响 |
|---|---|---|
| `p4` CLI | 已安装：2023.1 / Windows x64 | 已确认当前命令面与 `-Mj/-x/-b/sync --parallel`可用；真实 Server 行为仍待 E2E |
| `p4d` Server | 已就绪 | Windows 原生隔离 Fixture 已安装并在 `127.0.0.1:16661` 完成 Seed/停止/重启验收 |
| P4 连接变量 | Windows P4 注册表已有连接与凭据相关配置，仓库内无 `.p4config` | 自动化测试不得回退到用户真实 Server 上下文 |
| Node.js / pnpm | Node 24、pnpm 11，已调整为项目基线 | 前端测试、Mock、构建和类型检查可运行 |
| Rust | Rust 1.97.1、Cargo、rustfmt 和 Clippy 已安装；MSVC/Windows SDK 已就绪 | Common Controls v6 manifest 已覆盖 libtest；Pending CL 单测与 localhost E2E 可真实启动 |
| Fixture 脚本 | Windows/macOS 均已存在 | Windows 版使用项目内已校验的 P4/P4D 2026.1；Bash 版仍保持显式下载授权 |

当前可以完整执行：浏览器 Mock、前端构建、TypeScript 检查、前端单测、`cargo test`、`cargo check`、Clippy、Tauri debug 应用构建，以及 Windows localhost 应用层 E2E。Windows libtest 现通过链接器 manifest input 获得 Common Controls v6 依赖，不再以 `0xc0000139 / STATUS_ENTRYPOINT_NOT_FOUND` 退出。

当前已具备真实 Server 验收环境；BE-004a 已完成 Pending CL 数据正确性与基础写操作，BE-003、BE-004b、BE-008 仍需补齐 Submit、Shelf/Unshelve、质量验收，不能仅凭 Fixture 启动成功标记完成。

BE-002 的 Windows localhost 基线已完成；BE-009 中的多版本兼容部分仍需额外版本矩阵。合成数据性能基准可以继续执行。

## 已完成

| ID | 事项 | 验收结果 |
|---|---|---|
| BE-000 | P4 文件 Action 与批量执行骨架 | 强类型 Action、参数校验、`-b 128 -x -`、受控并行、进度/取消及单测已落地 |
| BE-000A | 安全本地路径操作 | Reveal/Open With 已通过强类型 IPC 接入；限制在 Workspace Root 内，不开放任意 Shell/进程；构建与检查恢复通过 |
| BE-001 | 连接与认证服务 | Context/Adapter/Application Service/IPC 已分层；CLI 发现、强类型状态、info/login status/trust/login/logout、安全 stdin、错误分类和脱敏测试已完成；BE-002 已验 localhost info/ticket，SSL/SSO 仍待专项验收 |
| BE-002 | localhost p4d 集成测试基线 | `scripts/test-p4d-e2e.ps1` 固定 `127.0.0.1:16661`、独立凭据文件与测试 Client；应用服务/Repository 覆盖连接、Workspace/Depot、Sync/Edit/Add/Delete/Revert，默认连续运行两次并清理 |
| BE-004a | Pending CL 数据正确性与基础写操作 | 查询按当前 User/Client 严格限定并正确合并 Default、编号 CL、Description/Jobs、opened/shelved files；创建、编辑、删除空 CL 与 Default ↔ 编号移动已通过 Windows localhost 连续两轮 E2E；写契约尚未接前端按钮 |
| BE-005 | 文件状态聚合与缓存失效 | 15 秒 TTL、512 条/16 MiB 双上限、并发合并、generation、stale/offline、局部失效和安全诊断已完成 |
| BE-006 | 操作记录、离线与 ticket 状态 | Operation Journal、2,000 条硬上限、游标分页、结构化终态、崩溃恢复和不可重放边界已完成 |
| BE-007 | 日志策略与诊断导出 | 稳定分页/过滤、策略硬上限、diagnostic-alert、受控 128 KiB 脱敏 JSON 导出已完成 |

## P0：下一阶段必须完成

### BE-001 — 连接与认证服务（DONE：本机可验证范围）

目标：让用户无需终端即可从未连接状态进入一个可用 Workspace。

范围：

- 将当前 `p4/context.rs` 从单个 JSON 设置扩展为独立的 Connection/Application Service；Context 发现、验证、持久化与运行时状态分层。
- 定义强类型连接状态：CLI 缺失、待测试、SSL 未信任、未登录、已连接、ticket 过期、网络/权限/配置错误。
- 提供受控能力：发现/校验 `p4` CLI、`p4 info`、SSL fingerprint 查询与明确确认后的 `p4 trust`、通过 stdin 登录、`p4 login -s` 状态检查、退出登录。
- 密码只允许通过 stdin 进入单次调用，不进入 Context、日志、历史、SQLite 或错误文本；ticket 内容不由应用读取或返回前端。
- 将 P4 常见错误映射为稳定错误码和用户可行动的恢复建议，不能让 UI 解析英文 stderr。
- 保持现有 P4CONFIG、P4TRUST、P4TICKETS、Broker/Proxy 与 SSO/MFA 兼容边界；无法自动完成的 SSO 明确返回外部认证状态。

验收：

1. 单测覆盖 CLI 缺失、普通连接、SSL 未 trust、登录失效、ticket 过期、错误脱敏和 camelCase IPC。
2. Fixture/可控假进程测试覆盖命令参数及 stdin，证明密码不落盘、不进日志。
3. `pnpm test`、`pnpm build`、`pnpm check`、Clippy 和 `git diff --check` 全部通过。
4. 输出给前端的状态足以直接驱动连接向导，不需要前端识别原始 P4 文本。

### BE-002 — localhost p4d 集成测试基线（DONE：Windows）

目标：把“单测可用”升级为“真实 P4 CLI/Server 可重复验证”。

范围：

- 基于 `scripts/p4d-fixture.ps1`（Windows）或 `scripts/p4d-fixture.sh`（macOS/Linux）建立隔离测试数据和固定用户/Workspace/Depot。
- 覆盖连接、Workspace 列表、Depot/Workspace 浏览、Sync、Edit、Add、Delete、Revert。
- 测试只能连接固定 localhost，禁止读取或回退到用户真实 `P4PORT`、ticket 和 trust 文件。
- 无 `p4d` 时明确 skip 并报告原因；CI/开发机有 Fixture 时必须执行。

验收：测试可重复运行、可清理、失败后不污染真实环境，并生成简短验收记录。

实际入口与结果（2026-10-08）：

```powershell
pnpm test:e2e:p4d:win
# 等价：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-p4d-e2e.ps1
```

- 默认连续执行两轮，两轮均通过；每轮创建并最终删除 `p4deck-fixture-e2e` Client 与独立 Workspace Root。
- Runner Context 显式携带 executable/server/user/client/tickets/trust，测试内部复验 `ServerID=p4deck-fixture-local` 和 loopback 地址；启动器隔离 P4CONFIG/P4ENVIRO/P4PASSWD，缺少固定工具时输出明确 `SKIP`。
- 已验证强类型连接、Workspace/Depot 浏览、Sync、Edit、Add、Delete、Revert；同一入口现已叠加 BE-004a Pending 验收。仍未包含 Submit、Shelf/Unshelve 写入、SSL Trust、SSO/MFA 或 macOS，分别留给 BE-003/004b、连接兼容矩阵和双平台验收。

### BE-003 — Submit 预检与执行状态机（READY）

目标：完成安全可解释的 Submit 后端闭环。

范围：

- 建立 `SubmitPreflight` 领域模型，检查空描述、空 CL、unresolved、out-of-date、锁/独占打开、权限及必要的 Shelf/Job 约束。
- 预检返回结构化 blocker/warning，不返回让前端自行判断的原始文本。
- 执行时绑定预检版本、Connection/Workspace 和 CL，防止确认期间上下文或内容变化导致误提交。
- 支持进度、取消、失败分类、部分失败后的刷新建议和 operation/log 关联。
- Submit 必须保持单 CL 单命令；默认不擅自启用并行。

验收：Fixture 覆盖成功提交、unresolved、out-of-date、空描述、无权限/模拟失败和过期预检。

### BE-004a — Pending CL 数据正确性与基础写操作（DONE：Windows localhost）

目标：先让 Pending 数据可信，并提供不依赖前端拼命令的安全基础写契约。

范围：

- `query_pending_changes` 已从 IPC 临时拼装迁入 Changelist Repository/Application Service；IPC 仅转发参数和结果。
- 查询仅返回当前 Connection 的当前 User + Client，正确区分 Default 与编号 CL，并返回 Description、Jobs、opened files、shelved files；shelved file 未知的 Workspace state 保持缺省。
- 新增未接 UI 的 `mutate_pending_change` 强类型契约：创建、编辑 Description/Jobs、删除真正空（无 opened/shelf/Jobs）的编号 CL、Default ↔ 编号 CL 文件移动。
- form 对每一行 Description 做缩进，Jobs 限制为单行 token 并在写入前验证存在；规避字段注入和 P4 在 Job 校验失败时“先改 Description、再报错”的部分写入行为。
- 修改继承调用方 operation ID，复用 Runner 的单 Server 串行 mutation、日志与 Journal；移动只失效映射到的本地路径，并只返回受影响 CL 的刷新结果。

验收结果（2026-10-08）：Windows localhost Fixture 覆盖 Default/编号分组、Description/Jobs、opened/shelved 查询、创建/编辑/删除空 CL、Default ↔ 编号移动、多行及特殊字段名文本、缺失 Job 预检失败恢复；默认连续两轮通过并清理 Client/Workspace/CL/Job/测试文件。前端写入口保持未连接。

工程基线说明：本批改动文件均通过 Prettier/rustfmt；全库 `pnpm format:check` 仍只报告批次前已存在的 `src/app/shell/StatusBar.tsx` 与 `src/features/search/SearchPage.tsx`，未在本批顺手改动这两个无关文件。

### BE-004b — Shelf / Unshelve Repository 补全（READY）

目标：在 BE-004a 可信 Pending 快照上补齐 Shelf 写入与 Unshelve 风险预检。

范围：

- Shelve 新建/更新/删除，支持明确文件子集。
- Unshelve 预览返回覆盖、锁、映射、目标 Workspace 和 Resolve 风险；用户确认后再执行。
- 所有修改操作继续复用 operation ID、串行策略、日志和取消边界。

验收：Fixture 覆盖部分 Shelf、更新/删除 Shelf、跨 Workspace Unshelve 风险和失败恢复；本项不包含 Submit。

### BE-005 — 文件状态聚合与缓存失效（DONE：BE-002 组合已验，兼容矩阵待 BE-009）

目标：稳定输出 Opened、Reconcile、Out-of-date、Conflicted 等日常状态，同时减少 P4 Server 请求。

范围：

- 建立独立 status/cache 模块，不把缓存散落在 IPC 或 React 页面。
- 缓存键至少包含 Server/User/Client/路径/查询类型；定义 TTL、最大容量和手动刷新语义。
- 合并相同并发查询，支持 generation/cancel，旧响应不得覆盖新上下文。
- 文件修改、CL 移动、Sync、Revert、Submit 后只失效受影响范围。
- 提供缓存命中、请求合并、耗时和失效原因的诊断指标，不记录敏感内容。

验收：并发去重、连接隔离、过期响应淘汰、容量上限、局部失效和离线旧数据标记均有测试。

## P1：Alpha 质量

### BE-006 — 操作记录、离线与 ticket 状态（DONE：真实离线/过期错误分类待兼容矩阵）

- 建立有上限的操作历史，关联 operation ID、用户动作、结果和脱敏日志。
- 区分离线、服务器不可达、认证过期和命令失败。
- 应用重启后可识别未正常结束的操作，但不得自动重放修改命令。

### BE-007 — 日志策略与诊断导出（DONE：前端入口待接入）

- Warning/Error 自动展开所需事件与偏好接口。
- 按 Server/Workspace/命令/操作 ID 查询，支持分页或游标。
- 导出带清单的脱敏诊断包；限制文件数量和总大小。
- 增加日志保留期、容量和清理策略配置，同时保持硬上限。

### BE-008 — Submitted 详情与可靠合并分类（READY）

- 懒加载 `describe`、`filelog`、integration/Stream 元数据并缓存。
- 多信号给出 normal/reliable/suspected/unknown，保守处理不确定结果。
- 缓存按 Connection 和 Change ID 隔离，支持局部失效与取消。

### BE-009 — 性能与兼容性基准（BLOCKED：需要固定设备/CI）

- 100,000 条 CL/文件/日志数据的解析、传输、缓存和内存基准。
- 验证输出上限、批量 filespec、并发限制和取消后的进程回收。
- 建立 Windows/macOS、Unicode/非 Unicode、代表性 P4 CLI 版本矩阵。
- 评估 `p4 -I` 与 JSON Lines 的兼容性；未通过矩阵前不默认启用。

## P2：后置范围

- Stream 写操作与完整切换编排。
- Branch Mapping、Labels、Jobs 独立工作台。
- P4API 原生绑定 Adapter。首版继续使用官方 `p4` CLI；引入前需完成 ABI、打包、升级和许可证评估。

## 最近完成批次

```text
BE-002 localhost p4d E2E                 DONE（Windows）
BE-005 状态聚合与缓存                  DONE
BE-006 操作记录、离线与 ticket 状态    DONE
BE-007 日志策略与诊断导出              DONE
```

BE-002 与 BE-004a 已在 Windows localhost Fixture 上完成应用层验收；BE-003/004b 保持 READY，Submit 与 Shelf/Unshelve 写入不在本批范围内。

## 总体推荐执行顺序

```text
BE-001 连接与认证
   ↓
BE-002 localhost p4d E2E
   ↓
BE-003 Submit 状态机
   ↓
BE-004a Pending 基础（DONE）→ BE-004b Shelf/Unshelve
   ↓
BE-005 状态聚合与缓存
   ↓
BE-006～008 Alpha 质量
   ↓
BE-009 性能与兼容矩阵
```

连接与认证排第一，因为后续所有真实 Fixture、Workspace 和 Submit 验收都依赖稳定的 Connection 状态与错误分类。缓存排在真实闭环之后，避免先缓存尚未稳定的领域协议。

## 每项任务统一交付要求

1. 先检查共享工作区最新状态，保留其他 Agent 的改动。
2. 领域模型、命令构造、输出解析、应用服务和 IPC 分层；UI 不解析 P4 原始输出。
3. 不开放通用 Shell；所有参数使用数组传递；秘密只走 stdin 并全链路脱敏。
4. 新能力同时提供 Rust 单测和契约测试；真实 P4 行为优先补 Fixture 测试。
5. 完成后执行 `pnpm test`、`pnpm build`、`pnpm check`、`cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`、`git diff --check`。
6. 更新《核心功能实现说明》；PM 状态由 PM 验收后统一调整。
