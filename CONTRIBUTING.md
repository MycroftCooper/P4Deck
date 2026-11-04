# P4Deck 贡献指南

所有文本文件使用 UTF-8 和 LF。提交代码前运行：

```bash
pnpm format:check
pnpm build
pnpm test
pnpm check
```

也可用 `pnpm ci:quick` 一次跑完本地静态检查和测试：默认 Web 组与 Rust 组并行、失败不中断，stdout 只打每步结果、失败摘要和一行紧凑 JSON，完整日志在 `artifacts/ci/logs/<mode>/<step>.log`。发布候选使用 `pnpm ci:local`（默认 fail-fast）加跑构建、桌面 bundle 的 mock 剔除检查和串行前后端性能门禁；只改打包或前端 mock 相关时可用 `pnpm ci:bundle` 快速自检（约 10 秒）。打包前先跑 `pnpm validate:versions`，详细边界见 [本地门禁与发布配置](ForAIDoc/Coder/本地门禁与发布配置.md)。

## 分支

- `dev`：日常开发分支，所有提交先进这里。
- `release`：发布线（主分支），只接受来自 `dev` 的 `--no-ff` merge 和 `v<semver>` tag；不要在 release 上直接开发。
- 发布：`pnpm ci:quick` 通过后执行 `pnpm wf:release --version x.y.z --apply`（默认 dry-run；脚本会校验分支、工作树、版本和门禁新鲜度）。
- 紧急修复：`hotfix/*` 从 release 拉出，修完先合回 `dev` 再走正常发布。

前端代码不得直接执行进程；所有 P4 调用和输出解析必须位于 Rust Adapter 边界内。

新增 P4 命令时必须：

1. 说明用户场景和破坏性操作保护措施。
2. 增加经过脱敏的结构化输出 Fixture。
3. 将原始字段转换为领域类型，禁止把未处理的 Map 直接交给 React。
4. 把错误分类为用户可理解、可恢复的应用错误。
5. 验证 Unicode、空格路径、取消、大输出和日志脱敏。

Commit Subject 暂时采用 Conventional Commits：`feat:`、`fix:`、`docs:`、`test:`、`chore:`。

前端分层、新增页签流程和状态归属见 [前端架构与维护约定](ForAIDoc/Coder/前端架构与维护约定.md)。使用 `pnpm format` 统一格式；避免将业务查询与操作事件状态重新放回 App。
