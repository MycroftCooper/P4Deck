# Diff 与冲突合并工具重做：现成方案预研与选型

> 文档编码：UTF-8；日期：2026-10-31；状态：**待方案对齐（本文不含实施，用户已明确"先对方案，别直接开始做"）**
>
> 关联任务：`UI-08`（Resolve 对话框与手工合并工具重做，暂停中）、`UI-08-1`（调研规格）、`CL-03-R01` / `CL-03`（Resolve 验收返工）。
>
> 范围：单文件 **Diff 工具窗口** 与 **P4 resolve 文本内容冲突的手工合并工具**（含 Resolve 主对话框的呈现重做）。不含多文件累加 diff / 文件树、图片语义合并、目录合并、Stream Graph，以及外部 mergetool 的完整管理（仅作为可选增强讨论）。
>
> 证据口径：外部事实以 2026-10-31 的 npm / crates.io / 官方文档快照为准，关键项附一手链接；无法核实的明确标 **【未验证】**。分层调研底稿见文末附录。

---

## 0. 结论速览（TL;DR）

**核心判断：没有能"整套替换"的现成方案，但每一层都有成熟件可复用。**

- **Diff**：展示层可以整套换（`@pierre/diffs` 或 CodeMirror 6），代价是交互/测试重构；算法层继续用已依赖的 Rust `similar` 即可。
- **冲突合并**：**没有可直接嵌入的现成三方合并 UI 组件**——CodeMirror / Monaco 都只有两栏 diff，VS Code 合并编辑器虽 MIT 但与 workbench 强耦合；开源全量合并工具（`git merge-file`、GNU `diff3`、Mergiraf、Kdiff3、Meld、WinMerge）全部 GPL/LGPL，**不能打包**；商业/闭源（P4Merge、Beyond Compare、UGit、P4V）只能外挂调用或借鉴交互，不能内嵌。
  → 可行的"不造轮子"组合是：**Rust 合并引擎（Apache-2.0）+ 编辑器内核（MIT）+ 只重写三方 UI 与 region 模型**。
- **外部工具**：`P4Merge` 可以"检测已安装 + 调用"（P4 用户通常随 P4V 自带），**零许可证风险、零算法成本**，但不能打包、体验割裂，不能替代产品内闭环。

### 0.1 推荐组合（待拍板）

| 层 | Diff 工具 | 冲突合并工具 |
| --- | --- | --- |
| 事实层（权威数据） | 保留：`p4 fstat/print` + 现有 `DiffRequest/DiffResult` 契约 | 保留：`p4 resolve -n -o -ztag` 取权威 base/theirs/yours；**禁止自研 base** |
| 计算层 | 保留：Rust `similar`（可选开 `inline` feature 做词级；或升级 3.x） | 替换：`similar` 3.x `merge::TextMerge`（Apache-2.0，结构化 `MergeRegion`） |
| 渲染/编辑层 | **首选候选 `@pierre/diffs`**（先做 1–2 天 spike；失败回退"保留现有外壳 + Shiki + 词级"） | 重写：**CodeMirror 6** 四栏/三栏编辑器，消费 Rust 下发的结构化 region |
| 语法高亮 | Shiki（默认 JS 正则引擎，无 WASM、无 CDN）或库自带 | CodeMirror Lezer 语言包 + Shiki 主题对齐 |
| 外部工具（可选） | `P4DIFF` 探测（低优先级） | "用 P4Merge 合并"按钮（检测+调用，**不打包**，2–3 人日） |
| 明确不做 | Monaco（101.7 MB unpacked，WebKit 风险）；无虚拟化的 diff 库 | 打包任何 GPL/LGPL 合并件；抽 VS Code merge editor；让 P4 server 生成 merge 作为主路径 |

### 0.2 直接回答"网上有没有现成能用的"

| 问题 | 答案 |
| --- | --- |
| 有没有现成的 **Diff 视图组件**？ | **有**。`@pierre/diffs`（Apache-2.0，GitHub 风格 + 词级 + 折叠 + 虚拟化 + Shiki）最接近"整套替换"；`@codemirror/merge`（MIT）在搜索/键盘/无障碍上最成熟。 |
| 有没有现成的 **三方合并编辑器组件**？ | **没有**。CodeMirror/Monaco 官方均只做两栏 diff；VS Code 的 MIT 源码抽取成本 15–25 人日；其余开源合并工具全是 GPL。 |
| 有没有现成的 **合并算法**？ | **有**。Rust `similar` 3.x `TextMerge`（Apache-2.0）与 `diffy`（MIT/Apache-2.0）都可直接静态链接；不要用 GPL 的 `git merge-file`/`diff3`。 |
| 有没有能"直接白嫖"的专业工具？ | **有，但只能调用不能打包**：P4Merge（随 P4V 免费）、Beyond Compare（用户自购）、Kdiff3/Meld（GPL，用户自装）。P4Deck 可做"检测已安装 + 调用"。 |
| 有没有 P4 官方已经做好的事实层？ | **有**，而且必须复用：`p4 resolve -n -o` 的 base/from、`p4 integrate -Ob` 的 base、官方 `-db/-dw/-dl` 空白口径、`p4 print --offset/--size` 分段。**自己算 P4 base 一定会错**。 |

---

## 1. 背景与现状

### 1.1 用户确认（2026-10-31 对话）

- 痛点六类**全选**：Diff 可读性（无语法高亮/无词级/折叠）、合并编辑器体验（4 个 textarea）、大文件/上限、合并算法质量（含中文重复行误判）、操作能力缺失（多文件/图片/忽略空白/搜索跳转）、稳定性与交互细节（卡顿/滚动不同步/快捷键）。
- 允许**前后端都换**，只需保留 P4 安全语义。
- 先对方案，**不直接实施**。

### 1.2 现有实现盘点（已核对代码）

| 模块 | 位置 | 现状 | 主要缺口 |
| --- | --- | --- | --- |
| Diff 后端 | `src-tauri/src/app/file_service.rs` `diff()`、`domain.rs` `DiffResult` | 自研 `build_unified_diff`（依赖 Rust `similar` 2.7）；`fstat/filelog/print` 取权威元数据与正文；二元/符号链接/超限显式状态；4 MiB 文本 / 100,000 行 / 8 MiB patch 上限；review cache 30s/128 项；operation group 可取消 | 无词级/忽略空白选项；超限即"不可显示"；无分段/懒加载 |
| Diff 前端 | `src/features/browsers/components/DiffView.tsx`（493 行）、`SplitDiff.tsx`（207 行）、`diffRows.ts`（170 行）、`diffNavigation.ts`（71 行） | 虚拟化双栏、hunk 计数与上一/下一、两侧搜索+命中计数、Ctrl+G 跳行、统计、复制/全选/右键菜单/Swarm 链接、EOF 标记；`@tanstack/react-virtual` 渲染 | **只有并排视图**；无语法高亮、无行内词级、无上下文折叠、无忽略空白；替换块按"第 i 个删除对第 i 个新增"硬配对；全量 DOM 行虚拟化（不是编辑器内核） |
| 合并后端 | `src-tauri/src/app/manual_merge.rs`、`workflow_service.rs`、`merge_resolve_action.rs` | 自研行级三方合并（base↔两侧求 hunk → 合并重叠区间 → 输出 `<<<<<<<`/`=======`/`>>>>>>>` 三段标记）；`decode/encode` 支持 UTF-8/UTF-16 BOM/CRLF；`snapshot`/`sha256`/`atomic_replace_with_backup`/`secure_workspace_file`；open/validate/save/resolve 双一次性 token、mutation lane 复检、保存后 SHA-256 复核、显式 `p4 resolve -ay` + unresolved 复核 | 合并引擎无 diff3 的细化/词级；冲突区间只以 marker 文本表达，UI 只能反解；无 region 级结构化事实 |
| 合并前端 | `ResolveDialog.tsx`（871 行）、`ManualMergeEditor.tsx`（590 行） | Resolve 主对话框：逐文件策略（Safe / Yours / Theirs）、blocker、批量安全合并；手工会话：Base/Theirs/Yours 只读 textarea + Result 可编辑 textarea，冲突导航、Accept Yours/Theirs/Both、搜索、撤销重做、未解决计数 | 无语法高亮/行号/词级；无编辑器级搜索/折叠/多光标；无"组合两侧/Accept Combination"；无批量应用非冲突；无显式 Complete/Reset；布局固定四栏、小屏拥挤 |
| 门禁与证据 | `scripts/frontend.perf.tsx`、`tests/browser`、axe、`pnpm ci:*`、Windows localhost E2E | 前端性能门禁（50k 行 <50 ms）、a11y axe、Web 474+ / Rust 184+ 项、localhost 真实 P4 E2E、CSP 已收紧 | 新编辑器/新依赖需要新的性能与 e2e 用例；jsdom 缺少 `ResizeObserver` 等需 mock |

**结论**：P4Deck 在**正确性/安全**维度（权威 base、token CAS、原子保存、resolve 复核）是强项，不应为对齐商业工具而削弱；短板集中在**阅读效率**（词级、语法高亮、忽略空白、折叠）与**编辑器体验**（textarea → 编辑器内核）。

### 1.3 与既有 UI-08 的关系

`UI-08` 拆了 6 个子项（调研规格 → Resolve 主窗体重做 → 行尾/二进制能力核对 → 逐块导航 → 合并工具重做 → 截图对照+用户验收），参考目标是 **P4V 老版 Resolve 窗口** 与 **腾讯 UGit 冲突界面**。本文是 `UI-08-1` 的"技术选型"分支，同时把范围扩到 Diff 工具；**本文不修改工作流状态与 TODO 表**，方案通过后再由工作流拆任务。

补充：**UGit 是腾讯闭源商用客户端，不可复用、不可内嵌**，只能作为交互参照（本机需要截图/录屏来固化规格）；P4V 同理。因此"对齐 UGit/P4V"只能是**设计复刻**，不是"引入组件"。

---

## 2. "不重复造轮子"的复用边界（分层）

| 层 | 现成可用 | 处理建议 |
| --- | --- | --- |
| P4 事实层 | `p4 resolve -n -o -ztag`（权威 base/theirs/yours）、`p4 integrate -Ob`、`p4 print`（`-Q/-B/-L`、`--offset/--size`）、`p4 diff -du/-ds/-db/-dw/-dl` | **全部复用**。P4 的 base 选择是"与 source/target 共同编辑最多的 revision"，与 Git LCA 不同，**自研必错** |
| 行级 diff 计算 | Rust `similar`（项目已依赖） | **保留**。需要词级时可开 `inline` feature（2.7 已支持）或升级 3.x |
| 合并算法 | `similar` 3.x `merge::TextMerge`（结构化 region）、`diffy::merge`（marker 文本） | **引入替换自研 hunk 合并**；两者均为宽松许可，可静态链接 |
| 语法高亮 | Shiki（默认 JS 正则引擎，无 WASM/CDN）、Lezer（CodeMirror） | **引入**（随渲染方案）。不要引入 WASM 后端以免改 CSP |
| 词级/字符级 | `similar` inline、`@pierre/diffs` `lineDiffType`、CodeMirror `presentableDiff`、`diff-match-patch` | **引入**，不自己写 |
| 虚拟化 | 现有 `@tanstack/react-virtual`；`@pierre/diffs` `CodeView`；CodeMirror viewport 渲染 | 随方案保留/替换，不自己造滚动回收 |
| 三方合并 UI | **无现成可嵌入组件** | 自建（CodeMirror 组合）或外挂工具 |
| 外部工具接入 | P4Merge（检测+调用）、`P4MERGE`/`P4DIFF` 机制 | 可选增强；**只调用，不打包** |
| 编辑器内核 | CodeMirror 6（MIT）、Monaco（MIT 但体积否决） | 用 CodeMirror 6 |

**不引入清单**：GPL/LGPL 合并二进制（`git merge-file`、GNU `diff3`、Mergiraf、Kdiff3、Meld、WinMerge、`threeway_merge` 的 xdiff 静态链接版）；VS Code merge editor 抽取；Monaco；任何运行时 CDN 资源。

---

## 3. Diff 工具重做

### 3.1 候选事实表（前端展示层）

| 库 | 最新版本 | 许可 | 虚拟化 | 词级 | 高亮 | 折叠 | 搜索 | 统一/并排 | React 19 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `@pierre/diffs` | 1.6.2 | Apache-2.0 | ✅ CodeView | ✅ `lineDiffType` | ✅ Shiki（JS 引擎） | ✅ hunk 分隔器 + 展开 | ❌（需在 shadow DOM 自建） | ✅ split / unified | ✅ 官方 | **首选候选（需 spike）** |
| `@codemirror/merge` | 6.12.3 | MIT | ✅ viewport | ✅ `presentableDiff`/`highlightChanges` | ✅ Lezer 语言包 | ✅ `collapseUnchanged` | ✅ `@codemirror/search` | ✅ MergeView / unifiedMergeView | 需自写 wrapper | **备选（搜索/键盘/a11y 最强）** |
| `monaco-editor` | 0.57.0 | MIT | ⚠️ 视口渲染 | ✅ | ✅ 全量内置 | ✅ | ✅ | ✅ DiffEditor | 需自写 wrapper | **不推荐**（unpacked 101.7 MB + WKWebView 风险） |
| `react-diff-view` | 3.3.3 | MIT | ❌ | ✅ `markEdits` | ⚠️ 自接 refractor | ⚠️ 需 raw source | ❌ | ✅ | ✅ | 不推荐（大 diff 渲染慢，README 自测 2.2 MB/26 s） |
| `react-diff-viewer-continued` | 4.4.0 | MIT | ❌ | ✅ | ⚠️ 自接 | ✅ `showDiffOnly` | ❌ | ✅ | ✅ | 不推荐（无虚拟化） |
| `@git-diff-view/react` | 0.1.8 | MIT | ❌ | ✅ FastDiff | ✅ highlight.js | ❌ | ❌ | ✅ | ✅ | 备选观察（无折叠/无虚拟滚动） |
| `diff2html` | 3.4.56 | MIT | ❌ | ❌ | ⚠️ 可选 | ❌ | ❌ | ✅ | 无 React 组件 | 不推荐（只适合导出 HTML） |
| 现有自研渲染 | — | 自有 | ✅ react-virtual | ❌ | ❌ | ❌ | ✅ | ❌ 仅并排 | ✅ | 可增强或替换 |

> 版本/许可取自 2026-10-31 npm registry；体积与活跃度明细见附录底稿。`@pierre/diffs` 为 2025 年底起的 1.x 新库，迭代快但也意味着**维护/兼容风险高于 CodeMirror**。

### 3.2 三个方案

**方案 D1（首选候选）：`@pierre/diffs` 渲染 + Rust 现有计算**

- 接入零 wire 契约改动：`leftText/rightText` 都有时用 `parseDiffFromFile`（可展开上下文），否则用 `parsePatchFiles(unified)`（partial 模式）；`truncated/partial` 控制是否允许展开。
- 得到：split/unified 切换、行内词级、hunk 分隔器+折叠、Shiki 高亮、行选择、CodeView 虚拟化、annotation/gutter 扩展点。
- 需要重写：搜索（在 `onPostRender` 的 shadowRoot 上建行文本索引）、上一/下一 hunk（`expandHunk` + 滚动）、右键菜单/复制（`composedPath()` 取行信息后接现有 ContextMenu/copy）、`DiffView` 测试（Shadow DOM 下 RTL 查询失效，需 `host.shadowRoot` 或 Playwright）。
- 风险：Shadow DOM 下浏览器查找/选择复制/原生右键在 WebView2 与 WKWebView 的行为 **【未验证】**；a11y 无官方说明；包体需实测；WebKit 有已知滚动 bug（官方提供 workaround）。
- 工作量：3–5 人日（含 e2e/a11y 回归）。

**方案 D2（低风险回退）：保留现有外壳，只补 P0 能力**

- Rust：`similar` 开 `inline` feature 输出每对删/增行的词级 span（契约加可选 `hunks/spans`，向后兼容）；或前端用 `diff-match-patch` 对配对行做词级。
- 前端：给 `SplitDiff` 换渲染内核——Shiki core（只注册常用语言/主题，JS 引擎）+ 结构化 spans + 上下文折叠（用现有 `leftText/rightText` 重建省略行）+ 统一视图切换 + 忽略空白归一化开关。
- 保留：虚拟化、搜索、hunk 导航、复制/右键、现有测试。
- 工作量：2–4 人日，风险最低；但"现代感"和折叠/大文件体验不如整套库。

**方案 D3（共用编辑器栈）：`@codemirror/merge`**

- 只读 `MergeView`（并排）或 `unifiedMergeView`（单栏）；内置搜索、`goToNextChunk/goToPreviousChunk`、`collapseUnchanged`、a11y、键盘。
- 代价：必须左右全文（当前 `leftText/rightText` 在 truncated 时缺失，需要 Rust 尽量给文本或降级）；两个编辑器实例内存翻倍；需自写 React 生命周期封装；`scanLimit/timeout`（默认 500）超限会退化为不精确 diff，需调参实测。官方已修复过"大文件导致标签页卡死"的默认限制回归（[codemirror/dev#1382](https://github.com/codemirror/dev/issues/1382)），但大文件仍需实测。
- 若合并工具也选 CodeMirror 6，D3 可复用同一编辑器栈/主题/语言包。
- 工作量：3–4 人日 + 测试改造。

### 3.3 推荐（带 spike 门）

1. **先做 1–2 天可丢弃 spike**（在现有分支外的试验代码里，不合并）：验证 `@pierre/diffs` 的 5 件事——（a）Shadow DOM 下 Ctrl+F/选择复制/右键菜单；（b）Tauri CSP 与（可选）worker；（c）Vite 实际产物大小；（d）100k 行首帧；（e）jsdom 下现有测试的可迁移性。
2. spike 通过 → 采用 **D1**；不通过 → 采用 **D2**（低成本补齐 P0），并把 D1/D3 留作后续视觉升级。
3. 不建议先上 Monaco；也不建议继续在现渲染器上堆功能却不动词级/高亮（那正是用户说的"烂"的根因）。

### 3.4 集成要点（D1）

- 改：新增 `PierreDiffView.tsx`；`DiffView.tsx` 只保留工具栏/搜索/跳转/统计/引用选择器，删除自研行渲染与滚动；删除 `SplitDiff.tsx`、`diffRows.ts` 及其单测；`diffNavigation.ts` 的 hunk 序号逻辑可复用。
- CSP：默认 `shiki-js` 不需要改；若启用 Worker Pool 需加 `worker-src 'self'`（Vite `worker.format: 'es'`），**仍不需要 `wasm-unsafe-eval`**。
- 包体：`manualChunks` 单独切 chunk + 只注册实际语言；同时给前端产物设硬上限（建议 ≤ 4 MB，见 §8）。
- 测试：jsdom 缺 `ResizeObserver`/`IntersectionObserver` 需 mock；渲染断言放 Playwright（项目已有 `test:browser`/`test:a11y`）；现有 RTL 断言需按 Shadow DOM 改写。

### 3.5 Diff 验收基线（建议直接作为验收项）

P0：并排/统一一键切换；行号 + 增删改 gutter；上一/下一差异 + "3/17" 计数；文内搜索 + 命中计数 + 上/下一个；**忽略空白/行尾开关**；**行内词级高亮**；**语法高亮**；大文件降级与提示（partial/truncated 不冒充完整）；键盘流（Alt+↑↓、Ctrl+F、Ctrl+G、Esc）；亮/暗主题与现有设计 token 一致；复制/全选/右键/Swarm 链接不回归；a11y（axe 通过、工具栏可键盘操作）。
P1：未变更上下文折叠/展开；Base/引用标识（left/right 修订）清晰；只读保护与错误/空/加载态；"文本清零≠内容正确"类提示（沿用合并场景文案）。
P2：多文件累加 diff/文件树；图片 diff（P4Merge 支持 BMP/GIF/JPG/PNG/TIFF 等，见 §4.3）；比较规则可配置（忽略大小写/正则替换，Beyond Compare 范式）。

### 3.6 大文件与上限

现有 4 MiB / 100,000 行 / 8 MiB patch 是"安全阀"，不是算法极限。建议改为**分段 + 懒加载 + 显式降级**：

- 事实层用 `p4 print --offset/--size` 可分段取正文；首屏只渲染 hunk 附近，其余按需展开（@pierre 的折叠/虚拟化或现有 react-virtual 都支持）。
- 上限可以上调（如 10 MiB / 500k 行），但必须新增"首帧 <50 ms"与"内存上限"测试；超限仍保留只读元数据 + 明确原因。
- 这条直接对应用户的"大文件/上限"痛点，建议单独立项（与 Diff 重做解耦，可先做）。

---

## 4. 冲突合并工具重做

### 4.1 引擎对比（可静态分发）

| 引擎 | 结构化冲突区间 | 词级 | 冲突标记可定制 | 许可 / 可否随闭源应用分发 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **`similar` 3.x `merge::TextMerge`** | ✅ `MergeRegion`（kind/base/yours/theirs range、`is_conflict`） | 行级（词级另用 inline diff） | ✅ labels / marker size / ConflictStyle | **Apache-2.0，可** | **首选** |
| `diffy` 0.5.2 | ❌ 仅 marker 文本 | 行级 | ⚠️ 长度可调，标签固定 | MIT OR Apache-2.0，可 | 备选（成熟、mergetool 风格） |
| `threeway_merge` 0.1.20 | ❌ marker + 计数 | 行级 | ✅ | MIT **AND LGPL-2.1-or-later**（静态链接 xdiff） | 不推荐（闭源分发有 LGPL §6 负担） |
| `git merge-file` | ❌ marker | 行级 | ✅ `-L`/`--marker-size` | GPL-2.0，**不可打包**（只能调用系统已装） | 不选 |
| GNU `diff3` | ❌ marker | 行级 | ⚠️ 形状固定 | GPL-3.0+，**不可打包** | 不选 |
| `mergiraf` | ❌（外部只给文件/marker） | 行级 + AST | 有限 | GPLv3，**不可打包** | 不选（对任意文本退化为行合并） |
| `node-diff3` / `diff3` npm | 部分（ok/conflict 块） | 行级 | ✅ | MIT，可打包 | 不选（4 MiB 主线程卡顿；默认按空白切分需显式传行数组） |

**引擎侧共性陷阱**（必须写进回归用例）：先统一换行再做合并；双方相同改动必须判为无冲突；保持"原文件无末尾换行则输出也无"；中文行级安全但要避免按字节切词；**4 MiB 病态输入要有超时/降级**——`similar` merge 文档未见 deadline 旋钮，建议保留旧实现一个版本作 fallback 并加看门狗。

### 4.2 合并 UI 对比

| 方案 | 三方支持 | 许可 | 成本/风险 | 结论 |
| --- | --- | --- | --- | --- |
| **CodeMirror 6 自绘四栏/三栏**（Base 可隐藏，Theirs/Yours 只读，Result 可编辑） | ✅ 事实来自 Rust region | MIT | 编辑器内核成熟（搜索/撤销/键盘/a11y/视口渲染），但布局与 region 渲染要自研；需 jsdom mock 与 Playwright | **推荐** |
| 现有 textarea 升级（加高亮/行号/导航） | ✅ | 自有 | 最低成本，但体验上限低，不符合"重做" | 保守回退 |
| `@codemirror/merge` 拼两栏 + Result | ⚠️ 拼装 | MIT | 无三方语义；两套 diff（CM Chunk vs Rust region）易错位 | 不推荐 |
| Monaco 三方 | ❌ 官方无 | MIT | 体积/WebKit | 不选 |
| VS Code merge editor 抽取 | ✅ | MIT | 强耦合 workbench，15–25 人日 + 跟上游 | 不选 |
| 外部 mergetool（P4Merge/Kdiff3/Meld/BC） | ✅ | 闭源/GPL | 只能调用；体验割裂；但零实现成本、专业用户熟悉 | **作为可选增强** |

### 4.3 P4 官方能力与外部工具（事实核对）

- **权威三方身份**：`p4 resolve -n -o -ztag` 提供 `resolveBaseFile/resolveBaseRev`、`resolveFromFile/resolveEndFromRev`、`resolveType`；`p4 integrate -Ob` 可单独取 base revision。**base 是 P4 特有语义**（"与 source/target 共同编辑最多的 revision"），与 Git LCA 不同，必须信 P4。
- **官方 3-way 结果**：`p4 resolve -am`（无冲突才接受，有冲突跳过）与 `-af`（强制写入 merge 结果，即使有冲突也留标记）。**不建议**把 `-am/-af` 作为 P4Deck 主路径：它会直接改工作区文件，绕开现有的内存预览 + 一次性 token + 原子保存 + 备份流程；可作为"只读实验/权威对照"。
- **P4MERGE 机制**：`p4 resolve` 的 `m` 选项会以 **base, theirs, yours, merge(result)** 四参调用外部合并程序；Windows 需要 `.bat` 包装。P4Deck 也可以**反向注册为 P4MERGE**（让用户从 P4 侧调用 P4Deck），本期不做。
- **P4Merge**：随 P4V 免费安装、可独立运行；macOS 必须用 `/Applications/p4merge.app/Contents/Resources/launchp4merge`；支持 2-way/3-way、逐 chunk 选择与 toggle、手动编辑高亮、忽略空白/行尾、编码选择、图片 diff（BMP/GIF/JPG/PNG/PBM/PGM/PPM/TIFF/XBM/XPM）。历史限制：约 10 MB 合计、曾专项修复 100,000 行；**当前版本上限需 `p4merge -h` 实测**。
- **许可证**：P4Merge 闭源免费、随 P4V 分发，Perforce 未提供可再分发许可 → **只能"检测已安装 + 调用"，不能打包**。EULA 原文未能解析 **【未验证，需法务核对】**。
- **调用流程（安全不降级）**：同目录 4 个临时文件 → spawn `p4merge`（超时/取消 kill）→ 读回 result → 现有 `decode` → SHA-256 + 与快照比对 → `validate` token → `atomic_replace_with_backup` → 保存后复核 → `p4 resolve -ay` → 复核 unresolved。
- **检测建议**：Windows `%P4MERGE%` → `Program Files\Perforce\p4merge.exe`（及 x86）→ 注册表 P4V 安装项 → PATH；macOS `launchp4merge` 路径 → `P4MERGE` → `mdfind` → PATH。**不要在启动时探测**，用户点"外部合并"时再探测并缓存到 profile。

### 4.4 推荐组合与实施草图

**Rust**

```rust
// 新增 DTO（与现有安全流程解耦；标记文本保留以兼容 unresolved_blocks/has_conflict_marker）
pub struct MergeRegionDto {
    pub kind: String,            // "ours" | "theirs" | "both" | "conflict"
    pub base: (usize, usize),    // [start, end)
    pub yours: (usize, usize),
    pub theirs: (usize, usize),
}
```

- `manual_merge.rs` 的 `merge_text` 改用 `similar::merge::TextMerge`（锁 3.x 精确版本；`MergeRegion` 是 `non_exhaustive`，避免穷举 match）；旧实现改名 `merge_text_legacy` 保留一个版本做超时 fallback（建议看门狗 8s，超时降级并在 UI 明示）。
- 保留 `decode/encode/snapshot/sha256/atomic_replace_with_backup/secure_workspace_file` 与 `line_ending` 语义（内部 LF 合并、输出按目标换行）。
- 契约：`open_manual_merge` 返回值新增 `regions`（向后兼容）；`validate/save/resolve` 契约不动。

**前端**

- 重写 `ManualMergeEditor.tsx`：CodeMirror 6 四栏（Base 可隐藏/切换）或"上三下一"（取决于 UI-08-1 规格）；Theirs/Yours/Base 只读，Result 可编辑；按 Rust region 渲染冲突块与 Accept Yours/Theirs/Both/组合；未解决计数 + 上一/下一；搜索/撤销重做/键盘流；编码与换行提示（CRLF/mixed）；只读保护与超限降级；保存/`-ay` 两段式流程不变。
- Resolve 主对话框（`ResolveDialog.tsx`）：按 UI-08-1 规格重做（文件表、推荐操作区、逐文件策略、批量操作、空/加载/失败态）。**不需要引入新库**，复用现有表格/虚拟化组件即可；"推荐解"仍来自后端允许的策略集合，不由前端推断。
- 外部工具按钮：默认内置编辑器，增加"用 P4Merge 合并"入口（未安装时禁用并说明）。

**参考 P4V/UGit 的可复刻点**

- P4V Resolve：推荐解 + 理由、四类 additional actions、逐文件选项、binary-as-text 开关（P4Deck 若不做需明确禁用/说明）。
- P4Merge：逐 chunk 选择按钮与 toggle、手动编辑高亮、Comparison Method（忽略空白/行尾）、编码警告、Ctrl+数字跳差异。
- UGit（仅参照）：逐块导航、接受当前块/两侧对比跳转、批量处理；**闭源不可复用**，规格需用户提供截图/录屏后固化。

### 4.5 合并验收基线

P0：三方身份准确（来自 P4，非猜测）；三方布局 + Base 可显示/隐藏；逐块 Accept Yours/Theirs/Both/组合；未解决冲突计数 + 导航；Result 可编辑 + 撤销/重做 + 搜索；词级/语法高亮；保存前不写盘、保存校验；编码/换行提示；大文件只读降级；错误/partial/unknown 不冒充成功；CAS/digest 复核；`p4 resolve -ay` 后 unresolved 复核。
P1：批量应用非冲突改动；"simple conflict" 自动合并；显式 Complete/Reset；状态恢复（重开同一冲突恢复布局/滚动）；外部 P4Merge 直通。
P2：三方"合并结果预测"与 P4 官方 `-af` 结果对照；多文件批量合并工作流。

### 4.6 明确不推荐

- **把 `p4 resolve -am/-af` 作为主路径**（改工作区、破坏 token/原子保存语义）。
- **自研 base 选择**（P4 语义不同）。
- **抽 VS Code merge editor**（15–25 人日 + 持续跟上游，收益不匹配）。
- **打包 GPL/LGPL 合并件**（`git merge-file`/`diff3`/Mergiraf/Kdiff3/Meld/WinMerge/`threeway_merge`）。
- **前端 JS 合并 4 MiB**（`node-diff3` 主线程会卡）。

---

## 5. 许可证与合规矩阵

| 依赖/工具 | 许可 | 能否随闭源桌面应用分发 | 结论 |
| --- | --- | --- | --- |
| `@pierre/diffs` | Apache-2.0 | 可以（保留 NOTICE/许可声明） | 候选 |
| `@codemirror/*`（merge/view/state/language/search） | MIT | 可以 | 候选 |
| `monaco-editor` | MIT | 可以 | 体积否决，非许可否决 |
| `react-diff-view` / `react-diff-viewer-continued` / `@git-diff-view/react` / `diff2html` | MIT | 可以 | 能力否决 |
| Rust `similar` / `diffy` | Apache-2.0 / MIT OR Apache-2.0 | 可以 | 推荐 |
| `threeway_merge` | MIT AND LGPL-2.1-or-later（静态链接 xdiff） | 有 LGPL §6 义务 | 不推荐 |
| `git merge-file` / GNU `diff3` / `mergiraf` / Kdiff3 / Meld / WinMerge | GPL-2.0/3.0/GPLv2+ | **不可以**（除非只调用系统已装命令） | 只能外挂 |
| P4Merge | 闭源免费（随 P4V） | **不可以打包**（未获再分发许可；EULA 未验证） | 只检测+调用 |
| VS Code merge editor 源码 | MIT | 可以 | 抽取成本否决 |
| UGit / P4V | 闭源商用 | 不可以 | 仅交互参照 |

建议把**依赖许可证扫描**（如 `license-checker`/`cargo-deny`）纳入 `pnpm ci:quick`，防止后续误引入 copyleft。

---

## 6. 分阶段路线与工作量（估算，单人/单 agent）

| 阶段 | 内容 | 产出 | 估时 |
| --- | --- | --- | --- |
| 0 | 方案对齐 + `@pierre/diffs` spike（可丢弃） | spike 报告（5 项判定） | 1–2 人日 |
| 1 | Diff 渲染重做（D1 或 D2）+ 搜索/hunk/右键/测试迁移 | Diff 工具窗口 | 3–5 人日（D1）/ 2–4 人日（D2） |
| 2 | 合并引擎替换（`similar::TextMerge` + regions + fallback + 回归） | 后端 + 契约 | 2–3 人日 |
| 3 | 合并 UI 重写（CodeMirror 6 四栏 + region 消费 + Resolve 主窗体重做） | 合并工具 + Resolve | 6–10 人日 |
| 4 | 可选：P4Merge 检测+调用（含设置项/降级） | 外部工具入口 | 2–3 人日 |
| 5 | 验收：Windows 真机截图对照 + 回归 + 性能/axe/e2e | 验收证据 | 2–3 人日 |

合计约 **2.5–4 周**（不含 macOS 真机验收与多 P4 版本矩阵）。建议先合并"阶段 0+1"立项，阶段 2–3 作为同一批次的两半（引擎先行，UI 后行），阶段 4 视用户是否需要 P4Merge。

---

## 7. 风险与待实测（spike 清单）

| 风险 | 影响 | 缓解 / 验证 |
| --- | --- | --- |
| `@pierre/diffs` Shadow DOM 下搜索/选择复制/右键在 WebView2/WKWebView 的行为 | 交互回归、e2e 失败 | spike 第 1 项；用 `onPostRender` 接现有菜单；真机 Playwright |
| `@pierre/diffs` 实际包体/首帧（unpacked 11.2 MB，不等于 bundle） | 包体积/性能门禁 | spike 第 3/4 项；`manualChunks` + 只注册语言；大文件关 inline |
| WebKit 26 已知滚动 bug（`hunkSeparators:'line-info'` + 自定义 gutter） | macOS 体验 | 官方 workaround（内置 gutter / `line-info-basic`） |
| `similar` merge 无 deadline、4 MiB 病态输入慢 | 后端卡顿 | 锁定版本 + 看门狗 + 旧引擎 fallback + 压测用例 |
| CodeMirror MergeView 大文件 `scanLimit` 退化为不精确 diff | diff 错位 | 调参 + 100k 行实测；必要时对大文件走 D2/自研渲染 |
| CodeMirror/Monaco 在 jsdom 单测不可用 | 测试红 | setup mock（ResizeObserver 等）+ Playwright |
| Tauri CSP 未放行 worker/wasm | 功能静默失败 | 默认不用 WASM；Worker 显式加 `worker-src 'self'` 并真机验证 |
| P4Merge CLI 语法/退出码/EULA 未验证 | 外部工具入口不可用/合规 | `p4merge -h` 实测 + 法务核对；未装时优雅降级 |
| P4VFS/altsync 下读文件触发按需下载 | diff/merge 首屏慢 | Rust 侧 hydrate 等待 + 限并发 + 骨架屏 |
| 依赖许可证漂移 | 合规风险 | CI 加许可证扫描 |

---

## 8. 需要拍板的问题（建议逐条确认后再拆任务）

1. **Diff 选型**：接受先做 `@pierre/diffs` spike 吗？若 spike 不过，是否接受 D2（保留现有交互外观，只补词级/高亮/折叠）作为过渡？
2. **合并 UI 形态**：按 UI-08-1 规格，采用"上三下一（P4Merge 式）/ 四栏并排（现式）"还是"VS Code 式三栏"？Base 是否默认隐藏？是否需要整窗/独立 tool window（现在挤在 Resolve 对话框里）？
3. **外部工具**：是否需要"用 P4Merge 合并"按钮？是否需要用户可配命令模板（支持 Beyond Compare/Kdiff3 等）？确认只调用不打包。
4. **大文件上限**：是否把 4 MiB / 100k 行上调并按分段懒加载实现？（这决定要不要单独立项。）
5. **包体与性能门禁**：新增依赖后允许前端产物上限（建议 ≤ 4 MB，未压缩）与 Diff 首帧 <50 ms 是否作为硬门禁？
6. **工作流**：方案通过后，是否把本报告拆成 `UI-08-2/3/4/5/6` + 新 Diff 任务，并更新 `state.json`（本报告不改工作流状态）。

### 8.1 已拍板（2026-10-31，用户确认）

| 任务 | 方案 | 范围 | 状态 |
| --- | --- | --- | --- |
| `DIFF-01` | **整套替换 `@pierre/diffs` 1.6.2（Apache-2.0）** | 保留现有工具栏/搜索/hunk 跳转/引用选择/复制/右键/Swarm 与 partial/truncated 语义；渲染、词级、折叠、Shiki 高亮交给库；不引入 WASM/CDN，CSP 默认不变；契约不变 | **已实现待验收**（2026-10-31，`check:web`/全量 vitest/build/cargo test/clippy/fmt 通过；见 `artifacts/evidence/2026-10-31-DIFF-01-MERGE-01/验证摘要.md`） |
| `MERGE-01` | **先直接调用 P4Merge 确保功能能用，不打包** | 仅检测已安装；从现有手工会话生成 base/theirs/yours/result 四临时文件，读回 result 回填编辑器，用户复核后仍走 validate/save token + 原子写 + `p4 resolve -ay` 复核；未安装/取消/超时/超限明确降级；UI 重做（UGit/P4V 对齐）与 CM6 方案后续再议 | **已实现待验收**（2026-10-31；cargo 单测 9 项 + 前端 25 项定向通过，全量门禁同上；真实 P4Merge GUI 冒烟交用户） |

> 决策口径：用户明确"merge 先保证能用，别的事后续再说"；因此 `MERGE-01` 不引入 CodeMirror/Monaco，也不改 Resolve 主对话框布局。`UI-08` 保持暂停，待 P4Merge 路径可用后再决定 UI 重做范围。

### 8.2 后续追加：DIFF-02 计算层优化（2026-10-31 用户指定优先）

- 目标：去掉前端对全文的第二次 diff 计算，直接消费 Rust `similar` 已经算好的结构化 hunk（`DiffResult.unified` 即其序列化）。
- 落地：前端删除 `MultiFileDiff`/`parseDiffFromFile`/`PatchDiff` 生产用法；改为 `parsePatchFiles(normalizeUnifiedPatch(unified))` → `<FileDiff fileDiff>`，`loadDiffFiles` 提供归一化全文用于展开上下文；hunk 导航/搜索改用同一份解析结果；解析失败走纯文本降级。
- 效果（100k 行、15 处改动）：`parseDiffFromFile` 中位 **90.32 ms / 14.59 MB heap** → `parsePatchFiles` **0.15 ms / 81 KB heap**（≈602×），hunk 数一致；全量 1550 tests、`check:web`、`build`、prettier 全绿；真实窗口视觉待用户验收。证据 `artifacts/evidence/2026-10-31-DIFF-02/验证摘要.md`。
- 未改 wire 契约：`unified` 本身就是 Rust 的 hunk 序列化，再加一份带行文本的 typed JSON 会让 8 MiB patch 与 8 MiB 结构体双份 IPC；若后续确需 typed 模型，建议"只下发 hunk 结构、由前端重建 patch"，另行评估。

---

## 9. 一手参考链接（分组）

**Diff 库**
- `@pierre/diffs` 文档：<https://diffs.com/docs>；仓库：<https://github.com/pierrecomputer/pierre>；npm：<https://www.npmjs.com/package/@pierre/diffs>
- CodeMirror merge 参考：<https://codemirror.net/docs/ref/#merge>；类型声明：<https://unpkg.com/@codemirror/merge@6.12.3/dist/index.d.ts>；大文件默认限制回归：<https://github.com/codemirror/dev/issues/1382>
- Monaco DiffEditor：<https://microsoft.github.io/monaco-editor/>；npm（unpacked 101.7 MB）：<https://registry.npmjs.org/monaco-editor/latest>
- `react-diff-view`：<https://github.com/otakustay/react-diff-view>；`react-diff-viewer-continued`：<https://github.com/Aeolun/react-diff-viewer-continued>；`git-diff-view`：<https://github.com/MrWangJustToDo/git-diff-view>；`diff2html`：<https://diff2html.xyz/>

**合并引擎**
- Rust `similar` merge 模块：<https://docs.rs/similar/latest/similar/merge/index.html>
- Rust `diffy`：<https://docs.rs/diffy/latest/diffy/>
- `threeway_merge`（LGPL 说明）：<https://docs.rs/threeway_merge/latest/threeway_merge/>
- GNU diffutils（GPL）：<https://www.gnu.org/software/diffutils/>；`git merge-file`（GPL）：<https://git-scm.com/docs/git-merge-file>
- Mergiraf（GPLv3）：<https://codeberg.org/mergiraf/mergiraf>
- node-diff3（MIT）：<https://github.com/bhousel/node-diff3>

**Perforce 官方**
- `p4 resolve`（策略/字段/`Diff chunks`）：<https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/p4_resolve.html>
- `p4 integrate`（base = 共同编辑最多）：<https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/p4_integrate.html>
- `p4 diff`（`-du/-ds/-db/-dw/-dl`）：<https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/p4_diff.html>
- `p4 diff2`：<https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/p4_diff2.html>
- `p4 print`（编码/BOM/`--offset --size`）：<https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/p4_print.html>
- `P4MERGE`（4 参数、Windows .bat）：<https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/P4MERGE.html>
- `P4DIFF`：<https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/P4DIFF.html>
- P4V "Merging Files"（P4Merge 布局/逐块语义）：<https://legacy-docs.perforce.com/doc.current/manuals/v17.2/p4v/advanced_files.p4merge.html>
- P4V "Resolving Files"（Resolve 对话框）：<https://legacy-docs.perforce.com/doc.current/manuals/v17.2/p4v/branches.resolve.html>
- P4Merge Release Notes（命令行选项/图片/规模限制，2008.1，时效风险）：<https://legacy-docs.perforce.com/doc.081/user/p4vmergenotes.txt>
- Perforce 法务入口：<https://www.perforce.com/legal>

**UX 基线**
- VS Code 三方合并：<https://code.visualstudio.com/docs/sourcecontrol/merge-conflicts>
- IntelliJ 冲突解决：<https://www.jetbrains.com/help/idea/resolve-conflicts.html>
- GitHub PR diff（忽略空白/上限）：<https://docs.github.com/en/pull-requests/reference/branches#comparing-branches-in-pull-requests>
- UGit 介绍（腾讯官方文章，**无冲突界面细节，需截图补规格**）：<https://cloud.tencent.com.cn/developer/article/2482449>

**Tauri 2**
- WebView 版本/差异：<https://v2.tauri.app/reference/webview-versions/>
- CSP（wasm/`worker-src`）：<https://v2.tauri.app/security/csp/>
- macOS 自定义协议无 Service Worker：<https://github.com/tauri-apps/wry/issues/389>
- 调用 Rust/子进程：<https://v2.tauri.app/develop/calling-rust/>；App Size：<https://v2.tauri.app/concept/size/>

---

## 附录：调研底稿与证据（本机 `artifacts/research/`，未入库）

| 底稿 | 内容 |
| --- | --- |
| `artifacts/research/2026-10-31-diff/diff-ui.md` | Diff 候选逐库事实表、功能矩阵、Rust crate 对比、3 套落地方案、风险与未验证清单 |
| `artifacts/research/2026-10-31-merge/merge.md` | 合并引擎/UI/外部工具三张对比表、方案 A/B/C、与现有 token/原子保存流程的衔接、许可证依据 |
| `artifacts/research/2026-10-31-p4-ux/p4-and-ux.md` | P4 官方能力复用/自研判定表、P4Merge/P4V 事实、23 项 UX 基线（P0/P1/P2）、Tauri 约束、开源可借鉴项 |

> 复核建议：对本文每个"可打包"结论，按链接核对 LICENSE；对 P4Merge 相关结论，落地前用 `p4merge -h` 与法务原文复核；对性能数字，一律以本机 4 MiB/100k 行样本实测为准。
