# P4Deck 工作流 v1（2026-10-29）

> **唯一入口。** 读完本文件 + [`state.json`](state.json) 就能接活，不需要再通读 2121 行交接日志。
> 目标：把"自然语言长日志当状态库"换成"状态文件 + 短任务单 + 脚本门"，省 token、提速。
> 本次改动只新增文件与两处横幅，**未修改任何产品代码、未改写历史文档内容**。

## 0. 权威地图（谁说话算数）

| 内容 | 权威位置 | 说明 |
|---|---|---|
| 任务 / 批次状态 | [`state.json`](state.json) | **机读真值**，唯一 |
| 人类视图 | [`看板.md`](看板.md) | 自动生成，勿手改 |
| 当前批次 / 停机条件 / 滚动决议 | [`当前批次.md`](当前批次.md) | 每批覆盖，保持 ≤60 行 |
| 角色合同 | [`角色/`](角色/) | LEAD / FE / BE / QA 各一页 |
| 任务单格式 | [`任务单模板.md`](任务单模板.md) | ≤200 字，8 行 |
| 历史决议与证据叙述 | [`../并行交接.md`](../并行交接.md) | **已归档，只读，不再追加** |
| 功能台账原文 | [`../Windows本机私用TODO.md`](../Windows本机私用TODO.md) | 历史台账；状态以 state.json 为准 |

冲突时以 `state.json` 为真值；`state.json` 与 TODO 表不一致，以 state.json 为准并在下批修正 TODO。

## 1. 角色：4 个（原根 + PM 合并）

| 角色 | 写域 | 该做 | 禁做 |
|---|---|---|---|
| **LEAD** | `ForAIDoc/**`、`scripts/**`、根配置 | 收需求、定类型/优先级、建任务单、转发、收执、更新状态、对用户汇报 | 不写 `src/`、`src-tauri/` 产品代码；不替 FE/BE 施工 |
| **FE** | `src/**` + 同目录测试 | React/TS/CSS、mock、定向测试 | 不写 `src-tauri/**`、不改根配置、不碰 QA 证据 |
| **BE** | `src-tauri/**`、构建配置 | Rust/IPC/宿主；**唯一集成人与唯一 Apply 执行者** | 不写 `src/**`；不改包版本/发布链 |
| **QA** | `src/test/batch-qa/**`、`evidence/**` | 对**冻结快照**独立验收，只报 PASS/FAIL + 语义缺口 | 不改产品实现、不边测边改、不复用旧批准 |

**合并理由**：根与 PM 都不写产品代码，中间多一跳 = 多一次上下文复制和一次失真机会。**QA 独立必须保留**——它是整套流程的质量支点。

**单写者**：`types.ts`、IPC 契约、`App.tsx`、`TopBar`、`CommandBar`、`Pending` 等共享文件，先定唯一作者；其他人只交**精确 hunk**，禁止整文件覆盖。

## 2. 一个任务的生命周期（8 步，每步一道门）

```
① LEAD 建任务单（state.json + ≤200字任务单）
② 转发：一条消息，不写文档
③ FE/BE 在 %TEMP%\P4Deck-<切片>-<日期>\source 建候选（BE 唯一快照者）
④ freeze：node scripts/workflow/batch.mjs manifest ...  → manifest.json（逐文件 hash）
⑤ QA：对冻结快照出 qa-approval.json，manifestSha256 必须绑定 ④
⑥ verify：node scripts/workflow/batch.mjs verify --manifest ... --qa ...
⑦ apply：BE 执行，默认 dry-run；真写需 --apply --confirm-dev-closed（用户确认 dev 已关）
⑧ 用户人工验收 → LEAD 更新 state.json（qaPassed/applied/humanAccepted）
```

不许推进：manifest 未冻结、QA 未过或绑定不上、原树漂移、用户未确认 dev 关闭、候选夹带未验切片。

## 3. 命令（都已实现并有自测）

| 命令 | 作用 | 何时用 |
|---|---|---|
| `node scripts/workflow/state.mjs check` | 校验状态库（ID/类型/状态/依赖/证据路径） | 改完 state.json、交接前 |
| `node scripts/workflow/state.mjs board` | 重新生成看板 | state 变更后 |
| `node scripts/workflow/state.mjs task <ID>` | 打印该任务短任务单 | 领活时 |
| `node scripts/workflow/select-tests.mjs` | 按改动文件给测试计划 | 提交前 |
| `node scripts/workflow/ci-fast.mjs` | 快速层门禁（并行：格式/类型/选测） | 每片开发中 |
| `… --files a,b,c` | 显式指定本片改动（无基线 commit 时必用） | 上面两条均可加 |
| `pnpm ci:quick` | 完整 11 步串行门禁 | **freeze 前一次** |
| `node scripts/workflow/batch.mjs manifest/verify/apply` | 批次 hash 守卫与 Apply | ④⑥⑦ |
| `node scripts/workflow/batch.selftest.mjs` | 批次工具自测（临时目录，不碰原树） | 改动 batch.mjs 后 |
| `node scripts/workflow/measure.mjs record/summary` | 量测（token/轮次/门禁耗时/入场行数） | 每批首尾 |
| `scripts\workflow\cargo-candidate.cmd <cargo 参数>` | 共享 Rust 编译缓存 + 可选 sccache | 候选内跑 cargo 时 |
| `node scripts/workflow/env-candidate.mjs --candidate <候选>` | 校验候选位置、打印环境变量 | 建候选后自检 |
| `node scripts/workflow/board.mjs` | 生成静态看板 `看板.html`（双击可看） | 想离线看 |
| `node scripts/workflow/board.mjs --serve` | 本地实时看板 `http://127.0.0.1:1421` | 想边干边看 |

## 3.1 可视化看板

两个入口，数据同源（`state.json` + `运行状态.json` + `metrics.jsonl`）：

1. **静态**：`node scripts/workflow/board.mjs` → `看板.html`，双击即看（生成物已 gitignore）。
2. **实时**：`node scripts/workflow/board.mjs --serve`，页面每 4 秒自刷。
3. **DSH 插件**（在 GUI 里看）：`tools/dsh-p4deck-board/` 是 cordis 宿主插件，经 Plugins 页以本地路径安装后，打开
   `http://127.0.0.1:56326/p4deck-board`。安装步骤见其 [README](../../../tools/dsh-p4deck-board/README.md)。

「谁在忙什么」写在 `运行状态.json`（LEAD 维护，含 agents / milestones / events）；任务状态仍只在 `state.json`。

## 4. 门禁分层（证据强度递增，弱证据不得顶替强证据）

| 层 | 内容 | 能证明什么 |
|---|---|---|
| 快速层 `ci:fast` | Prettier + tsc + `vitest related` | 改动自洽、相关测试过 |
| 完整层 `ci:quick` | contracts/validate/3×node test/format/rustfmt/tsc/cargo check/clippy/vitest/cargo test | freeze 可用 |
| 重层 `ci:local` | 上面 + 生产构建 + 双端性能 | 交付候选可用 |
| QA 定向 | 冻结快照上的语义/边界/故障注入 | 可放行 |
| 人工验收 | dev 实机 / 原生 | 可归档 |

`skipped` 永远不等于通过；mock/浏览器不等于原生；独立通过不等于联合通过；计数不跨批累加。

## 5. 消息协议（省 token 的关键）

任务单一律 ≤200 字、固定 8 行（见[模板](任务单模板.md)）。**禁止**把背景、历史、事故叙述写进任务单——这些去 `state.json` 的 id 和证据路径里查。

- 一次只激活一条任务；不逐项 steer；正写代码/跑工具时不打断。
- 缺依赖只阻塞对应动作，其他继续。
- 报告只报：改动范围 / 实际跑过的命令与结果 / 没跑的项 / 阻碍 / 是否安全停笔（6 行以内）。
- 角色空闲且无已授权任务：如实报告空闲，不制造工作。

## 6. 预算（超限就停笔，不硬撑）

**模型档位**（省 token 的第二把刀）：

| 工作类型 | 用法 |
|---|---|
| 写产品代码、冻结契约、阶段裁决 | 强模型 |
| 跑门禁、生成 manifest、Verify、Apply、状态渲染 | **脚本，不调用模型** |
| 截图核对、官方文档调研、只读审计 | 便宜模型 + 三列输出（已证 / 推测 / 未知） |

| 项 | 上限 |
|---|---|
| 单角色单任务 | ≤12 轮 |
| 任务单 | ≤200 字 |
| 交接消息 | ≤15 行 |
| 入场必读 | 本文件 + `当前批次.md` + `state.mjs task <ID>` ≈ 15k 字以内 |

超限不是失败，是信号：说明任务该拆，或规格不清。

## 7. 归档与回滚

- `并行交接.md` 已加横幅：只读归档，**新增决议写 `当前批次.md`**，超出 10 条移入 `归档/决议-YYYY-MM.md`。
- 想彻底回滚本次改造：删除 `ForAIDoc/PM/工作流/` 与 `scripts/workflow/`，去掉两处横幅与 `package.json` 的 `wf:*` 脚本即可。原始文档内容未被改写。

## 8. 不因省 token 而放弃的底线

原树只读；Apply 前 fresh Verify；QA 独立；单写者；生产 P4 全禁（含只读）；CUA 保持停止；不 push/打包/发布/生成签名密钥；不虚报证据。
