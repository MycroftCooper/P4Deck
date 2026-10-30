# dsh-p4deck-board

P4Deck 工作流看板的 **DSH 宿主插件**：在 DeepSeek Harness Web GUI 同源下提供看板页面，显示任务状态、功能名与各 Agent 当前在忙什么；可直接点「验收完成 / 取消」把结果写回 `state.json`。

- 同源路由，**不连 P4、不收集凭据**；只在用户点击按钮时写 `state.json` / `人类待办.json`。
- 数据读 3 个文件：`ForAIDoc/PM/工作流/state.json`（任务真值）、`运行状态.json`（Agent/里程碑）、`artifacts/workflow/metrics.jsonl`（量测）。
- 数据由文件监听 + SSE 驱动，变化才刷新；EventSource 不可用时退回 30 秒轮询。

## 安装（用 GUI 的 Plugins 页，不改安装包）

1. 左侧栏打开 **Plugins（插件）**。
2. **Add plugin** → 菜单里选 **Install a third-party plugin**。
3. 在包名输入框粘贴本地绝对路径：

   ```
   D:\GitCode\P4Deck\tools\dsh-p4deck-board
   ```

4. 点 **Install**，完成后点 **Enable now**。
5. **完全退出 DeepSeek Harness 再重新打开**（托盘退出/关闭主进程；只关窗口或按 Ctrl+R 不够）。

> 重要：DSH 的插件树和宿主路由在**进程启动时**组合，客户端 bundle 也只在启动时构建。
> 只重载窗口会出现“页面是新版、宿主还是旧代码”的半新状态，点验收按钮就会 HTTP 405。
> 因此首次安装、或 `lib/index.js` / `lib/client.js` 被替换后，**必须完全退出 DSH 再启动**；
> 只改数据文件（`state.json` / `运行状态.json`）不需要重启。
>
> 页面自己也会检测这种半新状态：检测到旧宿主时会显示红色重启提示并隐藏按钮；
> 也可以跑 `node tools/dsh-p4deck-board/verify.mjs`，看到 `验收按钮=无` 就是宿主没重启。

## 打开面板

安装并启用后，看板是**右侧栏的一个原生标签页**：

1. 右侧栏标签条末端的 **＋**（add control）会打开指南页；
2. 指南页里选 **工作流看板**（图标是三个小方块）；
3. 之后这个「看板」标签会留在右侧栏。**数据由文件监听驱动**：`state.json` / `运行状态.json` / `人类待办.json` 一变，宿主通过 SSE 推一帧，面板才刷新；不轮询。EventSource 不可用时才退回 30 秒兜底轮询。

> 只有在右侧栏没有其它标签占用时才需要走 ＋；已有标签时可在标签条上切换。
> 页面版入口仍保留：浏览器打开 `http://127.0.0.1:56326/p4deck-board`。

## 路由（宿主侧）

| 方法与路径 | 返回 |
|---|---|
| `GET /p4deck-board/api/events` | SSE：数据文件变化时推一帧（事件驱动） |
| `GET /p4deck-board` | 看板页面 |
| `GET /p4deck-board/` | 看板页面 |
| `GET /p4deck-board/api/snapshot` | 快照 JSON（`cache-control: no-store`；含 `scope` 功能名与验收事实） |
| `POST /p4deck-board/api/packages/accept` | body `{id}`：看板点「验收完成」，写 `state.json`；缺 QA/Apply 时按用户点击 force 补登 |
| `POST /p4deck-board/api/packages/cancel` | body `{id, reason?}`：看板点「取消」，归档并标记“取消范围”（不写 humanAccepted，不算验收通过） |
| `POST /p4deck-board/api/human-todos/toggle` | body `{id}`：勾选人类待办 |
| 其他方法 | 405 |
| 其他子路径 | 404 |
| `state.json` 缺失 | 503 + 错误原因 |

> 只有「待人工验收 / 未登记验收」卡片显示「验收完成」；未验收的活跃卡片显示「取消」。按钮写的是真实 `state.json`，写入后会触发 SSE 刷新。取消的项会出现在归档区并标「已取消（未验收）」。

## 配置

`cordis.patch.yml` 必须是 **bundle patch 列表**：新增行要用 `insert:`。直接写 `id + name` 会被当成
"覆盖已有行"，目标不存在时报 `patch: entry "p4deck-board" not found` 并**静默跳过**——这是它一开始
不出现的真正原因。

```yaml
- insert:
    - id: p4deck-board
      name: dsh-p4deck-board
      config:
        workspace: D:/GitCode/P4Deck
```

离线自检（不用重启 GUI）：把 profile 复制成临时名，再 dump 组合树：

```powershell
dsh.cmd --profile <tmp> --dump-config | Select-String p4deck
```

打印出 `- id: p4deck-board` 且没有 `not found` 警告，说明组合正确；再重启 GUI 才会实际加载。

## 自测（不需要 dsh 运行时）

```powershell
node tools/dsh-p4deck-board/selftest.mjs         # 宿主侧：路由/快照/验收/取消/边界
node tools/dsh-p4deck-board/selftest-client.mjs   # 客户端侧：bundle 加载/插槽注册/真实 React 渲染
```

客户端自测用假 `window.__ModuleLoader__` + 假 `require` 载入真实 `lib/client.js`，再用项目自带的 `react-dom/server` 渲染纯视图，断言标题、功能名、验收/取消按钮、Agent、里程碑、任务卡与加载/错误态。

## 已知边界

- 面板是**右侧栏标签页**（`sidebarRightTabs` + `sidebar.right.pane.tab`），数据走同源 `fetch(/p4deck-board/api/snapshot)`；离线展示仍可用 HTML 看板。
- 若安装后报错，先看 Plugins 页的诊断；常见原因是 `dsh.client.inject` 指向的 `@deepseek-ai/dsh-client-ui-sidebar-right` 未被启用。
- 本插件只在用户点击「验收完成 / 取消」或勾选人类待办时写文件；其余状态仍由 `node scripts/workflow/state.mjs ...` 维护。取消归档不满足 `archive` 命令的 humanAccepted 前置，属于看板专用的“取消范围”记录。
