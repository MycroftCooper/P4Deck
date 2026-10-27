# Windows 本机私用 TODO

> **唯一权威执行清单 · 2026-10-27 项目级静态盘点。** 本节覆盖下方旧快照的“当前”描述；旧记录仅用于追溯，不是第二套任务队列。后续新增任务、状态与关闭证据只维护本节。
> 审计对象为 `d582a5c` 加当前大量未提交工作树（本轮盘点时 Git 状态 282 条），不是一个可发布提交。未覆盖/回滚他人修改；本轮只读审计及文档编辑，没有启动应用、P4、网络探测或重跑产品测试。未发现根/祖先 AGENTS.md 或仓库 .agents/skills。

## 当前结论与状态口径

日常 P4 功能主体已有代码，不需要从零补 Pending/Submit/Shelf/Resolve/Graph/Search。当前首要问题是**安全验收入口未放行，以及最近 UI/History/Submitted 改动缺运行证据**。最新列表重叠修复、右侧导航和设置/关闭按钮迁移全部仍待运行验收。

- **已实现且有相应验收证据**：仅限标明日期/构建/场景的记录，不保证当前脏工作树全量无回归。
- **已实现待验收**：找到具体代码和契约；测试文件存在、TS/CSS/离线编译通过不等于测试执行或原生验收。
- **部分实现**：限定能力已经落地，仍有明确实现缺口或语义未证。
- **待实现**：明确下一步产出尚未完成；表内会标明是功能还是验收工作，不能把未跑测试说成未写功能。
- **受阻**：必须满足权限/环境/授权前置；不绕过、不盲重试。
- **建议待确认**：历史后置候选或范围扩大，不是用户已批准的新功能。

**安全优先于所有历史步骤**：只允许经证明的项目本地假 P4；公司生产禁止包括只读。旧 WIN-P0-03 及旧路线图中的本人 Server 操作冻结。不得为了收口清空用户 Profile、改全局配置/安全策略、安装 Agent 或禁用全部 QA。历史个人服务器退出条件不强迫当前任务触碰生产。

## 数量汇总（功能/工作包，不是菜单项数或测试数）

共 **41** 项：已实现且有相应验收证据 **2**、已实现待验收 **25**、部分实现 **7**、待实现 **2**、受阻 **3**、建议待确认 **2**。两个完成项独立归档；其余只在下表出现一次。

| 模块 | 总数 | 有证据完成 | 实现待验收 | 部分 | 待实现 | 受阻 | 待确认 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 安全与验收 | 4 | 0 | 0 | 1 | 1 | 2 | 0 |
| 界面与导航 | 4 | 0 | 3 | 1 | 0 | 0 | 0 |
| 连接与工作区 | 3 | 0 | 2 | 1 | 0 | 0 | 0 |
| 文件与版本 | 5 | 0 | 3 | 2 | 0 | 0 | 0 |
| History | 2 | 0 | 2 | 0 | 0 | 0 | 0 |
| CL 工作流 | 4 | 0 | 4 | 0 | 0 | 0 | 0 |
| Submitted 与周报 | 6 | 0 | 5 | 1 | 0 | 0 | 0 |
| 搜索与分支 | 3 | 0 | 3 | 0 | 0 | 0 | 0 |
| 工具与可靠性 | 5 | 2 | 3 | 0 | 0 | 0 | 0 |
| 阶段收口 | 3 | 0 | 0 | 1 | 1 | 1 | 0 |
| 后续候选 | 2 | 0 | 0 | 0 | 0 | 0 | 2 |

## 唯一任务表

证据列为实际源码或既有验收记录入口；旧日期测试只能证明对应旧版本。通用依赖 WIN-P0-02=最新原生 UI 冒烟、WIN-P0-04=隔离核心写入演练，沿用下方原编号及步骤，不重复计数为新功能。

| ID | 模块 / 范围 | 状态 | 优先级 | 证据路径 | 剩余步骤与验收标准 | 依赖 |
|---|---|---|---|---|---|---|
| GRAPH-01 | 文件与版本：聚焦修订图、目标合入证据与来源追溯（用户已批准） | 部分实现 | P1 | [FileReviewPage.tsx](../../src/features/browsers/FileReviewPage.tsx)；[数据缓存与操作架构.md](../Coder/数据缓存与操作架构.md) | 2026-10-27 单文件切片已编码：目标/来源模式、轨道隐藏/Solo、证据范围、共享缓存与并发取消/20次预算；去除默认 filelog -i。TS/CSS/离线cargo check通过，mock测试已写未运行、视觉未验。剩余：目标分支文件映射、整个CL逐文件汇总、内容保留/部分集成精确验证、目标/中转独立续页；当前只报记录路径与未知，不作已合/未合判断 | SAFE-02；QA-01 |
| SAFE-01 | 安全与验收：QA 只允许验证后的本地 fixture | 部分实现 | P0 | [p4d-fixture.ps1](../../scripts/p4d-fixture.ps1)；[context.rs](../../src-tauri/src/p4/context.rs) | 被动门禁已加；QA 持久化 Profile、恢复队列、环境回退仍未完整锁定。补加载/切换前拒绝与纯测试，不能全面禁用 QA 冒充隔离 | 无 |
| SAFE-02 | 安全与验收：运行入口身份与继承配置核验 | 受阻 | P0 | [本地假P4安全核验.md](../../ForAIDoc/Coder/本地假P4安全核验.md) | 用获准诊断证明实际 listener、二进制、root、无转发及凭据隔离；当前缺证，不可先 p4 info 再确认 | SAFE-01；受支持诊断权限 |
| SAFE-03 | 安全与验收：前端运行测试与可视验收通道 | 受阻 | P0 | [playwright.config.ts](../../playwright.config.ts)；[vite.config.ts](../../vite.config.ts) | 恢复产品支持的测试通道；旧 Vitest spawn EPERM 未重试，2026-10-27 浏览器 file URL 明确拒绝，不通过 HTTP/换浏览器绕过 | 工具权限/产品修复 |
| QA-01 | 安全与验收：可重复的独立无 P4 UI 验收入口 | 待实现 | P0 | [playwright.config.ts](../../playwright.config.ts)；[dropdown-theme.spec.ts](../../tests/browser/dropdown-theme.spec.ts) | 已有静态 DOM 用例，但默认 Playwright 会启动/复用 dev 服务。补明确隔离、可运行入口与宽窄/折叠/下拉/虚拟列表证据，不声称当前样本已验收 | SAFE-03 |
| UI-01 | 界面与导航：导航迁到主工具栏右侧、设置末端、关闭全部在页签栏 | 已实现待验收 | P0 | [App.tsx](../../src/app/App.tsx)；[CommandBar.tsx](../../src/app/shell/CommandBar.tsx)；[ActivityBar.tsx](../../src/app/shell/ActivityBar.tsx)；[chrome.tsx](../../src/app/docking/chrome.tsx) | 最新仅 TS/CSS 检查；验六个入口、选中态、文字开关、窄窗溢出、分屏与关闭范围，左栏不留空列 | QA-01 |
| UI-02 | 界面与导航：固定页紧凑头、多开页 icon、主题与标题国际化 | 已实现待验收 | P1 | [chrome.tsx](../../src/app/docking/chrome.tsx)；[tokens.css](../../src/app/styles/tokens.css)；[index.ts](../../src/shared/i18n/index.ts) | 验深浅主题、150% DPI、tooltip、键盘和即时切语言；文件名不翻译 | QA-01 |
| UI-03 | 界面与导航：Dock/popout、快捷键、页签恢复 | 已实现待验收 | P1 | [useDockController.ts](../../src/app/docking/useDockController.ts)；[Windows原生UI验收.md](../../ForAIDoc/Coder/Windows原生UI验收.md) | 旧原生只部分；最新构建验分屏/归还/关闭重开/焦点/390px | SAFE-02；WIN-P0-01 |
| UI-04 | 界面与导航：通用表格排序/列显隐/列宽 | 部分实现 | P2 | [TableHeader.tsx](../../src/app/context-menu/TableHeader.tsx)；[HistoryTable.tsx](../../src/features/browsers/HistoryTable.tsx) | 通用菜单明确禁用，History 独立列宽已实现。需先确认要推广的表格范围，再补真实控制器；不能把菜单已渲染当功能完成 | 范围确认；QA-01 |
| CON-01 | 连接与工作区：多 Profile、连接恢复、Workspace 切换/Root 校正 | 已实现待验收 | P1 | [connection_service.rs](../../src-tauri/src/app/connection_service.rs)；[ConnectionProfilesCard.tsx](../../src/features/settings/ConnectionProfilesCard.tsx) | 旧 localhost/部分原生证据存在；最新需假服验证迟到请求、切换失败不改连接、自动 Root | SAFE-02 |
| CON-02 | 连接与工作区：User/Workspace Browse 与受控新建 | 部分实现 | P1 | [connection_setup_service.rs](../../src-tauri/src/app/connection_setup_service.rs)；[ConnectionSpecCreateDialog.tsx](../../src/features/settings/ConnectionSpecCreateDialog.tsx) | Workspace 创建已有旧 fixture 证据；New User 成功路径曾被 AuthenticationRequired 阻断，需专用 fixture 权限与原生验证 | SAFE-02 |
| CON-03 | 连接与工作区：P4VFS 新建虚拟 Workspace | 已实现待验收 | P2 | [vfs_service.rs](../../src-tauri/src/app/vfs_service.rs)；[P4VFS虚拟Workspace.md](../../ForAIDoc/Coder/P4VFS虚拟Workspace.md) | 已有前后端约束；真实 Agent/首次读取未验。仅新建，不转换旧 Workspace、不代装 Agent | SAFE-02；现成受控 Agent 环境 |
| FILE-01 | 文件与版本：Workspace/Depot 树、预览、状态与缓存 | 已实现待验收 | P1 | [ResourceExplorer.tsx](../../src/features/files/components/ResourceExplorer.tsx)；[workspaceQueries.ts](../../src/features/files/workspaceQueries.ts)；[FilePreviewPage.tsx](../../src/features/browsers/FilePreviewPage.tsx) | 旧自动化/fixture 基线不覆盖最近壳变动；验长路径、大树、离线缓存、连接隔离 | SAFE-02；QA-01 |
| FILE-02 | 文件与版本：Sync/Get Revision/Edit/Add/Delete/Revert/Reconcile、普通 Lock/Unlock | 已实现待验收 | P1 | [file_service.rs](../../src-tauri/src/app/file_service.rs)；[sync_service.rs](../../src-tauri/src/app/sync_service.rs)；[file_lock_service.rs](../../src-tauri/src/app/file_lock_service.rs) | 已有窄契约与旧 localhost；最新原生预检/取消/目标快照/partial 复核，禁止真实工作区写入 | SAFE-02；WIN-P0-04 |
| FILE-03 | 文件与版本：Rename/Move | 部分实现 | P2 | [rename_service.rs](../../src-tauri/src/app/rename_service.rs)；[RenameDialog.tsx](../../src/features/files/components/RenameDialog.tsx) | 单文件已接且有旧 fixture；目录、跨 Workspace、覆盖、case-only 明确阻断，不列为已完成。是否扩范围需确认 | 范围确认；SAFE-02 |
| FILE-04 | 文件与版本：Diff、Revision Graph 与精确历史比较 | 已实现待验收 | P1 | [PageRenderer.tsx](../../src/app/PageRenderer.tsx)；[DiffView.tsx](../../src/features/browsers/DiffView.tsx)；[historyDiff.test.tsx](../../src/app/docking/historyDiff.test.tsx) | 验选中 #revision 到新独立 Diff 的真实请求参数、不回退 have/head、不受全局选择污染；旧 Diff 基线不能覆盖最新参数链 | QA-01；SAFE-02 |
| HIS-01 | History：四列表格、年日期、拖列宽、描述展开、FIFO 两选 | 已实现待验收 | P1 | [HistoryTable.tsx](../../src/features/browsers/HistoryTable.tsx)；[useRecordSelection.ts](../../src/app/context-menu/useRecordSelection.ts) | 测试源码存在，最新交互未跑；验 A→B→C 留 B/C、先后双色及aria/tooltip、右键不重排、长描述/空时间/双语 | QA-01 |
| HIS-02 | History：右键 CL 预览/Get/Undo/Diff 与全局差异入口 | 已实现待验收 | P1 | [ReadOnlyPages.tsx](../../src/features/browsers/ReadOnlyPages.tsx)；[UndoDialog.tsx](../../src/features/files/components/UndoDialog.tsx)；[undo_service.rs](../../src-tauri/src/app/undo_service.rs) | Undo 是单文件指定 revision 真 undo，非 sync/revert；6 项纯 Rust 历史通过，不等于 P4 执行验收。验预览/取消/一次确认、后选 Get、双选精确 Diff | SAFE-02；FILE-04 |
| CL-01 | CL 工作流：Pending 表单、文件移动/拖放、Default 与分页 | 已实现待验收 | P1 | [PendingPage.tsx](../../src/features/changelists/components/PendingPage.tsx)；[changelist_service.rs](../../src-tauri/src/app/changelist_service.rs) | 旧 localhost/自动化已有；最新验默认 CL 唯一、长列表、选择、跨 CL 移动/失败刷新 | SAFE-02；WIN-P0-04 |
| CL-02 | CL 工作流：Submit 预检、执行与结果复核 | 已实现待验收 | P1 | [submit_service.rs](../../src-tauri/src/app/submit_service.rs)；[FileClWorkflow.tsx](../../src/features/changelists/components/FileClWorkflow.tsx) | 已有旧 fixture 闭环；最新验阻断项/取消/重复确认/连接变化与安全清理 | SAFE-02；WIN-P0-04 |
| CL-03 | CL 工作流：Shelf/Unshelve/Resolve/手工文本合并 | 已实现待验收 | P1 | [workflow_service.rs](../../src-tauri/src/app/workflow_service.rs)；[manual_merge.rs](../../src-tauri/src/app/manual_merge.rs)；[ShelfDetailPage.tsx](../../src/features/changelists/components/ShelfDetailPage.tsx) | 已有旧 fixture；最新原生完整流程及 Shelf deep-path 跳转仍缺，验 CAS/备份/冲突保留 | SAFE-02；WIN-P0-04 |
| CL-04 | CL 工作流：全局 CL 详情弹窗与 Go To CL | 已实现待验收 | P1 | [ChangeDetailsDialog.tsx](../../src/features/changelists/components/ChangeDetailsDialog.tsx)；[SubmittedGoTo.tsx](../../src/features/changelists/components/SubmittedGoTo.tsx) | 已抽查 History/Pending/Submitted/FileReview/工具栏共享打开动作，搜索通过 App 导航继续核验覆盖；取消/迟到隔离代码已接；Go To 明确仅 submitted，验错误/空/长内容/关闭回焦点，不改筛选 | QA-01；SAFE-02 |
| SUB-01 | Submitted 与周报：单用户筛选、无 Client/Job、预设迁移与即时应用 | 已实现待验收 | P1 | [submittedFilters.ts](../../src/features/changelists/submittedFilters.ts)；[SubmittedFilterPanel.tsx](../../src/features/changelists/components/SubmittedFilterPanel.tsx) | schema4 丢弃旧隐藏条件，保留当前 Stream；验 reset/保存/恢复/空预设与不重复刷新 | QA-01 |
| SUB-02 | Submitted 与周报：Stream 多选 OR、当前快捷项、稳定分页 | 已实现待验收 | P1 | [repository.rs](../../src-tauri/src/p4/changelists/repository.rs)；[submittedFilters.test.ts](../../src/features/changelists/submittedFilters.test.ts) | 两项纯 Rust 并集测试通过；最多16项、去重、扫描不全报错；需 mock/fixture 验实际分页、当前+显式及换连接 | SAFE-02；QA-01 |
| SUB-03 | Submitted 与周报：普通/疑似 CI/自动生成分类 | 已实现待验收 | P1 | [submittedReport.ts](../../src/features/changelists/submittedReport.ts)；[SubmittedPage.tsx](../../src/features/changelists/components/SubmittedPage.tsx) | 精确元信息签名的启发式，不验证 CI 身份；仅筛已加载记录，验数量诚实性/不吞人工同描述 CL | QA-01 |
| SUB-04 | Submitted 与周报：单用户日期区间生成周报提示词 | 已实现待验收 | P1 | [submittedReport.ts](../../src/features/changelists/submittedReport.ts)；[SubmittedReportDialog.tsx](../../src/features/changelists/components/SubmittedReportDialog.tsx) | 独立分页、最多100页/5000候选、完整描述和CL引用、部分结果标记；本地生成且仅点击复制。验跨周/时区/取消/上限/遗漏，不上传 AI | QA-01；SUB-06 |
| SUB-05 | Submitted 与周报：结果虚拟行重叠修复、CL 展开、紧凑筛选与结果摘要 | 已实现待验收 | P0 | [ChangelistPage.tsx](../../src/features/changelists/components/ChangelistPage.tsx)；[workbench.css](../../src/app/styles/workbench.css)；[SubmittedPage.test.tsx](../../src/features/changelists/components/SubmittedPage.test.tsx) | 最新64/324固定高度、缓存重算和原点修复仅静态通过，截图问题尚未运行确认；必须验100+行不重叠、展开/收起、筛选折叠/resize、下拉不裁切；Depot/Stream与起止日期各同排 | QA-01 |
| SUB-06 | Submitted 与周报：查询时间边界与 Depot Path 诊断 | 部分实现 | P1 | [submittedFilters.ts](../../src/features/changelists/submittedFilters.ts)；[command.rs](../../src-tauri/src/p4/changelists/command.rs) | 本地时间转UTC后格式化无时区 P4 日期，8h差能解释但服务端解释未证；需假服已知时区边界验证后决定修法。裸 Depot Path 原样，Stream 加 /... 已有1项纯参数测试 | SAFE-02；不猜真实 depot |
| SEARCH-01 | 搜索与分支：七类全局搜索、Stream/Shelf 深度搜索 | 已实现待验收 | P1 | [SearchPage.tsx](../../src/features/search/SearchPage.tsx)；[search_service.rs](../../src-tauri/src/app/search_service.rs) | 已非待开发；旧原生看到类别/Stream跳转，Shelf deep-path 到详情与大规模 partial/权限仍待验 | SAFE-02；CL-03 |
| SEARCH-02 | 搜索与分支：Stream 切换与只读 Graph | 已实现待验收 | P1 | [stream_switch_service.rs](../../src-tauri/src/app/stream_switch_service.rs)；[StreamGraphPage.tsx](../../src/features/browsers/StreamGraphPage.tsx) | 旧 fixture切换/原生5节点已验；最新验切换预览/可选sync、缩放键盘与独立窗口 | SAFE-02 |
| SEARCH-03 | 搜索与分支：Branch Mapping 列表/详情/预览/受控CRUD | 已实现待验收 | P1 | [branch_mapping_service.rs](../../src-tauri/src/app/branch_mapping_service.rs)；[BranchMappingsPage.tsx](../../src/features/browsers/BranchMappingsPage.tsx) | 旧原生正向预览和fixture CRUD有证据；反向、窄屏、popout与权限/trigger边界需补 | SAFE-02 |
| OPS-01 | 工具与可靠性：Terminal/P4 Log/Journal/诊断脱敏 | 已实现待验收 | P1 | [ToolArea.tsx](../../src/features/tools/ToolArea.tsx)；[runner.rs](../../src-tauri/src/p4/runner.rs)；[log_store.rs](../../src-tauri/src/persistence/log_store.rs) | 受控终端与日志链已有；最新验快捷键/独立窗口/上下文隔离/仅Error红点、日志不抢焦点/导出脱敏 | SAFE-02；UI-03 |
| OPS-02 | 工具与可靠性：共享缓存、取消/代次隔离、大列表性能 | 已实现待验收 | P1 | [useSnapshotQuery.ts](../../src/shared/cache/useSnapshotQuery.ts)；[status_cache.rs](../../src-tauri/src/app/status_cache.rs)；[项目状态总览.md](../../ForAIDoc/PM/项目状态总览.md) | 旧100k基准仅历史设备与版本；最新验连接切换不串数据、上限和长滚动，无固定性能阈值时不宣称性能认证 | QA-01；WIN-P2-01 |
| OPS-03 | 工具与可靠性：Swarm 安全链接 | 已实现待验收 | P2 | [swarm_open.rs](../../src-tauri/src/app/swarm_open.rs)；[Swarm基础链接.md](../../ForAIDoc/Coder/Swarm基础链接.md) | 只做URL打开、无API/评论/创建Review；本轮禁止外部请求，安全测试先mock，真实外部验收另授权 | 明确外部验收授权 |
| WIN-P0-01 | 阶段收口：最新原生构建/启动/版本绑定 | 部分实现 | P0 | [Windows原生构建运行验收.md](../../ForAIDoc/Coder/Windows原生构建运行验收.md) | 旧94b5f0c等证据不代表当前d582a5c+脏工作树；记录源码快照、产物hash与原生退出，勿要求先清除用户改动 | SAFE-02 |
| WIN-P0-03 | 阶段收口：历史本人 Server 验收 | 受阻 | 不执行 | [开发路线图.md](../../ForAIDoc/PM/开发路线图.md) | 当前禁止生产包括只读；保留历史项但冻结，不作为AI下一动作，也不要求用户现在授权生产 | 当前用户安全约束 |
| WIN-P2-01 | 阶段收口：连续2小时稳定性验收记录 | 待实现 | P2 | [Windows本机私用TODO.md](../../ForAIDoc/PM/Windows本机私用TODO.md) | 这是未执行验收任务，不是缺少功能代码；最新假服构建覆盖重启/切换/日志/列表，记录资源与故障，关闭P0后进行 | WIN-P0-01；WIN-P0-02/04 |
| OPT-01 | 后续候选：Labels/Jobs独立工作台、Stream spec写入、全量高级菜单 | 建议待确认 | 未排期 | [catalog.ts](../../src/app/context-menu/catalog.ts)；[开发路线图.md](../../ForAIDoc/PM/开发路线图.md) | 静态数到190个phase:later；不是190项已承诺任务。选择实际需要的场景再立项，Force Unlock已明确退役不可恢复 | 用户范围决定 |
| OPT-02 | 后续候选：跨平台/发布/兼容矩阵/自动更新/外部认证 | 建议待确认 | 未排期 | [开发路线图.md](../../ForAIDoc/PM/开发路线图.md)；[后端TODO.md](../../ForAIDoc/PM/后端TODO.md) | macOS/ARM/多版本/签名/updater/remote CI不是当前私用阻塞；SSL/SSO/MFA仅新需求下评估，不因功能盘点自动开发 | 用户交付目标决定 |

## 完成项归档（历史基线有证据，不外推最新版本）

| ID | 模块 / 范围 | 状态 | 优先级 | 证据路径 | 关闭范围与回归边界 | 依赖 |
|---|---|---|---|---|---|---|
| WIN-P1-01 | 工具与可靠性：故障恢复与退出进程回收 | 已实现且有相应验收证据 | 归档 | [故障恢复与配置备份.md](../../ForAIDoc/Coder/故障恢复与配置备份.md) | 2026-10-22 Debug/HMR+隔离fixture原生记录含断服/ticket/离线重启/取消/执行中退出；完成限该基线，最新构建回归纳入OPS-01 | 旧基线证据；非本轮重跑 |
| WIN-P1-02 | 工具与可靠性：非敏感备份/恢复/回滚与DPI恢复 | 已实现且有相应验收证据 | 归档 | [backup.rs](../../src-tauri/src/persistence/backup.rs)；[故障恢复与配置备份.md](../../ForAIDoc/Coder/故障恢复与配置备份.md) | 2026-10-22原生创建/退出恢复/pre-restore回滚与凭据canary有记录；不是普通备份可含凭据，最新回归并入WIN-P0-02 | 旧基线证据；非本轮重跑 |

## 下一批最优先任务

1. **SAFE-01/02/03 + QA-01**：先完成可用隔离验收通道与 fail-closed QA 配置。安全核验失败时仅做离线工作；当前机器 connected/authorized 不代表 CIM、子进程或浏览器协议限制已解除。
2. **SUB-05 + UI-01**：以最新工作树先验用户刚报错的列表重叠，以及导航/设置/关闭入口。验100+条、展开文件、多次切页/筛选折叠、窄宽窗口和150%缩放，记录尺寸和截图；仍失败就定位，不再只用 CSS/类型检查结案。
3. **FILE-04/HIS-01/02 + CL-04**：假 backend 精确断言两侧 #revision；FIFO、右键目标、CL弹窗快切迟到；再在安全假服上做 Get/Undo 预览、取消与确认闭环。
4. **SUB-01/02/04/06**：补预设迁移、Stream OR 分页、周报完整性和时间边界证据；实际请求参数与UI一致，不把候选扫描上限当完整数据。
5. 合入 **WIN-P0-01/02/04 → WIN-P2-01** 的本机阶段收口。历史已完成恢复/备份无需重新开发，但应随最新构建回归。

## 真正缺实现与需要决定的范围

- **当前安全缺口**：QA加载/恢复/切换的 fixture 绑定不完整；有门禁脚本不等于隔离闭环。优先修，不恢复无条件禁用QA方案。
- **当前未接通的产品能力**：通用表头排序/列配置仍明确 disabled；History独立拖列宽例外。Rename/Move仅单文件安全子集，范围外操作有意阻断；它们属于部分实现，不是隐藏按钮就算完成。
- **需要用户选择**：是否优先推广通用列配置、是否扩目录/case-only Move；是否需要 Go To 同时查 pending（当前 submitted-only，原请求未承诺新增）；P4VFS 是否准备实际使用。未决定前不扩功能。
- **不自动立项**：Label/Job工作台、Stream spec写入、190个后置菜单、Swarm API/Review、跨平台发布。Force Unlock已退役，不重新加入Todo。
- **时间语义**：先用假服已知时区证据确定日期偏移问题，不能让用户猜后端原因或直接改本机/服务器时区。

## 不得恢复的已覆盖旧需求

保留当前行为，不把以下旧设计作为“缺功能”重做：Client筛选、Stream仅当前、独立Merge分类、History满两条阻止新增或“最多两条”提示、专用比较按钮、History内嵌Diff、预览CL跳Submitted、预设“应用”按钮、左侧六导航、数量摘要置于筛选内部。Depot真实名称未知不是已证实代码缺陷；不能为修报错探测生产路径。

## 本次核对与验证限制

- 阅读 ForAIDoc 入口、现行任务表、状态总览、核心基线、前后端历史Todo、原生UI/恢复备份/安全核验与菜单文档；逐模块对照现有前后端入口，特别抽查 TableHeader 的禁用、Go To submitted目标、Undo真实契约、周报分页上限、虚拟行与导航接线。
- 历史证据：2026-10-22恢复/备份原生验收；2026-10-10等旧测试/fixture/原生记录。不继承为2026-10-27全绿。
- 本任务之前最近实际检查：定向 TypeScript/CSS/格式/离线 cargo check；Stream并集2项、filespec构造1项纯Rust测试已通过。最近 React/浏览器回归源码多数未执行；本轮文档盘点没有重跑。
- **旧阻碍未重新确认解除**：CIM listener 权限拒绝、独立 Windows PowerShell 执行策略拒绝、Vitest/Node测试子进程 EPERM。2026-10-27 **当前已确认拒绝**：CUA本地静态HTML的 file URL 被协议策略拒绝，未换协议/服务/浏览器绕过。不存在可据此声称完成的最新视觉截图。
- 有安全静态HTML样本与静态DOM测试源码，但不是完整React虚拟化/原生IPC验收，也未成功在受控浏览器打开。解除阻碍应走产品支持路径，用户无需搬运项目文件。

---

## 历史执行说明与验收快照（2026-10-10 至 2026-10-26，仅追溯）

以下保留原文与 WIN 编号，历史“当前/已完成/下一步”不得覆盖上方唯一任务表；生产连接步骤处于冻结状态，旧 Activity Bar 和旧 Submitted 筛选描述不是最新产品要求。


> 当前阶段唯一执行清单。目标是在**当前这台 Windows 机器上供本人私用**，不是公开发布、跨平台交付或企业部署。
> 建立日期：2026-10-10。事实基线：`94b5f0c` 已取得第一轮 Windows Tauri 原生构建/启动和部分核心点击证据；用户随后决定从面向普通用户的 P4Deck 中移除管理员 Force Unlock，管理员强制解锁改由后台执行。本人实际 P4 Server 仍未验证。
> 历史实现记录继续保留在《前端操作流程 TODO》和《后端 TODO》，但不再作为当前任务队列。

## 当前验收快照

- **WIN-P0-01 部分完成**：`94b5f0c` 的 `pnpm tauri build --debug --no-bundle` exit 0，真实 exe、SHA-256、可见响应窗口和隔离 IPC 已绑定留证；移除 Force Unlock 后的 `3c21d03` 也已成功重建并由本人启动人工验收，本次“移除原生顶栏菜单”的决定即来自该窗口。旧隔离验收 PID 已正常关闭，fixture 已停止且 listener 消失，原 Roaming/Local 已恢复，测试 snapshot 已保留。菜单移除版的最新构建/版本绑定以 [Windows 原生构建与运行验收](../Coder/Windows原生构建运行验收.md) 为准，仍需本人确认新窗口外观与连接入口。
- **WIN-P0-02 部分完成**：原生窗口已通过 Profile 保存/验证、Workspace Root 校正、七类 Search 与 Stream 跳转、Stream Graph 拓扑/详情、Branch Mapping list/detail/forward preview/安全 CRUD。首轮 build 还曾真实执行一次后来下线的 Force Unlock；该历史事实保留在验收记录中，但不再是当前能力、阻塞或待复验项。详见 [Windows Tauri 原生 UI 验收](../Coder/Windows原生UI验收.md)。
- **当前产品决定**：普通用户界面只保留普通 Lock/Unlock 及 other-owner blocker/提示；不提供 Force Unlock 按钮、对话框或 API 路径。管理员强制解锁由后台按运维流程执行。
- **当前入口决定**：Terminal/P4 Log 只保留底部工具区、命令面板、快捷键与独立 panel；Stream Graph/Branch Mappings 从 Streams 页按钮进入，并继续支持 Dock/popout。左侧 Activity Bar 不再重复显示这四个入口。任何新日志/Warning/Error 都不自动展开或切换当前工具，未查看 Error 只显示底部可访问红点，打开日志后清除。
- **尚未通过**：Shelf `deep-path` 结果到独立详情、其余完整只读入口、命令面板/前端快捷键、390px、dock/popout/归还、焦点、关闭重开/布局恢复，以及剩余安全写入流程。本人验收认为原生 Connection/Changes/Navigate/View 顶栏菜单重复且不符合设计，现已从产品移除；连接管理继续位于 Settings。
- **WIN-P1 已完成**：2026-10-22 已在 Debug/HMR、QA Profile 和 loopback fixture 的 Windows Tauri 原生窗口中完成 Server 停止、ticket 缺失、离线重启、取消、执行中退出、配置备份/恢复/回滚和 150% DPI 窗口恢复验收。演练同时修复了退出后孤儿 `p4.exe`、Journal 时间偏移和窗口尺寸重复乘 DPI 三个缺陷。
- **未开始/未验**：本人实际 Server（WIN-P0-03）、完整核心读写安全演练（WIN-P0-04）和全部 P2。
- **控制停止事实**：提交 `707e51e` 后工具返回 “Computer Use was stopped by the user with the physical Escape key.”；随后没有继续原生点击。旧应用、fixture、原配置恢复与临时 seed 清理由后端收尾，不构成新版 UI 复验。
- **fixture 下轮前置**：临时 Shelf 4447/4448、历史 Force target CL4449 与 owner/client/user、原生测试 branch 已精确清理；下轮只需为 Shelf 导航等仍在范围内的场景重新 seed，不再创建管理员强制解锁目标。CL4446 四个已提交文件、5 个 streams 及历史 permission-map/shelf2 保留。

## 安全红线

> 当前 AI 执行约束（2026-10-26）：用户明确只允许项目本地假 P4，禁止任何公司生产连接，包括 `info`、认证状态和其他只读查询。下列历史计划中的“本人实际 Server”不构成执行授权；WIN-P0-03 及 WIN-P0-04 的非 fixture 部分暂不执行，也不标记完成。仅 loopback 地址或 QA 标识不足以放行，必须先证明服务属于项目且无生产代理/转发，核对配置与凭据继承。核验记录见 [本地假 P4 安全核验](../Coder/本地假P4安全核验.md)。

1. 自动化、故障注入和可重复写测试只能连接项目隔离 fixture（固定 loopback `127.0.0.1:16661`）或本人明确创建的测试 Server/测试 Depot/测试 Workspace。不得读取环境变量后回退到生产 Server，也不得复用真实生产 ticket、trust、Client 或 Workspace。
2. 在本人实际 Server 上，首次只做 `info/login status`、Workspace/Depot 浏览、History/Diff/Search 等只读检查。任何 Sync/Edit/Add/Delete/Revert/Move/Lock/Shelf/Unshelve/Resolve/Submit 演练，必须先确认目标位于本人可删除的专用测试路径、专用 Client 和专用 CL；执行前记录文件清单，执行后复核并清理。
3. 不在文档、截图、日志、Git 或诊断包中保存密码、ticket、trust 内容、内网地址、真实 Depot 路径和未脱敏文件内容。涉及个人 Server 的证据只记录脱敏后的 Server 类型、时间、结果和 operation ID。
4. 所有 mutation 都先完成 UI 预检并核对目标快照；结果为 partial、unknown、cancelled 或连接漂移时不得重复点击，先刷新并人工确认服务器实际状态。

## 完成定义

以下 P0、P1、P2 全部关闭后，本阶段标记为“Windows 本机私用就绪”：

- 最新本地提交能在当前 Windows 上完成 Tauri 原生构建并启动，证据绑定 commit、构建时间和可执行文件。
- 原生主窗口完成核心只读与写入流程冒烟；浏览器、jsdom 和 localhost 服务层结果只能作为补充，不能代替该证据。
- 本人实际 P4 Server 完成所需认证和只读访问；其真实认证方式如果不使用 SSL/SSO/MFA，则这些能力不构成本阶段阻塞。
- 写入安全演练只在隔离 fixture 或本人专用测试 Depot/Workspace 完成，并能恢复/清理。
- 配置与本地数据有可执行的备份/恢复方法，失败、断网、过期认证和异常退出有已验证的恢复路径。
- 在当前机器完成一次连续 2 小时稳定性观察，期间无数据错误、崩溃或无法解释的 mutation 结果；所有 P0/P1 缺陷已关闭或有明确安全降级。

## P0：首次私用前必须完成

### WIN-P0-01 — 最新 Tauri 构建、启动与版本绑定（部分完成）

- **目标**：从干净的当前 `master` 生成并启动最新 Windows 原生应用，而不是只验证 Web bundle。
- **为何阻塞本机私用**：`pnpm build`、浏览器 Playwright 和 Rust 单测都不能证明 WebView2/Tauri 进程、资源、IPC 与原生窗口能够在本机正常启动。
- **具体实现/验收步骤**：记录 commit 与工具版本；执行本地快速门禁；按项目已有 Tauri 入口完成 debug 或 release 构建；从生成物启动主窗口；确认无白屏、panic、资源缺失或立即退出；退出后确认无残留写操作进程。若 build/start 失败，只修复直接阻塞本机启动的问题，另立变更提交。
- **完成证据**：commit SHA、实际命令与退出码、生成物路径、启动/正常退出时间、主窗口截图或人工验收记录，以及无敏感信息的启动日志。
- **当前证据/缺口**：`94b5f0c` 构建/启动已通过；移除 Force Unlock 后的 `3c21d03` 也已重新构建并由本人启动，完整原生回归尚未完成。本人已授权后端结束该标准 exe 的残留进程并重建菜单移除版；最新构建是否完成、hash、路径和进程状态只引用 [Windows 原生构建与运行验收](../Coder/Windows原生构建运行验收.md)，本清单不固化瞬时“构建中”状态。下一步是由本人启动最新产物并复验。
- **负责端**：前端负责壳/UI 启动；后端负责 Rust/Tauri/IPC 启动错误；PM 核对证据绑定同一 commit。

### WIN-P0-02 — 最新构建的 Windows 原生 UI 冒烟（部分完成、待阻塞复验）

- **目标**：在 Tauri 原生窗口中确认本人会使用的核心入口可点击、可聚焦、可恢复。
- **为何阻塞本机私用**：现有 Web/真实 Edge 测试和 localhost 服务层 E2E 没有覆盖 WebView2 焦点、窗口恢复、系统对话与 IPC 串联，也不能证明最终原生窗口已不再显示退役的系统菜单栏。
- **具体实现/验收步骤**：先连接隔离 fixture；依次检查启动/退出、Settings 的“已保存连接”、Workspace/Depot、文件预览、Diff/History/Graph、Pending/Submitted、Search、Streams/Stream Graph、Branch Mappings、Shelf、Terminal/P4 Log/Operations/Diagnostics；确认原生 Connection/Changes/Navigate/View 顶栏菜单不存在。Settings 中连接主区只突出 Server/User/Workspace，P4 高级字段单列；User/Workspace 的 Browse 必须查询当前草稿 Server/User，New 必须经过专用 preflight → 明确确认，成功只回填草稿而不自动保存/激活；空 Workspace 时仍能先验证 Server/User 并进入 Trust/Login 恢复。确认 Activity Bar 没有重复的 Terminal/P4 Log、Stream Graph 或 Branch Mappings 按钮，前两者仍可从底部工具区手动打开、后两者仍可从 Streams 页按钮进入，并以测试 Error 验证只出现红点、不自动展开/切换、查看后清除；验证命令面板、主要前端快捷键、390px 主窗口、dock/popout/归还、关闭后重开和焦点恢复；对 Submit、Shelf、Resolve、Stream 切换、Branch Mapping create/edit/delete、普通 Lock/Unlock 只在测试数据上执行。确认其他用户持锁仍显示明确 blocker/owner 提示，且界面不存在管理员强制解锁入口。记录每一步通过/失败及所用构建。
- **完成证据**：按页面/动作列出的原生冒烟表、关键截图或录屏、operation/log ID、窗口恢复前后记录；必须明确写“Windows Tauri 原生”，不能用 Edge 截图替代。
- **当前证据/缺口**：已通过项和精确边界见 [Windows Tauri 原生 UI 验收](../Coder/Windows原生UI验收.md)。Settings 分组、草稿作用域 Browse、受控 New、空 Workspace 预验证及 390px Browser Mock 回归已具备自动化证据；Windows 隔离 localhost 另已真实验证 users/workspaces 查询、classic/stream Workspace 创建、字段回读与重复名称不覆盖。该 fixture 的 New User 被认证策略以 `AuthenticationRequired` 阻断，未验证真实创建成功；本人 Server 和 Windows Tauri 原生点击仍待验，不能用 Browser Mock 或服务层 fixture 替代。下一步构建并启动最新 exe，确认 Settings 连接管理、普通 Lock/Unlock 与 other-owner blocker 未受影响，再依有限清单补 Shelf 导航、剩余页面、命令面板/前端快捷键、390px、dock/popout、焦点和重开恢复；未实际点击项不得由后端日志或浏览器截图代替。
- **负责端**：前端主责交互与窗口；后端协查 IPC/operation；PM 执行或见证冒烟并归档结果。

### WIN-P0-03 — 本人 P4 Server 连接与实际认证（未验）

- **目标**：在应用内连接本人实际使用的 Server、User、Client/Workspace，并确认该 Server 实际要求的认证路径。
- **为何阻塞本机私用**：localhost fixture 证明协议和安全边界，但不能证明本人 Server 地址、权限、ticket/trust 策略和 Workspace 映射可用。
- **具体实现/验收步骤**：先备份现有应用配置；创建单独 Profile，输入非敏感 Server/User/Workspace 与 P4 高级设置；通过应用完成 CLI 发现、`p4 info` 和 `p4 login -s`；仅在服务器确实要求时执行 SSL trust 或外部 SSO/MFA。Workspace Root 必须由当前草稿向本人 Server 精确解析，不能手填或沿用旧 profile 的 cwd；空 Workspace 时应仍可验证 Server/User。选择本人测试 Client/Workspace 后再浏览 Workspace/Depot，并核对 Server/User/Client/Root/Stream。失败时按钮附近应立即显示原因与恢复方向，保持旧活动 Profile，不覆盖原配置，也不启动本地 Workspace 扫描。
- **完成证据**：脱敏连接状态、实际认证类型、只读页面成功记录、失败回滚记录和配置备份位置；不保存密码、ticket、fingerprint 全文或内网地址。
- **负责端**：PM/本人提供环境并验收；前端负责向导状态；后端负责认证分类、Context 与代次隔离。

### WIN-P0-04 — 核心读写安全演练（未关闭）

- **目标**：证明日常“浏览 → 修改 → Pending/Review → Shelf/Resolve → Submit”链路在安全边界内可用，并能恢复到已知状态。
- **为何阻塞本机私用**：自动化已验证实现，但首次用于个人数据前仍需确认实际权限、映射、文件类型、trigger 和服务器策略不会产生意外写入。
- **具体实现/验收步骤**：先在隔离 fixture 完整执行一轮；再仅在本人专用测试 Depot/Client/CL 上执行 Sync、Edit/Add、Move、Revert、Pending 移动、普通 Lock/Unlock（若权限支持）、Shelf/Unshelve、文本 Resolve 和 Submit。每个 mutation 先核对预检目标、blocker/warning、operation ID 和刷新建议；包含一次主动取消或失败场景；最终核对 Submitted 结果并删除/归档测试数据。真实生产 Depot 只做只读检查；管理员强制解锁不属于 P4Deck UI 演练范围。
- **完成证据**：脱敏的测试路径标识、操作前后文件/CL 清单、各状态机结果、服务器侧复核、清理结果和任何不支持能力的安全降级说明。
- **当前证据/缺口**：隔离 fixture 已完成一项 Branch CRUD；历史 build 曾完成一次现已下线的管理员强制解锁并有服务端复核，但它不属于当前完成条件。Submit、Shelf/Unshelve、Resolve、Stream 切换、普通 Lock/Unlock 等完整演练及本人 Server 权限/trigger 仍未验证。
- **负责端**：前端验证状态机呈现；后端验证命令、token、Journal/Log 与最终状态；PM/本人控制测试范围并确认清理。

## P1：进入日常使用前完成

### WIN-P1-01 — 故障恢复（已完成）

- **目标**：确认网络中断、认证失效、取消、异常退出和未知结果不会被误报为成功，且用户知道如何恢复。
- **为何阻塞本机私用**：P4 写操作发生中断时，错误重试可能造成重复操作或错误判断；必须先证明刷新与人工复核路径可用。
- **具体实现/验收步骤**：只在 fixture/测试 Depot 注入 CLI 不可用、Server 停止、ticket 缺失/过期等可恢复故障；在只读请求和一项可取消长操作中检查取消/重连；执行中关闭应用后重启，确认 Journal 将未终结操作标记为 interrupted 且不自动重放；对 partial/unknown 结果按提示刷新并从 Server 侧核对。
- **完成证据**：每类故障的 UI 状态、Journal/Log、重启后状态、人工恢复步骤和最终数据一致性记录。
- **负责端**：后端主责故障分类与不可重放；前端主责恢复入口；PM 核对结果没有假成功。
- **当前证据**：Rust 已把只读超时与 mutation/未知命令超时分开，后者记 `unknown`；超时会终止并等待子进程退出。Journal 启动恢复把未终结操作标为 `interrupted`，不保存重放 payload；Operations UI 为 unknown/interrupted/cancelled/authExpired/offline/serverUnreachable 显示核对日志、刷新 Pending/Workspace 和 Server 侧确认步骤，并明确“不自动重放”。2026-10-22 原生验收确认 Server 停止与离线重启保留缓存、ticket 缺失显示 `authExpired`、取消显示 `cancelled`、执行中关闭应用后重启显示 `interrupted` 且无自动重放。本地 fixture 最终无 open 记录，workspace 与 Have 一致；Windows Job Object 验证应用退出后残留 `p4.exe` 为 0。详细场景表见 [故障恢复与配置备份](../Coder/故障恢复与配置备份.md)。
- **剩余边界**：ticket 缺失由 fixture 临时移除 ticket 模拟；本人实际 Server 的 SSO/MFA、插件认证、权限与 trigger 仍由 WIN-P0-03 验证。

### WIN-P1-02 — 本地数据备份与回滚（已完成）

- **目标**：能够备份并恢复 P4Deck 的非敏感配置、布局和必要本地状态，同时安全处理 ticket/trust 等外部凭据。
- **为何阻塞本机私用**：当前只有本地 Git；应用配置损坏、磁盘问题或误切 Profile 时，需要无需 remote 也能恢复可用状态。
- **具体实现/验收步骤**：识别本机应用数据目录、Profile 配置、布局、日志/Journal/诊断与 P4 外部 ticket/trust 的实际位置；列出“备份”“不备份/单独保护”“可删除重建”三类；关闭应用后制作本地离线备份；在临时副本或测试账户验证一次恢复；记录回滚到上一 Git commit 和恢复应用配置的命令。不得把凭据加入仓库或普通压缩包。
- **完成证据**：脱敏文件清单、备份时间/介质、恢复演练记录、校验结果和回滚手册；不提交备份本体。
- **负责端**：后端说明持久化边界；PM/本人执行备份恢复；前端核对恢复后的布局/Profile 表现。
- **当前证据**：Settings 已提供创建备份、打开目录、查看待恢复/最近结果和选择回滚包。Bundle schema v1 只含 `connection.json`、窗口位置与布局 localStorage allowlist；ticket/trust、密码、终端历史、文件选择、日志、Journal、诊断和 IndexedDB 缓存不入包。源文件有 SHA-256 和结构校验；恢复先暂存并在下次启动加载连接前执行，自动生成 pre-restore 包。恢复前捕获两份在线文件，任一替换失败会立即恢复两份旧文件；中途崩溃则 pending 清单保留并在下次启动幂等重做。2026-10-22 原生验收完成“创建备份 → 修改连接名/主题 → 恢复并完全退出重开 → 选择 pre-restore 包回滚并再次退出重开”闭环；手工包含连接、窗口位置和 26 个布局键，ticket/trust canary 命中为 0。150% DPI 下的窗口位置/尺寸 round trip 也已修复并验证。详细边界见 [故障恢复与配置备份](../Coder/故障恢复与配置备份.md)。

## P2：阶段收口

### WIN-P2-01 — 本机稳定性观察与最终文档收口（未验）

- **目标**：以实际个人使用强度验证当前机器稳定性，并把已知限制固化为可执行说明。
- **为何阻塞本机私用**：短时冒烟无法发现窗口恢复、缓存、连接代次、长列表或日志增长问题；没有最终记录也无法判断后续回归。
- **具体实现/验收步骤**：在最新通过 P0/P1 的构建上连续运行至少 2 小时，覆盖两次应用重启、一次 Profile/Workspace 切换、浏览/搜索/Pending/Submitted/Diff/Log 和至少一个测试数据 mutation；观察崩溃、CPU/内存异常增长、旧连接数据串入、窗口恢复和日志容量；将缺陷分为本阶段阻塞或已知限制，更新项目状态、操作说明和备份/恢复日期。
- **完成证据**：开始/结束时间、构建 SHA、Windows/CLI 版本摘要、执行动作、资源观察、崩溃/错误数、最终缺陷清单和 PM 关闭结论。
- **负责端**：PM/本人主责；前后端只处理被判定为本机私用阻塞的缺陷。

## 当前阶段非范围

以下项目不阻塞“当前 Windows 机器本人私用”，不得混入本清单的完成判断：

- Git remote、远端 CI、异机恢复证明。
- macOS、Linux、Windows ARM64 与跨平台一致性。
- 代码签名、公证、正式 installer、正式 updater、公开发布与分发手册。
- 企业 SSO/MFA；仅当本人实际 Server 强制要求时，才升级为 WIN-P0-03 的真实阻塞。
- 第二 Server、Broker/Proxy、多 P4/P4D 版本、Unicode/non-Unicode Server 兼容矩阵。
- NVDA/VoiceOver、双平台读屏认证；当前保留键盘/ARIA/axe/对比度自动化基线。
- Label/Job 独立工作台与 Stream spec 写入等后续产品功能。Branch Mapping 前后端工作台已完成，Windows 原生点击及真实权限/trigger 行为仍须按本清单安全边界验收。
- 管理员 Force Unlock：按用户决定不面向普通用户提供，P4Deck 不再包含按钮、对话框或专用 API；需要时由管理员在后台执行，不进入本阶段验收。
- 菜单台账中 190 个 `phase: later` 项。

## 新增功能实施批次（不改变上述验收顺序）

- Stream Graph 前后端只读闭环已独立完成：正式全局 panel/Streams 入口、确定性 parent→child 分层、可访问虚拟树、过滤/分页/取消/重试、详情/键盘/390px、复用安全切换对话框，以及强类型契约、Tauri adapter、明确 simulated 的 Browser Mock、有界 `p4 streams` 采集、scope 复核、一次性分页游标和 Windows localhost fixture 均已落地。
- Web 组件与真实 Edge 已覆盖分页去重、游标失效重启、迟到隔离、大图 DOM 上限、390px 和 axe；这仍不表示 Windows Tauri 原生 panel/popout 已点击验收，需并入 WIN-P0-02 留证。
- Branch Mapping 前后端安全闭环已独立完成：正式全局 panel、Streams 页按钮/Dock/popout、虚拟列表与 opaque cursor、原样详情/View 语义、正反 `integrate -n` 只读影响预览，以及专用 preflight→confirm create/edit/delete 均已接入；Activity Bar 重复入口已移除。Client mapping/owner/unknown/TOCTOU/危险删除阻断、一次性 cursor/token、Tauri adapter 和明确 simulated 的 Browser Mock 均复用后端权威契约。Web 组件与真实 Edge 覆盖 390px、键盘、axe、大列表 DOM 上限、分页/迟到隔离和模拟增删改闭环。
- 历史记录：Force Unlock 曾完成前后端专用闭环并在首轮 Windows 原生验收执行过一次；用户随后明确决定移除该能力，因为 P4Deck 面向普通用户，管理员强制解锁应在后台执行。该历史不再代表当前产品能力或待验任务。
- Global Search 的 Stream/Shelf 深度搜索前后端闭环已完成：`SearchPage` 正式扩为七类筛选、facet、分组与 badge；Stream 结果显示服务端 path/name/owner/type/parent/description 摘要并显式定位到 Streams，Shelf 结果显示 numbered CL、owner/client/time/description 与后端已给出的匹配路径摘要并打开独立 Shelf detail。Shelf 仍按 500 条列表、128 个 detail 候选、8 个批次、每 shelf 256/总 20,000 文件及 20 秒预算保守截断，UI 会逐类别显示 `partialReason`，不宣称全量。分页保序去重、游标失效重搜、快速输入取消/迟到隔离、390px、键盘与 axe 已有 Web/真实 Edge 证据；Browser Mock 明示 simulated。
- 当前保留的三个用户优先功能为 Stream Graph、Branch Mapping、Global Search Stream/Shelf，均已完成代码闭环。上述浏览器或 fixture 证据不表示 Windows Tauri 原生 panel/popout/搜索导航、本人 Server 大规模与权限/trigger 已通过；它们分别并入 WIN-P0-02 与 WIN-P0-03/04，不改变 WIN-P0/P1/P2 的本机私用安全顺序，也不带入 Stream spec 写入。
