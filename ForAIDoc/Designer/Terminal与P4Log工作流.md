# Terminal 与 P4 Log 工作流

## 入口与命令目录

Terminal 和 P4 Log 同时保留底部工具区的快捷入口，并注册为全局单实例页签 `terminal` / `p4log`。正式页签可以分屏、从页签菜单或分组按钮弹出、关闭后 dock 回主窗口，并沿用所有 panel 的单实例聚焦和恢复协议。

应用菜单、命令面板、全局键盘处理和页面导航都读取同一份 `app/commands/catalog.ts`。命令面板展示稳定命令 ID、快捷键、可用状态和禁用原因；执行前再次按同一策略判断，不能靠入口隐藏代替能力检查。

| 命令 ID | 中文 / English | Windows / Linux | macOS | 可用条件 |
| --- | --- | --- | --- | --- |
| `app.commandPalette` | 打开命令面板 / Open Command Palette | Ctrl+Shift+P | Cmd+Shift+P | 始终 |
| `tools.openTerminal` | 打开 Terminal / Open Terminal | Ctrl+Alt+T | Cmd+Option+T | Runtime 已加载 |
| `tools.openP4Log` | 打开 P4 Log / Open P4 Log | Ctrl+Alt+L | Cmd+Option+L | 始终 |
| `tools.popoutTerminal` | 独立窗口打开 Terminal | 命令面板/应用菜单 | 命令面板/应用菜单 | 主窗口且 Runtime 已加载 |
| `tools.popoutP4Log` | 独立窗口打开 P4 Log | 命令面板/应用菜单 | 命令面板/应用菜单 | 主窗口 |
| `panel.dockBack` | 停靠回主窗口 / Dock Back | Ctrl+Alt+D | Cmd+Option+D | 仅独立窗口 |

## 恢复与连接语义

- `p4deck.nativePanels` 使用版本化记录保存 dock/浮窗状态和不透明 runtime binding；旧字符串数组自动迁移。浮窗恢复失败时回落为主窗口 dock 页签。
- Rust 的 `window-placement-v1.json` 是所有原生 panel 共用的位置/大小存储，不是 Terminal/Log 专属实现。保存普通窗口 bounds 和最大化状态；恢复时按当前屏幕交集选屏，尺寸与坐标收敛到安全可见范围，多屏拔插或越界回到主屏。
- 独立窗口 URL 只带 panel ID、profile、context generation 和不透明 connection token；不写入 P4 Context、ticket 路径、密码或命令文本。窗口仍从受控 Runtime 获取当前 Context，URL 不能覆盖执行上下文。
- profile、Context 或 generation 变化时，Terminal 取消当前 operation、清空输入与旧输出并隔离迟到结果；P4 Log 丢弃旧请求并按新连接重载。旧浮窗显示重绑定提示。
- Terminal 历史只保存通过安全检查的普通命令；Terminal 输出不持久化。P4 Log 只持久化 level、source 和 follow-tail；keyword、command filter 不落盘。

## 安全边界

独立窗口与 dock 页面复用 `ToolDrawer → backend.runP4 → P4Runner`，不能绕过通用 Runner。前端提前阻止 `login/login2/logout/trust/tickets/passwd/set/configure`、`-P`、secret long option、`P4PASSWD/P4TICKETS` 等形式；Rust 在 executable 解析和真正 spawn 前再次拒绝。Runner、日志、Journal 和诊断导出继续先脱敏后存储/序列化。

## 验证边界

自动化覆盖命令 ID/快捷键冲突/禁用原因、命令面板、panel route/白名单/deep link、旧浮窗状态迁移、runtime binding、placement 版本/多屏越界、Log 状态恢复、Terminal 敏感命令、连接切换取消与旧响应隔离。纯函数和浏览器组件证据不替代 Windows/macOS 原生菜单、窗口位置、单实例焦点、全局快捷键、拖放或读屏实测；这些项目仍需两平台桌面验收。
