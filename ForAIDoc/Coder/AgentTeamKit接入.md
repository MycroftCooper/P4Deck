# P4Deck 的 Agent Team Kit 接入

更新：2026-11-18。本文说明当前任务入口和协作协议；产品功能、测试与用户验收仍按各任务的具体证据判断。

## 当前入口与项目归属

任务规划、领取、运行、回执与验收统一使用本机 **Agent Team Kit（ATK）**。先打开当前实例的网页或桌面界面，再选择工作空间 **P4Deck**。

当前开发机的入口分开提供：

- **人用界面**：优先使用已打开的 ATK 桌面窗口；浏览器网页当前在 `http://127.0.0.1:5173/`，须使用该实例的私有访问码或私有链接解锁。不要把私有访问码、链接中的访问参数或 Agent 令牌记录进文档。
- **Agent API origin**：`http://127.0.0.1:1421`，下文 `ATK_URL` 始终指向此地址。当前开发实例的 `GET /` 返回 404 JSON；它不是网页入口，但健康检查和 Agent API 可正常工作。
- **标准安装版**：后端提供已构建网页时，网页和 API 可以同在 `1421`；以启动器返回的当前实例地址为准，不能将此安装模式套用于上面的开发实例。

网页端口可能随启动配置变化。浏览器私有访问码和 Agent 凭据各有用途；不能拿 `ATK_AGENT_TOKEN` 解锁网页，也不能把网页访问码交给 Agent。

- 项目 `projectId`：`project_ece33a91-962a-4264-ace0-583786ac661b`。
- 项目代码：`D:\GitCode\P4Deck`；任务文档与快照：项目下 `.agent-team/`。
- 「工作 → 任务 / 待我处理 / 协作实况」分别用于查看任务、处理批准与验收、观察真实运行与进度；任务名称打开共用详情抽屉。
- 「团队 → 项目 Agent」管理当前项目身份。每个身份及凭据固定归属此项目，其他项目不能复用；共享角色模板不等于共享身份。

**ATK 不会自动启动 AI 或开发会话。** 外部 Agent 必须实际运行并调用协议；创建身份、登记联系和领取工作是三个不同动作。最近有联系不保证进程仍存活，也不表示它正在领取任务。

## 接活前先对账

2026-11-14 的恢复基线为 `dev` 的 `96953e4`（`0.1.14` 发布记录提交）。截至 2026-11-18 的 `0403954`，该基线之后已有 30 个提交；工作树版本为 `0.1.15`（未发布），最近发布标签仍是 `v0.1.14`。旧需求描述中的“待实现”“尚未提交”不能直接作为重复施工依据。

在 ATK 的项目资源中读取 `agent/p4deck-current-status`，并在任务页按 `对账-20261114` 及分类标签定位逐条结论。对账标签表达当前核对结果，不代替生命周期状态；提交存在、历史测试报告和用户验收分别记录。对账资源保留每条旧需求、历史依赖、文件存在性和提交依据。

以下旧文档只读追溯，不再新增、领取或推进任务：

- [旧工作流与角色合同](../PM/工作流/README.md)。
- [旧功能与验收台账](../PM/Windows本机私用TODO.md)。
- [历史交接](../PM/并行交接.md)与[项目状态总览](../PM/项目状态总览.md)。

截至本轮对账时（2026-11-14），RUI-02 的过期人工会话已结束、人工验收重新排队；这是恢复时的历史快照，后续交付与验收状态请直接查看 ATK 当前记录。本轮文档交付不代勾该验收，也不能因租约恢复或版本发布推断它已通过。

## 身份与凭据

LEAD 使用 `ORCHESTRATOR` 身份规划；FE、BE、QA-ENG 及文档执行者使用各自受限的 `WORKER` 身份；QA 使用独立的 `REVIEWER` 身份。计划作者不执行或评审自己的计划，执行者不评审自己的交付。文档维护身份仅有获批的文档写域，不扩大 FE/BE 的产品写域。

本次恢复的 LEAD、文档与 QA 使用不同凭据。旧 LEAD/QA 身份保留历史记录，旧凭据已撤销；其他角色只有实际接入后才报告联系。凭据由协调方保存在本机私有数据目录，执行者只取被授权角色的条目。凭据不得提交到仓库，也不得写入普通文档、进度、日志、回执或截图。浏览器私有访问码与 Agent 凭据不同，不能互换。

先确认 **Node.js 24 或更新版本**。本机恢复时没有全局 `atk-agent` 命令，可直接运行 ATK 源码 CLI，无须全局安装或修改 `PATH`。以下 PowerShell 函数只在当前会话中提供命令名；已安装 `atk-agent` 时使用原命令即可。ATK 源码迁移目录后，应相应调整这一个路径。

```powershell
node --version
if (-not (Get-Command atk-agent -ErrorAction SilentlyContinue)) {
  function atk-agent { & node "D:/GitCode/agent-team-kit/apps/agent-cli/cli.mjs" @args }
}
atk-agent --help
```

也可不定义函数，逐条使用 `node D:/GitCode/agent-team-kit/apps/agent-cli/cli.mjs doctor` 等源码命令；后续子命令及参数完全相同。

下面是 PowerShell 命令示意，所有尖括号均须替换，令牌从本机安全配置注入；不要把实际令牌粘入版本控制文件。

```powershell
$env:ATK_URL = "http://127.0.0.1:1421"
$env:ATK_AGENT_TOKEN = "<当前角色的项目凭据>"
atk-agent doctor
atk-agent connect
atk-agent resources show agent/p4deck-current-status --scope project --project project_ece33a91-962a-4264-ace0-583786ac661b
```

使用上面已安装或源码包装的 `atk-agent` CLI；P4Deck 项目无需安装 ATK 或模型 SDK。`doctor` 检查服务与凭据，核对返回的 `identity.projectId`，不会更新时间或领取任务。`connect` 登记实际联系；不能只不断发心跳来制造“在线”状态。

## 从规划到交付

1. 在 P4Deck 工作空间创建新需求。LEAD 先读对账资源和当前代码，再精确领取该需求，提交角色、依赖、文件范围、检查与验收条件明确的计划。
2. **人类或获得本次明确授权的协调方批准具体计划版本后**，执行任务才会释放。Agent 的计划提交本身不授予执行权限；需求批准不等于产品验收通过。
3. 执行者只领取分配给自己的具体任务，按返回的 `spec`、`generation`、写域和必需检查施工。
4. 保持运行租约，实际进展通过事件上报；停止所有写入后提交检查与交付回执。
5. QA 用另一个身份领取评审，核对冻结交付及 `targetHash`，提交 `PASS`、`CHANGES_REQUESTED` 或 `BLOCKED`。变更后的产物必须重新绑定目标，不能复用旧通过结果。
6. 独立检查通过使工作达到 `VERIFIED`；整项需求仍需最终验收。人类或获得相应明确授权的协调方核对当前目标后批准最终验收，需求与已验证子任务才关闭。需要本人操作的产品验收仍由用户确认。

精确领取及续租的 CLI 示例：

```powershell
atk-agent claim --project project_ece33a91-962a-4264-ace0-583786ac661b --task <taskId> --wait 0
atk-agent watch <runId> --generation <generation>
```

`watch` 应在另一终端或受控子进程中运行；它约每 **10 秒**发送一次 `heartbeat`，租约为 **30 秒**。也可由调用方按相同间隔调用 `atk-agent heartbeat <runId> --generation <generation>`。写入前核对运行仍有效；出现 `stopRequired:true`、续租失败、撤销或代次不符时立即停笔。CLI watcher 以退出码 3 提示停止；不能留下无人负责的续租进程。终态回执确认后结束 watcher。

`claim` 返回 `run:null` 表示没有可领取工作，不是成功开工。只有真实 Run 才能报告执行；保留 `run.id`、`generation` 与 `leaseUntil`，不能拿旧代次继续写文件。

上报与交付命令示意：

```powershell
atk-agent events <runId> --file <events.json> --generation <generation>
atk-agent submit <runId> plan --file <plan-receipt.json>
atk-agent submit <runId> result --file <result-receipt.json>
atk-agent submit <runId> review --file <review-receipt.json>
```

三种 `submit` 由各自角色在相应阶段使用，不是同一身份顺序调用。`events.json` 是事件数组，每项含唯一 `eventId`、`type`（如 `progress`）及真实 `message`。提交文件包含本次 `generation`；执行回执包含 `outcome`、`stopped:true`、总结和实际运行的全部必需检查，评审回执包含 `targetHash`、`verdict` 和发现。未跑项如实说明，不能报绿；进度文字不会自动完成任务。

只有收到 `persisted:true` 才确认最终提交已持久化。网络状态不明确时保留原 `idempotencyKey`，用 `atk-agent get <runId>` 核对，或用 `atk-agent replay` 重送本机待确认回执，不能创建重复交付。

## 停止、隔离与人工验收

租约到期会使运行进入隔离，容量和文件锁不会自动释放。先检查外部写入者已经停止，再由原 Agent 用 `atk-agent stopped <runId> --generation <generation>` 确认，或由获授权的协调方在页面确认停止。`stopped` 只用于已请求停止或隔离的运行；正常完成使用执行回执。确认停止保留已有改动，不回滚文件，也不代表验收成功。

人工任务由页面「开始」后执行，工作台负责续租；本人完成对应操作后再提交交付。不能把历史人工勾选、未知运行结果或项目发布记录补造成新的成功 Run。

## 手动本地检查

当前 ATK 的 P4Deck 自动化配置在 `.atk/automations/`，通过 `scripts/atk-ci.mjs` 复用现有脚本；两条都是手动触发，由本文件的维护者按需运行：

- **P4Deck 冒烟（`smoke`）**：`atk-ci.mjs --task smoke` 执行 `pnpm ci:quick`，2026-11-18 实测 23 项（含 `browser-smoke` 与 `atk-ci-tests`）。不启动 P4 fixture、不上传。
- **P4Deck 发版（`release`）**：发布前置条件 → `ci:local` 完整门禁（当前计划 29 项，本次未执行）→ `publish-update.mjs` 签名构建。`realPublish` 默认 false，只生成本地签名产物；`allowDirty` 仅在 realPublish=false 时可用。ATK 不做版本升级、提交、合并或推送，真实发版仍按既定授权流程。

2026-11-17 曾在本机各执行一次：冒烟 22 项中 21 项通过（web-check 被当时的 `ConnectionSetupGate.tsx` 类型错误拦截），发版预演被缺失的 `ForAIDoc/PM/releases/v0.1.15.md` 前置拦截。2026-11-18 在 `4667346` 上复跑 `ci:quick` 为 23 项全绿；此前一轮仍带在途改动时是 21/23，两个失败项的定位与处置见 ATK 台账 `.atk/README.md`。模板存在或按钮执行完都不等于产品验收；`.atk/`、适配器与 runner 适配改动已在 2026-11-18 作为同一组提交纳入 Git。

## 当前操作边界

- AI 执行只允许已完成身份与环境安全证明的**项目本地假 P4**；禁止连接生产 P4，包括只读。细节见[本地假 P4 安全核验](本地假P4安全核验.md)。
- 发布、上传和创建对外版本必须获得用户当次明确授权；对账或小任务授权不包含发布。已有 v0.1.14 记录不授予下一次发布权限。
- 文档检查和协作协议链通过，只能证明对应范围；不能宣称 P4 原生流程、用户未做的验收或连续两小时稳定性已经通过。
- 每次交接记录代码基线、实际检查、未跑项和停止状态；新任务继续在 ATK 创建、领取与回执，旧 JSON/看板保持只读。
