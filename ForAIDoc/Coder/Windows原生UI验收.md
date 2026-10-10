# Windows Tauri 原生 UI 验收

> 验收日期：2026-10-10
>
> 首轮 UI 基线：`94b5f0c feat(search): add stream and shelf navigation`
>
> 历史修复提交：`707e51e fix: refresh force unlock file facts`（用户随后决定下线整个 Force Unlock 功能，不再需要原生复验）
>
> 范围：当前 Windows 机器、真实 Tauri/WebView2 窗口、隔离 `127.0.0.1:16661` fixture。本文不把浏览器 Mock、localhost 服务层或独立 CLI 结果单独冒充为原生 UI 通过。

> 后续人工验收决定：原生窗口顶部的 Connection/Changes/Navigate/View 菜单重复现有 Settings、侧栏与页面操作，且不在设计内，现已退役。本文保留首轮窗口的历史观测，但不再把点击这些旧菜单列为当前验收目标；下一版只验证菜单栏消失、Settings 连接管理仍完整可达，以及命令面板/前端快捷键未回归。

构建、进程、fixture、隔离用户数据及后端交叉复核见 [Windows 原生构建与运行验收](Windows原生构建运行验收.md)。本文只记录实际发生过的原生窗口交互，以及尚未点击或尚未复验的边界。

## 1. 绑定的原生构建

| 项目 | 证据 |
|---|---|
| Git 基线 | `94b5f0c0179e40af0041cf833ecc38467781b7df` |
| 构建命令 | `pnpm tauri build --debug --no-bundle`，exit 0 |
| 原生 exe | `D:\GitCode\P4Deck\src-tauri\target\debug\p4deck.exe` |
| SHA-256 | `D0C3D6D3BA12F750CA49246C4F15561B6101522540EB6F2C9258EC0A0D0C52A2` |
| 原生窗口 | 标题 `P4Deck`，进程与窗口可见且响应；Windows 11 build 26100 / WebView2 154 |
| 数据范围 | 全新隔离 P4Deck profile 数据 + loopback fixture；未连接本人 Server，未读取 ticket 内容 |
| 历史修复构建 | 源码 `707e51e` 曾重新执行同一 Tauri debug build，exit 0；SHA-256 `C821BA49A564FC1517AB295935B74FEFBC58DFC29E91FD52AEB5C5EB1B4C3602`。该 exe 未启动，随后 Force Unlock 整体下线 |

WIN-P0-01 的首轮构建/启动证据已取得。旧隔离验收 PID 已正常关闭，fixture 已停止且 `127.0.0.1:16661` 无 listener，原 Roaming/Local 已恢复；测试数据快照保留为同级 `.native-test-snapshot-20261010-194736`。移除 Force Unlock 后的 `3c21d03` 也已成功重建并由本人启动人工验收；本次原生菜单下线决定来自该实际窗口，但完整原生回归尚未完成。本人已授权后端结束标准 exe 的残留 PID 并重建菜单移除版；最新构建状态、hash 与进程证据以 [Windows 原生构建与运行验收](Windows原生构建运行验收.md) 为准。下一步是由本人启动最新产物验证菜单栏消失与 Settings 连接入口，而不是复验 `707e51e`。

## 2. 已实际通过的原生交互

| 场景 | 原生窗口实际操作与结果 | 交叉证据/边界 |
|---|---|---|
| Profile 与 IPC | 在设置中创建并保存 `p4deck-fixture` profile，填写 fixture Server/User/Client 与 ticket **路径**；草稿和保存后的活动 profile 均显示服务器连接及当前登录票据验证通过 | 后端日志确认 GUI IPC 统一指向 `127.0.0.1:16661`、`p4deck-fixture`，connection ID 一致；没有读取 ticket 内容，也没有自动化登录或安全设置 |
| Workspace 校正 | 初始未激活 profile 时曾把 debug exe 目录当 cwd，并出现非 Client Root 提示；激活 profile 后 Files/Workspace 切到 `D:\GitCode\P4Deck\.tools\p4d-fixture\workspace`，错误上下文消失 | 这是 profile 激活后的真实上下文切换，不应把首屏 debug cwd 解释成最终 workspace 已验证 |
| 七类 Global Search | 在原生 Search 页看到 Submitted、Pending、Workspace、Depot、Job、Stream、Shelf 七类；搜索 `p4deck-native`，显示 5 个 fixture Stream、Shelf 4447/4448，并显示 Shelf 有界深搜的 partial 提示 | 结果字段来自正式后端；partial 类别没有拖垮其他类别。`deep-path` 唯一 Shelf 点击到详情尚未完成 |
| Search → Stream | 点击 `Native Main` 结果后进入正式 Streams 页面，并带入精确路径 `//p4deck-native-stream/main` | 证明 Stream 搜索结果的显式状态导航在该 build 的原生窗口可用 |
| Stream Graph | 打开正式 Stream Graph；可访问树呈现 5 个节点及 parent→child 关系：main、dev、task、virtual、release；选择 Native Release 后详情显示 path、owner、type、parent、ParentView/flow 字段 | 未发现虚构父节点或 merge/copy 状态。缩放、完整键盘导航、popout 和窄屏未形成通过证据 |
| Branch Mapping list/detail | 打开正式 Branch Mapping，选择 `p4deck-native-branch`；详情原样显示 owner、description/options 和 View `//depot/main/... -> //depot/p4deck-native-branch-target/...` | 服务端 fixture spec 与 UI 一致 |
| Branch forward preview | 在 UI 运行专用 forward preview；明确显示只执行 `integrate -n`、不修改 workspace/不 open 文件，并显示 README 的 branch 动作、source 与 target | 后端日志只见 `p4 integrate -n`，无真实 integrate |
| Branch CRUD | 只对本轮独立 spec `p4deck-native-ui-branch` 执行 create → edit description → 高危 delete；三次均经过专用 preflight/一次性 token/确认及 server verified 结果 | 后端 tagged CLI 复核最终 spec 不存在，seed branch 与既有 permission-map 未动。不能外推到本人 Server 权限/trigger |
| Force Unlock（历史、已下线） | 在 Files/Depot 精确选择 `//depot/p4deck-native-lock/other-owner.txt`；独立高危流程显示 owner/client/CL4449/origin、`super` permission proof、风险和精确 acknowledgement；输入后确认，结果页显示 `1/1` 完整验证 unlocked | 后端独立复核唯一 mutation 为精确 `unlock -f -c 4449`；opened 记录仍为 CL4449，而 `fstat -Ol` 已无 lock。用户随后决定从面向普通用户的产品中移除此功能；本行只保留真实历史，不代表当前能力或待验项 |

本轮没有可持久引用的截图 ID，因此本文不编造截图编号；表中结论只来自已经执行并观察到的真实原生操作，后端字段只作为交叉复核。

## 3. 历史问题与后续下线决定

### Force Unlock 后 Files 锁事实未自动刷新（历史）

首轮复现步骤：

1. 在 build `94b5f0c` 中完成上述 Force Unlock，并看到完整验证成功结果。
2. 关闭结果页并等待超过约 1.6 秒，Files 行仍显示旧的 other-owner 锁标识。
3. 手动点击 Files“刷新”，约 1 秒后旧锁标识消失。
4. 同期独立 `fstat -Ol` 已确认服务端锁不存在，因此缺陷位于前端执行后刷新/当前 selection 元数据更新，而不是后端 mutation。

`707e51e` 已做最小修复：Force Unlock 的 success、partial/rejected 和 thrown-error 路径会实际重新加载当前 connection 的 Workspace/Depot 锁事实，并把重新解析的节点写回当前 command/selection；`resolveSelection(..., refresh=true)` 也会把 authoritative refresh 透传到后端。定向 3 个测试文件、14 项测试、`pnpm check:web`、Prettier check 和 `git diff --check` 均通过。

`707e51e` 曾生成新 Tauri exe但没有启动复验。用户随后决定彻底移除 Force Unlock：P4Deck 面向普通用户，管理员强制解锁由后台执行。因此该刷新问题随功能下线关闭，不再是 WIN-P0-02 阻塞，也不应重新 seed 管理员锁或安排原生复验。历史操作与缺陷仍保留在本文，不能改写成“从未存在”。

## 4. 有限剩余原生验收清单

以下项目没有在本轮真实窗口中完成，不得按“通过”统计：

1. 构建并启动移除原生顶栏菜单后的新 exe，确认已下线的管理员强制解锁入口/API 仍不存在，且 Connection/Changes/Navigate/View 系统菜单也不再显示；Settings 中 Connection Profiles 的 CRUD、验证、激活与认证入口仍可达，普通 Lock/Unlock 与 other-owner blocker/提示仍可用。
2. 完成 Shelf 深搜 `deep-path` 的唯一 Shelf 结果 → 独立 Shelf detail 导航、返回与焦点恢复。
3. 补齐 Workspace/Depot、Preview、Diff、History/Revision Graph、Pending、Submitted、Shelf、Terminal/P4 Log、Operations、Diagnostics 的主要只读入口冒烟；确认 Activity Bar 已无重复 Terminal/P4 Log、Stream Graph、Branch Mappings 按钮，前两者仍可从底部工具区手动打开、后两者仍可从 Streams 页按钮进入；测试 Error 只点亮红点而不自动展开/切换且查看后清除。已打开或后端有命令日志不等于这些页面全部通过。
4. 只在隔离 fixture 完成 Submit、Shelf/Unshelve、Resolve、Stream 切换、普通 Lock/Unlock 等剩余安全写入演练；Branch CRUD 不能替代整套写入验收。
5. 验证命令面板、主要前端快捷键、Tab/回焦/Escape；确认已退役原生顶栏菜单不再出现，不再执行旧菜单点击矩阵。
6. 验证主窗口真实 390px、关键页面无意外页面级横向溢出，以及 dock/popout/关闭归还。
7. 验证新版正常启动/关闭、再次打开和布局恢复；原用户数据目录已恢复，但为避免自动连接真实 Server，本轮未用其启动应用。

fixture 收尾已精确删除 Shelf 4447/4448、历史 Force target pending CL4449 及其临时 owner/client/user、原生测试 branch；下轮只为仍在范围内的 Shelf 等场景重新 seed，不再创建管理员强制解锁目标。CL4446 的 4 个已提交文件、5 个 native streams、历史 permission-map/shelf2 仍保留，不能把已清理的编号当成仍可直接复验的数据。

完成以上清单前，不能声明 WIN-P0-02 或整个 Windows 本机私用阶段通过。

## 5. 原生控制停止事实

在 `707e51e` 提交后、准备关闭旧应用并交接重建时，原生控制工具返回原文：

> Computer Use was stopped by the user with the physical Escape key.

依工具约束，本轮随后没有继续调用 Computer Use，前端验收 Agent 也没有再点击或关闭应用。后端随后已正常关闭旧 PID、恢复原配置、保留测试 snapshot、精确清理临时 seed 并停止 fixture；这些是构建运行侧证据，不是新增原生 UI 点击。

## 6. 结论

- build `94b5f0c` 已取得真实 Windows Tauri Profile/Workspace、七类 Search 与 Stream 跳转、Stream Graph 拓扑/详情、Branch list/detail/forward preview/CRUD、Force Unlock preflight/ack/confirm/服务端真解锁证据。
- 首轮 Force Unlock 的 mutation 和后续自动刷新缺陷属于真实历史；用户已决定将整个管理员功能下线，因此不再作为当前能力、阻塞或待复验项。
- 390px、dock/popout、命令面板/前端快捷键、最终构建无原生顶栏菜单、完整页面冒烟、重开/布局恢复及完整只读/安全写演练没有通过。
- 本人 P4 Server、真实认证/权限/trigger、故障恢复、备份恢复和 2 小时稳定性仍完全属于后续 WIN-P0/P1/P2 验收。
