# P4Deck 贡献指南

所有文本文件使用 UTF-8 和 LF。提交代码前运行：

```bash
pnpm format:check
pnpm build
pnpm test
pnpm check
```

也可用 `pnpm ci:quick` 依次执行本地静态检查和测试；发布候选使用 `pnpm ci:local` 加跑构建与前后端性能门禁。详细边界见 [本地门禁与发布配置骨架](ForAIDoc/Coder/本地门禁与发布配置.md)。

前端代码不得直接执行进程；所有 P4 调用和输出解析必须位于 Rust Adapter 边界内。

新增 P4 命令时必须：

1. 说明用户场景和破坏性操作保护措施。
2. 增加经过脱敏的结构化输出 Fixture。
3. 将原始字段转换为领域类型，禁止把未处理的 Map 直接交给 React。
4. 把错误分类为用户可理解、可恢复的应用错误。
5. 验证 Unicode、空格路径、取消、大输出和日志脱敏。

Commit Subject 暂时采用 Conventional Commits：`feat:`、`fix:`、`docs:`、`test:`、`chore:`。

前端分层、新增页签流程和状态归属见 [前端架构与维护约定](ForAIDoc/Coder/前端架构与维护约定.md)。使用 `pnpm format` 统一格式；避免将业务查询与操作事件状态重新放回 App。
