# QA-I3 独立验收

2026-10-28，按 PM `ForAIDoc/PM/并行交接.md` QA-I3 续批。限定结论：冻结 FE 集成实现与 synthetic/mock 验收通过，可交 PM 安排用户一次 dev 人工启动检查。不是实际工具启动、真实提交成功或原生故障验收。

## 快照与安全边界

- `src/features/companySubmit/i3-final-handoff.json` 22 个文件首轮 hash 全匹配，详见 `evidence/initial-hashes.json`；最终逐路径值在 `final-hashes.json`。三个变化 UI 路径均重新测试，不沿用 T01 截图。
- 独立入口 `fixture.tsx` 使用真实 ConnectionProfilesCard、ConnectionDirectoryDialog、PendingPage、CommandBar、useCustomSubmit、customSubmit、CustomSubmitStatusDialog 与相关 CSS。实际 Pending 原 Submit 经 CommandExecutionContext 接真实 CommandBar；所有外部边界使用显式内存替身。
- `vite.config.mjs` 精确白名单，拒绝 App/main/Tauri/真实 backend。`check-graph.mjs` write:false 内存构建，1698 模块、零禁入模块，`graph.json` 记录依赖/hash。浏览器运行前后均核同一依赖 hash，无变化；只允许本机 1437 请求，无外部请求/页面错误，自建 Edge 与 server 已关闭。
- 未运行真实 custom_submit_start、Command.spawn、P4、真实路径探测、默认产品、安装器或部署。保存、Root、配置列表、launcher 均为合成内存行为。没有改产品文件或 PM 文档。

## 实际执行与复用

- 定向 Vitest 首轮 6 文件 141 passed / 1 failed：I3 路由/Hook/CommandBar、SettingsPage、原 SubmitDialog 共 70 passed；菜单 71 passed / 1 failed。唯一失败是 PM 文档尚保留 C01-10/C02-14/C12-04。原始 `targeted-vitest.json` 保留。
- PM 删旧预览菜单项后只复验原菜单套件，72/72 passed，`menu-final.json`。未改菜单测试、稳定 ID、顺序或断言，不累计成新的总套件数量。
- 独立浏览器 `browser-results.json` 56/56 passed，设置/新状态弹窗/Pending 的浅深色 × 1200/390px。已实际查看 `settings-dark-390.png`、`status-dark-390.png`、`pending-light-1200.png`。
- 初次浏览器失败是 QA 定位器仅取 `.connection-field`、漏掉 P4 高级字段；改为实际 input 标签顺序。第二次是保存后未等待异步 Root 完成；添加完成等待。保留 `attempt1-results.json` 与 `attempt2-results.json`，无产品改动。
- 非增量 TypeScript 与 diff 检查在批末执行。BE 53 项纯 mock / offline check 采用 PM 已审交接结果，QA 未重新运行 Rust；不把作者 155 项 FE 测试算为独立执行。

## 覆盖

1. 配置紧接 P4 executable、旧 profile 默认空、保存 customSubmitExecutablePath、不改 P4 路径、不触发 launcher、不同 profile 切换恢复独立值：SettingsPage 定向测试；浏览器另核真实字段位置/保存请求、User/Workspace Browse 同行/等高/无 New、Root 保留。配置为真实 profile 模型字段，无新 localStorage 真值。
2. 原 Pending 单编号 Submit→CommandBar→真实 Hook→替身 launcher。发出的请求只有 changeId/connection/requestId，connection 精确五字段，generation=`18446744073709551615` 字符串，UUID；不携带 path/argv/env/cwd。独立预览入口消失，顶栏 CL 详情仍删除、刷新保留。Pending 两控件仍 35px，Default/2/10/100 数值排序正确。
3. 空配置仅进入原 native 对话框分支；浏览器在该边界记录 dispatch，真实 SubmitDialog 的预检/确认行为由独立运行的原套件覆盖，不声称浏览器执行了真实 P4 预检。
4. 非空错误路径仍走 custom；notStarted/transport failure 不自动回退、不自动重试。transport uncertain 锁定、并发及后续重复点击去重；Default/多选/溢出 CL 拒绝，前导零规范化，缺失/改变身份失败关闭。对应定向测试通过。
5. 连接切换隔离迟到响应；不接受另一个 requestId 的状态刷新。父退出 exitCode=0 仍 unknown，保持占用、不推断成功；浏览器真实状态弹窗呈现 unknown，关闭后再点击不再次启动。切换和并发边界采用 Hook mock 测试，未声称浏览器完整模拟宿主生命周期。
6. 静态核对 `tauriBackend.ts` 映射 `custom_submit_start({request})`、`custom_submit_status()`；与 Rust StartRequest/Session 字段相符。Rust deny_unknown_fields、旧配置默认空/roundtrip、连接代次拒绝、同锁占用/幂等/父退出未知测试采用 BE 交接证据；QA 只读源码，不调用真实 IPC。

## 给 PM 的用户 dev 手验草案（由用户执行）

1. 在用户当前桌面 dev 会话打开设置，选定目标连接，在 P4 可执行文件下面的“自定义提交工具（可选）”填入用户自己的绝对 exe 路径并保存。保存不应启动工具；切换 profile 再回来可检查该配置保留。
2. 核对当前 Server/User/Workspace，进入待提交列表，选一个用户准备检查的编号 CL，从该 CL 原有“提交”按钮主动点击一次。配置存在时应启动工具并出现自定义提交工具状态，而非普通 Submit 确认页。
3. 用户自行在外部工具核实所选 CL/连接与行为；P4Deck 的“已启动”不表示提交成功。可点“检查状态”，但不要为了验证重试而重复启动实际提交。
4. 外部父进程退出后，P4Deck 可能显示结果/子进程未知并保持占用；关闭状态窗口不会停止外部工具。首版到此只验一次会话，不建议以重启绕过占用。空配置的原生流程已由 mock 验证，本次无需再做一次真实提交。

工作目录为 exe 父目录，继承应用环境，尚未证明与 P4V 环境等价。退出未知不自动解除，不能承诺同一 app 会话连续启动或跨重启防重；任何错误不自动 fallback。实际工具、凭据、P4、真实 Root、安装包/原生 UI07、真实 DPI/dock 仍未覆盖。T01 390px＋CSS150% Branch 裁切观察继续保留，不扩入本批。
