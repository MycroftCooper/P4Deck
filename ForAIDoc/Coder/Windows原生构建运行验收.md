# Windows 原生构建与运行验收

> 验收日期：2026-10-10
> 首次原生验收基线：`94b5f0c0179e40af0041cf833ecc38467781b7df`
> 修复后最终构建基线：`707e51e0ade13053f1e775c9154a1d973f873de3`
> 报告提交前仓库 HEAD：`2dd0cb9`（仅追加前端验收文档；应用源码仍对应 `707e51e`）
> 移除管理员强制解锁后的最终源码构建基线：`3c21d03cc56cbe8ff8eab62082041280bba76853`
> 移除原生顶栏菜单的生产源码：前端 `48b91a0` + Rust `00bbf34`
> 范围：debug 原生应用、隔离 localhost P4D、结构化运行证据。本文不把前端点击、安装包、签名、公证或长期稳定性冒充为已验证。
> 产品边界更新（2026-10-10）：管理员强制解锁已从 P4Deck 完全移除。下文相关内容仅是退役旧构建的历史验收证据，不代表当前产品能力，也不再构成当前原生复验阻塞。

## 1. 本机环境与构建产物

| 项目 | 本轮观察值 |
| --- | --- |
| Windows | Windows 11 专业版 64 位，`10.0.26100` |
| WebView2 Runtime | `154.0.4258.62` |
| Node / pnpm | `v24.16.0` / `11.19.0` |
| Rust / Cargo | `1.97.1` / `1.97.1` |
| Tauri CLI | `2.11.4` |
| 构建命令 | `pnpm tauri build --debug --no-bundle` |
| 构建结果 | 四个记录基线均 exit 0；先执行 `pnpm build` 生成 `dist`，再编译 Tauri debug 应用 |
| 可执行文件 | `D:\GitCode\P4Deck\src-tauri\target\debug\p4deck.exe` |
| 当前大小 | `32,119,296` bytes（生产源码 `48b91a0` + `00bbf34`） |
| 首次 build SHA-256 | `D0C3D6D3BA12F750CA49246C4F15561B6101522540EB6F2C9258EC0A0D0C52A2`（`94b5f0c`，用于本轮可见窗口/IPC 验收） |
| 旧最终 build SHA-256 | `C821BA49A564FC1517AB295935B74FEFBC58DFC29E91FD52AEB5C5EB1B4C3602`（`707e51e`，退役旧功能构建） |
| 管理员能力移除 build SHA-256 | `E42333BCE95E46E47BF13755026FC7F98AB0EB1FE3B83C321D4DF397113A5E1B`（`3c21d03`） |
| 当前 build SHA-256 | `F0AE4038C75C00E6AEC3297502C724AEDEF8EB4233AF1833D19BC58E304E0733`（生产源码 `48b91a0` + `00bbf34`） |
| Authenticode | `NotSigned`，符合本轮 debug / no-bundle 范围；不能据此宣称发布签名通过 |

三次都使用 Tauri 构建入口，不是普通 `cargo build`。构建输出明确执行了前端 production build，因此 exe 嵌入的是对应基线生成的 `dist`。移除功能后的 `3c21d03` 另有 `pnpm ci:quick` 全绿和单轮 localhost fixture 证据；最终构建只有既有的 Vite 大 chunk 提示和 MSVC linker message warning，没有编译错误。该 exe 未启动，构建后确认 P4Deck 进程数为 0、fixture listener 数为 0，未访问个人配置。

## 2. 用户配置隔离

启动前确认没有 `p4deck` 进程，只检查了既有目录的路径与元数据，没有读取 `connection.json`、ticket 或其他凭据内容。原目录被可恢复地移动到同级备份：

- `C:\Users\fenganmeng\AppData\Roaming\dev.p4deck.desktop.native-acceptance-backup-20261010-192846`
- `C:\Users\fenganmeng\AppData\Local\dev.p4deck.desktop.native-acceptance-backup-20261010-192846`

验收应用随后创建全新的 `dev.p4deck.desktop` Roaming/Local 目录。Roaming 下的 `connection.json`、`p4deck.sqlite`、`operations.sqlite` 都是本轮隔离实例新建的；这里只记录文件名、大小和时间，不读取 profile 正文。

验收结束后先精确确认 PID `5780` 的 exe 路径和启动时间，再用 `CloseMainWindow` 正常退出；退出前没有活动 `p4.exe` 子进程。随后已执行恢复：

- 本轮 Roaming 数据移动到 `C:\Users\fenganmeng\AppData\Roaming\dev.p4deck.desktop.native-test-snapshot-20261010-194736`，共 7 个递归条目。
- 本轮 Local/WebView2 数据移动到 `C:\Users\fenganmeng\AppData\Local\dev.p4deck.desktop.native-test-snapshot-20261010-194736`，共 369 个递归条目。
- 原 Roaming/Local 备份均已恢复为 `dev.p4deck.desktop` 原名，递归条目数分别为 6 和 291；旧 `.native-acceptance-backup-20261010-192846` 路径已因移动恢复而不存在。

全程只枚举目录位置和元数据数量，没有读取恢复后的 profile、ticket 或 secret。恢复后没有启动 P4Deck，避免原配置自动连接任何真实 Server；最终 exe 留给用户手动启动。

## 3. localhost fixture

fixture 由 `scripts/p4d-fixture.ps1` 管理，使用仓库内固定并校验过的 P4 二进制，不安装 Windows 服务、不改系统 PATH。启动与写 seed 前都同时检查回环监听和 Server ID。

| 项目 | 本轮观察值 |
| --- | --- |
| P4PORT | `127.0.0.1:16661` |
| Server ID | `p4deck-fixture-local` |
| User | `p4deck-fixture-admin` |
| Client | `p4deck-fixture` |
| Charset | `none` |
| P4 path | `D:\GitCode\P4Deck\.local\p4d-fixture\bin\p4.exe` |
| Ticket path | `D:\GitCode\P4Deck\.local\p4d-fixture\tickets`（只记录路径，未读取内容） |
| P4D PID | `50676`（本轮记录时） |

服务端 `info` 会把地址规范化显示为本机主机名加端口；本轮实际 `P4PORT`、TCP listener 与所有显式 CLI 上下文仍然都是 `127.0.0.1:16661`。没有连接个人或生产 Server。

### 本轮 seed 与收尾状态

- Stream depot：`p4deck-native-stream`；包含 mainline `//p4deck-native-stream/main`、development `/dev`、release `/release`、virtual `/virtual`、task `/task`。父子关系由服务端 spec 给出，task 含 Unicode 名称/描述。
- Branch：`p4deck-native-branch`，View 为 `//depot/main/... //depot/p4deck-native-branch-target/...`，源侧有已提交的 README，可用于只读正反影响预览。
- 有界提交：CL `4446`，只新增 4 个文件。
- Shelf：CL `4447` 通过描述 `Native metadata searchable shelf Ω` 命中；CL `4448` 描述为 `Opaque native shelf`，含 `deep-path-alpha.txt`、`deep-path-beta.txt` 两个文件，可验文件路径深搜与 shelf 去重。
- 退役旧构建的强制解锁 seed：`//depot/p4deck-native-lock/other-owner.txt`，owner `p4deck-native-owner`，client `p4deck-native-owner-client`，numbered CL `4449`。创建后用 tagged `opened -a` 与 `fstat -Ol` 复核为 other-owner / other-client / other-change 锁事实；当前产品不再包含该入口。

收尾只回收临时、未提交对象：

- 精确 revert Force target 后删除 pending CL `4449`、`p4deck-native-owner-client` 和 `p4deck-native-owner`。
- 精确删除 shelf CL `4447`、`4448` 的 shelf，revert 对应 1+2 个文件，再删除两个 pending CL。
- 删除 `p4deck-native-branch`；UI 临时 `p4deck-native-ui-branch` 已不存在；既有 `p4deck-e2e-permission-map` 仍存在且仍为 locked。
- 复核 `//depot/p4deck-native-*` 没有 opened 记录，CL `4447`/`4448` 不再是 shelf，CL `4447`/`4448`/`4449` 不再是 pending。

为避免删除已提交数据引入不必要的多次 server mutation，保留 CL `4446` 的 4 个已提交文件，以及 `p4deck-native-stream` 的 5 个 stream，供下次原生复验复用。清理没有执行 obliterate，没有删除历史 spec，也没有重置 fixture。最后通过管理脚本正常停止 fixture，确认 PID `50676` 已退出且 `127.0.0.1:16661` 无 listener。

## 4. 原生进程、窗口与 IPC 证据

本轮从生成物直接启动，首次观测：

- PID：`5780`
- 路径：`D:\GitCode\P4Deck\src-tauri\target\debug\p4deck.exe`
- 窗口标题：`P4Deck`
- 窗口句柄：`0x92140C`
- `Responding=True`

结构化日志和 operation journal 来自本轮隔离 SQLite，只读取字段 `timestamp/level/operation_id/source/server/workspace/command/duration/state/failure`，不读取 raw ticket、profile 正文或 stderr。观察到：

- 激活隔离 profile 后，GUI 命令统一记录 `server=127.0.0.1:16661`、`workspace=p4deck-fixture`、`source=gui`。
- Stream Graph 实际调用有界 `p4 streams -T ... -m 5001`；Branch Mapping list 实际调用 `p4 branches -m 5001 -t`。
- Shelf / Global Search 实际调用 `p4 changes -s shelved -m 501` 和批量 `p4 describe -s -S -m 257 4448 4447 2`；Stream 深搜使用 `p4 streams ... -m 5001 -a`。
- 对应 query operation 在 journal 中为 `succeeded`，连接 ID 一致；工作区状态刷新也已落到 fixture workspace。

原生交互期间的后端交叉复核还确认：

- Branch 影响预览只执行 `p4 integrate -n -m 201 -b p4deck-native-branch`，没有真实 integrate。UI 创建、编辑、删除 `p4deck-native-ui-branch` 时，mutation 只有两次 `p4 branch -i` 和一次 `p4 branch -d`，每轮 recheck/write/verify 都为 `succeeded`。最终用 `p4 branches -E p4deck-native-ui-branch -m 10 -t` 复核无保存记录；不能用 `p4 branch -o` 判断不存在，因为官方 CLI 会为不存在的名字返回未保存模板。seed branch 与既有 locked permission branch 均仍存在，目标没有文件或 opened 记录。
- 退役旧构建中，管理员强制解锁唯一 mutation 是 `p4 unlock -f -c 4449 //depot/p4deck-native-lock/other-owner.txt`。执行后的独立 `opened -a` 仍保留 owner/client/change（符合 unlock 不改变 opened record），`fstat -Ol` 已无 `otherLock`/`ourLock`；这些只作为历史审计证据保留，当前源码和生成物不得提供同类入口。
- 退役旧构建曾发现结果页关闭后 Files 行未自动刷新，手工刷新后恢复；`707e51e` 当时修复了该问题。由于管理员强制解锁能力现已整体移除，此项不再是当前产品阻塞，也无需针对当前产品复验该 UI。

首次打开、profile 尚未激活时，前端曾观察到 cwd 落在 debug exe 目录并提示“not client root”。激活 `p4deck-fixture` 后，后端日志中的 workspace 与扫描根已切换为 `D:\GitCode\P4Deck\.local\p4d-fixture\workspace`，因此该现象属于环境上下文尚未被 profile 替换的启动阶段，不是本轮继续修改代码的证据。最终 UI 展示仍由前端验收记录确认。

## 5. 当前结论与未验证项

已由本轮后端观察确认：

- `94b5f0c`、退役旧构建 `707e51e` 与移除管理员能力后的 `3c21d03` 都能通过正式 Tauri build 入口生成嵌入 `dist` 的 Windows debug exe；当前 exe 的 SHA-256 已重新记录。
- 首次生成物能创建真实可见主窗口，进程持续响应；`707e51e` 和当前 `3c21d03` 生成物只完成构建与自动化检查，没有再次启动或点击，不能把旧窗口证据当作当前源码的原生 UI 复验。
- 隔离 profile 的原生 IPC 确实访问且只访问 localhost fixture；Stream、Branch、Shelf、Global Search 的代表性只读命令已执行并进入结构化日志/operation journal。
- 用户原有 P4Deck 持久化目录已恢复到原名；本轮测试数据已保留为独立同级 snapshot，fixture 已停止。

仍需或另行记录：

- 前端逐项点击、布局、弹窗、导航与 Branch CRUD 的交互结论，以前端原生验收文件为准；本文只提供后端/CLI/日志交叉证据。退役管理员功能的旧交互记录不代表当前能力。
- Branch CRUD 的首轮服务端事实已由独立 tagged CLI 复核。退役管理员强制解锁的旧 tagged CLI 证据只保留作历史审计，不再要求新 build 原生点击复验。
- 本轮不是安装包验收，未覆盖 MSI/NSIS、签名、公证、自动更新、升级或回滚。
- 本轮不覆盖 2 小时稳定性、长期 idle CPU/内存、睡眠唤醒、多屏/缩放或真实本人 Server。
- debug exe 未签名；不能把 localhost fixture 或 WebView2 窗口存在视为发布就绪。
- 本轮最终状态是：无 P4Deck 进程、无 fixture listener、原配置已恢复但未启动，测试 snapshot 和已提交的有限 seed 留作下轮复验。

## 6. 原生顶栏菜单移除批次

用户在后续人工验收中确认 Windows 顶部原生 `Connection / Changes / Navigate / View` 菜单不属于当前 UI 设计。当前源码已删除 Tauri `Builder.menu(...)` 以及 `on_menu_event(...)` → `app-command` 桥接，不保留隐藏菜单或仅用于原生菜单的 accelerator；前端页面、Command Palette、应用内快捷键、IPC、独立窗口和文件右键菜单不在此删除范围。连接配置继续由 Settings 页面承载。

源码阶段已通过 `cargo fmt --check`、`cargo check --all-targets`、IPC 定向测试 4/4，以及一次完整 `pnpm ci:quick`（Web 81 文件/474 项；Rust 184 项通过、1 项 localhost fixture 按设计 ignored）。本批没有 P4 逻辑变化，因此没有重复运行 localhost fixture。

准备重建时曾只读观察到 PID `28920` 占用标准 debug exe，路径为 `D:\GitCode\P4Deck\src-tauri\target\debug\p4deck.exe`、启动时间 `2026-10-10 20:12:17 +08:00`。用户随后明确授权只结束该精确残留进程；执行前再次核实时它已自行退出，因此没有调用 Stop/Kill，也没有处理其他进程。再次枚举确认 P4Deck 进程数为 0 后，正式运行 `pnpm tauri build --debug --no-bundle` 并成功覆盖标准生成物。

本次生成物时间为 `2026-10-10 20:23:14 +08:00`，大小 `32,119,296` bytes，SHA-256 为 `F0AE4038C75C00E6AEC3297502C724AEDEF8EB4233AF1833D19BC58E304E0733`，Authenticode 状态仍为 `NotSigned`。构建后 P4Deck 进程数和 `127.0.0.1:16661` listener 数均为 0；没有启动 exe、读取个人配置或连接 P4 Server。构建时使用的生产代码随后原样顺序提交为前端 `48b91a0` 与 Rust `00bbf34`；提交后只更新本报告，因此无需重复构建。当前 build 尚未由用户重新打开并原生点击，不能仅凭构建成功宣称顶栏已在 Windows 窗口中人工确认消失。

## 7. 日志工具入口与被动告警批次

后续产品调整删除左侧活动栏中的 P4 Log / Terminal 两个重复按钮，但底部工具区及其 P4 Log、Terminal、Operations、Diagnostics 页签继续保留；用户仍可从底部按需打开。日志与错误事件不再自动展开工具区或切换页签，Error 只更新红点提示。后端 `diagnostic-alert` 仍只提供脱敏的 operation ID 与 `warning/error` 级别；历史 `autoExpandWarning/autoExpandError` 持久化字段仅为兼容保留，不再驱动可见性。

生产源码为 `072195055c2de1a8c5675e50f0fd0c790f4fd7b1`。前端交接的 30 项定向测试、`check:web`、format 与真实 Edge 1/1，以及 PM 独立 23/23、validator 和 diff-check 均通过；本批没有 P4 逻辑变化，未重复运行 localhost fixture 或全量门禁。

构建前确认标准 debug exe 没有 P4Deck 进程占用，随后唯一一次运行 `pnpm tauri build --debug --no-bundle`，exit 0。生成物为 `D:\GitCode\P4Deck\src-tauri\target\debug\p4deck.exe`，时间 `2026-10-10 20:36:59 +08:00`，大小 `32,118,784` bytes，SHA-256 `44F984ED6068A5B286C588A9D9677DC2A72442B362B764A231D6AF3269BE91A4`，Authenticode 状态 `NotSigned`。构建后 P4Deck 进程数与 `127.0.0.1:16661` listener 数均为 0；没有启动应用、读取个人配置或连接 P4 Server。当前生成物尚未由用户重新打开并原生点击，不能把构建和浏览器自动化证据表述为 Windows 原生界面已人工验收。

## 8. Stream 工具入口精简批次

本批只删除左侧活动栏中不常用的 Stream Graph / Branch Mappings 重复入口；两个功能页及其生产路由保持不变，用户仍可从 Streams 页既有按钮打开。生产源码为 `753112fb36ef48781c930d1e96781986f9e35a07`。前端交接 panels 12/12、真实 Edge 390px + axe 2/2、`check:web`、format、validator 与 diff-check 通过，PM 另行复核 panels 12/12 和 validator；本批没有 Rust 或 P4 逻辑变化，因此未重复运行全量测试或 localhost fixture。

构建前只读确认标准 debug exe 没有 P4Deck 进程占用，随后唯一一次运行 `pnpm tauri build --debug --no-bundle`，exit 0。生成物为 `D:\GitCode\P4Deck\src-tauri\target\debug\p4deck.exe`，时间 `2026-10-10 20:47:35 +08:00`，大小 `32,118,784` bytes，SHA-256 `24D18F4739F48427552704E597BAFF04C4A73871D9E40566D52E397721AD0AB4`，Authenticode 状态 `NotSigned`。构建后 P4Deck 进程数与 `127.0.0.1:16661` listener 数均为 0；Agent 没有启动应用、读取个人配置或连接 P4 Server。当前 build 尚未由用户重新打开并原生点击，不能把浏览器自动化与构建成功表述为 Windows 原生界面已人工确认。

## 9. Connection / P4 设置拆分与草稿目录批次

本批把 Settings 的连接主区限定为 Server/User/Workspace，并为当前草稿 Context 增加有界 User/Workspace 目录查询及专用 New User/New Workspace preflight → confirm。现有活动连接 `listUserWorkspaces` 语义不变；新流程不借用旧活动 Context，不自动保存/激活 profile，不建本地目录、不 sync、不使用 `-f`，generic GUI 也不能以 `user`/`client` 绕过专用 API。Workspace 创建限定为既有绝对 Root，并要求 Stream 或结构化 classic View 二选一；一次性 token 绑定草稿 Context、request generation、Server identity、计划和存在性摘要，confirm 在 mutation lane 内复核后写入并逐字段回读。

自动化证据为：Rust `connection_setup` 9/9 通过（另 1 项隔离 E2E按设计 ignored），fake CLI 覆盖 self-only New User、generation stale、token replay、单次 `user -i` 以及无 `-f`/`sync`；`cargo check --tests`、`cargo fmt --check`、Clippy `-D warnings`、`check:web`、Tauri adapter 11/11、Prettier 与 diff-check 通过。单一 Windows localhost 隔离场景另行 1/1 通过，真实验证 users/workspaces 查询、classic/stream Workspace 创建与字段回读、重复名不覆盖，以及 stale/replay 不落写。该 fixture 的 New User preflight 实际返回 `ready=false` / `AuthenticationRequired`，因此没有把真实 User 创建写成已通过；本人 Server 策略仍待人工验证。

最终生产源码为 `718bbf4f0b6ddd6bcf33c36c54848f2ce8d902bc`。构建前只读确认标准 debug exe 没有 P4Deck 进程占用，随后唯一一次运行 `pnpm tauri build --debug --no-bundle`，exit 0；`beforeBuildCommand` 成功重新生成并嵌入当前 `dist`。生成物为 `D:\GitCode\P4Deck\src-tauri\target\debug\p4deck.exe`，时间 `2026-10-10 21:33:22 +08:00`，大小 `32,631,808` bytes，SHA-256 `0562BA5C2453F526983241E0803416500AEEB4525EE7F787113BE3AB5AFCE4D3`，Authenticode 状态 `NotSigned`。构建未启动应用、未读取个人配置、未连接本人 Server，也未自动结束任何用户进程；当前生成物仍需本人重新打开后做 Windows Tauri 原生 Settings 浏览/创建点击验收，不能以服务层 fixture 或构建成功替代。

## 10. Workspace Root 权威解析与连接审计批次

本批前端源码为 `13126c4`，后端源码为 `91b9f29`。Workspace 选中、保存活动 profile、首次创建并激活、切换与重新激活时，后端都会用草稿 Server/User/Client 精确读取服务端 client spec，并通过 `p4 info` 复核实际 Client root；草稿中即使提供另一个真实存在的本地目录，也不会再被当作该 Workspace Root。缺失、空白、相对路径、非目录、其他 Host，以及带选项前缀、通配符或控制字符的 Client 名都会 fail closed。环境启动 Context 不再把进程 cwd 猜成工作区；Files/Workspace 本地扫描在 Root 未验证时不会退回 exe 目录。连接审计只记录状态、错误分类、耗时、operation ID 与散列连接标识，不记录 stdin、raw args、ticket、密码或 Server/User/路径正文，且不会自动展开日志工具区。

有限验证已通过：后端定向测试 21/21（connection service 4、connection setup 7、context 9、workspace root 安全门 1），`cargo check`、Clippy `-D warnings`、Rust fmt、`check:web`、Prettier、前端契约 validator 与 diff-check 均通过；PM 另行复跑 connection service 4/4。单一 localhost 隔离 Root 链 1/1 通过，覆盖 classic Workspace 的首次激活、活动更新和保存均把故意给错但确实存在的 cwd 归一化为服务端 Root；测试后 fixture 已停止。没有运行历史全量 P4D 矩阵，也没有连接本人 Server。

本轮日志核查使用系统 Python `sqlite3`，以 `file:///C:/Users/fenganmeng/AppData/Roaming/dev.p4deck.desktop/p4deck.sqlite?mode=ro` 正常只读连接并包含 WAL；PM 使用同一方法独立复核。在 `2026-10-10 23:15:51 +08:00` 的时间截面，该方法观察到 630 行；`22:33:20 +08:00` 之后有 40 条 error，最新到 `23:15:51 +08:00`，40 条都同时包含 Client/Root 语义。另一 SQLite 运行时的短 URI 只读视图曾看到 27 行、最新到 `2026-10-08`，原因未证实，不能归因为忽略 WAL，也不能仅凭该视图判断本次点击没有发生。现有旧日志没有结构化 `notClientRoot` 或其他已知错误码，因此不能严谨宣称 40 条都是同一具体错误；此前“16 条 notClientRoot”是较早时间截面且分类过强，以本段为准。没有从这批记录中证实新的认证或网络错误。

用户于客户端日期 `2026-10-12` 确认关闭 P4Deck；构建主机日期同为 `2026-10-12`。构建前以 JSON 结果核对源码 HEAD `101b0bbb43efd2dddc5e8b4c9496d28c696fcb05`、工作树 clean 且没有 `p4deck.exe` 进程，随后唯一一次执行 `pnpm tauri build --debug --no-bundle`，exit 0。标准生成物为 `D:\GitCode\P4Deck\src-tauri\target\debug\p4deck.exe`，时间 `2026-10-12T11:17:40.0613135+08:00`，大小 `32,617,472` bytes，SHA-256 `FC7F2CABFE65F078F01D4935BD155B977FC5D0790F22875E29103B44191125A4`，Authenticode 状态 `NotSigned`。构建后再次确认没有 P4Deck 进程；Agent 未启动应用、读取个人配置或连接本人 P4 Server。该生成物已包含本批 Workspace Root 与连接审计源码，但仍需用户原生打开后验收实际连接行为。
