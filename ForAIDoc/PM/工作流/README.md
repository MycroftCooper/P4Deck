# P4Deck 工作流 v1.2（2026-10-29）

> **唯一入口，读完 ≈ 3k 字符就能接活。**
> **不要读 `state.json`（≈43k 字符）和 `并行交接.md`**——那是给脚本和追溯用的。
> 你要的信息用三条命令拿：`state.mjs task <ID>` / `queue --for <ROLE>` / `board --compact`。

## 0. 权威地图

| 内容 | 权威位置 | 怎么用 |
|---|---|---|
| 任务/批次/切片/归档状态 | [`state.json`](state.json) | **只给脚本读**；人用命令 |
| 写域 | [`ownership.json`](ownership.json) | `ownership.mjs map <路径>` |
| 验收回执 | `artifacts/evidence/<batch>/` | `evidence.mjs` 派生状态 |
| 人类视图 | `看板.html` / `--serve` / DSH 面板 | 事件驱动（SSE），不轮询 |
| 当前批次与决议 | [`当前批次.md`](当前批次.md) + [`归档/决议-2026-10.md`](../归档/决议-2026-10.md) | 决议溢出进归档 |
| 命令全集 | [`命令速查.md`](命令速查.md) | 找命令只翻这个 |
| 历史交接 | [`并行交接.md`](../并行交接.md)（最新 2 段）+ [`归档/`](../归档/) | 只读追溯 |

## 1. 角色（4 个）与写域

| 角色 | 写域 | 一句话 |
|---|---|---|
| **LEAD** | `ForAIDoc/**`、`scripts/**`、`tools/**`、根配置 | 定优先级、发任务单、派生状态、归档 |
| **FE** | `src/**`（`src/test/batch-qa/**` 除外） | 前端 + 同目录测试 |
| **BE** | `src-tauri/**`、构建配置 | 宿主；**唯一集成人/唯一 Apply 执行者** |
| **QA** | `src/test/batch-qa/**`、`src/test/preview-audit/**`、`tests/browser/**` | 只验冻结快照，不改产品 |

单写者从"约定"变成可执行检查：`ci-fast --role <ROLE>` 按 `ownership.json` 拦越界。

## 2. 一个任务的生命周期（9 步）

```
① LEAD：state.batch.slices + 任务单（state.mjs task <ID> --for <ROLE> --message）
② 转发：一条消息，不写文档
③ FE/BE：%TEMP%\P4Deck-<切片>-<日期>\source 建候选（BE 唯一快照者）
④ freeze：batch.mjs manifest --candidate … --packages <ID>
⑤ QA：qa-approval.json（task=<切片>，manifestSha256 绑定 ④）
⑥ verify：batch.mjs verify --manifest … --qa …
⑦ apply：BE 执行，默认 dry-run；真写需 --apply --confirm-dev-closed
⑧ 派生：evidence.mjs（QA→待应用，Apply→待人验）
⑨ 人验 → LEAD 写 humanAccepted → 归档（archive 命令，门禁 humanAccepted）
```

不许推进：manifest 未冻结、QA 未绑定、原树漂移、用户未确认 dev 关闭、夹带未验切片。

## 3. 门禁分层

| 层 | 命令 | 能证明什么 |
|---|---|---|
| 快速 | `ci-fast --files … --role FE` | 写域/状态预检 + 格式/类型/选测（预检实测 0.41s） |
| 完整 | `ci:quick`（含 workflow-state） | freeze 可用 |
| 重层 | `ci:local` | 交付候选可用 |
| QA 定向 | 冻结快照上的语义/边界/故障注入 | 可放行 |
| 人验 | dev 实机 / 原生 | 可归档 |

`skipped` ≠ 通过；mock ≠ 原生；独立通过 ≠ 联合通过；计数不跨批累加。

## 4. 省 token 的三条硬规则

1. 任务单 ≤200 字、9 行，由命令生成，不手写；背景/历史去 `state.json` 的 id 与证据路径查。
2. 只报 6 行：改了哪些文件 / 跑过的命令与结果 / 没跑的 / 阻碍 / 是否安全停笔。
3. 超预算就停笔：单任务 ≤12 轮；入场必读只到本文件 + `当前批次.md`。

## 5. 归档与轮转

- `archive <ID> --note "理由"`：**前置 humanAccepted===true**，写入归档时间/理由/证据；`import` 不会打回。
- 看板底部有独立「已完成归档」区，不混在活跃看板（活跃 50 / 总计 52）。
- 文档轮转：`archive.mjs --apply`（默认 dry-run + 并发保护）；`并行交接.md` 已从 182k 字符降到 ≈1.7k。

## 6. 不因省 token 而放弃的底线

原树只读；Apply 前 fresh Verify；QA 独立；单写者；生产 P4 全禁（含只读）；CUA 停止；不 push/打包/发布；不虚报证据。
