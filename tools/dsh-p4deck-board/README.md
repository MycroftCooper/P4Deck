# dsh-p4deck-board

P4Deck 工作流看板的 **DSH 宿主插件**：在 DeepSeek Harness Web GUI 同源下提供一个只读看板页面，显示任务状态与各 Agent 当前在忙什么。

- 只注册同源 GET 路由，**不连 P4、不写原树、不收集凭据**。
- 数据只读 3 个文件：`ForAIDoc/PM/工作流/state.json`（任务真值）、`运行状态.json`（Agent/里程碑）、`artifacts/workflow/metrics.jsonl`（量测）。
- 页面每 5 秒拉一次 `/p4deck-board/api/snapshot`，无需重启或手动刷新。

## 安装（用 GUI 的 Plugins 页，不改安装包）

1. 左侧栏打开 **Plugins（插件）**。
2. **Add plugin** → 菜单里选 **Install a third-party plugin**。
3. 在包名输入框粘贴本地绝对路径：

   ```
   D:\GitCode\P4Deck\tools\dsh-p4deck-board
   ```

4. 点 **Install**，完成后点 **Enable now**。
5. **重启 DeepSeek Harness**（或至少对窗口按 Ctrl+R 重载一次）。

> 重要：DSH 的插件树在**进程启动时组合**，并且客户端 bundle 只在启动时构建。
> 因此首次安装、或包的 `package.json`/`lib/client.js` 被替换后，**必须重启**才能看到侧栏条目；
> 只改面板里的数据（`state.json` / `运行状态.json`）不需要重启，面板每 5 秒自刷新。

## 打开面板

安装并启用后，看板是**右侧栏的一个原生标签页**：

1. 右侧栏标签条末端的 **＋**（add control）会打开指南页；
2. 指南页里选 **工作流看板**（图标是三个小方块）；
3. 之后这个「看板」标签会留在右侧栏，内容是实时数据，每 5 秒自刷。

> 只有在右侧栏没有其它标签占用时才需要走 ＋；已有标签时可在标签条上切换。
> 页面版入口仍保留：浏览器打开 `http://127.0.0.1:56326/p4deck-board`。

## 路由（宿主侧）

| 方法与路径 | 返回 |
|---|---|
| `GET /p4deck-board` | 看板页面 |
| `GET /p4deck-board/` | 看板页面 |
| `GET /p4deck-board/api/snapshot` | 快照 JSON（`cache-control: no-store`） |
| 其他方法 | 405 |
| 其他子路径 | 404 |
| `state.json` 缺失 | 503 + 错误原因 |

## 配置

`cordis.patch.yml` 里可改工作区路径：

```yaml
- id: p4deck-board
  name: dsh-p4deck-board
  config:
    workspace: D:\GitCode\P4Deck
```

## 自测（不需要 dsh 运行时）

```powershell
node tools/dsh-p4deck-board/selftest.mjs         # 宿主侧：路由/快照/边界，15 项
node tools/dsh-p4deck-board/selftest-client.mjs   # 客户端侧：bundle 加载/插槽注册/真实 React 渲染，16 项
```

客户端自测用假 `window.__ModuleLoader__` + 假 `require` 载入真实 `lib/client.js`，再用项目自带的 `react-dom/server` 渲染纯视图，断言标题、52 计数、Agent、里程碑、任务卡与加载/错误态。

## 已知边界

- 面板是**右侧栏标签页**（`sidebarRightTabs` + `sidebar.right.pane.tab`），数据走同源 `fetch(/p4deck-board/api/snapshot)`；离线展示仍可用 HTML 看板。
- 若安装后报错，先看 Plugins 页的诊断；常见原因是 `dsh.client.inject` 指向的 `@deepseek-ai/dsh-client-ui-sidebar-right` 未被启用。
- 本插件不改变 `state.json`；状态仍由 `node scripts/workflow/state.mjs ...` 维护。
