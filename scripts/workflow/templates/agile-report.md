# AGILE-{{ID}}：{{TITLE}}

> {{DATE}}｜角色 `{{ROLE}}`｜通道：**敏捷（默认）**｜门禁：**{{GATE_STATUS}}**（{{GATE_DURATION}}）
> 本通道不 freeze、不做独立 QA、不 apply；只有发版才走全量流程。
> 证据目录：`{{EVIDENCE_DIR}}`

## 1. 改动范围

| 文件 | 类型 | sha256（改后） | 改动前备份 |
|---|---|---|---|
{{FILES_TABLE}}

## 2. 门禁结果（`ci-fast`）

| 步骤 | 结果 | 退出码 | 耗时 |
|---|---|---|---|
{{GATE_TABLE}}

- 已跑：见上表。
- 未跑：{{NOT_RUN}}
- 结论：`ci-fast` 通过 ≠ freeze/QA 通过；本通道不代替发版前全量门禁。

## 3. 回滚

- 备份：`{{EVIDENCE_DIR}}/backup/`（对已跟踪文件取 `git show HEAD:<path>` 的改动前版本；新增文件没有备份）。
- 回滚单文件：`git checkout -- <path>`，或用备份覆盖后重跑定向测试。
- 本次改动在工作树，未触碰真实 P4 / 生产数据。

## 4. 用户验收（约 5 分钟）

清单见 [`ACCEPTANCE.md`](ACCEPTANCE.md)。用户确认后：需要写回任务状态时用
`node scripts/workflow/state.mjs accept <ID> --note "<依据>"`（仅对 state 中已存在的任务）。
