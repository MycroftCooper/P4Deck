# 前端操作流程 TODO

日期：2026-10-09。负责人：前端 UI。状态：P0 连接认证、BE-003/BE-004a/BE-004b/BE-008/BE-008Q/BE-008G、FE-16 诊断体验及 FE-17 本机大列表基准已完成自动化验收；等待 SSL/SSO、固定设备性能与 Windows/macOS 原生 UI 验收，整体未完成。

## 范围与约束

本批次承接已完成的页签、工具栏和右键菜单，补齐操作入口之后的交互。只负责 React/样式、前端状态和契约适配，不修改 Rust/P4 服务，不安装服务器、不操作真实生产数据。

未接通的流程必须明确显示“界面预览 / 未提交”，不能使用假成功消息。示例数据只用于明确标注的预览。已有真实操作入口替换时保留目标快照、连接边界、风险确认，不因做 UI 扩大执行范围。

## 实施清单

| ID | 工作项 | 范围 | 验收标准 | 状态 |
| --- | --- | --- | --- | --- |
| FE-00 | 连接与认证向导 | CLI 发现、保存/验证分离、连接/票据状态、SSL Trust、Login/Logout、过期恢复、SSO/MFA 指引 | 不解析 stderr；密码单次使用；Trust 绑定精确 server/fingerprint；切换连接淘汰旧结果；成功刷新依赖视图 | 生产契约与浏览器测试通过；localhost Login/Logout/ticket 通过；SSL/SSO/原生待验 |
| FE-01 | 统一对话框基础 | 模态层、标题/描述/正文/页脚、焦点、Escape、滚动、主题、危险态、忙碌与错误 | 键盘可操作；焦点恢复；来源窗口正确；不被停靠容器裁剪；忙碌时不重复确认 | 浏览器/跨 document 通过；原生窗口待验收 |
| FE-02 | CL 新建/编辑 | Description、Jobs、上下文、必填校验、未保存修改保护 | Default 不冒充编号 CL；不直接发送空描述；未接通时仅检查表单 | BE-004a 已接生产入口；浏览器契约/组件测试通过，原生待验收 |
| FE-03 | 目标 CL 选择与移动文件 | Default/编号 CL、过滤、文件计数、目标摘要 | 保留明确文件子集；不可选当前/不适用目标；无目标/空列表可解释 | BE-004a 已接生产入口；Default 往返、失效与失败测试通过，原生待验收 |
| FE-04 | 提交预检与确认 UI | CL 摘要、阻塞/警告、文件范围、检查中、过期、失败、结果 | 只确认整个指定 CL；检查失败/过期不能提交；无后端预检不显示“可提交” | BE-003 已接生产入口；状态机测试通过，原生待验收 |
| FE-05 | 获取指定版本 | head/修订/CL/日期选择、范围预览、输入校验 | 文件版本与 CL 不混用；取消不执行；目录标明递归 | 前端证据通过；真实 sync 未验收 |
| FE-06 | 重命名/移动文件 | 原目标、新路径、范围、覆盖/映射提示 | 路径不拼 Shell；未验证映射/覆盖时不能宣称安全；未接通不修改文件 | 前端证据通过；映射/覆盖后端校验待补 |
| FE-07 | 批量与递归确认 | 共用目标清单、数量、父子去重提示、危险操作说明 | 目标不跟随外部选择变化；大列表虚拟化；不隐藏部分失败或取消边界 | 50,000 目标虚拟化证据通过；真实性能待验收 |
| FE-08 | Shelf UI | 明确 CL 与文件子集、创建/更新/删除确认、状态反馈 | 不把 shelf 当本地副本；删除风险明确；未接通动作不执行 | BE-004b 生产契约与 localhost 通过；原生待验收 |
| FE-09 | Unshelve UI | 来源、目标 CL、覆盖/映射/锁/Resolve 风险、预检与确认 | 无有效预检不执行；支持加载、空、阻塞、失败及过期状态 | BE-004b 生产契约与 localhost 通过；原生待验收 |
| FE-10 | Resolve UI | 冲突列表、当前项、比较双方、处理方式与结果 | 不以演示内容覆盖真实文件；未知冲突/不可用工具明确说明 | BE-004b 生产契约与 localhost 通过；原生待验收 |
| FE-11 | 通用状态与可访问性 | 加载/空/错误/离线/过期；键盘、读屏、亮暗、中英、窄窗口 | 共享状态组件；禁用可解释；文本不截断关键风险信息；不只依赖颜色 | 浏览器键盘/布局通过；原生与真实读屏待验收 |
| FE-12 | 全量接入与验收 | 工具栏/菜单/页面按钮统一入口；清理浏览器原生 prompt/confirm 的相关流程 | 同一动作一套 UI；自动化测试与真实页面验证；逐项记录证据和剩余后端依赖 | Submit/Pending 生产入口统一；原生双平台门槛未通过 |
| FE-13 | Submitted 详情与 merge 分类 | 按需真实详情、四态分类、可靠 merge 降噪、文件/Jobs/Integration、stale response 与大列表 | 仅隐藏有证据的 reliable；疑似/unknown 可见；详情文件窗口化；Mock 不冒充真实结果 | BE-008 生产接线与自动化/localhost 通过；原生待验收 |
| FE-14 | Submitted 组合查询与保存过滤器 | 全字段组合筛选、稳定 cursor 分页、stats/截断、保存/应用/覆盖/删除/重置 | 字段内 OR、条件间 AND；切换取消并淘汰旧页；多页不重不漏；敏感字段不持久化 | BE-008Q 生产接线与自动化/localhost 通过；原生点击/读屏待验收 |
| FE-15 | 全局搜索生产接线 | `SearchPage` 接入 `globalSearch`，映射 Submitted/Pending、Workspace/Depot 文件与 Job 分组、facet、导航、加载/空/失败/partial/继续加载 | Mock 必须显示模拟标识；切换查询需取消旧 operation 并隔离 stale response；按 UTF-16 高亮范围以文本节点渲染，不自行拼 P4 参数 | 已完成生产接线与 49 文件/296 项 Web 自动化；Windows localhost 默认双轮复验通过。Job 因无现有详情页明确禁用，Stream/Shelf 延后；原生点击/390px 原生窗口/读屏待验 |
| FE-16 | 日志、操作与诊断生产闭环 | P4 Log 游标分页/筛选/策略，diagnostic-alert，Operation Journal，诊断导出，缓存指标，连接代次清理和双向 operation 导航 | 后端过滤必须作用于分页；策略失败回滚；alert 去重且不抢焦点；导出不泄露敏感字段；Mock 明示模拟；窄屏、键盘和 ARIA 基线 | 生产接线与 50 文件/302 项 Web 自动化通过；Windows localhost 默认两轮通过。原生点击、390px 原生窗口和真实读屏未验 |
| FE-17 | 大列表窗口化与自动基准 | Pending 打开/搁置文件、Submitted 详情、Search、Log、Journal、Files/Depot；50k 生产筛选/搜索/去重和 100k 结构门禁 | 不挂全量 DOM；稳定 ID 选择；键盘焦点、窄屏、ARIA 和操作按钮不回退；50k p95 `<50 ms`；报告含环境与非跨平台声明 | 实现完成；52 文件/306 项 Web 测试与本机 `test:perf` 6 项通过。Windows/macOS 固定设备原生 FPS/内存/读屏未验 |

## 执行顺序

FE-01 → FE-02～04 → FE-05～07 → FE-08～10 → FE-11～14。

每完成一项，更新本表并记录测试证据；不得只做基础框架就将整个批次标为完成。前端可独立完成的交互继续推进；后端依赖单独列出，不混入前端完成声明。

## 验收记录

- FE-17 大列表与性能（2026-10-09）：修复 `PendingFileList` 打开/搁置文件全量 DOM，并将 Global Search、P4 Log、Operation Journal 的分页累积列表接入既有 TanStack Virtual；Submitted 详情、Files/Depot 和确认目标列表沿用既有窗口化。常规 Web 测试以 100,000 条 Pending 文件验证 `<40` 行 DOM（实际 24）、键盘焦点、稳定 ID 选择及 ARIA；全量 52 文件/306 项通过。本机 `pnpm test:perf` 使用固定 seed、7 轮 warmup/25 轮测量，50k Workspace 筛选 p95 0.651 ms、Unicode 搜索 p95 1.421 ms、50k+50k Global Search 合并去重 p95 10.511 ms，均通过项目 `<50 ms` 门禁；100k 筛选与 Pending 结构只作为信息/结构项。报告见 `ForAIDoc/Coder/前端性能基准.md`。自动化环境无法枚举原生窗口，Windows/macOS 固定设备持续滚动 FPS、真实峰值内存、原生焦点和读屏未验。

- FE-16 诊断体验（2026-10-09）：P4 Log 使用 `queryLogPage` 的真实级别/来源/命令/operation 筛选与游标追加，保留分页失败结果并可重试；日志策略真实接 `get/setLogPolicy`，覆盖校验、保存反馈和失败回滚。`diagnostic-alert` 按 Warning/Error 策略自动展开、按 operation+level 去重且不调用焦点 API。Operation Journal 使用当前连接隔离和服务端状态/类型/时间/文本筛选，展示开始/结束/耗时/摘要/结构化错误，并与日志双向跳转。诊断视图真实接导出与缓存指标刷新；浏览器 Mock 明示不写文件，因现有安全打开能力仅允许 Workspace 内路径，导出仅提供复制路径。全量 `pnpm format:check`、50 文件/302 项 `pnpm test:web`、`pnpm build`、`pnpm check`、Rust 81 项通过/1 项 ignored、Clippy `-D warnings`、rustfmt 与 Windows localhost `p4d` 默认两轮均通过；原生窗口无法枚举，未执行原生点击、390px 原生窗口或真实读屏验收。

- FE-15 Global Search（2026-10-09）：五类结果分组、facet/count、后端 target 导航、Unicode/特殊字符与 UTF-16 安全高亮、300ms debounce/取消/stale 隔离、稳定 cursor 追加去重、分页失败保留与重试、partial/单类别失败/扫描上限、空结果/整体错误、类别切换重置、Mock/Tauri 契约、390px、键盘焦点和 ARIA live/status 自动化通过。全量 `pnpm format:check`、49 文件/296 项 `pnpm test:web`、`pnpm build`、`pnpm check`、Rust 81 项通过/1 项 ignored、Clippy `-D warnings`、rustfmt、`git diff --check` 与 Windows localhost `p4d` 默认两轮均通过。当前自动化环境不提供原生窗口枚举，因此未用浏览器或 Mock 冒充 Windows/macOS 原生点击、390px 原生窗口和真实读屏验收。

- PM 独立稳定性复验（2026-09-29）：37 个前端测试文件、222 项测试全部通过；同时 53 项 Rust 测试、生产构建、TypeScript/Rust Check、Clippy 和 `git diff --check` 全部通过。该结果确认当前工程基线绿色，但不替代真实 P4、原生窗口和 Windows/macOS 验收。

- 初始盘点：没有统一业务对话框；已有操作仍使用部分原生 prompt/confirm，部分按钮尚未绑定流程。
- 工程基线参考上一批：159 项前端测试、42 项 Rust 测试；本批将重新验证，不沿用计数充当新证据。

### 第一批落地：对话框、CL 表单与移动选择

- `Dialog` 统一使用原生 modal + 来源 document portal，包含关闭、Escape、焦点恢复、正文滚动、页脚、忙碌和错误样式。显式设置初始字段焦点，避免默认落到右上角关闭按钮。
- `ChangelistFormDialog`：Pending/Submitted 页面新建入口、Pending 编号 CL 编辑入口复用同一表单。描述必填，Jobs 分行去重，Default 编辑被拒绝；未保存输入有放弃确认。可选异步适配器支持忙碌、错误与重复提交保护，卸载后不触发旧回调。应用尚未连接该写入适配器。
- `MoveFilesDialog`：Pending CL 和工作文件（单选/多选）的右键入口；固定来源、文件子集和候选快照，排除来源 CL，包含 Default，支持编号/描述筛选。筛选隐藏已选项时保留并明确展示该项。预览不执行移动。
- `TargetList`：公共只读操作范围虚拟列表，长路径可横向滚动，用于后续批量确认复用。
- 自动化：全量前端 172 项通过（包括 CL 表单 9 项、移动选择 4 项）；`pnpm run build` 通过。测试覆盖校验、默认 CL 边界、草稿保护、重复提交、失败保留输入、卸载隔离、焦点恢复、目标过滤及快照。
- 页面验证：亮色 Pending 新建表单关闭保护通过；单文件右键移动仅显示该文件，候选排除来源 CL，选择 Default 后仅显示未执行提示。截图 `/tmp/p4deck-move-cl-ui.png`。
- 尚待综合验收：暗色/英文/窄屏/独立窗口的业务弹窗；全局统一入口；大型目标列表实际滚动性能。现有 Pending 数据未提供 Jobs/候选归属与锁状态，不能据此宣称已完成写入前验证。
- 后续继续 FE-04～12；本批次整体未完成。

### 第二批落地：提交整个 CL 的预检界面

- 工具栏和 Pending CL 右键提交入口统一打开 `SubmitDialog`。旧的浏览器确认后直接提交分支已撤下；现有后端返回结构未提供可验证的预检快照，故当前入口只读取文件摘要，不执行提交。
- 显示固定 CL/工作区、完整文件范围虚拟列表、描述、未检查/加载/预检中/阻塞/过期/失败/提交中/结果；警告与阻塞分别展示。确认要求整个 CL 的显式勾选。
- 可选前端适配器契约要求目标 CL 一致、非空 token、有效期；超时自动失效，提交失败需重新预检，切换连接使旧结果失效，忙碌时防重复。真正接入时，适配器必须在执行前原子验证 token、连接和整个 CL 范围，不能仅依据前端计时器放行。
- 新增 7 项测试：摘要不等于预检、摘要缺失、整 CL 确认、阻塞/失败、过期、目标不匹配、防重复与连接切换。浏览器验证工具栏与右键菜单均进入同一界面，确认按钮禁用，完整显示 CL 31821 的四个文件；截图 `/tmp/p4deck-submit-ui.png`。
- 下一项 FE-05：获取指定版本表单；全局弹窗状态组件抽取和多窗口验收仍在 FE-11/12 中。

### 第三批落地：获取指定版本

- `RevisionDialog` 替换 CommandBar 的原生版本 prompt；选择 head / 文件修订 / 截至 CL / 截至日期。严格正整数/真实日历日期校验，拒绝原始命令字符串、前缀、范围和零修订（避免把清除本地文件混入普通版本选择）。
- 固定目标快照，显示递归范围和父子去重提示，取消返回 null；切换连接或卸载也取消待确认请求，异步确认后检查连接代次及并发操作。保留既有获取版本执行路径，未新增后端逻辑。此项不像新建 CL 等预览弹窗：用户点击“确认获取”会调用已有获取动作，界面明确说明会更新工作区。
- 语义依据：[Perforce 修订选择说明](https://help.perforce.com/helix-core/server-apps/p4guide/2024.2/Content/P4Guide/syntax.syntax.revisions.html)；日期按服务器时区午夜解释，不自动转换为客户端时区；CL 表示截至该 CL，不是只取该 CL 文件。
- 新增解析测试 3 项和弹窗测试 3 项。全量前端 186 项通过，生产构建通过（计数包括其他已有测试）。页面验证目录递归入口直接打开新表单；QA 仅输入与取消，不执行 sync。
- FE-06～12 继续实施，整体目标未完成。

### 第四批落地：重命名预览与批量确认

- 文件/目录右键重命名入口统一进入 `RenameDialog`，只做目标输入检查，明确未验证映射、存在性、覆盖、权限、签出和大小写改名。源对象固定；更改输入后关闭需确认放弃；没有任何后端或磁盘调用。
- `checkRenamePath` 处理空路径、相对路径、控制字符/通配符、点段、相同路径及目录自包含；支持 POSIX、盘符路径与 Depot 格式。此校验不是完整的系统路径合法性或 P4 可执行性判断，界面不承诺安全。
- `OperationConfirmDialog` 统一批量/递归获取、签出、添加以及删除/还原确认，显示全部去重目标的虚拟列表，要求勾选范围确认；说明目录递归、部分成功和取消无法回滚的边界。沿用现有操作执行路径，不在 QA 中执行写入。
- `useDialogRequest` 抽取异步确认请求生命周期，复用于获取指定版本和批量确认：重复请求不覆盖旧请求，连接变化/卸载使等待方以取消结束。确认后再次检查连接代次与正在运行的操作。
- CommandBar 中已无原生 `window.prompt/confirm`。其他功能及页面的原生弹窗仍需 FE-12 全量检查，不将此局部清理视为全量完成。
- 新增路径规则测试 3 项，交互与异步请求测试 4 项。全量前端 193 项通过，生产构建通过；页面验证重命名路径检查/草稿关闭保护及目录递归还原取消，全程未执行文件变更。截图 `/tmp/p4deck-rename-ui.png`、`/tmp/p4deck-batch-ui.png`。
- 后续继续 Shelf / Unshelve / Resolve，以及通用状态、结果反馈和跨窗口统一入口。

### 第五批落地：Shelf / Unshelve

- `ShelfDialog`：Pending 编号 CL、单个/多个打开文件、整个 shelf、单个/多个搁置文件的入口。明确固定文件子集；已有 shelf 可选择保留或替换所选版本，替换/删除要求确认风险；Default 显示先创建编号 CL 的前置要求，不冒充完成创建。
- `UnshelveDialog`：固定来源文件标识，选择目标 Default/编号 CL，可筛选、保留已选目标；当前只检查选择，不执行。映射、锁、本地修改、覆盖和 Resolve 风险显式显示，不能把前端选择检查当作服务器预检。
- `PreflightStatus` 为后续状态统一提供未接通、未检查、检查中、空、过期、离线、失败、阻塞和就绪的表现组件。当前 Unshelve 生产入口仅展示真实可知的未接通/空状态；其余状态已做组件测试，需未来适配器驱动，不在界面伪造服务器结果。
- `testHarness` 抽取 jsdom 对话框测试基础，避免继续复制测试初始化代码；已有测试迁移安排在整理阶段。
- 新增 6 项测试，覆盖替换确认重置、Default/空范围、删除边界、同源目标选择、未预检禁用及全部状态文案。浏览器核验单文件 Shelf 范围、替换风险确认、单文件 Unshelve 到 Default 后仍禁用执行；没有写入服务器。
- 验证截图 `/tmp/p4deck-shelf-ui.png`、`/tmp/p4deck-unshelve-ui.png`。下一项 Resolve；剩余全局入口和样式/键盘/多窗口验收仍未完成。
- 本轮全量前端 199 项测试通过；修正测试工具的 DOM 类型后，生产构建通过。

### 第六批落地：Resolve 处理计划

- 文件及 Pending 工作文件右键的 Resolve 入口共用 `ResolveDialog`。固定目标列表、当前项、前后切换、按文件保留处理计划；列表支持方向键/Home/End 和鼠标选择。
- 基线、工作区一侧、传入一侧独立展示。没有真实详情时明确显示未知版本和未载入内容，不以文件状态推断已无冲突。可呈现适配器提供的版本、文本与结果，预览文本设置字符上限，二进制类型提示不能文本合并。
- 处理计划支持暂不处理、尝试合并、保留工作区、接受传入及外部工具；选择一侧显示丢弃另一侧修改风险。只有“检查计划（不执行）”可用；未接通冲突检查/执行时不会标记已解决，不执行任何写入。关闭更改过的计划需确认。
- `TargetList` 扩展为可选的键盘可操作虚拟选择列表，仍可供普通只读范围展示复用；少量目标按行数收缩高度，不空占 160px。
- 新增 4 项 Resolve 测试，覆盖未知数据、分文件计划、关闭保护、键盘导航、提供的版本/失败结果和执行禁用。浏览器验证 Pending 单文件入口、版本未知说明、选择传入侧的风险提示和不执行反馈；截图 `/tmp/p4deck-resolve-ui.png`。
- FE-11/12 进入整合与全量验收阶段：共享状态、样式/语言/键盘/窗口适配、入口一致性、批量结果反馈及大列表。没有将本批整体标为完成。
- 本轮全量 203 项前端测试通过；目标列表高度调整后，相关 8 项测试及生产构建再次通过。

### 第七批整合：来源窗口与结果反馈

- 修复右键菜单→全局命令的来源丢失：菜单动作传递原始触发元素，经 CommandExecutionContext/App/CommandBar 到业务弹窗，确保由来源 document 创建弹窗并恢复原始焦点。SVG 触发器回退到最近 HTML 祖先；不依赖主窗口 `document.activeElement` 猜测独立窗口来源。
- 跨 document 集成测试验证 iframe 来源菜单打开模态框：主 document 无弹窗、来源 document 有弹窗、输入初始焦点和关闭回焦均正确。此测试不是 Win/mac 原生独立窗口实测的替代，后者仍在验收范围。
- 修复文件操作返回非零退出码仍提示完成：`fileActionFeedback` 读取退出码及 error/cancelled/warning/stderr 事件，保留服务器反馈和任务 ID；失败与取消明确告知可能部分执行、不能回滚。没有退出状态不宣称成功；所有异常路径提示检查日志和文件状态。
- 修复旧连接异步错误覆盖新连接的提示；错误图标改为告警，反馈多行展示并限制视图高度，避免长输出把工作区挤出屏幕。
- 新增结果反馈测试 3 项和菜单→弹窗跨 document 测试 1 项；既有跨窗口菜单测试增加来源元素传递断言。全量 207 项前端测试、生产构建通过。
- 未完成项仍包括：Files/Depot 等页面的 CL 移动/Shelf 入口统一、部分页面空按钮/原生弹窗清理、真实多窗口及亮暗/英文/窄屏/大列表验收。整体目标保持进行中。

### 第八批整合：跨页面 CL 操作与主题/键盘验收

- `FileClWorkflow` 接通 Files/工作区/Depot 单文件、多文件的移到 CL/Shelf 入口，复用原弹窗。仅显式打开时读取一次 Pending 快照；缺失或重复归属阻塞全部选择，不静默丢弃未知目标。跨 CL 移动支持明确跳过已在目标 CL 的文件；跨 CL Shelf 要先选择来源分组，支持返回组选择。
- 菜单总表与注册表追加 `F01-37`、`F02-36` 单文件 Shelf 项（保留旧 ID），菜单叶子从上一批基线 492 增至 494。清单一致性测试通过。
- 终端多行粘贴使用统一 Dialog，明确只填入不执行；预览截断有说明，取消不改变输入。`src` 已无浏览器原生 prompt/confirm；异步弹窗在卸载/连接变化后拒绝旧请求。
- 暗色英文检查发现主按钮浅绿底白字对比不足，新增 `--on-accent` 主题变量修复。390px 窄屏检查：弹窗左 16px、右 374px，内部没有横向溢出，正文独立滚动、页脚可见；测试后恢复原亮色中文和窗口尺寸。
- 实测发现原生 Tab 在末尾可离开弹窗，补显式 Tab/Shift+Tab 循环。浏览器验证正向从末按钮返回关闭按钮、反向回末按钮，焦点均留在弹窗；自动化测试覆盖此行为。
- 新增文件归属测试 2 项、跨页面流程测试 3 项、焦点循环测试 1 项。全量前端 213 项通过，构建通过；截图 `/tmp/p4deck-files-shelf-ui.png`、`/tmp/p4deck-dark-dialog-ui.png`、`/tmp/p4deck-dark-narrow-ui.png`。
- 仍待完成：原生独立窗口完整流程、大列表实际滚动、所有业务表单的英文/窄屏矩阵、遗留无动作按钮，以及最终架构整理和验收汇总。

### 第九批整合：弹窗协调、布局矩阵与大列表

- `useCommandDialogs` 将 CommandBar 的六类独立弹窗状态收敛为判别联合与单个请求通道；同一 App 实例中的命令弹窗互斥，切换连接取消旧请求。工具栏忙碌判断也包含正在打开的命令弹窗。这不等于多个原生进程之间的全局互斥。
- Pending 的 CL 头部右键和“更多”共用 `changeMenu`；移除没有处理逻辑的 drop 接收器，删除 CL 按钮明确禁用并解释未接入。Submitted 的详情“更多”也与行右键共用菜单；固定 30 天改为静态范围，不再伪装成可点按钮；固定 submitted 的筛选明确禁用；详情空态补中文。
- 开发专用 `?workflow-audit` 页面提供明确标注的合成数据，集中验收 10 种表单，不查询或写入 P4。生产入口以 `import.meta.env.DEV` 隔离，生产产物没有该测试页面。
- 10 种表单（新建/编辑 CL、移动、提交、版本、重命名、批量、Shelf、Unshelve、Resolve）完成四组布局检查：英文暗色 390×650、中文亮色 1000×760、中文暗色 390×650、英文亮色 390×650。未发现横向溢出，页脚在弹窗内，超长正文独立滚动。此矩阵验证布局，不代表读屏器或原生窗口已验收。
- 50,000 个合成目标的批量清单首尾均只渲染 12 行；End 滚动到最后一项。Resolve 的 End 同样选择第 50,000 项，保持 12 行 DOM。验证了虚拟化和末项导航，未测量 FPS、真实服务器延迟或整体内存。截图 `/tmp/p4deck-50000-targets-ui.png`。
- 当前全量 215 项前端测试通过（35 个文件），生产构建通过。新增的两个协调器测试覆盖重复打开互斥和连接切换取消。Pending 更多菜单、Submitted 详情更多菜单的 Enter 打开/Escape 关闭均经真实页面验证，截图 `/tmp/p4deck-submitted-menu-ui.png`。
- 独立窗口核验现状：浏览器弹出动作后主页面出现 opened in a new window 状态，但可操作浏览器清单没有对应弹出窗口，因此尚未验证该窗口内的业务弹窗；当前未运行原生 P4Deck。不能把主窗口提示、iframe 测试或构建通过当作原生跨窗口验收通过。

### 第十一批：BE-003 / BE-004a 前端生产接线

- `ChangelistFormDialog` 已由 Pending 与 Submitted 的新建入口接到 `mutatePendingChange`；编号 CL 编辑完整带回并提交 Jobs。成功使用 `refreshedChanges` 只合并受影响 CL，`refreshError` 不显示全成功；失败保留草稿并显示后端原因。
- 编号 Pending CL 的删除按钮和右键菜单共用明确确认框。Default 永不允许删除；前端展示当前 files/shelves/Jobs 快照，但最终以后端“真正为空”复核为准，拒绝原因原样展示。
- `MoveFilesDialog` 保留打开时的来源、文件集合和候选快照，采用“检查选择 → 确认移动”两阶段；目标改变、连接/Workspace 改变会让确认失效。Pending 页面与 Files/右键统一调用强类型 `moveFiles`，成功合并来源/目标 CL 并刷新文件状态，失败按不确定/可能部分执行路径刷新。
- `useCommandDialogs` 的统一 Submit 入口已接 `preflightSubmit` / `confirmSubmit`。被 blocker 阻断且无 token 是合法预检结果；只有 ready、目标一致、未过期且持有 token 时才可确认。confirmed warning、unknown、token 过期、连接/Workspace/CL 漂移、加载失败、结构化拒绝/失败/unknown、成功和重复点击均有独立状态。
- Submit 结果按后端 refresh advice 刷新 Pending、Submitted 与 Workspace 查询；错误或 IPC 异常也保守刷新 Pending/Workspace。成功显示 operation/log 引用；非 `submitted` outcome 不显示成功。
- Browser Mock 继续实现同一契约并驱动状态测试；成功提示明确是浏览器模拟、未访问真实 P4 Server。Shelf/Unshelve/Resolve 仍维持既有预览边界，本批没有扩大执行范围。
- 自动化新增删除确认、Pending 局部合并、Default↔编号移动、Submit blocker/warning/unknown/过期/漂移/失败/防重复及统一适配器接线覆盖。2026-10-08 全量 `pnpm test:web` 为 39 个文件、241 项通过；`pnpm build`、`pnpm check`、Rust test/check/clippy/fmt、`git diff --check` 通过，Windows localhost E2E 连续两轮通过。
- 最新 debug Tauri 已通过 `pnpm tauri build --debug --no-bundle` 重建，并以隔离 Fixture 环境启动为响应正常的 `P4Deck` 窗口。当前 Computer Use 原生应用清单连续返回空，无法绑定窗口执行可核验点击；实例与 Fixture 已清理，因此 Pending/Submit 原生 UI 冒烟记为“未验收”，不以进程存在、旧 exe、Mock 或应用层 E2E 冒充。

### 第十二批：BE-004b 前端生产接线

- `ShelfDialog` 已接 `preflightShelf` / `confirmShelf`：固定编号 CL 与文件子集，分别呈现首次创建、替换和子集删除；replace/delete 必须明确勾选危险确认。ready 无 token、过期 token、目标不匹配、来源/连接漂移均不可执行，blocker/warning/unknown 保留后端语义。
- `UnshelveDialog` 已接 `preflightUnshelve` / `confirmUnshelve`：固定来源 Shelf 子集，可选择当前或同用户其他 Workspace，并输入 Default（0）或编号 CL；逐文件显示映射、本地修改、已有打开 CL、锁和 Resolve 风险。执行只发送 token 与绑定目标，不提供强制覆盖旁路；来源、目标或连接变化使确认失效。
- `ResolveDialog` 已接真实冲突详情与 `confirmResolve` 逐文件计划。策略下拉只包含后端返回且可执行的 `safe` / `acceptYours` / `acceptTheirs`；`mergePreview` 不冒充执行策略，blocked/unknown 或缺少策略的文件阻塞全部确认。只有 outcome 为 `succeeded` 且每个文件经后端复核为 `succeeded` 才显示成功，partial/unknown/仍 unresolved 保持失败。
- 工具栏、文件右键、Pending 文件/CL 菜单继续复用 `useCommandDialogs`、`FileClWorkflow` 与相同三个业务对话框；右键来源元素直接传入对话框以保证关闭回焦。异步 generation、防重入、busy 关闭保护和连接变化淘汰旧结果均已覆盖。
- `workflowRefresh` 按后端 refresh advice 失效当前连接的 Workspace/Depot 查询，并把 workflow 目标和受影响路径交给 Pending 做相关 CL 局部合并；IPC 异常按可能部分执行保守刷新。结果保留逐文件状态、operation ID 与 log reference；失败不清空目标选择。
- Browser Mock 与 Tauri 保持同一强类型契约；Mock 现在模拟 Shelf/Unshelve 状态变化并复核一次性 token、Context 与内容 digest，所有成功文案明确“未访问真实 P4 Server”。Mock Resolve 对真实冲突事实保持 unknown/blocked，不伪造可执行成功。
- 自动化覆盖 Shelf 首次/替换/删除子集、过期 token、来源/连接漂移；Unshelve Default/编号/跨 Workspace、映射/覆盖/锁/已有打开/Resolve 风险；Resolve 策略过滤、blocked/unknown、partial/unknown、成功、防重复与关闭保护；统一入口及 Pending 局部合并。2026-10-08 全量 Web 为 40 个测试文件、247 项通过；生产构建、TypeScript、Rust test/check/clippy/fmt 与 Windows localhost E2E 两轮通过。
- 开发审计页复验 390×650 中文亮色 Shelf 与英文暗色 Unshelve/Resolve：对话框 `clientWidth=scrollWidth=357`，正文无横向溢出、页脚可见；Unshelve 初始焦点位于目标 Workspace。此证据只覆盖浏览器布局与焦点，不替代原生窗口或读屏器验收。
- 最新 debug Tauri 再次重建，并以隔离 APPDATA/Fixture 环境启动为 `Responding=True` 的 `P4Deck` 窗口；Computer Use 原生应用清单仍为空，且当前客户端没有可用的原生窗口枚举入口，无法绑定执行点击，因此 BE-003/004a/004b Windows 原生 UI 仍记为“未验收”。实例与 Fixture 已停止；不以进程响应、Mock 或 localhost 应用层 E2E 替代原生证据。

### 第十三批：P0 连接与认证向导生产接线

- `SettingsPage` 已移除通用 `runP4(info)` 旁路，按 `discoverP4Cli → testConnection → queryLoginStatus` 强类型顺序验证；Trust、Login、Logout 分别只调用窄契约。UI 直接消费 `ConnectionStatus.state/recovery`，不解析英文 stderr，覆盖 CLI 缺失/无效、未测试、普通连接、SSL 未信任、未登录、已登录、ticket 过期、服务器不可达/断开、权限/配置错误、externalAuthRequired/SSO/MFA、unsupported 与 unknown。
- 保存 Context 与验证/认证明确分离：未保存修改必须先保存；保存结果固定为 `notTested`，不会显示“已连接”。`useRuntime` 增加连接代次；保存、验证、登录或退出后更新 Runtime，Workspace/Streams/Pending/Submitted/Files 等依赖页以新代次重建，旧异步结果不可回写。
- SSL Trust 显示并绑定后端返回的完整 server/fingerprint；缺 fingerprint 时阻塞，只有勾选“已通过可信渠道核对”才发送 `confirmed: true`。切换 Context 会清除确认并淘汰旧请求，重复点击由同步 in-flight guard 拦截。
- 密码只存在于受控 password state 和一次 `login` 请求闭包；点击登录后在等待 IPC 前立即清空输入。密码不进入 Context、Storage、URL、命令历史、日志、notice/error 或截图流程；异常使用本地结构化恢复文案，不回显异常字符串。ticket 过期复用重新登录；Logout 后进入 `authRequired`。externalAuthRequired 不显示密码框，只说明在组织 SSO/MFA 工具中完成后再检查状态。
- Browser Mock 与 Tauri 保持同一契约；Mock 的 CLI/连接/Trust/Login/Logout 文案均明确无本地 CLI、真实网络、Trust 或 ticket 写入，并支持 Logout→Login 状态往返。Mock 不伪造真实 SSL/SSO。
- 自动化新增 2 个测试文件、11 项测试；全量 Web 为 42 个文件、258 项通过。覆盖全部状态与 recovery 的中英文映射及组件呈现、CLI 失败短路、普通连接后的票据查询、精确 fingerprint、密码即时清理与不持久化、Logout/重登、防重复、保存分离、切换连接淘汰及 Mock 声明。生产构建、TypeScript/Rust Check、Rust 单测、Clippy `-D warnings`、rustfmt 与 `git diff --check` 均通过；全库 Prettier 仍只报告既有 `StatusBar.tsx`、`SearchPage.tsx`。
- Windows localhost Fixture 连续两轮通过：真实普通连接、有效 ticket、Logout 后 `authRequired`、缺失 ticket 查询、使用隔离 fixture 密码 Login、恢复 ticket 后继续完整既有 E2E。Rust 的分类契约覆盖 ticketExpired、SSL 与 externalAuthRequired；本机没有 SSL/SSO 环境，因此三者未做真实服务器实机，不能宣称通过。
- 最新 Windows debug Tauri 已由当前源码重建并在隔离 Fixture/APPDATA 下启动。Computer Use 原生应用清单仍为空，且当前会话实际没有 `listWindows` / `computer.launch_app` 能力，无法取得合法窗口 ID；因此原生向导点击、390px 原生窗口、键盘/焦点与读屏仍记为“未验收”。实例和 Fixture 已停止。

### 第十四批：BE-008 Submitted 详情与可靠 merge 分类生产接线

- `SubmittedPage` 选中行后才调用 `getSubmittedChangeDetail`，Tauri 与 Browser Mock 共用窄契约；Tauri 不再传空文件或展示“尚未接入”。详情完整呈现 loading、空文件、失败/重试和成功，以及真实 path/action/revision、Jobs、describe/filelog Integration 证据与检查完整性。
- 行切换、关键词/可靠 merge 筛选、刷新、连接代次变化和卸载均取消当前 operation ID 并递增详情 generation；返回值还复核 Change ID 和当前列表，旧响应不能回写新选中项。被查询/分类过滤掉的选中项会清除。
- 前端只消费后端四态并增加防御：无 Integration 证据的 `reliableMerge` 不升级；非 complete 的 `normal` 不当作普通提交。疑似与 unknown 均明确可见，“隐藏可靠合并”只移除有证据的 reliable，详情升级时同步隐藏计数并安全清选。
- `RevisionFileList` 改为窗口化渲染，使用稳定 path+revision 目标，支持 ArrowUp/ArrowDown/Home/End 的 roving focus、Enter/Space 选择和既有右键菜单；10,000 文件测试只保留窗口 DOM。390px 下 Submitted 列表与详情改为上下布局，详情和文件区独立滚动。
- Browser Mock 的普通/reliable/文字疑似/unknown 数据明确标记为模拟，不访问真实 P4 Server 或网络；Tauri Adapter 测试确认只传 `changeId + operationId`，不回退为空 files。中英文补齐四态、检查、证据、Jobs、错误与空态文案。
- 2026-10-09 全量 Web 为 45 个测试文件、268 项通过；`pnpm format:check`、生产构建、TypeScript/Rust Check、Rust 单测（71 通过、1 个 localhost E2E 显式 ignored）、Clippy `-D warnings`、rustfmt、`git diff --check` 与 Windows localhost E2E 默认连续两轮均通过。
- 当前会话没有可用的原生窗口枚举/绑定能力，未执行 Windows Tauri 点击、390px 原生窗口、键盘焦点或读屏验收；该项保持“未验收”，不以 Browser Mock、组件测试或 localhost 应用层 E2E 替代。

### 第十五批：BE-008Q Submitted 组合查询前端待接线

- Rust/TypeScript/Tauri/Browser Mock 已统一 `ClQuery`：关键词、用户、Client、depot path、Stream、起止时间、Jobs、hasJob、merge 四态、仅隐藏 reliable、1～500 page size 与 opaque cursor；结果统一为 `items/nextCursor/hasMore/stats`。
- 当前 `SubmittedPage` 只迁移到新契约并为列表请求分配/取消 operation ID，仍只发送关键词、固定最近 30 天、Mock stream 与隐藏 reliable，且只显示首个 200 条页面；本批没有新增完整筛选 UI。
- 前端下一步必须接入用户/Client/path/Stream/time/Job/四态控件、`nextCursor` 的继续加载/重试/条件切换淘汰，以及保存过滤器；不得解析或改写 opaque cursor，也不得把 `unknown`/`suspectedMerge` 当作 reliable 隐藏。
- Browser Mock/Adapter 契约覆盖组合过滤、多页无重复、非法/错配 cursor、Unicode 透传与连接代次失效；Windows localhost 两轮后端证据不能替代原生筛选 UI 验收。

### 第十六批：BE-008Q Submitted 组合查询前端生产接线

- `SubmittedPage` 已接关键词、User、Client、Depot Path、Stream、起止时间、Job/hasJob、merge 四态与“仅隐藏 reliable”的完整控件；多值输入按逗号/分号/换行规范化，同字段 OR、不同条件 AND。前端镜像后端的数量、长度、空白、路径/Stream scope、日期反向及 Job 冲突校验，非法草稿不发请求。
- 筛选变化立即取消旧 operation、清空旧 cursor/列表/选择与详情，300ms debounce 后以不可变查询快照发起首屏；generation 与响应内 `requestGeneration` 双重隔离 stale response。连接变化、刷新和卸载沿用同一失效边界。
- `nextCursor` 保持不透明并原样回传；继续加载按 ID 防重复，保留已有行、选中项与懒加载详情。分页失败保留部分结果和 cursor 供重试；缺失/不前进 cursor 被阻断。页脚显示累计页数、扫描/匹配/隐藏统计，以及 partial、错误和达到 5,000 扫描上限的明确截断警告。
- 保存过滤器使用 `p4deck.submitted.filters` 的 version 1 schema，只白名单写入查询草稿字段，最多 50 项；支持命名、同名覆盖确认、删除确认、应用与重置默认最近 30 天。损坏、旧版本或非法条目降级为空列表；ticket/password/fingerprint、连接 Context 与 cursor 不进入 Storage 或 URL。
- Mock 筛选面板和详情均明确标注模拟数据；Tauri 继续只调用真实 `query_changelists` / `get_submitted_change_detail`，未增加浏览器网络旁路。中英文标签、语义分组、校验关联、按钮焦点与 390px 单列滚动布局有组件证据。
- 2026-10-09 全量 Web 为 46 个测试文件、281 项通过；`pnpm format:check`、`pnpm build`、`pnpm check`、Rust 单测（77 通过、1 个 localhost E2E 显式 ignored）、Clippy `-D warnings`、rustfmt、`git diff --check` 与 Windows localhost E2E 默认连续两轮均通过。
- Computer Use 返回原生 apps 空列表，且当前客户端没有 `listWindows` / 原生启动能力，无法绑定 P4Deck Tauri 窗口；因此 Windows/macOS 原生点击、390px 原生窗口、键盘焦点和真实读屏保持“未验收”，不以浏览器组件或 Mock 证据替代。

## 剩余验收与交接边界

1. 原生 Windows/macOS：除独立窗口业务弹窗外，还需验收连接向导的输入顺序、初始焦点、Tab/Shift+Tab、读屏状态、390px、亮暗/中英、密码遮罩与清空、Logout/重登；需可绑定的对应平台桌面实例。整体目标暂不标为完成。
2. FE-12/FE-13 证据对照见下表；四组旧弹窗测试已迁入公共基础。原生门槛仍未完成，避免仅凭全量测试数量宣布全覆盖。
3. 新建/编辑/删除空 Pending CL、Default↔编号移动、Submit 及 Shelf/Unshelve/Resolve 已完成 BE-003/004a/004b 生产接线；仍需 Windows/macOS 原生 UI 冒烟。重命名执行不在本批范围。
4. Pending 已使用后端 Jobs 与 opened/shelved 归属事实；锁、映射和策略未知状态仍不得由前端推断。Submit 的 unknown 保持显式呈现，不能把前端校验当作服务器事实。

### 第十批：测试整理与逐项审计

- CL 表单、移动文件、提交、版本选择四组测试统一使用 `app/dialogs/testHarness.tsx`，删除重复的 React root、原生 dialog stub 与清理代码；保留既有 23 项断言场景，没有以删测试换通过。
- 重跑全量 35 文件 / 215 项测试通过。只读进程检查未发现 P4Deck；已检查的 `src-tauri/target/debug` 没有可直接运行的 p4deck，release 目录不存在。未为 UI 验收构建或修改 Rust，也未执行 P4 写入。

下表中的“前端证据通过”仅涵盖明确的 UI-only 范围；原生项保持未验收。

| ID | 当前权威证据（源码位于 src/） | 审计结论 |
| --- | --- | --- |
| FE-01 | `app/dialogs/Dialog.tsx`；`workflow.test.tsx` 的键盘循环；`ChangelistFormDialog.test.tsx` 的初始/恢复焦点和忙碌；`ContextMenu.test.tsx` 的来源 document；第八/九批浏览器记录 | 浏览器与跨 document 证据通过；原生来源窗口待实测 |
| FE-02 | `ChangelistFormDialog.test.tsx` 10 项、`DeleteChangelistDialog.test.tsx` 3 项、`backend.test.ts` Pending 契约；第十一批接线记录 | 创建/编辑 Jobs/删除拒绝与成功已接 BE-004a；原生待验 |
| FE-03 | `MoveFilesDialog.test.tsx` 7 项；`FileClWorkflow.test.tsx` 3 项；`fileClScope.test.ts` 2 项；`PendingPage.test.ts` 局部合并 | Default 往返、固定快照、目标/连接失效、失败保留与局部刷新已覆盖 |
| FE-04 | `SubmitDialog.test.tsx` 11 项；`useCommandDialogs.test.tsx` 生产适配器接线；后端 Submit 契约测试 | BE-003 已接；blocker/warning/unknown/过期/漂移/成功/失败/防重复已覆盖，原生待验 |
| FE-05 | `RevisionDialog.test.tsx` 3 项；`revisionSelector.test.ts` 3 项；第三/九批页面记录 | 前端证据通过；实际 sync 未在 QA 执行 |
| FE-06 | `renamePath.test.ts` 3 项；`workflow.test.tsx` 的路径/草稿用例；第四/九批页面记录 | 前端证据通过；未声称映射或覆盖已验证 |
| FE-07 | `workflow.test.tsx` 的风险确认/目标快照；`fileActionFeedback.test.ts` 3 项；第九批 50,000 目标首尾导航/12 行 DOM | 前端证据通过；未测真实 P4 性能 |
| FE-08 | `ShelfDialog.test.tsx` 的首次/替换/删除子集、危险确认、过期与漂移；`FileClWorkflow.test.tsx` 跨 CL 分组；Mock/后端契约测试 | BE-004b Shelf 生产契约已接；原生待验 |
| FE-09 | `ShelfDialog.test.tsx` 的 Unshelve Default/编号/跨 Workspace 与映射/覆盖/锁/Resolve 风险；双 Backend 契约 | BE-004b Unshelve 生产契约已接；不提供强制覆盖，原生待验 |
| FE-10 | `ResolveDialog.test.tsx` 的策略过滤、blocked/unknown、逐文件计划、partial/unknown/成功、防重复与关闭保护 | BE-004b Resolve 生产契约已接；仅后端允许策略可执行，原生待验 |
| FE-11 | `PreflightStatus` 状态测试；第八批 Tab 实测；第九批 40 个布局组合；语义标签/错误不只靠颜色 | 已覆盖浏览器键盘与布局；原生及真实读屏未验收 |
| FE-12 | `useCommandDialogs.test.tsx` 3 项；工具栏/右键/Pending 复用同一业务对话框；`workflowRefresh.test.ts` 局部合并；生产 audit 隔离检查 | BE-003/004a/004b 入口整合已落地；因原生门槛未通过，不宣称整体完成 |
| FE-13 | `SubmittedPage.test.tsx` 的四态/无证据防升级/stale response/隐藏计数/重试/Mock/390px；`RevisionFileList.test.tsx` 的 10,000 文件窗口化与键盘；`tauriBackend.test.ts` 的窄请求 | BE-008 生产接线已落地；仅 reliable 隐藏，疑似/unknown 保持可见；原生点击与读屏待验 |

### 原生双平台验收步骤（待执行）

在 Windows 和 macOS 的开发桌面实例分别运行；使用演示/测试工作区，只检查界面，不确认实际文件操作。

1. 将 Files 和 Pending 分别弹出独立窗口；确认原页签移动且内容可见。
2. 在独立 Files 窗口右键打开重命名、指定版本、移动到 CL、Shelf、Resolve；弹窗必须出现在触发窗口，而非主窗口。
3. 在独立 Pending 窗口打开新建/编辑 CL、移动、提交、Shelf、Unshelve；确认完整标题、固定目标、风险说明和禁用原因。
4. 每个弹窗检查初始字段焦点，Tab/Shift+Tab 循环、Escape、草稿放弃确认、关闭后回到原触发器；Submit 只有有效未过期 token 才能确认写入。
5. 弹窗打开时关闭来源窗口、返回主窗口或改变连接；确认主窗口仍可操作、旧请求不占用命令通道、旧结果不覆盖新连接。
6. 在亮/暗色、中/英文和缩窄窗口下复查正文滚动、页脚可达、主题同步；记录平台、版本、结果和截图。发现问题只修前端；需要 IPC 行为变化时单独交给后端。

缺少对应平台桌面实例时，此项记为“未验证”，不是“通过”，也不以 iframe 或浏览器弹出提示替代。

### 环境阻塞确认

2026-10-08 Windows 收尾检查已重建并启动最新 debug Tauri，隔离 localhost Fixture 可用，系统进程显示 `P4Deck` 窗口响应正常；但 Computer Use 会话的原生应用清单为空且无可用窗口枚举入口，因而不能执行或留存 Pending/Submit/Shelf/Unshelve/Resolve 原生交互证据。macOS 仍没有本批实例。浏览器、单测、构建、应用层 E2E 和文档证据不能补足此原生门槛。

恢复条件：Computer Use 能返回并绑定 P4Deck 原生窗口，或由对应平台人员按上方清单返回可核验结果。恢复后继续原生验收及发现问题的前端修复；不自动扩大为后端开发，也不把目标改为只通过浏览器验证。
