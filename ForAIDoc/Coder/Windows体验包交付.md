# Windows 体验包交付

> 2026-10-27 用户已明确要求：主题色与CL严格批量追踪完成后，制作可在其他设备使用的体验包，由用户自行转发。唯一任务为 [Windows本机私用TODO](../PM/Windows本机私用TODO.md) 的 PKG-01。本文件是实施和证据标准，不是已产出或已验收证明。

## 当前打包入口（2026-10-29 改造后）

> 本节描述当前可用的命令行入口，取代下文历史过程记录里的手工 staging 做法；历史记录保留原文，不再作为流程模板。

```powershell
pnpm package:desktop:win                            # NSIS 安装包，默认 WebView2 bootstrapper
node scripts/package-desktop.mjs --offline-webview2 # 内嵌离线 WebView2 安装器
```

- 入口脚本为 `scripts/package-desktop.mjs`：先执行 `pnpm validate:versions` 校验版本一致，再执行 `tauri build --bundles nsis --ci`，并把本次新生成的安装包复制到 `artifacts/delivery/P4Deck-<version>-<commit7>[-offline]/`。
- 交付目录固定包含：NSIS 安装包（`.exe`）、`SHA256SUMS.txt`、`使用说明.txt`、`artifact-info.json`。`artifact-info.json` 记录 version、versionSource、gitHead、gitDirty、builtAt、platform、node、tauriCli、command、bundle、WebView2 模式、签名状态（当前为 `unsigned`）、安装包 name/sizeBytes/sha256 以及交付文件清单。
- WebView2 两种模式：默认 `downloadBootstrapper`（安装时联网下载，包体小）；传 `--offline-webview2` 时改用 `offlineInstaller` 覆盖层 `src-tauri/tauri.package.offline.conf.json`（约 215MB，安装无需联网），交付目录名带 `-offline` 后缀。NSIS 基础配置位于 `src-tauri/tauri.windows.conf.json`（`targets=["nsis"]`、currentUser 安装、`useLocalToolsDir`、`installerIcon`），由 Tauri 平台配置自动合并；默认 WebView2 模式也在这里。
- 版本与脏树策略：版本仍以 `package.json`、`tauri.conf.json`、`Cargo.toml` 三处一致为准，`pnpm validate:versions` 不一致即失败；`scripts/build-desktop.mjs` 与 `scripts/package-desktop.mjs` 默认拒绝脏工作树，确需时显式传 `--allow-dirty`，该标记会写入 `artifact-info.json`。
- `pnpm build:desktop:win` 走 `scripts/build-desktop.mjs`，只做 `tauri build --no-bundle` 并复制独立 exe 到 `artifacts/desktop/`，同时写 `artifact-info.json`；它不是安装包，不能作为体验包交付。
- `artifacts/` 整体被 Git 忽略；旧的 `artifacts/package-*`、`frozen-source-*` 目录仍留在磁盘，但不再进入版本库。下文 0.1.2 的交付记录属于人工 staging 产物，只作历史证据保留，不再作为当前流程模板。

## 新增实现与运行批准边界

本轮又新增CL-05 Pending编号数值升/降序与UI-06全局横纵滚动条统一，均已交FE、待证据；验收包括Default位置、选择/展开/菜单拖放不变且无额外查询，以及表格/弹窗/侧栏/预览的浅深主题对比、边界、hover/active。JSON/Branch修复、无配置引导继续；0.1.2不含这些新增改动。视觉server批准未回复，暂不打包，不把旧包hash与旧视觉证据当新批次验收。

新增CON-05无配置强制启动引导由FE实现/mock：配置加载结束才判断，无有效激活配置进入设置连接区，验证成功放行；设置/CLI获取/退出可用，已有配置暂时断网不是首次。与Branch叠字及JSON空白修复并行，最终集成验证须绑定共同的新源码。0.1.2包不视为包含这些新增修复；其既有hash记录不变。视觉专用隔离入口运行批准仍待用户，不从功能授权推导运行许可；暂不打新包。

## 新增反馈与版本影响待确认

候选交付后收到用户报告：他人机器Branch Mapping列表UI重叠，本机未复现。根核对截图为81/81条、多行约10px间隔叠字、底两行正常、外围UI正常。实际运行版本/环境与0.1.2影响尚未确认；不将本反馈写成已证实的0.1.2回归，也不沿用代表表视觉证明该列表正常。FE仅核查此缺陷及mock视觉，实验/修后证据待回报；没有自动发布新包的授权。下面包hash与未验边界保持。

## 0.1.2候选实际交付记录（2026-10-28）

- 包体：[P4Deck_0.1.2_x64-setup.exe](../../artifacts/package-0.1.2-20261028/delivery/P4Deck_0.1.2_x64-setup.exe)，223452134 bytes。
- SHA-256：`46BD93F1891E05781F8EAC558F2D38D15C4C7C6409FF9E8579E5796FE04C2F0D`。PM已独立读取文件大小并计算hash，均与[artifact-info.json](../../artifacts/package-0.1.2-20261028/artifact-info.json)一致。
- 构建证据：artifact-info记录version=0.1.2、architecture=x64、buildExit=0；根转发BE staging TS、生产前端、Rust release、NSIS均通过，源码变化0，检查标记未命中。后几项为根转发证据，PM未重跑构建。
- 运行依赖：包内微软离线WebView2安装器签名有效；不捆绑P4 CLI，复用配置/PATH/标准安装目录统一发现，缺失提供官方获取与重新检测，自定义路径可能需用户指定。这不是无需任何配置或无需确认条款的保证。
- 签名与验收：P4Deck安装包`NotSigned`，不能把微软运行时签名称为应用签名。installationTested=false、applicationLaunched=false、productionP4Access=false；干净安装、启动、卸载和跨设备均未验。候选已产出不等于完全验收，更不保证接收设备直接可用。
- 用户已获包位置与未验限制。PKG-01更新为已实现待验收，不归档完成；本次仅同步记录后停止，其他项目保持停工。以下打包待构建/待hash等描述均为此前过程记录，不覆盖本节实际交付事实。
- 本节为 0.1.2 人工 staging 交付的历史记录，保留原包、hash 与未验边界；当前打包已改由 `scripts/package-desktop.mjs` 生成，不复用当次流程。

## 范围与当前静态事实（配置事实为首次静态核对快照）

本次限 Windows 体验包，不扩大到macOS/ARM64、公开release、自动更新或生产P4验收。目标暂按已有 Windows 11 x64 基线；接收设备的系统和架构尚未确认，不能承诺所有设备可用。不push、不上传、不代用户发送。

- `src-tauri/tauri.conf.json`：版本0.1.0、identifier为dev.p4deck.desktop、bundle active且targets=all、createUpdaterArtifacts=false；Windows 特有 bundle 配置（NSIS、currentUser 安装、WebView2 模式、installerIcon、useLocalToolsDir）位于 `src-tauri/tauri.windows.conf.json`，由 Tauri 平台配置自动合并；仍未配置 Windows 代码签名、额外资源或 P4 CLI sidecar。
- 历史脚本 `scripts/build-desktop.ps1` 已删除（当时它实际执行 `tauri build --no-bundle`，仅复制release exe到artifacts/desktop，不能当成安装包流程；package.json对应包装入口还使用了ExecutionPolicy Bypass）。当前对应入口是 `node scripts/build-desktop.mjs`（独立 exe）和 `node scripts/package-desktop.mjs`（NSIS 安装包），且不再用 Bypass 包装规避执行策略。
- 本地安装的Tauri CLI配置schema支持nsis/msi。默认使用 downloadBootstrapper，`--offline-webview2` 切换 offlineInstaller；`useLocalToolsDir` 会把 NSIS 工具缓存在 `src-tauri/target/.tauri`，本机已验证首次下载成功后可复用。默认配置不能证明断网缺WebView2时可安装；两种 WebView2 模式在干净设备上的实机安装仍待验收。
- 项目已有文档记录WebView2为运行依赖，P4 CLI为P4功能依赖。Node/pnpm/Rust/MSVC属于构建机依赖，不应要求体验者安装开发工具。P4 CLI尚无随包分发方案，不从本机.local拷入fixture工具或数据；最低兼容版本须由BE根据新增命令门禁提供证据。
- Windows代码签名和安装/卸载验收无已完成记录。不得将updater签名公钥误称为Windows Authenticode签名。
- 新用户无应用配置也不足以证明无生产连接：ContextStore有环境回退，必须同时验证Profile、恢复队列、P4环境/注册表/配置/凭据来源及启动自动请求行为。

## 最新证据与未满足门槛

最新授权与执行方案：用户“好的，现在打包吧”，根已交BE恢复最新最终候选构建。离线WebView2自动处理；P4 CLI优先被动检测已有，缺失时提供官方获取引导，由接收者确认条款，不夹带未知许可CLI。仅最小补齐发现/缺失引导，不扩产品；PM不执行构建。该方案覆盖下方“CLI方案待答复”及必须随包CLI的旧解释：并未获得CLI再分发许可，不宣称完全离线无交互。实际首次运行是否达到用户体验目标仍需验证，缺CLI引导不得冒称CLI已可用。

版本证据待BE提供：最终源码/版本及输入manifest、构建退出结果、包名/大小/SHA-256、WebView2版本与来源签名、P4 CLI检测/缺失行为和随包内容清单。实际安装/启动/卸载仍未验，候选包不能称为已跨设备验证；只使用证明隔离的验证入口，禁止生产连接。旧skip包不可发，其他项目仍停工。

最终输入更新中：根已确认FE完成本地时间展示小改（本地年月日时分，调查范围/读取时间不显示UTC/ISO/时区说明；内部query边界不变）。范围起止均formatLocalTime，读取/提交时间本地化，toISOString仅内部query；本批3文件19通过、TS/diff通过，不沿用26项回归证明小改。已交BE更新staging并绑定新的输入hash，尚未收到完成hash/最终包证据。旧截图格式不代表新代码，不外推新视觉验收。P4 CLI方案及隔离安装前置不变。

最新FE冻结：候选缩放重复计高、History重测缓存、Shelf表头隔离、原生拖宽基线已修；最终5文件26通过，TS/diff通过（不累计旧176/28）。PM核对Shelf源码与代表图及results.json，详见覆盖矩阵。workflow-audit1437纯mock代表浏览器验证已完成、浏览器/server已关，无Tauri/外部/P4；这不是14表全视觉或WebView/假P4/跨设备验收。正式包继续等待用户P4 CLI官方获取方案答复及隔离安装验证；WebView2离线运行时已备，旧skip包不可发。以下旧P1待修/视觉进行中等记录已被本段更新。

本次最新复核：新CL引用链与表格切片已有21文件176测试、最终列宽后6文件28测试通过的根转发证据（不可相加为唯一测试数），TS/diff通过；SUB-07已实现待验收。PM发现Shelf文件表头/列宽误接右侧文本预览，UI-04仍有P1待修及原生表首次拖动视觉风险；见覆盖矩阵。FE纯mock浏览器视觉进行中，修复与回归前不冻结放行打包；未证明原生/假P4/跨设备可用。下方无新链路证据等描述保留为旧状态。

**最新打包前置覆盖**：SUB-07已改为结构化CI来源CL引用传导链，直接和间接可达CL显示其自身workspace，不再要求正文相同，不查integrated/文件。此前正文匹配冻结、10mock＋入口1等结果不证明新方案通过。须按[最新链路验收矩阵](../PM/并行交接.md)补直接/多跳、乱序分页、环/多路径/重复、完整数字边界与畸形元数据、缓存/取消续查测试，并完成UI-04表格回归后重新冻结打包。当前没有新链路完成证据，不宣布交付；依赖自包含及隔离安装要求不变。下方其他匹配规格均保留为历史，不覆盖本段。

新增打包前置UI-04：用户已授权全项目表格UI统一与可复用可拖列宽，见[覆盖矩阵](../Designer/全项目表格统一覆盖矩阵.md)。FE完成全覆盖回归后重新冻结源码再打候选；此前冻结不涵盖该批改动。保留已有布局/交互，测试含逐表拖动/最小宽度/列宽隔离/长文本窄屏/虚拟行高度及不误触选择排序菜单。其他项目不恢复。

**2026-10-28最新需求覆盖**：用户将SUB-07替换并细化为“普通源CL同原正文的后续CI合并CL及各自workspace/client”候选。仅对已识别CI包装精确分离元数据与原正文，不泛删标签或模糊匹配；优先复用候选自身client，缺失显示未知/按需取详情，不经文件推算stream。先修验此功能再打包。规格和验收以[并行交接最新替换需求](../PM/并行交接.md)及唯一TODO为准。旧严格逐文件查询不算完成，其链路正确性不再是本次打包前置；下文旧缺陷/假P4逐文件正例门槛只作历史记录。新方案必须测试通过并冻结最终源码才打候选；候选应排除自身、保留不同CL、跨分支且不受当前筛选限制、缓存优先/有界分页并诚实报告不完整。描述匹配不证明合并。最新根转发FE新方案已冻结，新10mock＋入口1通过、TS/格式/CSS/diff通过；相关Submitted/主题回归待补、视觉未验。BE22通过/0失败/1skip，skip不计通过。包体与安装放行仍未完成；自包含依赖要求保留。

2026-10-28最新阻塞：用户报告“这个功能没好，以及往后合并的CL却查不到”。SUB-07已进入限定缺陷核查/修复，PKG-01交付放行暂停；之前19项纯mock通过不证明该真实集成场景正确，之前冻结src不再作为最终候选输入。FE/BE仅处理此缺陷，不恢复BFF或无关开发。修复后须在经证明隔离的本地假P4记录可复现的向后合并正例、负例、截断/失败不误判与缓存回归（含缓存命中、显式刷新、连接代次隔离）；记录源/目标CL、文件修订、fixture/源码快照、实际请求及结果。未满足SAFE-02则不运行假P4，更不查询生产；如受阻，保持未验。依赖自包含打包要求保留，等修后最终源码及上述证据再打候选。

2026-10-28根转发用户“重新开始打吧”：仅恢复P4Deck打包协调，其他工作仍停工，不派新功能。FE原5文件纯mock已通过正式require_escalated原命令执行，exit 0，19项全过（2＋1＋7＋4＋5），源码与冻结一致，本轮无修改；React act环境警告未造成失败。BE为唯一打包人，准备官方固定版本NSIS依赖、白名单staging、最终hash及构建证据，可使用FE最终冻结src构建候选。恢复不授权启动产品连接P4、未经隔离的安装验收、push或发布。用户随后明确接收者无需自行安装环境：取消`skip`作为最终方案。BE须研究并实现官方WebView2自动安装/捆绑，同时核验P4 CLI依赖及再分发许可，不能把免Node/Rust误当成免运行环境。下段为此前证据，依赖准备已恢复不等于依赖已取得。

| 交付层次 | 当前证据 | 尚待取得 |
|---|---|---|
| 代码 | 此前FE/BE切片及冻结已有证据；现因向后合并CL漏查进入缺陷修复 | 修复后的最终源码、重新冻结清单，不沿用旧冻结放行 |
| 测试 | 后端10＋1＋2项回归/libcheck通过；FE正式提权原命令exit 0，5文件19项纯mock通过；React act警告无失败 | 视觉和隔离端到端证据；纯mock通过不外推真实P4或安装验收 |
| 包体 | 交付放行暂停，待修后最终源码再打候选；BE此前已恢复官方固定NSIS依赖与白名单staging准备；WebView2 skip最终方案已取消，官方运行时自动安装/捆绑与P4 CLI自动处理/再分发许可待BE落实 | 依赖校验、构建退出结果、产物文件/大小/hash、签名状态和内容检查 |
| 安装验收 | 尚无本轮最终包安装/启动/卸载证据 | 获准且已证明隔离的验证环境；未经隔离不得启动，不宣称异机可用 |

根转发BE已完成并停写后端切片：10项新Rust/mock、1项runner、2项cache/cursor回归及offline locked libcheck通过；FE已有TS/CSS/format/diff通过，正在做最终wire契约核对与可授权mock通路检查。以上不是安装可用证明。前端运行、视觉、安装/启动验收仍缺；NSIS工具未发现、无签名配置，P4 CLI不得夹带fixture版本。BE目前只读核对NSIS依赖和隔离安装启动方案，等待形成合并的最小审批请求；未获支持通路前不安装工具、不执行打包或启动。

## 当前依赖与放行缺口

根转发WebView2离线运行时已下载且签名Valid，仍需绑定实际版本/hash并完成最终包安装验证；不能把运行时签名称为P4Deck应用签名。P4 CLI再分发授权未确认，已有检测＋官方获取并确认条款方案正在等待用户接受；未回复前不视为同意，不声称依赖自动处理已经闭环。旧WebView2 skip内部候选不是最终交付。FE新方案最终冻结已有，新10mock＋入口1通过，相关Submitted/主题回归和视觉尚待补；须按修后冻结输入构建并绑定最终包hash，缺干净隔离安装证据仍明确未验。

## 包格式建议

优先制作 Windows x64 NSIS安装包，使用明确的当前用户安装范围；交付目录只包含安装包、SHA-256清单和简短中文使用/已知限制说明。最终包必须在明确支持版本的干净Windows x64设备自动处理WebView2与P4 CLI依赖；接收者只需输入自己的连接信息，不应手动安装开发工具或运行环境。BE核对官方来源、固定版本/哈希、安装方式和许可后选定运行时自动安装或捆绑方案。若自动安装需要网络/管理员确认或重启，应明确说明并验证失败恢复；无需手工装环境不自动等于支持离线。P4 CLI再分发许可或自动处理方案不成立时，记为交付阻碍，不改成要求接收者手装。包中不带公司配置、地址、凭据或fixture数据。

以上格式现已由脚本实现：`node scripts/package-desktop.mjs` 生成 currentUser 范围的 NSIS 安装包，默认 WebView2 bootstrapper，`--offline-webview2` 产出离线版；交付目录除安装包、SHA-256 清单、使用说明外还包含 `artifact-info.json`。两种模式是否满足“接收者免装环境”仍需按上文完成干净设备安装验收，命令能跑通不等于已验收。

裸exe压缩包仅可作为明确标注依赖的补充，不称为免安装免依赖包。MSI仅在接收环境确有需求时另评估。没有签名时必须标明未签名体验包，不提供关闭安全软件或绕过系统拦截的步骤；安装被拦即记录阻碍。

## 构建与最小验收顺序

交付硬门槛：无需接收者自行装环境；WebView2和P4 CLI均纳入，许可/来源/版本和依赖自动处理须有证据。缺少干净隔离设备的安装验证必须在交付说明中明示，状态不能关闭为“已验证跨设备可用”。此变更仅属PKG-01打包范围，不恢复BFF或额外产品开发。

1. **功能与版本冻结**：FE交付UI-05，FE/BE共同交付SUB-07。取得修复后的TS结果、新Rust编译与定向纯测试证据；明确未运行的mock/视觉项目，核心交互证据缺失时不得标为可体验。冻结源码快照、改动清单及依赖锁文件；HEAD加脏工作树需文件哈希绑定，不能仅用7af7671标识新版。
2. **干净构建目录**：由根指定负责人建立新的受控staging和构建输出目录，逐项白名单复制所需源码/配置/资源及锁文件，并核对哈希与前端嵌入产物。这里的clean指新目录与明确输入，不是git clean/reset、不删除已有工作树/dist/target、不丢弃未提交修改。核查构建资源、源映射及嵌入文本，不把测试夹具或个人路径误带入产物。
3. **依赖与构建入口**：负责人先检查NSIS及所选WebView2材料、Rust目标和依赖缓存；缺失时报告具体依赖和下载需求。使用当前受支持的 `node scripts/package-desktop.mjs`（必要时 `--offline-webview2`）或 `node scripts/build-desktop.mjs`，不使用策略Bypass；只构建，不隐式运行应用/fixture。版本、identifier、安装范围及WebView2模式由脚本与 `src-tauri/tauri.windows.conf.json` 统一决定；release/updater 入口已删除，不存在可启动的 `release:prepare` 或更新器流程。
4. **包内容检查**：交付白名单排除源码仓库、.git、.local、artifacts旧资料、真实测试数据、个人Profile、connection配置、备份/恢复队列、tickets/trust/凭据、cache/数据库、logs/journal及用户文件。检查实际安装包文件清单及解包/安装产物；不存在明文秘密不等于已证明没有嵌入私人数据，仍要核对资源来源。
5. **最小安装启动**：在获准且已证明隔离的Windows x64环境，用最终包安装；不得直接双击默认入口试探。记录OS/架构、WebView2/CLI条件、包hash与应用版本；证明无继承生产配置、无自动连接。必须在未预装WebView2/P4 CLI的干净受支持Windows x64环境验证依赖自动处理、安装失败提示/恢复及首次使用；仅提示用户手装CLI不满足交付。另验证已有依赖的兼容路径；不探测生产、不代装P4 Agent。验证首开、退出重开、主题预设/自定义/保存/浅深主题及既有布局；严格追踪用已证明隔离的假P4或受支持的纯mock，验证右键行绑定、缓存/有限查询、取消、截断/未知和目标CL核对。验证安装位置、再次启动与卸载，仅处理测试实例，不删除个人配置。
6. **交付结论**：保存安装/启动/功能/卸载的实际结果与未通过项，生成最终包SHA-256及构建快照清单，标明架构、依赖、签名状态、测试覆盖和已知限制。根确认交付后提供本地包位置，由用户自行转发。不能将静态通过、打包命令成功或历史原生验收当作异机可用证明。

## 负责人范围与阻碍升级

根已指定BE线程 `01a17d99-4396-7163-b4ef-d756fd8ba00a` 为唯一打包负责人；后端收尾后才准备，FE/BE最小验证与版本冻结后才最终构建。该角色额外获准修改必要的根packaging scripts/config/version及src-tauri bundle，负责staging/产物清单、构建及获准的安装验收。不得使用策略绕过、未经授权安装新依赖、连接生产P4或公开发布/外发。FE仅修改src，BE仅修改src-tauri业务代码；涉及tauri.conf/Cargo版本等打包文件时由根先交接给打包负责人，避免与BE抢写。PM只更新ForAIDoc与证据状态，不自行打包或宣称已通知其他角色。

打包负责人已指定，Windows x64 NSIS为暂定默认；依赖、签名及安装启动验证方案由BE核查后提交。PM截至本次更新尚未收到打包构建/下载/安装/启动完成证据。已知运行限制尚未解除。若受阻，提交最小请求须包含：具体动作、可执行文件和包hash、目标测试目录/环境、确切拒绝信息、已完成检查及是否已执行；只请求支持该动作的权限/通道，不申请关闭安全策略、不改协议或解释器绕过。不申请生产访问。
