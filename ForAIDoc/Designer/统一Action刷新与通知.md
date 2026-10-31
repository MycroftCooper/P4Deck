# 统一 Action、刷新与通知

## Action 目录

`src/app/commands/catalog.ts` 是 41 个生产命令的单一目录，供命令面板、前端快捷键和执行策略共同使用。Windows 原生顶栏菜单已按本人验收反馈移除：连接管理由 Settings 中现有的“已保存连接”区承担，Changes/Navigate/View 不再重复侧栏、页面和普通操作。写操作的 `execution.kind=shell` 只调用既有 `CommandBar`，因此目标校验、对话框、preflight、一次性 token、确认、取消和代次检查不会被命令面板或快捷键绕过。`pnpm validate:frontend-contracts` 自动校验 `AppCommandId` union、生产定义和本清单完整一致，并继续校验设计菜单、右键注册表与验收台账。

| 分组 | 稳定 ID | 动作 | Windows / Linux | macOS | 风险 / 确认 |
| --- | --- | --- | --- | --- | --- |
| App | `app.commandPalette` | 命令面板 | Ctrl+Shift+P | Cmd+Shift+P | 只读 |
| Connection | `connection.manageProfiles` | 连接 / 切换 Profile | — | — | 导航至受控 Settings 流程 |
| Navigation | `view.refresh` | 刷新当前数据 | Ctrl+R（别名 F5） | Cmd+R（别名 F5） | 幂等只读 |
| Changes | `workspace.sync` / `workspace.syncRevision` | Sync / Sync to revision | — | — | mutation；既有 Sync preflight/confirm |
| Changes | `changelist.submit` | Submit 所选 CL | — | — | mutation；既有 Submit preflight/confirm |
| Changes | `changelist.shelf` / `changelist.moveFiles` | Shelf / 移动到 CL | — | — | mutation；既有工作流状态机 |
| Changes | `file.rename` / `file.resolve` | Rename/Move / Resolve | — | — | mutation；既有 preflight/confirm |
| Changes | `file.lock` / `file.unlock` | Lock / Unlock | — | — | mutation；既有完整文件集预检与确认 |
| Changes | `file.checkout` / `file.add` / `file.delete` / `file.revert` | 文件写操作 | — | — | mutation；既有目标策略与适用确认 |
| Navigation | `view.files` | Depot 文件 | Ctrl+9 | Cmd+9 | 只读导航 |
| Navigation | `view.pending` / `view.submitted` | Pending / Submitted | Ctrl+1 / Ctrl+2 | Cmd+1 / Cmd+2 | 只读导航 |
| Navigation | `view.branchMappings` | Branch Mappings | Ctrl+3 | Cmd+3 | 只读导航 |
| Navigation | `view.search` | Global Search | Ctrl+Shift+F | Cmd+Shift+F | 只读导航 |
| Navigation | `view.workspaces` | Workspace | Ctrl+5 | Cmd+5 | 只读导航；切换仍走验证/CAS |
| Navigation | `view.streams` | Streams | Ctrl+7 | Cmd+7 | 只读导航；切换动作仍走验证/CAS |
| Navigation | `view.streamgraph` | Stream Graph | Ctrl+Shift+M | Cmd+Shift+M | 只读导航 |
| Navigation | `navigation.focusAddress` | 跳转到地址栏 | Alt+L（别名 Ctrl+G） | Option+L（别名 Cmd+G） | 只读；仅聚焦统一地址栏，不改变当前对象 |
| Tools | `view.diagnostics` | Diagnostics | Ctrl+I | Cmd+I | 只读 |
| File | `file.diff` | Diff | Ctrl+D（别名 Ctrl+Shift+D） | Cmd+D（别名 Cmd+Shift+D） | 只读；要求适用的单文件上下文 |
| File | `file.history` / `file.revgraph` / `file.preview` | 文件查看工具 | Ctrl+T / Ctrl+Shift+R / — | Cmd+T / Cmd+Shift+R / — | 只读；要求适用的单文件上下文 |
| File | `file.reveal` / `file.openWith` | 系统定位 / Open With | Ctrl+Shift+S / — | Cmd+Shift+S / — | 本地系统能力检查 |
| Navigation | `swarm.open` | 在 Swarm 中打开 | — | — | 只读外链；活动 profile/context CAS 与 URL allowlist |
| App | `operation.cancel` | 取消当前操作 | — | — | 仅在现有状态机允许时可用 |
| Tools | `tools.openTerminal` | Terminal | Ctrl+Alt+T | Cmd+Option+T | sensitive；继续受 Terminal 双层安全策略约束 |
| Tools | `tools.openP4Log` | P4 Log | Ctrl+Alt+L | Cmd+Option+L | 只读 |
| Tools | `tools.popoutTerminal` / `tools.popoutP4Log` | 独立窗口 | — | — | 仅主窗口；复用受控 popout |
| App | `view.settings` | Settings | Ctrl+, | Cmd+, | 只读导航 |
| App | `refresh.toggleAuto` | 暂停 / 恢复自动刷新 | — | — | 只读偏好 |
| Tools | `panel.dockBack` | 停靠回主窗口 | Ctrl+Alt+D | Cmd+Option+D | 仅独立窗口 |

快捷键按平台精确解析：Windows/Linux 只接受 Ctrl，macOS 只接受 Cmd；普通快捷键在 input、textarea、select、contenteditable 和 textbox 内不触发。命令面板及旧 Terminal/P4 Log 快捷键明确允许在编辑焦点下使用。mutation 不分配直接快捷键，也不能绕过上下文禁用原因；只读/导航命令按 P4V 默认映射绑定主键位，`aliases` 仅作默认兼容键位（参与分发与冲突检测，不进入后续 Settings 的可编辑主键）。

## Retry 边界

- `shared/lib/retry.ts` 只允许 `read` / `refresh` 且 `idempotent=true` 的任务自动重试；mutation 即使报告网络错误也只执行一次。
- offline、server unreachable、timeout、temporary busy 使用指数退避、±20% jitter、硬最大延迟和最多三次尝试；认证、权限、非法输入与未知错误不自动重试。
- 每次尝试前后比较 profile + context generation，并接受 AbortSignal。切换 Profile/Workspace、暂停、组件卸载或新刷新都会取消旧任务，迟到结果不能更新当前状态。
- Submit、Sync、Shelf、Resolve、Rename/Move 和普通文件 mutation 失败后只保留现有明确人工恢复入口；永不隐式重放。

## 自动刷新

- 默认开启，间隔为 `UiPreferences.autoRefreshMinutes`（默认 5 分钟，0 关闭，对应 P4V 的 “Check server for updates every n minutes”）；可在 Settings、状态栏或 `refresh.toggleAuto` 暂停/恢复，状态栏显示刷新中、失败和上次更新时间。
- 计时器每分钟检查一次是否到期；重新聚焦、从隐藏恢复、网络恢复也只在距上次刷新满足配置间隔时才触发。隐藏、离线或暂停时不刷新；进行中的刷新合并重复触发；手动刷新不受间隔限制。
- 每轮先 `markSnapshotsStale()` 把全部服务器快照标记为过期但不发请求，再只向当前活动页（Pending、Submitted、Workspaces、Streams、Stream Graph、Branch Mappings、History/Diff/Rev Graph）和共享 Workspace/Depot 活跃查询广播刷新；其他页在切回时发现过期才后台重验。Search 仍由用户明确提交查询，写工作流中的快照页不会后台刷新。
- 刷新期间页面保留旧行，只显示角落转圈；失败状态保留并提供 `view.refresh` 人工恢复，不以无限重试掩盖 partial/truncated。操作后的定向刷新走 `invalidateData(effects)`，详见 [数据缓存与操作架构](../Coder/数据缓存与操作架构.md)。

## 桌面通知

- 偏好默认关闭，可选择“长操作与需处理事件”或“仅失败与需处理事件”。应用在前台可见且聚焦时不发系统通知。
- operation error、长于 15 秒的完成事件、认证过期/外部认证需求进入同一通知中心；相同 key 30 秒冷却去重。
- 标题/正文在适配器边界再次清洗 password/ticket/token、本地用户路径与 depot path，并限制长度。通知内容只用于召回，完整细节仍在脱敏 P4 Log / Journal。
- 当前实现使用可测试的 Web Notification 适配层；Windows/macOS Tauri WebView 的系统权限提示、通知中心展示、点击行为和辅助功能必须真机验收，自动化不得宣称已通过。

## 自动化证据与外部项

Web 单测覆盖 action ID/元数据完整性、跨平台冲突、编辑焦点、禁用原因、全量 CommandBar 映射、mutation 无快捷键且必须回状态机、重试分类/退避/取消/代次漂移、自动刷新可见性/节流/迟到隔离，以及通知去重/脱敏/偏好/前台抑制。前端 contract validator 会在 union、生产定义或文档清单漏掉任一命令时失败；它不再制造已删除的 Rust 原生菜单 ID 镜像。

仍需外部执行：Windows Tauri 中确认系统菜单栏已经消失、Settings 连接管理仍可达，并验证前端快捷键、输入法/编辑器焦点、独立窗口前后台节流、系统通知权限/展示、真实网络上下线与认证过期、原生读屏。上述事项未由 jsdom 或纯函数测试替代。
