# P4Deck 工作流 v1.2（2026-10-29）

> **⛔ 2026-11-06 起冻结（只读）**：P4Deck 的任务安排、领取、执行与验收已迁移到本机 **Agent Team Kit**（`http://127.0.0.1:1421`，项目 `P4Deck`）。不要在本工作流新增或推进任务；新需求请在 ATK 网页用 **+ New request** 创建，任务由 ATK 的 PM/执行/评审身份领取并回执。本目录的台账、证据、看板与脚本保留为历史依据，不再作为调度权威。

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
| 功能台账 | [`Windows本机私用TODO.md`](../Windows本机私用TODO.md) | 只保留数量汇总/任务表/归档/子项/验收定义；顶部叙事已轮转至 [`归档/TODO-叙事-2026-10.md`](../归档/TODO-叙事-2026-10.md) |

## 1. 角色（4 个）与写域

| 角色 | 写域 | 一句话 |
|---|---|---|
| **LEAD** | `ForAIDoc/**`、`scripts/**`、`tools/**`、根配置 | 定优先级、发任务单、派生状态、归档 |
| **FE** | `src/**`（`tests/qa/batch-qa/**` 除外） | 前端 + 同目录测试 |
| **BE** | `src-tauri/**`、构建配置 | 宿主；**唯一集成人/唯一 Apply 执行者** |
| **QA** | `tests/qa/batch-qa/**`、`tests/qa/preview-audit/**`、`tests/browser/**` | 只验冻结快照，不改产品 |

单写者从"约定"变成可执行检查：`ci-fast --role <ROLE>` 按 `ownership.json` 拦越界。

## 0.6 发布闸门（用户明确授权才发布）

- **未经用户明确说「发版 / 发布新版本」，任何 agent 与 Lead 都不得执行 publish/上传 release**（包括 0.1.x 版本号预置、构建、draft 转正）。
- 版本号可以提前 bump、构建与本地校验可以做；**发布动作必须单独获得用户当次授权**。构建产物与 latest.json 留在本地，等授权后再上传。
- 未发布前，所有新功能与修复都累积进同一个「待发版本」；不要为小改动单独发版。
- 违反视为流程事故：立即停止、报告、保留证据，不自动重试上传。

## 1.5 两条通道（默认敏捷，只有发版才全量）

| 通道 | 何时用 | 做什么 | 明确不做 |
|---|---|---|---|
| **敏捷（默认）** | 用户验收反馈、bug 修复、文案/布局/小逻辑调整、≤5 文件小改 | 直接改原树 → `pnpm wf:agile --files <改动> --role <FE\|BE\|LEAD> --title "<一句话>"`：自动跑 `ci-fast`（写域/状态/相关格式/类型/关联测试），把改动、门禁结果、改动前备份（`git show HEAD:<path>`）和 5 分钟验收清单写进 `artifacts/evidence/agile-<n>/` → LEAD 复核 diff → 用户按 `ACCEPTANCE.md` 做约 5 分钟验收 | **不建候选、不 freeze manifest、不跑全量 tsc/cargo/vitest、不做独立 QA、不做联合集成、不 apply**（文件已在树里） |
| **发布** | 准备发版/交付新版本（版本号、打包、签名、对外） | 下方 9 步全流程 + 全量 CI（`ci:quick` / `ci:local`）+ 打包/版本校验 | — |

判定规则：**只有"新版本发布"才允许/要求走全量流程**；其余尤其是"用户人验反馈→调整"一律走敏捷通道。敏捷通道底线：定向检查必须绿、改前备份、回执列改动文件+sha、不碰真实 P4/生产数据、dev 进程关闭才写树。

`wf:agile` 的证据结构（模板在 `scripts/workflow/templates/`）：

```text
artifacts/evidence/agile-<n>/
  REPORT.md       改动范围 / 门禁步骤 / 回滚 / 未跑项
  ACCEPTANCE.md   约 5 分钟的用户验收清单
  hashes.json     改动文件 sha256 + gitHead + gitDirty + 备份标记
  gate.log        ci-fast 原始输出
  backup/         已跟踪文件改动前的 HEAD 版本（新增文件无备份）
```

常用变体：`--plan` 只打印计划；`--skip-gate` 只记录证据（仅文档或已验改动）；`--todo` 顺带加一条人类待办；`--since-baseline` 从基线取改动。命令与参数见 [命令速查](命令速查.md#敏捷通道)。

## 1.6 依赖链与就绪（任务 / 人类待办同链）

- 依赖写在 `state.json` 的 `deps`（来源是 TODO 表「依赖」列），可填任务 ID，也可填**人类待办 ID**（`T01`…）。
- 就绪是**派生**的，不写回状态：所有依赖都完成才 `ready`。任务完成 = `stage=done` / 已归档 / `humanAccepted`；人类待办完成 = 已勾选。
- 依赖完成后不会伪造"已开工"的状态迁移：下游任务在 `queue` 里自动从 `WAIT …` 变成 `READY`；`next` 返回第一个就绪项。
- 人类待办是链上一环：勾选后从看板活跃区移除（记录保留用于审计）、打印解锁的下游任务、自动刷新 `看板.md` / `看板.html`；取消勾选会重新阻塞下游。已完成的人类待办不再出现在活跃区。
- 命令：

  ```bash
  node scripts/workflow/state.mjs queue --for FE [--ready|--waiting]
  node scripts/workflow/state.mjs next --for FE
  node scripts/workflow/state.mjs task <ID> --for FE --message   # 依赖行标注就绪/等待
  node scripts/workflow/state.mjs board                          # 看板新增「就绪」列
  ```

- 新增/修改链：在 TODO 表该行「依赖」列写 `T04` 或任务 ID，再运行 `node scripts/workflow/state.mjs import`；直接改 `state.json` 会在下次 import 被 TODO 表覆盖。
- `accept <ID>` 完成一个任务后会打印「解锁下游任务」；`check` 会报未知依赖与依赖环。人类待办勾选对下游的解锁由 `human-todos.mjs toggle` 打印。
- **父子任务（完成聚合）**：TODO 的「关联子项」表（子ID / 父项）就是父子关系。父任务完成 = 自身已完成 **或** 所有子任务完成（已验收的父任务不会因后来新增子任务被降级）；父任务未完成全部子任务时，`accept` / `archive` 会拒绝；子任务可用 `accept <子ID>` 单独验收，导入会保留子任务验收结果。`queue` 同时列出可开工的子项并标 `（子项 → 父项）`，看板显示 `子任务 n/m`；完成最后一个子任务时打印「父任务汇总完成」。

## 2. 发布通道：一个发布任务的生命周期（9 步，仅发版）

> 分支：日常提交在 `dev`；发布走 `pnpm wf:release --version x.y.z --apply`（dev→release `--no-ff` + `v*` tag，默认 dry-run，带门禁校验）。

```
① LEAD：state.batch.slices + 任务单（state.mjs task <ID> --for <ROLE> --message）
② 转发：一条消息，不写文档
③ FE/BE：%TEMP%\P4Deck-<切片>-<日期>\source 建候选（BE 唯一快照者）
④ freeze：batch.mjs manifest --candidate … --packages <ID>
⑤ QA：qa-approval.json（task=<切片>，manifestSha256 绑定 ④）
⑥ verify：batch.mjs verify --manifest … --qa …
⑦ apply：BE 执行，默认 dry-run；真写需 --apply --confirm-dev-closed
⑧ 派生：evidence.mjs（QA→待应用，Apply→待人验）
⑨ 人验 → `state.mjs accept <ID> --note "依据"`（写 humanAccepted、stage→done）→ 归档（archive 命令，门禁 humanAccepted）
```

不许推进：manifest 未冻结、QA 未绑定、原树漂移、用户未确认 dev 关闭、夹带未验切片。

**发布正文必须是中英双语（GitHub release + 应用内更新日志）**：

- 模板 [发布说明模板](发布说明模板.md)；填好后放 `artifacts/release-notes-<version>.md`，用 `node scripts/validate-release-notes.mjs --version <version> <file>` 校验，再以 `--notes-file` 传给 `scripts/publish-update.mjs`。GitHub 正文中文在上、英文折叠在 `<details>`；缺任一语言发布会直接拒绝。`latest.json` 的 `notes` 继续取中文段。
- 应用内「设置 → 更新 → 查看更新日志」的数据在 `src/app/update/changelog.ts`，每个版本中英各一组条目；`pnpm validate:changelog` 已进入 `ci:quick`/`ci:local`，版本号涨了却没有条目会直接失败。
- 只补已发布 release 的正文：`node scripts/update-release-notes.mjs --version x.y.z --notes-file <file>`（先 `--dry-run`；需要 `GITHUB_TOKEN` 或已存 git 凭据），不动资产与签名。

## 3. 门禁分层

| 层 | 命令 | 能证明什么 | 适用通道 |
|---|---|---|---|
| 快速 | `ci-fast --files … --role FE` | 写域/状态预检 + 格式/类型/选测（预检实测 0.41s） | **敏捷（默认）** + 发布 |
| 完整 | `ci:quick`（含 workflow-state） | freeze 可用 | 仅发布 |
| 重层 | `ci:local` | 交付候选可用 | 仅发布 |
| QA 定向 | 冻结快照上的语义/边界/故障注入 | 可放行 | 仅发布 |
| 人验 | dev 实机 / 原生 | 可归档 | 发布后 |

`skipped` ≠ 通过；mock ≠ 原生；独立通过 ≠ 联合通过；计数不跨批累加。**敏捷通道只要求"快速层 + 定向测试"；全量/QA 定向/联合只属于发布通道。**

## 4. 省 token 与敏捷的硬规则

1. 任务单 ≤200 字、9 行，由命令生成，不手写；背景/历史去 `state.json` 的 id 与证据路径查。
2. 只报 6 行：改了哪些文件 / 跑过的命令与结果 / 没跑的 / 阻碍 / 是否安全停笔。
3. 超预算就停笔：单任务 ≤12 轮；入场必读只到本文件 + `当前批次.md`。
4. **默认敏捷**：用户人验反馈/小修直接按 §1.5 敏捷通道执行，不写任务单、不派多 agent、不建候选；**只有发版才启动全量流程**。
5. 每批发布 Apply 后重建 `baseline.mjs start`；否则 `ci-fast` 会因原树大量脏改动退化为全量门禁。

## 5. 归档与轮转

- `archive <ID> --note "理由"`：**前置 humanAccepted===true**，写入归档时间/理由/证据；`import` 不会打回。
- 看板底部有独立「已完成归档」区，不混在活跃看板（活跃 51 / 总计 53）。
- 文档轮转：`archive.mjs --apply`（默认 dry-run + 并发保护）；`并行交接.md` 已从 182k 字符降到 ≈1.7k。

## 6. 不因省 token 而放弃的底线

原树只读；Apply 前 fresh Verify；QA 独立；单写者；生产 P4 全禁（含只读）；CUA 停止；不 push/打包/发布；不虚报证据。
