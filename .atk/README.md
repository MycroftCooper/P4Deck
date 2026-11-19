# P4Deck 的 ATK 自动化

配置位于 `automations/`；`runs/` 保存每次 ATK 运行的完整日志、原生 CI 摘要、ATK 报告和发布产物，`.atk/.gitignore` 排除 `runs/` 与 `local/`，不纳入 Git。

**仓库状态（2026-11-18）**：`.atk/`（配置与本台账）、`scripts/atk-ci.mjs`、`scripts/atk-ci.node-test.mjs` 和 `scripts/ci-runner.mjs` 的 `P4DECK_CI_OUTPUT_DIR`/`::atk::` 支持已作为同一组纳入 Git；`runs/` 与 `local/` 由 `.atk/.gitignore` 排除。以后改动配置、适配器或适配器测试时保持同组提交，否则本台账描述的入口和门禁计划会再次与仓库脱节。

两条流程均手动触发，也可以由本项目的 Agent 通过 `atk-agent automation run` 发起。

- **P4Deck 冒烟（smoke）**：执行现有 `ci:quick`。2026-11-18 实测为 23 项：前端契约与 IPC 表面、版本与 changelog、i18n 两项静态检查、`workflow-state`、9 项 `node:test` 自测（含 `atk-ci-tests`）、web 格式/类型/vitest、rust 格式/clippy/测试，以及 `browser-smoke`（3 个 spec，单 worker）。不启动 P4 fixture、不上传。
- **P4Deck 发版（release）**：发布前置条件 → `ci:local` 完整门禁 → 现有 `publish-update.mjs` 签名构建及发布。`ci:local` 是 quick 全部基础项再加 web/desktop 构建、bundle 审计、全量 `browser-e2e` 与前后端性能门禁，按当前 `scripts/ci-runner.mjs` 的 `local` 计划静态计数为 29 项（本次未执行）；显式设置 `P4DECK_CI_RUN_P4D=1` 时再加 Windows 隔离 p4d E2E 一项。

发版参数：

- `realPublish`（是否真实发版），默认 **false**：传 `--skip-publish`，只在本地生成签名安装包及更新清单。
  选择 **true** 才会上传并公开 GitHub Release。
- `allowDirty`（本地预演允许未提交改动），默认 **false**：只能用于不上传的本地构建；不能和真实发版同时开启。

发版前先按项目现有流程准备版本、应用内 changelog 及 `ForAIDoc/PM/releases/v<version>.md` 的双语说明。
真实发版还要求干净的 `release` 分支、指向 HEAD 的版本标签以及已经推送的同一远端标签。
ATK 不执行版本升级、Git 提交、合并或推送；这些准备步骤继续使用现有发布流程。
签名材料和 GitHub 凭据由现有发布脚本从本机环境读取，不写进自动化配置和报告。
缺少发布说明、源码不干净或标签未准备好时，前置步骤会失败并跳过后续构建/发布，不会假装成功。

## 适配入口

适配入口为 `scripts/atk-ci.mjs`，复用现有 CI 和发布脚本。
CI 输出目录通过 `P4DECK_CI_OUTPUT_DIR` 切到本次运行的 `output/ci/`；未设置时原来的命令和输出位置保持不变。
内部检查开始/结束会显示进度，长检查由适配器发送心跳；进度与心跳的 `::atk::` 输出和 `P4DECK_CI_OUTPUT_DIR` 支持都落在 `scripts/ci-runner.mjs`（`git log -p -- scripts/ci-runner.mjs`）。用不含这些改动的旧版 runner 运行时，适配器读不到 `<output>/ci/<mode>-latest.json`，冒烟会被判成 `CI report` 失败，而不是通过。
`scripts/atk-ci.node-test.mjs` 验证布尔参数、默认禁止发布和前置条件，不调用真实上传；该套件已作为 `atk-ci-tests` 进入 `ci:quick`。

## 核验记录

### 2026-11-17 首次接入（历史）

- ATK 实例已识别 smoke/release 两条配置；UI 中 realPublish 和 allowDirty 均默认 false。
- 适配器 4 项 Node 测试通过；新增脚本和 CI 入口的格式检查通过。
- 冒烟运行 `20261117T090736Z-77c851e1-a937-44ac-9640-ff032dc63657`：当时 22 项门禁中 21 项通过；web-check 被已有的 `src/features/settings/ConnectionSetupGate.tsx:79`（TS2554：useRef 缺少初始参数）拦截。该业务文件未在此次 CI 接入中修改。
- 发版预演运行 `20261117T091051Z-31a29615-ded6-4a15-aaae-e042c53ed7bf`：realPublish=false、allowDirty=true；因当前 0.1.15 尚缺双语发布说明被前置步骤拦截，完整检查和签名构建/发布步骤均为 SKIPPED。没有上传、真实发布、Git 提交、合并或推送。
- 门禁组成有两次变化：11-17 当次 22 项（含当时工作树里的 `atk-ci-tests`、无 `browser-smoke`）；随后 `browser-smoke` 提交进 quick；2026-11-18 本组提交把 `atk-ci-tests` 一并纳入，quick 固定为 23 项。历史数字只代表各自当时的计划。

### 2026-11-18 复核（当前）

- 上次的 web-check 阻塞已解除：`ConnectionSetupGate.tsx` 的 useRef 初值由 `fe77321` 修复；`pnpm check:web` 与本轮 `ci:quick` 中的 `web-check` 均通过。
- 第一次复核在右键菜单/Search 的在途改动尚未提交时执行（`0403954` 附近，`P4DECK_CI_OUTPUT_DIR=.atk/local/ci-align`）：23 项中 21 项通过、2 项失败，216.2 s。
  - `web-format` 失败：`src/app/context-menu/model.ts`、`model.test.ts` 未格式化。这两个文件随后随 `de0d103`、`6d32c66` 提交，当前 `pnpm format:check` 通过。
  - `rust-test` 失败：`app::confirmation::ticket_tests::a_review_that_expires_during_the_recheck_is_refused_after_it`（600 通过 / 1 失败 / 6 ignored）。该用例单独重跑与整包复跑都通过（601 通过 / 0 失败 / 6 ignored）：它用 120 ms TTL 对真实时钟做断言，满负载下可能在预检前就已过期，属时间敏感的易抖用例，不能当作功能回归结论。
- 第二次复核在 `de0d103`、`6d32c66`、`4667346` 提交之后执行（HEAD `4667346`，`P4DECK_CI_OUTPUT_DIR=.atk/local/ci-align2`）：**23 项全部通过**（`ok:true`，205.4 s），其中 `browser-smoke` 55.7 s、`web-test` 111.4 s；`rust-test` 本轮通过（84.9 s），印证上一轮是该用例在满负载下的抖动。
- 发版前置仍受阻：`ForAIDoc/PM/releases/v0.1.15.md` 仍不存在；`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 已到 0.1.15，最近发布标签仍是 `v0.1.14`。真实发版所需的 `release` 分支、指向 HEAD 的 `v0.1.15` 标签和远端同名标签也尚未准备。
- 以上是本机当次源码的核验结果；后续运行以 ATK 对应 runId 的归档为准。门禁项、适配入口或参数变化时，同步更新本文件与 `ForAIDoc/Coder/AgentTeamKit接入.md`。
