# QA-B01 阶段报告：待 PM 协调专用入口

本轮仅写 src/test/batch-qa；未修改产品、旧证据或 Vite 配置。根及 D:/GitCode、D:/ 的 AGENTS.md 和仓库 .agents 均未发现。已读 ForAIDoc/README、PM 顶部批次单及本机 TODO。工作树原有修改保留。

## 实际完成

运行 `node src/test/batch-qa/audit-baseline.mjs`，exit 0。证据 `evidence/baseline.json` 记录 97 个源码/夹具/配置文件 SHA-256，7 个历史绑定 hash 全匹配；4 个静态存在性断言通过。这些是静态检查，不是 4 个 UI/行为测试。未发现上述有历史 hash 文件漂移；没有历史完整依赖 hash，不能证明全部依赖未变。

| 范围 | 本轮核对与复用 | 尚未覆盖 |
|---|---|---|
| Branch | BranchMappingsPage hash 匹配，复用历史隐藏恢复/末行的限定记录 | 当前完整依赖组合回归 |
| JSON | FilePreviewPage、preview.css hash 匹配，复用历史正文/零尺寸恢复 | 当前完整依赖组合回归 |
| Gate | ConnectionSetupGate hash 匹配，复用历史设置可达/拒绝关闭保留记录 | 真连接、native 关闭与共同会话 |
| Pending | PendingPage、pendingFilterState hash 匹配；已实际查看旧 sort-390.png，Default/2/10/100、按钮可见 | 真导航接入、提交预检/确认/目标的本轮 mock 交互 |
| scrollbar | scrollbars.css hash 匹配；复用历史双主题拖动范围，不累计旧测试数 | 当前共同会话及 OS/WebView 行为 |
| TopBar/UI07 | 已查看旧 390-1.png：未见重复窗控，但导航是合成文字 | 旧 results 无源码 hash，不能绑定当前代码；原生故障未验 |
| 顶栏去重 | CommandBar groups 不含 submit；submit 分派、Pending submit 和 dialogs 的 preflightSubmit/confirmSubmit 静态仍存在 | 宽窄/文字/icon/溢出、真实 ActivityBar 点击、提交确认行为均未执行 |

静态存在性不能证明流程没有绕过或参数正确。旧 Pending fixture 的 CommandExecutionContext 是空函数，故其旧排序结果不证明提交确认链。旧 TopBar fixture 没有加载 CommandBar/ActivityBar，不能用旧无重复窗控图片证明提交入口去重。

## 明确阻塞（非权限拒绝）

动作：给顶栏去重及真实待提交导航建立 synthetic 浏览器 fixture。目标：`src/test/preview-audit/vite.config.mjs` 的白名单与隔离依赖替身。原因：现有配置未允许 CommandBar、ActivityBar、SubmitDialog/真实提交 dialog 链；QA-B01 明确规定既有配置需改白名单先报 PM，不能自行扩大。状态：**尚未执行，待 PM 协调配置所有权/精确白名单**；没有 auto-review 拒绝或不确定执行。

建议 PM 协调根/配置负责人：保留 App/main/Tauri/真实 backend 的拒绝规则，仅对 CommandBar、ActivityBar、panels、pageIcons、commandPolicy 及必要样式逐项放行；对 ContextMenu/environment、useCommandDialogs、cache、clipboard、localCapabilities 等逐项指定合成替身，禁止宽泛目录放行。真实提交确认链可用已审纯 mock 定向测试另证，不能由空 command handler 冒充。所有新夹具/输出继续限本批目录。配置变更后重新核验依赖图，允许本批目录的精确文件，再核身份启动一次专用 server。

本轮没有启动任何 server、浏览器、默认应用、Tauri、P4、公司工具、安装器；无外部请求，没有待清理的本任务浏览器/server。未运行运行时 mock 套件或合并浏览器回归，未新增运行时通过/失败数字。按批次顺序，步骤 2 的入口准备阻塞，步骤 3 等同会话条件满足后继续。没有确证产品 bug，不派新产品任务。

## UI-07 最小 Windows 宿主故障方案（仅计划）

前置门槛尚未满足，**待原生验收**。需 PM/BE 提供专用 synthetic host 入口及正式运行审批，绝不能启动当前默认 main/App/Tauri。使用可回滚独立 Windows VM/专用测试账户；记录入口源码 hash、编译产物 hash、进程路径/命令行、构建依赖和数据目录。测试宿主只复用已冻结 close_guard/close_policy；专用注册的 IPC 仅允许 close-guard 测试协议，不注册生产命令，不加载真实 backend，不启动 P4/公司工具。

数据与凭据：数据目录在一次性合成目录，Profile/journal/editor 内容只有合成标记；显式注入空连接配置和合成 journal，不读取用户 home、系统票据、真实配置或旧恢复队列。环境快照只记录允许键名称和 synthetic 值；禁用 PATH 搜索/继承 P4CONFIG/P4TICKETS/P4PORT 等生产定位路径，不复制任何真实环境值到证据。运行前以代码及受控访问记录证明全部读取目标，不能用“测试参数”代替隔离证据。

网络与操作：不改变系统防火墙/代理/安全设置。宿主构建不包含生产操作执行器；仅使用内嵌 synthetic 页面或明确 loopback 专用故障服务，无远端 URL，服务 owner/PID/端口必须记录。主动/未知操作由纯内存计数与合成 journal 注入；确认框使用真实 Windows MessageBox，不能用浏览器 confirm 假冒。无法证明无真实连接/凭据继承即停止运行。

| 场景 | 操作与预期 | 必留证据 |
|---|---|---|
| 页面导航失败/服务不可达 | 仅停止本次专用故障服务；主窗和 popout 用系统关闭/Alt+F4，仍有宿主确认通道 | 原生屏录/窗口身份、CloseRequested 与 MessageBox 日志 |
| 初始化失败/无 FE 报告 | 不创建 React 或注入初始化失败，超时为 unknown，拒绝确认窗口保留 | probe/代次/超时/拒绝记录 |
| dirty/unknown/伪 clean | 合成脏状态及旧代次/旧序号/无认证 clean；不得自动降为可信 clean | 报告拒收、确认前后快照 |
| 在途/结果未知 | 内存 active 和合成 unknown journal 阻止错误退出，取消不丢状态 | 同锁准入与关闭决定记录 |
| 确认竞态 | 确认后操作/新窗口/导航代次变化，过期许可失效 | revision、permit、真实销毁事件顺序 |
| 主窗/popout 范围 | popout 关闭只作用指定窗口，主窗退出覆盖需保护窗口 | 窗口集合、退出决定与存活结果 |
| 可关闭路径 | 无真实操作，仅对当前 unknown 人工确认允许关闭；拒绝后可再次请求 | 真正窗口销毁/进程结束，不强杀代替成功 |

收尾只结束本任务已核身份的服务与 host；保留异常证据，不能杀他人进程或清理真实配置。Windows 安装/卸载/跨设备另列 PKG-01，浏览器和本计划均不能证明这些通过。
