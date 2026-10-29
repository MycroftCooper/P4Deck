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

4. 点 **Install**，完成后点 **Enable now**。带 HMR 的 profile 会即时挂载，不需要重启。
5. 浏览器打开（同源，沿用当前登录态）：

   ```
   http://127.0.0.1:56326/p4deck-board
   ```

## 路由

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
node tools/dsh-p4deck-board/selftest.mjs
```

用假 `ctx`/假 req-res 验证：快照 52 项、Agent/里程碑非空、路由注册、页面 200、API 200、405/404/503 边界。当前 15/15 通过。

## 已知边界

- 只做宿主侧路由；**没有**注册客户端 UI 插槽，所以入口是 URL，不是侧栏按钮。要做成侧栏面板需要另写 `lib/client.js`（`dsh.client` + slot 注册），属于第二期。
- 插件管理器会显示加载失败原因；若安装后报错，先看 Plugins 页的诊断，再对照本 README 的路由契约。
- 本插件不改变 `state.json`；状态仍由 `node scripts/workflow/state.mjs ...` 维护。
