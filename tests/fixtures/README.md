# tests/fixtures

前端测试用的**只读夹具**。不要在这些文件里放业务逻辑。

## tauri-2.11.5-drag.js

来源：Tauri 2.11.5 注入到 WebView 的 drag-region 路由脚本（从候选证据目录收回仓库）。
用途：`src/app/shell/TopBar.drag.test.tsx` 用它验证"整条顶栏空白可拖、交互控件不拖、双击最大化"等真实路由行为，
而不是在测试里重写一套模拟实现。

- 许可证：随 Tauri 上游（MIT / Apache-2.0）。
- 使用方式：`readFileSync("tests/fixtures/tauri-2.11.5-drag.js")` —— **仓库根相对路径**，不要用 `import.meta.url`
  （vitest/jsdom 环境下不保证 `file:` 协议）。
- 模板占位 `__TEMPLATE_os_name__` 由测试替换为 `"windows"`。
