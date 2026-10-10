# Windows 原生构建与运行验收

> 验收日期：2026-10-10
> 首次原生验收基线：`94b5f0c0179e40af0041cf833ecc38467781b7df`
> 修复后最终构建基线：`707e51e0ade13053f1e775c9154a1d973f873de3`
> 报告提交前仓库 HEAD：`2dd0cb9`（仅追加前端验收文档；应用源码仍对应 `707e51e`）
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
| 构建结果 | 两个基线均 exit 0；先执行 `pnpm build` 生成 `dist`，再编译 Tauri debug 应用 |
| 可执行文件 | `D:\GitCode\P4Deck\src-tauri\target\debug\p4deck.exe` |
| 大小 | `32,627,712` bytes |
| 首次 build SHA-256 | `D0C3D6D3BA12F750CA49246C4F15561B6101522540EB6F2C9258EC0A0D0C52A2`（`94b5f0c`，用于本轮可见窗口/IPC 验收） |
| 最终 build SHA-256 | `C821BA49A564FC1517AB295935B74FEFBC58DFC29E91FD52AEB5C5EB1B4C3602`（`707e51e`，包含 Force 自动刷新修复） |
| Authenticode | `NotSigned`，符合本轮 debug / no-bundle 范围；不能据此宣称发布签名通过 |

两次都使用 Tauri 构建入口，不是普通 `cargo build`。构建输出明确执行了前端 production build，因此 exe 嵌入的是对应基线生成的 `dist`。最终 build 后另跑 `pnpm check`，TypeScript build 与 `cargo check` 均 exit 0；构建只有既有的 Vite 大 chunk 提示和 MSVC linker message warning，没有编译错误。

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
| P4 path | `D:\GitCode\P4Deck\.tools\p4d-fixture\bin\p4.exe` |
| Ticket path | `D:\GitCode\P4Deck\.tools\p4d-fixture\tickets`（只记录路径，未读取内容） |
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

首次打开、profile 尚未激活时，前端曾观察到 cwd 落在 debug exe 目录并提示“not client root”。激活 `p4deck-fixture` 后，后端日志中的 workspace 与扫描根已切换为 `D:\GitCode\P4Deck\.tools\p4d-fixture\workspace`，因此该现象属于环境上下文尚未被 profile 替换的启动阶段，不是本轮继续修改代码的证据。最终 UI 展示仍由前端验收记录确认。

## 5. 当前结论与未验证项

已由本轮后端观察确认：

- `94b5f0c` 与修复后的 `707e51e` 都能通过正式 Tauri build 入口生成嵌入 `dist` 的 Windows debug exe；最终 exe 的 SHA-256 已重新记录。
- 首次生成物能创建真实可见主窗口，进程持续响应；最终生成物只完成构建与静态 check，没有再次启动或点击。
- 隔离 profile 的原生 IPC 确实访问且只访问 localhost fixture；Stream、Branch、Shelf、Global Search 的代表性只读命令已执行并进入结构化日志/operation journal。
- 用户原有 P4Deck 持久化目录已恢复到原名；本轮测试数据已保留为独立同级 snapshot，fixture 已停止。

仍需或另行记录：

- 前端逐项点击、布局、弹窗、导航与 Branch CRUD 的交互结论，以前端原生验收文件为准；本文只提供后端/CLI/日志交叉证据。退役管理员功能的旧交互记录不代表当前能力。
- Branch CRUD 的首轮服务端事实已由独立 tagged CLI 复核。退役管理员强制解锁的旧 tagged CLI 证据只保留作历史审计，不再要求新 build 原生点击复验。
- 本轮不是安装包验收，未覆盖 MSI/NSIS、签名、公证、自动更新、升级或回滚。
- 本轮不覆盖 2 小时稳定性、长期 idle CPU/内存、睡眠唤醒、多屏/缩放或真实本人 Server。
- debug exe 未签名；不能把 localhost fixture 或 WebView2 窗口存在视为发布就绪。
- 本轮最终状态是：无 P4Deck 进程、无 fixture listener、原配置已恢复但未启动，测试 snapshot 和已提交的有限 seed 留作下轮复验。
