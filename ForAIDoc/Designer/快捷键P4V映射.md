# 快捷键 P4V 映射（KEY-01-1 研究）

> 目标：为《Windows本机私用TODO》KEY-01 子项①给出可执行的 P4V（Windows）默认快捷键 → P4Deck 命令映射规格，供 KEY-01-2（实现）、KEY-01-3（Settings 编辑区）、KEY-01-4（持久化）使用。
>
> 范围：只做研究/文档，不改产品代码。P4Deck 当前命令目录为 `src/app/commands/catalog.ts`（37 个生产命令、7 个已绑定快捷键）。

## 0. 结论摘要

1. **P4V 默认键位可完整获得**：以 Perforce 官方 P4V 2023.2/2023.3 指南为准（本机安装 P4V **2023.2.246.7475**，见 `C:\Program Files\Perforce\p4v.exe`）；没有访问任何生产 P4 服务。
2. **P4Deck 可迁移 17 项只读/导航键位**（其中 7 项复用已有命令、3 项新增页面命令、1 项新增地址栏聚焦命令，其余为已有命令补键位）；新增/复用后 P4V 侧最常用的“视图切换 + 查看 + 刷新”基本对齐。
3. **写操作（mutation）一律不迁移**：现有设计规范《统一Action刷新与通知》明确“mutation 不分配直接快捷键”，`catalog.test.ts` 也有同断言（`mutation` 无 `shortcut` 且必须回状态机）。P4V 的 Ctrl+E/Ctrl+S/Ctrl+R/Ctrl+Shift+G/Ctrl+L/Ctrl+U 因此**有意不绑定**，只保留工具栏/命令面板入口与原有 preflight/确认；如用户坚持要绑，需 Lead **明确变更该安全口径**后再做（见 §7 待确认点 D1）。
4. **快捷键本身不绕过风险**：`commandForShortcut` 只负责把按键解析成命令 ID，最终仍走 `App.executeAppCommand` → `CommandBar.executeCommand`；mutation 命令即使未来被绑定，也只会打开原有确认/预检对话框，不存在绕过路径。阶段 2 的测试会固化“快捷键分发与命令面板/工具栏同一条执行链”。
5. **P4Deck 保留既有 7 个快捷键不变**（含 `view.refresh=Ctrl+R`）；P4V 的 Ctrl+R=Revert 与它冲突，按“不回归现有行为”原则**让位**：P4Deck 的 Revert 不绑快捷键，刷新额外补 F5（P4V 的 Refresh All）。
6. **同名键冲突已识别**：Ctrl+Shift+P 在 P4V 是 Push、在 P4Deck 是命令面板 → 保留命令面板；浏览器/WebView 保留键（Ctrl+1..8、Ctrl+T、Ctrl+S、Ctrl+P、Ctrl+Shift+R、F5 等）只在桌面 Tauri 目标下验收，Web 演示模式可能被浏览器抢键（见 §5）。

## 1. 来源与方法

| 来源 | 用途 | 链接 |
| --- | --- | --- |
| P4V 2023.2 指南 `using.access-keys` | 本机安装版本对应的默认键位全集 | <https://www.perforce.com/manuals/v23.2/p4v/Content/P4V/using.access-keys.html> |
| P4V 2023.3 指南 `using.access-keys` | 交叉核对键位表 | <https://www.perforce.com/manuals/v23.3/p4v/Content/P4V/using.access-keys.html> |
| P4V 2023.3 指南 `configuring.preferences.shortcuts` | Alt+L 默认键、Restore Defaults/Use Default 语义 | <https://www.perforce.com/manuals/v23.3/p4v/Content/P4V/configuring.preferences.shortcuts.html> |
| 本机 P4V 安装 | 确认版本 2023.2.246.7475（不执行、不连接服务器） | `C:\Program Files\Perforce\p4v.exe` |
| P4Deck 代码/设计文档 | 现有命令、分发、保护、设计口径 | `src/app/commands/catalog.ts`、`src/app/App.tsx`、`ForAIDoc/Designer/统一Action刷新与通知.md` |

**文档自身的不一致（已记录，不作为 P4Deck 实现依据）**：

- Lock/Unlock：`Common shortcut keys` 表写 Ctrl+Shift+L / Ctrl+Shift+U；`Default shortcut keys` 表写 Ctrl+L / Ctrl+U。两表同版本互相矛盾。
- Fetch 与 Show Timelapse 都写 Ctrl+Shift+T（`Common shortcut keys` 表重复）；`Default shortcut keys` 表把 Ctrl+Shift+T 归给 Time-lapse。
- Jobs 行 `Default shortcut keys` 表 Mac=Ctrl+6、Windows=Ctrl+5，与 Windows 上 Ctrl+5=Workspaces 冲突（官方表笔误）。
- 本机 P4V 的最终键位以用户 Preferences → Shortcuts 页实际显示为准；P4Deck 对上述歧义项**均不迁移**（Lock/Unlock 属 mutation，Time-lapse/Jobs 无对应功能），因此不影响本规格。

## 2. P4V 默认快捷键全集（Windows）与处理结论

图例：**迁移** = 阶段 2 绑定；**复用** = 命令已存在只加键位；**新增** = 需要新命令；**不迁移** = 明确不绑定并给出理由。

### 2.1 视图/页面切换

| P4V 键位 | P4V 动作 | P4Deck 处理 | 命令 ID / 备注 |
| --- | --- | --- | --- |
| Ctrl+9 | View Depot Tree | **迁移（新增）** | `view.files`（新增命令，打开 Files 页） |
| Ctrl+0 | View Workspace Tree | 不迁移（阶段 2 之外） | Files 页的 depot/workspace 由地址栏决定，没有“带 scope 参数”的页面命令；如要做需给命令加 target 参数 |
| Ctrl+1 | View Pending Changelists | **迁移（复用）** | `view.pending` 补键位 |
| Ctrl+2 | View Submitted Changelists | **迁移（复用）** | `view.submitted` 补键位 |
| Ctrl+3 | View Branch Mappings | **迁移（新增）** | `view.branchMappings`（PageId 已有 `branchmappings`） |
| Ctrl+4 | View Labels | 不迁移 | P4Deck 无 Labels 页/命令 |
| Ctrl+5 | View Workspaces | **迁移（复用）** | `view.workspaces` 补键位 |
| Ctrl+6 | View Jobs | 不迁移 | P4Deck 无 Jobs 页 |
| Ctrl+7 | View Streams | **迁移（复用）** | `view.streams` 补键位 |
| Ctrl+8 | View Remote Mappings | 不迁移 | P4Deck 无 Remote Mappings 页 |
| （无默认键） | Stream Graph | **迁移（新增）** | `view.streamgraph`，P4V 用 Ctrl+Shift+M 打开 Stream Graph（官方默认表） |
| Ctrl+Shift+M | Show in Stream Graph | **迁移（新增）** | `view.streamgraph` 键位 |

### 2.2 刷新 / 查找 / 地址

| P4V 键位 | P4V 动作 | P4Deck 处理 | 命令 ID / 备注 |
| --- | --- | --- | --- |
| F5 | Refresh All | **迁移（复用）** | `view.refresh` 增加别名 F5（主键位仍 Ctrl+R，不回归） |
| Ctrl+Shift+F | Find File | **已覆盖** | `view.search` 现为 Mod+Shift+F，与 P4V 一致 |
| Ctrl+F | Find（当前视图内查找） | 不迁移（阶段 2） | P4Deck 无全局 in-place find；保留浏览器/WebView 原生查找，后续可加“聚焦当前列表筛选”命令 |
| Alt+L | Jump to Address Bar（Windows；官方默认） | **迁移（新增）** | `navigation.focusAddress`（新增命令，聚焦统一地址栏） |
| Ctrl+G | Go To（跳转到 spec） | **迁移（新增，近似）** | 同一命令 `navigation.focusAddress` 作为别名；P4Deck 地址栏当前主要解析路径，CL/标签号跳转属后续增强（语义近似，文档标注） |

### 2.3 文件查看（只读）

| P4V 键位 | P4V 动作 | P4Deck 处理 | 命令 ID / 备注 |
| --- | --- | --- | --- |
| Ctrl+D | Diff selected file | **迁移（复用）** | `file.diff` 补键位（需单文件选中；无目标时按 `appCommandReason` 静默不可用） |
| Ctrl+Shift+D | Diff Against | **迁移（别名，近似）** | `file.diff` 别名；P4Deck 只有一个 diff 入口，不复刻 P4V 的“选择基准版本”分支 |
| Ctrl+T | Revision history | **迁移（复用）** | `file.history` 补键位（浏览器里 Ctrl+T 为新标签页，见 §5） |
| Ctrl+Shift+R | Revision Graph | **迁移（复用）** | `file.revgraph` 补键位（浏览器里 Ctrl+Shift+R 为强制刷新，见 §5） |
| Ctrl+Shift+S | Show in Explorer | **迁移（复用）** | `file.reveal` 补键位（浏览器里 Ctrl+Shift+S 为“另存为”，见 §5） |
| Ctrl+Shift+T | Show Time-lapse View | 不迁移 | P4Deck 无 Time-lapse 视图 |
| Ctrl+Shift+C | Copy depot path | 不迁移（阶段 2） | 地址行已有“复制地址”按钮；如后续要做，新增 `navigation.copyAddress` 更合适 |
| Ctrl+P | Print | 不迁移 | 无打印功能 |
| F1 | Open P4V Help | 不迁移 | 无内置帮助/快捷键帮助页 |

### 2.4 写操作（mutation，全部不迁移）

| P4V 键位 | P4V 动作 | P4Deck 等价命令 | 处理 |
| --- | --- | --- | --- |
| Ctrl+E | Check out file | `file.checkout` | 不迁移：mutation 不分配直接快捷键（既有设计口径 + 安全） |
| Ctrl+S | Submit | `changelist.submit` | 不迁移：同上（且 Ctrl+S 在浏览器为“保存网页”） |
| Ctrl+Shift+G | Get Latest Revision | `workspace.sync` | 不迁移：同上 |
| Ctrl+R | Revert selected files | `file.revert` | 不迁移：与既有 `view.refresh=Ctrl+R` 冲突，保留刷新语义 |
| Ctrl+L / Ctrl+Shift+L | Lock files | `file.lock` | 不迁移：mutation；且官方两表键位不一致 |
| Ctrl+U / Ctrl+Shift+U | Unlock files | `file.unlock` | 不迁移：同上 |
| Ctrl+N | Create new specification | 无 app command | 不迁移：P4Deck 新建 CL 入口在页面/对话框，尚未注册为命令 |
| Ctrl+O | Open a new connection | `connection.manageProfiles` | 不迁移：连接流程在 TopBar/Settings 受控入口，命令本身不执行 |
| Ctrl+Shift+I | Initialize Personal Server | — | 不迁移：无对应功能 |
| Ctrl+Shift+A | Open P4Admin | — | 不迁移：无对应功能 |
| Ctrl+Shift+P | Push（DVCS） | （占用） | 冲突：P4Deck 该键是命令面板，保留命令面板；P4V 的 Push 不适用 |

### 2.5 编辑/剪贴板/系统键（不迁移，保留原生）

| P4V 键位 | P4V 动作 | 处理 |
| --- | --- | --- |
| Ctrl+A / Ctrl+C / Ctrl+X / Ctrl+V / Ctrl+Z / Ctrl+Y | 全选/复制/剪切/粘贴/撤销/重做 | 不迁移：保留浏览器/系统原生编辑语义，尤其不能在输入框（地址栏、搜索框、对话框）内被应用级快捷键截获 |
| Ctrl+F4 / Ctrl+W | Close current window | 不迁移：P4Deck 关窗有受控 close guard，不做快捷键（避免误关） |
| Alt+F 等 | 菜单 access keys | 不迁移：P4Deck 无 Windows 原生菜单栏（已按验收反馈移除） |

## 3. P4V → P4Deck 映射总表（阶段 2 规格）

| 序号 | P4V 键位 | P4Deck 命令 ID | 现状 | 阶段 2 动作 | 风险/保护 |
| --- | --- | --- | --- | --- | --- |
| 1 | Ctrl+9 | `view.files` | **需新增命令** | 新增命令（openPage files）+ 键位 | 只读导航；编辑焦点内不触发 |
| 2 | Ctrl+1 | `view.pending` | 已有命令 | 补键位 | 只读导航 |
| 3 | Ctrl+2 | `view.submitted` | 已有命令 | 补键位 | 只读导航 |
| 4 | Ctrl+3 | `view.branchMappings` | **需新增命令** | 新增命令 + 键位 | 只读导航 |
| 5 | Ctrl+5 | `view.workspaces` | 已有命令 | 补键位 | 只读导航 |
| 6 | Ctrl+7 | `view.streams` | 已有命令 | 补键位 | 只读导航 |
| 7 | Ctrl+Shift+M | `view.streamgraph` | **需新增命令** | 新增命令 + 键位 | 只读导航 |
| 8 | F5 | `view.refresh` | 已有键位 Ctrl+R | 增加别名 F5，主键位不变 | 幂等只读；浏览器 F5=刷新页需先 preventDefault |
| 9 | Ctrl+Shift+F | `view.search` | 已覆盖 | 无改动 | 与现有键位一致 |
| 10 | Ctrl+D | `file.diff` | 已有命令 | 补键位 | 只读；需单文件目标；浏览器书签冲突 |
| 11 | Ctrl+Shift+D | `file.diff` | 已有命令 | 增加别名（近似 Diff Against） | 同上 |
| 12 | Ctrl+T | `file.history` | 已有命令 | 补键位 | 只读；浏览器新标签页冲突 |
| 13 | Ctrl+Shift+R | `file.revgraph` | 已有命令 | 补键位 | 只读；浏览器强制刷新冲突 |
| 14 | Ctrl+Shift+S | `file.reveal` | 已有命令 | 补键位 | 只读；浏览器“另存为”冲突；桌面才可用（本地系统能力检查仍生效） |
| 15 | Ctrl+I | `view.diagnostics` | 已有命令 | 补键位 | 只读 |
| 16 | Alt+L | `navigation.focusAddress` | **需新增命令** | 新增命令（聚焦地址栏）+ 键位 | 只读；不改变当前选择对象（与《统一地址与对象工具栏》一致） |
| 17 | Ctrl+G | `navigation.focusAddress` | 同上 | 增加别名（近似 Go To） | 近似：地址栏解析路径；CL/标签 spec 跳转后续增强 |
| 18 | Ctrl+E/Ctrl+S/Ctrl+Shift+G/Ctrl+R/Ctrl+L/Ctrl+U | 对应 mutation 命令 | 已有命令 | **不绑定**（见 §2.4 与 §7 D1） | 防止误触写操作；保留确认/预检入口 |

合计：迁移 17 项（含 2 组别名），新增命令 4 个（`view.files`、`view.branchMappings`、`view.streamgraph`、`navigation.focusAddress`），命令总数 37 → 41；已绑定快捷键 7 → 约 22 条（含别名）。

## 4. 现有 7 个快捷键回归清单（阶段 2 必须保持）

| 命令 ID | 键位 | 行为 | 阶段 2 要求 |
| --- | --- | --- | --- |
| `app.commandPalette` | Mod+Shift+P | 打开命令面板；`allowInEditable` | 不变 |
| `view.refresh` | Mod+R | 刷新当前数据 | 不变；新增 F5 别名 |
| `view.search` | Mod+Shift+F | 打开全局搜索 | 不变 |
| `tools.openTerminal` | Mod+Alt+T | 打开 Terminal；`allowInEditable` | 不变 |
| `tools.openP4Log` | Mod+Alt+L | 打开 P4 Log；`allowInEditable` | 不变（注意与 P4V 的 Alt+L 地址栏区分：P4Deck 是 Ctrl+Alt+L） |
| `view.settings` | Mod+, | 打开 Settings | 不变 |
| `panel.dockBack` | Mod+Alt+D | 停靠回主窗口 | 不变 |

## 5. 冲突与不迁移清单（完整）

### 5.1 与既有 P4Deck 键位的冲突

| 冲突 | 处理 | 理由 |
| --- | --- | --- |
| P4V Ctrl+R = Revert ↔ P4Deck Ctrl+R = Refresh | P4Deck 保留 Refresh；Revert 不绑 | “不破坏现有 7 个快捷键”硬约束；刷新使用频率高 |
| P4V Ctrl+Shift+P = Push ↔ P4Deck = 命令面板 | 保留命令面板 | Push 属 P4V DVCS 功能，P4Deck 无；命令面板是本产品核心入口 |
| P4V Alt+L = 地址栏 ↔ P4Deck Ctrl+Alt+L = P4 Log | 两者共存（不冲突，P4Deck 是 Ctrl+Alt+L） | 无冲突，但文档/设置里要显示完整修饰键避免误读 |

### 5.2 浏览器/WebView 保留键（Web 演示模式）

P4Deck 主目标是 Tauri 桌面（WebView2）；Web 演示仅用于开发/QA。以下键在浏览器里可能被浏览器抢占，`preventDefault` 不保证生效：

| 键位 | 浏览器默认行为 | 影响 | 处理 |
| --- | --- | --- | --- |
| Ctrl+1..8 | 切换标签页 | Web 演示下视图切换可能失效 | 桌面验收；Web 演示不作为验收口径 |
| Ctrl+9 | 切到最后一个标签页 | 同上 | 同上 |
| Ctrl+T | 新标签页（Chrome 保留） | `file.history` 可能打不开 | 同上；桌面可用 |
| Ctrl+Shift+R | 强制刷新 | `file.revgraph` 可能变刷新 | 同上 |
| Ctrl+Shift+S | 网页另存为 | `file.reveal` 可能被抢 | 同上；桌面可用 |
| Ctrl+S | 保存网页 | 预留（mutation 不绑，无影响） | — |
| Ctrl+D | 加入书签 | `file.diff` 可能被抢 | 桌面验收 |
| Ctrl+P | 打印 | 不迁移，无影响 | — |
| Ctrl+F | 查找 | 不迁移，保留原生查找 | — |
| F5 | 刷新网页 | `view.refresh` 别名可能变成整页刷新 | 桌面可用；实现时先 `preventDefault`，Web 演示仍可能受限 |

**实现建议**：快捷键在任何环境都注册并用 `event.preventDefault()` 拦截；验收只以 Windows Tauri 桌面为准（与既有《统一Action刷新与通知》的“外部项”一致，不把 jsdom 当原生通过）。

### 5.3 Windows 系统键 / 输入法

| 项 | 结论 |
| --- | --- |
| Win+*、Ctrl+Alt+Del、Ctrl+Shift+Esc 等 | 本规格未使用，无冲突 |
| Ctrl+Shift+L / Ctrl+Shift+U（若未来绑定 Lock/Unlock） | 部分输入法/旧的键盘布局切换使用 Ctrl+Shift；阶段 2 不绑定，风险仅记录 |
| Alt+L（地址栏） | 原生应用里 Alt+字母 可能触发菜单；P4Deck 无原生菜单栏，WebView 内由页面处理；中文输入法下 Alt+字母一般不进候选窗 |
| 输入框保护 | 新增键位一律 `allowInEditable=false`；`isEditable` 覆盖 input/textarea/select/contenteditable/[role=textbox]；已有 `allowInEditable=true` 仅命令面板/Terminal/P4 Log 三个 |
| 平台差异 | 数据里统一写 `Mod`，Windows/Linux 解析为 Ctrl、macOS 解析为 Cmd（现有 `normalizedShortcut` 已实现）；F5 在 macOS 需 Fn+F5，属系统行为，保留 Mod+R 作为 Mac 兼容主键位 |
| 独立窗口（detached） | 新增页面命令沿用 `requires:"mainWindow"`，独立窗口内静默不可用并给原因（现有 `appCommandReason` 行为） |

## 6. 阶段 2 实现建议（供批准）

1. **数据模型**：`AppCommandDefinition` 保留 `shortcut?: string` 作为主键位（Settings 可编辑/持久化对象），新增 `aliases?: readonly string[]`（默认别名，只读展示；不参与用户编辑，参与冲突检测与分发）。这样既满足 P4V 双键位（F5/Ctrl+R、Ctrl+D/Ctrl+Shift+D、Alt+L/Ctrl+G），又不改变命令面板与后续 Settings 的“当前键”单值语义。
2. **新增命令**（4 个，`requires:"mainWindow"`，page 执行）：
   - `view.files` → `{ kind: "page", page: "files" }`
   - `view.branchMappings` → `{ kind: "page", page: "branchmappings" }`
   - `view.streamgraph` → `{ kind: "page", page: "streamgraph" }`
   - `navigation.focusAddress` → App.tsx 内 `window.dispatchEvent(new Event("p4deck:focus-address"))`；CommandBar 监听并 `focus()`/`select()` 地址输入框（与现有 `p4deck:open-settings` 事件模式一致；不改 CommandId union，不动写操作）。
3. **分发**：`commandForShortcut` 匹配 `shortcut` + `aliases`，其余逻辑（平台修饰键过滤、editable 保护、返回唯一 ID）不变；`shortcutConflicts` 同时检查主键位与别名，返回可读冲突串。
4. **文档同步**：更新 `ForAIDoc/Designer/统一Action刷新与通知.md`（命令数 37→41、快捷键列 + mutation 说明），否则 `validate:frontend-contracts` 会因“Action documentation omits production commands”失败（脚本按反引号 ID 校验，不改脚本）。
5. **测试**：
   - `catalog.test.ts`：新增每个 P4V 键位的解析断言（Windows/Mac 各一遍）、别名解析、编辑焦点保护、跨平台冲突为空、mutation 仍无 `shortcut`/`aliases`；保留现有 Windows/macOS/编辑框用例。
   - `App` 分发：用现有 App 测试（或新增最小用例）证明按键 → `executeAppCommand` → 目标 page/shell 命令；mutation 命令（若未来绑定）仍进 CommandBar 状态机。
   - 地址栏：CommandBar 测试断言 `p4deck:focus-address` 事件后 input 获得焦点。
   - 负向：浏览器保留组合键在 jsdom 下能解析（说明拦截靠 preventDefault，不依赖浏览器行为）。
6. **不做**：Settings 编辑区（阶段 3）、持久化（阶段 4）、任何 mutation 键位、Windows 原生菜单镜像。

## 7. 需 Lead/用户确认的点

- **D1（关键）**：P4V 的写操作键位（Ctrl+E 签出、Ctrl+S 提交、Ctrl+Shift+G 获取最新、Ctrl+R 还原、Ctrl+L/U 锁/解锁）是否要绑定？
  - **建议 A（默认，本文档按此规格）**：不绑定，保持《统一Action刷新与通知》“mutation 不分配直接快捷键”口径；原因：误触写操作风险、与既有测试/doclint 一致、P4Deck 已有确认链。
  - 备选 B：绑定但必须证明仍走原确认对话框（`executeAppCommand` → `CommandBar.executeCommand`）。若选 B，需要改设计文档口径与 `catalog.test.ts` 断言，属于安全口径变更，需 Lead 明确批准后再实施。
- **D2**：`Ctrl+G` 作为地址栏别名（近似 P4V “Go To spec”）。若要求严格语义，可暂不绑 Ctrl+G，只保留 Alt+L；CL 号跳转待地址栏增强。
- **D3**：`view.refresh` 主键位保留 Ctrl+R（不回归）且只加 F5 别名，是否符合“P4V 对齐”预期。
- **D4**：浏览器/Web 演示模式下保留键被抢占，验收只认 Windows Tauri 桌面（是/否）。

## 8. 验收对照（KEY-01-1）

| 验收要求 | 本文档落点 |
| --- | --- |
| 覆盖 P4V 主要快捷键（菜单/工具栏/面板/树/提交/Resolve/History/Diff） | §2 全集表 + §3 映射总表（视图/刷新/地址/查看/写操作/编辑系统键） |
| 每项有处理结论 | §2、§3 每行均有“迁移/不迁移/复用/新增 + 理由” |
| 冲突清单完整 | §5.1 既有键位冲突、§5.2 浏览器保留键、§5.3 Windows/IME/平台/独立窗口 |
| 输出到 `ForAIDoc/Designer/快捷键P4V映射.md` | 本文件 |
| 只研究、不改产品代码 | 本次唯一写入为本文件 + 证据备份清单 |

## 9. 证据

- 备份/基线：`artifacts/evidence/key01/backup/round1/`（阶段 2 动工前文件快照 + sha256 清单）。
- 本文件 sha256 与命令目录基线 hash 记录在同目录 `baseline.json`。
