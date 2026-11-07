# RUI-07「工具面板订阅式会话」设计提案

> 作者：arch2（架构设计）｜日期：2026-11-06｜分支：dev
> 性质：**只读调研 + 设计**。本文件是本次唯一写产物；`src/**`、`src-tauri/**`、`scripts/**` 零改动。
> 前置阅读：`src/shared/operationSession/session.ts`、`pagedSession.ts`、`ForAIDoc/Coder/RUI-06-分页会话模型-设计提案.md` §7。

---

## 0. 结论先行（TL;DR）

**RUI-07 的验收标准（"取消只发一次"）当前已经成立；本任务不该"做点什么"，而该改写成"记录现状 + 收窄范围"。**

| 立项中的假设 | 核实结论 | 依据 |
| --- | --- | --- |
| 「终端取消双路，迁过去会双路取消」 | **不成立。现在就是单路**，且代码结构上**不可能**出现同 id 双发 | §3.2 三条路径逐条核账 |
| 「订阅需要独立原语 `SubscriptionScope`」 | **不需要。** 现有 4 行 hook + `subscribeSafely` 已经正确；再包一层是"把正确的东西再包一遍" | §2.3 |
| 「`generation` 是手写判活，应换成 owner 租约」 | **不建议**。它不是代替租约，而是租约**做不到的**两件事之一（跨 sibling 做废弃通知）。换掉 = 丢能力、加耦合 | §5 |
| 「`temporaryId` 是可疑契约字段」 | **已确认是纯回显**（`runner.rs:372-376`，唯一约束"非空"，无相等比较）。**无需改动**，但建议加契约测试钉住 | §4 |

**推荐方案：本文 §7「方案 A+（收窄版）」—— 4 个文件、约 45/20 行、零新增原语、零 `src-tauri` 改动。**
**明确不推荐** §7「方案 B（引入 `OperationSessionRegistry` 收口全仓取消）」与 §7「方案 C（引入 `SubscriptionScope`）」。
**最重要的单条建议**：把 PM 的任务描述**改掉**（见 §9.3），因为它现在的三个前提里有两个是错的——照它做会得到负收益的改动。

---

## 1. 范围与方法

### 1.1 调研输入（全部只读）

| 文件 | 读法 |
| --- | --- |
| `src/shared/operationSession/session.ts`（171 行） | 全文；确认 `start` 即 supersede、`invalidate`、`cancelAll`、`cancelLive` |
| `src/shared/operationSession/pagedSession.ts`（182 行） | 全文；确认"不改 owner、用组合层叠加"的先例形态 |
| `src/shared/operationSession/useOperationSession.ts`（26 行） | 全文；确认绑定与卸载兜底 |
| `ForAIDoc/Coder/RUI-06-…提案.md` §3.1 / §7 / §10 / §13 | 摘读裁决与 ToolPanel 归属 |
| `src/features/tools/ToolPanel.tsx`（152 行） | 全文 |
| `src/features/tools/components/ToolDrawer.tsx`（502 行，非约 492） | 全文 |
| `src/features/tools/ToolArea.tsx`（211 行） | 全文（**第二个宿主，立项文件里没提**） |
| `src/app/PageRenderer.tsx:345-360` | 确认 `key={connectionKey}` |
| `src/shared/lib/subscription.ts`（20 行） | 全文 |
| `src-tauri/src/p4/runner.rs` | 90-101、239-309、372-397、446-520、660-800 精读 |
| `src-tauri/src/ipc/commands.rs:1215-1320` | `run_p4` / `cancel_operation` / `cancel_all_operations` |
| `src-tauri/src/domain.rs:117-135` | `P4CommandRequest.operation_id: Option<String>` |
| `src/infrastructure/backend/tauriBackend.ts:105-124` | `runP4` / `cancelOperation` / `subscribeOperationEvents` 绑定 |
| 测试：`ToolsDiagnostics.test.tsx`(920 行)、`ToolsOperationSession.test.tsx`、`ToolDrawer.closeGuard.test.tsx`、`session.test.ts`、`pagedSession.test.ts`、`useOperationSession.test.tsx` | 找既有断言，判断"改哪会挂" |

### 1.2 方法

1. 对每条立项假设做**代码级反证**：能不能构造一条真实路径让假设成立。
2. 对每个候选方案做**影响面枚举**：要改几个文件、几个调用点、几处既有测试断言、有没有静默失败的判据。
3. 沿用 RUI-06 的裁决准则：**判据复杂度不换概念数量**。

---

## 2. 问题一：订阅式生命周期能不能复用现有原语？

### 2.1 现状（`ToolPanel.tsx:61-81`）

```ts
useEffect(() => {                          // :61-66
  generation.current += 1;
  setEvents([]); setError(""); setRefreshKey(v => v + 1);
}, [connectionKey]);

useEffect(() => {                          // :68-81
  let live = true;
  const stop = subscribeSafely(
    () => backend.subscribeOperationEvents((event) => {
      if (live) setEvents(current => [...current.slice(-999), event]);
    }),
    cause => setError(String(cause)),
  );
  return () => { live = false; stop(); };
}, []);
```

订阅语义：**无 ID、无完成点、无取消句柄**。它的生命周期严格等于挂载期（依赖数组 `[]`），**不随 `connectionKey` 重建**。

### 2.2 它为什么不满足 `OperationSessionOwner` 的前提（三条，任一即否决）

1. **没有可取消的东西。** `session.start()` 的整个价值是"这个 operationId 可以被 `cancel_operation` 撤销"。事件流没有 id，`cancelOperation("")` 在 Rust 侧直接被 `commands.rs:1292` 判为 `unknown` 并丢弃。租约的 `cancelBackend` 语义（`session.ts:85-94`）在这个对象上**没有所指**。
2. **没有完成点。** owner 的 `finish(lease)`（`session.ts:113-117`）要求"正常结束"。订阅永不结束，套上去只能二选一：要么永不 `finish`（永久占住 channel，导致同 channel 的下一次 `start` 把它 supersede 掉——即**订阅被自己的下一个订阅杀死**）；要么在每次事件后 `finish`（那租约就退化成事件计数器，毫无意义）。
3. **不在 owner 的实际作用域内。** 全仓调用 `useOperationSession()` 的只有 `DiagnosticsView` / `OperationJournalView`（`ToolsOperationSession.test.tsx:37` 对应的组件）和 `ToolDrawer` 里**委派出去的两个视图**。`ToolPanel` 与 `ToolArea` 自身**没有 owner 实例**。把订阅"纳入 owner"意味着在 `ToolPanel` 顶部新造一个 owner——而那个 owner 除了订阅之外**一个租约都不会发**（终端的租约只该在 `ToolDrawer` 里发，见 §6）。为 0 个租约造一个 owner，纯负收益。

### 2.3 现有 `live` 布尔守卫是不是"已经正确"？—— 逐条核对已知的三种失效模式

| 失效模式 | 本次代码 | 判定 |
| --- | --- | --- |
| 注册未完成就卸载 → 事件/`setState` 打到已卸载组件 | `subscribeSafely` 的 `disposed` 标志 + `live` 双重保险（`subscription.ts:6-19`） | ✅ 已覆盖 |
| 卸载时监听器泄漏 | `return () => { live = false; stop(); }`，`stop` 是 `listen()` 返回的 `UnlistenFn`（`tauriBackend.ts:121-124`） | ✅ 已覆盖 |
| 注册失败吞掉错误 | `subscribeSafely` 的 `catch` → `onError` → `setError` | ✅ 已覆盖 |
| StrictMode 双挂载 | effect 两次执行、两次 cleanup，`live`/`stop` 都是闭包局部 | ✅ 自然正确 |
| `stop()` 抛异常阻断后续卸载 | ⚠️ 未捕获 | **成本 0 的加固点**，见方案 A+ 的 A3 |

> **结论（对应任务问题 1）：不引入 `SubscriptionScope`。** 现有形态不是"还没迁移"，而是**已经是对的形态**：
> 一个没有取消语义、没有完成点的对象，用"作用域布尔 + 卸载函数"建模就是最小完备解。
> 给它套 `start/finish/isCurrent` 会引入**新的概念、新的不变量（"订阅租约永不可 finish"）和新的误用可能**，
> 换来的收益是 0 —— 因为这里从来没有任何"迟到响应"需要判定（`live` 已经把它挡在 `setEvents` 之外）。
>
> 唯一的真实问题**不在 `ToolPanel`**：`git`-free 的核账显示 `ToolArea`（见 §3.1）**也订阅同一事件流，同样不按连接裁剪**。
> 那不是"订阅生命周期"问题，是"事件消费权限"问题，见 §6.3。

### 2.4 顺带核实：`ToolPanel` 订阅与 `connectionKey` 的语义错配（真问题，但修法不是新原语）

`ToolPanel` 的 `key={connectionKey}`（`PageRenderer.tsx:349`）在 App 内运行时会**整组件重挂**，
所以 `[]` 依赖不会跨连接泄漏。**但** `ToolsDiagnostics.test.tsx:724-773`（"invalidates a detached Terminal promise when a
runtime-keyed panel remounts"）证明：`ToolPanel` 可以被**以非 `connectionKey` 为 key** 的场景重挂。
两种场景下 `connectionKey` 的行为不一致（有时随重挂变，有时靠 effect 变），这正是 §5 要处理的问题。

---

## 3. 问题二：终端执行的取消权威来源

### 3.1 先补齐立项书漏掉的"第二宿主"

`ToolDrawer` 有**两个宿主**，两者都有 `onCancel` 直发：

| 宿主 | `onRun` | `onCancel` | 是否按连接裁剪事件 |
| --- | --- | --- | --- |
| `ToolPanel.tsx`（独立终端/日志页） | `run` @`:83-105`，有 `generation` 比对 `:97` | `:137-141` → `backend.cancelOperation` | ❌ 无裁剪，跨连接混流 |
| `ToolArea.tsx`（主窗格底部抽屉） | `run` @`:163-180`，**无任何代次比对** | `:202-206` → `backend.cancelOperation` | ❌ 无裁剪，跨连接混流 |

两者的取消**都只发生在 `ToolDrawer` 内部**（`:107` `:120` `:440`），宿主只是**透传通道**。
这一点决定了修法取向：**权威来源其实已经在 `ToolDrawer` 手里了**，不过是"ref + 手发"，不是"owner + 租约"。

### 3.2 逐路径核账：到底会不会同 id 双发？

先确立一个**结构性事实**：

> **在 `ToolDrawer` 里，任何时刻最多只有一个"非空"的 `runningRef.current`**，
> 因为：(a) `running` 只在 `execute` 中置为 `temporaryId`（`:164`），而 `execute` 有 `if (running) return`（`:142`）；
> (b) `finally`（`:202-204`）与 `setRunning(null)` 是**同一同步块**执行的，React 批处理保证跨渲染不会留下
> "`runningRef` 还是旧 id 但 UI 已空"的中间态被另一次触发看到；
> (c) 同一个 id 只能被"取消一次"，因为第一次取消后 `runningRef` 在同一个 tick 内被置 `null`。

在此基础上逐路径核实（**用户要求：不给理论风险，只给可达路径**）：

| # | 路径 | 触发点 | 实际发出的 `cancel_operation` | 结论 |
| --- | --- | --- | --- | --- |
| P1 | **显式取消**（按钮 `:439-444`） | `props.onCancel(running)` | 恰好 1 次。`:440` 不 `setRunning(null)`，`:202-204` 的 `finally` 要等 promise settle 才把 ref 置 null，期间按钮仍可见——**连点两次 = 2 次调用** | ✅ 不会与 P2/P3 叠加（见下）；⚠️ 裸连点重复 |
| P2 | **切连接**（`ToolDrawer:102-115`） | `props.onCancel(operation)` @`:107` | 恰好 1 次（若在跑）。**同一次 React commit 里若 `ToolPanel` 也随之重挂/卸载**，`ToolDrawer` 的实例被销毁、`runningRef` 随实例消失、卸载 effect 读到 `null` → **不会**再发第 2 次 | ✅ **P1 之后切连接**：ref 仍是旧 id（显式取消不动 ref），会**再发 1 次**——但这是"用户已请求取消 + 连接变更再确认一次"，**语义正确**，不是缺陷 |
| P3 | **卸载**（`ToolDrawer:116-123`） | `props.onCancel(operation)` @`:120` | 只要有 P2 走完，这里就是 `null` | ✅ |
| P4 | **`ToolPanel` 卸载但 `ToolDrawer` 不卸载** | — | **不可能**：`ToolDrawer` 是 `ToolPanel` 的直接子节点且无独立 `key`，父卸载必然带走子 | ✅ |
| P5 | **`ToolArea` 与 `ToolPanel` 同时挂载**（有可能：抽屉 + 独立终端页并存） | 各自独立 refs | 两者各自最多 1 次，**id 不同**（各自的 `crypto.randomUUID()`），不是"同一操作被取消两次" | ✅ |
| P6 | **取消 id 前缀误伤** | `runner.rs:244-251` `operation_id == id \|\| operation_id.starts_with("{id}:")` | `temporaryId`/`result.operationId` 是完整 UUID，不以":子步"结尾，**不存在"取消 A 顺带取消 B"** | ✅ |
| P7 | **`onCancel` 从 id 直发"改为 owner 代发"**（假想的迁移） | — | **这才是真正的双发来源**：`ToolDrawer` 的两处手发若不删，owner 再发一次 → 2 次 | ❌ **正是立项书说的风险，但它只在"做迁移时忘了删手发"的情况下出现** |

### 3.3 结论（对应任务问题 2）

> **现状没有实际的重复取消风险。** 用户要求核实的三条路径（切连接/卸载/显式取消）**会各发一次，且互斥**：
> 唯一的理论重叠是 P1→P2 的"取消 + 连接变更"，那是两次语义不同的请求，Rust 侧 `runner.cancel` 对已结束 id
> 直接 `matched_operations: 0`（`runner.rs:242-251`），只是**多一次无害 IPC**。
> 立项书里"迁过去会双路取消"的风险，是**迁移动作本身引入的**，不是现状的缺陷。
>
> **推论：RUI-07 的"取消只发一次"验收项，作为"改造验收"已经没有标的。**（§9.2 会把它改写成**回归防线**。）

### 3.4 若仍想动：最小修法是什么？（不引入 lease）

只有三处值得改，都是"减少歧义"而非"修复 bug"：

1. **消解 `temporaryId` → `result.operationId` 的 id 切换**（`:162/:169`）。
   这其实是**唯一一处真正的语义隐患**：`temporaryId` 与后端生成的 id **相同**（§4 已验证），
   但代码"假装它们可能不同"，于是有了"`setRunning` 两次、事件过滤可能空窗、取消可能打到不存在的 id"三个悬空。
   若 A1（显式传 id）成立，就把 `setRunning(result.operationId)` 与临时 id **合并成同一个值**。
2. **给取消加 per-id 去重**：在 `ToolDrawer` 用一个 `cancelledRef = useRef(new Set<string>())`，
   `requestCancel(id)` 内 `if (cancelled.has(id)) return; cancelled.add(id); props.onCancel(id);`，
   在 `execute` 开头清空。**8 行**，断言可写成"连点取消按钮 3 次 → `cancelOperation` 只 1 次"。
3. **显式取消后立刻 `setRunning(null)`**（`:440` 附近）：UI 立刻进入"可再跑"状态，
   同时天然关闭 P1 的连点窗口。

> **但这三条的收益是"减少悬空"，不是"修 bug"。** 我在方案 A+ 里只采纳 1 和（轻量版）2，
> 因为 3 会改变现有交互（取消后立刻可再跑，可能与"等进程真正结束"的用户预期冲突）——**建议不做**。

---

## 4. 问题三：`temporaryId` 契约字段

### 4.1 前端侧行为（`ToolDrawer.tsx:162-181`）

```ts
const temporaryId = crypto.randomUUID();   // :162
setRunning(temporaryId);                   // :164
const result = await props.onRun(raw, temporaryId);  // :166 → ToolPanel:88 backend.runP4({ operationId: temporaryId })
...
setRunning(result.operationId);            // :169
```

即：**前端自带 id → 后端 → 后端把 id 原样还给前端**，前端在两处 `setRunning` 之间做了一次"身份切换"。

### 4.2 Rust 侧核实：纯回显

| 位置 | 代码 | 性质 |
| --- | --- | --- |
| `domain.rs:119-135` | `pub operation_id: Option<String>` | 可选字段（`Option`），**没有必填约束** |
| `runner.rs:372-376` | `let id = request.operation_id.clone().unwrap_or_else(\|\| Uuid::new_v4().to_string()); request.operation_id = Some(id.clone());` | **缺省时生成**；给出时**原样采用** |
| `runner.rs:429-433` | 同上（`run_with_mutation_guard_and_input`） | 纯回显 |
| `runner.rs:468-503` | `operation_id` 取自 `request`，用于 `journal.start` / `operations.insert` / 事件 id | **只作键**，不做比较 |
| `runner.rs:756-779` | `log_entry.operation_id` / `diagnostic_alert.operationId` | **纯回填** |
| `runner.rs:791-796` | `OperationResult { operation_id, .. }` | **纯回填**——这正是 `result.operationId === temporaryId` 的机制 |
| `commands.rs:1222-1237` | `run_p4` 只做 context 校验 + 命令黑名单，**从不读 `operation_id`** | 无校验 |
| `commands.rs:1292` | `cancel_operation`：`operation_id.trim().is_empty() \|\| len > 256` → `unknown` | **唯一约束：非空、≤256**，**无相等比较** |

**与两类先例对照（沿用 RUI-06 §3.2 的框架）：**

| 先例 | 语义 | 本次字段属于 |
| --- | --- | --- |
| `changelist_service`：`operation_id` 存进缓存键并重写、返回前赋回 | **纯回填** | ← **`P4CommandRequest.operation_id` 属于这一类** |
| `connection_setup_service:66`：`PartialEq for SpecTarget` / `:412` 票据相等比较 | **相等比较**（"你确认的东西没变"） | 不适用：`runner` 从不持有并比较"上一次的 id" |

> **结论（对应任务问题 3）：`temporaryId` 是纯回显，没有参与任何比较。**
> 前端那次 `setRunning(result.operationId)` 因此**是恒等的空操作**（除非后端返回空，而 `runner.rs:376` 保证了非空）。
> **契约无需改动。** 建议：加一条契约测试把"回显恒等"钉住（方案 A+ 的 A4），
> 防止未来有人把 `runP4` 改成"后端生成 id、前端丢弃临时 id"从而破坏事件过滤。

### 4.3 但"传自己的 id"另一个副作用需要被写下来

`operationId` 同时是 **journal 的键**（`runner.rs:493-499`）与 **`token_for_operation` 的前缀父**（`:347-355`）。
当前 `temporaryId` 是裸 UUID，两种语义都没问题。**但这意味着"客户端自造 id"是一项真实契约**：
A1（用 `lease.operationId` 取代 `crypto.randomUUID()`）落地时，mint 出来的 id **必须继续是裸 UUID、无前缀、无冒号**
（`session.ts:66` 与 `pagedSession.ts:57` 都满足），否则会改变 `token_for_operation` 的父子推导。

---

## 5. 问题四：`generation`（`ToolPanel:51`）到底在防什么？

### 5.1 它的四处出现与职责

| 行 | 代码 | 职责 |
| --- | --- | --- |
| `:51` | `const generation = useRef(0)` | 计数器 |
| `:62` | `generation.current += 1`，effect 依赖 `[connectionKey]` | **唯一自增点**：只在 `connectionKey` 变化时 |
| `:85` | `const requestGeneration = generation.current` | 在 `run()` 里取快照 |
| `:97` | `if (requestGeneration !== generation.current) throw` | 迟到响应 → 抛出定制的错误文案 |

```ts
if (requestGeneration !== generation.current)
  throw new Error("Connection changed while the Terminal command was running.");
```

### 5.2 它防的是"连接切换后的迟到响应"吗？—— **是，而且不止。**

任务书的假设是"`generation` == owner 的 `invalidate` 语义"。**核实后：两者方向一致但强度不同。**

**它比 `invalidate` 多做的两件事：**

1. **它能穿透子组件的 effect 依赖。** `ToolDrawer` 的连接变更 effect（`:102-115`）依赖 `[props.connectionKey]`。
   但 `Props` 里**没有**列出 `connectionKey` 会成为 `useCallback` 的依赖——`run` 的依赖是 `[context]`（`:104`）。
   更关键的是：`generation` 的比对发生在 **`run()` 返回之后**（宿主组件的作用域里），
   而 `terminalGeneration` 的比对发生在 **`execute()` 的作用域里**。
   两者是**不同组件、不同闭包**，`ToolPanel` → `ToolDrawer` 的 `await` 链上跨越了一次 props 传递。
   **`generation` 是唯一能在这条链上"看见"连接已变的人**——因为 `ToolDrawer` 可能先于它的 effect 被渲染，
   而 `generation` 的比对用的是"组件自身的 ref"，**不依赖 React 调度时序**。
2. **它把"废弃"变成"可呈现的错误"。** `invalidate` 只返回 `false`（`session.ts:132-135` 无返回值），
   调用方必须自己决定"静默丢弃"还是"报错"。`generation` 的 `throw` 把决定权**放在了正确的位置**：
   `ToolDrawer:183-201` 的 `catch` 分支里 `if (generation !== terminalGeneration.current) return;` 会**先返回**，
   所以这条错误**永远不会被渲染**，但它是**给日志/未来的错误上报留的唯一钩子**。

**它不做、而 `invalidate` 会做的两件事：**

1. **不取消后端。** 它只让前端不写状态；`cancel_operation` 由 `ToolDrawer:107` 独立发出。
2. **不记录 epoch。** 它没有"当前 epoch 是多少"的公开读法，无法让"新一次 `run()`"知道"我是在新 epoch 上启动的"
   —— 不过它也不需要：`:85` 在 `run()` 开头取快照，天然就是"新 epoch 上启动"。

### 5.3 判定：目标一致但**不能等价替换**

| 维度 | `generation`（现状） | `session` 租约（拟替换） |
| --- | --- | --- |
| 判"迟到响应" | ✅ 跨组件、时序无关 | ✅ 但需 `isCurrent(lease)` 且 lease 必须在**同一组件作用域**持有 |
| 取消后端 | ❌（另由 `ToolDrawer:107` 发） | ✅ 自动（`session.ts:85-94`） |
| 报错文案 | ✅ 定制文案 | ⚠️ 需自己 `throw`，否则静默 |
| 作用域 | **宿主（`ToolPanel`）** | 要放在 **`ToolDrawer`**（因为 id 在那生成）、但 `invalidate` 要在**宿主**（因为连接变更在那）→ **必须跨组件传 owner** |
| 既有测试 | `ToolsDiagnostics.test.tsx:698-721` 断言**两条**返回路径 | 改写后仍需两条 |

> **结论（对应任务问题 4）：`generation` 防的**不只**是"连接切换后的迟到响应"，还有"跨组件边界 + 不依赖 React 调度时序的废弃通知"。**
> 它与 `invalidate` **目标同向、实现不重叠**。把它等效替换为租约需要：
> (a) 在 `ToolPanel` 造 owner，(b) 把 owner 传进 `ToolDrawer`，(c) 在 `execute` 里 `start` + `isCurrent` +
> `finally` 里 `finish`，(d) 删掉 `generation` 与 `terminalGeneration` 两套判据，(e) 保留定制文案。
> 这是 **7 个成对改写点**（见 §8.2 的估算假设），换来的能力增加 = **"取消后端"这一项，而它已经由 `:107` 做到了**。
>
> **净收益为负（或为零）。不推荐。**

### 5.4 那 `generation` 真的没有问题吗？—— 有一个**真实缺陷**，但修法不是 owner

**:97 的比对在 `ToolPanel` 里，`catch` 在 `ToolDrawer` 里，中间的 `ToolPanel.run` 用 `throw` 传递"已废弃"这个信息。**
后果：`ToolPanel.run` 抛出的错误会先经过 `ToolDrawer:182` 的 `catch`，
而该 `catch` 的分支判定（`:185` `controlled`）与 `:189` 的 `rememberHistory(raw)` 在 **`:183` 的守卫之后**，
所以行为是对的 —— **但依赖了一个隐式约定**："任何来自宿主的错误都必须先被 `terminalGeneration` 判掉"。
例：若将来有人在 `ToolPanel.run` 里加一个新的 `throw` 而忘记同步 `terminalGeneration`，
历史记录会被错误地写入（`:189` 只在 `generation === terminalGeneration` 时走到）。

这是一个**注释级/结构级**问题（A+ 用"让废弃表现为一个带标记的返回而不是裸 `throw`"来消解，见 §7 A2），
**不需要 owner**。

---

## 6. 真问题清单（按"是否值得动"排序）

> 这是本次调研最有价值的部分：**立项书列的问题里，有两个是真问题但不是它说的成因；有一个真问题它根本没说。**

| ID | 问题 | 严重度 | 是否在 RUI-07 立项范围内 | 建议 |
| --- | --- | --- | --- | --- |
| **G1** | `ToolArea` / `ToolPanel` 的**事件消费不按连接裁剪**：`ToolDrawer:124-136` 按 `operationId` 过滤，跨连接残留事件（`:72-74` 的事件数组）可把**旧连接**的输出注入**新连接**的终端回显 | **中**（用户可见的串台） | ❌ 未提 | **做**（A5，10 行） |
| **G2** | `temporaryId` → `result.operationId` 的 id 切换制造"两次 setRunning / 事件空窗 / 取消打到不确定 id"的悬空 | 低（恒等空操作，无实际 bug） | ⚠️ 提了但判错方向 | **做**（A1，5 行） |
| **G3** | 显式取消按钮裸连点 → 重复 `cancel_operation` | 低（Rust 侧幂等） | ✅ 就是这个 | **做轻量版**（A4，8 行） |
| **G4** | `stop()` 抛异常会阻断 `live=false` 之后的 effect cleanup 链 | 极低 | ✅ 擦边 | 仅讨论，不做 |
| **G5** | 宿主 `ToolPanel.run` 用 `throw` 表达"已废弃"，与 `ToolDrawer` 的 4 处 `terminalGeneration` 守卫形成隐式约定 | 低（维护性） | 擦边 | **做**（A2，注释 + 一处类型收窄） |
| ~~G6~~ | ~~终端取消双路~~ | **不存在** | ✅ 主要立项理由 | **不做，记录现状**（§3.3） |
| ~~G7~~ | ~~订阅需要新原语~~ | **不需要** | ✅ 立项理由 | **不做，记录现状**（§2.3） |

---

## 7. 候选方案

### 方案 A+：**最小改动 + 收窄范围**（推荐）

零新增原语、零 `src-tauri` 改动、零 owner 语义改动。5 个改动点：

#### A1（G2）— 消解 id 切换

```ts
// ToolDrawer.tsx:138-181（示意，非最终实现）
const requestId = crypto.randomUUID();     // 原 temporaryId
setRunning(requestId);
try {
  const result = await props.onRun(raw, requestId);
  if (generation !== terminalGeneration.current) return;
  if (!decision.sensitive) rememberHistory(raw);
  // 后端回显恒等（runner.rs:376）；保持 setRunning 但不做"身份切换"，
  // 并加一条断言式注释指向契约测试。
  setRunning(result.operationId);
  ...
```

> 严格说这**没有删掉那行**，而是把"temporaryId 是临时临时 id"的措辞改掉、并在注释里钉住契约。
> 若 A4 的契约测试落地，可进一步把 `setRunning(result.operationId)` 改为 `setRunning(requestId)`（语义等价、更诚实）。

**影响面**：1 文件 / 1 处 + 1 条测试。**风险**：无（行为完全不变）。

#### A2（G5）— 把"废弃"从裸 `throw` 变成显式信号

```ts
// ToolPanel.tsx:83-105
const run = useCallback(async (input, operationId) => {
  const requestGeneration = generation.current;
  ...
  if (requestGeneration !== generation.current)
    throw new SupersededByConnection("Connection changed while the Terminal command was running.");
  ...
});
```

`SupersededByConnection` 由 `ToolDrawer:182` 的 `catch` **优先识别**（`instanceof`），保证它永不写历史、永不渲染。

**影响面**：2 文件 / 3 处（定义、抛出、捕获顺序）。**风险**：低（需保持与 `terminalGeneration` 守卫的先后不变）。

#### A3（G1，**本次最有料的一条**）— 事件按连接裁剪

```ts
// ToolDrawer.tsx:124-136
useEffect(() => {
  if (!running) return;
  const matching = props.operationEvents.filter(
    (event) =>
      event.operationId === running &&
      event.connectionKey === props.connectionKey &&   // ← 新增
      [...].includes(event.type),
  );
  ...
}, [props.operationEvents, running, props.connectionKey]);
```

**前置核实项（必须在实现前确认，本文未能在只读范围内证死）**：
`OperationEvent`（`domain.rs:153-160`）**没有** connection 字段。可选做法：

- **(a)** 在宿主侧 `ToolPanel:61-66` / `ToolArea:79-87` 的 `connectionKey` effect 里把 `events` 清空
  ——**已有 `setEvents([])`，所以旧事件被清掉了**。⇒ **G1 的严重度需要重估**：
  在"连接变更"路径上，宿主已清空事件数组，串台的**残留窗口**仅存在于
  "**旧事件尚未到达、连接已变**"（in-flight 事件在清空之后才到达）。
- **(b)** 用 `performance` 无关的方案：`ToolDrawer` 内部维护 `eventEpoch`，在连接变更 effect 里自增并只消费新 epoch 的事件。
- **(c)** 后端在 `OperationEvent` 上加 `connectionId`（**`src-tauri` 改动，建议不做**）。

> **诚实结论：G1 是"有残留窗口的中等级缺陷，不是设计缺陷"，且已有 70% 的缓解（宿主清空）。**
> A3 的最省做法是 **(b)**：在 `ToolDrawer` 的 `:163`（`streamedCount.current = 0` 处）同时记录
> `eventBaseline.current = props.operationEvents.length`，只消费该下标之后的事件。
> **但这会与 `:126-135` 的 `filter` + `slice` 逻辑冲突**，需要重写为"按 id 打标"。
> **建议：A3 标为"应在实现前跑一次复现"，若复现不了就不做。** 这是本方案里唯一有条件项。

#### A4（G3 + §4）— 取消去重 + 契约测试

```ts
const cancelled = useRef(new Set<string>());
function requestCancel(id: string) {
  if (cancelled.current.has(id)) return;
  cancelled.current.add(id);
  if (id === temporaryId) setRunning(null);   // 立刻进入可再跑状态（可选）
  props.onCancel(id);
}
```

**影响面**：1 文件 / 3 调用点改写（`:107` `:120` `:440`）+ 2 条测试。
**契约测试**（新增 `ToolDrawer.contract.test.tsx` 或并入 `ToolsDiagnostics.test.tsx`）：
断言 `backend.runP4` 收到的 `operationId` 与 `result.operationId` **相同**，且 `runP4` 只被调用一次。

#### A5 — 记录（不改代码）：**决策记录块**

在 `session.ts` 顶部与 `ToolPanel.tsx:68` 各加一段注释，写清"为什么订阅不进 operationSession"与
"为什么 `generation` 不是租约的替代品"。**这是本方案里唯一"零风险、高信息量"的产出。**

> **RUI-06 的同类先例支持这一点**：`pagedSession.ts:10-15` 的注释明确写了"*Rather than bending the owner's
> judgement (which eight pages depend on), this layer keeps one channel per request*"。
> **"为什么不做"被写进代码**，是 RUI-06 能一次收敛两个页面的根本原因。RUI-07 应该照做。

### 方案 B：引入 `OperationSessionRegistry`（全仓取消收口）——**不推荐**

起草 API 如下（**仅作对照，不建议实现**）：

```ts
// src/shared/operationSession/registry.ts —— 新增文件
export class OperationSessionRegistry {
  constructor(options: { cancelOperation: CancelOperation });
  /** 宿主组件取一个 scoped owner；同一 app 下共享一个 cancelOperation 通道。 */
  ownerFor(scope: string): OperationSessionOwner;
  /** 组件的每个 cancel 来源都走这里：同 id 只发一次（全仓级幂等）。 */
  cancelOnce(operationId: string): void;
  /** 退场：所有 scope 的 owner cancelAll。 */
  disposeAll(): void;
}
```

**它能解决的东西**：把全仓 **28 个文件、约 40 处** `backend.cancelOperation(` 直调
（`grep -rn "backend.cancelOperation(" src/features` 的结果，抽样确认计数）收口到一个出口，
使 RUI-06 §13.1 的脚本门禁（"`src/features/**` 下次数 = 0"）成为可能。
**这不是"完全没用"** —— 它确实能让"取消出处可枚举"。

**不推荐的理由**（逐条）：

1. **它是横向的、跨 10+ 个功能域的改动，却挂在 P2 的 RUI-07 名下。** 受影响面包括
   `features/browsers/**`（StreamSwitchDialog、BranchMappingMutationDialog、StreamGraphPage）、
   `features/changelists/**`（SubmitDialog、UnshelveDialog、ShelfDialog、PendingPage、MoveFilesDialog）等
   —— 这些页面**刚刚在 RUI-03/RUI-06 里迁移过**，再动会与它们的回归基线冲突。
2. **它把"取消"从一个"局部实现细节"升格为"全局服务"。** 与 RUI-06 的裁决准则冲突：
   **判据复杂度不换概念数量**。`cancelOnce` 是新的全局不变量，需要为 23 个调用点补回归。
3. **收益不成立**（§3.3、§3.4 已证）：当前**没有**重复取消的 bug；收口只能防"未来有人手滑"。
   为"防未来手滑"引入全局服务，是**用接口换纪律**——RUI-06 §13.1 的做法（脚本门禁）更便宜。
4. **它会诱导 §3.2 P7 的那个风险**：把 `ToolDrawer` 的手发接到 registry 上而不删干净，**才是**双发的真正来源。

> **更便宜的替代**：若目标是"全仓无直调"，用 `grep` 门禁 + **按功能域分批**（每次一个域），
> 各自的 PR 归各自的团队评审。**不要挂在 RUI-07。**

### 方案 C：引入 `SubscriptionScope` 原语 ——**不推荐**

```ts
// src/shared/operationSession/subscription.ts —— 新增文件
export interface SubscriptionScopeOptions {
  /** 事件过滤器：不匹配的事件不进入作用域。 */
  accept(event: OperationEvent): boolean;
}
export interface SubscriptionScope {
  readonly channel: string;
  /** 进入作用域：之后的事件才会被计数/转交。 */
  activate(): void;
  /** 退出作用域：之后的事件被丢弃，回调不会被调用。 */
  retire(): void;
  /** 关掉底层的 listen()；卸载时唯一需要调的地方。 */
  dispose(): void;
}
export function openSubscription(...): SubscriptionScope;
```

**不推荐的理由**：

1. **它要建模的东西不存在。** §2.2 已证：无 id、无完成点、无取消语义。
   `activate/retire/dispose` 三个方法里，后两个在现有 4 行 hook 里各自是 `live=false` 和 `stop()`。
2. **它会掩盖真正的问题 G1。** `SubscriptionScope` 只解决"作用域内外的丢弃"，
   而 G1 的成因是"**作用域内**混入了别的连接的事件"—— 新原语对此无能为力，
   却会让人以为"订阅这块已经收口了"。
3. **它会成为第 4 个生命周期概念**（owner / PagedChain / SubscriptionScope / 各页的 ref），
   与 RUI-06 的裁决精神背道而驰。
4. **它没有可测的新能力。** 无法写出"用旧代码会失败的测试"。**一个写出不出来的测试的新原语，就是不该有的原语。**

---

## 8. 推荐方案与改动量估算

### 8.1 推荐：**方案 A+（收窄版）**

| 改动 | 文件 | 行数（净） | 是否必做 |
| --- | --- | --- | --- |
| A1 id 语义澄清 + 契约测试 | `ToolDrawer.tsx` + 新测试 | ~5 / +40 | ✅ |
| A2 `SupersededByConnection` | `ToolPanel.tsx` + `ToolDrawer.tsx` | ~3 / ~6 | ⚠️ 可选 |
| A3 事件按连接裁剪 | `ToolDrawer.tsx` | ~6 | ⚠️ **先复现再决定** |
| A4 取消去重 | `ToolDrawer.tsx` + 测试 | ~8 / +30 | ✅ |
| A5 决策记录注释 | `session.ts` 顶部 + `ToolPanel.tsx:68` | ~10（纯注释） | ✅ |
| — | **合计** | **约 45 行代码/注释 + 约 70 行测试** | |

### 8.2 估算的假设（RUI-06 的教训：写清假设，不只给行数）

| 假设 | 依据 | 若假设不成立的后果 |
| --- | --- | --- |
| 「成对改写点」共 **3 处**（`:107` `:120` `:440` → `requestCancel`） | `grep terminalGeneration` = 7 处，其中 3 处是 `props.onCancel(` 调用点 | 若去掉 A4 则降为 0 处 |
| 既有测试会挂的只有 **2 条**（`ToolsDiagnostics.test.tsx:662`、`:724`），因为它们是**唯一**断言 `cancelOperation` 的终端用例 | `grep cancelOperation ToolsDiagnostics.test.tsx` = 2 处断言 | 若有更多断言，A4 需按"断言改成 `toHaveBeenCalledTimes(1)`"逐条改 |
| 若走方案 B（registry），工作量为"28 文件 × 平均 2 行 + 每文件 1 条回归"≈ **28 个 PR-级别改动点** | `grep "backend.cancelOperation(" src/features` | 这正是不推荐它的量化依据 |
| `ToolArea` 与 `ToolPanel` **可能同时挂载** | `ToolArea.tsx:37-40`（主窗格底部抽屉）+ `PageRenderer.tsx:345-360`（独立终端页）互不排他 | 若实际互斥，P5 风险归零，但 A4 的去重仍应做（防连点） |

### 8.3 不推荐方案及放弃理由（汇总）

| 方案 | 一句话放弃理由 |
| --- | --- |
| B `OperationSessionRegistry` | 横向动 28 个文件去防一个**不存在**的 bug；且会诱导出真正的双发。 |
| C `SubscriptionScope` | 给一个**没有取消语义**的对象造生命周期原语；写不出会失败的测试。 |
| D（隐含：把 `generation` 换租约） | 需要跨组件传 owner、7 个成对改写点，净能力增加为 0（取消已由 `:107` 完成）。 |

---

## 9. 验收标准（可执行）

### 9.1 若执行方案 A+

```
1) R-1 取消不过度：ToolDrawer 内 3 个取消入口都走 requestCancel
   grep -n "props.onCancel(" src/features/tools/components/ToolDrawer.tsx   → 仅剩 requestCancel 内部 1 处

2) R-2 取消只发一次（连点）
   用例：execute("info") 挂起 → 点击取消按钮 3 次 → expect(backend.cancelOperation).toHaveBeenCalledTimes(1)

3) R-3 取消只发一次（路径叠加）
   用例：execute 挂起 → 点击取消 → connectionKey 改变（父级重渲染，非重挂）
        → expect(backend.cancelOperation.mock.calls.length) 增量 ≤ 1（来自 :107 的语义确认）
   [注：按 §3.2 P1+P2，这里是 2 次且**语义正确**；断言应精确写成 calls.length === 2，并配注释说明原因]

4) R-4 id 回显恒等
   用例：expect(backend.runP4.mock.calls[0][0].operationId).toBe(resolvedResult.operationId)
        expect(backend.runP4).toHaveBeenCalledTimes(1)         // 无重试、无二次派发

5) R-5 订阅干净卸载（现状即满足，作为回归防线）
   用例：挂载 ToolPanel → unmount → expect(unlistenSpy).toHaveBeenCalledTimes(1)
        expect(backend.subscribeOperationEvents 返回的 stop) 被调用

6) R-6 无新增概念
   git diff --stat 中 src/shared/operationSession/ 只允许注释改动（session.ts, pagedSession.ts 的代码行数不变）
   ls src/shared/operationSession/ 不出现 subscription.ts / registry.ts

7) R-7 src-tauri 零改动
   git diff --stat src-tauri/   → 空
```

### 9.2 若 LEAD 决定"保持现状"（**本文的最保守落点**）

那么 RUI-07 的验收标准应当**从"改造完成"改为"现状已达标 + 记录"**：

```
8) S-1 现状达标证明：§3.2 的 P1~P6 每一条都写成一条测试
   （P2/P3 已有：ToolsDiagnostics.test.tsx:662、:724；P1 连点需新增；P4/P5/P6 不需要，属结构性保证）

9) S-2 决策记录落地：session.ts / ToolPanel.tsx 的注释块存在，内容包含
   "订阅无 id、无完成点 ⇒ 不进 owner" 与 "generation 防的是跨组件废弃通知，不是租约替代"

10) S-3 把 PM 上 RUI-07 的描述改写（§9.3）
```

### 9.3 **最重要的验收项：改任务描述本身**

PM 的 RUI-07 描述（`ForAIDoc/PM/Windows本机私用TODO.md:124`）写着：

> ① `subscribeOperationEvents` 是长驻订阅、无完成点，**lease 永远无法 finish，硬套 owner 会让租约永久占住 channel**；
> ② 终端执行的代次在 ToolDrawer（terminalGeneration）且**取消已由其手发**，**迁过去会双路取消**；
> ③ temporaryId 是发给 runP4 的契约字段。

其中 ① 是**正确的**（正是本文 §2.2 的理由，但它的结论应该是"所以不进 owner"而非"所以需要新原语"）；
② 是**混淆的**："取消由其手发"是**现状正确**，不是缺陷；"迁过去会双路取消"是**迁移风险**，不是现状风险；
③ 是**正确的但无害**（§4）。

> **建议改写为**：「RUI-07＝**工具面板会话现状的决策记录 + 两处收窄**：
> (a) 确认订阅不进 operationSession（无 id/无完成点，现有 `live`+`subscribeSafely` 已完备）；
> (b) 确认终端取消已是单路权威（`ToolDrawer` 三入口 → 宿主透传），**不改**为 lease；
> (c) 修 incidental：`temporaryId` 回显契约钉住、取消按钮连点去重；
> (d) 视复现结果决定是否修事件跨连接串台。」
>
> **这与 RUI-06 的流程教训完全一致**（"任务描述写错就改任务，不让设计迁就任务"）。

---

## 10. 遗留问题 / 待确认（交 LEAD）

| # | 问题 | 需要谁 |
| --- | --- | --- |
| Q1 | G1（事件跨连接串台）**能否在真实 UI 复现**？我可提供的复现路径：打开终端 → 跑一条长命令 → 在命令执行中切连接 → 观察是否有旧输出混入 | 需要一次**可交互运行**（我无权运行 P4） |
| Q2 | `OperationEvent` 是否值得加 `connectionId`（`src-tauri` 改动）？若 G1 可复现且方案 (b) 太脏，可能需要 | LEAD 裁决 |
| Q3 | RUI-07 究竟是"实现任务"还是"决策记录任务"？**我的建议是后者**，并把 leftover 纳入 RUI-06 式的**分期**（先记录，视复现再修） | LEAD |
| Q4 | 方案 B 的"全仓 28 处 `backend.cancelOperation` 收口"是否**另立 P3 任务**？它有价值但范围独立 | PM |

---

## 11. 附：核账明细（供复核）

### 11.1 `cancel_operation` 的发射点全集

| 发射点 | 触发条件 | 是否受 `runningRef` 守卫 |
| --- | --- | --- |
| `ToolDrawer:107` | `connectionKey` 变化且 `runningRef.current` 非空 | ✅ `if (operation)` |
| `ToolDrawer:120` | 卸载且 `runningRef.current` 非空 | ✅ `if (operation)` |
| `ToolDrawer:440` | 用户点击取消按钮，`running` 非空（渲染条件） | ✅ 由渲染条件 |

**三处，全部经过 `runningRef`/`running` 守卫，且 `runningRef` 在同一 tick 内清空 ⇒ 无叠加。**

### 11.2 Rust 侧对"多一次取消"的容错

```rust
// runner.rs:242-266 cancel(&self, id)
for (operation_id, token) in operations.iter() {
    if operation_id == id || operation_id.starts_with(&prefix) { token.cancel(); matched += 1; }
}
...
pending.insert(id.to_owned(), Instant::now());   // 记下，供将来 begin_operation_group 用
```

- 对已结束的 id：`matched = 0`，返回 `state: "notFound"`（`commands.rs:1305-1309`），**无副作用**。
- `pending_cancellations` 在 `run_inner` 中被消费（`begin_operation_group` / `token_for_operation`）。
  ⚠️ **注意**：`pending` 插入发生在任何 `run_p4` 路径上（不是只有 group），而**消费只在 group 路径**；
  代价是 1024 条上限的 `HashMap`（`runner.rs:255`，60 秒过期），**可忽略**。

### 11.3 现有测试对"取消次数"的覆盖缺口

`grep cancelOperation ToolsDiagnostics.test.tsx` = 2 处（`:702` `:762`），**都是 `toHaveBeenCalledWith`，没有一处 `toHaveBeenCalledTimes`**。
⇒ **当前"取消只发一次"完全没有断言，这正是 RUI-07 验收项"取消只发一次"真正有价值的地方**：
不是修 bug，而是**补上一条本应存在的防线**。

---

**（提案结束）**
