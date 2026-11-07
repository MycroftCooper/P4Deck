# Windows 本机私用 TODO

> **⛔ 2026-11-06 起冻结（只读）**：本表不再新增或推进任务；任务调度已迁移到本机 **Agent Team Kit**（`http://127.0.0.1:1421`，项目 `P4Deck`），新需求请在 ATK 网页用 **+ New request** 创建。本表仅保留历史结论、证据与数量口径。

> **状态真值已迁移。** 任务/批次状态以 [工作流/state.json](工作流/state.json) 为准（由 `node scripts/workflow/state.mjs import` 从本表机械生成，62 项口径已核对一致）。
> 本表保留为历史台账与详情来源；改状态优先改本表再运行 `node scripts/workflow/state.mjs import`（也可直接改 state.json），之后运行 `node scripts/workflow/state.mjs board` 刷新看板。
> 工作流入口：[工作流/README.md](工作流/README.md)。

> 历史叙事（S2B-QA / ACTION 集成 / 阶段2b / 当前批次调度）已于 2026-10-29T13:40:50.669Z 轮转至 [归档/TODO-叙事-2026-10.md](归档/TODO-叙事-2026-10.md)。
> 本文件只保留：数量汇总、唯一任务表、完成项归档、关联子项、验收定义。状态真值见 `工作流/state.json` 与 `工作流/当前批次.md`。

## 当前结论与状态口径

2026-10-28用户本次dev人工明确通过四项：Branch切换滚动无叠字、JSON正文/缩窄/隐藏恢复、CL正倒序/Default置顶及滚动条清晰、顶栏提交删除且Pending内保留。仅对应范围关闭，不要求重测；版本/环境未明确，不能外推安装包、所有DPI或原生故障。CON-05/UI-07条件chrome/CL-06-I3不在本次通过范围。

日常 P4 功能主体已有代码，不需要从零补 Pending/Submit/Shelf/Resolve/Graph/Search。当前首要问题是**安全验收入口未放行，以及最近 UI/History/Submitted 改动缺运行证据**。最新列表重叠修复、右侧导航和设置/关闭按钮迁移全部仍待运行验收。

- **已实现且有相应验收证据**：仅限标明日期/构建/场景的记录，不保证当前脏工作树全量无回归。
- **已实现待验收**：找到具体代码和契约；测试文件存在、TS/CSS/离线编译通过不等于测试执行或原生验收。
- **部分实现**：限定能力已经落地，仍有明确实现缺口或语义未证。
- **待实现**：明确下一步产出尚未完成；表内会标明是功能还是验收工作，不能把未跑测试说成未写功能。
- **受阻**：必须满足权限/环境/授权前置；不绕过、不盲重试。
- **建议待确认**：历史后置候选或范围扩大，不是用户已批准的新功能。

**安全优先于所有历史步骤**：只允许经证明的项目本地假 P4；公司生产禁止包括只读。旧 WIN-P0-03 及旧路线图中的本人 Server 操作冻结。不得为了收口清空用户 Profile、改全局配置/安全策略、安装 Agent 或禁用全部 QA。历史个人服务器退出条件不强迫当前任务触碰生产。

## 数量汇总（功能/工作包，不是菜单项数或测试数）

### 类型与状态独立记录

类型仅分三类：**Bug修复**（已有行为错误或回归）、**功能需求**（用户新增/改变行为，含UI优化及明确交付/验收工作）、**重构与代码优化**（内部复用、维护性或性能改造，外部行为不应改变）。类型不是状态；重构不能伪装Bug，需求批准不等于已实现，测试通过不等于验收归档。纯环境/权限受阻不是产品Bug，SAFE-02/03归功能需求的验收支持子标签，不据此派产品修复。

权威主表新增类型、负责人列，原ID/状态/优先级/证据/依赖保留。负责人表示职责归属而非当前执行授权，实际领取仍按PM队列；范围确认项的PM负责登记，不代表已派开发。旧条目按已知主目标分类：SAFE-01隔离缺口、SUB-05重叠、SUB-06时间语义排查为Bug；OPS-02缓存/取消/性能内部优化归重构优化；其他产品、交付与验收工作包归需求。SUB-06根因尚未证实，Bug分类不等于已经确认日期修法。

混合工作包按下方关联子项执行/验收。**55个活跃主工作包**（新增CL-07跨CL提交选中文件；2026-10-31 新增 DIFF-01/MERGE-01 并补登 UI-13；阶段与Bug子项不重复计数），子项不额外计数为新工作包；单个Bug修复或共享抽取通过，不把父项所有功能/验收一并关闭。同一证据可引用但不能重复计算完成数。原2项完成归档保留对应历史基线，不因分类改变重新宣称最新版本通过。

共 **70** 项（活跃 59 + 归档 11）：已实现且有相应验收证据 **30**、已实现待验收 **9**、部分实现 **8**、待实现 **10**、进行中（方案/实施分阶段）**0**、受阻 **2**、建议待确认 **2**。归档 11 项均已有验收证据；本次新增归档 4 项为 DIFF-01/DIFF-02/CL-06/CL-07（2026-11-04 人工验收收尾）。计数以 state.json 的活跃主工作包为准，不表示当前工作树通过编译。

| 模块 | 总数 | 有证据完成 | 实现待验收 | 部分 | 待实现 | 受阻 | 待确认 | 进行中 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 安全与验收 | 4 | 0 | 0 | 3 | 0 | 1 | 0 | 0 |
| 界面与导航 | 14 | 10 | 2 | 1 | 1 | 0 | 0 | 0 |
| 连接与工作区 | 4 | 2 | 1 | 1 | 0 | 0 | 0 | 0 |
| 文件与版本 | 8 | 4 | 0 | 2 | 0 | 0 | 0 | 0 |
| History | 2 | 1 | 1 | 0 | 0 | 0 | 0 | 0 |
| CL 工作流 | 8 | 5 | 2 | 1 | 0 | 0 | 0 | 0 |
| Submitted 与周报 | 7 | 5 | 1 | 1 | 0 | 0 | 0 | 0 |
| 搜索与分支 | 3 | 2 | 1 | 0 | 0 | 0 | 0 | 0 |
| 工具与可靠性 | 2 | 1 | 1 | 0 | 0 | 0 | 0 | 0 |
| 阶段收口 | 3 | 0 | 0 | 1 | 1 | 1 | 0 | 0 |
| 后续候选 | 2 | 0 | 0 | 0 | 0 | 0 | 2 | 0 |
| **合计** | **57** | **30** | **9** | **12** | **7** | **2** | **2** | **0** |

> 2026-10-31 增补：新增 **DIFF-01**（Diff 工具重做，整套替换 `@pierre/diffs` 1.6.2）与 **MERGE-01**（冲突合并工具重做，先接 P4Merge 外部合并）两个主工作包（活跃 52→54），并补登 **UI-13**（标题栏版本号，0.1.9 已实现，活跃 54→55）；当前活跃 55 + 归档 7 = 62。选型依据见 [预研-Diff与合并工具重做.md](预研-Diff与合并工具重做.md)，明细见唯一任务表。
> 2026-11-04 结项：DIFF-01（Diff 工具重做）、DIFF-02（Diff 计算层优化）、CL-06（公司自定义提交工具接入）、CL-07（跨 Pending CL 提交选中文件）均已完成人工验收收尾并登记验收，四项行已移入下方「完成项归档」；活跃主工作包 55→52，已实现待验收 13→9。
> 2026-11-06 登记：新增 5 个 0.1.12 重构主包 —— RUI-01（补回丢失的搜索页/预览本地化 UI 改动，P0）、RUI-02（收口 operationSession 与 ipc-surface 进行中工作，P0/进行中）、RUI-03（操作会话收敛，P1.5，依赖 RUI-02）、RUI-04（React 状态收敛，P1.5，依赖 RUI-03）、RUI-05（CSS 收敛，P1.5）。活跃主工作包 51→56，总数 63→68；回填早前漏计的部分实现行（上下文菜单英文映射，UI-02-B01）。
>
> 编号口径：决议与发布记录里的 **UI-12**（背景色 chrome 层次）对应子项 **UI-09-3**，不重复立主包；**UI-13**（标题栏版本号）原先只存在于决议/发布记录，本次补登为主工作包。

## 唯一任务表

证据列为实际源码或既有验收记录入口；旧日期测试只能证明对应旧版本。通用依赖 WIN-P0-02=最新原生 UI 冒烟、WIN-P0-04=隔离核心写入演练，沿用下方原编号及步骤，不重复计数为新功能。

> **依赖链**：「依赖」列可填任务 ID，也可填人类待办 ID（`T01`…）。填写后运行 `node scripts/workflow/state.mjs import`；任务完成后（accept/归档）或人类待办打钩后，下游任务会在 `queue`/看板自动变为就绪，不会自动改状态。规则见 [工作流 README §1.6](工作流/README.md)。
>
> **父子任务**：「关联子项」表（子ID / 父项）即父子关系。父任务在全部子任务完成前不能验收/归档；子任务可单独 `accept`；全部完成时父任务自动汇总完成。已验收的父任务不会因后来新增子任务被降级。

| ID | 类型 | 负责人 | 模块 / 范围 | 状态 | 优先级 | 证据路径 | 剩余步骤与验收标准 | 依赖 |
|---|---|---|---|---|---|---|---|---|
| GRAPH-01 | 功能需求 | FE＋BE（PM拆领取范围） | 文件与版本：聚焦修订图、目标合入证据与来源追溯（用户已批准） | 部分实现 | P1 | [FileReviewPage.tsx](../../src/features/browsers/components/FileReviewPage.tsx)；[数据缓存与操作架构.md](../Coder/数据缓存与操作架构.md) | 2026-10-27 单文件切片已编码：目标/来源模式、轨道隐藏/Solo、证据范围、共享缓存与并发取消/20次预算；去除默认 filelog -i。TS/CSS/离线cargo check通过，mock测试已写未运行、视觉未验。新增已编码：显式根目录/简单 Branch Mapping 正反向文件映射、CL逐文件记录汇总、目标/来源/共同中转各最多2页（最多2中转），所有读取共用2并发/缓存/取消与20次API尝试预算，100文件上限。剩余：复杂Stream导入/重映射、内容保留/部分集成精确验证、mock执行及视觉验收；当前只报集成记录与未知，不作内容已合/未合判断 | SAFE-02；QA-01 |
| SAFE-01 | Bug修复 | BE | 安全与验收：QA 只允许验证后的本地 fixture | 部分实现 | P0 | [p4d-fixture.ps1](../../scripts/p4d-fixture.ps1)；[context.rs](../../src-tauri/src/p4/context.rs) | 被动门禁已加；QA 持久化 Profile、恢复队列、环境回退仍未完整锁定。补加载/切换前拒绝与纯测试，不能全面禁用 QA 冒充隔离 | 无 |
| SAFE-02 | 功能需求 | 根协调；PM验收 | 安全与验收：运行入口身份与继承配置核验 | 受阻 | P0 | [本地假P4安全核验.md](../../ForAIDoc/Coder/本地假P4安全核验.md) | 用获准诊断证明实际 listener、二进制、root、无转发及凭据隔离；当前缺证，不可先 p4 info 再确认 | SAFE-01；受支持诊断权限 |
| SAFE-03 | 功能需求 | 根协调；PM验收 | 安全与验收：前端运行测试与可视验收通道 | 部分实现（专用通路已用，覆盖边界保留） | P0 | [playwright.config.ts](../../playwright.config.ts)；[vite.config.ts](../../vite.config.ts) | 恢复产品支持的测试通道；旧 Vitest spawn EPERM 未重试，2026-10-27 浏览器 file URL 明确拒绝，不通过 HTTP/换浏览器绕过 | 工具权限/产品修复 |
| QA-01 | 功能需求 | FE；根配置由根协调 | 安全与验收：可重复的独立无 P4 UI 验收入口 | 部分实现（已有专用入口，统一覆盖待收尾） | P0 | [playwright.config.ts](../../playwright.config.ts)；[dropdown-theme.spec.ts](../../tests/browser/dropdown-theme.spec.ts) | 已有静态 DOM 用例，但默认 Playwright 会启动/复用 dev 服务。补明确隔离、可运行入口与宽窄/折叠/下拉/虚拟列表证据，不声称当前样本已验收 | SAFE-03 |
| UI-01 | 功能需求 | FE | 界面与导航：导航迁到主工具栏右侧、设置末端、关闭全部在页签栏 | 已实现待验收 | P0 | [App.tsx](../../src/app/App.tsx)；[CommandBar.tsx](../../src/app/shell/CommandBar.tsx)；[ActivityBar.tsx](../../src/app/shell/ActivityBar.tsx)；[chrome.tsx](../../src/app/docking/chrome.tsx) | 最新仅 TS/CSS 检查；验六个入口、选中态、文字开关、窄窗溢出、分屏与关闭范围，左栏不留空列。新增用户明确删除顶层工具栏纸飞机“提交 CL”按钮（根已核对截图）；保留清单icon“待提交”导航、Pending CL内部提交按钮、原功能/确认流程和后端submit命令。此增量已落盘，本批10文件111mock与TS/diff通过（根转发）；新视觉待批准，不能外推实机验收 | FE本轮UI与入口回归；QA-01 |
| UI-02 | 功能需求 | FE | 界面与导航：固定页紧凑头、多开页 icon、主题与标题国际化 | 已实现待验收 | P1 | [chrome.tsx](../../src/app/docking/chrome.tsx)；[tokens.css](../../src/app/styles/tokens.css)；[index.ts](../../src/shared/i18n.ts) | 验深浅主题、150% DPI、tooltip、键盘和即时切语言；文件名不翻译 | QA-01 |
| UI-03 | 功能需求 | FE | 界面与导航：Dock/popout、快捷键、页签恢复 | 已实现待验收 | P1 | [useDockController.ts](../../src/app/docking/useDockController.ts)；[Windows原生UI验收.md](../../ForAIDoc/Coder/Windows原生UI验收.md) | 旧原生只部分；最新构建验分屏/归还/关闭重开/焦点/390px | SAFE-02；WIN-P0-01 |
| UI-04 | 功能需求 | FE | 界面与导航：全项目统一表格UI与可复用可拖列宽（用户已批准扩大范围） | 已实现待验收 | P1（打包前） | [全项目表格统一覆盖矩阵](../Designer/全项目表格统一覆盖矩阵.md)；[TableHeader.tsx](../../src/app/context-menu/TableHeader.tsx)；[useColumnWidths.ts](../../src/app/context-menu/useColumnWidths.ts) | 2026-10-28授权覆盖全部主页面/弹窗/子表/虚拟表，非仅合并候选。PM只读列出14个数据表/多列子表及12组边界入口；最新核对T01–T14及View编辑/详情已接共享列宽。Shelf表头/预览隔离已修，PM源码及PNG核实；原生表已从实际宽度起拖，代表浏览器记录40px拖动对应40px。候选缩放重复计高及History重测缓存已修，results.json记录无重叠/裁切。根转发最终5文件26通过、TS/diff通过，旧176/28不累计。仅workflow-audit1437纯mock代表性浏览器验证，非14表全视觉/原生WebView/假P4验收；证据见覆盖矩阵，未覆盖入口仍待验。保留既有布局、选择/排序/菜单/拖放；逐表验拖动、最小宽度、列宽隔离、长文本/窄屏/虚拟高度及拖动不误触。不额外实现排序/列显隐，不新增全局持久化；FE负责src，PM不改产品代码 | FE全覆盖；SAFE-03；QA-01；PKG-01等待本项回归及新源码冻结 |
| CON-04 | 功能需求 | FE＋BE（PM拆领取范围） | 连接与工作区：移除详情侧栏、四项行菜单（用户已批准） | 已实现待验收 | P1 | [WorkspacePage.tsx](../../src/features/workspaces/WorkspacePage.tsx)；[workspace_mutation.rs](../../src-tauri/src/app/workspace_mutation.rs) | Switch绑定右键行；New复用创建表单；Rename使用原生renameclient（2022.2+），Delete仅非force删除定义；预检/120秒单次token/重验/服务器写锁。当前workspace需先切走，其他保存profile引用不会自动改写。待mock交互与假服验证；不把菜单存在当运行验收 | SAFE-02；QA-01 |
| CON-01 | 功能需求 | FE＋BE（PM拆领取范围） | 连接与工作区：多 Profile、连接恢复、Workspace 切换/Root 校正 | 已实现待验收 | P1 | [connection_service.rs](../../src-tauri/src/app/connection_service.rs)；[ConnectionProfilesCard.tsx](../../src/features/settings/ConnectionProfilesCard.tsx) | 旧 localhost/部分原生证据存在；最新需假服验证迟到请求、切换失败不改连接、自动 Root | SAFE-02 |
| CON-02 | 功能需求 | FE＋BE（PM拆领取范围） | 连接与工作区：User/Workspace Browse 与受控新建 | 部分实现 | P1 | [connection_setup_service.rs](../../src-tauri/src/app/connection_setup_service.rs)；[ConnectionSpecCreateDialog.tsx](../../src/features/settings/ConnectionSpecCreateDialog.tsx) | Workspace 创建已有旧 fixture 证据；New User 成功路径曾被 AuthenticationRequired 阻断，需专用 fixture 权限与原生验证 | SAFE-02 |
| CON-03 | 功能需求 | BE | 连接与工作区：P4VFS 新建虚拟 Workspace | 已实现待验收 | P2 | [vfs_service.rs](../../src-tauri/src/app/vfs_service.rs)；[P4VFS虚拟Workspace.md](../../ForAIDoc/Coder/P4VFS虚拟Workspace.md) | 已有前后端约束；真实 Agent/首次读取未验。仅新建，不转换旧 Workspace、不代装 Agent | SAFE-02；现成受控 Agent 环境 |
| FILE-01 | 功能需求 | FE＋BE（PM拆领取范围） | 文件与版本：Workspace/Depot 树、预览、状态与缓存 | 已实现待验收 | P1 | [ResourceExplorer.tsx](../../src/features/files/components/ResourceExplorer.tsx)；[workspaceQueries.ts](../../src/features/files/workspaceQueries.ts)；[FilePreviewPage.tsx](../../src/features/browsers/components/FilePreviewPage.tsx) | 旧自动化/fixture 基线不覆盖最近壳变动；验长路径、大树、离线缓存、连接隔离。新增JSON小文件正文空白：根报告BE7测试正常、data.content已到FE，FE已落盘JSON高度候选，本批10文件111mock及TS/diff通过；BE7测未改生产。最新JSON合成视觉已闭环：11场景、7/7mock及TS/diff通过，PM核results.json及前后截图，viewport0基线与修后正文可见；非原生/全部文件验收 | PM队列；SAFE-02；QA-01 |
| FILE-02 | 功能需求 | FE＋BE（PM拆领取范围） | 文件与版本：Sync/Get Revision/Edit/Add/Delete/Revert/Reconcile、普通 Lock/Unlock | 已实现待验收 | P1 | [file_service.rs](../../src-tauri/src/app/file_service.rs)；[sync_service.rs](../../src-tauri/src/app/sync_service.rs)；[file_lock_service.rs](../../src-tauri/src/app/file_lock_service.rs) | 已有窄契约与旧 localhost；最新原生预检/取消/目标快照/partial 复核，禁止真实工作区写入 | SAFE-02；WIN-P0-04 |
| FILE-03 | 功能需求 | FE＋BE（PM拆领取范围） | 文件与版本：Rename/Move | 部分实现 | P2 | [rename_service.rs](../../src-tauri/src/app/rename_service.rs)；[RenameDialog.tsx](../../src/features/files/components/RenameDialog.tsx) | 单文件已接且有旧 fixture；目录、跨 Workspace、覆盖、case-only 明确阻断，不列为已完成。是否扩范围需确认 | 范围确认；SAFE-02 |
| FILE-04 | 功能需求 | FE＋BE（PM拆领取范围） | 文件与版本：Diff、Revision Graph 与精确历史比较 | 已实现待验收 | P1 | [PageRenderer.tsx](../../src/app/PageRenderer.tsx)；[DiffView.tsx](../../src/features/browsers/components/DiffView.tsx)；[historyDiff.test.tsx](../../src/app/docking/historyDiff.test.tsx) | 验选中 #revision 到新独立 Diff 的真实请求参数、不回退 have/head、不受全局选择污染；旧 Diff 基线不能覆盖最新参数链 | QA-01；SAFE-02 |
| HIS-01 | 功能需求 | FE | History：四列表格、年日期、拖列宽、描述展开、FIFO 两选 | 已实现待验收 | P1 | [HistoryTable.tsx](../../src/features/browsers/components/HistoryTable.tsx)；[useRecordSelection.ts](../../src/app/context-menu/useRecordSelection.ts) | 测试源码存在，最新交互未跑；验 A→B→C 留 B/C、先后双色及aria/tooltip、右键不重排、长描述/空时间/双语 | QA-01 |
| HIS-02 | 功能需求 | FE＋BE（PM拆领取范围） | History：右键 CL 预览/Get/Undo/Diff 与全局差异入口 | 已实现待验收 | P1 | [ReadOnlyPages.tsx](../../src/features/browsers/components/ReadOnlyPages.tsx)；[UndoDialog.tsx](../../src/features/files/components/UndoDialog.tsx)；[undo_service.rs](../../src-tauri/src/app/undo_service.rs) | Undo 是单文件指定 revision 真 undo，非 sync/revert；6 项纯 Rust 历史通过，不等于 P4 执行验收。验预览/取消/一次确认、后选 Get、双选精确 Diff | SAFE-02；FILE-04 |
| CL-01 | 功能需求 | FE＋BE（PM拆领取范围） | CL 工作流：Pending 表单、文件移动/拖放、Default 与分页 | 已实现待验收 | P1 | [PendingPage.tsx](../../src/features/changelists/components/PendingPage.tsx)；[changelist_service.rs](../../src-tauri/src/app/changelist_service.rs) | 旧 localhost/自动化已有；最新验默认 CL 唯一、长列表、选择、跨 CL 移动/失败刷新 | SAFE-02；WIN-P0-04 |
| CL-02 | 功能需求 | FE＋BE（PM拆领取范围） | CL 工作流：Submit 预检、执行与结果复核 | 已实现待验收 | P1 | [submit_service.rs](../../src-tauri/src/app/submit_service.rs)；[FileClWorkflow.tsx](../../src/features/changelists/components/FileClWorkflow.tsx) | 已有旧 fixture 闭环；最新验阻断项/取消/重复确认/连接变化与安全清理 | SAFE-02；WIN-P0-04 |
| CL-03 | 功能需求 | FE＋BE（PM拆领取范围） | CL 工作流：Shelf/Unshelve/Resolve/手工文本合并 | 部分验收（用户 2026-10-30：Shelf/Unshelve 通过；Resolve/手工文本合并不通过，待返工） | P1 | [workflow_service.rs](../../src-tauri/src/app/workflow_service.rs)；[manual_merge.rs](../../src-tauri/src/app/manual_merge.rs)；[ShelfDetailPage.tsx](../../src/features/changelists/components/ShelfDetailPage.tsx) | 已有旧 fixture；最新原生完整流程及 Shelf deep-path 跳转仍缺，验 CAS/备份/冲突保留 | SAFE-02；WIN-P0-04 |
| UI-08 | 功能需求 | FE（PM拆领取范围） | 界面与导航：Resolve 对话框与手工合并工具重做（对齐 P4V 与 UGit） | 待实现 | 暂停（后置；2026-10-30 用户调整优先级） | [ResolveDialog.tsx](../../src/features/files/components/ResolveDialog.tsx)；[ManualMergeEditor.tsx](../../src/features/files/components/ManualMergeEditor.tsx) | 用户验收明确判定当前临时实现不达标；先调研出参考规格再重做。参考目标：P4V 老版 Resolve 窗口（[官方说明](https://legacy-docs.perforce.com/doc.current/manuals/v17.2/p4v/branches.resolve.html)）与腾讯 UGit 冲突解决界面（[介绍](https://cloud.tencent.com.cn/developer/article/2482449)）。不改 host resolve 语义/安全边界（blocked/unknown 不执行、token/digest 校验），只重做呈现与交互；与参考截图逐项对照 + 用户验收通过前不关闭 CL-03 | CL-03；UI-08-1 |
| MERGE-01 | 功能需求 | FE＋BE（PM拆领取范围） | CL 工作流：冲突合并工具重做（先接 P4Merge 外部合并，保留现有安全链） | 已实现待验收 | P1 | [预研-Diff与合并工具重做.md](预研-Diff与合并工具重做.md)；[ManualMergeEditor.tsx](../../src/features/files/components/ManualMergeEditor.tsx)；[workflow_service.rs](../../src-tauri/src/app/workflow_service.rs) | 用户 2026-10-31 选定先直接调用 P4Merge 确保能用；仅检测已安装不打包；从现有手工会话生成 base/theirs/yours/result 四临时文件，等待 P4Merge 退出后读回 result，放入现有 Result 供用户复核，再走现有 validate/save token + 原子写 + `p4 resolve -ay` 复核；未安装/取消/超时/超限明确降级；不改 resolve 策略与 blocked/unknown 语义；GUI 启动不做自动测试，真机冒烟交用户 | CL-03；SAFE-02；UI-08（后续 UI 重做再议） |
| CL-04 | 功能需求 | FE＋BE（PM拆领取范围） | CL 工作流：全局 CL 详情弹窗与 Go To CL | 已实现待验收 | P1 | [ChangeDetailsDialog.tsx](../../src/features/changelists/components/ChangeDetailsDialog.tsx)；[SubmittedGoTo.tsx](../../src/features/changelists/components/SubmittedGoTo.tsx) | 已抽查 History/Pending/Submitted/FileReview/工具栏共享打开动作，搜索通过 App 导航继续核验覆盖；取消/迟到隔离代码已接；Go To 明确仅 submitted，验错误/空/长内容/关闭回焦点，不改筛选 | QA-01；SAFE-02 |
| SUB-01 | 功能需求 | FE | Submitted 与周报：单用户筛选、无 Client/Job、预设迁移与即时应用 | 已实现待验收 | P1 | [submittedFilters.ts](../../src/features/changelists/submittedFilters.ts)；[SubmittedFilterPanel.tsx](../../src/features/changelists/components/SubmittedFilterPanel.tsx) | schema4 丢弃旧隐藏条件，保留当前 Stream；验 reset/保存/恢复/空预设与不重复刷新 | QA-01 |
| SUB-02 | 功能需求 | FE＋BE（PM拆领取范围） | Submitted 与周报：Stream 多选 OR、当前快捷项、稳定分页 | 已实现待验收 | P1 | [repository.rs](../../src-tauri/src/p4/changelists/repository.rs)；[submittedFilters.test.ts](../../src/features/changelists/submittedFilters.test.ts) | 两项纯 Rust 并集测试通过；最多16项、去重、扫描不全报错；需 mock/fixture 验实际分页、当前+显式及换连接 | SAFE-02；QA-01 |
| SUB-03 | 功能需求 | FE | Submitted 与周报：普通/疑似 CI/自动生成分类 | 已实现待验收 | P1 | [submittedReport.ts](../../src/features/changelists/submittedReport.ts)；[SubmittedPage.tsx](../../src/features/changelists/components/SubmittedPage.tsx) | 精确元信息签名的启发式，不验证 CI 身份；仅筛已加载记录，验数量诚实性/不吞人工同描述 CL | QA-01 |
| SUB-04 | 功能需求 | FE | Submitted 与周报：单用户日期区间生成周报提示词 | 已实现待验收 | P1 | [submittedReport.ts](../../src/features/changelists/submittedReport.ts)；[SubmittedReportDialog.tsx](../../src/features/changelists/components/SubmittedReportDialog.tsx) | 独立分页、最多100页/5000候选、完整描述和CL引用、部分结果标记；本地生成且仅点击复制。验跨周/时区/取消/上限/遗漏，不上传 AI | QA-01；SUB-06 |
| SUB-05 | Bug修复 | FE | Submitted 与周报：结果虚拟行重叠修复、CL 展开、紧凑筛选与结果摘要 | 已实现待验收 | P0 | [ChangelistPage.tsx](../../src/features/changelists/components/ChangelistPage.tsx)；[workbench.css](../../src/app/styles/workbench.css)；[SubmittedPage.test.tsx](../../src/features/changelists/components/SubmittedPage.test.tsx) | 当前摘要64px、展开自然高度，ResizeObserver正值测量更新虚拟行偏移/总高，忽略隐藏页零测量；文件复用外层滚动视口，已替代固定324px方案。此前静态检查通过不等于当前追踪WIP全量编译通过。验100+行、多CL展开/收起、0/1/多文件、筛选折叠/resize、宽窄与150%缩放、下拉不裁切；Depot/Stream与起止日期各同排 | QA-01 |
| SUB-06 | Bug修复 | FE＋BE（PM拆领取范围） | Submitted 与周报：查询时间边界与 Depot Path 诊断 | 部分实现 | P1 | [submittedFilters.ts](../../src/features/changelists/submittedFilters.ts)；[command.rs](../../src-tauri/src/p4/changelists/command.rs) | 本地时间转UTC后格式化无时区 P4 日期，8h差能解释但服务端解释未证；需假服已知时区边界验证后决定修法。裸 Depot Path 原样，Stream 加 /... 已有1项纯参数测试 | SAFE-02；不猜真实 depot |
| SEARCH-01 | 功能需求 | FE＋BE（PM拆领取范围） | 搜索与分支：七类全局搜索、Stream/Shelf 深度搜索 | 已实现待验收 | P1 | [SearchPage.tsx](../../src/features/search/SearchPage.tsx)；[search_service.rs](../../src-tauri/src/app/search_service.rs) | 已非待开发；旧原生看到类别/Stream跳转，Shelf deep-path 到详情与大规模 partial/权限仍待验 | SAFE-02；CL-03 |
| SEARCH-02 | 功能需求 | FE＋BE（PM拆领取范围） | 搜索与分支：Stream 切换与只读 Graph | 已实现待验收 | P1 | [stream_switch_service.rs](../../src-tauri/src/app/stream_switch_service.rs)；[StreamGraphPage.tsx](../../src/features/browsers/components/StreamGraphPage.tsx) | 旧 fixture切换/原生5节点已验；最新验切换预览/可选sync、缩放键盘与独立窗口 | SAFE-02 |
| SEARCH-03 | 功能需求 | FE＋BE（PM拆领取范围） | 搜索与分支：Branch Mapping 列表/详情/预览/受控CRUD | 已实现待验收 | P1 | [branch_mapping_service.rs](../../src-tauri/src/app/branch_mapping_service.rs)；[BranchMappingsPage.tsx](../../src/features/browsers/components/BranchMappingsPage.tsx) | 旧原生正向预览和fixture CRUD有证据；反向、窄屏、popout与权限/trigger边界需补。新增用户异机列表重叠反馈：根目视截图为81/81条、多行约10px间隔叠字、底两行正常、外围UI正常；本机未复现，0.1.2影响未确认，不能据截图断定根因。根已派FE仅此修复与mock视觉，根最新报告候选修复7测通过、像素未验；按PM队列在自然检查点核实源码与待验项，不重新打断FE；此前代表表验收不覆盖该页 | FE限定缺陷核查；纯mock视觉；真实假P4另依赖SAFE-02 |
| OPS-01 | 功能需求 | FE＋BE（PM拆领取范围） | 工具与可靠性：Terminal/P4 Log/Journal/诊断脱敏 | 已实现待验收 | P1 | [ToolArea.tsx](../../src/features/tools/ToolArea.tsx)；[runner.rs](../../src-tauri/src/p4/runner.rs)；[log_store.rs](../../src-tauri/src/persistence/log_store.rs) | 受控终端与日志链已有；最新验快捷键/独立窗口/上下文隔离/仅Error红点、日志不抢焦点/导出脱敏 | SAFE-02；UI-03 |
| OPS-02 | 重构与代码优化 | FE＋BE（PM拆领取范围） | 工具与可靠性：共享缓存、取消/代次隔离、大列表性能 | 已实现待验收 | P1 | [useSnapshotQuery.ts](../../src/shared/cache/useSnapshotQuery.ts)；[status_cache.rs](../../src-tauri/src/app/status_cache.rs)；[项目状态总览.md](../../ForAIDoc/PM/项目状态总览.md) | 旧100k基准仅历史设备与版本；最新验连接切换不串数据、上限和长滚动，无固定性能阈值时不宣称性能认证 | QA-01；WIN-P2-01 |
| OPS-03 | 功能需求 | BE | 工具与可靠性：Swarm 安全链接 | 已实现待验收 | P2 | [swarm_open.rs](../../src-tauri/src/app/swarm_open.rs)；[Swarm基础链接.md](../../ForAIDoc/Coder/Swarm基础链接.md) | 只做URL打开、无API/评论/创建Review；本轮禁止外部请求，安全测试先mock，真实外部验收另授权 | 明确外部验收授权 |
| WIN-P0-01 | 功能需求 | PM（实现按需领取） | 阶段收口：最新原生构建/启动/版本绑定 | 部分实现 | P0 | [Windows原生构建运行验收.md](../../ForAIDoc/Coder/Windows原生构建运行验收.md) | 旧94b5f0c等证据不代表当前7af7671+脏工作树；记录源码快照、产物hash与原生退出，勿要求先清除用户改动 | SAFE-02 |
| WIN-P0-03 | 功能需求 | PM（实现按需领取） | 阶段收口：历史本人 Server 验收 | 受阻 | 不执行 | [开发路线图.md](../../ForAIDoc/PM/开发路线图.md) | 当前禁止生产包括只读；保留历史项但冻结，不作为AI下一动作，也不要求用户现在授权生产 | 当前用户安全约束 |
| WIN-P2-01 | 功能需求 | PM（实现按需领取） | 阶段收口：连续2小时稳定性验收记录 | 待实现 | P2 | [Windows本机私用TODO.md](../../ForAIDoc/PM/Windows本机私用TODO.md) | 这是未执行验收任务，不是缺少功能代码；最新假服构建覆盖重启/切换/日志/列表，记录资源与故障，关闭P0后进行 | WIN-P0-01；WIN-P0-02/04 |
| OPT-01 | 功能需求 | PM（实现按需领取） | 后续候选：Labels/Jobs独立工作台、Stream spec写入、全量高级菜单 | 建议待确认 | 未排期 | [catalog.ts](../../src/app/context-menu/catalog.ts)；[开发路线图.md](../../ForAIDoc/PM/开发路线图.md) | 静态数到190个phase:later；不是190项已承诺任务。选择实际需要的场景再立项，Force Unlock已明确退役不可恢复 | 用户范围决定 |
| OPT-02 | 功能需求 | PM（实现按需领取） | 后续候选：跨平台/发布/兼容矩阵/自动更新/外部认证 | 建议待确认 | 未排期 | [开发路线图.md](../../ForAIDoc/PM/开发路线图.md)；[后端TODO.md](../../ForAIDoc/PM/后端TODO.md) | macOS/ARM/多版本/签名/updater/remote CI不是当前私用阻塞；SSL/SSO/MFA仅新需求下评估，不因功能盘点自动开发 | 用户交付目标决定 |
| UI-05 | 功能需求 | FE | 界面与导航：Appearance主题色预设＋自定义（用户已批准） | 已实现待验收 | P1 | [SettingsPage.tsx](../../src/features/settings/SettingsPage.tsx)；[usePreferences.ts](../../src/app/hooks/usePreferences.ts)；[tokens.css](../../src/app/styles/tokens.css)；[并行交接](并行交接.md) | 根转发FE已完成并停写：5个预设＋自定义、预览/保存/跨窗口同步已实现，语义颜色独立。FE报告TS/CSS/format/diff通过；2026-10-28根转发正式require_escalated原命令exit 0，5文件19项纯mock全部通过（2＋1＋7＋4＋5），源码与冻结一致、本轮无修改；React act环境警告无失败。视觉及假P4尚未验。仍需验证浅深主题、非法输入、刷新/重开/跨窗口同步与布局不回归；静态色值计算不关闭验收 | FE；SAFE-03；QA-01 |
| SUB-07 | 功能需求 | FE＋BE（PM拆领取范围） | Submitted 与周报：CI结构化来源CL引用链及自身workspace（用户最新替换需求） | 已实现待验收 | P1 | [并行交接最新规格](并行交接.md)；[全项目表格统一覆盖矩阵](../Designer/全项目表格统一覆盖矩阵.md) | 以CI描述完整已识别元数据中的来源CL号建反向索引/有向边，从源CL计算直接/间接可达合并CL，逐条显示其自身client/workspace；合并来源路径仅作来源证据，不是目标workspace。不要求正文相同，不查integrated/文件，不匹配正文数字/issue或CL号子串。缓存提交描述与引用索引，串行有界分页累积后重算可达，支持乱序页、取消/续查及未完整短状态；当前筛选不限制调查。旧正文匹配实现/测试仅历史证据；根转发新引用链及虚拟叠字/紧凑顶部/删作者已落盘，21文件176通过，最终列宽后6文件28再通过，TS/diff通过（批次可能重叠）。PM只读确认结构化完整CL号解析与反向索引可达计算；纯mock浏览器视觉进行中，原生/假P4未验。需验直接/多跳、子先父后、同CL多路径/环/重复页、数字边界、缺失/畸形元数据、缓存与失败/取消。UI-04拖宽复用、删候选作者列/两句长说明及紧凑顶部继续，主表作者不动。用户最新要求时间统一显示本地年月日时分，尤其调查范围/读取时间，不显示UTC/ISO/时区说明；仅改展示，不改内部query边界。根已确认范围起止均调用formatLocalTime（DescriptionTraceDialog:414，ChangelistPage:222实际入口），读取/提交时间也本地化，toISOString仅用于内部query；3文件19通过、TS/diff通过。已交BE更新staging/hash，旧截图不代表新格式，不外推新视觉验收 | FE＋BE新链路；UI-04；SAFE-03；QA-01；实际假P4验证仍依赖SAFE-02 |
| CON-05 | 功能需求 | FE | 连接与工作区：无生效P4配置的强制启动引导（用户已批准） | 已实现待验收（合成UI已通过） | P1 | [gate证据](../../tests/qa/preview-audit/gate-evidence/results.json)；[并行交接](并行交接.md) | 无有效激活配置引导设置，验证成功放行；已配临时断网不当首次。最新初始焦点修至配置按钮，21合成浏览器断言＋47相关mock/TS/diff通过；PM核JSON/源码/390px图。真实Gate但配置卡片/CLI/关闭为替身，不能证明真实认证/下载/原生关闭；保留迟到/连接代次/错误恢复与端到端门槛。合成阶段收尾，不计整包完成，不打包 | 实际连接依赖SAFE-02；原生关闭依赖UI-07宿主验收 |
| CL-05 | 功能需求 | FE | CL 工作流：Pending编号数值正倒序按钮（用户已批准） | 已验收（用户 2026-10-30：CL 编号排序验证通过） | P1 | [pending证据](../../tests/qa/preview-audit/pending-evidence/results.json)；[并行交接](并行交接.md) | 11浏览器断言＋23mock边界/刷新、TS/diff通过，无新增产品改动。PM核JSON/hash及390px图Default/2/10/100顺序；合成验升降序、选择展开、菜单拖放目标、既有偏好及零额外读取。真实Pending逻辑但数据/菜单/移动确认替身，不能外推真实P4执行或全包；保留Default特殊位置和现有交互 | 真实操作依赖SAFE-02；本项合成阶段收尾 |
| UI-06 | 功能需求 | FE | 界面与导航：全局横纵滚动条对比与边界（UI优化） | 已验收（用户 2026-10-30：全页面/窄窗滚动条通过） | P1 | [滚动条覆盖](../../tests/qa/preview-audit/scroll-evidence/coverage.json)；[并行交接](并行交接.md) | 双主题28实际拖动及4窄窗150%检查通过，另2无横向溢出不计实际拖动；17mock/TS/diff通过，无产品改动。PM核矩阵/JSON/hash及Dockview截图，表格/虚拟表/预览真实组件，弹窗/侧栏/嵌套部分结构替身。保留Windows WebView、OS overlay/高对比、未实例化Dockview自绘纵条缺口；不能宣称全平台/所有页面验收 | 原生/OS覆盖待验；本轮合成矩阵收尾 |

| RUI-01 | 重构与代码优化 | LEAD（协调）＋FE＋BE | 交付：补回 0.1.12 丢失的搜索页/预览本地化 UI 改动 | 已实现待验收 | P0 | [SearchPage.tsx](../../src/features/search/SearchPage.tsx)；[searchModel.ts](../../src/features/search/searchModel.ts)；[search.css](../../src/app/styles/search.css)；[FilePreviewPage.tsx](../../src/features/browsers/components/FilePreviewPage.tsx)；[localizeError.ts](../../src/shared/localizeError.ts) | 2026-11-06 重做完成：FE 5bbe55d（11 文件，SearchPage 8 例含「等待 400ms 零请求 / Enter 恰好一次 / 改输入取消且迟到响应不渲染」硬断言；全量 vitest 1834 绿），LEAD 78014b7 同步 i18n 基线；剩余=用户抽验。原记录：| 2026-11-04 已在 dev 完成并验证（搜索 7→6 类去 Job、去掉 300ms 自动搜索改为点击/Enter、删标题与分割线、结果区铺满、预览/路径错误按语言本地化），但 i18n 分支基于 00052b3 合并回 dev 后这批改动丢失；按当前 t()/catalog 写法重做，验收=6 类、无自动触发、无标题/分割线、预览错误中英双语 | 无 |
| RUI-02 | 重构与代码优化 | LEAD（协调）＋FE＋BE | 交付：收口 operationSession 与 ipc-surface 进行中工作 | 已实现待验收 | P0 | [src/shared/operationSession/](../../src/shared/operationSession/)；[validate-ipc-surface.mjs](../../scripts/validate-ipc-surface.mjs) | 2026-11-06 已提交并验证：LEAD 614bce5（ipc-surface + operationSession 模块）、BE 0014ab2（bounds/confirmation 迁移，537 Rust 测试绿）、FE ba6bc10（26 个 src 文件收口，1832 web 测试绿）；vite 排除 node:test 套件后全量门禁干净；剩余=用户抽验。原记录：| 工作树已有未提交改动（43 文件）：operationSession（session/useOperationSession + 14 个对话框迁移）、validate-ipc-surface 静态校验（Rust 命令↔invoke↔Backend↔事件）；验收=ci-fast 与定向测试绿、ipc-surface 进 CI、提交代码并记录 | 无 |
| RUI-03 | 重构与代码优化 | FE＋BE（PM拆领取范围） | 重构：操作会话收敛（取消/代次/迟到隔离统一） | 部分实现 | P1 | [operationSession](../../src/shared/operationSession/)；[useConfirmationGuard.ts](../../src/shared/confirmation/useConfirmationGuard.ts)；[snapshots.ts](../../src/shared/cache/snapshots.ts) | 2026-11-06 已迁移 7 页：ResolveDialog（8cb7183）、LogView（a8620a3）、SubmittedPage（8090c34）、DiagnosticsView+OperationJournalView（c8116a5）、ConnectionProfilesCard（91409e4）、SearchPage（c48b7fd）；ChangelistFormDialog（d069ba9）+ SearchPage 安全整数防护（1b63135）；全量 vitest 1851 绿；全仓仅剩 ToolPanel 3 处（已论证排除）；三页论证排除（ToolPanel/StreamGraph/BranchMapping，需「分页会话模型」立项）。通用规则：先清 busy/loading 再 finish；改输入用 finish 而非 abandon；非回显型 requestGeneration 保留原单调 seq。 | RUI-02 |
| RUI-04 | 重构与代码优化 | FE | 重构：React 状态复杂度收敛（useState 集中页面转 reducer） | 待实现 | P1 | [ConnectionProfilesCard.tsx](../../src/features/settings/ConnectionProfilesCard.tsx)；[SubmittedPage.tsx](../../src/features/changelists/components/SubmittedPage.tsx)；[SearchPage.tsx](../../src/features/search/SearchPage.tsx) | 前置：RUI-03 剩余两页（ConnectionProfilesCard、SearchPage）完成后再开；三页（ToolPanel/StreamGraph/BranchMapping）已论证排除，其状态收敛需等「分页会话模型」立项。原记录：| 2026-11-06 完成（4 页改 + 1 页论证跳过）：UnshelveDialog 34cfb0d（14→7）、SyncDialog 8dd0872（10→6）、MoveFilesDialog d2caa15（10→7）、ShelfDialog aa48967（9→3），四个文件原测试一行未改全过、全量 vitest 1851 绿；ConnectionProfilesCard 论证不做（155 处单字段散写，reducer 化只是 setter→dispatch 机械替换）。**指标修正**：真正产生收益的是「同一套字段清理/推进规则的重复次数 4→1」，而非 useState 计数；建议后续同类任务以「转移规则重复次数 ≥3 才 reducer 化」为验收指标，本任务结论记为部分达成（降低重复规则、未显著降低字段总数）。 定口径：| 现状 322 处 useState，单文件最多 20 个（ConnectionProfilesCard 20、SubmittedPage 19、BranchMappingsPage 18、SearchPage/FileReviewPage 17）；验收=迁移后状态依赖可枚举、定向组件测试全绿、无行为变化 | RUI-03 |
| RUI-05 | 重构与代码优化 | FE | 重构：CSS 收敛（workbench.css 拆分 + 排版刻度 + token 化） | 已实现待验收 | P1 | [workbench.css](../../src/app/styles/workbench.css)；[tokens.css](../../src/app/styles/tokens.css) | 2026-11-06 完成：FE2 2b0609f 按域拆分（workbench 4269→643，798 规则/2412 声明零丢失）+ 391417c 字号 16 token（297/298 映射，逐字节等价）与 13 处色值 token 化；同文件重复块 3 处保留（改动层叠无法证明等价）。后续可选（单独立项、有视觉影响）：字号收敛为 6~8 档。原记录：| 现状 workbench.css 4225 行/81KB、字号 17 种（10/11/12px 占 250 处）、tokens 仅 42 个变量、硬编码色值 109 处；验收=按域拆分、引入排版刻度变量、theme-contrast 与视觉回归通过 | 无 |
| RUI-06 | 重构与代码优化 | FE＋BE（PM拆领取范围） | 重构：分页会话模型（组合层 PagedChain + owner 最小增量） | 待实现 | P1（RUI-04 之后） | [src/shared/operationSession/](../../src/shared/operationSession/)；[StreamGraphPage.tsx](../../src/features/browsers/components/StreamGraphPage.tsx)；[BranchMappingsPage.tsx](../../src/features/browsers/components/BranchMappingsPage.tsx)；[ToolPanel.tsx](../../src/features/tools/ToolPanel.tsx) | RUI-03 论证出三页不适合现有「单 channel 单租约」模型：StreamGraph/BranchMapping 是**续期式分页**（loadMore 沿用同一 generation、restore 从快照恢复历史 generation），而 owner 的 start 即 supersede 会打断分页；两页与 ToolPanel 的取消都是**多 id 集合**（activeOperations: Set），owner 单 id 表达不了，硬迁会漏取消。2026-11-06 设计提案已完成（ForAIDoc/Coder/RUI-06-分页会话模型-设计提案.md）：**结论与立项描述相反——owner 不需要改**。Rust 侧核实 requestGeneration 是纯回显+非零校验（SGS 6 处、BMS 12 处无一处相等比较），故契约代次可直接取 lease.epoch、src-tauri 零改动；同代次串行租约与多 id 取消用组合层 PagedChain 表达（8 页零改动）；ToolPanel 属另一问题，拆出 RUI-07。LEAD 裁决采纳方案 B（判据复杂度不换概念数量）。分期：一期模块+StreamGraphPage 试点，二期 BranchMappingsPage。2026-11-06 第 1 期 a 阶段完成（fe 85cd2d0）：新增 `pagedSession.ts`（118 行代码，零依赖）+ 6 个单测（兄弟隔离/settle-cancel/单请求 abandon/死链请求/channel 独立/游标 stall），`session.ts` 纯新增 `cancelLive`+`liveOperationIds` 两个方法（既有语义零改动）；写测试时自查出「只 abort 不取消宿主」的真 bug；generation 用 per-channel 独立单调计数（不用 owner.epoch，避免与 request channel epoch 脱节）。b 阶段完成（fe d5a13d1）：StreamGraphPage 6 个手写 ref 清零（activeOperations/requestToken/requestGeneration/consumedCursors/pendingCursors/session.current），接 paged.open/request/isCurrent + CursorLedger，原 6 例未改全过（含精确 cancel 断言）；实测改动 +122/−107，与 arch 估算 −120/+60 相差近一个数量级（真实原因：估算只算删掉的账本、没算约 20 处成对改写、游标两态→三态、侧栏独立请求边界）；试点中自行发现并修正「侧栏 Stream 用首页 token 判活会被静默丢弃」的非等价点。二期完成（fe 1316dde）：BranchMappingsPage list/detail/preview 三链各持独立 PagedSession、统一从 cancelAll 一处退役，7 个手写 ref 清零，原 8 例未改全过，新增三链同死断言；三条链 cancelBackend 均为 true（已被取代时 id 已发宿主）；实测 +151/−157（净 −6）。**结项：全仓 generation.current 仅剩 ToolPanel 3 处（RUI-07）**。收益性质：StreamGraph 是结构收益（+122/−107 净 +15，不往估算凑），BranchMapping 是取消路径从 5 处散落收敛到 2 个具名入口 + 1 个统一门，非行数收益；arch 估算 −120/+60、−150/+80 均低估近一个数量级（只算删掉的账本、未算约 20 处成对改写、游标两态→三态、侧栏独立请求边界）。验收=三页迁完后全仓无 generation.current 手写判活（ToolPanel 的订阅与终端执行另议），原测试不改全过 + 三类断言 | RUI-04 |
| RUI-07 | 重构与代码优化 | BE＋FE（PM拆领取范围） | 重构：工具面板会话现状的决策记录 + 两处收窄 | 已实现待验收 | P2（RUI-06 之后） | [ToolPanel.tsx](../../src/features/tools/ToolPanel.tsx)；[ToolDrawer.tsx](../../src/features/tools/components/ToolDrawer.tsx) | 2026-11-06 设计提案完成（ForAIDoc/Coder/RUI-07-订阅式会话-设计提案.md）：**立项三条前提中两条经核实不成立**——(1) 终端取消**现状即单路**（ToolDrawer :107/:120/:440 三入口全受 runningRef 守卫，P2→P3 间实例已销毁，ToolPanel 卸载必带走 ToolDrawer；「双路」是迁移动作才引入的风险）；(2) 订阅无 id/无完成点/无取消语义（cancel_operation("") 在 commands.rs:1292 直接判 unknown），现有 live+subscribeSafely 已覆盖未注册完就卸载/泄漏/注册失败/StrictMode 四种失效，**不进 owner 是正确结论**；(3) temporaryId 经核为纯回显（runner.rs:372-376，仅约束非空≤256，零相等比较）。另发现立项书漏掉的第二宿主 ToolArea.tsx。裁决：RUI-07 定性为「决策记录 + 两处收窄」（钉住 temporaryId 回显契约、取消按钮连点去重），不做 OperationSessionRegistry / SubscriptionScope。待定 Q1：事件跨连接串台（真问题，需一次可交互复现）。2026-11-06 收尾完成：决策记录落档（ForAIDoc/Coder/前端架构与维护约定.md cc29e8e「操作会话的三条边界」「立项描述是待验证的假设」两节）+ 两处收窄（fe 00eb62b：temporaryId 回显契约注释与空回显保留、取消按钮连点只发一次；新增 3 断言，验证过 stash 修复后连点断言会变红，证明断言非摆设）。**待定 Q1：事件跨连接串台**——需可交互复现（开终端→跑长命令→执行中切连接→观察是否混入旧输出），当前无隔离环境，记为待用户人工观察，不假装修复。验收=决策记录落档 + 两处收窄有断言 + 取消仍单路 | RUI-06 |
| UI-07 | Bug修复 | BE宿主先行；FE自然检查点协作 | 界面与导航：WebView导航/初始化失败时保留关闭与恢复通道 | 部分实现（旧原生兜底已撤销，待CHROME-OFF替换；CLOSE独立继续） | P0 | [tauri.conf.json](../../src-tauri/tauri.conf.json)；[TopBar.tsx](../../src/app/shell/TopBar.tsx)；[并行交接](并行交接.md) | 根核实截图为Edge ERR_CONNECTION_REFUSED/127.0.0.1，无应用标题栏或关闭按钮。主窗decorations=false、devUrl=127.0.0.1:1422；截图无端口，未证明dev断服或生产资源错误，0.1.2影响未知。先核查实际构建/导航路径及原生关闭生命周期；网页不可达也须有宿主级关闭保障，React边界仅覆盖页面内错误。故障注入验主窗/popout/启动引导/初始化失败、系统关闭快捷键及未保存/在途操作保护；不得强杀/静默丢失、不改代理防火墙。纯mock不等于原生关闭验证 | BE1纯策略11/11已审核；FE1A完成；BE2发现旧文档身份不可证；PM冻结v1.1保持wire，未验证clean一律unknown并原生确认，FE1根报告82＋1测试/TS/diff通过，PM核4场景TopBar JSON及390px图；BE2根报告12纯测试＋11策略回归/libcheck/fmt/diff通过，PM抽查v1.1宿主接线；实现阶段收尾，原生故障验收明确挂起，现释放JSON-only待根代转，不归档全项；隔离原生验收另证；不自动打包 |


| UI-09 | 功能需求 | FE | 界面与导航：设置里支持自定义背景色（主题色之外） | 已验收（用户 2026-10-30：自定义背景色验收通过） | P2 | [BackgroundColorSettings.tsx](../../src/features/settings/BackgroundColorSettings.tsx)；[background.ts](../../src/features/settings/background.ts) | 设置“背景色”：预设 + 取色器/十六进制 + 恢复默认，深浅主题自适应对比度，偏好持久化；0.1.8 已发布并获用户验收；子项 UI-09-1/2/3 分别记录实现与验收 | 无 |
| UI-11 | 功能需求 | FE | 界面与导航：标签页 session（首启只开待提交、重启恢复上次标签） | 已实现待验收（0.1.9 已发布） | P1，0.1.9 | [usePageNavigation.ts](../../src/app/hooks/usePageNavigation.ts)；[usePageNavigation.test.ts](../../src/app/hooks/usePageNavigation.test.ts) | 首启只开 Pending；主窗口持久化打开页+激活页（上限 12、版本容错、未知页过滤、关闭同步、损坏回退、幂等），11 项 vitest 覆盖；0.1.9 已随版本交付，待人工确认重启恢复体验 | 无 |
| UI-13 | 功能需求 | FE | 界面与导航：标题栏显示应用版本号（0.1.9 补登） | 已验收（用户 2026-10-31 看板点验收通过） | P1，0.1.9 | [TopBar.tsx](../../src/app/shell/TopBar.tsx)；[useAppVersion.ts](../../src/app/shell/useAppVersion.ts)；[TopBar.version.test.tsx](../../src/app/shell/TopBar.version.test.tsx) | 标题栏显示 `P4Deck v<version>`（tooltip 为完整版本号），版本取自运行时 app version，加载中不显示；0.1.9 已发布；2026-10-31 用户在看板点验收通过 | 无 |
| UI-14 | 功能需求 | FE | 界面与导航：设置页自适应填满 + 模块折叠 + 设置导航 | 已实现待验收 | P1，0.1.9 | [SettingsPage.tsx](../../src/features/settings/SettingsPage.tsx)；[SettingsNav.tsx](../../src/features/settings/SettingsNav.tsx)；[SettingsSection.tsx](../../src/features/settings/SettingsSection.tsx) | 右侧空白填充（导航+内容两栏、auto-fit 多列、表单 max-width 480）；8 模块折叠（aria-expanded/持久化/损坏回退全展开）；sticky 导航+scroll-spy+键盘；窄屏降级；tsc 0、定向 12 文件 85 用例过；真实视觉/窄窗待人工验收 | 无 |
| UI-15 | 功能需求 | BE＋FE | 界面与导航：P4 可执行文件/自定义提交工具加文件选择按钮 | 已实现待验收 | P1，0.1.9 | [ConnectionProfilesCard.tsx](../../src/features/settings/ConnectionProfilesCard.tsx)；[executablePicker.ts](../../src/features/settings/executablePicker.ts) | tauri-plugin-dialog 2.8.4 双侧接入+仅 dialog:allow-open；两字段后浏览按钮（桌面显示、取消/失败安全、不自动保存）；tsc 0、picker 9 用例 + SettingsPage 38 通过；真实桌面点击待人工验收 | 无 |
| KEY-01 | 功能需求 | FE＋BE | 界面与导航：快捷键系统（P4V 对齐 + 设置可配置 + 持久化） | 已实现待验收（0.1.8 已发布） | P2 | [catalog.ts](../../src/app/commands/catalog.ts)；[ShortcutSettingsCard.tsx](../../src/features/settings/ShortcutSettingsCard.tsx)；[快捷键P4V映射.md](../Designer/快捷键P4V映射.md) | 四阶段（P4V 映射调研、catalog 统一分发、Settings 录制/冲突/恢复默认、keymap 持久化）已在 0.1.8 发布并有 vitest 覆盖；待人工确认默认键位、输入框保护、冲突提示与跨重启生效 | 无 |

## 完成项归档（历史基线有证据，不外推最新版本）

分类仅重整台账，不新增完成结论。混合项子项见后表，父项的完成总数仍按主表唯一ID统计。

| ID | 类型 | 负责人 | 模块 / 范围 | 状态 | 优先级 | 证据路径 | 关闭范围与回归边界 | 依赖 |
|---|---|---|---|---|---|---|---|---|
| WIN-P1-01 | 功能需求 | BE | 工具与可靠性：故障恢复与退出进程回收 | 已实现且有相应验收证据 | 归档 | [故障恢复与配置备份.md](../../ForAIDoc/Coder/故障恢复与配置备份.md) | 2026-10-22 Debug/HMR+隔离fixture原生记录含断服/ticket/离线重启/取消/执行中退出；完成限该基线，最新构建回归纳入OPS-01 | 旧基线证据；非本轮重跑 |
| WIN-P1-02 | 功能需求 | BE | 工具与可靠性：非敏感备份/恢复/回滚与DPI恢复 | 已实现且有相应验收证据 | 归档 | [backup.rs](../../src-tauri/src/persistence/backup.rs)；[故障恢复与配置备份.md](../../ForAIDoc/Coder/故障恢复与配置备份.md) | 2026-10-22原生创建/退出恢复/pre-restore回滚与凭据canary有记录；不是普通备份可含凭据，最新回归并入WIN-P0-02 | 旧基线证据；非本轮重跑 |

| PKG-01 | 功能需求 | BE | 阶段收口：其他设备可用的Windows体验包（候选已交付，安装未验） | 已验收（用户 2026-10-30：Windows 体验包安装/启动/卸载/跨设备通过） | 归档 | [Windows体验包交付](../Coder/Windows体验包交付.md)；历史包产物已清理，sha/大小记录见交付记录 | 2026-10-28已产出0.1.2 x64 NSIS候选，223452134 bytes，PM核对文件大小/SHA-256与artifact-info一致；具体hash及位置见交付记录。staging TS/生产前端/Rust release/NSIS通过，源码变化0、检查标记未命中（根转发BE）。内置微软签名有效离线WebView2；不捆P4 CLI，配置/PATH/标准目录统一发现，缺失官方获取/重新检测，自定义路径可能需指定。安装包NotSigned；干净安装/启动/卸载及跨设备均未验，不归档为完全验收，不保证直接可用。用户已获位置及限制。新增异机Branch Mapping列表重叠反馈，是否属于0.1.2尚未确认；当前候选不因旧代表表证据获得全页验收，也不视为含最新Branch叠字、JSON空白修复或CON-05启动引导。上述实现可并行，最终集成回归须使用同一新源码；视觉隔离入口运行批准待用户，暂不构建或发布新包 | 仅剩获准隔离安装/启动/卸载及跨设备验收；禁止生产访问/公开发布；其他项目停工 |
| PKG-02 | 功能需求 | BE调研；FE/BE按PM阶段派单 | 阶段收口：检查新包、提示并由用户点击自动更新 | 已验收（用户 2026-10-31：0.1.8→0.1.9 检查/提示/点击更新成功） | 归档 | [并行交接R任务单](并行交接.md)；[tauri.conf.json](../../src-tauri/tauri.conf.json) | 当前未见updater依赖、createUpdaterArtifacts=false。只读评估Tauri2官方updater/NSIS、更新签名与OS签名、可信HTTPS发布源、版本渠道/失败恢复、UI-07安全退出及首个updater版本迁移；R→S→I→V分别验收。默认不强制/静默安装，不上传账号/P4配置/遥测。用户无现成托管，GitHub Releases为候选，用户已确认安装包公开可接受，可独立发行仓库不公开源码；owner/repo尚未指定，不能自行创建/上传，禁止客户端共享PAT或假定浏览器cookie可供updater；公开GitHub Releases方案待具体目的地与发布权限，离线UPD-S01移至最后，当前不推进实现；源码不获公开许可，不生成私钥、不部署/上传/接受协议。根转发R结论：0.1.2无updater需首次手装支持版；自动检查提示保留，手动检查不能替代；Windows安装前必须BE完成UI-07许可同锁交接，FE不得直install | UI-07安全关闭；PKG-01安装验证；发布源/签名方案；R可空闲BE先行，实施不打断FE既有队列 |
| UPD-01 | 功能需求 | BE＋FE（PM拆领取范围） | 交付：自动升级（GitHub Releases public + 标题栏提示 + 下载安装重启） | 已验收（用户 2026-10-30 0.1.7→0.1.8、2026-10-31 0.1.8→0.1.9 两次真机自动升级成功） | 归档 | [tauri.conf.json](../../src-tauri/tauri.conf.json)；[scripts/package-desktop.mjs](../../scripts/package-desktop.mjs) | 用户已定：放 **GitHub Releases（public）**。要点：Tauri2 updater（createUpdaterArtifacts=true、pubkey、`latest.json` endpoint）、updater 签名密钥（私钥不进仓库）、启动/定时检查、标题栏“有新版本”提示、点击下载→安装→重启、失败/回退/无网提示；首个带 updater 版本需手动安装一次。仓库 owner/repo、密钥生成与保管、首个版本手装确认待用户对齐 | — |
| DIFF-01 | 功能需求 | FE | 文件与版本：Diff 工具重做（整套替换 @pierre/diffs 1.6.2，Apache-2.0） | 已验收（用户 2026-11-04：真实窗口人工验收通过） | 归档 | [预研-Diff与合并工具重做.md](预研-Diff与合并工具重做.md)；[DiffView.tsx](../../src/features/browsers/components/DiffView.tsx) | 2026-11-04 用户确认真实窗口视觉验收通过并按人工验收登记归档；关闭范围限本项 UI/渲染替换，不改变后端口径（DiffResult/unified+leftText/rightText），双平台原生矩阵仍不在本项范围 | — |
| DIFF-02 | 重构与代码优化 | FE | 文件与版本：Diff 计算层优化（Rust hunk 直供渲染库，去掉前端二次 diff） | 已验收（用户 2026-11-04：真实窗口人工验收通过） | 归档 | [DiffView.tsx](../../src/features/browsers/components/DiffView.tsx)；[diffNavigation.ts](../../src/features/browsers/diffNavigation.ts) | 与 DIFF-01 同批人工验收通过；关闭范围限前端计算层（parsePatchFiles→FileDiff+loadDiffFiles），旧基准数据不外推其他规模或设备 | DIFF-01 |
| CL-06 | 功能需求 | BE调研；FE/BE由PM分阶段派单 | CL 工作流：自定义提交工具配置与原提交入口分流 | 已验收（用户 2026-11-04：人工验收收尾通过） | 归档 | [并行交接调研任务单](并行交接.md)；[custom_submit.rs](../../src-tauri/src/app/custom_submit.rs) | 2026-11-04 用户确认人工验收收尾通过，按既有 Mock 切片关闭；真实公司工具执行、cwd/认证优先级/后台生命周期仍未验证，仍受安全红线约束 | — |
| CL-07 | 功能需求 | FE＋BE；QA独立 | CL 工作流：跨多个Pending CL提交选中文件 | 已验收（用户 2026-11-04：本机假 P4 人工验收通过） | 归档 | [并行交接](并行交接.md)；[selected_submit.rs](../../src-tauri/src/app/selected_submit.rs) | 2026-11-04 用户在本机假 P4 上完成跨 CL 选文件→新建 CL→自定义/原生提交的真实链路人工验收；关闭范围限本项流程，部分失败不回退/不回移语义保持不变 | CL-01；CL-02；CL-06 |
## 下一批最优先任务

### 混合工作包关联子项（分别验收，不重复计数）

| 子ID / 父项 | 类型 | 负责人 | 优先级 | 状态 | 依赖 | 验收证据与剩余标准 |
|---|---|---|---|---|---|---|
| CL-03-R01 / CL-03 | 功能需求（返工） | FE＋BE | 功能需求（返工） | 待实现 | 待用户补充失败现象后定 | 无 | Resolve/手工文本合并验收不通过（用户 2026-10-30）：需重做冲突解决与手工文本合并的交互/结果核对，保留 CAS/备份/冲突保留语义；返工后重新验收 | 用户失败场景/截图；UI-08 可能合并处理 |
| CON-01-F01 / CON-01 | 功能需求（UI布局） | FE；QA | P1，UI-T01同批 | T01限定QA通过/残余保留；I3改动待复验 | 连接设置局部布局/回归 | User与Workspace各仅保留浏览（放大镜真实选择功能）并置input同行右侧、同高度主题；仅删除本处新建入口，保留Workspace Root输出、其他创建/后端及保存验证，窄屏不挤压 |
| UI-01-F02 / UI-01 | 功能需求（入口精简） | FE；QA | P1，UI-T01同批 | T01限定QA通过/残余保留；I3改动待复验 | 顶toolbar组配置及定向回归 | 仅删眼睛icon“CL详情/查看CL详情”工具栏入口，保留旁边刷新、共享弹窗/右键预览/GoTo及后端；与提交CL去重分项验收，不全局删动作 |
| CL-05-F01 / CL-05 | 功能需求（UI视觉修整） | FE；QA | P1，UI-T01同批 | T01限定QA通过/残余保留；I3改动待复验 | 与Branch Owner复用已有控件样式 | Pending主页面过滤input与CL排序button灰原生样式，根核约35px且已对齐；仅主题/边界/状态统一，保留既有布局与高度；不改排序/筛选/新建/提交确认、不增加查询，两页同批QA视觉回归，截图细节待根补充 |
| SEARCH-03-F01 / SEARCH-03 | 功能需求（UI视觉修整） | FE；QA | P1，下一UI批 | T01限定QA通过/残余保留；I3改动待复验 | 复用现有控件样式；截图像素待根补充 | Branch Owner输入框/按钮统一高度/主题/圆角/边界/间距/基线与窄屏换行，仅局部样式；不改筛选/不增加查询，与UI-07-F01可同批分别验收 |
| UI-07-F01 / UI-07 | 功能需求（UI外观） | BE方案；FE/QA后续按批 | P1，近期方案优先 | CHROME-I01已放行（I3手验独立） | 动态decorations/当前窗控ready协议/原生隔离验收 | 正常恢复自绘窗控，仅页面失效无可用窗控时原生兜底；always decorations=true不满足最新要求。先核Tauri能力、同URL旧ready/后台节流/恢复与DPI，不打断M01；关闭仍统一安全协调 |
| UI-02-B01 / UI-02 | Bug修复 | FE；QA协作 | P1，当前批内最小收尾 | 已验收（英文＋稳定ID套件72/72） | QA-I2 labels冻结安全交接 | 既有“重命名工作区…”缺英文映射导致菜单测试失败；仅补映射/定向回归，新hash重冻结；菜单C01-10/C02-14/C12-04及C09/W01文档漂移PM已补，收尾批一次复验，不混算产品Bug |
| SEARCH-03-B01 / SEARCH-03 | Bug修复 | FE | P1 | 用户dev人工通过（限定范围） | FE自然检查点核对；获批专用入口及Branch fixture覆盖 | 根报告Branch81行叠字候选7测通过，像素未验；核对源码与测试，再验证81条/滚动/缩放无重叠。父项CRUD不因本Bug关闭自动归档 ；2026-10-28用户明确四项通过，登记09:45:09 UTC，具体版本/环境未提供，见交接原话 |
| FILE-01-B01 / FILE-01 | Bug修复 | FE；BE按需协作 | P1 | 用户dev人工通过（限定范围） | data.content已到FE；安全mock | 根报告BE7测试正常；FE高度候选已落盘，本批10文件111mock/TS/diff通过，新视觉未验；仍需验证虚拟挂载，验0尺寸、隐藏重显、resize、空/错误及原正文换行；不重复后端已证检查 ；2026-10-28用户明确四项通过，登记09:45:09 UTC，具体版本/环境未提供，见交接原话 |
| UI-01-F01 / UI-01 | 功能需求（UI优化） | FE；QA验收 | P1 | 用户dev人工通过（限定范围） | 既有steer修改先核实 | 只去顶栏纸飞机提交CL按钮；待提交导航、Pending内部提交和确认/后端命令保留。根转发已落盘，本批10文件111mock及TS/diff通过，新视觉待批准 ；2026-10-28用户明确四项通过，登记09:45:09 UTC，具体版本/环境未提供，见交接原话 |
| UI-04-R01 / UI-04 | 重构与代码优化 | FE | P1，既有切片 | 已实现待验收（限定代表验证） | UI-04可拖列宽需求；覆盖矩阵 | 共享useColumnWidths/ColumnResizer/ResizableTable等抽取接入已有源码，最终5文件26通过及代表浏览器结果见矩阵；状态隔离/虚拟高度/交互兼容，不宣称14表全视觉。父项仍为用户拖列宽功能需求，抽取不另计完成 |
| SUB-05-F01 / SUB-05 | 功能需求（UI优化） | FE | P1，既有切片 | 已实现待验收 | SUB-05虚拟行Bug回归；QA-01 | 紧凑筛选、结果摘要、自然展开等用户需求与重叠Bug分别判断；旧静态/限定mock证据不外推全部新布局像素通过 |
| UI-08-1 / UI-08 | 功能需求（调研） | FE；PM | P1 | 待实现 | 无 | 调研 P4V 老版 Resolve 窗口与腾讯 UGit 冲突解决界面（截图/录屏/键盘路径），输出布局规格：分区、列、按钮、状态色、自动/交互模式、逐文件与批量操作；列出与本实现差异及不可复制项（外部 merge tool、行尾空白选项等） |
| UI-08-2 / UI-08 | 功能需求（UI重做） | FE | P1 | 待实现 | UI-08-1 | 按规格重做 Resolve 主窗口：文件表（目标/来源/类型）、推荐操作区、逐文件选项、批量操作、空/加载/失败态；保持 host 现有策略与 token 安全边界不降低 |
| UI-08-3 / UI-08 | 功能需求（能力核对） | FE＋BE | P1 | 待实现 | UI-08-1 | 核对行尾/空白选项与“二进制按文本合并”的 host 能力边界；可实现则接入，否则明确禁用文案与原因，不伪造可用控件 |
| UI-08-4 / UI-08 | 功能需求（交互增强） | FE | P2 | 待实现 | UI-08-2 | 参考 UGit 的逐块冲突导航：冲突块上一/下一、接受当前块/两侧对比跳转；先评估 host 是否提供块级事实，无法权威支持则不做假块操作 |
| UI-08-5 / UI-08 | 功能需求（UI重做） | FE | P1 | 待实现 | UI-08-1 | 重做手工合并工具（ManualMergeEditor）：P4V Merge + UGit 风格三栏/逐块导航/接受块/保存校验与备份提示；保留现有 session/validate/save/resolve 生命周期，不绕过结果 digest 校验 |
| UI-08-6 / UI-08 | 功能需求（验收） | FE；用户 | P1 | 待实现 | UI-08-2；UI-08-5 | 与参考截图逐项对照并交用户验收；保留对照截图/录屏证据；用户明确通过前不标记完成、不关闭 CL-03 |
| UPD-01-1 / UPD-01 | 功能需求（调研/方案） | BE；PM | P1 | 已验收（随 0.1.9 交付） | 无 | 调研 Tauri2 updater + NSIS 产物 + GitHub Releases：pubkey 配置、`latest.json` 格式与 endpoint、签名命令、安装/回退路径；输出可选仓库（release-only public）与发布流程方案；列出与 Windows 安装包签名/首次手装的边界 |
| UPD-01-2 / UPD-01 | 功能需求（BE集成） | BE | P1 | 已验收（随 0.1.9 交付） | UPD-01-1 | 集成 updater：启动检查 + 定时检查（间隔可配）、仅提示不静默安装、下载进度、安装并重启；失败/断网/校验失败有明确提示；不记录账号/P4 配置/遥测 |
| UPD-01-3 / UPD-01 | 功能需求（FE UI） | FE | P1 | 已验收（随 0.1.9 交付） | UPD-01-1 | 标题栏“有新版本 vX.Y.Z”入口 + 更新面板：版本说明、下载进度、稍后、立即重启安装；与现有 WindowControls/CommandBar 布局兼容；无更新时不打扰 |
| UPD-01-4 / UPD-01 | 功能需求（发布流水线） | BE＋PM | P1 | 已验收（随 0.1.9 交付） | UPD-01-1 | 版本发布流水线：版本一致性校验、构建、签名 updater 产物、生成 `latest.json`、上传 GitHub Release（public）；记录 sha/签名/资产清单；失败不发布半成品 |
| UPD-01-5 / UPD-01 | 功能需求（验收） | PM；用户 | P1 | 已验收（随 0.1.9 交付） | UPD-01-2；UPD-01-4 | 端到端验收：手装旧基线版→发布新版本→标题栏提示→下载安装→重启后版本更新；覆盖无网/中断/签名不匹配/回退；证明不静默安装、不上传敏感信息 |
| UI-09-1 / UI-09 | 功能需求（UI） | FE | P2 | 已实现待验收（0.1.8 已发布） | 无 | 设置“背景色”自定义：预设 + 取色器/十六进制输入、恢复默认；主题深/浅色下文字与选中态对比度检查；偏好持久化、重启生效；BackgroundColorSettings.tsx + background.test.ts 覆盖 |
| UI-09-2 / UI-09 | 功能需求（验收） | FE；用户 | P2 | 已实现且有相应验收证据（用户 2026-10-30 验收背景色） | UI-09-1 | 截图对照验收：深/浅背景 + 自定义背景下的可读性、弹窗/菜单/表格/状态色一致性；用户 2026-10-30 确认背景色功能通过（0.1.8 自动升级后）；UI-09-3 的 chrome 层次另记 |
| UI-09-3 / UI-09 | 功能需求（UI） | FE | P1，0.1.9 | 已实现待验收（0.1.9 已发布，决策名 UI-12） | UI-09-1 | 自定义背景色后，工具栏/标题栏/标签栏/侧栏/状态栏也要跟随（同色系 3-4 级层次、略有区别）；默认“跟随主题”外观保持不变；BackgroundColorSettings 的浅/深预览已含 chrome 层；待人工确认层次与对比度 |
| UI-11-1 / UI-11 | 功能需求（首启默认） | FE | P1 | 已实现待验收（0.1.9 已发布） | 无 | 无 session 记录时只打开 Pending；移除“默认全开标签”行为；保留连接 gate/深链/通知导航；usePageNavigation.test.ts 首启用例覆盖 |
| UI-11-2 / UI-11 | 功能需求（session 恢复） | FE | P1 | 已实现待验收（0.1.9 已发布） | UI-11-1 | 持久化打开页+激活页（仅主窗口、上限、版本容错）；启动恢复并过滤未知页；关闭页面同步；损坏回退 Pending；测试幂等；usePageNavigation.test.ts 其余 10 项覆盖 |
| KEY-01-1 / KEY-01 | 功能需求 | FE；PM | P2 | 已实现且有相应验收证据（映射文档） | 无 | 调研 P4V 默认快捷键（Windows：菜单/工具栏/面板），输出 P4V 键位→P4Deck 命令映射清单、冲突与不迁移项（保留系统/输入法冲突说明）；产出 [快捷键P4V映射.md](../Designer/快捷键P4V映射.md) |
| KEY-01-2 / KEY-01 | 功能需求 | FE | P2 | 已实现待验收（0.1.8 已发布） | KEY-01-1 | 按 P4V 习惯在 app/commands/catalog.ts 补齐全局+页面快捷键；统一 commandForShortcut 分发，保留输入框保护/平台 Ctrl-Cmd/风险与确认不绕过；冲突测试更新；keymap.ts + catalog.test.ts 覆盖 |
| KEY-01-3 / KEY-01 | 功能需求 | FE | P2 | 已实现待验收（0.1.8 已发布） | KEY-01-2 | Settings 新增“快捷键”分区：按分组列出命令/当前键/可用条件；点击录制新键；实时冲突提示；恢复默认；不可用原因显示；ShortcutSettingsCard.tsx + 10 项测试覆盖 |
| KEY-01-4 / KEY-01 | 功能需求 | FE | P2 | 已实现待验收（0.1.8 已发布） | KEY-01-3 | keymap 持久化（本地配置文件，随 profile 独立；版本号/迁移；损坏回退默认）；重启后生效验证；与命令面板标签一致；keymapPersistence.ts + 测试覆盖 |

CL-06需求阶段：CL-06-R只读调研由空闲BE领取，R只读调研已完成，S已审核mock边界，真实启动契约以独立R2只读证据/必要隔离实验计划推进，不等不存在文档；CL-06-S已根据独立报告审核最小方案/安全边界，三组维护者问题见交接；CL-06-I实施验收依赖已确定方案并在FE原六项队列后领取。三阶段均属功能需求（不是重构，R仅表示Research），不额外计工作包；R有完成报告，S有审核结论，I尚未实施/验收。验收要求及禁止项见交接任务单。

待办分类视图：Bug队列当前为SEARCH-03-B01在手项自然收尾→UI-07（P0）→FILE-01-B01；需求后继为CON-05→CL-05→UI-06→UI-01-F01。重构优化仅保留UI-04-R01及OPS-02既有证据/未验范围，本次不插入新重构任务。归档只保留主表WIN-P1-01/02两项历史完成；SEARCH-03-B01及FILE-01-B01已按各自合成复现与修后证据关闭，父项SEARCH-03及全包未归档；主工作包数量不变。

### 最新调度覆盖：UI-06限定浏览器通过，释放UI-01-F01-only

PM已读取branch-evidence/results.json并查看before/after-hidden-restored-exposed.png：旧隐藏恢复出现叠字，修后分行正常。24条检查为前后各12组，修后12组overlap/overflow均false，errors/blocked空；末组含index95，96条末行可达。源码baseline/current hash已记录。根报告7/7mock、TS/diff通过、无外部请求、专用服务已关闭。SEARCH-03-B01仅该具体缺陷合成场景验收闭环，不外推Branch CRUD、原生WebView、他人设备或0.1.2新包。主表SEARCH-03保持实现待验收，完成主包仍2项。

Branch已自然停笔，旧capacity恢复待办及“当前执行Branch”段落仅留历史，禁止再次续派。当前UI-07：FE1及BE2实现阶段已收尾，原生故障验收挂起；JSON-only已合成闭环，CON-05及CL-05合成UI已通过，UI-06限定矩阵通过，UI-01-F01-only任务单已释放待根代转。以下BE1/契约等待文字为历史步骤，以交接顶部最新记录为准。契约经PM确认后才派FE布局/状态适配、BE宿主接线；随后JSON。原生故障注入未执行，不打包。

### 当前执行队列（历史步骤结合上述最新调度）

**当前执行项：FE已自然收尾，代码不重做；六项进入待验收检查点，用户已批准专用synthetic-only视觉入口，当前仅释放SEARCH-03-B01验收，根转交曾确认started；FE原turn因model capacity失败无最终报告，部分文件/进程/证据待恢复核对。PM已拟一次保留现模型的同线程恢复单，直接派发durable失败，根已确认恢复turn 01a1815f-a7b1-722f-8134-22b556b21639 started，结果待回报，不重复恢复。UI-07 BE只读诊断完成、S已审，BE1待代转，FE不追加新功能。** 根最新确认：JSON高度候选、CON-05启动引导、CL-05排序、UI-06滚动条、UI-01删顶提交均落盘，10文件111mock＋TS/diff通过；Branch候选此前7测通过。专用配置 `src/test/preview-audit/vite.config.mjs` 现获用户批准，执行/结果仍待确认；白名单当前主要覆盖FilePreview，Branch缺失须精确补synthetic fixture而非放开App，0.1.2不含这些改动。以下队列仍保留验收顺序；旧获取FE状态失败是历史，不覆盖本次根转发结果。 FE线程 `01a18135-e9c5-7728-9d7d-73616359bca7` 的只读状态获取失败（durable host unavailable），以下按根已提供证据排序，不冒认FE当前正在某一子项。根在其自然检查点转发这份状态请求：六项分别已改哪些文件、是否已测/结果、未做部分、当前安全停笔状态；不要追加实现指令。PM收到后跳过已证实完成的实现，先验后派。

| 顺序/现有ID | 领取内容与当前证据 | 验收与后继条件 |
|---|---|---|
| 1 SEARCH-03-B01（Bug） | 原turn capacity失败，根已确认同线程恢复started，结果待回报；先核已产文件/服务/证据，不能当未发生；Branch Mapping 81行叠字；根报告候选修复7测通过，像素未验。保留修复，不重新盲写 | 核对7测范围与源码，获批后纯fixture复现81条及滚动/缩放/行高无重叠；未批准只做已获准检查，像素验收挂起，不记完成 |
| 2 UI-07（P0 Bug） | BE先只读核查主窗无原生装饰、导航失败与关闭保护；FE在Branch自然检查点后协作，当前不打断 | 先回报最小宿主方案/故障注入计划，经PM拆定实现与验收；不能只加React错误边界或建议任务管理器；不自动进入后继 |
| 3 FILE-01-B01（Bug） | JSON小文件正文空白；BE7项测试正常，data.content已到FE，FE查虚拟挂载。BE保持空闲，除非PM依据证据派接口协作 | 保留原JSON文本/换行；验content已到但容器初始0尺寸、挂载/隐藏再显示、resize/滚动、空文件与错误状态。不能以BE通过推定前端已修；不重跑生产读取 |
| 4 CON-05（需求） | 无生效P4配置强制引导；已散发，已落盘，本批111mock通过，视觉未验 | 配置加载完再判定，设置/CLI获取/退出可达，验证成功放行、失败可恢复；已配临时断网不误当首次，迟到结果/代次隔离 |
| 5 CL-05（需求） | Pending CL编号数值正倒序；已落盘，本批111mock通过，视觉未验 | 数值2/10、Default特殊位置、空/单条、选择/展开/菜单/拖放保持，排序不额外查询 |
| 6 UI-06（需求/UI优化） | 全局横纵滚动条对比/边界/hover-active浅深主题；非Pending局部 | 表格/弹窗/侧栏/预览及嵌套滚动逐入口核对；保留布局/列宽/虚拟高度、两方向可见可拖、窄屏缩放；视觉批准未答不能算已验 |
| 7 UI-01-F01（需求/UI优化） | 仅删顶toolbar纸飞机“提交CL”；已落盘，本批111mock通过，视觉未验 | 待提交导航与Pending内部提交、确认流程、后端命令均保留；验入口去重/键盘/窄窗，不执行生产提交 |

每次仅释放一项执行并审查证据，完成再归档；若运行批准阻塞，PM明确挂起其验收后才可释放独立下一项，状态保持未验，不由执行者自动跳队。原六项均挂在既有ID；UI-07为新增一个Bug工作包。最新P0插队安排覆盖旧六项顺序描述，不打断Branch在手操作。当前优先处理用户报告的可见缺陷，再启动引导，再排序/滚动条及入口去重；实际已有实现不回退、不重复劳动。最终合并验收绑定同一新源码，暂不打包。长期调度规则见[并行交接](并行交接.md)。

并行交接已确认停笔，根线程已释放文档写权限。FE只写 `src/**`，BE只写 `src-tauri/**`，PM只写 `ForAIDoc/**`；`scripts/**` 与根配置由根线程协调。共享IPC先由BE提出并经根线程转发确认，TS类型/adapter/mock由FE单写；双方未确认前不把草稿标成冻结契约。

离线实现可与下述验收前置并行：UI-05与SUB-07前端切片已停写，TS错误已修；SUB-07后端已停写且定向回归/libcheck通过，下一步由FE核对最终契约与获准mock通路，再协调最小运行验证。全项目表格UI与可拖列宽已明确授权（UI-04）；不得扩大至额外排序/列显隐、目录Move或高级菜单；不得用静态通过替代运行验收。

1. **SAFE-01/02/03 + QA-01**：先完成可用隔离验收通道与 fail-closed QA 配置。安全核验失败时仅做离线工作；当前机器 connected/authorized 不代表 CIM、子进程或浏览器协议限制已解除。
2. **SUB-05 + UI-01**：以最新工作树先验用户刚报错的列表重叠，以及导航/设置/关闭入口。验100+条、展开文件、多次切页/筛选折叠、窄宽窗口和150%缩放，记录尺寸和截图；仍失败就定位，不再只用 CSS/类型检查结案。
3. **FILE-04/HIS-01/02 + CL-04**：假 backend 精确断言两侧 #revision；FIFO、右键目标、CL弹窗快切迟到；再在安全假服上做 Get/Undo 预览、取消与确认闭环。
4. **SUB-01/02/04/06**：补预设迁移、Stream OR 分页、周报完整性和时间边界证据；实际请求参数与UI一致，不把候选扫描上限当完整数据。
5. 合入 **WIN-P0-01/02/04 → WIN-P2-01** 的本机阶段收口。历史已完成恢复/备份无需重新开发，但应随最新构建回归。

## 真正缺实现与需要决定的范围

- **新增已确认功能**：UI-05主题色预设/自定义已实现待验收；SUB-07前端切片已完成，后端校验及整体语义/运行证据仍待收束。两项已纳入上表，不再作为表外新增计数。

- **当前安全缺口**：QA加载/恢复/切换的 fixture 绑定不完整；有门禁脚本不等于隔离闭环。优先修，不恢复无条件禁用QA方案。
- **当前未接通的产品能力**：通用表头排序/列配置仍明确 disabled；History独立拖列宽例外。Rename/Move仅单文件安全子集，范围外操作有意阻断；它们属于部分实现，不是隐藏按钮就算完成。
- **需要用户选择**：额外排序/列显隐是否需要（全项目可拖列宽已批准）、是否扩目录/case-only Move；是否需要 Go To 同时查 pending（当前 submitted-only，原请求未承诺新增）；P4VFS 是否准备实际使用。未决定前不扩功能。
- **不自动立项**：Label/Job工作台、Stream spec写入、190个后置菜单、Swarm API/Review、跨平台发布。Force Unlock已退役，不重新加入Todo。
- **时间语义**：先用假服已知时区证据确定日期偏移问题，不能让用户猜后端原因或直接改本机/服务器时区。

## 不得恢复的已覆盖旧需求

保留当前行为，不把以下旧设计作为“缺功能”重做：Client筛选、Stream仅当前、独立Merge分类、History满两条阻止新增或“最多两条”提示、专用比较按钮、History内嵌Diff、预览CL跳Submitted、预设“应用”按钮、左侧六导航、数量摘要置于筛选内部。Depot真实名称未知不是已证实代码缺陷；不能为修报错探测生产路径。

## 本次核对与验证限制

- **2026-10-27停笔交接证据**：最近追踪WIP的TS检查exit 1，`IntegrationTraceDialog.tsx` 报 TS2554（无初值的 `useRef<AbortController>()`）及 TS2322（赋undefined）；根已转发FE修复两处并通过TS/CSS/format/diff，故这两项编译错误关闭。根随后转发BE新证据：integration_trace/file_service/domain/runner切片已停写，10项新Rust/mock＋1项runner＋2项cache/cursor回归通过，offline locked libcheck通过。证据为根转发的BE报告，PM未重跑；不外推前端运行/视觉或假P4验收。详细原始记录见[并行交接](并行交接.md)。PM本次只核对文档行数、状态汇总及diff，不运行产品测试。

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

## 当前阶段非范围（PKG-01定向Windows体验包除外）

以下项目不阻塞“当前 Windows 机器本人私用”，不得混入本清单的完成判断：

- Git remote、远端 CI、异机恢复证明。
- macOS、Linux、Windows ARM64 与跨平台一致性。
- 正式代码签名、公证、自动更新及公开发布仍非范围；新增PKG-01只授权定向Windows体验包、必要安装说明和最小验收，由用户自行转发。
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

### 2026-10-27 本轮增量说明

- UI-04：保留现有布局及视觉差异，工作区详情及其占位删除，切换按钮移到搜索行；分支流列表详情及侧栏占位也已删除，切换Stream保留原行右键入口，隐藏失效的“查看详情”菜单；未删除后端能力。列宽参数保存在各页面本地状态，与 History 一致；所有数据列均有键盘/指针拖动和最小宽度。
- GRAPH-01：调查弹窗按需读取，默认不扫描服务器；映射未匹配/复杂规则、权限或缺版本均为未知。预算为 API 尝试数（缓存命中也占保守预算），并非底层 P4 进程计数。CL detail沿用既有有界实现，可能另读集成元信息。新请求增加代次预检查，旧结果不写新连接缓存。调查不是内容包含证明。
- CON-04：Rename官方依据 https://help.perforce.com/helix-core/server-apps/cmdref/2026.1/Content/CmdRef/p4_renameclient.html 。本轮不执行真实P4；当前工作区和case-only重命名保守拒绝。失败不自动force/retry，未知结果需先检查日志和列表。
- 新增 Vitest 纯/mock用例已写，旧子进程权限拒绝仍未解除，未执行也未绕过；UI视觉/真实假P4未验收。本轮已通过 `tsc --noEmit`、离线 `cargo check --locked --lib`、限定 `app::connection_service::workspace_mutation::tests::` 的3项纯Rust测试（版本门槛、当前/无效名称拒绝、原生命令且不force）、两份CSS的PostCSS解析及diff空白检查。没有启动应用或实际调用P4。

### 修订图请求契约修复

`graphReads.ts` 的内部联合类型 `kind=graph` 曾泄漏到 `get_revision_graph`，触发 Rust `deny_unknown_fields`。已在共享调度边界显式构造 scope/revisionLimit/cursor/refresh/operationId；覆盖初始/刷新/分页/目标和CL调查共同路径，不放宽后端校验。Mock增加未知字段拒绝；新增共享读取请求形状、invoke序列化与Rust反序列化回归。无图且读取失败时显示数量未知，不再显示确定0个版本。此项是前端参数错误，不是已证实的旧后端不兼容，不需为此改后端契约或运行默认入口。

此接口修复验证：TypeScript、Prettier、diff检查通过；离线限定 `domain::revision_graph_wire_tests::` 的2项纯Rust测试通过（精确请求往返、kind仍拒绝），256项其他测试未运行。前端共享读取/invoke/错误计数回归已写，受既有Vitest权限限制未执行。未运行P4或应用。

### 已提交分类呈现简化（用户确认）

SUB-03/SUB-05：列表/筛选/周报类别选择共用普通提交、CI 合并、自动生成三个短名称，保留筛选“全部”。移除旧mergeClassification徽标和已提交状态列；表格改为CL、提交类型、描述、用户、时间五列。规则本身未变，分类仍是描述签名启发式，不证明CI身份。CL展开、详情、GoTo及周报数据逻辑不变。表头与虚拟行统一tracks及横向滚动，保留64/324行高与原定位；新增文案/列结构回归待运行。视觉仍未验收。

收起列表的文件数列已移除：`p4/changelists/parser.rs` 摘要默认file_count=0，只有按需详情/元信息读取才覆盖，因此原0不代表真实空CL。展开后仅用detail.files.length显示数量，complete才显示文件数，partial显示已加载数量/总数未知；加载/错误不显示数量，真实完整空列表才显示0。沿用懒加载与连接范围缓存，不额外逐行describe。

此批已通过TypeScript、7份修改文件Prettier、workbench.css PostCSS解析、git diff空白检查。新增三类呈现/五列结构/展开计数加载失败完整与partial及缓存复用的纯mock回归，仅写入未运行（旧Vitest子进程拒绝未绕过）；未进行视觉或P4验收，未新增逐行计数请求。

### 已提交展开区弹性高度（覆盖固定64/324方案）

已移除展开固定260px/总行高324px。CL摘要仍64px，展开内容自然流，按ResizeObserver正高度更新主虚拟列表估计和总高/后续偏移；隐藏页签的零测量被忽略。RevisionFileList在此模式使用外层滚动元素和相对scrollMargin，不再制造内层固定滚动框，文件区域由已加载行数×40px撑开，文件DOM仍按外层视口虚拟化。加载/错误/数量/partial说明高度一起测量；无新读取请求。新增0/1/2/多行及多CL展开、隐藏零测量、收起/resize回归；视觉与Vitest仍未运行。


### 2026-10-27 增量收束：Submitted 与修订图比较（已实现待运行验收）

- Submitted：五个数据列为 CL、提交类型、描述、用户、时间；全部复用 `useColumnWidths` 拖宽/键盘调宽，表头与行共用模板。主类型仅普通提交/CI 合并/自动生成，旧 merge badge、状态和收起文件数已移除。作者使用主文字字号/颜色。
- 展开文件采用正值 ResizeObserver 内容测量，64px 主行加实际详情高度；虚拟行位置/总高同步刷新，忽略隐藏页零测量。文件列表使用主列表滚动视口，少量文件没有固定 324px 留白或内层滚动条。此实现替代早期固定高度补丁。
- 标签最新需求覆盖独立列：完整原始描述中的 ASCII 方括号在原位置渲染 tag，文字/重复项顺序保留，React 文本转义；无独立标签列。组合筛选保留候选多选，也可手输文本回车加入，trim/去重/IME Enter 防误提交，取消勾选或清空移除。OR 匹配、与类型 AND；仅已加载数据范围，不改描述/导出/服务端参数；稳定服务器 query 对象防止本地标签切换触发额外请求。
- 内置“我的提交（默认）”首次/重置/重新选中时动态生成最近七天、当前连接用户、普通提交、Stream 不限、其余条件空。连接变化重取当前用户；缺用户报字段错误而非查询所有用户。内置项不写入用户预设，不覆盖同名自定义项；保存自定义仍保存用户指定日期。
- 修订图：原“所选与上一版”及页内 Diff 删除。候选复用 History 容量2 FIFO，蓝色先选/琥珀后选，aria 角色区分；聚焦/隐藏分支与比较选择分离。按钮紧跟缩放，两个有效候选才启用；新建并激活锁定 Diff，明确左文件#revision 与右文件#revision，无 have/workspace 回退。
- Diff 新增可选 `rightFileIdentity`，右侧独立检查/读取；缓存键包含右路径，后端显式跨文件请求只允许精确 depot 路径和正 revision。相同路径复用 inspection；原 History 同文件契约不变。运行旧二进制不支持新字段，需要后续在获准隔离入口更新前后端；本次未启动应用。
- 证据：`ChangelistPage.tsx`、`SubmittedChangeFiles.tsx`、`RevisionFileList.tsx`、`submittedTags.ts`、`SubmittedFilterPanel.tsx`、`SubmittedPage.tsx`、`FileReviewPage.tsx`、`panels.ts`、`useDockController.ts`、`file_service.rs`、`domain/mod.rs`。
- 已跑：TS noEmit、CSS PostCSS 解析、diff 空白检查；离线 Rust check；纯 Rust `domain::explicit_diff_pair_tests::` 1通过/258过滤（反序列化两端路径与版本、拒绝 have 和通配符）。
- 已写未跑：标签解析/原文保留/纯查询一致、动态默认、标签手输/IME/无额外请求、列模板同步、FIFO双色/精确新Diff参数和无内联、动态展开多行/零测量回归。Vitest 子进程既有拒绝未绕过；浏览器视觉限制未绕过。不将 TS/CSS 或纯合约测试标为视觉/P4功能验收。
- 剩余：真实隔离假 P4 端到端、宽窄窗口/缩放/多展开/滚动可视验收；修订图目标映射/CL逐文件证据调查原有缓存与预算切片继续列为部分实现，图可达性仍不代表内容包含。没有生产连接、默认应用启动或推送。

- 最新布局补充：标签筛选在 DOM 中紧接关键词，视觉与 Tab 顺序一致；日期/Depot 与 Stream 配对布局不变。
