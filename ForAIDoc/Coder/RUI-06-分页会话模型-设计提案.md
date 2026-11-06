# RUI-06 分页会话模型 — 设计提案

> 状态：**提案（未实施）**・作者：arch（架构设计）・日期：2026-11-06
> 任务：`RUI-06 重构：分页会话模型（owner 支持同代次连续租约 + 多 id 取消集合）`，依赖 RUI-04
> 本文只做设计与只读调研；**未修改任何产品代码**，仓库内唯一新增文件即本文。

---

## 0. 结论先行（TL;DR）

1. **不要改 `OperationSessionOwner` 的核心语义，不要新增 paged session 类型。**
   「同一代次下串行多次租约」「多 id 取消」这两个需求，**用现有 owner 就能表达**，仓库里已经有
   **三处独立先例**（`SubmittedPage`、`ShelfDetailPage`、`ReviewRequestOwner`）已经手工实现了，
   只是没有收敛成显式 API。
2. 真正缺的不是能力，而是**一个共享的"分页链"小原语**（约 40–60 行纯 TS，零依赖），
   用来替代三处各自手写的 ref 书（`session.current` / `listSession` / `usedCursors` / `pendingCursors`）。
   → 推荐 **方案 B（组合层 `PagedChain`）的收敛版**。
3. **`requestGeneration` 的归属已被 `changelist` 先例解决**：它就应该**等于 `lease.epoch`**，
   与本地判活**同源**，不再是一个页面自己维护的 `useRef(0)` 计数器。
   Rust 侧经核实是**纯回显 + 非零校验**，不做相等比较，因此**`src-tauri` 零改动**。
4. `epoch` **不需要拆成 chain-level / lease-level 两级**——`isCurrent(lease)` 已经同时覆盖
   "这一页的租约还活着"和"整条链没有被 invalidate"，再拆会把 8 页已迁移代码全拖下水。
5. **`ToolPanel` 不在本提案覆盖范围**：它的问题是"事件订阅无完成点 + 取消已在下层手发"，
   与分页是两个不同问题，建议**单独立项 RUI-07**。

> ⚠️ 关于任务标题的偏差说明（遵守"不为了迁就任务描述而强行设计"的要求）：
> 任务标题写的是"**owner 支持**同代次连续租约 + 多 id 取消集合"，本提案的结论是
> **owner 不需要改，能力应当以"组合层"的形式提供**。详见 §6 / §8。

---

## 1. 约束（来自任务书 + 调研核实）

| 约束 | 内容 | 本提案的落实 |
| --- | --- | --- |
| 向后兼容 | 现有 8 页迁移 API 不变 | 只**新增可选成员**，`start/isCurrent/finish/abandon/cancel/invalidate/cancelAll/epoch` 签名全部不动 |
| `src-tauri` 尽量不改 | 除非论证必须 | **零改动**（§3 已论证：两个字段仅做 `!= 0` 校验） |
| 不引入新依赖 | — | 纯 TS 模块，仅用标准库 |
| 不写产品代码 | 本提案只是设计 | ✅ |
| 生产 P4 全禁 | 不运行真实命令 | ✅ 本轮只读源码 + `node scripts/workflow/state.mjs` |

**现有 API 使用面（只读核实，共 23 处 `useOperationSession()` 调用点）**：
`WorkspaceMutationDialog`、`BranchMappingMutationDialog`、`UnshelveDialog`、`SubmittedPage`、
`ChangelistFormDialog`、`SubmitDialog`、`ShelfDetailPage`、`DiagnosticsView`、`ShelfDialog`、
`OperationJournalView`、`SearchPage`、`LogView`、`ConnectionProfilesCard`、`CommandBar`、
`ConnectionDirectoryDialog`、`SyncDialog`、`FileLockDialog`、`ResolveDialog`、
`ConnectionSpecCreateDialog`、`RenameDialog`，外加 `reviewRequests.ts`（`ReviewRequestOwner` 包装）。
改动必须是**纯增量**，否则上述全部需要回归。

---

## 2. 现状：三个未迁移页面到底卡在哪

只读核实 `session.ts`（148 行）的语义：

- `start()` 第一行就是 `this.abort(channel)` → **启动即取代**，旧租约被 abort 并向后端 `cancelOperation`；
- `isCurrent()` 的承重判据是 **owner 全局 `sequence`**，外加 `identity` 与 `epoch` 三道等值比较；
- `invalidate()` = 抬 epoch + abort 当前租约，**不启动替代者**；
- `finish()` 退休但**不取消**；`abandon()` 退休**且**取消。

两个分页页面的实际需求与上述语义之间的冲突：

### 2.1 `StreamGraphPage.tsx` / `BranchMappingsPage.tsx` 的"续期式分页"

| 现状机制 | 代码位置 | 与 owner 冲突 |
| --- | --- | --- |
| `session.current` 是**跨 request 存活的会话** | SGP:136-144、BMP:116-124 | owner 没有"会话"概念，也没有"恢复一个会话 Id"的能力 |
| `requestGeneration = useRef(0)`，`startFresh` 自增 | SGP:222、BMP:197 | 代次由页面自己维护，与 lease 完全脱钩，两套判活并存 |
| `loadMore` **沿用同一 generation** | SGP:374、BMP:350 | 若直接改成 `session.start()`，会 abort 掉正在飞的首屏 → 分页被打断 |
| `restore()` 把 generation 设成**快照里的历史值** | SGP:274-283、BMP:251-260 | owner 的 epoch 只增不回，无法表达"恢复到某个历史代次" |
| 页面拿**后端回显值**反问隔离 `page.requestGeneration !== generation` | SGP:246、BMP:220/224 | 回显值与本地代次是否必须相等？→ §3 定案 |
| `activeOperations: Set<string>` + 遍历取消 | SGP:131/178-182、BMP:111/179-185 | owner 的 `cancelAll()` **只取消每 channel 的 1 个租约**，多 id 能力必须新增 |

### 2.2 `ToolPanel.tsx`（不同问题，见 §10）

- `generation = useRef(0)` + 手写代次校验（:51/:62/:85/:97）——**与分页无关**，只是手动失效；
- 事件订阅 `backend.subscribeOperationEvents` **没有完成点**（:68-81），取消在 `ToolDrawer.tsx:107/120/440`
  由下层直接 `onCancel` 手发——**绕过 owner**。

---

## 3. 问题一：契约字段分离 —— `requestGeneration` 从哪来、谁维护、与 lease 什么关系

### 3.1 【关键核实】Rust 侧：纯回显 + 非零校验，**从不参与比较**

对 `StreamGraphQuery.requestGeneration` 与 `BranchMappingQuery.requestGeneration` 逐一核实：

**`src-tauri/src/app/stream_graph_service.rs`** —— 全文仅 6 处：

| 行 | 用法 | 性质 |
| --- | --- | --- |
| 48 | `request_generation: u64` | 结构体字段 |
| 115 | `request_generation: query.request_generation` | **回填** |
| 357 | `request_generation: query.request_generation` | **回填** |
| 526 | `\|\| query.request_generation == 0` | **非零校验**（`InvalidQuery`） |
| 691 / 711 | 测试数据 | — |

**`src-tauri/src/app/branch_mapping_service.rs`** —— 全部 12 处，无一处比较：

- `normalize_query` (1162) / 各入口 (195/236) 调用 `validate_request_identity`；
- `validate_request_identity` (1197-1208) 的实现：`if request_generation == 0 || !valid_operation_id(..)` → 报错；
- 其余 141/225/343/861/1370 全部是 `request_generation: query.request_generation` **原样回填**。

> **结论：这两个字段在 Rust 侧是 `u64` 的"请求标识回显"，唯一约束是 `> 0`。
> 它既不是缓存键的一部分，也不与任何已存状态做相等比较。**

### 3.2 与两类先例对照

任务书给的两类先例，核实后确实是两种不同语义，而**我们这两个字段属于第一类**：

| 先例 | 位置 | 语义 | 归属 |
| --- | --- | --- | --- |
| `changelist_service.rs` | :305/:310/:345（SubmittedQueryCacheKey **只取 `generation`**，`request_generation` 单独存字段、命中后重写、返回前再赋回） | **纯回填** | 客户端自由决定 |
| `connection_setup_service.rs` | :66 `PartialEq for SpecTarget`、:412 `stored.request_generation != confirmation.request_generation` | **相等比较** | 属于**已保存的确认票据**，用于"你确认的东西没变" |

对 `SpecTarget` 的核实补充：该相等比较出现在
`SpecTarget` 的 `PartialEq` 与确认票据校验（:412）中，比较对象是**落盘的 ticket 记录**与**本次 confirmation**，
属于"审阅-确认-写入"的幂等保护。它和分页查询没有任何交集。

→ **两个分页契约字段应采用 `changelist` 语义，而不是 `connection_setup` 语义。**

### 3.3 设计定案

**`requestGeneration` 的唯一权威来源 = `lease.epoch`。**

```ts
// 现有已迁移页面的正确写法（SubmittedPage.tsx:412 / ResolveDialog.tsx:73-79 已如此）
const requestGeneration = lease.epoch;
...
const result = await backend.queryStreamGraph({ ...query, operationId: lease.operationId, requestGeneration });
if (!session.isCurrent(lease) || result.requestGeneration !== requestGeneration) return;
```

三个子问题逐一回答：

1. **从哪来**：从 owner 来（`lease.epoch`），**不再有页面自持的 `useRef(0)` 计数器**。
   `start()` 时 owner 已把 `epoch(channel)` 写进租约；`invalidate(channel)` 抬升它。
2. **谁负责维护**：owner 独占维护，页面只读。页面**不再 `++` 任何 generation**。
3. **和 lease 本地判活的关系**：**同源但不等价**。
   - `session.isCurrent(lease)` 是**唯一**的发布闸门（本地判活，权威）；
   - `result.requestGeneration !== requestGeneration` 是**契约一致性断言**（防御 IPC 序列化/回填 bug），
     它**不能**替代 `isCurrent`——因为同一 chain 里两次 load-more 可能带**相同** `requestGeneration`，
     光靠回显相等根本区分不出"这是上一页的迟到响应"。
   - 因此：**回显比较降级为断言，`isCurrent` 是主判据**。这也正是
     `StreamGraphPage.tsx:246` 与 `BranchMappingsPage.tsx:220` 目前**唯一的真实缺陷**：
     它们只比回显、且比的是页面自己维护的代次，`isCurrent` 缺失。

**关于 `restore()` 里的"历史 generation"**：
快照中保存 `requestGeneration` 是**无害但无意义**的——因为 Rust 不比较它，恢复后继续分页只要带
任意 `> 0` 的值即可。**但必须 > 0**（`stream_graph_service.rs:526`、`branch_mapping_service.rs:1201`），
而 owner 的 `epoch` 从 0 开始。

> 🔴 **实现陷阱（必须在实施时写入代码注释）**：恢复快照时**不得**用快照里的历史值去"回填" owner 的 epoch。
> 恢复的正确做法是 `owner.invalidate(channel)` 抬到 ≥1 后 `startIn` 复用该 epoch；
> **绝不能**写 `requestGeneration = cached.requestGeneration` 这种把页面代次和外层 owner 脱钩的代码
> （现有 SGP:274 / BMP:251 就是这么写的，是 bug 温床）。

---

## 4. 问题二：续期式分页 —— 同一代次下串行多次租约

### 4.1 现有的三种手工解法（核实结论：能力已够，只是没抽象）

| 文件 | 做法 | 代码 |
| --- | --- | --- |
| `SubmittedPage.tsx` | `append && chain.current ? chain.current : session.start(CHAIN)` | :406-408 |
| `ShelfDetailPage.tsx` | 每次 load-more **都 `start()`**（接受 supersede），旧租约的 `finally` 因 `isCurrent=false` 而**不再清 loading**，由新租约接管 | :241-294（注释 :242-243 写明）|
| `ReviewRequestOwner` | 把 channel+identity 绑定的薄包装 | `reviewRequests.ts:48-67` |

**三种做法能跑，但各自暴露一个隐患**：

- `SubmittedPage` 式：`chain.current` 只保留"最后一个 lease"，中间的 lease **没有任何句柄**——
  `cancelQuery()` 只能 `abandon` 最后一个。前一个如果还在飞（正常不会，因为 `chainBusy` 挡了，
  但**没有类型层面的保证**），会**漏取消**。
- `ShelfDetailPage` 式：语义上是"分页请求可以打断首屏请求"，**与主流语义相反**，且依赖注释解释，
  后人极易改坏。
- `ReviewRequestOwner` 式：只包了 channel，没有表达"同一 chain 的代数"。

### 4.2 需要新增 `startIn(chain)` / `chain` 概念吗？

**需要"chain"这个概念，但不需要改 owner 的内部数据结构。**

推荐：**chain = 一个由调用方持有的不可变对象 `{ channel, epoch }`，外加 owner 侧的一条新增方法。**

```ts
/** 一条分页链：同一 epoch 下允许多次串行租约；epoch 由 owner 维护。 */
export interface OperationChain {
  readonly channel: string;
  /** 本链在 wire 上的 `requestGeneration`；恒等于本 chain 内每个 lease 的 epoch。 */
  readonly epoch: number;
}

export class OperationSessionOwner {
  // ── 新增（纯增量，不改动任何现有方法语义） ──────────────────────

  /**
   * 开一条新链：抬升 channel epoch（丢弃旧链上的所有在飞租约），返回新 chain。
   * 等价于 `invalidate(channel)` + 读取新 epoch，只是把语义写清楚。
   */
  openChain(channel: string): OperationChain;          // = this.invalidate(channel); return { channel, epoch: this.epoch(channel) }

  /**
   * 在指定 chain 上开新租约：**不 abort 同 channel 的其他租约**。
   * - 若 `chain.epoch !== this.epoch(channel)` → 直接返回已失效的租约（signal.aborted=true），不发出后端取消；
   * - 否则把租约注册进 channel 的租约集合，返回正常租约。
   * 这是"续期式分页"的唯一入口，与 `start()` 的区别只有"是否 supersede"。
   */
  startIn(chain: OperationChain, options?: StartOperationOptions): OperationLease;

  /** 取消并清空整条链（含所有在飞租约），但**不抬 epoch**（区别于 invalidate）。 */
  cancelChain(chain: OperationChain): void;

  /** 当前该 channel 的在飞租约 id 快照（调试/断言用，避免页面自建 Set）。 */
  liveOperationIds(channel: string): readonly string[];
}
```

**关键：`chain.epoch` 是派生值，不是第二套计数器。** 它永远 `=== owner.epoch(channel)`（在链有效期间），
所以不存在"两个 epoch 打架"的问题。

### 4.3 `invalidate` 对整条链怎么作用

**天然就是对的，不需要额外代码**：`invalidate(channel)` 抬 epoch + cancel channel 上**全部**在飞租约。
因为 §4.2 已把内部状态从"每 channel 一个租约"改为"每 channel 一组租约"，
`invalidate` 再 `startIn(旧 chain)` 时，epoch 比较会让新租约**立刻失效**，链自然断掉。

> 因此语义表述为：**chain 的生命周期完全由 channel epoch 决定**。
> `chain.epoch !== owner.epoch(channel)` ⇔ 链已死。

### 4.4 `epoch` 语义要不要拆成 chain-level 和 lease-level？

**不拆。** 理由：

1. 现状下 `lease.epoch === owner.epoch(channel)`（`session.ts:82` 在读当前 epoch），
   二者在"start 时"本来就相等；分叉只发生在 `invalidate` 之后。
2. `isCurrent(lease)` 已经同时回答两个问题：
   - "这份结果还能发布吗" ← `signal.aborted` / `sequence` / `identity`；
   - "这条链还是当前链吗" ← `epoch`。
   拆开后需要引入第二个字段和第二次比较，**收益为零，破坏面却是 8 页 × 每页多处**。
3. `SubmittedPage` 已用 `lease.epoch` 同时承担 wire generation 与本地判活（:412/:433/:699），
   并**跑通了**，说明单级 epoch 足够。

→ **保留单级 epoch；只把"chain"作为调用方视角的只读派生值暴露出去。**

---

## 5. 问题三：多 id 取消 —— 集合语义

### 5.1 现状缺陷（语义层面，不是风格问题）

`activeOperations` 是页面**手写的第二套取消账本**，与 owner 的租约账本并行。由此产生：

1. **双账本漂移**：`finish()`（正常完成）后 owner 已无此租约，但页面 `finally` 里的 `delete` 若因
   early-return 被跳过（BMP:355/:375 的 `return` 在 `try` 内、`finally` 会执行——这点没问题），
   但 `closeDetail()`/`loadDetail()` 里**先 `delete` 再 `cancel`** 的顺序（BMP:403-413、459-463、563-575、999-1006）
   意味着 **`cancelOperation` 是页面自己发的，owner 完全不知情**；
2. **取消不幂等**：同一 id 可能被"页面 Set 遍历"和"owner 的 abort 监听"各发一次
   （owner `start()` 里 `signal` 的 abort 监听会 `cancelOperation`，`session.ts:86-93`）；
3. **`cancelAll()` 不够用**：`session.cancelAll()` 只清每 channel **1 个**租约（`leases: Map<channel, {...}>`），
   而这两页同时可能有 list / detail / preview 三条链在飞 → **必然漏取消**（BMP 最典型：list+detail+preview）。

> 这正是任务书所说"**如何保证不漏取消**是安全要求"的落点。

### 5.2 设计：取消的权威来源唯一化

**原则：`cancelOperation` 只能由 owner 发出；页面禁止直接调用 `backend.cancelOperation`。**

新增的回调契约（`OperationSessionOptions` 层面**保持不变**，仍是
`cancelOperation: (operationId: string) => Promise<unknown>`），变化在**调用时机与去重**：

```ts
interface CancelBookkeeping {
  /** 已为该 operationId 发出过取消请求的集合（owner 内部，永不外泄）。 */
  readonly cancelled: Set<string>;
  /** 幂等：同一 operationId 至多一次后端取消；后端错误吞掉（取消是尽力而为）。 */
  cancelOnce(operationId: string): void;
}
```

`cancelOnce` 的调用点收敛为 **3 处**（全部在 owner 内）：
`start()` 取代旧租约时、`abort()`/`cancelChain()` 时、`invalidate()`/`cancelAll()` 时。

> **为什么不把 `cancelOperation` 改成接受数组？** 因为它已经是 `(id) => Promise<unknown>`，
> 数组版只增加后端往返合并的收益，而 Rust 端 `cancel_operation` 是**按单个 id 精确匹配**的
> （`ipc/commands.rs:1287-1313`：依次调 `runner/search/stream_graph/branch_mappings` 的 `cancel(id)`），
> 批量接口需要改 IPC → **违反"src-tauri 尽量不改"**。前端去重即可，**签名不变**。

### 5.3 `finish` / `abandon` 与集合的关系

| 操作 | 从集合移除 | 向后端取消 | 备注 |
| --- | --- | --- | --- |
| `finish(lease)` | ✅ | ❌ | 已正常完成，取消会对已结束的 op 发无效请求 |
| `abandon(lease)` | ✅ | ✅（`cancelOnce`） | 幂等：已取消的不再发 |
| `cancelAll()` | 全部清零 | ✅（逐个 `cancelOnce`） | 覆盖**跨所有 channel 的所有在飞租约** |
| `cancelChain(chain)` | 仅该链 | ✅ | 不动其他链（对应"只取消当前列表请求"） |
| `invalidate(channel)` | 该 channel 全部 | ✅ | 抬 epoch |

**"不漏取消"的保证机制（三条，缺一不可）**：
1. **唯一账本**：租约集合在 owner 内，页面无法绕过（页面拿不到内部 Map）；
2. **兜底**：`useOperationSession` 卸载时 `cancelAll()`——只要租约经 owner 发放，卸载必然取消
   （`useOperationSession.test.tsx:51-57` 已有该断言，新增用例扩展为多租约）；
3. **静态可检**：ESLint 禁令 `no-restricted-syntax` / 自定义规则——`src/features/**` 下禁止
   出现 `backend.cancelOperation(` 直接调用（`ToolPanel.tsx:138` 是唯一现存违规，随 §10 单独处理）。

---

## 6. 两种候选方案

### 方案 A：扩展现有 owner（在 `session.ts` 内加 chain/集合概念）

```ts
export interface OperationChain { readonly channel: string; readonly epoch: number }

export class OperationSessionOwner {
  start(channel: string, options?: StartOperationOptions): OperationLease;              // 不变
  isCurrent(lease: OperationLease): boolean;                                            // 不变
  finish(lease): boolean; abandon(lease): boolean;                                       // 不变
  cancel(channel): void; invalidate(channel): void; cancelAll(): void; epoch(channel): number; // 不变

  // 新增
  openChain(channel: string): OperationChain;
  startIn(chain: OperationChain, options?: StartOperationOptions): OperationLease;
  cancelChain(chain: OperationChain): void;
  liveOperationIds(channel: string): readonly string[];
}
```

**内部数据结构改动**：`leases: Map<string, RegisteredLease>` → `Map<string, Map<number, RegisteredLease>>`
（channel → sequence → lease）。`isCurrent` 的判据从"是不是 channel 唯一的那个"改成"是不是 channel 集合里 sequence 最大的那个 **且** epoch 相等"。

- **对现有 8 页的影响**：由于 `start()` 仍会 `abort(channel)` 清空整个 channel 集合，**行为完全不变**。
  `isCurrent` 在单租约场景下退化为原语义。→ **8 页零改动**，但需要回归。
- **三页回迁改动量**：SGP 约 **-120 行 / +60 行**（删 `session.current`、`requestToken`、`requestGeneration`、
  `activeOperations`、`consumedCursors`/`pendingCursors` 五套 ref，换成 `chain` + 一个 `cursorLedger`）；
  BMP 约 **-150 行 / +80 行**（额外还要把 detail/preview 改成独立 chain）。
- **风险**：
  - 🔴 **`isCurrent` 的判据变复杂**，而它是 23 处调用点的承重逻辑，改错会**静默地让迟到响应通过**；
  - 🔴 `start()` 与 `startIn()` 的交互必须写非常密的测试才能保证"8 页行为不变"；
  - 🟡 现有测试 `session.test.ts`（115 行，9 用例）虽可不改而全过，但**不足以覆盖新增的集合语义**。

### 方案 B：新增独立 paged session 类型（`PagedSessionOwner`，与 owner 并列）

```ts
export interface PagedChain {
  readonly channel: string;
  readonly generation: number;           // = owner.epoch(channel)，> 0
}

export interface PagedRequest {
  readonly operationId: string;
  readonly requestGeneration: number;    // 恒 = chain.generation
  readonly signal: AbortSignal;
}

/** 分页链：同代次串行租约 + 游标账本 + 多 id 取消集合。 */
export class PagedSession {
  constructor(owner: OperationSessionOwner, mintOperationId?: () => string);

  /** 开新链（抬 epoch，丢弃旧链一切在飞请求）。 */
  open(channel: string): PagedChain;

  /** 链上发一页：不 supersede 同链其他请求；游标重复/不前进一律拒绝。 */
  request(chain: PagedChain, cursor?: string): PagedRequest;

  /** 该页是否仍是本链的合法发布者。 */
  isCurrent(chain: PagedChain, request: PagedRequest): boolean;

  /** 正常结束一页（不取消）。 */
  settle(CHAIN: PagedChain, request: PagedRequest): void;
  /** 放弃一页（取消，幂等）。 */
  abandon(request: PagedRequest): void;

  /** 取消整条链上所有在飞请求（不抬 generation）。 */
  cancel(chain: PagedChain): void;
  /** 全部取消（卸载兜底）。 */
  cancelAll(): void;

  /** 游标账本，替代页面手写的 consumedCursors/pendingCursors。 */
  readonly cursors: {
    tryClaim(cursor: string): boolean;   // false = 正在飞或已消费
    consume(cursor: string): void;
    release(cursor: string): void;
  };
}
```

- **对现有 8 页的影响**：**零**（完全旁挂，不触碰 `session.ts`）。
- **三页回迁改动量**：SGP 约 **-130 / +50**，BMP 约 **-160 / +70**（同样收敛 ref 书）；
  同时 `SubmittedPage` 与 `ShelfDetailPage` 可**顺手收敛**（可选，非必需）。
- **风险**：
  - 🟡 `PagedSession` 内部仍要复用 owner 的 `cancelOperation`，需要 owner 暴露一个
    `cancel(operationId)` 的细粒度入口（或用 `cancelBackend:false` 的独立 owner 实例）→
    **轻量的 owner 增量接口**不可避免（§4.2 的 `startIn` 更小）；
  - 🔴 概念一多（owner + chain + paged），新人需要读两个模块才会用。
  - 🟢 但**风险隔离最好**：分页模型出问题不会影响 8 页已迁移代码。

### 方案 C（不推荐的第三种，仅作对照）：不改模块，三页各自照抄 `SubmittedPage`

- 改动量最小（每页 ~40 行），**但** 复制三份 `chain.current` + `usedCursors` 手写逻辑，
  与"全仓无手写判活"的验收目标**直接冲突**，且 `cancelAll` 漏取消风险原样保留。

---

## 7. 推荐方案

### 推荐：**方案 B 的收敛版 —— 组合层 `PagedSession`，owner 只加最小增量**

即：

- **`session.ts`（owner）只加 1 个方法**：`cancelLive(operationId: string): void`（幂等、供组合层调用），
  以及 `liveOperationIds(channel)` 作为断言入口。**不改 `leases` 数据结构，不改 `isCurrent` 判据。**
- 新增独立模块 `src/shared/operationSession/pagedSession.ts`（约 150 行，含类型），
  由 `PagedSession` **持有一个 owner 实例**，用多个 channel（`${channel}:page`、`${channel}:detail`…）
  加 `cancelBackend:false` + 自管 `cancelOnce` 的方式绕开 owner 的 supersede 语义。

> **为什么这也算"组合"而不是"绕过"**：`PagedSession` 借用的是 owner 的
> **epoch 单调性 + 取消幂等 + 卸载兜底**三件事，这三件事就是 `session.ts` 的核心价值；
> 而它要的"同代次多租约"恰恰是 owner **刻意不提供**的（因为 8 页全都依赖 supersede）。
> **刻意不把这两种相反的生命周期塞进同一个判据函数，是这个设计最重要的决定。**

### 为什么不推荐方案 A

1. **它把相反语义塞进同一个 `isCurrent`**。"一个 channel 同时只能有一个活租约"是 8 页 23 个调用点
   的**隐含前提**；方案 A 让它变成"可能多个"，判据从 `current.sequence === lease.sequence` 变成
   "集合内最大且 epoch 相等"——**一旦写错，迟到响应会静默通过**，这是最难测的一类 bug。
2. **收益不成立**。任务标题假设 owner 需要支持分页；但核实后**已经支持**（`ShelfDetailPage`/`SubmittedPage`
   证明了），缺的只是**显式化与防漏取消**，而这些放组合层足够。
3. **破坏面与收益不成比例**：改核心 → 需要为 23 个调用点补回归；放组合层 → 只需为 2 个页面各补一份。

### 为什么不推荐方案 C（三页各抄）

`cancelAll` 漏取消风险**保留**，且与验收标准"全仓无手写判活"冲突。**不推荐。**

---

## 8. 推荐方案 API 草图（TS interface）

```ts
// src/shared/operationSession/pagedSession.ts —— 新增文件，零依赖
import type { CancelOperation, OperationSessionOwner } from "./session";

/** 一条分页链的调用方视角：generation 恒 > 0，链的有效性由 owner 的 epoch 决定。 */
export interface PagedChain {
  readonly channel: string;
  /** wire 上的 requestGeneration；恒 > 0，且本链内不变。 */
  readonly generation: number;
}

export interface PagedRequest {
  readonly operationId: string;
  readonly generation: number;
  readonly signal: AbortSignal;
}

export interface PagedSessionOptions {
  cancelOperation: CancelOperation;
  mintOperationId?: () => string;
  /** 见 §3.3：restore 时必须抬到至少 1；默认由 open() 保证。 */
  initialGeneration?: number;
}

export class PagedSession {
  constructor(options: PagedSessionOptions);

  /**
   * 开一条新链：抬 channel epoch，作废旧链上所有在飞请求（逐个幂等取消）。
   * `generation` 保证 > 0（owner epoch 从 0 起，这里 +1）。
   */
  open(channel: string): PagedChain;

  /**
   * 在链上开一页。**不** supersede 同链其他请求。
   * 链已死（被 cancel/invalidate/被新链取代）时返回 signal 已 abort 的请求，
   * 并且**不发出**后端取消（因为它从未发出过）。
   */
  request(chain: PagedChain, options?: { operationId?: string }): PagedRequest;

  /** 该页仍是本链的合法发布者 ⇔ 链未死 且 本页未被结算/放弃/取消。 */
  isCurrent(chain: PagedChain, request: PagedRequest): boolean;

  /** 正常结束（不取消后端）。 */
  settle(chain: PagedChain, request: PagedRequest): void;
  /** 放弃（取消后端，幂等）。 */
  abandon(chain: PagedChain, request: PagedRequest): void;

  /** 取消该链上**全部**在飞请求（不抬 generation，可继续分页）。 */
  cancel(chain: PagedChain): void;
  /** 取消所有链（卸载兜底）。 */
  cancelAll(): void;

  /** 游标账本：替代页面手写的 consumedCursors / pendingCursors 两个 ref。 */
  cursors: CursorLedger;
}

export interface CursorLedger {
  /** 认领一个游标用于请求；已在飞或已消费则返回 false。 */
  claim(cursor: string): boolean;
  /** 该页成功后标记已消费。 */
  consume(cursor: string): void;
  /** 失败/取消时释放，允许重试。 */
  release(cursor: string): void;
  /** 新链/restore 时清空。 */
  reset(): void;
  /** 防"后端返回非前进游标"：判断是否应停止分页。 */
  isStalled(nextCursor: string | undefined): boolean;
}
```

### owner 侧最小增量（`session.ts`，纯新增）

```ts
export class OperationSessionOwner {
  // …现有全部方法签名不变…

  /**
   * 幂等地为该 operationId 发出一次后端取消；供 PagedSession 使用。
   * owner 自身的 `start`/`invalidate`/`cancelAll` 内部也改走此方法，
   * 从而保证"同一 id 至多一次后端取消"。
   */
  cancelLive(operationId: string): void;

  /** 供调试与断言：某 channel 当前在飞租约 id（不可变快照）。 */
  liveOperationIds(channel: string): readonly string[];
}
```

> 注意：`session.ts` 现有 `leases: Map<channel, lease>` 是**每 channel 单租约**，
> `PagedSession` 通过**每个 `PagedRequest` 独占一个内部 owner channel**
> （`${channel}#${sequence}`）来规避，因此**不需要把 `leases` 改成嵌套 Map**。
> 这是一个可以完全不碰 `isCurrent` 判据的关键技巧——**方案 B 的全部价值就在这里**。

---

## 9. 对现有页面 / 三页回迁的影响与改动量估算

| 页面 | 改动内容 | 估算 | 风险 |
| --- | --- | --- | --- |
| 已迁移 8 页 + 15 个对话框 | **零改动**（只在 `session.ts` 增加 2 个方法） | 0 | 低（但需跑全量测试） |
| `StreamGraphPage` | 删 `requestToken`/`requestGeneration`/`activeOperations`/`session.current`/`consumedCursors`/`pendingCursors`（6 个 ref）；`startFresh` → `paged.open()+request()`；`loadMore` → 同链 `request()`；`restore` → `open()` 后**不用**历史值；`cancel` → `paged.cancel(chain)` | **-120 / +60 行** | 🟡 `restore` + `startFresh(true)` 并发路径最易错 |
| `BranchMappingsPage` | 同上，额外把 detail/preview 从 `detailOperation`/`previewOperation` 单值 ref 改成各自一条链（共 3 条链：list/detail/preview）；删 `cancelAll` 里遍历 `activeOperations` 的逻辑 | **-150 / +80 行** | 🟡 detail/preview 与 list 的取消隔离是重点 |
| `ToolPanel` | **不在本提案范围**（§10） | 0 | — |
| `SubmittedPage` / `ShelfDetailPage`（可选，二期） | 收敛到 `PagedSession`，去掉 `chain.current` 手写与 `ShelfDetailPage` 的"分页打断首屏"反语义 | 各自 **-40 / +25** | 🟡 二期做，不阻塞本期 |

**`src-tauri` 改动：0 行。**

---

## 10. `ToolPanel`：本提案**不覆盖**，建议单独立项

### 10.1 它的问题与分页无关（两个不同问题）

| 问题 | 证据 | 本质 |
| --- | --- | --- |
| **事件订阅没有完成点** | `ToolPanel.tsx:68-81` `backend.subscribeOperationEvents(...)` 只有 `live` 标志与 `stop()`，没有"这一批事件何时结束"的概念 | **流式订阅的生命周期建模**，不是请求生命周期 |
| **终端取消已在下层手发** | `ToolPanel.tsx:137-141` 的 `onCancel` 直接 `backend.cancelOperation`；调用方是 `ToolDrawer.tsx:107/120/440`，绕过 owner | **取消出口未收敛** |
| **手写代次校验** | `ToolPanel.tsx:51/62/85/97` `generation.current` | 这只是"连接变更即失效"，属于 §5 早已解决的**能力复用**问题 |

分页会话模型（多租约、游标账本）**对这三个问题一个都不适用**：ToolPanel 从来不"同一代次下发多次请求并累积"。

### 10.2 建议的单独立项

**新的 RUI-07「事件订阅与工具取消收敛」**，范围：

1. 把 `ToolPanel` 的 `generation` 手写判活换成 `useOperationSession()` 的
   `session.epoch(channel)` 判活（**能力已具备，纯机械替换，约 10 行**）；
2. 把 `ToolDrawer` 的 `onCancel(id)` 接到 owner（`session` 传入或回调上提），
   **消除全仓最后一处 `backend.cancelOperation` 直调**（可配合 ESLint 禁令守门）；
3. 讨论 `subscribeOperationEvents` 是否需要"订阅批次"概念（`subscribe(channel) → stop()` 的现有形态
   在 `subscribeSafely` 已有封装，**大概率不需要新模型**）；
4. 验收：`src/features/**` 下 `backend.cancelOperation(` 出现次数 = 0。

> 之所以强调"不要塞进 RUI-06"：塞进来会让 RUI-06 的 diff 从"2 个分页页 + 1 个模块"
> 变成"3 个页面 + 1 个模块 + 订阅模型"，**回滚粒度和归因都会变差**。

---

## 11. 验收标准

### 11.1 硬性（必须全部满足才算成功）

1. **全仓无手写判活**：
   ```bash
   # 以下三条 grep 全部应无命中（src/**）
   grep -rn "requestGeneration" src/features    # 仅允许出现在 backend 请求体与回显断言中，不允许自增/自持
   grep -rn "generation\.current" src/           # 0 命中（ToolPanel 由 RUI-07 处理；本期先列入白名单）
   grep -rn "activeOperations" src/features/browsers  # 0 命中
   ```
2. **原测试不改全过**：`src/shared/operationSession/session.test.ts`（9 用例）与
   `useOperationSession.test.tsx`（3 用例）**一行不改**仍然通过；这是"owner 语义未被破坏"的契约证明。
3. **三类断言齐全**（`pagedSession.test.ts` 新增，至少 9 个用例）：
   - **取消幂等**：同一 `operationId` 的 `abandon`/`cancel`/`cancelAll` 多次调用，
     `cancelOperation` **恰好 1 次**；`settle` 后不得再取消。
   - **代次漂移**：`open()` 后旧链的 `isCurrent` 全为 false；旧链在飞请求逐个被取消；
     新链 `generation` 严格大于旧链；**恢复快照后 generation 恒 ≥ 1**（否则 Rust 报 `InvalidQuery`）。
   - **迟到响应隔离**：同链 A、B 两页并发（模拟），A 迟到返回时 `isCurrent(chain, A)` 必须为 false，
     **即使 `A.generation === B.generation`**（这正是现有页面只比回显值的致命盲区）。
4. **不漏取消**：BMP 场景 list/detail/preview 三链同时在飞时触发卸载 → `cancelOperation` 调用
   **次数 == 在飞请求数**，无遗漏、无重复。
5. **Rust 零改动**：`git diff --stat src-tauri` 为空。
6. **门禁通过**：`node scripts/workflow/ci-fast.mjs --files <改动文件>` 与
   `node scripts/workflow/ownership.mjs check --role FE`。

### 11.2 软性（人工确认）

- `StreamGraphPage` / `BranchMappingsPage` 中不再出现任何"页面自维代次"的变量名；
- `startFresh` / `restore` / `loadMore` / `cancel` 四个入口的注释能说清"哪条链、哪个代次"；
- 快照里的 `requestGeneration` **不再被读取用于恢复**（或明确注释"仅记录，不参与恢复"）。

---

## 12. 分期实施建议

**推荐：两期，先模块 + 一个页面试点，再补齐第二页。**

### 第 1 期（模块 + 试点 `StreamGraphPage`）

1. `session.ts`：新增 `cancelLive()` + `liveOperationIds()`（纯增量，跑原测试验证全过）；
2. 新增 `pagedSession.ts` + `pagedSession.test.ts`（§11.1 第 3、4 条断言）；
3. `StreamGraphPage` 试点回迁（它比 BMP 少 detail/preview 两条链，**风险更低**，适合验证 API）；
4. 门禁 + 全量测试。

**为什么试点选 SGP 而不是 BMP**：BMP 有 list/detail/preview 三条链 + mutation 回调 + 4 处手发取消，
是全集；先用 SGP 把 API 形状验证好，BMP 落地时改动只有"再接两条链"。

### 第 2 期（`BranchMappingsPage` + 可选的先例收敛）

1. `BranchMappingsPage` 按第 1 期验证过的 API 回迁（3 条链）；
2. **可选**：`SubmittedPage` / `ShelfDetailPage` 收敛到 `PagedSession`，
   顺手消掉 `ShelfDetailPage.tsx:242-243` 那条"分页打断首屏"的反语义注释；
3. ESLint 禁令开关打开：`src/features/**` 禁止 `backend.cancelOperation(` 直调
   （等待 RUI-07 修掉 `ToolPanel.tsx:138` 后才能开；**在此之前只加 `warn`**）。

### 三页不一起做的理由

- `ToolPanel` **根本不属于这一期**（§10）；
- BMP 的改动面是 SGP 的 2 倍且有 mutation 交互，与 API 首次落地同批进行，
  一旦出问题**无法区分是 API 设计错还是页面移植错**。

---

## 13. 遗留问题 / 待确认

| # | 问题 | 建议 |
| --- | --- | --- |
| 1 | 快照里的 `requestGeneration` 字段要不要**直接删除**？ | **保留但不再读取**，避免破坏已有磁盘快照的反序列化校验（`isStreamGraphSnapshot` / `isBranchMappingSnapshot`）；在类型注释里写明"仅记录，不参与恢复" |
| 2 | `PagedSession` 与 `ReviewRequestOwner` 是否合并？ | 暂不。二者 channel 分配策略不同（后者按 review identity 分 channel），合并会引入回归 |
| 3 | `SubmittedPage` 的 `chain.current` 中"中间 lease 无句柄"是否本期修？ | 本期不修（靠 `chainBusy` 保证串行），二期收敛时自然消失 |
| 4 | ESLint 禁令的具体实现 | 待与 `scripts/workflow/` 的既有 lint 配置一并确认（本轮未读 lint 配置，**列为待办**） |
| 5 | 是否需要在 `docs` 层同步更新前端架构约定 | 建议实施完成后在 `ForAIDoc/Coder/前端架构与维护约定.md` 补一节"分页链与会话 owner" |
