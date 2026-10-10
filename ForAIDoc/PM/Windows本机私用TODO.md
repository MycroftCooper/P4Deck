# Windows 本机私用 TODO

> 当前阶段唯一执行清单。目标是在**当前这台 Windows 机器上供本人私用**，不是公开发布、跨平台交付或企业部署。
> 建立日期：2026-10-10。事实基线：本地 `master` 已有前后端实现、自动化门禁和 Windows localhost `p4d` 证据；尚未取得与最新提交绑定的 Tauri 原生窗口点击证据，也尚未验证本人实际 P4 Server。
> 历史实现记录继续保留在《前端操作流程 TODO》和《后端 TODO》，但不再作为当前任务队列。

## 安全红线

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

### WIN-P0-01 — 最新 Tauri 构建、启动与版本绑定

- **目标**：从干净的当前 `master` 生成并启动最新 Windows 原生应用，而不是只验证 Web bundle。
- **为何阻塞本机私用**：`pnpm build`、浏览器 Playwright 和 Rust 单测都不能证明 WebView2/Tauri 进程、资源、IPC 与原生窗口能够在本机正常启动。
- **具体实现/验收步骤**：记录 commit 与工具版本；执行本地快速门禁；按项目已有 Tauri 入口完成 debug 或 release 构建；从生成物启动主窗口；确认无白屏、panic、资源缺失或立即退出；退出后确认无残留写操作进程。若 build/start 失败，只修复直接阻塞本机启动的问题，另立变更提交。
- **完成证据**：commit SHA、实际命令与退出码、生成物路径、启动/正常退出时间、主窗口截图或人工验收记录，以及无敏感信息的启动日志。
- **负责端**：前端负责壳/UI 启动；后端负责 Rust/Tauri/IPC 启动错误；PM 核对证据绑定同一 commit。

### WIN-P0-02 — 最新构建的 Windows 原生 UI 冒烟

- **目标**：在 Tauri 原生窗口中确认本人会使用的核心入口可点击、可聚焦、可恢复。
- **为何阻塞本机私用**：现有 82/481 Web 测试、5 项真实 Edge 测试和 localhost 服务层 E2E 没有覆盖原生应用菜单、WebView2 焦点、窗口恢复、系统对话与 IPC 串联。
- **具体实现/验收步骤**：先连接隔离 fixture；依次检查启动/退出、设置与 Profile、Workspace/Depot、文件预览、Diff/History/Graph、Pending/Submitted、Search、Streams/Stream Graph、Branch Mappings、Shelf、Terminal/P4 Log/Operations/Diagnostics；验证命令面板、菜单、主要快捷键、390px 主窗口、dock/popout/归还、关闭后重开和焦点恢复；对 Submit、Shelf、Resolve、Stream 切换、Branch Mapping create/edit/delete、Lock/Unlock 只在测试数据上执行。Force Unlock 只可使用隔离 fixture 中明确创建的另一 User/Client 正数 numbered CL；`default`、`-s`、`-x` 只验证 blocker，不得尝试绕过。记录每一步通过/失败及所用构建。
- **完成证据**：按页面/动作列出的原生冒烟表、关键截图或录屏、operation/log ID、窗口恢复前后记录；必须明确写“Windows Tauri 原生”，不能用 Edge 截图替代。
- **负责端**：前端主责交互与窗口；后端协查 IPC/operation；PM 执行或见证冒烟并归档结果。

### WIN-P0-03 — 本人 P4 Server 连接与实际认证

- **目标**：在应用内连接本人实际使用的 Server、User、Client/Workspace，并确认该 Server 实际要求的认证路径。
- **为何阻塞本机私用**：localhost fixture 证明协议和安全边界，但不能证明本人 Server 地址、权限、ticket/trust 策略和 Workspace 映射可用。
- **具体实现/验收步骤**：先备份现有应用配置；创建单独 Profile，输入非敏感 Context；通过应用完成 CLI 发现、`p4 info` 和 `p4 login -s`；仅在服务器确实要求时执行 SSL trust 或外部 SSO/MFA；选择本人测试 Client/Workspace，浏览 Workspace/Depot，并核对 Server/User/Client/Root/Stream。失败时保持旧活动 Profile，不覆盖原配置。
- **完成证据**：脱敏连接状态、实际认证类型、只读页面成功记录、失败回滚记录和配置备份位置；不保存密码、ticket、fingerprint 全文或内网地址。
- **负责端**：PM/本人提供环境并验收；前端负责向导状态；后端负责认证分类、Context 与代次隔离。

### WIN-P0-04 — 核心读写安全演练

- **目标**：证明日常“浏览 → 修改 → Pending/Review → Shelf/Resolve → Submit”链路在安全边界内可用，并能恢复到已知状态。
- **为何阻塞本机私用**：自动化已验证实现，但首次用于个人数据前仍需确认实际权限、映射、文件类型、trigger 和服务器策略不会产生意外写入。
- **具体实现/验收步骤**：先在隔离 fixture 完整执行一轮；再仅在本人专用测试 Depot/Client/CL 上执行 Sync、Edit/Add、Move、Revert、Pending 移动、Lock/Unlock（若权限支持）、Shelf/Unshelve、文本 Resolve 和 Submit；Force Unlock 仅当本人确有管理员需求时，另用可删除测试文件、另一测试 User/Client 与正数 numbered CL 演练，逐项核对 owner/origin/admin proof 和写后验证。每个 mutation 先核对预检目标、blocker/warning、operation ID 和刷新建议；包含一次主动取消或失败场景；最终核对 Submitted 结果并删除/归档测试数据。真实生产 Depot 只做只读检查。
- **完成证据**：脱敏的测试路径标识、操作前后文件/CL 清单、各状态机结果、服务器侧复核、清理结果和任何不支持能力的安全降级说明。
- **负责端**：前端验证状态机呈现；后端验证命令、token、Journal/Log 与最终状态；PM/本人控制测试范围并确认清理。

## P1：进入日常使用前完成

### WIN-P1-01 — 故障恢复演练

- **目标**：确认网络中断、认证失效、取消、异常退出和未知结果不会被误报为成功，且用户知道如何恢复。
- **为何阻塞本机私用**：P4 写操作发生中断时，错误重试可能造成重复操作或错误判断；必须先证明刷新与人工复核路径可用。
- **具体实现/验收步骤**：只在 fixture/测试 Depot 注入 CLI 不可用、Server 停止、ticket 缺失/过期等可恢复故障；在只读请求和一项可取消长操作中检查取消/重连；执行中关闭应用后重启，确认 Journal 将未终结操作标记为 interrupted 且不自动重放；对 partial/unknown 结果按提示刷新并从 Server 侧核对。
- **完成证据**：每类故障的 UI 状态、Journal/Log、重启后状态、人工恢复步骤和最终数据一致性记录。
- **负责端**：后端主责故障分类与不可重放；前端主责恢复入口；PM 核对结果没有假成功。

### WIN-P1-02 — 本地数据备份与回滚

- **目标**：能够备份并恢复 P4Deck 的非敏感配置、布局和必要本地状态，同时安全处理 ticket/trust 等外部凭据。
- **为何阻塞本机私用**：当前只有本地 Git；应用配置损坏、磁盘问题或误切 Profile 时，需要无需 remote 也能恢复可用状态。
- **具体实现/验收步骤**：识别本机应用数据目录、Profile 配置、布局、日志/Journal/诊断与 P4 外部 ticket/trust 的实际位置；列出“备份”“不备份/单独保护”“可删除重建”三类；关闭应用后制作本地离线备份；在临时副本或测试账户验证一次恢复；记录回滚到上一 Git commit 和恢复应用配置的命令。不得把凭据加入仓库或普通压缩包。
- **完成证据**：脱敏文件清单、备份时间/介质、恢复演练记录、校验结果和回滚手册；不提交备份本体。
- **负责端**：后端说明持久化边界；PM/本人执行备份恢复；前端核对恢复后的布局/Profile 表现。

## P2：阶段收口

### WIN-P2-01 — 本机稳定性观察与最终文档收口

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
- Label/Job 独立工作台与 Stream spec 写入等后续产品功能。Force Unlock 前后端专用闭环已完成，但不表示本人 Server 管理权限或特殊锁来源已验证；Branch Mapping 前后端工作台也已完成。两者 Windows 原生点击及真实权限/trigger 行为仍须按本清单安全边界验收。
- 菜单台账中 190 个 `phase: later` 项。

## 新增功能实施批次（不改变上述验收顺序）

- Stream Graph 前后端只读闭环已独立完成：正式全局 panel/Streams 入口、确定性 parent→child 分层、可访问虚拟树、过滤/分页/取消/重试、详情/键盘/390px、复用安全切换对话框，以及强类型契约、Tauri adapter、明确 simulated 的 Browser Mock、有界 `p4 streams` 采集、scope 复核、一次性分页游标和 Windows localhost fixture 均已落地。
- Web 组件与真实 Edge 已覆盖分页去重、游标失效重启、迟到隔离、大图 DOM 上限、390px 和 axe；这仍不表示 Windows Tauri 原生 panel/popout 已点击验收，需并入 WIN-P0-02 留证。
- Branch Mapping 前后端安全闭环已独立完成：正式全局 panel、Streams/Dock/Activity 入口、虚拟列表与 opaque cursor、原样详情/View 语义、正反 `integrate -n` 只读影响预览，以及专用 preflight→confirm create/edit/delete 均已接入；Client mapping/owner/unknown/TOCTOU/危险删除阻断、一次性 cursor/token、Tauri adapter 和明确 simulated 的 Browser Mock 均复用后端权威契约。Web 组件与真实 Edge 覆盖 390px、键盘、axe、大列表 DOM 上限、分页/迟到隔离和模拟增删改闭环。
- Force Unlock 前后端专用闭环已独立完成：文件工具栏提供与普通 Unlock 分离的高危入口，路径只能来自 1～128 个精确 depot file 选择快照；专用对话框展示后端权威 server/profile/user/client、owner/origin/permission proof、blocker/warning，并要求精确 typed acknowledgement。取消/连接变化隔离迟到响应，执行结果逐文件展示并强制刷新；只有 complete + 全部 `unlocked` 才显示验证成功。后端只允许已证明的正数 numbered changelist，完整 Connection/generation、一次性 token、mutation lane/TOCTOU 与写后复核仍由 Rust 权威执行；普通 unlock 没有 force 开关，generic GUI 旁路仍关闭。Browser Mock 明示 simulated。standard localhost 不能证明 distributed `-x`，tagged facts 不能可靠证明 aborted-submit `-s`，均保持 blocker。
- 上述浏览器或 fixture 证据不表示 Windows Tauri 原生 panel/popout、Force Unlock UI 或本人 Server 权限/trigger 已通过；分别并入 WIN-P0-02 与 WIN-P0-03/04。新增功能批次不改变 WIN-P0/P1/P2 的本机私用安全顺序，也不带入 Stream spec 写入。
