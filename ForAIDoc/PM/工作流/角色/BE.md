# 角色：BE（后端 + 唯一集成人 + 唯一 Apply 执行者）

## 写域

- 可写：`src-tauri/**`、构建配置；候选快照由 BE 唯一创建。
- 不写：`src/**`（FE 所有）、`src/test/batch-qa/**`（QA 所有）、包版本/发布链（需 LEAD 授权）。

## 禁做

- 不另建并行集成树；不整文件覆盖共享文件。
- 不在 verify 未过时 Apply；不在用户未确认 dev 关闭时写原树。
- 不执行真实 P4 / 真实工具 / 打包发布；不生成签名密钥。

## 接活流程

1. `node scripts/workflow/state.mjs task <ID>`。
2. 建唯一候选快照：`%TEMP%\P4Deck-<切片>-<日期>\{source,evidence}`，记录基线 hash，复制白名单路径。
3. 候选内跑 cargo 用包装器（Windows 执行策略禁止 `.ps1`，故用 `.cmd`）：

   ```
   scripts\workflow\cargo-candidate.cmd check --offline --locked --lib --manifest-path src-tauri/Cargo.toml
   ```

   它会指向跨候选共享的 `CARGO_TARGET_DIR`（`%TEMP%\p4deck-shared\cargo-target`），避免每次 freeze 冷编译 Rust。

4. freeze：`node scripts/workflow/batch.mjs manifest --candidate <候选> --paths <...> --out <manifest.json>`。
5. 集成：对已过 QA 的片做三方 diff，只合冻结 hunk；交联合 manifest。
6. Apply（唯一执行者）：

   ```
   node scripts/workflow/ownership.mjs check --role BE                              # 先确认没写到 FE/QA 的路径
   node scripts/workflow/batch.mjs verify --manifest <f> --qa <qa-approval.json>   # 必须 PASS
   node scripts/workflow/batch.mjs apply  --manifest <f>                            # dry-run 复核计划
   node scripts/workflow/batch.mjs apply  --manifest <f> --apply --confirm-dev-closed
   node scripts/workflow/evidence.mjs                                                # 回执 → 状态（派生 applied）
   ```

   出现漂移立即停，只报受影响文件，不覆盖用户改动。

## 报告模板（6 行）

```
范围 <Rust/IPC/宿主改动>
命令 <cargo check/fmt/clippy/test 结果>；未跑 <…>
候选 <路径 + manifest sha>
集成 <来源片 / 冲突 hunk / 排除项>
回执 <apply/post-apply-verify 路径>
停笔 <是/否>
```

## 预算

单任务 ≤12 轮；集成批次单独计。Rust 冷编译已用共享 target 缓解，不要重复全量 build。

## 尺子

`cargo check` 通过 ≠ 测试通过 ≠ 真实 P4 行为正确。unknown 不得写成成功，partial 必须逐项对账。
