# 文件预览支持 CSV / XLSX：方案预研

> 文档编码：UTF-8；日期：2026-11-03；状态：**已验收（用户 2026-11-03：「验收，通过」）；未发布、未打包、未提交**（实施与验收记录见 `artifacts/research/preview-csv-xlsx/impl-report.md`；本文保留为规格与实测来源）
>
> 关联：`FILE-01`（文件与版本：Workspace/Depot 树、预览、状态与缓存）的预览能力扩展；实施前需由 LEAD 在 TODO 登记新任务（建议 `FILE-05`）并 `state.mjs import`。**本文不修改 TODO、`state.json` 与看板**。
>
> 范围：工作区**本地副本**的只读表格预览——`.csv/.tsv`、`.xlsx/.xlsm`（只读缓存值）。不含：Shelf/Depot 自动下载、编辑/保存、公式求值、宏、图表/图片、`.xls`(BIFF)/`.ods`、Diff/合并。
>
> 证据口径：仓库内事实以 `文件:行号` 为准（Lead 已核）；外部事实以 2026-11-03 的 crates.io / docs.rs / npm / 官方文档快照为准；实测数据来自 BE/FE 两份底稿在 `%TEMP%` 独立工程的离线实测（未在仓库树跑构建）。无法核实的标 **【未验证】**。两份底稿：`artifacts/research/preview-csv-xlsx/be-findings.md`（Rust，621 行）与 `fe-findings.md`（前端，726 行）；`artifacts/` 被 `.gitignore` 忽略，不入库。

---

## 0. 结论速览（TL;DR）

**核心判断：能实现，而且正确解法不是"把预览上限整体调大"，而是把「文件本身大」与「读多少 / 传多少 / 渲染多少」拆开——后端流式解析出"有界表格页"，前端只渲染前 500 行 × 64 列。**

- **CSV**：Rust 侧自研有界流式解析（`encoding_rs` 增量解码 + RFC 4180 状态机 + 分隔符探测）。**中文 Excel 另存的 ANSI/GBK CSV 是刚需**，所以必须引入 `encoding_rs`；`csv` crate 留作替换式备选，`chardetng` 留 P2。
- **XLSX**：首选 `calamine` 0.37/0.38（MIT，MSRV 1.88）的流式 API `worksheet_cells_reader` + 自研 zip 中央目录前置校验；**备选**是复用已链接的 `zip 9.1.3` + 缓存中已有的 `quick-xml 0.41` 自研最小读取（可全离线，工作量约 3–5 倍）。**否决**前端 SheetJS（npm 版停在 0.18.5、7.5 MB、需 vendoring 且大文件内存不可控）。
- **实测证明"大文件小预览"成立**：110 MB / 120 万行 CSV 读前 500 行只取 **64 KiB、316 µs**；6.8 MB xlsx（解压 61.7 MB）读前 500 行只解压 **200 KB、1.0 ms**，中央目录校验 303 µs。
- **传输/渲染上限不需要调大**：500×64 单元格的 IPC JSON 典型 **471 KB**（含中文约 1.2 MB），仍低于现有文本预览的 2 MiB；前端用 `@tanstack/react-virtual` 只做行虚拟化，64 列不做列虚拟化，DOM 约 2.7–4.4k 元素。
- **新增依赖**：`encoding_rs 0.8.44`（CSV 必需）+ `calamine`（XLSX 推荐路径）。calamine 会带入 `quick-xml 0.42`、`atoi_simd`、`codepage`、`fast-float2`，且它的 `zip/deflate` feature 会引入 `zopfli` + `zlib-rs`——exe/安装包增量 **【未验证】**，是选型阶段必须实测的一项。
- **工作量**：BE 3–5 人日 + FE 6–7 人日 ≈ 9–12 人日（并行约 1–1.5 周）；含 calamine spike、契约联调、单测与合成视觉，不含发布与用户验收。
- **首版明确不做**（避免"以为有"）：加载更多/分页、列虚拟化、列宽持久化（拖拽按用户反馈已改为复用共享 `ResizableTable`，仅本地）、单元格完整值弹窗、公式求值、日期/数字/货币格式化、排序/筛选/查找/导出、多行单元格展开、CSV 手动编码/分隔符切换、工作表选择随页签持久化、`.xls`(BIFF)/`.ods`。
- **需要用户拍板 6 项**（见 §8.4）：真实大文件样本、XLSX 首选/备选路线、`.tsv/.xlsm/.xls/.ods` 口径、V09 菜单、是否纳入 T15/UI-04/UI-06 视觉矩阵、表格页首版是否要"加载更多"。

### 0.1 直接回答："CSV/XLSX 一般较大，要不要把支持预览的文件大小改大点？"

**不要调大"传输/渲染"上限；要改的是"文件大小不再等于预览量"。**

| 量 | 现状 | 建议 | 理由 |
| --- | --- | --- | --- |
| ① 从磁盘读多少 | 统一 8 MiB 早退（`preview.rs:47`），text 再卡 2 MiB | 按 kind 拆开：CSV 读前 8 MiB；XLSX 输入文件 ≤64 MiB（实际按行流式读）；text 仍 2 MiB；image 仍 8 MiB | 读取量决定 IO/内存；大文件≠多读 |
| ② 文件大小上限 | 8 MiB 一刀切 | CSV 512 MiB 仅防呆；XLSX 64 MiB（保护 sharedStrings/styles 内存）；text/image 不变 | 用户说"大"的文件可以预览，只是"预览得少" |
| ③ IPC 传输量 | text 最多 2 MiB | **不调大**：table 目标 ≤2 MiB（典型 471 KiB，硬上限 4 MiB） | Tauri v2 命令返回值走 JSON 序列化，2 MiB 已可观；32k 字符串比连续文本更贵 |
| ④ 前端渲染/缓存 | 文本虚拟滚动；缓存 3 份 | **不调大**：500 行 × 64 列 + 行虚拟化；`KEEP_PREVIEWS` 保持 3 | 表格单条 1.5–4 MB JS heap，比现有 8 MiB 图片（base64 ≈10.7 MB）轻一个量级 |

- **text：不调大（2 MiB）**。真正的大文本需求是"分块读取 / 搜索"，属独立特性，不在本次。
- **image：不调大（8 MiB / 2000 万像素）**。大图应走缩略图/按需解码的独立方案。
- **CSV：不是调上限，而是解耦**。文件可以 100 MB+，只读前 8 MiB、解析前 500 行，`rowCount:null` + "仅显示前 500 行"。
- **XLSX：输入上限 64 MiB，预览量固定 500 行**。64 MiB 的真实目的是限制 `Xlsx::new` 在内存里整体载入的 sharedStrings/styles，而不是限制预览行数。

### 0.2 推荐落点（一句话）

`get_file_preview` 保留单命令，按 kind 分派：`text/image` 行为不变；`csv/tsv` 走有界流式解析；`xlsx/xlsm` 走 `calamine` 流式单元格 + zip 前置校验；统一返回 `kind:"table"` 的有界行矩阵 + 截断原因；前端新增 `PreviewTable`（原生 `<table>` + sticky 表头/行号 + 行虚拟化）与 V09 菜单，`useFilePreview` 的缓存 identity 增加 `sheetIndex`。

---

## 1. 现状盘点（已核对代码）

| 事实 | 位置 | 说明 |
| --- | --- | --- |
| 唯一预览实现 `read(root,input) -> FilePreview` | `src-tauri/src/app/preview.rs:22` | 路径 canonicalize + `starts_with(root)` + `is_file`，只读本地工作副本 |
| **单一 8 MiB 早退** | `preview.rs:47-49` | `if metadata.len() > IMAGE_LIMIT { return Err(...) }`，在分类之前一刀切——本次要拆掉 |
| 整文件读入 + `classify()` | `preview.rs:50-131` | PNG/JPEG/GIF/WebP（≤20 MP）或 UTF-8/UTF-16(BOM) 文本；控制字符即拒绝；无流式/分页 |
| 上限常量 | `preview.rs:8-9` | `IMAGE_LIMIT=8 MiB`、`TEXT_LIMIT=2 MiB`；20 MP 硬编码在 `:73` |
| IPC 命令 | `src-tauri/src/ipc/commands.rs:2196-2232` | depot 路径先 `resolve_path` 成本地路径；`root=context.cwd`；`spawn_blocking`（无超时/无取消） |
| 前端契约 | `src/shared/contracts.ts:2711-2718` | 扁平 `kind:"text"\|"image"` + `content/size/encoding/width/height` |
| 读取/缓存 hook | `src/features/browsers/useFilePreview.ts:22-75` | 150 ms 防抖、`staleTime 3s`、最多 3 份、`live` 迟到隔离；identity 不含 sheet |
| 页面 | `src/features/browsers/components/FilePreviewPage.tsx` | 文本虚拟行 / 图片缩放 / 工具栏 / footer 上限文案 / 菜单 V05–V07；未知 kind 落 `null`（`:219`）空白 |
| Mock | `src/infrastructure/backend/mockBackend.ts:3674-3700` | 文本正则含 `csv`（当前按文本返回）；`.xlsx` 直接 `Unsupported preview format (demo)` |
| 文档约束 | `ForAIDoc/Designer/体验与界面规范.md:199-205` | "文本 ≤2 MiB、图片 ≤8 MiB/20 MP、虚拟行、单行 >4000 截断、不自动下载 depot" |
| 维护约定 | `ForAIDoc/Coder/前端架构与维护约定.md:100,109` | "FilePreviewPage 负责呈现；useFilePreview 负责异步数据，已有读取限制与缓存策略保持不变"（本次要按新契约更新该句） |

**结论**：当前是"整文件入内存 → 嗅探 → 分类渲染"，没有流式、没有分页、没有 per-kind 上限；CSV >2 MiB 直接报错，XLSX 完全不可预览。

---

## 2. 大小上限设计（per-kind）

> 单位 KiB/MiB；行/列/单元格按"单次显示的表格页"计。数字来自两份底稿的推导与实测（§10），实现时以本表为单一来源，FE footer 文案与之一致。

| 项 | 常量 | 建议值 | 依据 / 超限行为 |
| --- | --- | --- | --- |
| 文本读取 | `TEXT_LIMIT` | 2 MiB（不变） | 现状；超限报错 |
| 图片读取 | `IMAGE_LIMIT` / `IMAGE_MEGAPIXELS` | 8 MiB / 20,000,000（不变） | 现状（`preview.rs:8,73`）；超限报错 |
| CSV 输入防呆 | `CSV_INPUT_LIMIT` | 512 MiB | 仅防呆；超过报"文件过大" |
| CSV 单次读取 | `CSV_READ_CAP` | 8 MiB | 500 行×64 列×40 B ≈1.28 MiB，6 倍余量；超限返回部分行 + `byteCap` |
| CSV 单字段 | `CSV_FIELD_CAP` | 64 KiB | 防单字段爆炸；截断该字段 |
| XLSX 输入 | `XLSX_INPUT_LIMIT` | 64 MiB | 保护 `Xlsx::new` 的 sharedStrings/styles 内存；覆盖约 140 万行 × 10 列 |
| zip 条目数 | `XLSX_ZIP_ENTRIES` | 2,048 | 正常 xlsx 几十项；超过视为疑似 zip bomb |
| zip 单条目解压 | `XLSX_ENTRY_CAP` | 256 MiB | 实测 15 万行 sheet 解压 61.7 MiB ≈60 万行 |
| zip 解压总量 | `XLSX_UNCOMPRESSED_TOTAL` | 512 MiB | 配合 64 MiB 输入，压缩比上限 8× |
| zip 压缩比 | `XLSX_ZIP_RATIO` | 200 | 正常 xlsx 实测 8.72；>200 可疑 |
| sharedStrings | `XLSX_SHARED_STRINGS_CAP` | 24 MiB（解压后） | calamine 会整体载入；24 MiB XML ≈20–30 MB 堆，超限报"字符串表过大" |
| styles | `XLSX_STYLES_CAP` | 4 MiB（解压后） | 同上；正常 1–300 KiB |
| 行 / 列 / 单元格 | `ROW_CAP / COL_CAP / CELL_CAP` | 500 / 64 / 32,000 | 一屏 20–40 行，500 行约 12–25 屏；500×64 典型 JSON 471 KB |
| 单单元格字符 | `CELL_CHAR_CAP` | 512 | 避免 4096 字符 ×3.2 万格 ≈131 MB 极端 JSON（实测） |
| 单元格文本预算 | `CELL_TEXT_BUDGET` | 2 MiB / 次响应 | 达到即停止加行（`budgetCap`） |
| 预览超时 | `TABLE_DEADLINE` | 5 s | 返回已读部分 + `timeout`，不报错；不覆盖 `canonicalize` 阻塞 |
| IPC 返回体积 | `TABLE_JSON_BUDGET` | 目标 ≤2 MiB，硬上限 4 MiB | 与现有 text 2 MiB 同量级；用 `serde_json::to_vec` 做回归门禁 |
| 页偏移（预留） | `PAGE_OFFSET_CAP` | 5,000 行 | v1 FE 不发送；未来分页时限制 O(offset) 重读 |
| sheet 名单 | `SHEET_NAMES_CAP / SHEET_NAME_LEN` | 200 / 128 字符 | 超限截断并提示"仅列出前 200 个工作表" |

---

## 3. CSV 方案

### 3.1 流程

1. 读前 64 KiB → **编码判定**（BOM 优先）→ 解码为 UTF-8 → **分隔符探测**（前 64 KiB，引号外计数，候选 `, ; \t |`；`.tsv` 直接锁 `\t`）。
2. `File::open` 一次，把已读 head 用 `Cursor` 拼回解码器首段，避免二次读文件；整体 `Read::take(CSV_READ_CAP)`。
3. **RFC 4180 状态机**逐字符推进：引号字段、`""` 转义、引号内 CRLF、LF/CR/CRLF 混排、末尾无换行；**CRLF 跨读缓冲边界**必须用 `BufRead::fill_buf/consume` 或保留上一字节状态（BE 的探针恰好在这里踩过一次，见 §10）。
4. 行/列/单元格/文本预算/超时同步裁剪，**返回部分结果 + `truncatedReason` 而不是报错**；完全空行跳过（已知取舍，固定测试）。
5. 行矩阵原样返回（含第 0 行）；`rowCount` 恒为 `null`（统计总行数需扫全文件：实测 1.2M 行 129 ms，但在 P4 的冷缓存/网络盘上不可控）。

### 3.2 编码级联（中文刚需）

`BOM(UTF-8/UTF-16) → UTF-8 严格校验 → GB18030 严格解码 → Windows-1252 兜底`；需要 `encoding_rs 0.8.44`（`(Apache-2.0 OR MIT) AND BSD-3-Clause`，`rust_version 1.88`，crate_size 554,960 B）。`encoding` 返回机器可读名（`UTF-8` / `UTF-16 LE` / `GB18030` / `Windows-1252`）+ `encodingGuess: true`，由 FE 本地化"（推测）"，**不要在 Rust 里拼中文**。已知取舍：非中文 legacy 单字节编码（如 windows-1254）可能被 GB18030 误吃一部分；v1 标"推测"，P2 再评估 `chardetng 1.0.0`。

### 3.3 明确不做

`.csv` 按文本直传（无法处理引号内换行）、整文件读入、前端解析（违反"前端不解析文件格式"）、手动编码/分隔符切换（只显示自动检测结果）。

---

## 4. XLSX 方案

### 4.1 候选对比

| 维度 | **A. calamine 0.37/0.38（推荐）** | B. 自研 zip 9.1.3 + quick-xml 0.41（备选） | C. 前端 SheetJS（否决） |
| --- | --- | --- | --- |
| 许可/版本 | MIT；0.37.0（2026-10-18）/0.38.0（2026-11-02），MSRV 1.88 | 自有代码；依赖均在本地缓存 | npm `xlsx` 0.18.5（npm 源已过期，权威源在自家 CDN，需 vendoring） |
| 大文件行为 | `worksheet_cells_reader` 逐单元格流式，可只读前 N 行；但 `Xlsx::new` 会整体载入 sharedStrings/styles | 完全流式；可只保留前 500 行引用到的字符串 | 整个 workbook 解析成 JS 对象；大文件内存/主线程不可控 |
| 日期/数字/合并/公式缓存值 | 有（`DataRef::as_string`/`as_datetime`）；公式只取缓存值 | 需自写 styles/numFmt、sharedStrings、mergeCells（约 +300–500 行） | 完整，但会带入 7.5 MB 与 7 个依赖，且公式可能在 JS 侧计算 |
| 依赖代价 | +encoding_rs、calamine、quick-xml 0.42、atoi_simd、codepage、fast-float2；zip 的 `deflate` feature 会同时引入 `zopfli`+`zlib-rs` | 仅把 `quick-xml 0.41` 提为普通依赖 + zip 开 `deflate-flate2`（flate2/miniz_oxide 已在 lock） | 进 Vite 产物，锁文件难以表达来源 |
| 离线可实施 | **否**（需联网拉新 crate） | **是**（BE 已实测 `cargo build --release --offline` 成功） | 否（需 vendoring 流程） |

### 4.2 判定

- **首选 A**：流式 API 已核实存在（`calamine 0.38 Xlsx::worksheet_cells_reader` 返回 `XlsxCellReader`），能直接满足"只读前 500 行"；日期/合并/公式缓存值有人替我们处理，代码量最小（`xlsx.rs` 约 200–300 行）。
- **备选 B**：只在 A 的 spike 失败（内存/格式/依赖体积不可接受）时启用；BE 已实测其可行性（读 150k 行 sheet 前 500 行仅 1.0 ms、读 200 KB 压缩字节）。
- **明确不做**：`calamine::worksheet_range`/`worksheets()` 整表解析；前端 SheetJS；`.xls`(BIFF)/`.xlsb`/`.ods`；宏执行（永不调用 `vba_project()`）；公式求值；图片/图表/条件格式；合并单元格视觉展开（只显示锚点值）。

### 4.3 最大风险：sharedStrings 内存（**spike 已完成，风险解除**）

`Xlsx::new` 会把 sharedStrings/styles 整体载入内存。2026-11-03 已用 `calamine 0.38.0` 在独立工程 spike（工具与原始结果见 `artifacts/research/preview-csv-xlsx/spike/`，`RESULTS.md`）：

- **真实样本**（`技能数据.xlsx`，3.3 MB，10 sheet，最大 sheet XML 19.8 MB）：`Xlsx::new` 8.7 ms、首 500 行 14.6 ms（33,430 格）、峰值工作集 **9.3 MB**；`Xlsx::new` 耗时与 sheet 大小基本无关。
- **sharedStrings 压力**（10 万唯一串，`sharedStrings.xml` 11.86 MB）：`Xlsx::new` 164–179 ms、峰值 **28.3 MB**，内存约为 XML 的 2 倍、耗时约 15 ms/MB。
- 按上限 `sharedStrings ≤ 24 MiB` 外推：`Xlsx::new` ≈ 360 ms、峰值 ≈ 55 MB，**在可接受线内**。

因此维持首选 A（calamine），不需要切自研 B。仍需在接入产品树后实测 `Cargo.lock` diff 与 exe/安装包增量（§4.4）。另：`DataRef::as_string()` 对日期/时间输出正确，但**百分比/货币显示原始值**（0.125 而非 12.50%），v1 接受并在页脚注明，若要求 Excel 观感再加 numFmt 格式化（0.5–1 人日，后置）。

### 4.4 依赖/体积（spike 实测）

`calamine` 声明 `zip ^9.0 (default-features=false, features=["deflate"])`；`zip` 的 `deflate` = `deflate-zopfli` + `deflate-flate2-zlib-rs`（本地源码已核），因此会新增 `zopfli` 与 `zlib-rs`。spike 的 fresh resolve 实测：`calamine 0.38.0`、`encoding_rs 0.8.44`、`quick-xml 0.42.0`、`flate2 1.1.10`、`zopfli 0.8.4`、`zlib-rs 0.6.8`、`zip 9.3.0`、`atoi_simd 0.18.1`、`codepage 0.1.3`。

- **产品 lock 注意**：现有 lock 是 `zip 9.1.3`、`quick-xml 0.41.0`（后者仅 build 依赖）。fresh resolve 把 zip 解到 9.3.0；接入产品时必须检查 `Cargo.lock` 实际 diff（可能保留 9.1.3，也可能升 9.x），并跑 updater 相关测试确认无行为变化；quick-xml 0.41 与 0.42 不兼容会并存（0.41 仍只用于 build）。
- **体积**：spike 可执行文件（含 calamine + windows-sys + std）**860,672 B**；产品 release exe 增量需接入后实测（预期 <1 MB）。当前基线 exe 33.8 MB、安装包 9.81 MB；若增量不可接受才切自研 B（B 只加 flate2/miniz_oxide/quick-xml，均已在缓存）。

---

## 5. 契约与命令形态

### 5.1 wire（两种底稿已对齐的最终形状）

`FilePreview` **保持扁平**（不改成判别联合），只加 `kind:"table"` 与可选 `table`，table 时 `content:""`、`size` 为文件真实字节；`table` 用 `skip_serializing_if` 保证 text/image 的 wire 不变。相比 BE 底稿，**Lead 裁决追加 2 个字段**（FE 的两条可选项，成本 O(1)）：

```ts
// src/shared/contracts.ts（替换 2711-2718）
export type FilePreviewKind = "text" | "image" | "table";
export type FilePreviewTruncatedReason =
  | "rowCap" | "colCap" | "cellCap" | "byteCap" | "budgetCap" | "timeout";

export interface FilePreviewTable {
  format: "csv" | "xlsx";                 // .tsv/.xlsm 都归入这两类
  delimiter: "," | ";" | "\t" | "|" | null; // csv 探测值；xlsx null
  sheetName: string | null;               // xlsx 当前表；csv null
  sheetIndex: number | null;              // xlsx 当前下标；csv null
  sheetNames: string[] | null;            // xlsx 全部（≤200×128 字符）；csv null
  rows: string[][];                       // 已格式化字符串；含表头行；≤500×≤64
  rowCount: number | null;                // xlsx 仅 dimension 可信；csv 恒 null
  rowCountSource: "dimension" | null;     // 口径：含表头行、可能含空行
  hasMore: boolean;
  truncated: boolean;
  truncatedReason: FilePreviewTruncatedReason | null;
  totalColumns?: number | null;           // 【Lead 追加】工作表总列数（列截断文案用）
}

export interface FilePreview {
  kind: FilePreviewKind;
  content: string;                        // text 原文 / image data URL / table ""
  size: number;
  encoding?: string | null;               // csv 机器可读编码名
  encodingGuess?: boolean;                // 【Lead 追加】编码为推测值
  width?: number | null;                  // 仅 image
  height?: number | null;                 // 仅 image
  table?: FilePreviewTable;               // 仅 kind==="table"
}
```

Rust 侧：`FilePreview` 用 `Option<TablePreview>` + `#[serde(skip_serializing_if="Option::is_none")]`；**不要**顺手给 `encoding/width/height` 加 skip（会改变既有 wire，测试断言可能受影响）。

### 5.2 命令形态

保留 `get_file_preview`，加 3 个可选参数（不新增命令，避免 depot 解析/root 校验/spawn_blocking 复制一遍）：

```rust
#[tauri::command]
pub async fn get_file_preview(
    _admission: Admission, path: String,
    sheet_index: Option<u32>, // xlsx：0 基；越界报"共 N 个工作表"
    offset: Option<u32>,      // v1 FE 不发；>5000 报错
    limit: Option<u32>,       // v1 FE 不发；钳制 1..=500
    state: State<'_, AppState>, app: AppHandle,
) -> Result<preview::FilePreview, String>
```

TS：`getFilePreview(path, options?: { sheetIndex?, offset?, limit? })`；`tauriBackend` 平铺 `invoke("get_file_preview", { path, sheetIndex, offset, limit })`。**FE 首版只发 `sheetIndex`**；Tauri v2 对缺省 `Option` 参数的行为【未验证】，联调时先用一次空调用确认（不成立就显式传 `null`）。

### 5.3 表头 / 行语义（已对齐，避免 off-by-one）

- `rows` **原样含全部行**；FE 默认把**前 1 行**冻结为表头，行数 N 可在 **0–10** 调整（纯客户端，不重取、不影响缓存）；N=0 时只显示列字母行、所有行都是数据；N≥2 时多行表头逐行冻结。
- 行号/`aria-rowindex`/截断统计**统一从 `normalizeTable(table, N)` 单点派生**（表头行数 = `max(1, N)`，数据行数 = `rows.length - N`，数据第一行号 = `N+1`）。
- BE 不做表头启发式（不猜语义）；完全空行跳过。
- xlsx 公式只给缓存值；合并单元格只给锚点值；日期/数字由 BE 统一格式化为显示文本（`as_string` 的显示格式需 spike 实测，不满意则 `as_datetime` + 现有 `chrono` 格式化）。

### 5.4 分页 / 加载更多

**v1 不做**（BE、FE 同结论）：只返回首页 500 行 + 明确截断提示；命令保留 `offset/limit` 以便后续扩展，但前端不发。未来要做必须返回稳定快照游标（裸 offset 在文件变化时会重/漏行），并给 identity 加 offset 维度。

### 5.5 与两份底稿的差异（Lead 裁决记录）

| 项 | BE 底稿 | FE 底稿 | 本文裁定 |
| --- | --- | --- | --- |
| 契约形状 | 扁平 `FilePreview` + `table` | 曾提判别联合，后改为照搬 BE | **扁平 + 可选 table**（兼容现有 `content/size/encoding` 访问，`backend.test.ts` 不用改） |
| `totalColumns` | 无 | 请求补（列截断文案需要） | **采纳**，可选字段 |
| `encoding` 提示 | `"GB18030（推测）"` 中文混排 | 英文界面会出中文 | **采纳 FE**：`encoding` 机器可读 + `encodingGuess:boolean` |
| 错误文案语言 | 文档用中文描述 | 担心中文进英文 UI | **Rust 返回英文短句**（沿用现有 `Result<_,String>` 直接展示的模式，不做错误码/前端映射） |
| `.tsv/.xlsm` | `.tsv` 锁 `\t`；xlsm 可预览 | mock 里 xlsm 不支持 | **支持**：`.tsv → format:"csv", delimiter:"\t"`；`.xlsm → format:"xlsx"`（只读值，不执行宏）；`.xls/.ods` 不支持 |
| 冻结表头行数 | 不判断，前端渲染 | 默认 1、可调 0–10 | **默认 1 行**；0 时只显示列字母行、全部行为数据；纯客户端不重取 |
| `sheetDimension`/`warnings` | 无（用 `truncatedReason`） | 可选展示 | **不加** v1（少一个漂移点；A1 区域后置） |

---

## 6. 前端渲染与 UX

### 6.1 渲染结构

- **原生 `<table>` 经统一 `ResizableTable` 包装**（非 `role=grid`，只读无单元格交互）：`th scope="col|row"`、`aria-rowcount/colcount`；`table-layout: fixed` + `colgroup` 列宽，每行布局 O(列数)；列宽拖拽复用 `useColumnWidths`/`ColumnResizer`（本地、不持久化），表头用共享组件的 sticky 模式保留冻结。
- 表头 `position: sticky`、`top = 行序 × 28px`（多行冻结表头逐行叠加，表头行高统一 28px）；首列行号/左上角 `sticky; left:0`（`.preview-line > span` 已证明 `contain:strict` 双向滚动容器内 sticky 可行，`preview.css:82-93`）。
- `@tanstack/react-virtual` **只做行虚拟化**：`estimateSize:24`、`overscan:8`、spacer `<tr>`（照抄 `LogView.tsx:422-427` 写法），固定行高因此不需要 `measureElement`/每行 ResizeObserver。
- **不做列虚拟化**：列上限 64（列字母 A…BL），64×160px ≈10,240px 横向滚动可承受；>128 列再议。
- DOM 量级：600px 视口 ≈41 渲染行 × 66 单元格 ≈ **2.7k 元素 / 5.4k 节点**；900px 视口 ≈3.6k 元素；滚动每步只换 1–3 行（≈66–200 元素）【估算】<2 ms。**32k 单元格 DOM 只会在"不做行虚拟化/BE 越界"时出现**，所以加渲染侧硬截断（500×64）兜底。
- 单元格：`white-space:nowrap` + ellipsis + `title`；超长按 BE 的 512 字符由后端截断，FE 不放大上限；`font-variant-numeric: tabular-nums`；行号/列字母等宽；**不做数字/日期识别**（不猜语义）。

### 6.2 组件与样式落点

```
src/features/browsers/
  previewTableModel.ts        # 纯函数：columnLetter / normalizeTable / estimateColumnWidth /
                              # physicalRowNumber / tableToTsv / truncationNotes / formatBytes
  components/PreviewTable.tsx # 原生 table + sticky + 行虚拟化
  components/PreviewTable.test.tsx
  components/FilePreviewPage.tsx # +table 分支/工具栏/footer/V09（约 +40 行，text/image 不动）
src/app/styles/preview.css    # .preview-table-scroll/-table/-gutter/-letter/-heading/-cell/
                              # -spacer/-notice/-select/-toggle/-stats
```

CSS 只用现有 token（`--panel/--panel-2/--border/--text/--muted/--hover/--accent/--accent-soft/--warning`），不新增颜色；不改全局表格样式（避免与已验收的 UI-04/UI-06 冲突）。

### 6.3 工具栏 / 提示 / 文案

- 工具栏：格式徽标（CSV/XLSX）、列×行、文件大小（自适应 KiB/MiB，110 MB 不能显示成 `107597.0 KiB`）、CSV 编码与分隔符、xlsx 工作表 `<select>`（`sheetNames.length>1` 才出现）、冻结表头行数步进器（0–10，默认 1）、spacer、大小；页签头不变，刷新仍走 `PageRefreshSlotContext`。
- 截断提示（`.preview-table-notice`，`role="note"`）：按 `truncatedReason/hasMore/rowCount` 生成中英文；CSV 总行数未知写"总行数未统计"。
- 空表 / 只有表头 / 未知 kind / 表格载荷畸形 / 越界 sheet / 超限 / 损坏文件：沿用现有 `role="alert"` / `role="status"` 模式；**必须补 `default` 分支**（当前未知 kind 落到 `:219` 空白）。
- 390px：`flex-wrap` + 隐藏编码/分隔符/大小等次要 chip（`.preview-toolbar-secondary`），横向滚动只发生在表格容器内，页面不得横向溢出。
- Mock 更新：`.csv/.tsv/.xlsx/.xlsm` 返回 `kind:"table"` 样例（含宽表/截断/空表/sheet 切换路径），文本正则里删掉 `csv`；`backend.test.ts:403-412` 扩 table 断言。
- 缓存：`identity = JSON([mode, context, target, sheetIndex])`；每 sheet 一条、仍受 3 份上限；切 target 用派生状态避免"旧 sheet + 新 target"错请求；`KEEP_PREVIEWS` 保持 3（表格比图片轻）。

### 6.4 右键菜单 V09（硬约束）

下一个空闲对象是 **V09**「本地表格预览内容（CSV/XLSX）」（已核：`catalog.ts` 现有 V01–V08，无 V09）。新增菜单必须**三处同 commit**，否则 `model.test.ts` 与 `pnpm validate:frontend-contracts` 直接红（已核脚本逻辑：设计总表 ↔ 注册表 ↔ 验收台账 的 ID 集合/顺序/数量完全一致）：`src/app/context-menu/catalog.ts`、`ForAIDoc/Designer/右键菜单对象与菜单项总表.md`、`ForAIDoc/Coder/右键菜单UI逐项验收台账.md`。首版建议 5 项：复制所选文本 / 全选 / 复制整表（TSV，懒计算）/ 复制文件路径 / 系统中定位+其他软件打开（后两项由 `useContentMenu` 统一注入）。

### 6.5 实施时必须同步的既有文档

`体验与界面规范.md:199-205`（预览一节加表格能力与上限）、`统一地址与对象工具栏.md:41`（"文本/图片工具"→"文本/图片/表格工具"）、`前端架构与维护约定.md:36-38,100`（域根文件加 `previewTableModel.ts`）、`全项目表格统一覆盖矩阵.md`（登记 T15 预览表格及"未接共享拖宽/表头 T08"的偏差理由，纳入 UI-06 滚动条矩阵）、`技术架构.md`（新增依赖与解析边界属架构决策，文档约定要求写入）、`核心功能实现说明.md`（实现批次落点）。

---

## 7. 安全边界与失败模式

| 面 | 要求 |
| --- | --- |
| workspace 路径限制 | **保持不变**：`canonicalize + starts_with(root)`；只接收已解析的本地路径；不新增"按 depot 路径直接读服务器" |
| zip bomb | 四重：条目数 ≤2,048 / 单条目 ≤256 MiB / 解压总量 ≤512 MiB / 压缩比 ≤200；**先读中央目录声明值再解压**，解压流上再套 `CountingReader` 硬上限（防声明值撒谎）；超限中止 |
| 解压落盘 | **永不落盘**：`ZipFile` 直接接 XML reader / calamine 内存流，不建临时目录 |
| XML/XXE | quick-xml 默认不处理 DTD/外部实体（本地源码已核），不启用额外 feature |
| 宏 / 公式 | `.xlsm` 可预览值；**永不调用 `vba_project()`**；只读缓存值，不实现公式引擎，不调用外部 Excel/COM |
| 体积/DoS | 读取缓冲 ≤64 KiB + 首页 ≤2 MiB 文本 + calamine sharedStrings/styles 受前置校验约束；`spawn_blocking` 内 `TABLE_DEADLINE=5s` 早停返回部分结果（Tauri invoke 无取消通道，不做跨线程强杀） |
| 错误信息 | 新错误统一英文短句 + 可选数值（"共 N 个工作表"），不回显 zip 条目名/XML 片段/绝对路径 |
| 前端 | 单元格全部按文本节点渲染，不用 `dangerouslySetInnerHTML`；不引入 SheetJS/zip 解析 |

---

## 8. 实施拆分、工作量与待拍板项

### 8.1 BE（3–5 人日；`src-tauri/**` 写域）

1. **S1 spike（已完成 2026-11-03，通过）**：`calamine=0.38.0` 接入独立工程，真实样本 + sharedStrings 压力测试见 `artifacts/research/preview-csv-xlsx/spike/RESULTS.md`：峰值内存 9.3–28.3 MB、`Xlsx::new` 9–179 ms、首 500 行 0.8–14.6 ms，**风险解除，走方案 A**。实现阶段只需补产品树 lock diff 与 exe 体积实测。
2. S2 结构：`preview.rs` 拆为 `app/preview/{mod,legacy,csv,table,xlsx}.rs`，`read()` 加 `TableSpec`/分派；常量按 §2 集中。
3. S3 CSV：编码级联 + 分隔符 + RFC4180 + 上限/超时；S4 XLSX：zip 前置校验 + calamine 流式 + 格式化。
4. S5 契约/命令：`commands.rs` 加 3 个 `Option` 参数；`FilePreview`/`TablePreview` serde；错误文案。
5. S6 测试：§9 的 Rust 单测（含 `zip::ZipWriter` 现造 xlsx 夹具，避免二进制夹具）+ `cargo test`/`clippy -D warnings`/`fmt`/binary 体积对比。

### 8.2 FE（6–7 人日；`src/**` 写域，可压到 4.5–5）

契约与 mock（0.5）→ `previewTableModel.ts`+单测（0.75）→ `PreviewTable.tsx`+CSS（1.5）→ `FilePreviewPage` 集成 + V09 + 文案（1.0）→ 缓存/生命周期（0.5）→ jsdom 测试（1.0）→ Playwright/axe + QA 合成视觉（1.0）→ 联调回归（0.5）。

### 8.3 顺序与门禁

BE S1~S4 完成后冻结 wire，FE 才能联调；V09 三处文档同 commit；门禁按仓库工作流：`pnpm check:web`、定向 vitest、`cargo test`、`clippy -D warnings`、`pnpm validate:frontend-contracts`、`format:check`；**本任务不涉及发布**，按敏捷通道记录证据即可（不发布、不打包）。

### 8.4 拍板状态与剩余决策

已拍板（2026-11-03）：① 路线 = 先 spike 再实施 → **spike 已通过，按 calamine 方案 A 实施**；② 用户已提供真实样本 `技能数据.xlsx`（3.3 MB，10 sheet）并完成实测。

实施中按以下默认值执行（如需改动请在实施前说）：

1. **格式口径**：`.tsv` 按 CSV（`\t`）、`.xlsm` 按 xlsx 只读值、`.xls/.ods` 首版不支持。
2. **V09 菜单**：按 5 项实施（复制所选文本 / 全选 / 复制整表（TSV）/ 复制文件路径 / 系统中定位+其他软件打开），三处文档由 LEAD 同步。
3. **视觉验收**：表格预览纳入 T15 / UI-04 / UI-06 矩阵，最终交给用户视觉验收。
4. **首版范围**：不做"加载更多/分页、列虚拟化、列宽持久化、手动编码/分隔符切换"（只显示首个有界页）；列宽拖拽按用户反馈已复用共享表格组件。
5. **数值格式（spike 新增）**：日期/时间按 Excel 显示；百分比/货币显示原始值（如 0.125），v1 接受并在页脚注明；若要求 Excel 观感，实现阶段再加 numFmt（+0.5–1 人日）。

---

## 9. 测试计划（摘要）

| 层 | 用例 |
| --- | --- |
| Rust 单测 | CSV：基本/引号/`""`/引号内 CRLF/LF-CRLF 混排/CRLF 跨缓冲边界/UTF-8 BOM/UTF-16 BOM/**GBK 字节**/各分隔符/`.tsv`/行截断 501→500/列截断 100→64/字段与单元格预算/空文件/非法二进制/超时注入。XLSX：用 `zip::ZipWriter` 现造最小工作簿（含 sharedStrings/inlineStr/数字/布尔/日期 numFmt/空 sheet/多 sheet 顺序/501 行/64 列/坏 zip/缺 workbook/sheet 越界/声明解压 300 MiB 的炸弹/dimension 不可信）；JSON wire 断言（table 时 `content:""`、text/image 无 `table` 键、序列化 ≤2.5 MiB）。表格模型：截断原因优先级、行归一化。 |
| e2e | 现有 `e2e.rs:7072-7122` 只覆盖 Shelf 预览；`get_file_preview` 无需真实 P4（不接触服务器），补一条本地临时 workspace 用例即可（不强制）。 |
| 前端 jsdom | 表头/列字母/行号、冻结表头行数 0/1/2（行号、多行 sticky top 偏移）、行虚拟化（视口内行数 < 全量）、截断文案三分支、sheet 切换（断言第二次调用 `{sheetIndex:1}`）、空表/只有表头/畸形 payload/未知 kind、错误、单元格截断、a11y 属性；纯函数单测（列字母 0/25/26/51/52/63、TSV、formatBytes）。 |
| Playwright/axe | 390px 无页面级横向溢出、表头冻结、行号冻结、sheet 键盘切换、`.file-preview-page` axe 零 violations；QA 合成视觉（浅/深色、64 列、截断、空表、sheet 切换）。 |
| Mock | `.csv/.tsv/.xlsx/.xlsm` 表格样例 + 宽表/截断/空表/sheet 路径；`backend.test.ts` 扩断言。 |

---

## 10. 证据、实测与未验证项

### 10.1 实测（`%TEMP%` 独立工程，离线，2026-11-03）

| 场景 | 结果 |
| --- | --- |
| 110,179,268 B CSV（120 万行×10 列）读前 500 行 | 仅读 65,536 B、解析 43,720 B、**316 µs** |
| 同上全量扫描（对照） | 129 ms（page cache）→ 支持"CSV 不统计总行数" |
| 7,086,075 B xlsx（解压 61,736,683 B，压缩比 8.72）读前 500 行 | 仅解压 **200,289 B**、**1,025 µs** |
| 同一 xlsx 中央目录扫描（不解压） | 303 µs |
| 同一 xlsx 全量解压 / 全量解析 | 41 ms / 202 ms → 证明必须早停 |
| 500×64 表格 JSON（典型/40 字符每格/128 列） | 471,287 B / 1,409,038 B / 961,382 B；500×64×512 字符极端值≈16 MB → 必须有 `CELL_TEXT_BUDGET` |
| Lead 独立复核（20 字符/格、中文） | 737,968 B / 1,249,968 B，与上表同量级 |
| **真实 xlsx spike**（3,311,864 B，10 sheet，最大 sheet XML 19.8 MB）首 500 行 | `Xlsx::new` 8.7 ms、33,430 格 / **14.6 ms**、峰值工作集 **9.3 MB** |
| **sharedStrings 压力**（`sharedStrings.xml` 11.86 MB，10 万唯一串） | `Xlsx::new` 164–179 ms、峰值 **28.3 MB**（≈2× XML）、首 500 行 0.8 ms |
| 同上按 `sharedStrings ≤24 MiB` 上限外推 | `Xlsx::new` ≈360 ms、峰值 ≈55 MB（可接受） |
| 真实 xlsx 全表读取（对照：477,850 格） | 306 ms、峰值 11.1 MB → 流式有界；证明不能走 `worksheet_range` |
| `as_string()` 日期/百分比 | 日期/时间正确（`2026-01-02`、`03:04:05`）；百分比/货币为原始数值（`0.125`）⚠️ |

### 10.2 外部来源

- encoding_rs：<https://crates.io/crates/encoding_rs>（0.8.44，Apache-2.0/MIT/BSD-3，rust 1.88）
- calamine：<https://crates.io/crates/calamine>、流式 API <https://docs.rs/calamine/0.38.0/calamine/struct.XlsxCellReader.html>（`worksheet_cells_reader` 已核）
- zip features：本地 `zip-9.1.3/Cargo.toml`（`deflate = deflate-zopfli + deflate-flate2-zlib-rs`）
- SheetJS：<https://registry.npmjs.org/xlsx/latest>、<https://docs.sheetjs.com/docs/getting-started/installation/nodejs/>
- RFC 4180：<https://www.rfc-editor.org/rfc/rfc4180>
- Tauri v2 IPC：<https://v2.tauri.app/concept/inter-process-communication/>
- Excel 规格上限（1,048,576 行×16,384 列、单元格 32,767 字符）：<https://support.microsoft.com/en-us/office/excel-specifications-and-limits-1672b34d-7043-467e-8e27-269d656771c3>

### 10.3 未验证（实现阶段必须补）

1. **新增依赖的 lock diff 与 release exe/安装包增量**（zopfli/zlib-rs/calamine；fresh resolve 会把 zip 解到 9.3.0，产品内可能保留 9.1.3）——接入产品树后 `cargo tree` + 构建对比。
2. Tauri v2 对缺省 `Option` 命令参数的行为（联调用一个空调用确认）。
3. sticky 表头/行号在 WebView2（及未来 WKWebView）的真实像素表现；2.7–4.4k 元素首帧耗时（jsdom 无法测）。
4. 390px 工具栏 chip 降级与 axe 的实际结果。
5. `tests/qa/preview-audit/` 现有脚本的可复跑性（FE 发现 `check-json.mjs` 相对路径与专用 vite 配置可能已漂移，未执行）。

已由 spike 解决：`Xlsx::new` 峰值内存与耗时（见 §4.3/§10.1）、`as_string()` 日期/显示格式（日期正确、百分比/货币为原始值）。

---

## 附录：两份底稿

- `artifacts/research/preview-csv-xlsx/be-findings.md`：Rust 侧完整推导（现状、候选对比、上限表、契约/Rust 结构草案、安全、12+12 条测试、风险表、实测附录）。
- `artifacts/research/preview-csv-xlsx/fe-findings.md`：前端侧完整推导（契约落地口径、渲染/DOM 估算/CSS 类名、UX 文案表、缓存、V09 三处联动、mock/测试/工作量、12 个开放问题）。
- 本文只做汇总与裁决，不替代两份底稿的实现细节；两份底稿不入库（`artifacts/` 被 `.gitignore` 忽略），如需长期保留应择要并入 `Coder/` 文档。
