# P4Deck 后端 TODO

> 负责人：后端 Agent  
> 建立日期：2026-09-29  
> 文档角色：**历史累计实现与验收台账**，不是当前任务队列。
> 当前事实源：先看 [Windows 本机私用 TODO](Windows本机私用TODO.md) 和 [项目状态总览](项目状态总览.md)。截至 2026-10-10，“连接 → Workspace → 文件操作 → Pending/Shelf/Resolve → Submit”及 Search、Stream、Lock/Unlock 已完成约定实现和 Windows localhost 证据；当前后端只需配合最新 Tauri 原生冒烟、本人 Server 连接/认证、安全写入与恢复演练。
> 下文各批次的测试数量、P0/P1 标题和平台缺口均为当时快照。旧数字不得解释为最新门禁，remote/macOS/多版本矩阵也不再是当前 Windows 本机私用阻塞。

## 状态说明

| 状态        | 含义                                     |
| ----------- | ---------------------------------------- |
| IN PROGRESS | 后端 Agent 正在执行                      |
| QUEUED      | 已下发给后端 Agent，等待前一项完成后继续 |
| NEXT        | 后端 Agent 下一项直接领取                |
| READY       | 前置条件已满足，可以顺序执行             |
| BLOCKED     | 依赖产品、前端、设备或外部环境           |
| DONE        | 已实现并通过约定验证                     |

## 当前本机环境与可执行范围

盘点时间：2026-10-09。

| 环境           | 当前状态                                                              | 影响                                                                                   |
| -------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `p4` CLI       | 已安装：2023.1 / Windows x64                                          | 已确认当前命令面与 `-Mj/-x/-b/sync --parallel`可用；真实 Server 行为仍待 E2E           |
| `p4d` Server   | 已就绪                                                                | Windows 原生隔离 Fixture 已安装并在 `127.0.0.1:16661` 完成 Seed/停止/重启验收          |
| P4 连接变量    | Windows P4 注册表已有连接与凭据相关配置，仓库内无 `.p4config`         | 自动化测试不得回退到用户真实 Server 上下文                                             |
| Node.js / pnpm | Node 24、pnpm 11，已调整为项目基线                                    | 前端测试、Mock、构建和类型检查可运行                                                   |
| Rust           | Rust 1.97.1、Cargo、rustfmt 和 Clippy 已安装；MSVC/Windows SDK 已就绪 | Common Controls v6 manifest 已覆盖 libtest；Pending CL 单测与 localhost E2E 可真实启动 |
| Fixture 脚本   | Windows/macOS 均已存在                                                | Windows 版使用项目内已校验的 P4/P4D 2026.1；Bash 版仍保持显式下载授权                  |

当前可以完整执行：浏览器 Mock、前端构建、TypeScript 检查、前端单测、`cargo test`、`cargo check`、Clippy、Tauri debug 应用构建，以及 Windows localhost 应用层 E2E。Windows libtest 现通过链接器 manifest input 获得 Common Controls v6 依赖，不再以 `0xc0000139 / STATUS_ENTRYPOINT_NOT_FOUND` 退出。

当前已具备真实 Server 验收环境；BE-002R、BE-003、BE-004a、BE-004b、BE-008 已分别完成单文件 Rename/Move、Submit、Pending、Shelf/Unshelve/Resolve 与 Submitted 详情/可靠合并分类。BE-008Q 已完成 Submitted 组合查询和稳定游标。BE-008G 已完成全局搜索生产后端及 `SearchPage` 前端接线。BE-010 已完成基础 Stream 切换；BE-011 已完成文件 Lock/Unlock 与 `+l` 独占状态的强类型安全闭环和 Windows localhost 双用户/双 Client 验收；原生 UI 仍待验收。

### BE-012 — 文本三方手工合并（DONE：Windows localhost；原生 UI/macOS 待验）

- `open/validate/confirm save/confirm resolve` 窄协议绑定 active profile、完整 Context/generation、Workspace/depot/local path、官方 resolve base/source revision、resolve record、size/mtime/SHA-256、encoding/BOM 与结果 digest。`resolve -n -o` tagged 字段和 `p4 print -o` 是权威来源，不猜 have/head。
- binary/symlink/delete/move/缺基线/不可识别编码/4 MiB 或 100,000 行超限/Workspace 越界明确阻断并降级既有 Resolve 选择。正文只在 IPC 与短期内存存在，不写 Log/Journal/通知/本地持久化。
- save token 一次消费；mutation lane 内完整 TOCTOU 复核后，以同目录临时文件 + fsync + 平台原子 replace 写入，留下唯一可恢复 backup。LocalFile Journal 只记录 operation 元数据。保存不自动 resolve；独立一次性 token + 明确确认后执行 `resolve -ay` 并复核 unresolved。
- 成功或未知结果精确触发 Workspace/Pending/Search/Review/Resolve 失效；连接切换清除会话/token，operation group 取消覆盖所有 P4 子命令与最终提交边界。generic GUI `run_p4 resolve` 仍被危险命令策略阻断，未增加 Terminal/外部工具旁路。
- Rust/Web/Windows localhost 覆盖矩阵与未验范围见《手工文本三方合并工作流》；不包含图形/二进制 merge 插件、外部 mergetool 配置、Stream Graph 或管理员能力。

BE-002 的 Windows localhost 基线已完成；BE-009b 的本机合成数据性能基准已经建立并通过，BE-009 多版本、双平台、Unicode/non-Unicode、Proxy/Broker 与 SSL 兼容矩阵仍需外部环境。

## 已完成

| ID      | 事项                                    | 验收结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BE-000  | P4 文件 Action 与批量执行骨架           | 强类型 Action、参数校验、`-b 128 -x -`、受控并行、进度/取消及单测已落地                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| BE-000A | 安全本地路径操作                        | Reveal/Open With 已通过强类型 IPC 接入；限制在 Workspace Root 内，不开放任意 Shell/进程；构建与检查恢复通过                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| BE-001  | 连接与认证服务                          | Context/Adapter/Application Service/IPC 已分层；CLI 发现、强类型状态、info/login status/trust/login/logout、安全 stdin、错误分类和脱敏测试已完成；BE-002 已验 localhost info/ticket，SSL/SSO 仍待专项验收                                                                                                                                                                                                                                                                                                                                                                                       |
| BE-001M | 多连接配置与活动 Workspace 切换         | `connection.json` schema v2、profile CRUD/list/get/set active、revision CAS、原子 replace、旧裸 Context allowlist 备份迁移与结构化错误已完成；切换先复核 info/login 再原子提交，失败保留旧活动项；generation、Runner cancel、Submitted/Search/status cache 与确认 token 全部失效；Windows localhost 双 Client 默认两轮通过                                                                                                                                                                                                                                                                      |
| BE-002  | localhost p4d 集成测试基线              | `scripts/test-p4d-e2e.ps1` 固定 `127.0.0.1:16661`、独立凭据文件与测试 Client；应用服务/Repository 覆盖连接、Workspace/Depot、Sync/Edit/Add/Delete/Revert，默认连续运行两次并清理                                                                                                                                                                                                                                                                                                                                                                                                                |
| BE-002S | Sync 安全生产闭环                       | 强类型 preview/confirm/result、真实 `p4 sync -n` 分类、一次性短期 token、连接 generation/规范范围/typed revision/force/options/preview digest 绑定、mutation lane 内复核、取消/超时、Journal/Log 与局部缓存失效已完成；GUI 直接 Sync 旁路已封死；Windows localhost 双轮通过，原生 UI/macOS 待验                                                                                                                                                                                                                                                                                                 |
| BE-002R | 单文件 Rename/Move 安全生产闭环         | 强类型 preflight/confirm/result、同 Workspace 映射与目标不存在复核、opened 状态/目标 CL/generation/profile/preview digest 一次性绑定、mutation lane 内真实 `p4 move`、Journal/Log/取消/缓存刷新已完成；泛化 `renameMove` 旁路已移除；目录、跨 Workspace、覆盖和 Windows 仅大小写改名明确阻止；localhost E2E 通过，原生 UI/macOS 待验                                                                                                                                                                                                                                                            |
| BE-003  | Submit 预检与执行状态机                 | 强类型预检/确认/结果、一次性短期 token、Connection generation 与 CL/文件状态摘要绑定、mutation lane 原子复核、结构化失败/刷新建议及 Journal/Log 关联已完成；Windows localhost Fixture 已通过；前端统一生产入口已接线并有状态机测试，原生 UI 待验收                                                                                                                                                                                                                                                                                                                                              |
| BE-004a | Pending CL 数据正确性与基础写操作       | 查询按当前 User/Client 严格限定；Default 独立固定返回，numbered CL 使用绑定 query/connection/双 generation/snapshot 的稳定 cursor；首次扫描上限为 500 CL、100,000 opened 记录并返回 partial/truncated/stats。创建、编辑、删除及 Submit/Shelf/Unshelve/Move 会废弃旧 cursor 链；Default ↔ 编号移动继续使用独立预检/确认 token、逐文件 `reopen` 与最终归属复核。浏览器、Rust 与 Windows localhost 新分页路径连续两轮通过，原生 UI 待验收 |
| BE-004b | Shelf / Unshelve / Resolve 真实后端闭环 | 强类型预检/确认、共享一次性 token、显式文件子集、跨 Workspace/CL 风险、逐文件 Resolve 与局部刷新已完成；新增独立 Shelf 详情稳定分页和文本内容预览，binary/symlink/delete/过大内容只返回元数据；Windows localhost 连续两轮 E2E 与前端生产接线通过，原生 UI 待验收 |
| BE-005  | 文件状态聚合与缓存失效                  | `fstat/opened/resolve -n/reconcile -n/ignores -v` 与单层本地目录合并为强类型状态；未知不冒充 untracked，忽略规则带来源；15 秒 TTL、512 条/16 MiB 双上限、并发合并、分组取消、generation、stale/offline、局部失效、10,000 项上限和安全诊断已完成；Windows localhost 已验                                                                                                                                                                                                                                                                                                                         |
| BE-006  | 操作记录、离线与 ticket 状态            | Operation Journal、2,000 条硬上限、当前连接隔离、游标分页及状态/类型/时间/文本服务端筛选、结构化终态、崩溃恢复和不可重放边界已完成；前端已接入                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| BE-007  | 日志策略与诊断导出                      | 稳定分页及级别/来源/Server/Workspace/命令/operation/关键词过滤、策略硬上限、diagnostic-alert、受控 128 KiB 脱敏 JSON 导出已完成；前端已接入                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| BE-007S | 凭据泄漏边界加固                        | 统一 credential policy/redaction pipeline 已覆盖 generic Runner 输入/环境、stdout/stderr/JSON、事件、结果、Terminal 历史/输出、LogStore 内存/SQLite、Journal、诊断导出和错误；认证/票据/配置命令 spawn 前拒绝，受控认证 API 保留；旧日志启动事务清洗与读侧兜底已完成。Rust sentinel 链路、阻止前不启动、前端恢复入口与 localhost 默认双轮作为验收门禁。 |
| BE-008  | Submitted 详情与可靠合并分类            | 强类型只读详情契约、按需 describe/有界 filelog、保守四态分类、Connection generation 缓存隔离、取消/超时与 Windows localhost 连续两轮普通/真实 integrate 验证已完成；前端按需详情、摘要升级、仅隐藏 reliable 和文件虚拟化已接线，原生 UI 待验收                                                                                                                                                                                                                                                                                                                                                  |
| BE-008Q | Submitted 组合查询与稳定游标            | 强类型关键词/User/Client/depot path/Stream/time/Job/hasJob/merge 四态契约；1～500 页大小；版本化 keyset cursor 绑定完整 query、connection identity 与 generation；`changes`/`fixes`/批量 `describe` 下推与 5,000 条硬上限；查询缓存防旧连接回写；Windows localhost 连续两轮覆盖插入期间多页稳定性、组合过滤、非法 cursor、取消及代次隔离。前端完整筛选、继续加载与保存过滤器已接线，原生 UI 待验收                                                                                                                                                                                              |
| BE-008G | 全局搜索生产后端                        | Submitted/Pending CL、Workspace/Depot 文件与 Job 五类窄契约；结果分组、稳定 identity、导航 target、匹配字段与 UTF-16 高亮、facet/stats/partial；首次有界采集后使用版本化不可变快照游标，绑定规范化 query、类别、完整 connection identity 与 generation；P4 参数数组执行，每类最多扫描 1,000 条，Submitted 复用 BE-008Q 的 5,000 扫描/500 结果上限；Windows localhost 连续两轮覆盖五类组合、Unicode/特殊字符、稳定分页、取消、非法/错配 cursor、代次隔离与 partial 上限。Mock 明确 `simulated=true` 且不联网；`SearchPage` 已完成生产接线与浏览器自动化。Stream/Shelf 本批不纳入，原生 UI 待验收 |
| BE-010  | 基础 Stream 切换安全闭环                | 强类型 preflight/confirm/result、一次性短期 token、完整 profile/connection/workspace/generation/spec/risk digest 绑定、mutation lane 内 TOCTOU 复检、非 force `client -s -S`、默认不改文件、显式可选非 force `sync #head`、最终 Client spec 验证、结构化恢复和缓存/generation 失效已完成；GUI 通用写旁路已封死；Windows localhost 双 Stream 默认双轮通过，原生 UI/macOS 待验 |
| BE-011  | 文件 Lock/Unlock 与独占打开安全闭环     | `preflight_file_lock` / `confirm_file_lock` 绑定完整文件集合、映射、opened action、CL、filetype、权限、锁 owner、profile/context generation 与 digest；mutation lane 内逐文件执行并以 tagged `fstat -Ol` 复核，不自动回滚、不提供 force unlock；Workspace/Pending 聚合我方/他方锁、owner、other-open 与 `+l`。泛化 FileAction、Terminal 和 `run_p4` 旁路已关闭；Windows localhost 双用户/双 Client 覆盖冲突、解锁、独占、重放、generation/TOCTOU，原生 UI/macOS 待验。 |

## 历史 P0 实施记录（以下条目按自身状态判断，不是当前任务队列）

### BE-005R — Diff / File History / Revision Graph 生产闭环（DONE：Windows localhost，原生 UI/macOS 待验）

- 只读文件审查统一使用 `FileReviewScope`，绑定 Server/User/Client/Workspace、活动 Profile、Context generation 与文件 identity；Diff 使用 `Workspace / Have / Head / Revision / Shelf(changeId)` 强类型引用。当前产品入口仍只比较同一 depot path 的两侧；Shelf 由独立变体和权威 `@=change` 读取接入，不用字符串假装支持任意 CL 或两条不同 depot path。
- Diff 先以结构化 `fstat` / `filelog -t` 确认 depot/local 映射、修订、filetype、size 和 digest，再以参数数组 `p4 print -q <escaped filespec#rev>` 读取允许的 depot 文本；Workspace 只读取映射到当前 Client 的受控本地路径。P4 literal filespec 对 `%/@/#/*` 进行转义；不经过 Shell。
- 文本 Diff 限制单侧 4 MiB、100,000 行、输出 8 MiB，返回稳定 unified hunk、增删/hunk 统计及 identical/truncated/partial；UTF-8/BOM 与 BOM UTF-16 有明确解码，保留换行差异。binary/symlink 不进入文本渲染，返回两侧 type/size/digest/existence 和原因。缺少 Have/Workspace 作为空侧参与 Diff；未映射或不可见文件返回结构化可解释错误。
- File History 使用真实 `filelog -l -t`，返回 revision/change/action/type/time/user/description/digest/fileSize/integrations；1～500 页大小、opaque cursor 绑定完整 scope 和文件，游标错配、generation 漂移会拒绝。
- Revision Graph 使用 `filelog -i -l -t` 的 `how/file/srev/erev` 建模真实 branch/copy/merge/move/add/delete/edit 边；同路径 revision edge 与 integration edge 分离，重复边去重，缺失引用以 `missing` 节点呈现。按 100 revision 增量展开，最多 2,000 revision；`partial/truncated` 不包装成完整图。
- 三类结果使用 30 秒、128 项有界缓存；key 包含 profile/context generation/file identity/selectors/cursor，文件写操作清空，显式 Refresh 绕过。Runner 根 operation group 现覆盖当前子命令、后续子命令和最终 cache commit；取消与 generation/scope 漂移均在返回及写缓存前复核，取消响应不缓存。其余继续复用超时、64 MiB 进程输出保护、Log 与 Operation Journal。
- Rust 单测覆盖空/相同/增删文本、binary/symlink/filetype、UTF-8/UTF-16、special filespec、cursor scope/generation、缓存 TTL/容量、integration edge/重复边/缺失节点及 operation group 跨子命令取消；前端 delayed-promise 组件/模型测试覆盖 A→B 晚返回、连续 node Diff、分页后换 path、profile generation drift、卸载取消、取消后新请求成功、旧错误晚到、重复 cursor、Graph 合并去重与 History/Diff selector 切换。Windows localhost 连续两轮覆盖正常 Graph/History/Diff、真实 review operation cancel、generation drift，以及原有边界矩阵；macOS 与原生窗口未验收。

### BE-001M — 多连接配置与活动 Workspace 切换（DONE：后端与 Windows localhost）

- profile 只包装现有非敏感 `P4Context`，ID 使用 UUID v4；名称和完整 context 均禁止重复，空值、控制字符、过长字段、并发 revision 冲突和删除活动/最后一项返回结构化错误。
- schema v2 使用同目录随机临时文件、flush/sync 与原子 replace；旧裸 Context 迁移前把 allowlist 非敏感字段写入 `connection.json.legacy.bak`，不会把历史未知 password/fingerprint 复制进备份。损坏、未知版本、不同旧备份或写入失败均保留原文件与内存活动状态。
- `set_active_connection_profile` 与 `switch_workspace` 在异步验证期间不修改活动状态；`p4 info` 和 `p4 login -s` 均成功后，才以 expected revision/generation 原子提交。保存 Context 仍只产生 `notTested`，Trust/Ticket/密码继续由 P4 外部机制与既有窄接口管理。
- 提交切换后递增 context generation，取消全部 Runner 操作，清除 Submitted detail/query、Global Search snapshot、status cache 及 Submit/Workflow token；前端 `connectionKey` 同步清理 Files/Pending/Submitted/Search/Log/Journal 视图，旧响应继续由 generation 复核拒绝。
- Windows localhost 默认两轮创建第二 Client/Root，覆盖 profile CRUD、同 Server 不同 Client 活动切换、不可执行 CLI 失败回滚、Workspace Client+Root 真切换及 stale generation。未启动第二隔离 `p4d`，成功 Server 切换留作兼容矩阵；结构化失败回滚已有覆盖。
- 前端边界：Workspace 详情已有最小切换入口；完整设置页 profile 管理与活动连接切换 UI 仍由前端任务接线，不能把后端 DONE 记为完整用户流程 DONE。

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
- 已验证强类型连接、Workspace/Depot 浏览、Sync、Edit、Add、Delete、Revert；Sync 已覆盖新增/更新/删除/指定 revision、已最新、writable/clobber blocker、force 二次确认、非法 spec、token 重放/过期/篡改、generation 漂移、Journal 与缓存刷新；同一入口已叠加 BE-003 Submit、BE-004a Pending 与 BE-004b Shelf/Unshelve/Resolve 验收。仍未包含 SSL Trust、SSO/MFA 或 macOS，留给连接兼容矩阵和双平台验收。
- 同一入口也覆盖 BE-002R：真实单文件 move、目标已存在、source 未 opened、映射外、Windows 仅大小写 blocker、token 重放/过期及 generation drift；成功后 revert 并复核 fixture 恢复。仍未包含目录递归、覆盖、跨 Workspace、macOS 或原生 UI，均不作完成声明。

### BE-002R — 单文件 Rename/Move 安全生产闭环（DONE：Windows localhost）

- 仅接受当前 Workspace view 内的单个本地受控文件；source 必须存在且 `edit/add` opened，目标必须映射到同一 Client、位于 Workspace Root 内且本地/Depot 均不存在。目标 CL 仅允许 Default 或当前 User/Client 拥有的既有 Pending 编号 CL。
- `RenameMovePreflight` 返回 source/target 的 depot/client/local 映射、opened action/CL、目标 CL 有效性、存在性、case-only 风险、结构化 blocker、operation/log 引用和 120 秒一次性 token。token 绑定 active profile、Context generation、完整映射、source state、目标 CL 与 preview digest。
- `confirmRenameMove` 消费 token 后进入同 Server mutation lane，重查全部状态并拒绝重放、过期、上下文/映射/opened/目标/CL 漂移；只使用参数数组执行一条 `p4 move -c <CL> <source> <target>`。GUI `run_p4 move` 和泛化 `FileAction::RenameMove` 旁路已关闭，显式 Terminal 语义不变。
- Windows 仅大小写改名本批不冒险模拟普通 move：由于尚无经过验证的临时名两步事务及完整回滚，预检固定返回 `caseOnlyRename` blocker。目录递归、跨 Workspace、目标覆盖、自动创建父目录及含 `@`、`#`、`%`、`*`、`?` 的 P4 filespec 路径同样不在本批范围。
- 单文件命令没有可报告的部分成功集合；非零退出返回 `failed`，取消返回 `cancelled`，超时返回 `unknown`，均携带 source/target、Pending 与 Workspace 的保守刷新建议。Runner 继续负责取消、结构化日志和 Operation Journal，成功/失败后均失效两端文件状态缓存。

### BE-003 — Submit 预检与执行状态机（DONE：Windows localhost）

目标：完成安全可解释的 Submit 后端闭环。

范围：

- 建立 `SubmitPreflight` 领域模型，检查空描述、空 CL、unresolved、out-of-date、锁/独占打开、权限及必要的 Shelf/Job 约束。
- 预检返回结构化 blocker/warning，不返回让前端自行判断的原始文本。
- 执行时绑定预检版本、Connection/Workspace 和 CL，防止确认期间上下文或内容变化导致误提交。
- 支持进度、取消、失败分类、部分失败后的刷新建议和 operation/log 关联。
- Submit 必须保持单 CL 单命令；默认不擅自启用并行。

实现结果（2026-10-08）：

- `SubmitPreflight` / `SubmitConfirmation` / `SubmitResult` 已作为 Rust/TypeScript 双向强类型契约落地；blocker、warning、目标快照、文件摘要、TTL、operation/log 关联与刷新建议均为结构化字段，前端不需要解析 stderr。
- 预检检查空描述、空 CL、unresolved、out-of-date、锁/独占打开、`protects -M` 写权限、Shelf 与 Job；无法可靠得知的文件/权限/Job trigger 策略明确返回 `unknown` warning。
- 一次性 token 绑定 Server/User/Client/Workspace、Context generation、CL Description/Jobs/Shelf、文件集合及 fstat/权限快照；确认阶段占用同 Server mutation lane，复核后只执行一条 `p4 submit -c <change>`，过期、目标不符、连接/Workspace 切换和 CL 内容变化均拒绝。
- Submit 结果只返回结构化 outcome/failure/message/refresh；进度与取消复用 Runner，Journal 分类为 `submit`，Log 继续脱敏。失败或不确定结果要求刷新 Pending/Submitted/Workspace。
- 已删除 `FileAction::Submit` 及 TypeScript 泛化 FileAction 的 `"submit"`，Mock 和通用 GUI `run_p4` 也拒绝 submit；终端来源仍保持用户显式 P4 会话语义。
- Windows localhost Fixture 使用独立 writer/read-only Client、专属 `//depot/p4deck-submit-e2e/...` 路径与临时保护表，覆盖成功提交、空描述、空 CL、unresolved、out-of-date、权限拒绝、过期 token、目标/Workspace/CL 内容变化拒绝；失败路径恢复保护表并清理 Client/User/Workspace/CL/专属 depot 数据。前端 SubmitDialog 已接统一生产入口，原生 UI 流程仍待验收。

验收：`pnpm test:e2e:p4d:win` 默认连续两轮通过后方可视为本机 DONE；macOS/多版本仍属于 BE-009 兼容矩阵。

### BE-004a — Pending CL 数据正确性与基础写操作（DONE：Windows localhost）

目标：先让 Pending 数据可信，并提供不依赖前端拼命令的安全基础写契约。

范围：

- `query_pending_changes` 已从 IPC 临时拼装迁入 Changelist Repository/Application Service；IPC 仅转发参数和结果。
- 查询仅返回当前 Connection 的当前 User + Client，正确区分 Default 与编号 CL，并返回 Description、Jobs、opened files、shelved files；shelved file 未知的 Workspace state 保持缺省。
- `query_pending_changes` 接收 `operationId/requestGeneration/keyword/sort/pageSize/cursor`；Default 不进入 numbered offset。snapshot cache 为 60 秒/32 项，cursor 绑定规范化 query、完整连接 identity、connection generation、pending generation 和随机 snapshot ID，并要求 cursor 在服务端签发集合中存在；同一 cursor 可安全重试同一不可变页。
- `changes/opened/shelved` 初次采集使用参数数组硬上限；当前 numbered CL 500、opened 100,000。任一上限触发时 `partial=true`、`truncatedBySafetyLimit=true`，不得用无限重试掩盖截断。
- `mutate_pending_change` 强类型契约负责创建、编辑 Description/Jobs、删除真正空（无 opened/shelf/Jobs）的编号 CL；Edit 会从写前权威快照回填 `Files:`，不会把已移动文件意外放回 Default。Default ↔ 编号 CL 文件移动已拆为 `preflight_move_files` → `confirm_move_files`；旧 MoveFiles IPC、泛化 ClAction/FileAction 与 GUI `run_p4 reopen` 旁路明确拒绝。
- form 对每一行 Description 做缩进，Jobs 限制为单行 token 并在写入前验证存在；规避字段注入和 P4 在 Job 校验失败时“先改 Description、再报错”的部分写入行为。
- 修改继承调用方 operation ID，复用 Runner 的单 Server 串行 mutation、日志与 Journal。MoveFiles 预检固定 Server/User/Client/Workspace/generation、来源/目标 CL、文件集合与 opened/lock 摘要；确认复核后逐文件执行 `p4 reopen -c`，支持取消并返回逐项成功/失败与最终归属，只失效映射到的本地路径并刷新来源/目标 CL。

验收结果（2026-10-09）：Windows localhost Fixture 覆盖 Default/编号分组、Description/Jobs、opened/shelved 查询、创建/编辑/删除空 CL、Default + 多页 numbered 稳定分页、跨页去重、创建/删除后的 cursor generation 失效、Default ↔ 编号强类型移动及最终归属、特殊字符文件、多行及特殊字段名文本、缺失 Job 预检失败恢复；默认连续两轮通过并清理 Client/Workspace/CL/Job/测试文件。前端菜单、键盘与拖放入口已统一接线，原生 UI 待验收。

工程基线说明：本批改动文件均通过 Prettier/rustfmt；全库 `pnpm format:check` 仍只报告批次前已存在的 `src/app/shell/StatusBar.tsx` 与 `src/features/search/SearchPage.tsx`，未在本批顺手改动这两个无关文件。

### BE-004b — Shelf / Unshelve / Resolve 真实闭环（DONE：前端生产接线另行验收）

目标：在 BE-004a 可信 Pending 快照上补齐 Shelf 写入与 Unshelve 风险预检。

范围：

- Shelf 新建、选中文件覆盖更新与选中文件删除均使用显式 filespec；覆盖子集使用 `-f`，不使用会替换整架 Shelf 的 `-r`。
- Unshelve 强类型预检返回来源 Shelf、目标 Workspace/Default 或编号 CL、映射、本地修改、已有打开、锁、权限与 Resolve 风险；默认不传 `-f`，用户确认后才执行。
- Resolve 返回真实 unresolved 状态、预览/来源信息与逐文件 `safe`、`acceptYours`、`acceptTheirs`、`mergePreview` 能力；`mergePreview` 不可作为修改确认，未知或执行后仍 unresolved 保持 blocked/unknown。
- Shelf、Unshelve、Resolve 与 Submit 共用一次性内存 token 基础设施：默认 120 秒、绑定 Connection/Workspace/context generation/CL/文件集合/内容摘要，在同 Server mutation lane 内复核后执行。
- 所有执行关联 operation ID、Journal、脱敏 Log、进度/取消与局部缓存失效；失败、取消、部分成功和不确定结果均返回结构化刷新建议。
- 已移除泛化 `ClAction` 的 MoveFiles/shelve/unshelve 变体；FileAction 与 GUI `run_p4` 明确拒绝 reopen/shelve/unshelve/resolve，显式 Terminal 语义不变。
- `get_shelf_detail` 不再接受原始 offset：首屏冻结服务端快照，后续只接受后端签发的一次性 opaque cursor。cursor 绑定 active profile、完整 Connection、context generation、Shelf mutation generation、change 与 page size，并由快照内 cursor ID→offset 映射拒绝伪造、边界篡改和重放；错查询/错连接/代次漂移/过期分别返回结构化 `invalidCursor`、`connectionChanged`、`snapshotChanged`、`cursorExpired`。30 秒内首屏可复用缓存，分页快照最多保留 120 秒/32 份；显式刷新和 Shelf/Pending mutation 清空快照并推进代次。Default 明确拒绝，1～500 page size 与 10,000 文件硬上限保持不变。
- `get_shelf_file_preview` 使用 `fstat -Rs -e` 判定 action/filetype/size/digest，仅文本调用 `p4 print -q depot@=change`；binary、symlink、delete/missing 与超过 4 MiB 的内容不按文本解码，返回明确元数据原因。`RevisionReference::Shelf { changeId }` 同时接入 Diff 读取。

验收结果（2026-10-09）：Windows localhost Fixture 默认连续两轮通过（77.40 秒、77.45 秒），覆盖部分文件首次 Shelf、选中文件覆盖更新、子集删除、Shelf 详情两页 cursor、重放拒绝、真实文本预览、二进制元数据语义、TTL 与本地/来源内容漂移拒绝、Unshelve 到 Default/编号 CL、跨 Workspace、映射失败、本地覆盖阻断、锁、权限拒绝、需要 Resolve、真实 Resolve 成功与不可解决/未知保持阻断，并清理临时 Client/Root/CL/Shelf 与专属 `//depot/p4deck-workflow-e2e/...` 数据；不修改 Fixture seed 或用户配置。独立 Shelf 页已接生产入口及 Rust `shelf` 窗口白名单；原生点击、焦点、读屏仍待验收。

### BE-005 — 文件状态聚合与缓存失效（DONE：Windows localhost 已验，兼容矩阵待 BE-009）

目标：稳定输出 Opened、Reconcile、Out-of-date、Conflicted 等日常状态，同时减少 P4 Server 请求。

范围：

- 建立独立 status/cache 模块，不把缓存散落在 IPC 或 React 页面。
- 缓存键至少包含 Server/User/Client/路径/查询类型；定义 TTL、最大容量和手动刷新语义。
- 合并相同并发查询，支持 generation/cancel，旧响应不得覆盖新上下文。
- 文件修改、CL 移动、Sync、Revert、Submit 后只失效受影响范围。
- 提供缓存命中、请求合并、耗时和失效原因的诊断指标，不记录敏感内容。
- Workspace 查询只扫描当前目录一层，并以转义后的 `//client/path/*` 查询服务器；符号链接/Windows reparse point 不下钻，返回条目硬上限为 10,000。
- 一次查询聚合 `fstat -Op -Or`、`opened`、`resolve -n -N`、`reconcile -n -e -a -d -f -l` 与分批 `ignores -v -i`。Reconcile 全程 preview，不改变 opened 集合；特殊字符路径作为参数数组传递并转义 P4 filespec。
- 强类型结果保留 `openedAction`、`reconcileAction`、`sync`、`resolve`、`local`、mapping、move 对端、ignore 来源及 evidence；主状态只用于排序/旧 UI 兼容。优先级为 unresolved/conflicted → 显式 opened action → reconcile edit/delete/add → sync 落后/未同步 → controlled/unknown。缺少权威 P4 证据必须是 `unknown + partial`，不得默认 untracked。
- 任一子命令失败时保留其余可信证据，在 `WorkspaceListing` 返回查询级错误与 partial；缓存回退明确标为 stale/offline。文件节点不复制整份查询错误，避免大目录内存按条目数放大。
- 前端 Query 使用连接隔离 key，共享并发请求；AbortSignal 取消 operation 前缀下全部子命令。普通重复查询命中后端缓存，手动刷新先失效对应目录再查询。

验收：Rust 覆盖结构化/旧版 reconcile、部分失败证据保留、Unicode ignore provenance、filespec 转义、单层扫描/硬上限与缓存边界；前端覆盖并发去重、连接隔离、明确刷新和取消分组。Windows localhost 覆盖 clean、未打开修改、missing、Unicode/空格/`@#%` 未跟踪、ignore 规则来源、缓存命中、mutation 失效、mapping 外 unknown/partial、move/delete/out-of-date 与真实 unresolved；入口默认连续两轮并清理隔离数据。

## P1：Alpha 质量

### BE-011 — 文件 Lock/Unlock 与 `+l` 独占打开（DONE：Windows localhost，原生 UI/macOS 待验）

- 只接受 1～512 个显式非递归文件；预检以 `where`、`fstat -Ol` 和 `protects -M` 获取映射、opened action、Default/编号 CL、filetype、我方/他方锁、`user@client` owner、other-open 与权限。目录、未打开、映射外、权限拒绝、他人锁和未知状态均为结构化 blocker；already locked/not locked 明确显示而不伪造操作。
- 一次性 120 秒 token 绑定活动 Profile、Server/User/Client/Root、Context generation、操作类型、排序后的完整文件快照与 SHA-256 digest。确认消费 token 后进入同 Server mutation lane，完整重查并拒绝错绑、重放、过期、generation、映射、opened/CL、filetype、权限和 owner 漂移。
- 执行只调用逐文件参数数组 `p4 lock` / `p4 unlock`；路径按 literal filespec 转义，大集合状态查询使用 `-x -`。每个文件返回 succeeded/alreadySatisfied/failed/cancelled/unknown，部分成功不自动回滚；最终仅以 tagged `fstat -Ol` 复核，超时或不可验证结果要求刷新后人工重试。管理员 force unlock 不在产品范围。
- Workspace 与 Pending 状态聚合显示我方锁、他方锁 owner、other-open、filetype 与 `+l`；成功或不确定结果失效 Workspace/Pending/Search/Review 相关缓存。通用 `FileAction::Lock/Unlock`、Terminal 与 generic `run_p4 lock/unlock` 均在执行前拒绝，所有 GUI 入口统一进入预检对话框。
- Windows localhost 隔离数据覆盖两个真实 User/Client、普通文件双方打开后的 lock conflict/owner、lock→unlock、`binary+l` 第二 Client 无法打开、一次性 token 重放、Context generation 与 owner TOCTOU 漂移；失败也清理 User/Client/Root 和专属 depot 路径。Windows/macOS 原生点击、真实读屏、macOS 和多 P4 版本矩阵仍未验收。
- 验收：2026-10-09 Windows localhost 默认连续两轮通过（135.59 秒、134.97 秒）；全量 Web 73 文件/417 项、Rust 144 项通过（另 1 项 localhost E2E 默认 ignored），生产构建、TypeScript/Cargo check、Clippy `--all-targets -D warnings`、Prettier、rustfmt 与前后端性能正确性门禁通过。

### BE-010 — 基础 Stream 切换安全闭环（DONE：Windows localhost，原生 UI/macOS 待验）

- 入口：Streams 页通过 `preflight_stream_switch` → `confirm_stream_switch`；GUI 通用 `run_p4` 明确拒绝 `client/stream/switch` 写命令，Terminal 语义不变。
- 预检：权威读取连接、Client/Stream spec、protects、opened、resolve preview、reconcile preview 与 sizes；打开文件、未解决文件、无 Root、owner 不匹配、不可见/不支持目标会阻断。同步模式下本地变化阻断；仅切视图模式下本地变化作为必须确认的警告。
- 绑定：一次性 120 秒 token 绑定 active profile、Server/User/Client/Root、Context generation、源/目标 Stream、类型/父级、模式、Client/Stream spec digest 和风险 digest；确认在 mutation lane 内完整重查，错绑、重放、过期、generation/spec/文件状态漂移全部拒绝。
- 执行：只使用非 force `p4 client -s -S`。默认不触碰工作区；显式选择同步时，在目标 Stream 验证成功后运行非 force `p4 sync //client/...#head`。取消只停止尚可停止的步骤，不宣称回滚；失败/未知结果返回已验证 Stream、同步是否开始/完成、operation/log 与恢复预检建议。
- 刷新：已确认 Stream 改变时 CAS 推进 generation；IPC 清除 Workspace/Streams/Pending/Submitted/Search/Depot 等依赖缓存和其他确认 token。结果页关闭后前端应用新 runtime，避免验证结果被提前卸载。
- 验收：Windows localhost 固定 fixture 创建 `//p4deck-stream-e2e/main` 与 `dev`、独立 Client/Root，覆盖过期、错绑/重放、generation 漂移、预检后本地 TOCTOU、opened blocker、仅切视图不改文件、同 Stream 恢复同步和同步回切；默认连续两轮分别 115.59 秒、114.50 秒通过，并清理 Client/Root/depot/版本化 Stream spec。
- 非范围：不实现 Stream Graph、Branch Mapping、Stream spec 创建/编辑/删除或管理员能力；不调用高层 `p4 switch`，因为其隐式 reconcile/shelve/revert/unshelve/sync 不符合本批显式副作用边界。

### BE-006 — 操作记录、离线与 ticket 状态（DONE：真实离线/过期错误分类待兼容矩阵）

- 建立有上限的操作历史，关联 operation ID、用户动作、结果和脱敏日志。
- 区分离线、服务器不可达、认证过期和命令失败。
- 应用重启后可识别未正常结束的操作，但不得自动重放修改命令。

### BE-007 — 日志策略与诊断导出（DONE：前端入口已接入，真实故障与原生 UI 待验）

- Warning/Error 自动展开所需事件与偏好接口。
- 按 Server/Workspace/命令/操作 ID 查询，支持分页或游标。
- 导出带清单的脱敏诊断包；限制文件数量和总大小。
- 增加日志保留期、容量和清理策略配置，同时保持硬上限。

### BE-008 — Submitted 详情与可靠合并分类（DONE：前后端已接，原生 UI 待验收）

- 懒加载 `describe`、`filelog`、integration/Stream 元数据并缓存。
- 多信号给出 normal/reliable/suspected/unknown，保守处理不确定结果。
- 缓存按 Connection generation 和 Change ID 隔离，支持 TTL/容量淘汰、连接切换失效与取消。

实现结果：摘要层只能给出 suspected/unknown；详情层仅在 describe action 或对应 revision 的 filelog integration 关系提供明确证据时升级 reliable，完整检查无证据才归 normal，失败/截断保持 unknown 或 suspected。详情缓存绑定 Server/User/Client、Context generation 与 Change ID，采用 60 秒 TTL、256 条 LRU 上限，复用 Runner 的 60 秒超时和 operation ID 取消，并在返回前复核连接代次。Windows localhost 连续两轮验证普通提交、真实 branch 提交、摘要升级与可靠 merge 隐藏。

### BE-009 — 性能与兼容性基准（PARTIAL：BE-009b 本机基准完成；矩阵仍 BLOCKED）

- 100,000 条 CL/文件/日志数据的解析、传输、缓存和内存基准。
- 验证输出上限、批量 filespec、并发限制和取消后的进程回收。
- 建立 Windows/macOS、Unicode/非 Unicode、代表性 P4 CLI 版本矩阵。
- 评估 `p4 -I` 与 JSON Lines 的兼容性；未通过矩阵前不默认启用。

BE-009b 实现结果（2026-10-09）：

- 新增独立 `pnpm test:perf:backend` release 入口，不进入普通 `cargo test`；固定 seed、7 轮 warmup、25 轮测量，产出 `artifacts/performance/backend-latest.json` 与 `.md`。
- 直接复用生产 Submitted/Pending/File JSON parser、domain serde/IPC、StatusCache、cursor/fingerprint 与 Global Search Unicode 过滤/identity 去重；10k/50k/100k serde、100k parser、100k cache hit/cursor/search 及 10k LRU 路径均输出 p50/p95。
- 5 项确定性门禁覆盖条目数/顺序/分类、serde round-trip、TTL/LRU/并发合并/失效、cursor 绑定和 Unicode 去重；项目没有后端数值阈值，时延全部保持信息项。
- 本机实际记录 Windows x64、Rust 1.97.1、P4 2023.1、Fixture P4D 2026.1 与本地 `P4CHARSET=utf8`。未连接 server，不能据此声明 Unicode Server、non-Unicode、macOS、多版本、Proxy/Broker、SSL 或 `p4 -I` 通过。
- RSS 为 case 边界采样，Windows peak working set 为进程级累计近似；本机进程峰值约 164.80 MiB，不是固定设备或单 case 精确峰值。详见《后端性能基准》。

## P2：后置范围

- Stream Graph、Branch Mapping、Stream spec 写入和管理员能力（基础当前 Workspace 切换已由 BE-010 完成）。
- Branch Mapping、Labels、Jobs 独立工作台。
- P4API 原生绑定 Adapter。首版继续使用官方 `p4` CLI；引入前需完成 ABI、打包、升级和许可证评估。

## 最近完成批次

```text
BE-002 localhost p4d E2E                 DONE（Windows）
BE-001M 多连接与活动 Workspace 切换      DONE（Windows localhost）
BE-003 Submit 状态机                    DONE（Windows localhost）
BE-004a Pending 数据与基础写            DONE（Windows localhost）
BE-004b Shelf/Unshelve/Resolve          DONE（Windows localhost；前端已接线）
BE-005 状态聚合与缓存                  DONE
BE-006 操作记录、离线与 ticket 状态    DONE
BE-007 日志策略与诊断导出              DONE
BE-007S 凭据泄漏边界加固               DONE（自动化；原生 UI/macOS 待验）
BE-008 Submitted 详情与可靠合并分类    DONE（Windows localhost；前端已接线）
BE-010 基础 Stream 切换                 DONE（Windows localhost；原生 UI/macOS 待验）
BE-011 文件 Lock/Unlock 与独占打开      DONE（Windows localhost；原生 UI/macOS 待验）
```

BE-002、BE-003、BE-004a、BE-004b 与 BE-008 已在 Windows localhost Fixture 上完成应用层验收；BE-008 前端页面接线已在后续批次完成，原生 UI 证据仍未取得。

## 历史总体实施顺序

```text
BE-001 连接与认证
   ↓
BE-002 localhost p4d E2E
   ↓
BE-003 Submit 状态机
   ↓
BE-004a Pending 基础（DONE）→ BE-004b Shelf/Unshelve/Resolve（DONE，前端已接线）
   ↓
BE-005 状态聚合与缓存
   ↓
BE-006～008 Alpha 质量
   ↓
BE-009 性能与兼容矩阵
```

该顺序解释历史依赖关系。连接与认证曾排第一，因为后续所有真实 Fixture、Workspace 和 Submit 验收都依赖稳定的 Connection 状态与错误分类；这些约定实现现已完成。当前执行顺序改看《Windows 本机私用 TODO》。

## 每项任务统一交付要求

1. 先检查共享工作区最新状态，保留其他 Agent 的改动。
2. 领域模型、命令构造、输出解析、应用服务和 IPC 分层；UI 不解析 P4 原始输出。
3. 不开放通用 Shell；所有参数使用数组传递；秘密只走 stdin 并全链路脱敏。
4. 新能力同时提供 Rust 单测和契约测试；真实 P4 行为优先补 Fixture 测试。
5. 完成后执行 `pnpm test`、`pnpm build`、`pnpm check`、`cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`、`git diff --check`。
6. 更新《核心功能实现说明》；PM 状态由 PM 验收后统一调整。
