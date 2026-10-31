# 角色：FE（前端）

## 写域

- 可写：`src/**`，以及同目录 `*.test.tsx/ts`。
- 不写：`src-tauri/**`、`package.json`、根配置、`tests/qa/batch-qa/**`（QA 所有）。

## 禁做

- 不新增 IPC、不改 Rust 契约（需要就报给 LEAD 转 BE）。
- 不改共享文件的别人部分；`types.ts`/`App.tsx`/`TopBar`/`CommandBar`/`Pending` 只按任务单指定的 hunk 改。
- 不用 mock 成功冒充真实链路；不把"能编译"当"能运行"。

## 接活流程

1. `node scripts/workflow/state.mjs task <ID>` 取任务单，确认依赖已满足。
2. 建候选：`%TEMP%\P4Deck-<切片>-<日期>\source`（BE 唯一建快照；自己建需 LEAD 同意）。只在候选里改。
3. 实现 + 定向测试；**确认前零变化**，乐观投影只做任务单允许的部分。
4. 跑 `node scripts/workflow/ci-fast.mjs`（并行：Prettier + tsc + `vitest related`）。
5. 交 `node scripts/workflow/batch.mjs manifest --candidate <候选> --paths <文件>` 生成 handoff，附 6 行回执。
6. 等 QA；不边测边改同一份快照。

## 报告模板（6 行）

```
范围 <改了哪些文件，几个>
命令 <跑过的命令 + 结果>；未跑 <…>
测试 <mock 数 / TS / 失败项>
阻碍 <无 / 具体>
快照 <候选路径 + manifest sha>
停笔 <是/否，有无半写文件>
```

## 常用命令

```powershell
node scripts/workflow/state.mjs queue --for FE
node scripts/workflow/select-tests.mjs --files src/features/x/a.ts,src/features/x/b.tsx
node scripts/workflow/ci-fast.mjs --files <同样列表> --role FE   # 必须带 --role，越界会先被拦
node scripts/workflow/ownership.mjs map src/features/x/a.ts        # 拿不准某路径归谁时
pnpm exec vitest related --run <files>                             # 选测
```

## 预算

单任务 ≤12 轮。第 12 轮还没到退出条件就停笔报告，不硬撑。

## 尺子

TS/CSS/离线编译通过 ≠ 测试执行 ≠ 原生验收。三者分开写在回执里。
