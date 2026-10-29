# Windows 本机私用 TODO

> **状态真值已迁移。** 任务/批次状态以 [工作流/state.json](工作流/state.json) 为准（由 `node scripts/workflow/state.mjs import` 从本表机械生成，52 项口径已核对一致）。
> 本表保留为历史台账与详情来源；改状态请改 state.json 后运行 `node scripts/workflow/state.mjs board` 刷新看板。
> 工作流入口：[工作流/README.md](工作流/README.md)。

## S2B-QA-NOOP-01 测试执行异常（最新检查点）

根转：NOOP最小修复offline check通过，最终Rust测试EXE在任何用例结果前以0xC0000005退出；测试未通过，不能将编译通过或既往S3a/CHROME结果替代本片验收。当前是测试进程启动异常，非已证产品业务现场故障、非审批拒绝，根因尚未确定。

根已要求BE按原过滤仅一次受控复测：保留失败命令/退出码/EXE及hash、日志，在隔离target禁incremental后重新构建并执行相同过滤；不放宽断言、不操作弹窗或用户进程、不修改系统设置、不把非增量成功当编译器根因已证。若再次失败，停止该动作并报告精确阻塞，不无限重试。阶段3不依赖本结果的迁移继续。

复测成功也仅恢复该片测试证据，仍须新freeze/hash、QA retained/no-op正向语义及FE投影/占用释放验证后才可关闭缺口；失败则保持待测试。最终两项联合交付门槛不变，原树不动。

## ACTION-R01 集成配置与实际迁移验收（最新）

根转最新冻结证据：SHELF真实入口QA 53mock、appTS及17hash通过；候选缺vite.config.ts导致完整TS18003，属于候选配置不完整，不能记完整TS通过，也不直接归因产品逻辑失败。S3a宿主24纯测/6hash通过，首次测试EXE启动崩溃及关闭增量后原过滤通过证据并存，不能抹去首轮异常。S2b FE真实入口233mock/fullTS冻结已交QA；retained/no-op窄修仍由BE进行，S2b整体尚未放行。以上计数各属自身证据，不相加冒充唯一总用例。

唯一集成人BE在既定最终集成候选复用完整原基线构建配置（package/lock、全部tsconfig及extends/references目标、vite.config.ts和实际引用的测试配置等），先比对文件存在性及基线hash，再叠加批准产品切片；不得从不完整切片目录直接推定完整项目。缺配置从已核基线补齐，记录来源，不生成替代配置或放宽exclude/断言掩盖错误；不带updater暂停片、个人配置或凭据。各片不再为同一配置缺口另造候选/重复全量验证。QA在完整联合manifest上跑app/node及项目原有全TS入口，补齐SHELF完整TS门槛，并检查共享入口/配置差异；此前局部通过继续有效但不能替代联合结果。

技术阶段3后继必须更新既有50库存及明确新增行的实际迁移状态（不另造一份总表）：逐行列真实入口→adapter→host执行链、所属阶段/执行者、旧路径退出或保留理由、结果/冲突/本地IO结束证据、冻结hash/测试、尚缺项。优先完成既定本地IO/专用文件操作，再CL与其他实体写操作、认证配置等例外生命周期；host-only变体仍须宿主接入验证。typed注册、pure模型和宿主模块测试均不独立算端到端入口迁移完成，不以额外等待或虚假成功替代结果事实。

执行边界不变：独立候选、纯mock/已证明隔离假P4；禁生产P4、真实提交工具及恢复CUA。CON06＋完整ACTION矩阵联合通过后唯一BE核当前会话安全、漂移和备份再合入本地dev，随后停工；更新功能暂停，当前不提前Apply。

## ACTION-R01／技术阶段2b：S2B-QA-NOOP-01 修复单（QA结果后批准）

已读取 QA-S2b-result.md：原21项及最终新增3项通过，但正常保留正向验收未闭环，S2b不整体放行。问题定性为回执/事实来源能力缺口，不是已证实真实P4现场误判；初轮夹具两失败及修正记录保留。证据位于 C:\Users\fenganmeng\AppData\Local\Temp\P4Deck-action-r01-qa-20261029\QA-S2b-result.md。

BE在当前技术阶段3最近安全检查点执行最小修复：为revertUnchanged补可验证正常保留事实来源与retained/no-op或等义兼容逐项表达；命令成功与仍opened不能单独作为保留证明。须结合实际可获得的changed证据、适用命令语义及身份/归属稳定性；证据不足、竞态、超时、取消、读失败仍unknown。不得凭新状态名伪造事实，不增加全操作通用框架，不将普通revert改成同样规则。冻结新wire/hash并明确正常保留如何结束本次占用，历史unknown不被批量清空。

FE在wire冻结后仅接最小结果映射：已证明retained保留文件行、撤销本次乐观隐藏并释放本次占用，不显示内容已还原，不撤其他操作投影/锁。QA新hash后集中验证全部保留、混合成功与保留、正常revert、失联/读取失败与竞态，以及FE投影退休/资源释放链；不重复已过无关全套，不真实还原文件或访问生产P4。

持续队列：技术阶段3其他迁移继续，不整体停工。SHELF真实入口已接唯一ledger、224mock由根报告，联合QA进行中，尚非整体放行；REG01独立QA95唯一定向通过、50库存查漏通过，仅注册覆盖证据，不计真实迁移完成。CON06＋全矩阵ACTION联合通过后才由唯一BE安全合入本地dev并停工；软件更新仍暂停，原树当前不动。

ACTION技术阶段2b后端21test/offline冻结（根转），wholeCL范围修复；QA正核revertUnchanged正常已改保留是否误unknown。确证后批准最近安全边界最小no-op语义修＋FE投影/锁释放定向验，still opened本身不够证明；真实不确定保持unknown。不打断BE技术阶段3，不记疑点为已证Bug，详交接。


审批范围澄清：FE-S3-REG01属于第二交付项ACTION-R01／技术阶段3，不是已暂停的软件更新第三交付项。当前TS通过，mock因审批将技术阶段3误解为交付范围之外而拒绝，未执行，不记测试通过。根已转用户原文作为实质新授权证据，仅允许走正常审批对同一原命令一次重试，不能改命令/配置/工具绕过；若仍拒，记录准确动作/目标/原因并由根向用户说明所需确认。其他独立工作继续。REG01验证后FE优先接真实SHELF，当前S2a真实入口尚未开始，不以注册表算已迁移。后续任务单统一写第二交付项ACTION-R01／技术阶段N，软件更新明确暂停。

迁移验收收紧：S1B host57/FE＋pure98通过只算模块证据；S2a wire到FE立即接真实SHELF入口并退出旧active/刷新栈，随后Revert。全矩阵逐行必须真实入口链、旧实现退出、立即UI行为、前后调用计数和失败对账/hash证据，typed注册/纯模型不计完成。详交接，原树未动。


FE-S3-REG01立即代码片：从已核矩阵落typed canonical registry/别名解析及真实入口覆盖、旧MOVE退出测试，区别migrated/legacy/hostOnly/边界，不猜wire、不另造store、不以登记算迁移。S1B BE52/FE89及S2pure44已冻QA中，BE S2a真实迁移继续；FE本片后wire到即接真实SHELF，不全停。updater暂停、原树只读。详执行单。


FE-S2-PURE立即编码：冻结S1A ledger基线下新片实现SHELF→Revert纯投影adapter与乱序/partial/unknown/版本/I/O冲突测试，已有S2A代码先复用，不等S1B、不另建store、不猜wire、不接真实写入口。两片完成自动接已到S1B适配，QA按freeze续验；updater暂停。详执行单，原树只读。


最高最新终点纠正：用户“做完后推到dev啊”明确授权CON06＋全矩阵ACTION完成且联合QA通过后合入本地dev，再全员停工。软件更新保持暂停不混入；不是仅交候选，也不是远端git push/发布。此前禁止合dev仅适用于完成前，现由本条覆盖。完成后唯一BE核精确联合manifest/当前会话安全/原树漂移/备份，fresh Verify后Apply；本条授权不证明届时dev已关闭，必要时根仅最终请求一次当前关闭且无在途确认，不提前应用。实际回执/hash验证后报告并停止，不缩小全量action范围、不打包发布、不恢复updater。

最高最新停工条件：仅完成CON06＋ACTION-R01全矩阵迁移/必要QA，随后全员停止汇报等安排。UPDATER立即暂停后续，离线检查点保留；BE S1B后直接ACTION2/3，FE与QA只接前两项，不扩provider/发布。禁止合dev/打包/发布/新增需求，原devJOIN04保持；不能只MOVE算重构完成。详交接最新队列，覆盖旧三项并交安排。


FE-S2A-PREP立即放行：BE-S1A QA38过，FE S1A54/UPD18冻结等QA；FE复用已冻ACTION内核写SHELF纯投影adapter与版本/partial/unknown/重叠/退休测试，不等wire、不接删除UI/真实IPC、不改QA冻结内核。完成按S1B/provider到达接续，均未到可做Revert纯适配测试。不是阶段2业务完成，详交接；原树只读/三项并交。


ACTION阶段0方案QA已核通过（非实现）；连续批单已放：BE S1A→S1B准入/解除→UPD真实host→ACTION2/3；FE UPD离线→S1A ledger/MOVE→S1B操作区→UPD适配→后继迁移；QA按freeze持续故障注入。CUSTOM静默65mock/TS/6hash已验候选。owner/repo待不阻独立host代码，不假装mock即真实更新；三项总闸门/原树JOIN04只读不变，详交接。


FE-UPD-S1立即编码：独立updater模块/纯状态机/注入provider离线UI与mock，配置缺失零调用、自动检查有限去重、用户确认安装、错误只日志；不猜IPC/不等owner-repo/不网络发布密钥。CUSTOM静默63mock已冻QA，BE ACTION-S1A运行；FE完成后按wire接ACTION纯ledger。仅候选，三项总交付前原树JOIN04不动。详执行单。


用户最新最高交付门槛：CON06 P4状态＋ACTION-R01全矩阵乐观重构＋PKG02软件更新全部完成联合验证/必要发布链验收后一次合入dev。取消CON06单独应用/关dev催促，PKG02升本轮P1不再最后搁置；原树保持JOIN04，CUSTOM静默也仅候选。UPD离线UI/逻辑/mock可先做，owner/repo/签名保管/发布授权待用户明确，不生成密钥/建仓/上传。持续小队列及门槛见交接，未齐不Apply。


BE-S1A已立即授权编码：既有ACTION候选实现MOVE持久回执兼容元数据/强类型lookup/故障注入与重启测试，不等阶段0整批。Terminal/lane/fence留S1B显式未接，最终联合gate不降；FE当前CUSTOM收尾后接ledger适配，QA差量继续。详执行单，原树只读。


ACTION阶段0 PM已裁受控解除：既有操作区仅指定已结束但unknown操作可由用户显式解除写阻塞，保留历史unknown，活动进程/I/O不可解除，无P4执行/自动重试/新modal。MOVE整段lane、Terminal参数分类、最小本地/custom准入纳首迁；后继schema不抢跑。QA接FE-v2/BE-delta/本裁决一次差量，通过即自动释放阶段1兼容wire＋宿主/FE ledger＋MOVE编码，详交接。原树只读。

CUSTOM-SILENT01截图已定界：标题自定义提交工具，内容工具已启动/本次尝试路径及检查状态、关闭、X；仅应用启动状态展示窗，不是预确认或外部工具窗口。明确删除该窗及独立检查状态按钮，内部会话状态追踪/防重/退出刷新保留，失败只日志error，正常不打扰；不再等待截图，不扩大移除范围。

新增CL-06-F03/CUSTOM-SILENT01需求小片：FE立即独立候选移除应用内自定义工具启动/状态弹窗，正常静默，未启动/失败只既有日志error；保目标校验、防重/unknown占用与退出刷新，不fallback/重试，不影响普通submit确认。不扩大ACTION、不打断BE矩阵，原树只读、禁真实tool/P4/CUA。详交接。


CON06联合QA已直接核qa-approval.json：20hash，manifest EEFA0274AB258DE0A945A00D7DA394D998BAC4FCB7CFC8FD4843AF9D5E22E520，44FE/双TS通过，6Rust hash一致复用11项及offline证据；非交互通过，nativeTransportRun=false，originalApplied=false。根已通知用户并请求本批关闭确认，当前待应用；确认后BE按既定fresh Verify/Apply，不重复测试或候选。ACTION FE delta01已核：九变体无FE执行入口但host可调用，明确阶段3a；别名/结果字段已修正，v2矩阵50库存行有阶段负责人，非50已迁移动作。BE差量仍在做，到齐QA一次差量闭环，阶段0尚未通过。

ACTION阶段0方法层已对齐107注册，仍四差集阻断；立即FE补9变体/alias/结果字段，BE补generic未知语义/MOVE持久lookup/Terminal准入最小方案，QA只复核差量。PM已裁阶段1仅共享基础＋MOVE，SHELF/Revert随后，其余file/spec/控制平面有序后继；纯读/平台边界例外有归属，不空白later。阶段0不等全后继实现，首迁必要安全契约仍必须闭环。CON06联合20文件已冻独立QA，详交接。


CON06最终FE v1.1已核freeze SHA3C5EF989…1669102，43mock/TS；BE计数自然收尾即单一SERVER-STATUS-JOIN01整合最终FE/BE，QA非交互联合后独立交付，不等重构。ACTION FE矩阵105adapter/41组/48别名已到，QA双向差集中，尚非阶段0通过；FE立即准备契约字段来源/转换表/测试迁移，不抢跑写架构，SHELF9mock模型仅参考。详交接，原树只读/CUA停。


ACTION-R01 BE阶段0初稿已核：TEMP/P4Deck-action-r01-20261029/evidence/BE-action-matrix.md，104 commands.rs IPC映射（含35读查询），另3 close_guard原生命令及写入点索引；非104个业务action，非完整AST覆盖。明确journal INSERT OR REPLACE不提供通用幂等，server mutation lane不是逐文件持久ledger，selected_submit已有专用持久回执可复用。三动作成本仅静态，mock计数待补。FE真实入口矩阵与QA双向差集未齐，阶段0未通过；沿既定门槛续接、不重造计划。CON06 BE wire已冻交FE，独立于本审计基线。

ACTION-R01阶段0 QA基线已核：TEMP/P4Deck-action-r01-qa-20261029/QA-ACTION-R01-coverage-checklist.md及source-hashes.json、fe-callsite-candidates.json。47调用候选为正则索引，非47个canonical action或全量覆盖证明。重点差集包含runP4通道、长尾文件action、双CL修改接口、手工merge写盘、认证配置及日志管理；逐行核真实入口→IPC→service→副作用，适用/例外有理由负责人。FE/BE矩阵未齐，QA仅准备完成、未执行测试，不宣称阶段0通过；两清单冻结后QA直接双向查漏并保留未匹配项，PM收敛迁移排序。当前CON06安全收尾不打断，CUA/生产禁令保持。

ACTION-R01范围补充：阶段0必须全量交叉清点真实命令注册/IPC/菜单/toolbar/dialog/drop/快捷键及本地写路径，交唯一action覆盖矩阵，不能仅MOVE/SHELF/Revert。矩阵列入口证据、实体/副作用、生命周期/刷新、乐观可行性、确认/幂等/并发、权威字段及partial/unknown校准、迁移阶段或明确例外。FE/BE双向清单由QA查差集，矩阵当前待产出，不能称已完成。前三动作仅首批，后继按矩阵迁移；不适合乐观的不预报成功。CON06安全收尾不打断，详重构设计阶段0补充。

ACTION-R01｜重构/P1主任务｜用户明确授权统一action生命周期/乐观投影/批量执行/结果校准。SHELF-PERF01与REVERT-PERF01转迁移验收子项，不再独立扩乐观栈；MOVE先迁移再SHELF/Revert，复用缓存/operationId/journal，不造消息总线。CON06继续安全收尾，FE/BE随后按阶段0→1→2→3有序自主续接，独立候选、原树只读、CUA/生产禁令保持。短设计/接口/退出条件见[统一操作生命周期重构](统一操作生命周期重构.md)。新增重构主包不把历史包总数当未完成数。

REVERT-PERF01新增CL-01-B02性能Bug＋CL-01-R02优化，与SHELF性能同批排CON06后：官方支持多文件revert，现命令构造已批量，实际入口/检查/刷新计数待BE核，不猜根因。确认后乐观Pending局部更新，实际文件I/O结束前同文件写锁，partial/unknown准确对账不重试，不承诺恢复丢弃内容。保一次确认/精确范围、纯mock/假P4不碰用户文件。详交接。


SHELF-PERF01：CL-03-B01性能Bug＋CL-03-R01乐观删除/批量优化，排FE/BE CON06安全收尾后。已核当前删除命令本身支持多paths，未见逐文件删除；preflight/recheck含多次检查需计数，现FE未见乐观隐藏，不能凭猜归因。立即局部移除＋逐版本partial/unknown对账，不删新搁置版本、不自动重试，错误仅日志。独立候选/纯mock，详交接。


CON-06/SERVER-STATUS v1.1：绝不自动info/探测，所有无有效样本均unknown；仅P4空闲展开任务面板内手动按钮点击触发单次info，可-s，scope/代次校验与在途合并，无自动重试。手动仅可达性，不入质量基线、不判smooth、不清登录/权限异常；底栏/toolbar不露按钮，失败只日志。FE/BE同片安全边界补契约，mock验零探测与防重复；详交接。


JOIN04已实际合入／待人工验收（2026-10-29 08:14UTC）：回执complete、40hash一致及备份通过，manifest D1F43C7DF9D4C65C242F90CE0C5982C1C59E08084A49A89D5426B8D06CB37BC2；根转应用后appTS过。原dev人验已通知，不再待应用、不重测已人工拖窗。SERVER-STATUS新图标未混入，FE/BE独立开发继续；CUA仍停，日志即时刷新与真实业务边界保留。详交接实证。


CON-06／SERVER-STATUS-I01｜功能需求/P1｜用户已批准普通用户状态，实现可并行：BE被动既有命令聚合＋快照，FE底栏P4空闲后icon及任务顶部三维状态。scope/revision隔离，无样本灰；不探管理员负载、不新增P4轮询。R01已转实现前置完成，新增一个主包（原52历史不代表未完成数）。独立候选不改JOIN04冻结，CUA仍停止，详细契约/阈值冻结门槛与验收见交接。


SERVER-STATUS-R01官方调研完成／待决策，未实现：info可达性不代表负载（压力豁免），客户端慢不等于服务器拥堵；高级monitor受权限/配置限制，ping不作心跳。建议被动连接状态＋明确本机推断的响应质量，运维集中监控另议。未探生产，不新增轮询或编码，来源及边界见交接。


JOIN-APPLY04最终非交互QA通过，待应用／人工验收：40hash，manifest D1F43C7DF9D4C65C242F90CE0C5982C1C59E08084A49A89D5426B8D06CB37BC2，144FE/6Rust/app＋nodeTS通过。根已请求本轮停dev无在途确认；确认后BE freshVerify/Apply，无需再PM。原树尚未应用，不重复测试/候选。日志打开/手动刷新可查，已打开面板即时刷新未证实；CUA仍停、测试窗清理未知。SERVER-STATUS仅研究，详交接。


SERVER-STATUS-R01｜仅调研/进行中：根独立研究P4断连/正常及忙闲指标，区分普通/管理员权限与客户端延迟推断、缓存/低频成本。未授权实现或生产探测，不新增P4轮询，不占JOIN04；结果后再议产品方案，不增已承诺主包。


SHELF-QA-02确认遗漏：DeleteShelfDialog在startDeleteShelf同步拒绝后显示DialogNotice并留窗，属于操作失败非输入校验。立即FE独立小patch改确认后关窗＋既有日志准确去重，零重试；保留原freeze，交BE JOIN04纳新hash/QA定向复验。CUA禁止、原树只读。详交接。


JOIN-APPLY04 BE立即先整合已冻CLOSE/ERROR/CUSTOM后端＋拖窗/REVEAL，核hash备份；Pending/FE最终接线未冻不取。ERROR只合必要计数/准入窄差异不覆盖DIRECT。FE一冻直接续接新manifest，QA最终一次补交叉面及REVEAL真实组件入口。ERROR4＋1/CUSTOM12过，REVEAL18mock14browser共享层过非完整入口；CUA仍停止，原树只读。详交接连续执行单。


2026-10-29用户明确“我人工测了，拖窗成功了”：UI-07-B02拖窗成功范围人工通过，不再安排鼠标拖动测试。当前证据对应候选/隔离测试，不代表已合入原树；最大化恢复、所有交互排除等未明确验证边界不外推。Escape停止CUA限制继续有效，不自动恢复交互/关闭测试窗或shell杀窗。继续纯代码/mock、日志接线及其他已授权非交互工作。

QA边界更新：用户Escape停止CUA，禁止自动恢复交互或shell杀窗；拖窗19mock过但原生未验，可能残留隔离测试窗由用户手动关闭。CLOSE9Rust/22mock及所验隔离原生路径过；REVEAL18mock/首轮11browser/TS过，补充待收；MOVE-DROP因合Pending notice已变hash，等最新freeze。非交互代码/mock继续，原树未获应用许可，详交接。


ERROR-LOG01真实依赖已确认：现有宿主日志无FE写入口，BE立即受限IPC窄片复用log_store/现有日志，冻结结构化脱敏/有界/幂等wire交FE；FE接后恢复SHELF确认并完成实际日志，不把禁用作为交付。CUSTOM wire已提供，按既有接线继续。新增路径纳JOIN04定向QA，原树只读；详交接。


本轮JOIN-APPLY04已预备唯一BE整合单：拖窗/REVEAL/DROP/CLOSE/CUSTOM各片冻结情况分开记录，QA分段中；FE继续SHELF/日志/Pending notice/CUSTOM接线。BE可立即收manifest/diff，源片QA通过后直接按差量合，重点App/TopBar/Pending/日志/close共享路径，最终QA仅交叉面。原树本轮未改、未获当前安全应用确认，不重开三项人工通过、不重复全套、不等人验阻独立工作。详交接。


最新UI-01-F07／ERROR-LOG01（需求/P1）：本轮操作错误统一仅进既有日志，覆盖Pending、SHELF后台、工具退出刷新与F06 error/targetError独立alert；不额外modal/工具栏或标题图标/ToolArea alert，不抢焦点展开面板。保留业务确认和必要输入校验、准确partial/unknown上下文，去重脱敏，不删显示丢日志。FE/BE安全边界最小适配，QA改日志可查断言，原树只读；此前独立alert建议已替换，非全项目重构。详交接。


新增CL-01-F03／PENDING-NOTICE01：删除Pending标题右侧notice操作结果勾/提示与空占位，保留新建CL、固定动作及非静默错误反馈；并入FE MOVE-DROP/SHELF-DELETE共享Pending安全切片，不重改全局toolbar。详交接，原树只读。


新增CL-06-F02／CUSTOM-EXIT01（需求/P1）：仅P4Deck启动的工具会话父进程退出，合并事件后一次失效/刷新对应Pending；退出非提交成功，切换连接只标原作用域失效，不抢导航滚动、不添toolbar状态、不轮询P4。BE空闲即审现有custom_submit Entry/try_wait并独立实现最小通知，FE当前安全边界接；QA可控进程mock。原树只读，无真实工具/P4执行，任务单见交接。


CL-03-F02截图已定界为服务器搁置版本删除，非本地文件或整个CL；解除对象等待，唯一SHELF-DELETE02片可按队列执行。一次明确范围的取消/确认，确认立即关窗，内部自动校验与后台结果保留，不再多加用户步骤；不真实删除测试。详交接。


新增CL-03-F02／SHELF-DELETE02（需求/P1）：删除搁置相关一次取消/确认，去核对勾与用户独立预检，确认立即关窗后台执行，内部校验与非toolbar失败反馈保留；准确删除对象待根截图定界，不猜本地删除。BE CLOSE收尾审接口，FE REVEAL安全收尾接轻量UI，原树只读。MOVE-DROP01截图已确认为已定目标后预览确认窗，拖放不弹选择/二次确认，菜单入口保留。详交接，关联子项不加主包。


新增CL-01-F02／MOVE-DROP01（需求/交互优化/P1）：拖到明确目标CL直接复用乐观移动，不弹中间窗口；右键移动仍保留目标选择/新建。源码dropFiles当前setMove(target)已定位；FE拖窗→REVEAL自然收尾后接，QA定向验防重复/取消无效/同CL/partial与unknown，原树只读。关联CL01不增主包，详交接。


UI-07-B02最新范围澄清：最上方整条标题栏的所有横向空白均可拖动，不限品牌附近小块；按钮、输入、选择器等交互命中排除。FE原拖窗切片内落实，QA在左/中/右空白及窄宽布局逐点验证，不能只测品牌区域代表全栏。不新增任务、不打断当前修改。

最新UI-07-F04／CLOSE-DIRECT01（需求修正/P1）：所有应用关闭入口直接正常退出，不再因dirty/unknown/busy弹阻断确认或等页面/操作；覆盖旧F02仅删泛化unknown范围。BE立即独立候选核CloseRequested/ExitRequested/自绘X共用路径并最小修，FE按需安全边界薄接线，QA定向验；保留业务提交/删除确认和非阻塞记录/正常清理，不宣称服务端已撤销。原树运行中只读，禁止真实P4/tool。任务单见交接，关联UI07不加主包。


新增REVEAL-I01：FILE-01-F01（需求/P1）地址栏文件导航同步左工作区一次性展开/选中/滚动；FILE-01-B02（Bug/P1）右键在工作区中定位无效。FE拖窗自然收尾后自动接同一最小切片，BE可立即只读审既有路径映射/缓存接口，QA分别验两入口及异步/虚拟树/重复请求/手滚不锁定。源码初查右键仅env.navigate，须核完整链路；原树只读、禁生产P4、不增加主工作包计数。完整分工见交接顶部。


2026-10-29用户dev人工通过：工具栏无转圈勾号、永久无原生标题栏、Pending布局及Shelved操作；对应子项限定通过，不重开。新增UI-07-B02（Bug/P1）顶部无法拖窗，FE立即独立候选最小修拖动命中/事件路由，QA定向mock与隔离原生拖动验证；main已有start-dragging权限，不盲加权限、不恢复原生头。原树保持只读，任务单见交接顶部；不扩大至真实P4或安装验收，不增加主工作包计数。


**2026-10-29最新：JOIN-APPLY03已合入原树，待人工验收。** 用户本批关闭确认后BE实际Apply完成；PM核回执与post-apply-verify：53/53最终hash一致、0失败、备份完整，manifest9F0ABF1966CB2E726B7D6FD089BAAD4E95143C25039D878CEFD9B6DD658DF2D9，06:33:25UTC复核；根转应用后appTS通过。不再待应用，以下此前等待记录为历史。原P4Deck-Dev.cmd入口已通知用户；真实P4、原生关闭及真实业务仍未据自动QA验收。不重启产品、不打包、不重复旧全套；本次关闭不授权未来热覆盖。


**当前最终状态：JOIN-APPLY03已实现、联合自动QA通过，待应用／待人工验收。** 53项manifest `9F0ABF1966CB2E726B7D6FD089BAAD4E95143C25039D878CEFD9B6DD658DF2D9`；100mock、64浏览器检查、全量app/nodeTS通过，原树/候选/备份Verify一致。MOVE-QA-01与CLOSE-QA-01限定自动化缺陷关闭，无本轮产品阻塞。原树尚未应用，唯一当前门槛为本批dev关闭且无在途操作确认；根确认后BE直接重新Verify/Apply，不需再派审批。停止重复测试、新候选和范围扩展；真实P4、原生关闭及人工体验仍未据此验收。此前过程记录仅作历史，最新任务单见并行交接顶部。

最新QA：MIN＋F06独立通过（manifest31360669…17F0DF6，96mock/17browser/fullTS）；MOVE-QA-01已关闭（新manifest76142562D431920B13742B257E7B541EAC906E49017A273BA467C698BC905284，23mock/12browser/fullTS），CLOSE既有通过限定保留。BE立即JOIN-APPLY03独立候选联合，QA新freeze只补交叉面；两批未联合前不得外推。原树尚未应用，本批dev关闭确认仍待，MIN小批可独立交付不被联合阻塞。完整可执行单见交接顶部。


当前最新：MOVE-QA-01（Bug/P1，关联CL01）独立回归已复现连续成功移动后旧覆盖复活，MOVE阻断；FE立即原候选最小修每文件覆盖淘汰＋迟到缓存/多文件回归，QA新freeze自动复验。CLOSE-QA-01已在FE/Host契约组合范围关闭，非原生实测。F06已冻结33mock/appTS，BE继续MIN＋F06优先独立整合，不等MOVE；QA按最终manifest一次验。本批dev关闭确认仍未到，原树未应用。任务单与精确证据见交接顶部。

> **唯一权威执行清单 · 2026-10-27 项目级静态盘点。** 本节覆盖下方旧快照的“当前”描述；旧记录仅用于追溯，不是第二套任务队列。后续新增任务、状态与关闭证据只维护本节。
> 最初盘点对象为 `d582a5c` 加当时工作树；2026-10-27 并行交接后的当前基线为 checkpoint `7af7671` 加其后未提交修改，不是可发布或全量验收提交。PM本轮仅核对并更新文档，未启动应用、P4、网络探测或重跑产品测试；未覆盖/回滚他人修改。未发现根/祖先 AGENTS.md 或仓库 .agents/skills。停笔时的编译缺口与职责见 [并行交接](并行交接.md)。

## 当前批次调度（覆盖下方历史记录）

MIN-APPLY02现20文件/59mock/双TS/Rustcheck通过，manifest5EE629CC...F4E1EAB9未应用；批准BE先核F06基线/错误通道/冲突，FE freeze后直接最小补入并新manifest。QA完成当前MOVE/CLOSE后只验最终MIN＋F06一次，不重跑旧全套，不夹未验MOVE/CLOSE；本批停dev未答仍禁止Apply。

F06最终范围统一：所有操作状态均不进入工具栏（running转圈/完成勾/错误动态按钮/空占位分隔全移除），固定工具与导航保留，进度/错误沿既有操作区日志不吞错。吸收未应用F04，不另造过滤；FE当前安全边界唯一小patch，QA全状态一轮验，详交接。

UI-01-F06需求/P1替换F03旧范围：任何操作完成勾号及动态状态按钮全部移出工具栏，仅固定入口；内部防重/操作保留，错误走既有非工具栏反馈/日志不吞错。FE MOVE安全边界后唯一CommandBar小补丁，BE不并发改；QA过才纳MIN或下一小片，不夹未验、不写原树，详交接。

BE MOVE/CLOSE已冻结并空闲，立即执行MIN-APPLY02候选抽补丁→合并纯测/编译→备份/Verify→QA freeze，仅已验Pending/SHELF＋CHROME-OFF；明确排除未验MOVE/CLOSE与诊断配置，不整文件覆盖共享代码。原树Apply禁止（本批停dev未答），无需额外预研或PM往返，完整执行单见交接。

CL01B01/SHELF-QA-V01限定候选QA关闭：57mock/66布局主题/双TS过；CHROME-OFF21FE/27host/75合成/双TS过。MIN-APPLY02最小补丁清单已备，只合已验Pending/Shelf与永久无框，不夹带继承中间MOVE/CLOSE；新合并需定向QA与当前停dev确认，原树未应用。QA可先准备MOVE deferred/分块失败测试，不改未冻结产品，详交接。

根确认环境connected且原队列已恢复：BE MOVE-P01/CLOSE-QA-01，FE乐观移动/旧测试与解除接线，QA先验冻结Pending主题布局＋CHROME-OFF；依赖就绪自动接CLOSE边界/MOVE集中回归。连接恢复不是应用关闭，本批原树未应用、dev安全确认未到，不自动启停产品/tool。

MOVE-P01最新硬验收：确认后立即本地乐观重分组至目标CL，后台批量reopen，不全表loading/等刷新；新建临时身份映射真实回执，partial失败纠正、unknown待核不盲回滚/重试、同文件冲突串行而其他UI可用。P4V内部机制未证不猜；官方多参数reopen已核，FE/BE安全边界接同批。

CLOSE-QA-01组合阻断：dirty→诊断unknown→明确全部放弃仍残留host dirty，93FE/27host/92browser/双TS通过不能放行；FE Pending/SHELF安全收尾后小修，BE同边界对齐显式解除事实，非标题栏撤销范围。新增CL-01-R01/MOVE-P01重构优化：先量化N文件调用，官方批量reopen/安全分块＋一次刷新＋局部pending反馈，准确partial/unknown不重发；接MOVE安全边界，关联主包不加数。

最高最新口径：用户撤销原生标题栏兜底，UI-07-F03 CHROME-OFF优先小修永久主窗无框＋自绘常驻。R02自动恢复/延迟优化停止、旧兜底验收取消（非通过）；F04去转圈保留，CLOSE具体dirty/在途及unknown体验方案继续。BE MOVE安全边界后接、FE同步清probe依赖；重核所有候选继承防旧机制带回，原树未授权热改。

UI-01-F05｜需求/UI精简｜已定位移动到CL弹窗：并入MOVE前端同片删取消及独占footer，把高度还给目标CL列表；保X/关闭保护，不改全局Dialog或提交/删除确认。FE当前片自然收尾后接MOVE，不打断MOVE/Pending/CLOSE；关联UI01不加主包。

立即调度：BE空闲直接执行已批准MOVE-I01，不再等调研/PM；FE CLOSE安全收尾后同一Pending-UI-FIX切片修CL01B01提前裁切＋SHELF-QA-V01按钮主题。Shelf功能41FE/2组合/9Rust/TS过但视觉失败，不能放行；Pending截图已证内外双滚动与底部空白，不硬编码约100px。QA一次合并视觉及定向功能回归，详交接。

CL-01-B01｜Bug/P1｜Pending下方空白提前裁切：FE CLOSE当前修改安全收尾后优先查高度/滚动/虚拟测量并最小修，图待根核；MOVE后端可独立继续，FE移动界面随后接。分项验多CL展开/Shelved/缩放隐藏恢复/末行可达，不用巨大固定高度；原树只读，不新增主包。

CL-01-F01｜功能需求/P1｜MOVE-I01已立即排给空闲BE，优先PKG预审：跨CL选文件移到已有可写pending/新建CL（需描述），只移动不提交。已有MoveFilesDialog origins/paths及多选入口，缺新建目标与全链准确性需最小补；FE CLOSE/文案安全收尾后接，QA按freeze续验。独立候选不写原树，关联CL01不加主包数，详见交接。

CLOSE BE已冻结25pure通过、wire交FE；R02/SHELF17路径备份预检完，原树不动。BE下一独立项为PKG01具体只读资源/白名单审计（不是重复原则文档，不build/install/upload），输出候选evidence；做完后真实剩余依赖为FE/QA最终与本批停dev确认，条件齐自动接集成，见交接任务单。

FE-CLOSE立即独立修复：审计已结束，修意外卸载保留dirty、明确保存/放弃仅清对应token、CL07放弃清除与定向mock；沿已批FE-prep候选不等BE/wire，不改原树/SHELF。本地有界类别可先做，IPC最后一次对齐；BE SHELF自然收尾后接宿主粘滞dirty/Ready问题。

持续领取规则已生效：角色当前安全步骤结束即接其有序已授权独立队列，不等整批/人验/合入或逐项PM；缺依赖只暂停对应动作。FE：关闭dirty审计→CLOSE独立实现→等待wire时CL06F01文案；BE：SHELF收尾→CLOSE契约/实现→集成准备；QA：SHELF分段验→CLOSE分段验→文案及最终合并回归。具体所有权/顺序见交接，原树写入仍需当前停dev确认，禁止生产/真实tool，BFF停、updater最后。

UI-07-F02｜功能需求/P1｜CLOSE-UX01排SHELF后：取消仅因页面unknown而通用未保存确认；无明确dirty/在途正常直接关，具体脏编辑或操作仍具体提示，保留白屏native/同锁退出保护。用户直接关是体验需求非停机确认。旧v1.1一律弹框口径被覆盖，方案与验证见交接，不打断当前项。

CL-03-F01｜功能需求/P1｜SHELF-I01下一批：当前CL Shelved加全部Unshelve/删除全部、标题本地化及CL同款前置折叠箭头；PM源码确认已有同CL多选paths传参和标题右键全集入口，缺显式按钮、完整执行与部分失败待BE/QA核；跨CL shelf多选不支持且本批不隐式扩。可独立候选准备，不打断R02最终QA/合入，不写用户运行树。关联CL03不加52主包，完整分工/验收见交接。

UI-R02候选实现完成、QA最终组合中：BE33Rust/FE最终52mock过，F04阶段21视觉过，不累加。PM被动进程列表见p4deck PID54340，未确定归属/未停止；原树写入需本批用户安全停dev确认及QA精确hash通过。BE可立即备份/patch准备，条件齐后单一应用，无需逐项许可，详交接。

UI-R02立即释放：UI-07-B01启动原生头延迟消失（Bug/P1）＋UI-01-F04移除工具栏loading转圈显示（需求/P1，核CommandBar operation反馈位，保留真正refresh命令），关联已有主包不加计数。BE单一新TEMP候选，宿主时序与FE握手/入口最小修并行，QA集中回归；现已发现二次成功探测/500ms调度待验证，不牺牲故障可关。用户或已重开dev，原树先只读，不沿用上批停止授权。详见交接。

INTEGRATE-I01已完成应用原树：36/36最终hash匹配，其他基线源码未变，应用后TS与offline locked Rust check通过。PM已核applied-validation.json，完成时间2026-10-28T12:31:35Z；精确证据及manifest见并行交接顶部。用户已获原dev入口通知，agent未启动产品/P4/工具。

| 项目 | 类型 | 当前状态 | 尚缺范围 |
|---|---|---|---|
| UI-07 / CHROME | Bug修复＋关联外观需求 | 原生兜底需求已撤销；CHROME-OFF待实施 | 主窗永久无框/自绘常驻；白屏不可关用户接受；具体dirty/在途关闭保护另按CLOSE验 |
| CL-07 | 功能需求 | 已合入，待人工验收 | 跨CL创建/移动仅在已证明本地假P4验；真实业务不以mock推定；取消保留新CL |
| UI-01-F03 | 功能需求/UI精简 | 已合入，待人工验收 | 刷新成功无勾号，加载/错误/真实刷新保留；31mock及9代表视觉通过 |

已人工通过：Branch叠字修复、JSON正文缩窄/隐藏恢复、Pending数值排序/Default及滚动条、顶栏Submit去重、自定义工具启动。I3启动不代表实际提交成功、连续会话或跨重启防重。CL06-B01不再用户阻塞；BUG-INBOX01旧测试弹窗与本轮诊断窗均已独立记录，不归为真实提交失败。

后继仅准备既有事项：CL-06-F01本次尝试路径文案（已随CLOSE实现及限定QA，不重复派发）、UI07剩余受控关闭验收、PKG01下一包证据与排除项。未派新产品修改或打包；自动更新PKG02仍最后。新dev可能由用户启动，下一写入仍须新的安全检查点，不沿用本次停止状态永久写入。

52是主工作包台账规模，不是未实现数；关联子项不重复计数。此前批次过程/失败/修复证据保留在并行交接历史，当前状态以本节和主表为准。
## 当前结论与状态口径

2026-10-28用户本次dev人工明确通过四项：Branch切换滚动无叠字、JSON正文/缩窄/隐藏恢复、CL正倒序/Default置顶及滚动条清晰、顶栏提交删除且Pending内保留。仅对应范围关闭，不要求重测；版本/环境未明确，不能外推安装包、所有DPI或原生故障。CON-05/UI-07条件chrome/CL-06-I3不在本次通过范围。

日常 P4 功能主体已有代码，不需要从零补 Pending/Submit/Shelf/Resolve/Graph/Search。当前首要问题是**安全验收入口未放行，以及最近 UI/History/Submitted 改动缺运行证据**。最新列表重叠修复、右侧导航和设置/关闭按钮迁移全部仍待运行验收。

- **已实现且有相应验收证据**：仅限标明日期/构建/场景的记录，不保证当前脏工作树全量无回归。
- **已实现待验收**：找到具体代码和契约；测试文件存在、TS/CSS/离线编译通过不等于测试执行或原生验收。
- **部分实现**：限定能力已经落地，仍有明确实现缺口或语义未证。
- **待实现**：明确下一步产出尚未完成；表内会标明是功能还是验收工作，不能把未跑测试说成未写功能。
- **受阻**：必须满足权限/环境/授权前置；不绕过、不盲重试。
- **建议待确认**：历史后置候选或范围扩大，不是用户已批准的新功能。

**安全优先于所有历史步骤**：只允许经证明的项目本地假 P4；公司生产禁止包括只读。旧 WIN-P0-03 及旧路线图中的本人 Server 操作冻结。不得为了收口清空用户 Profile、改全局配置/安全策略、安装 Agent 或禁用全部 QA。历史个人服务器退出条件不强迫当前任务触碰生产。

## 数量汇总（功能/工作包，不是菜单项数或测试数）

### 类型与状态独立记录

类型仅分三类：**Bug修复**（已有行为错误或回归）、**功能需求**（用户新增/改变行为，含UI优化及明确交付/验收工作）、**重构与代码优化**（内部复用、维护性或性能改造，外部行为不应改变）。类型不是状态；重构不能伪装Bug，需求批准不等于已实现，测试通过不等于验收归档。纯环境/权限受阻不是产品Bug，SAFE-02/03归功能需求的验收支持子标签，不据此派产品修复。

权威主表新增类型、负责人列，原ID/状态/优先级/证据/依赖保留。负责人表示职责归属而非当前执行授权，实际领取仍按PM队列；范围确认项的PM负责登记，不代表已派开发。旧条目按已知主目标分类：SAFE-01隔离缺口、SUB-05重叠、SUB-06时间语义排查为Bug；OPS-02缓存/取消/性能内部优化归重构优化；其他产品、交付与验收工作包归需求。SUB-06根因尚未证实，Bug分类不等于已经确认日期修法。

混合工作包按下方关联子项执行/验收。**52个主工作包**（新增CL-07跨CL提交选中文件；阶段与Bug子项不重复计数），子项不额外计数为新工作包；单个Bug修复或共享抽取通过，不把父项所有功能/验收一并关闭。同一证据可引用但不能重复计算完成数。原2项完成归档保留对应历史基线，不因分类改变重新宣称最新版本通过。

共 **52** 项：已实现且有相应验收证据 **2**、已实现待验收 **34**、部分实现 **9**、待实现 **1**、进行中（方案/实施分阶段）**2**、受阻 **2**、建议待确认 **2**。本次纳入已授权的 UI-05 主题色、SUB-07 CI来源CL引用链与 PKG-01 Windows体验包；两个完成项独立归档，其余只在下表出现一次。计数按交接已知证据，不表示当前工作树通过编译。

| 模块 | 总数 | 有证据完成 | 实现待验收 | 部分 | 待实现 | 受阻 | 待确认 | 进行中 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 安全与验收 | 4 | 0 | 0 | 3 | 0 | 1 | 0 | 0 |
| 界面与导航 | 7 | 0 | 6 | 1 | 0 | 0 | 0 | 0 |
| 连接与工作区 | 5 | 0 | 4 | 1 | 0 | 0 | 0 | 0 |
| 文件与版本 | 5 | 0 | 3 | 2 | 0 | 0 | 0 | 0 |
| History | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| CL 工作流 | 7 | 0 | 6 | 0 | 0 | 0 | 0 | 1 |
| Submitted 与周报 | 7 | 0 | 6 | 1 | 0 | 0 | 0 | 0 |
| 搜索与分支 | 3 | 0 | 3 | 0 | 0 | 0 | 0 | 0 |
| 工具与可靠性 | 5 | 2 | 3 | 0 | 0 | 0 | 0 | 0 |
| 阶段收口 | 5 | 0 | 1 | 1 | 1 | 1 | 0 | 1 |
| 后续候选 | 2 | 0 | 0 | 0 | 0 | 0 | 2 | 0 |

## 唯一任务表

证据列为实际源码或既有验收记录入口；旧日期测试只能证明对应旧版本。通用依赖 WIN-P0-02=最新原生 UI 冒烟、WIN-P0-04=隔离核心写入演练，沿用下方原编号及步骤，不重复计数为新功能。

| ID | 类型 | 负责人 | 模块 / 范围 | 状态 | 优先级 | 证据路径 | 剩余步骤与验收标准 | 依赖 |
|---|---|---|---|---|---|---|---|---|
| GRAPH-01 | 功能需求 | FE＋BE（PM拆领取范围） | 文件与版本：聚焦修订图、目标合入证据与来源追溯（用户已批准） | 部分实现 | P1 | [FileReviewPage.tsx](../../src/features/browsers/FileReviewPage.tsx)；[数据缓存与操作架构.md](../Coder/数据缓存与操作架构.md) | 2026-10-27 单文件切片已编码：目标/来源模式、轨道隐藏/Solo、证据范围、共享缓存与并发取消/20次预算；去除默认 filelog -i。TS/CSS/离线cargo check通过，mock测试已写未运行、视觉未验。新增已编码：显式根目录/简单 Branch Mapping 正反向文件映射、CL逐文件记录汇总、目标/来源/共同中转各最多2页（最多2中转），所有读取共用2并发/缓存/取消与20次API尝试预算，100文件上限。剩余：复杂Stream导入/重映射、内容保留/部分集成精确验证、mock执行及视觉验收；当前只报集成记录与未知，不作内容已合/未合判断 | SAFE-02；QA-01 |
| SAFE-01 | Bug修复 | BE | 安全与验收：QA 只允许验证后的本地 fixture | 部分实现 | P0 | [p4d-fixture.ps1](../../scripts/p4d-fixture.ps1)；[context.rs](../../src-tauri/src/p4/context.rs) | 被动门禁已加；QA 持久化 Profile、恢复队列、环境回退仍未完整锁定。补加载/切换前拒绝与纯测试，不能全面禁用 QA 冒充隔离 | 无 |
| SAFE-02 | 功能需求 | 根协调；PM验收 | 安全与验收：运行入口身份与继承配置核验 | 受阻 | P0 | [本地假P4安全核验.md](../../ForAIDoc/Coder/本地假P4安全核验.md) | 用获准诊断证明实际 listener、二进制、root、无转发及凭据隔离；当前缺证，不可先 p4 info 再确认 | SAFE-01；受支持诊断权限 |
| SAFE-03 | 功能需求 | 根协调；PM验收 | 安全与验收：前端运行测试与可视验收通道 | 部分实现（专用通路已用，覆盖边界保留） | P0 | [playwright.config.ts](../../playwright.config.ts)；[vite.config.ts](../../vite.config.ts) | 恢复产品支持的测试通道；旧 Vitest spawn EPERM 未重试，2026-10-27 浏览器 file URL 明确拒绝，不通过 HTTP/换浏览器绕过 | 工具权限/产品修复 |
| QA-01 | 功能需求 | FE；根配置由根协调 | 安全与验收：可重复的独立无 P4 UI 验收入口 | 部分实现（已有专用入口，统一覆盖待收尾） | P0 | [playwright.config.ts](../../playwright.config.ts)；[dropdown-theme.spec.ts](../../tests/browser/dropdown-theme.spec.ts) | 已有静态 DOM 用例，但默认 Playwright 会启动/复用 dev 服务。补明确隔离、可运行入口与宽窄/折叠/下拉/虚拟列表证据，不声称当前样本已验收 | SAFE-03 |
| UI-01 | 功能需求 | FE | 界面与导航：导航迁到主工具栏右侧、设置末端、关闭全部在页签栏 | 已实现待验收 | P0 | [App.tsx](../../src/app/App.tsx)；[CommandBar.tsx](../../src/app/shell/CommandBar.tsx)；[ActivityBar.tsx](../../src/app/shell/ActivityBar.tsx)；[chrome.tsx](../../src/app/docking/chrome.tsx) | 最新仅 TS/CSS 检查；验六个入口、选中态、文字开关、窄窗溢出、分屏与关闭范围，左栏不留空列。新增用户明确删除顶层工具栏纸飞机“提交 CL”按钮（根已核对截图）；保留清单icon“待提交”导航、Pending CL内部提交按钮、原功能/确认流程和后端submit命令。此增量已落盘，本批10文件111mock与TS/diff通过（根转发）；新视觉待批准，不能外推实机验收 | FE本轮UI与入口回归；QA-01 |
| UI-02 | 功能需求 | FE | 界面与导航：固定页紧凑头、多开页 icon、主题与标题国际化 | 已实现待验收 | P1 | [chrome.tsx](../../src/app/docking/chrome.tsx)；[tokens.css](../../src/app/styles/tokens.css)；[index.ts](../../src/shared/i18n/index.ts) | 验深浅主题、150% DPI、tooltip、键盘和即时切语言；文件名不翻译 | QA-01 |
| UI-03 | 功能需求 | FE | 界面与导航：Dock/popout、快捷键、页签恢复 | 已实现待验收 | P1 | [useDockController.ts](../../src/app/docking/useDockController.ts)；[Windows原生UI验收.md](../../ForAIDoc/Coder/Windows原生UI验收.md) | 旧原生只部分；最新构建验分屏/归还/关闭重开/焦点/390px | SAFE-02；WIN-P0-01 |
| UI-04 | 功能需求 | FE | 界面与导航：全项目统一表格UI与可复用可拖列宽（用户已批准扩大范围） | 已实现待验收 | P1（打包前） | [全项目表格统一覆盖矩阵](../Designer/全项目表格统一覆盖矩阵.md)；[TableHeader.tsx](../../src/app/context-menu/TableHeader.tsx)；[useColumnWidths.ts](../../src/app/context-menu/useColumnWidths.ts) | 2026-10-28授权覆盖全部主页面/弹窗/子表/虚拟表，非仅合并候选。PM只读列出14个数据表/多列子表及12组边界入口；最新核对T01–T14及View编辑/详情已接共享列宽。Shelf表头/预览隔离已修，PM源码及PNG核实；原生表已从实际宽度起拖，代表浏览器记录40px拖动对应40px。候选缩放重复计高及History重测缓存已修，results.json记录无重叠/裁切。根转发最终5文件26通过、TS/diff通过，旧176/28不累计。仅workflow-audit1437纯mock代表性浏览器验证，非14表全视觉/原生WebView/假P4验收；证据见覆盖矩阵，未覆盖入口仍待验。保留既有布局、选择/排序/菜单/拖放；逐表验拖动、最小宽度、列宽隔离、长文本/窄屏/虚拟高度及拖动不误触。不额外实现排序/列显隐，不新增全局持久化；FE负责src，PM不改产品代码 | FE全覆盖；SAFE-03；QA-01；PKG-01等待本项回归及新源码冻结 |
| CON-04 | 功能需求 | FE＋BE（PM拆领取范围） | 连接与工作区：移除详情侧栏、四项行菜单（用户已批准） | 已实现待验收 | P1 | [WorkspacePage.tsx](../../src/features/workspaces/WorkspacePage.tsx)；[workspace_mutation.rs](../../src-tauri/src/app/workspace_mutation.rs) | Switch绑定右键行；New复用创建表单；Rename使用原生renameclient（2022.2+），Delete仅非force删除定义；预检/120秒单次token/重验/服务器写锁。当前workspace需先切走，其他保存profile引用不会自动改写。待mock交互与假服验证；不把菜单存在当运行验收 | SAFE-02；QA-01 |
| CON-01 | 功能需求 | FE＋BE（PM拆领取范围） | 连接与工作区：多 Profile、连接恢复、Workspace 切换/Root 校正 | 已实现待验收 | P1 | [connection_service.rs](../../src-tauri/src/app/connection_service.rs)；[ConnectionProfilesCard.tsx](../../src/features/settings/ConnectionProfilesCard.tsx) | 旧 localhost/部分原生证据存在；最新需假服验证迟到请求、切换失败不改连接、自动 Root | SAFE-02 |
| CON-02 | 功能需求 | FE＋BE（PM拆领取范围） | 连接与工作区：User/Workspace Browse 与受控新建 | 部分实现 | P1 | [connection_setup_service.rs](../../src-tauri/src/app/connection_setup_service.rs)；[ConnectionSpecCreateDialog.tsx](../../src/features/settings/ConnectionSpecCreateDialog.tsx) | Workspace 创建已有旧 fixture 证据；New User 成功路径曾被 AuthenticationRequired 阻断，需专用 fixture 权限与原生验证 | SAFE-02 |
| CON-03 | 功能需求 | BE | 连接与工作区：P4VFS 新建虚拟 Workspace | 已实现待验收 | P2 | [vfs_service.rs](../../src-tauri/src/app/vfs_service.rs)；[P4VFS虚拟Workspace.md](../../ForAIDoc/Coder/P4VFS虚拟Workspace.md) | 已有前后端约束；真实 Agent/首次读取未验。仅新建，不转换旧 Workspace、不代装 Agent | SAFE-02；现成受控 Agent 环境 |
| FILE-01 | 功能需求 | FE＋BE（PM拆领取范围） | 文件与版本：Workspace/Depot 树、预览、状态与缓存 | 已实现待验收 | P1 | [ResourceExplorer.tsx](../../src/features/files/components/ResourceExplorer.tsx)；[workspaceQueries.ts](../../src/features/files/workspaceQueries.ts)；[FilePreviewPage.tsx](../../src/features/browsers/FilePreviewPage.tsx) | 旧自动化/fixture 基线不覆盖最近壳变动；验长路径、大树、离线缓存、连接隔离。新增JSON小文件正文空白：根报告BE7测试正常、data.content已到FE，FE已落盘JSON高度候选，本批10文件111mock及TS/diff通过；BE7测未改生产。最新JSON合成视觉已闭环：11场景、7/7mock及TS/diff通过，PM核results.json及前后截图，viewport0基线与修后正文可见；非原生/全部文件验收 | PM队列；SAFE-02；QA-01 |
| FILE-02 | 功能需求 | FE＋BE（PM拆领取范围） | 文件与版本：Sync/Get Revision/Edit/Add/Delete/Revert/Reconcile、普通 Lock/Unlock | 已实现待验收 | P1 | [file_service.rs](../../src-tauri/src/app/file_service.rs)；[sync_service.rs](../../src-tauri/src/app/sync_service.rs)；[file_lock_service.rs](../../src-tauri/src/app/file_lock_service.rs) | 已有窄契约与旧 localhost；最新原生预检/取消/目标快照/partial 复核，禁止真实工作区写入 | SAFE-02；WIN-P0-04 |
| FILE-03 | 功能需求 | FE＋BE（PM拆领取范围） | 文件与版本：Rename/Move | 部分实现 | P2 | [rename_service.rs](../../src-tauri/src/app/rename_service.rs)；[RenameDialog.tsx](../../src/features/files/components/RenameDialog.tsx) | 单文件已接且有旧 fixture；目录、跨 Workspace、覆盖、case-only 明确阻断，不列为已完成。是否扩范围需确认 | 范围确认；SAFE-02 |
| FILE-04 | 功能需求 | FE＋BE（PM拆领取范围） | 文件与版本：Diff、Revision Graph 与精确历史比较 | 已实现待验收 | P1 | [PageRenderer.tsx](../../src/app/PageRenderer.tsx)；[DiffView.tsx](../../src/features/browsers/DiffView.tsx)；[historyDiff.test.tsx](../../src/app/docking/historyDiff.test.tsx) | 验选中 #revision 到新独立 Diff 的真实请求参数、不回退 have/head、不受全局选择污染；旧 Diff 基线不能覆盖最新参数链 | QA-01；SAFE-02 |
| HIS-01 | 功能需求 | FE | History：四列表格、年日期、拖列宽、描述展开、FIFO 两选 | 已实现待验收 | P1 | [HistoryTable.tsx](../../src/features/browsers/HistoryTable.tsx)；[useRecordSelection.ts](../../src/app/context-menu/useRecordSelection.ts) | 测试源码存在，最新交互未跑；验 A→B→C 留 B/C、先后双色及aria/tooltip、右键不重排、长描述/空时间/双语 | QA-01 |
| HIS-02 | 功能需求 | FE＋BE（PM拆领取范围） | History：右键 CL 预览/Get/Undo/Diff 与全局差异入口 | 已实现待验收 | P1 | [ReadOnlyPages.tsx](../../src/features/browsers/ReadOnlyPages.tsx)；[UndoDialog.tsx](../../src/features/files/components/UndoDialog.tsx)；[undo_service.rs](../../src-tauri/src/app/undo_service.rs) | Undo 是单文件指定 revision 真 undo，非 sync/revert；6 项纯 Rust 历史通过，不等于 P4 执行验收。验预览/取消/一次确认、后选 Get、双选精确 Diff | SAFE-02；FILE-04 |
| CL-01 | 功能需求 | FE＋BE（PM拆领取范围） | CL 工作流：Pending 表单、文件移动/拖放、Default 与分页 | 已实现待验收 | P1 | [PendingPage.tsx](../../src/features/changelists/components/PendingPage.tsx)；[changelist_service.rs](../../src-tauri/src/app/changelist_service.rs) | 旧 localhost/自动化已有；最新验默认 CL 唯一、长列表、选择、跨 CL 移动/失败刷新 | SAFE-02；WIN-P0-04 |
| CL-02 | 功能需求 | FE＋BE（PM拆领取范围） | CL 工作流：Submit 预检、执行与结果复核 | 已实现待验收 | P1 | [submit_service.rs](../../src-tauri/src/app/submit_service.rs)；[FileClWorkflow.tsx](../../src/features/changelists/components/FileClWorkflow.tsx) | 已有旧 fixture 闭环；最新验阻断项/取消/重复确认/连接变化与安全清理 | SAFE-02；WIN-P0-04 |
| CL-03 | 功能需求 | FE＋BE（PM拆领取范围） | CL 工作流：Shelf/Unshelve/Resolve/手工文本合并 | 已实现待验收 | P1 | [workflow_service.rs](../../src-tauri/src/app/workflow_service.rs)；[manual_merge.rs](../../src-tauri/src/app/manual_merge.rs)；[ShelfDetailPage.tsx](../../src/features/changelists/components/ShelfDetailPage.tsx) | 已有旧 fixture；最新原生完整流程及 Shelf deep-path 跳转仍缺，验 CAS/备份/冲突保留 | SAFE-02；WIN-P0-04 |
| CL-04 | 功能需求 | FE＋BE（PM拆领取范围） | CL 工作流：全局 CL 详情弹窗与 Go To CL | 已实现待验收 | P1 | [ChangeDetailsDialog.tsx](../../src/features/changelists/components/ChangeDetailsDialog.tsx)；[SubmittedGoTo.tsx](../../src/features/changelists/components/SubmittedGoTo.tsx) | 已抽查 History/Pending/Submitted/FileReview/工具栏共享打开动作，搜索通过 App 导航继续核验覆盖；取消/迟到隔离代码已接；Go To 明确仅 submitted，验错误/空/长内容/关闭回焦点，不改筛选 | QA-01；SAFE-02 |
| SUB-01 | 功能需求 | FE | Submitted 与周报：单用户筛选、无 Client/Job、预设迁移与即时应用 | 已实现待验收 | P1 | [submittedFilters.ts](../../src/features/changelists/submittedFilters.ts)；[SubmittedFilterPanel.tsx](../../src/features/changelists/components/SubmittedFilterPanel.tsx) | schema4 丢弃旧隐藏条件，保留当前 Stream；验 reset/保存/恢复/空预设与不重复刷新 | QA-01 |
| SUB-02 | 功能需求 | FE＋BE（PM拆领取范围） | Submitted 与周报：Stream 多选 OR、当前快捷项、稳定分页 | 已实现待验收 | P1 | [repository.rs](../../src-tauri/src/p4/changelists/repository.rs)；[submittedFilters.test.ts](../../src/features/changelists/submittedFilters.test.ts) | 两项纯 Rust 并集测试通过；最多16项、去重、扫描不全报错；需 mock/fixture 验实际分页、当前+显式及换连接 | SAFE-02；QA-01 |
| SUB-03 | 功能需求 | FE | Submitted 与周报：普通/疑似 CI/自动生成分类 | 已实现待验收 | P1 | [submittedReport.ts](../../src/features/changelists/submittedReport.ts)；[SubmittedPage.tsx](../../src/features/changelists/components/SubmittedPage.tsx) | 精确元信息签名的启发式，不验证 CI 身份；仅筛已加载记录，验数量诚实性/不吞人工同描述 CL | QA-01 |
| SUB-04 | 功能需求 | FE | Submitted 与周报：单用户日期区间生成周报提示词 | 已实现待验收 | P1 | [submittedReport.ts](../../src/features/changelists/submittedReport.ts)；[SubmittedReportDialog.tsx](../../src/features/changelists/components/SubmittedReportDialog.tsx) | 独立分页、最多100页/5000候选、完整描述和CL引用、部分结果标记；本地生成且仅点击复制。验跨周/时区/取消/上限/遗漏，不上传 AI | QA-01；SUB-06 |
| SUB-05 | Bug修复 | FE | Submitted 与周报：结果虚拟行重叠修复、CL 展开、紧凑筛选与结果摘要 | 已实现待验收 | P0 | [ChangelistPage.tsx](../../src/features/changelists/components/ChangelistPage.tsx)；[workbench.css](../../src/app/styles/workbench.css)；[SubmittedPage.test.tsx](../../src/features/changelists/components/SubmittedPage.test.tsx) | 当前摘要64px、展开自然高度，ResizeObserver正值测量更新虚拟行偏移/总高，忽略隐藏页零测量；文件复用外层滚动视口，已替代固定324px方案。此前静态检查通过不等于当前追踪WIP全量编译通过。验100+行、多CL展开/收起、0/1/多文件、筛选折叠/resize、宽窄与150%缩放、下拉不裁切；Depot/Stream与起止日期各同排 | QA-01 |
| SUB-06 | Bug修复 | FE＋BE（PM拆领取范围） | Submitted 与周报：查询时间边界与 Depot Path 诊断 | 部分实现 | P1 | [submittedFilters.ts](../../src/features/changelists/submittedFilters.ts)；[command.rs](../../src-tauri/src/p4/changelists/command.rs) | 本地时间转UTC后格式化无时区 P4 日期，8h差能解释但服务端解释未证；需假服已知时区边界验证后决定修法。裸 Depot Path 原样，Stream 加 /... 已有1项纯参数测试 | SAFE-02；不猜真实 depot |
| SEARCH-01 | 功能需求 | FE＋BE（PM拆领取范围） | 搜索与分支：七类全局搜索、Stream/Shelf 深度搜索 | 已实现待验收 | P1 | [SearchPage.tsx](../../src/features/search/SearchPage.tsx)；[search_service.rs](../../src-tauri/src/app/search_service.rs) | 已非待开发；旧原生看到类别/Stream跳转，Shelf deep-path 到详情与大规模 partial/权限仍待验 | SAFE-02；CL-03 |
| SEARCH-02 | 功能需求 | FE＋BE（PM拆领取范围） | 搜索与分支：Stream 切换与只读 Graph | 已实现待验收 | P1 | [stream_switch_service.rs](../../src-tauri/src/app/stream_switch_service.rs)；[StreamGraphPage.tsx](../../src/features/browsers/StreamGraphPage.tsx) | 旧 fixture切换/原生5节点已验；最新验切换预览/可选sync、缩放键盘与独立窗口 | SAFE-02 |
| SEARCH-03 | 功能需求 | FE＋BE（PM拆领取范围） | 搜索与分支：Branch Mapping 列表/详情/预览/受控CRUD | 已实现待验收 | P1 | [branch_mapping_service.rs](../../src-tauri/src/app/branch_mapping_service.rs)；[BranchMappingsPage.tsx](../../src/features/browsers/BranchMappingsPage.tsx) | 旧原生正向预览和fixture CRUD有证据；反向、窄屏、popout与权限/trigger边界需补。新增用户异机列表重叠反馈：根目视截图为81/81条、多行约10px间隔叠字、底两行正常、外围UI正常；本机未复现，0.1.2影响未确认，不能据截图断定根因。根已派FE仅此修复与mock视觉，根最新报告候选修复7测通过、像素未验；按PM队列在自然检查点核实源码与待验项，不重新打断FE；此前代表表验收不覆盖该页 | FE限定缺陷核查；纯mock视觉；真实假P4另依赖SAFE-02 |
| OPS-01 | 功能需求 | FE＋BE（PM拆领取范围） | 工具与可靠性：Terminal/P4 Log/Journal/诊断脱敏 | 已实现待验收 | P1 | [ToolArea.tsx](../../src/features/tools/ToolArea.tsx)；[runner.rs](../../src-tauri/src/p4/runner.rs)；[log_store.rs](../../src-tauri/src/persistence/log_store.rs) | 受控终端与日志链已有；最新验快捷键/独立窗口/上下文隔离/仅Error红点、日志不抢焦点/导出脱敏 | SAFE-02；UI-03 |
| OPS-02 | 重构与代码优化 | FE＋BE（PM拆领取范围） | 工具与可靠性：共享缓存、取消/代次隔离、大列表性能 | 已实现待验收 | P1 | [useSnapshotQuery.ts](../../src/shared/cache/useSnapshotQuery.ts)；[status_cache.rs](../../src-tauri/src/app/status_cache.rs)；[项目状态总览.md](../../ForAIDoc/PM/项目状态总览.md) | 旧100k基准仅历史设备与版本；最新验连接切换不串数据、上限和长滚动，无固定性能阈值时不宣称性能认证 | QA-01；WIN-P2-01 |
| OPS-03 | 功能需求 | BE | 工具与可靠性：Swarm 安全链接 | 已实现待验收 | P2 | [swarm_open.rs](../../src-tauri/src/app/swarm_open.rs)；[Swarm基础链接.md](../../ForAIDoc/Coder/Swarm基础链接.md) | 只做URL打开、无API/评论/创建Review；本轮禁止外部请求，安全测试先mock，真实外部验收另授权 | 明确外部验收授权 |
| WIN-P0-01 | 功能需求 | PM（实现按需领取） | 阶段收口：最新原生构建/启动/版本绑定 | 部分实现 | P0 | [Windows原生构建运行验收.md](../../ForAIDoc/Coder/Windows原生构建运行验收.md) | 旧94b5f0c等证据不代表当前7af7671+脏工作树；记录源码快照、产物hash与原生退出，勿要求先清除用户改动 | SAFE-02 |
| WIN-P0-03 | 功能需求 | PM（实现按需领取） | 阶段收口：历史本人 Server 验收 | 受阻 | 不执行 | [开发路线图.md](../../ForAIDoc/PM/开发路线图.md) | 当前禁止生产包括只读；保留历史项但冻结，不作为AI下一动作，也不要求用户现在授权生产 | 当前用户安全约束 |
| WIN-P2-01 | 功能需求 | PM（实现按需领取） | 阶段收口：连续2小时稳定性验收记录 | 待实现 | P2 | [Windows本机私用TODO.md](../../ForAIDoc/PM/Windows本机私用TODO.md) | 这是未执行验收任务，不是缺少功能代码；最新假服构建覆盖重启/切换/日志/列表，记录资源与故障，关闭P0后进行 | WIN-P0-01；WIN-P0-02/04 |
| OPT-01 | 功能需求 | PM（实现按需领取） | 后续候选：Labels/Jobs独立工作台、Stream spec写入、全量高级菜单 | 建议待确认 | 未排期 | [catalog.ts](../../src/app/context-menu/catalog.ts)；[开发路线图.md](../../ForAIDoc/PM/开发路线图.md) | 静态数到190个phase:later；不是190项已承诺任务。选择实际需要的场景再立项，Force Unlock已明确退役不可恢复 | 用户范围决定 |
| OPT-02 | 功能需求 | PM（实现按需领取） | 后续候选：跨平台/发布/兼容矩阵/自动更新/外部认证 | 建议待确认 | 未排期 | [开发路线图.md](../../ForAIDoc/PM/开发路线图.md)；[后端TODO.md](../../ForAIDoc/PM/后端TODO.md) | macOS/ARM/多版本/签名/updater/remote CI不是当前私用阻塞；SSL/SSO/MFA仅新需求下评估，不因功能盘点自动开发 | 用户交付目标决定 |
| UI-05 | 功能需求 | FE | 界面与导航：Appearance主题色预设＋自定义（用户已批准） | 已实现待验收 | P1 | [SettingsPage.tsx](../../src/features/settings/SettingsPage.tsx)；[usePreferences.ts](../../src/app/hooks/usePreferences.ts)；[tokens.css](../../src/app/styles/tokens.css)；[并行交接](并行交接.md) | 根转发FE已完成并停写：5个预设＋自定义、预览/保存/跨窗口同步已实现，语义颜色独立。FE报告TS/CSS/format/diff通过；2026-10-28根转发正式require_escalated原命令exit 0，5文件19项纯mock全部通过（2＋1＋7＋4＋5），源码与冻结一致、本轮无修改；React act环境警告无失败。视觉及假P4尚未验。仍需验证浅深主题、非法输入、刷新/重开/跨窗口同步与布局不回归；静态色值计算不关闭验收 | FE；SAFE-03；QA-01 |
| SUB-07 | 功能需求 | FE＋BE（PM拆领取范围） | Submitted 与周报：CI结构化来源CL引用链及自身workspace（用户最新替换需求） | 已实现待验收 | P1 | [并行交接最新规格](并行交接.md)；[全项目表格统一覆盖矩阵](../Designer/全项目表格统一覆盖矩阵.md) | 以CI描述完整已识别元数据中的来源CL号建反向索引/有向边，从源CL计算直接/间接可达合并CL，逐条显示其自身client/workspace；合并来源路径仅作来源证据，不是目标workspace。不要求正文相同，不查integrated/文件，不匹配正文数字/issue或CL号子串。缓存提交描述与引用索引，串行有界分页累积后重算可达，支持乱序页、取消/续查及未完整短状态；当前筛选不限制调查。旧正文匹配实现/测试仅历史证据；根转发新引用链及虚拟叠字/紧凑顶部/删作者已落盘，21文件176通过，最终列宽后6文件28再通过，TS/diff通过（批次可能重叠）。PM只读确认结构化完整CL号解析与反向索引可达计算；纯mock浏览器视觉进行中，原生/假P4未验。需验直接/多跳、子先父后、同CL多路径/环/重复页、数字边界、缺失/畸形元数据、缓存与失败/取消。UI-04拖宽复用、删候选作者列/两句长说明及紧凑顶部继续，主表作者不动。用户最新要求时间统一显示本地年月日时分，尤其调查范围/读取时间，不显示UTC/ISO/时区说明；仅改展示，不改内部query边界。根已确认范围起止均调用formatLocalTime（DescriptionTraceDialog:414，ChangelistPage:222实际入口），读取/提交时间也本地化，toISOString仅用于内部query；3文件19通过、TS/diff通过。已交BE更新staging/hash，旧截图不代表新格式，不外推新视觉验收 | FE＋BE新链路；UI-04；SAFE-03；QA-01；实际假P4验证仍依赖SAFE-02 |
| PKG-01 | 功能需求 | BE | 阶段收口：其他设备可用的Windows体验包（候选已交付，安装未验） | 已实现待验收 | P1 | [Windows体验包交付](../Coder/Windows体验包交付.md)；[artifact-info.json](../../artifacts/package-0.1.2-20261028/artifact-info.json) | 2026-10-28已产出0.1.2 x64 NSIS候选，223452134 bytes，PM核对文件大小/SHA-256与artifact-info一致；具体hash及位置见交付记录。staging TS/生产前端/Rust release/NSIS通过，源码变化0、检查标记未命中（根转发BE）。内置微软签名有效离线WebView2；不捆P4 CLI，配置/PATH/标准目录统一发现，缺失官方获取/重新检测，自定义路径可能需指定。安装包NotSigned；干净安装/启动/卸载及跨设备均未验，不归档为完全验收，不保证直接可用。用户已获位置及限制。新增异机Branch Mapping列表重叠反馈，是否属于0.1.2尚未确认；当前候选不因旧代表表证据获得全页验收，也不视为含最新Branch叠字、JSON空白修复或CON-05启动引导。上述实现可并行，最终集成回归须使用同一新源码；视觉隔离入口运行批准待用户，暂不构建或发布新包 | 仅剩获准隔离安装/启动/卸载及跨设备验收；禁止生产访问/公开发布；其他项目停工 |
| CON-05 | 功能需求 | FE | 连接与工作区：无生效P4配置的强制启动引导（用户已批准） | 已实现待验收（合成UI已通过） | P1 | [gate证据](../../src/test/preview-audit/gate-evidence/results.json)；[并行交接](并行交接.md) | 无有效激活配置引导设置，验证成功放行；已配临时断网不当首次。最新初始焦点修至配置按钮，21合成浏览器断言＋47相关mock/TS/diff通过；PM核JSON/源码/390px图。真实Gate但配置卡片/CLI/关闭为替身，不能证明真实认证/下载/原生关闭；保留迟到/连接代次/错误恢复与端到端门槛。合成阶段收尾，不计整包完成，不打包 | 实际连接依赖SAFE-02；原生关闭依赖UI-07宿主验收 |
| CL-05 | 功能需求 | FE | CL工作流：Pending编号数值正倒序按钮（用户已批准） | 限定dev人工通过（其余范围保留） | P1 | [pending证据](../../src/test/preview-audit/pending-evidence/results.json)；[并行交接](并行交接.md) | 11浏览器断言＋23mock边界/刷新、TS/diff通过，无新增产品改动。PM核JSON/hash及390px图Default/2/10/100顺序；合成验升降序、选择展开、菜单拖放目标、既有偏好及零额外读取。真实Pending逻辑但数据/菜单/移动确认替身，不能外推真实P4执行或全包；保留Default特殊位置和现有交互 | 真实操作依赖SAFE-02；本项合成阶段收尾 |
| UI-06 | 功能需求 | FE | 界面与导航：全局横纵滚动条对比与边界（UI优化） | 已实现待验收（本次滚动条清晰人工通过） | P1 | [滚动条覆盖](../../src/test/preview-audit/scroll-evidence/coverage.json)；[并行交接](并行交接.md) | 双主题28实际拖动及4窄窗150%检查通过，另2无横向溢出不计实际拖动；17mock/TS/diff通过，无产品改动。PM核矩阵/JSON/hash及Dockview截图，表格/虚拟表/预览真实组件，弹窗/侧栏/嵌套部分结构替身。保留Windows WebView、OS overlay/高对比、未实例化Dockview自绘纵条缺口；不能宣称全平台/所有页面验收 | 原生/OS覆盖待验；本轮合成矩阵收尾 |
| CL-06 | 功能需求 | BE调研；后续FE/BE由PM分阶段派单 | CL工作流：自定义提交工具配置与原提交入口分流 | 进行中（I3 QA及用户人工启动通过，连续会话等边界保留） | P1（先调研） | [并行交接调研任务单](并行交接.md) | 用户要求研究旧P4V待提交CL右键公司入口并接入；BE静态确证customtools.xml调用DevGuardSubmitTool.exe 3.36.1.0、签名Valid，菜单为Custom Tools而非Jobs；工具内部Jobs/退出码/工作目录/认证/default CL仍未知。先只读本机P4V自定义工具配置/相关已安装脚本及官方Custom Tools/Jobs文档，识别customtool/job/其他机制、CL参数/路径/依赖与缺配置降级，再定方案安全边界，最后实现验收。根已核实目标为菜单底部“提交当前CL”，另有查看提交详情/提交选中文件；标准Submit及Remove All Jobs独立存在，不证明Jobs机制。PM直接派发曾遇AbsolutePathBuf错误；根已按PM任务单转交空闲BE，工具确认started，仅只读调研已启动，实施未开始。用户后要求独立研究Agent，独立线程01a1814f-5e59-7699-b5be-f55db37820e5“调研公司提交入口”已创建，BE已自然完成交接，研究员只读续查已完成，PM已读最终报告；S审核通过最小单编号pending CL的mock边界，真实cwd/认证优先级/后台生命周期仍未知。用户明确无文档，PM已给独立研究员R2完成且PM直接审核，未新增运行契约；I1固定参数/路径/连接快照/防重纯mock排既有队列后，真实启动禁用；动态下一步仅询问可回滚独立Windows VM是否可用，不再等待用户提供文档作为唯一前置；不得执行工具或生产验证。仅阶段完成，I未派；mock切片排现有六项后，实际公司工具不执行。禁止启动P4V自动连接、点击入口、执行公司脚本或生产P4查询（包括jobs/info）；配置命令仅作数据，敏感信息脱敏 | CL-06-R调查→CL-06-S方案→CL-06-I实现验收；FE原队列不打断；公司入口执行需独立安全边界 |
| CL-07 | 功能需求 | FE＋BE；QA独立 | CL工作流：跨多个Pending CL提交选中文件 | 已实现待验收（已合入，待用户本地假P4人工验收） | P1高优先，当前项自然收尾后 | [CL07-I01批单](并行交接.md) | 跨Default/编号CL选文件，预览并填写描述后新建CL，仅移动选中、核成员后走既有custom/native提交路线；部分失败不提交，取消保留新CL，不自动回退/回移；mock覆盖幂等、身份变化和逐文件恢复事实 | CL-01；CL-02；CL-06；UI07；用户dev安全写入边界 |

| UI-07 | Bug修复 | BE宿主先行；FE自然检查点协作 | 界面与导航：WebView导航/初始化失败时保留关闭与恢复通道 | 部分实现（旧原生兜底已撤销，待CHROME-OFF替换；CLOSE独立继续） | P0 | [tauri.conf.json](../../src-tauri/tauri.conf.json)；[TopBar.tsx](../../src/app/shell/TopBar.tsx)；[并行交接](并行交接.md) | 根核实截图为Edge ERR_CONNECTION_REFUSED/127.0.0.1，无应用标题栏或关闭按钮。主窗decorations=false、devUrl=127.0.0.1:1422；截图无端口，未证明dev断服或生产资源错误，0.1.2影响未知。先核查实际构建/导航路径及原生关闭生命周期；网页不可达也须有宿主级关闭保障，React边界仅覆盖页面内错误。故障注入验主窗/popout/启动引导/初始化失败、系统关闭快捷键及未保存/在途操作保护；不得强杀/静默丢失、不改代理防火墙。纯mock不等于原生关闭验证 | BE1纯策略11/11已审核；FE1A完成；BE2发现旧文档身份不可证；PM冻结v1.1保持wire，未验证clean一律unknown并原生确认，FE1根报告82＋1测试/TS/diff通过，PM核4场景TopBar JSON及390px图；BE2根报告12纯测试＋11策略回归/libcheck/fmt/diff通过，PM抽查v1.1宿主接线；实现阶段收尾，原生故障验收明确挂起，现释放JSON-only待根代转，不归档全项；隔离原生验收另证；不自动打包 |

| PKG-02 | 功能需求 | BE调研；FE/BE按PM阶段派单 | 阶段收口：检查新包、提示并由用户点击自动更新 | 进行中（R完成，方案待定） | 最后（用户排序） | [并行交接R任务单](并行交接.md)；[tauri.conf.json](../../src-tauri/tauri.conf.json) | 当前未见updater依赖、createUpdaterArtifacts=false。只读评估Tauri2官方updater/NSIS、更新签名与OS签名、可信HTTPS发布源、版本渠道/失败恢复、UI-07安全退出及首个updater版本迁移；R→S→I→V分别验收。默认不强制/静默安装，不上传账号/P4配置/遥测。用户无现成托管，GitHub Releases为候选，用户已确认安装包公开可接受，可独立发行仓库不公开源码；owner/repo尚未指定，不能自行创建/上传，禁止客户端共享PAT或假定浏览器cookie可供updater；公开GitHub Releases方案待具体目的地与发布权限，离线UPD-S01移至最后，当前不推进实现；源码不获公开许可，不生成私钥、不部署/上传/接受协议。根转发R结论：0.1.2无updater需首次手装支持版；自动检查提示保留，手动检查不能替代；Windows安装前必须BE完成UI-07许可同锁交接，FE不得直install | UI-07安全关闭；PKG-01安装验证；发布源/签名方案；R可空闲BE先行，实施不打断FE既有队列 |

## 完成项归档（历史基线有证据，不外推最新版本）

分类仅重整台账，不新增完成结论。混合项子项见后表，父项的完成总数仍按主表唯一ID统计。

| ID | 类型 | 负责人 | 模块 / 范围 | 状态 | 优先级 | 证据路径 | 关闭范围与回归边界 | 依赖 |
|---|---|---|---|---|---|---|---|---|
| WIN-P1-01 | 功能需求 | BE | 工具与可靠性：故障恢复与退出进程回收 | 已实现且有相应验收证据 | 归档 | [故障恢复与配置备份.md](../../ForAIDoc/Coder/故障恢复与配置备份.md) | 2026-10-22 Debug/HMR+隔离fixture原生记录含断服/ticket/离线重启/取消/执行中退出；完成限该基线，最新构建回归纳入OPS-01 | 旧基线证据；非本轮重跑 |
| WIN-P1-02 | 功能需求 | BE | 工具与可靠性：非敏感备份/恢复/回滚与DPI恢复 | 已实现且有相应验收证据 | 归档 | [backup.rs](../../src-tauri/src/persistence/backup.rs)；[故障恢复与配置备份.md](../../ForAIDoc/Coder/故障恢复与配置备份.md) | 2026-10-22原生创建/退出恢复/pre-restore回滚与凭据canary有记录；不是普通备份可含凭据，最新回归并入WIN-P0-02 | 旧基线证据；非本轮重跑 |

## 下一批最优先任务

### 混合工作包关联子项（分别验收，不重复计数）

| 子ID / 父项 | 类型 | 负责人 | 优先级 | 状态 | 依赖 | 验收证据与剩余标准 |
|---|---|---|---|---|---|---|
| CON-01-F01 / CON-01 | 功能需求（UI布局） | FE；QA | P1，UI-T01同批 | T01限定QA通过/残余保留；I3改动待复验 | 连接设置局部布局/回归 | User与Workspace各仅保留浏览（放大镜真实选择功能）并置input同行右侧、同高度主题；仅删除本处新建入口，保留Workspace Root输出、其他创建/后端及保存验证，窄屏不挤压 |
| UI-01-F02 / UI-01 | 功能需求（入口精简） | FE；QA | P1，UI-T01同批 | T01限定QA通过/残余保留；I3改动待复验 | 顶toolbar组配置及定向回归 | 仅删眼睛icon“CL详情/查看CL详情”工具栏入口，保留旁边刷新、共享弹窗/右键预览/GoTo及后端；与提交CL去重分项验收，不全局删动作 |
| CL-05-F01 / CL-05 | 功能需求（UI视觉修整） | FE；QA | P1，UI-T01同批 | T01限定QA通过/残余保留；I3改动待复验 | 与Branch Owner复用已有控件样式 | Pending主页面过滤input与CL排序button灰原生样式，根核约35px且已对齐；仅主题/边界/状态统一，保留既有布局与高度；不改排序/筛选/新建/提交确认、不增加查询，两页同批QA视觉回归，截图细节待根补充 |
| SEARCH-03-F01 / SEARCH-03 | 功能需求（UI视觉修整） | FE；QA | P1，下一UI批 | T01限定QA通过/残余保留；I3改动待复验 | 复用现有控件样式；截图像素待根补充 | Branch Owner输入框/按钮统一高度/主题/圆角/边界/间距/基线与窄屏换行，仅局部样式；不改筛选/不增加查询，与UI-07-F01可同批分别验收 |
| UI-07-F01 / UI-07 | 功能需求（UI外观） | BE方案；FE/QA后续按批 | P1，近期方案优先 | CHROME-I01已放行（I3手验独立） | 动态decorations/当前窗控ready协议/原生隔离验收 | 正常恢复自绘窗控，仅页面失效无可用窗控时原生兜底；always decorations=true不满足最新要求。先核Tauri能力、同URL旧ready/后台节流/恢复与DPI，不打断M01；关闭仍统一安全协调 |
| UI-02-B01 / UI-02 | Bug修复 | FE；QA协作 | P1，当前批内最小收尾 | 已验收（英文＋稳定ID套件72/72） | QA-I2 labels冻结安全交接 | 既有“重命名工作区…”缺英文映射导致菜单测试失败；仅补映射/定向回归，新hash重冻结；菜单C01-10/C02-14/C12-04及C09/W01文档漂移PM已补，收尾批一次复验，不混算产品Bug |
| SEARCH-03-B01 / SEARCH-03 | Bug修复 | FE | P1 | 用户dev人工通过（限定范围） | FE自然检查点核对；获批专用入口及Branch fixture覆盖 | 根报告Branch81行叠字候选7测通过，像素未验；核对源码与测试，再验证81条/滚动/缩放无重叠。父项CRUD不因本Bug关闭自动归档 ；2026-10-28用户明确四项通过，登记09:45:09 UTC，具体版本/环境未提供，见交接原话 |
| FILE-01-B01 / FILE-01 | Bug修复 | FE；BE按需协作 | P1 | 用户dev人工通过（限定范围） | data.content已到FE；安全mock | 根报告BE7测试正常；FE高度候选已落盘，本批10文件111mock/TS/diff通过，新视觉未验；仍需验证虚拟挂载，验0尺寸、隐藏重显、resize、空/错误及原正文换行；不重复后端已证检查 ；2026-10-28用户明确四项通过，登记09:45:09 UTC，具体版本/环境未提供，见交接原话 |
| UI-01-F01 / UI-01 | 功能需求（UI优化） | FE；QA验收 | P1 | 用户dev人工通过（限定范围） | 既有steer修改先核实 | 只去顶栏纸飞机提交CL按钮；待提交导航、Pending内部提交和确认/后端命令保留。根转发已落盘，本批10文件111mock及TS/diff通过，新视觉待批准 ；2026-10-28用户明确四项通过，登记09:45:09 UTC，具体版本/环境未提供，见交接原话 |
| UI-04-R01 / UI-04 | 重构与代码优化 | FE | P1，既有切片 | 已实现待验收（限定代表验证） | UI-04可拖列宽需求；覆盖矩阵 | 共享useColumnWidths/ColumnResizer/ResizableTable等抽取接入已有源码，最终5文件26通过及代表浏览器结果见矩阵；状态隔离/虚拟高度/交互兼容，不宣称14表全视觉。父项仍为用户拖列宽功能需求，抽取不另计完成 |
| SUB-05-F01 / SUB-05 | 功能需求（UI优化） | FE | P1，既有切片 | 已实现待验收 | SUB-05虚拟行Bug回归；QA-01 | 紧凑筛选、结果摘要、自然展开等用户需求与重叠Bug分别判断；旧静态/限定mock证据不外推全部新布局像素通过 |

CL-06需求阶段：CL-06-R只读调研由空闲BE领取，R只读调研已完成，S已审核mock边界，真实启动契约以独立R2只读证据/必要隔离实验计划推进，不等不存在文档；CL-06-S已根据独立报告审核最小方案/安全边界，三组维护者问题见交接；CL-06-I实施验收依赖已确定方案并在FE原六项队列后领取。三阶段均属功能需求（不是重构，R仅表示Research），不额外计工作包；R有完成报告，S有审核结论，I尚未实施/验收。验收要求及禁止项见交接任务单。

待办分类视图：Bug队列当前为SEARCH-03-B01在手项自然收尾→UI-07（P0）→FILE-01-B01；需求后继为CON-05→CL-05→UI-06→UI-01-F01。重构优化仅保留UI-04-R01及OPS-02既有证据/未验范围，本次不插入新重构任务。归档只保留主表WIN-P1-01/02两项历史完成；SEARCH-03-B01及FILE-01-B01已按各自合成复现与修后证据关闭，父项SEARCH-03及全包未归档；主工作包数量不变。

### 最新调度覆盖：UI-06限定浏览器通过，释放UI-01-F01-only

PM已读取branch-evidence/results.json并查看before/after-hidden-restored-exposed.png：旧隐藏恢复出现叠字，修后分行正常。24条检查为前后各12组，修后12组overlap/overflow均false，errors/blocked空；末组含index95，96条末行可达。源码baseline/current hash已记录。根报告7/7mock、TS/diff通过、无外部请求、专用服务已关闭。SEARCH-03-B01仅该具体缺陷合成场景验收闭环，不外推Branch CRUD、原生WebView、他人设备或0.1.2新包。主表SEARCH-03保持实现待验收，完成主包仍2项。

Branch已自然停笔，旧capacity恢复待办及“当前执行Branch”段落仅留历史，禁止再次续派。当前UI-07：FE1及BE2实现阶段已收尾，原生故障验收挂起；JSON-only已合成闭环，CON-05及CL-05合成UI已通过，UI-06限定矩阵通过，UI-01-F01-only任务单已释放待根代转。以下BE1/契约等待文字为历史步骤，以交接顶部最新记录为准。契约经PM确认后才派FE布局/状态适配、BE宿主接线；随后JSON。原生故障注入未执行，不打包。

### 当前执行队列（历史步骤结合上述最新调度）

**当前执行项：FE已自然收尾，代码不重做；六项进入待验收检查点，用户已批准专用synthetic-only视觉入口，当前仅释放SEARCH-03-B01验收，根转交曾确认started；FE原turn因model capacity失败无最终报告，部分文件/进程/证据待恢复核对。PM已拟一次保留现模型的同线程恢复单，直接派发durable失败，根已确认恢复turn 01a1815f-a7b1-722f-8134-22b556b21639 started，结果待回报，不重复恢复。UI-07 BE只读诊断完成、S已审，BE1待代转，FE不追加新功能。** 根最新确认：JSON高度候选、CON-05启动引导、CL-05排序、UI-06滚动条、UI-01删顶提交均落盘，10文件111mock＋TS/diff通过；Branch候选此前7测通过。专用配置 `src/test/preview-audit/vite.config.mjs` 现获用户批准，执行/结果仍待确认；白名单当前主要覆盖FilePreview，Branch缺失须精确补synthetic fixture而非放开App，0.1.2不含这些改动。以下队列仍保留验收顺序；旧获取FE状态失败是历史，不覆盖本次根转发结果。 FE线程 `01a18135-e9c5-7728-9d7d-73616359bca7` 的只读状态获取失败（durable host unavailable），以下按根已提供证据排序，不冒认FE当前正在某一子项。根在其自然检查点转发这份状态请求：六项分别已改哪些文件、是否已测/结果、未做部分、当前安全停笔状态；不要追加实现指令。PM收到后跳过已证实完成的实现，先验后派。

| 顺序/现有ID | 领取内容与当前证据 | 验收与后继条件 |
|---|---|---|
| 1 SEARCH-03-B01（Bug） | 原turn capacity失败，根已确认同线程恢复started，结果待回报；先核已产文件/服务/证据，不能当未发生；Branch Mapping 81行叠字；根报告候选修复7测通过，像素未验。保留修复，不重新盲写 | 核对7测范围与源码，获批后纯fixture复现81条及滚动/缩放/行高无重叠；未批准只做已获准检查，像素验收挂起，不记完成 |
| 2 UI-07（P0 Bug） | BE先只读核查主窗无原生装饰、导航失败与关闭保护；FE在Branch自然检查点后协作，当前不打断 | 先回报最小宿主方案/故障注入计划，经PM拆定实现与验收；不能只加React错误边界或建议任务管理器；不自动进入后继 |
| 3 FILE-01-B01（Bug） | JSON小文件正文空白；BE7项测试正常，data.content已到FE，FE查虚拟挂载。BE保持空闲，除非PM依据证据派接口协作 | 保留原JSON文本/换行；验content已到但容器初始0尺寸、挂载/隐藏再显示、resize/滚动、空文件与错误状态。不能以BE通过推定前端已修；不重跑生产读取 |
| 4 CON-05（需求） | 无生效P4配置强制引导；已散发，已落盘，本批111mock通过，视觉未验 | 配置加载完再判定，设置/CLI获取/退出可达，验证成功放行、失败可恢复；已配临时断网不误当首次，迟到结果/代次隔离 |
| 5 CL-05（需求） | Pending CL编号数值正倒序；已落盘，本批111mock通过，视觉未验 | 数值2/10、Default特殊位置、空/单条、选择/展开/菜单/拖放保持，排序不额外查询 |
| 6 UI-06（需求/UI优化） | 全局横纵滚动条对比/边界/hover-active浅深主题；非Pending局部 | 表格/弹窗/侧栏/预览及嵌套滚动逐入口核对；保留布局/列宽/虚拟高度、两方向可见可拖、窄屏缩放；视觉批准未答不能算已验 |
| 7 UI-01-F01（需求/UI优化） | 仅删顶toolbar纸飞机“提交CL”；已落盘，本批111mock通过，视觉未验 | 待提交导航与Pending内部提交、确认流程、后端命令均保留；验入口去重/键盘/窄窗，不执行生产提交 |

每次仅释放一项执行并审查证据，完成再归档；若运行批准阻塞，PM明确挂起其验收后才可释放独立下一项，状态保持未验，不由执行者自动跳队。原六项均挂在既有ID；UI-07为新增一个Bug工作包。最新P0插队安排覆盖旧六项顺序描述，不打断Branch在手操作。当前优先处理用户报告的可见缺陷，再启动引导，再排序/滚动条及入口去重；实际已有实现不回退、不重复劳动。最终合并验收绑定同一新源码，暂不打包。长期调度规则见[并行交接](并行交接.md)。

并行交接已确认停笔，根线程已释放文档写权限。FE只写 `src/**`，BE只写 `src-tauri/**`，PM只写 `ForAIDoc/**`；`scripts/**` 与根配置由根线程协调。共享IPC先由BE提出并经根线程转发确认，TS类型/adapter/mock由FE单写；双方未确认前不把草稿标成冻结契约。

离线实现可与下述验收前置并行：UI-05与SUB-07前端切片已停写，TS错误已修；SUB-07后端已停写且定向回归/libcheck通过，下一步由FE核对最终契约与获准mock通路，再协调最小运行验证。全项目表格UI与可拖列宽已明确授权（UI-04）；不得扩大至额外排序/列显隐、目录Move或高级菜单；不得用静态通过替代运行验收。

1. **SAFE-01/02/03 + QA-01**：先完成可用隔离验收通道与 fail-closed QA 配置。安全核验失败时仅做离线工作；当前机器 connected/authorized 不代表 CIM、子进程或浏览器协议限制已解除。
2. **SUB-05 + UI-01**：以最新工作树先验用户刚报错的列表重叠，以及导航/设置/关闭入口。验100+条、展开文件、多次切页/筛选折叠、窄宽窗口和150%缩放，记录尺寸和截图；仍失败就定位，不再只用 CSS/类型检查结案。
3. **FILE-04/HIS-01/02 + CL-04**：假 backend 精确断言两侧 #revision；FIFO、右键目标、CL弹窗快切迟到；再在安全假服上做 Get/Undo 预览、取消与确认闭环。
4. **SUB-01/02/04/06**：补预设迁移、Stream OR 分页、周报完整性和时间边界证据；实际请求参数与UI一致，不把候选扫描上限当完整数据。
5. 合入 **WIN-P0-01/02/04 → WIN-P2-01** 的本机阶段收口。历史已完成恢复/备份无需重新开发，但应随最新构建回归。

## 真正缺实现与需要决定的范围

- **新增已确认功能**：UI-05主题色预设/自定义已实现待验收；SUB-07前端切片已完成，后端校验及整体语义/运行证据仍待收束。两项已纳入上表，不再作为表外新增计数。

- **当前安全缺口**：QA加载/恢复/切换的 fixture 绑定不完整；有门禁脚本不等于隔离闭环。优先修，不恢复无条件禁用QA方案。
- **当前未接通的产品能力**：通用表头排序/列配置仍明确 disabled；History独立拖列宽例外。Rename/Move仅单文件安全子集，范围外操作有意阻断；它们属于部分实现，不是隐藏按钮就算完成。
- **需要用户选择**：额外排序/列显隐是否需要（全项目可拖列宽已批准）、是否扩目录/case-only Move；是否需要 Go To 同时查 pending（当前 submitted-only，原请求未承诺新增）；P4VFS 是否准备实际使用。未决定前不扩功能。
- **不自动立项**：Label/Job工作台、Stream spec写入、190个后置菜单、Swarm API/Review、跨平台发布。Force Unlock已退役，不重新加入Todo。
- **时间语义**：先用假服已知时区证据确定日期偏移问题，不能让用户猜后端原因或直接改本机/服务器时区。

## 不得恢复的已覆盖旧需求

保留当前行为，不把以下旧设计作为“缺功能”重做：Client筛选、Stream仅当前、独立Merge分类、History满两条阻止新增或“最多两条”提示、专用比较按钮、History内嵌Diff、预览CL跳Submitted、预设“应用”按钮、左侧六导航、数量摘要置于筛选内部。Depot真实名称未知不是已证实代码缺陷；不能为修报错探测生产路径。

## 本次核对与验证限制

- **2026-10-27停笔交接证据**：最近追踪WIP的TS检查exit 1，`IntegrationTraceDialog.tsx` 报 TS2554（无初值的 `useRef<AbortController>()`）及 TS2322（赋undefined）；根已转发FE修复两处并通过TS/CSS/format/diff，故这两项编译错误关闭。根随后转发BE新证据：integration_trace/file_service/domain/runner切片已停写，10项新Rust/mock＋1项runner＋2项cache/cursor回归通过，offline locked libcheck通过。证据为根转发的BE报告，PM未重跑；不外推前端运行/视觉或假P4验收。详细原始记录见[并行交接](并行交接.md)。PM本次只核对文档行数、状态汇总及diff，不运行产品测试。

- 阅读 ForAIDoc 入口、现行任务表、状态总览、核心基线、前后端历史Todo、原生UI/恢复备份/安全核验与菜单文档；逐模块对照现有前后端入口，特别抽查 TableHeader 的禁用、Go To submitted目标、Undo真实契约、周报分页上限、虚拟行与导航接线。
- 历史证据：2026-10-22恢复/备份原生验收；2026-10-10等旧测试/fixture/原生记录。不继承为2026-10-27全绿。
- 本任务之前最近实际检查：定向 TypeScript/CSS/格式/离线 cargo check；Stream并集2项、filespec构造1项纯Rust测试已通过。最近 React/浏览器回归源码多数未执行；本轮文档盘点没有重跑。
- **旧阻碍未重新确认解除**：CIM listener 权限拒绝、独立 Windows PowerShell 执行策略拒绝、Vitest/Node测试子进程 EPERM。2026-10-27 **当前已确认拒绝**：CUA本地静态HTML的 file URL 被协议策略拒绝，未换协议/服务/浏览器绕过。不存在可据此声称完成的最新视觉截图。
- 有安全静态HTML样本与静态DOM测试源码，但不是完整React虚拟化/原生IPC验收，也未成功在受控浏览器打开。解除阻碍应走产品支持路径，用户无需搬运项目文件。

---

## 历史执行说明与验收快照（2026-10-10 至 2026-10-26，仅追溯）

以下保留原文与 WIN 编号，历史“当前/已完成/下一步”不得覆盖上方唯一任务表；生产连接步骤处于冻结状态，旧 Activity Bar 和旧 Submitted 筛选描述不是最新产品要求。


> 当前阶段唯一执行清单。目标是在**当前这台 Windows 机器上供本人私用**，不是公开发布、跨平台交付或企业部署。
> 建立日期：2026-10-10。事实基线：`94b5f0c` 已取得第一轮 Windows Tauri 原生构建/启动和部分核心点击证据；用户随后决定从面向普通用户的 P4Deck 中移除管理员 Force Unlock，管理员强制解锁改由后台执行。本人实际 P4 Server 仍未验证。
> 历史实现记录继续保留在《前端操作流程 TODO》和《后端 TODO》，但不再作为当前任务队列。

## 当前验收快照

- **WIN-P0-01 部分完成**：`94b5f0c` 的 `pnpm tauri build --debug --no-bundle` exit 0，真实 exe、SHA-256、可见响应窗口和隔离 IPC 已绑定留证；移除 Force Unlock 后的 `3c21d03` 也已成功重建并由本人启动人工验收，本次“移除原生顶栏菜单”的决定即来自该窗口。旧隔离验收 PID 已正常关闭，fixture 已停止且 listener 消失，原 Roaming/Local 已恢复，测试 snapshot 已保留。菜单移除版的最新构建/版本绑定以 [Windows 原生构建与运行验收](../Coder/Windows原生构建运行验收.md) 为准，仍需本人确认新窗口外观与连接入口。
- **WIN-P0-02 部分完成**：原生窗口已通过 Profile 保存/验证、Workspace Root 校正、七类 Search 与 Stream 跳转、Stream Graph 拓扑/详情、Branch Mapping list/detail/forward preview/安全 CRUD。首轮 build 还曾真实执行一次后来下线的 Force Unlock；该历史事实保留在验收记录中，但不再是当前能力、阻塞或待复验项。详见 [Windows Tauri 原生 UI 验收](../Coder/Windows原生UI验收.md)。
- **当前产品决定**：普通用户界面只保留普通 Lock/Unlock 及 other-owner blocker/提示；不提供 Force Unlock 按钮、对话框或 API 路径。管理员强制解锁由后台按运维流程执行。
- **当前入口决定**：Terminal/P4 Log 只保留底部工具区、命令面板、快捷键与独立 panel；Stream Graph/Branch Mappings 从 Streams 页按钮进入，并继续支持 Dock/popout。左侧 Activity Bar 不再重复显示这四个入口。任何新日志/Warning/Error 都不自动展开或切换当前工具，未查看 Error 只显示底部可访问红点，打开日志后清除。
- **尚未通过**：Shelf `deep-path` 结果到独立详情、其余完整只读入口、命令面板/前端快捷键、390px、dock/popout/归还、焦点、关闭重开/布局恢复，以及剩余安全写入流程。本人验收认为原生 Connection/Changes/Navigate/View 顶栏菜单重复且不符合设计，现已从产品移除；连接管理继续位于 Settings。
- **WIN-P1 已完成**：2026-10-22 已在 Debug/HMR、QA Profile 和 loopback fixture 的 Windows Tauri 原生窗口中完成 Server 停止、ticket 缺失、离线重启、取消、执行中退出、配置备份/恢复/回滚和 150% DPI 窗口恢复验收。演练同时修复了退出后孤儿 `p4.exe`、Journal 时间偏移和窗口尺寸重复乘 DPI 三个缺陷。
- **未开始/未验**：本人实际 Server（WIN-P0-03）、完整核心读写安全演练（WIN-P0-04）和全部 P2。
- **控制停止事实**：提交 `707e51e` 后工具返回 “Computer Use was stopped by the user with the physical Escape key.”；随后没有继续原生点击。旧应用、fixture、原配置恢复与临时 seed 清理由后端收尾，不构成新版 UI 复验。
- **fixture 下轮前置**：临时 Shelf 4447/4448、历史 Force target CL4449 与 owner/client/user、原生测试 branch 已精确清理；下轮只需为 Shelf 导航等仍在范围内的场景重新 seed，不再创建管理员强制解锁目标。CL4446 四个已提交文件、5 个 streams 及历史 permission-map/shelf2 保留。

## 安全红线

> 当前 AI 执行约束（2026-10-26）：用户明确只允许项目本地假 P4，禁止任何公司生产连接，包括 `info`、认证状态和其他只读查询。下列历史计划中的“本人实际 Server”不构成执行授权；WIN-P0-03 及 WIN-P0-04 的非 fixture 部分暂不执行，也不标记完成。仅 loopback 地址或 QA 标识不足以放行，必须先证明服务属于项目且无生产代理/转发，核对配置与凭据继承。核验记录见 [本地假 P4 安全核验](../Coder/本地假P4安全核验.md)。

1. 自动化、故障注入和可重复写测试只能连接项目隔离 fixture（固定 loopback `127.0.0.1:16661`）或本人明确创建的测试 Server/测试 Depot/测试 Workspace。不得读取环境变量后回退到生产 Server，也不得复用真实生产 ticket、trust、Client 或 Workspace。
2. 在本人实际 Server 上，首次只做 `info/login status`、Workspace/Depot 浏览、History/Diff/Search 等只读检查。任何 Sync/Edit/Add/Delete/Revert/Move/Lock/Shelf/Unshelve/Resolve/Submit 演练，必须先确认目标位于本人可删除的专用测试路径、专用 Client 和专用 CL；执行前记录文件清单，执行后复核并清理。
3. 不在文档、截图、日志、Git 或诊断包中保存密码、ticket、trust 内容、内网地址、真实 Depot 路径和未脱敏文件内容。涉及个人 Server 的证据只记录脱敏后的 Server 类型、时间、结果和 operation ID。
4. 所有 mutation 都先完成 UI 预检并核对目标快照；结果为 partial、unknown、cancelled 或连接漂移时不得重复点击，先刷新并人工确认服务器实际状态。

## 完成定义

以下 P0、P1、P2 全部关闭后，本阶段标记为“Windows 本机私用就绪”：

- 最新本地提交能在当前 Windows 上完成 Tauri 原生构建并启动，证据绑定 commit、构建时间和可执行文件。
- 原生主窗口完成核心只读与写入流程冒烟；浏览器、jsdom 和 localhost 服务层结果只能作为补充，不能代替该证据。
- 本人实际 P4 Server 完成所需认证和只读访问；其真实认证方式如果不使用 SSL/SSO/MFA，则这些能力不构成本阶段阻塞。
- 写入安全演练只在隔离 fixture 或本人专用测试 Depot/Workspace 完成，并能恢复/清理。
- 配置与本地数据有可执行的备份/恢复方法，失败、断网、过期认证和异常退出有已验证的恢复路径。
- 在当前机器完成一次连续 2 小时稳定性观察，期间无数据错误、崩溃或无法解释的 mutation 结果；所有 P0/P1 缺陷已关闭或有明确安全降级。

## P0：首次私用前必须完成

### WIN-P0-01 — 最新 Tauri 构建、启动与版本绑定（部分完成）

- **目标**：从干净的当前 `master` 生成并启动最新 Windows 原生应用，而不是只验证 Web bundle。
- **为何阻塞本机私用**：`pnpm build`、浏览器 Playwright 和 Rust 单测都不能证明 WebView2/Tauri 进程、资源、IPC 与原生窗口能够在本机正常启动。
- **具体实现/验收步骤**：记录 commit 与工具版本；执行本地快速门禁；按项目已有 Tauri 入口完成 debug 或 release 构建；从生成物启动主窗口；确认无白屏、panic、资源缺失或立即退出；退出后确认无残留写操作进程。若 build/start 失败，只修复直接阻塞本机启动的问题，另立变更提交。
- **完成证据**：commit SHA、实际命令与退出码、生成物路径、启动/正常退出时间、主窗口截图或人工验收记录，以及无敏感信息的启动日志。
- **当前证据/缺口**：`94b5f0c` 构建/启动已通过；移除 Force Unlock 后的 `3c21d03` 也已重新构建并由本人启动，完整原生回归尚未完成。本人已授权后端结束该标准 exe 的残留进程并重建菜单移除版；最新构建是否完成、hash、路径和进程状态只引用 [Windows 原生构建与运行验收](../Coder/Windows原生构建运行验收.md)，本清单不固化瞬时“构建中”状态。下一步是由本人启动最新产物并复验。
- **负责端**：前端负责壳/UI 启动；后端负责 Rust/Tauri/IPC 启动错误；PM 核对证据绑定同一 commit。

### WIN-P0-02 — 最新构建的 Windows 原生 UI 冒烟（部分完成、待阻塞复验）

- **目标**：在 Tauri 原生窗口中确认本人会使用的核心入口可点击、可聚焦、可恢复。
- **为何阻塞本机私用**：现有 Web/真实 Edge 测试和 localhost 服务层 E2E 没有覆盖 WebView2 焦点、窗口恢复、系统对话与 IPC 串联，也不能证明最终原生窗口已不再显示退役的系统菜单栏。
- **具体实现/验收步骤**：先连接隔离 fixture；依次检查启动/退出、Settings 的“已保存连接”、Workspace/Depot、文件预览、Diff/History/Graph、Pending/Submitted、Search、Streams/Stream Graph、Branch Mappings、Shelf、Terminal/P4 Log/Operations/Diagnostics；确认原生 Connection/Changes/Navigate/View 顶栏菜单不存在。Settings 中连接主区只突出 Server/User/Workspace，P4 高级字段单列；User/Workspace 的 Browse 必须查询当前草稿 Server/User，New 必须经过专用 preflight → 明确确认，成功只回填草稿而不自动保存/激活；空 Workspace 时仍能先验证 Server/User 并进入 Trust/Login 恢复。确认 Activity Bar 没有重复的 Terminal/P4 Log、Stream Graph 或 Branch Mappings 按钮，前两者仍可从底部工具区手动打开、后两者仍可从 Streams 页按钮进入，并以测试 Error 验证只出现红点、不自动展开/切换、查看后清除；验证命令面板、主要前端快捷键、390px 主窗口、dock/popout/归还、关闭后重开和焦点恢复；对 Submit、Shelf、Resolve、Stream 切换、Branch Mapping create/edit/delete、普通 Lock/Unlock 只在测试数据上执行。确认其他用户持锁仍显示明确 blocker/owner 提示，且界面不存在管理员强制解锁入口。记录每一步通过/失败及所用构建。
- **完成证据**：按页面/动作列出的原生冒烟表、关键截图或录屏、operation/log ID、窗口恢复前后记录；必须明确写“Windows Tauri 原生”，不能用 Edge 截图替代。
- **当前证据/缺口**：已通过项和精确边界见 [Windows Tauri 原生 UI 验收](../Coder/Windows原生UI验收.md)。Settings 分组、草稿作用域 Browse、受控 New、空 Workspace 预验证及 390px Browser Mock 回归已具备自动化证据；Windows 隔离 localhost 另已真实验证 users/workspaces 查询、classic/stream Workspace 创建、字段回读与重复名称不覆盖。该 fixture 的 New User 被认证策略以 `AuthenticationRequired` 阻断，未验证真实创建成功；本人 Server 和 Windows Tauri 原生点击仍待验，不能用 Browser Mock 或服务层 fixture 替代。下一步构建并启动最新 exe，确认 Settings 连接管理、普通 Lock/Unlock 与 other-owner blocker 未受影响，再依有限清单补 Shelf 导航、剩余页面、命令面板/前端快捷键、390px、dock/popout、焦点和重开恢复；未实际点击项不得由后端日志或浏览器截图代替。
- **负责端**：前端主责交互与窗口；后端协查 IPC/operation；PM 执行或见证冒烟并归档结果。

### WIN-P0-03 — 本人 P4 Server 连接与实际认证（未验）

- **目标**：在应用内连接本人实际使用的 Server、User、Client/Workspace，并确认该 Server 实际要求的认证路径。
- **为何阻塞本机私用**：localhost fixture 证明协议和安全边界，但不能证明本人 Server 地址、权限、ticket/trust 策略和 Workspace 映射可用。
- **具体实现/验收步骤**：先备份现有应用配置；创建单独 Profile，输入非敏感 Server/User/Workspace 与 P4 高级设置；通过应用完成 CLI 发现、`p4 info` 和 `p4 login -s`；仅在服务器确实要求时执行 SSL trust 或外部 SSO/MFA。Workspace Root 必须由当前草稿向本人 Server 精确解析，不能手填或沿用旧 profile 的 cwd；空 Workspace 时应仍可验证 Server/User。选择本人测试 Client/Workspace 后再浏览 Workspace/Depot，并核对 Server/User/Client/Root/Stream。失败时按钮附近应立即显示原因与恢复方向，保持旧活动 Profile，不覆盖原配置，也不启动本地 Workspace 扫描。
- **完成证据**：脱敏连接状态、实际认证类型、只读页面成功记录、失败回滚记录和配置备份位置；不保存密码、ticket、fingerprint 全文或内网地址。
- **负责端**：PM/本人提供环境并验收；前端负责向导状态；后端负责认证分类、Context 与代次隔离。

### WIN-P0-04 — 核心读写安全演练（未关闭）

- **目标**：证明日常“浏览 → 修改 → Pending/Review → Shelf/Resolve → Submit”链路在安全边界内可用，并能恢复到已知状态。
- **为何阻塞本机私用**：自动化已验证实现，但首次用于个人数据前仍需确认实际权限、映射、文件类型、trigger 和服务器策略不会产生意外写入。
- **具体实现/验收步骤**：先在隔离 fixture 完整执行一轮；再仅在本人专用测试 Depot/Client/CL 上执行 Sync、Edit/Add、Move、Revert、Pending 移动、普通 Lock/Unlock（若权限支持）、Shelf/Unshelve、文本 Resolve 和 Submit。每个 mutation 先核对预检目标、blocker/warning、operation ID 和刷新建议；包含一次主动取消或失败场景；最终核对 Submitted 结果并删除/归档测试数据。真实生产 Depot 只做只读检查；管理员强制解锁不属于 P4Deck UI 演练范围。
- **完成证据**：脱敏的测试路径标识、操作前后文件/CL 清单、各状态机结果、服务器侧复核、清理结果和任何不支持能力的安全降级说明。
- **当前证据/缺口**：隔离 fixture 已完成一项 Branch CRUD；历史 build 曾完成一次现已下线的管理员强制解锁并有服务端复核，但它不属于当前完成条件。Submit、Shelf/Unshelve、Resolve、Stream 切换、普通 Lock/Unlock 等完整演练及本人 Server 权限/trigger 仍未验证。
- **负责端**：前端验证状态机呈现；后端验证命令、token、Journal/Log 与最终状态；PM/本人控制测试范围并确认清理。

## P1：进入日常使用前完成

### WIN-P1-01 — 故障恢复（已完成）

- **目标**：确认网络中断、认证失效、取消、异常退出和未知结果不会被误报为成功，且用户知道如何恢复。
- **为何阻塞本机私用**：P4 写操作发生中断时，错误重试可能造成重复操作或错误判断；必须先证明刷新与人工复核路径可用。
- **具体实现/验收步骤**：只在 fixture/测试 Depot 注入 CLI 不可用、Server 停止、ticket 缺失/过期等可恢复故障；在只读请求和一项可取消长操作中检查取消/重连；执行中关闭应用后重启，确认 Journal 将未终结操作标记为 interrupted 且不自动重放；对 partial/unknown 结果按提示刷新并从 Server 侧核对。
- **完成证据**：每类故障的 UI 状态、Journal/Log、重启后状态、人工恢复步骤和最终数据一致性记录。
- **负责端**：后端主责故障分类与不可重放；前端主责恢复入口；PM 核对结果没有假成功。
- **当前证据**：Rust 已把只读超时与 mutation/未知命令超时分开，后者记 `unknown`；超时会终止并等待子进程退出。Journal 启动恢复把未终结操作标为 `interrupted`，不保存重放 payload；Operations UI 为 unknown/interrupted/cancelled/authExpired/offline/serverUnreachable 显示核对日志、刷新 Pending/Workspace 和 Server 侧确认步骤，并明确“不自动重放”。2026-10-22 原生验收确认 Server 停止与离线重启保留缓存、ticket 缺失显示 `authExpired`、取消显示 `cancelled`、执行中关闭应用后重启显示 `interrupted` 且无自动重放。本地 fixture 最终无 open 记录，workspace 与 Have 一致；Windows Job Object 验证应用退出后残留 `p4.exe` 为 0。详细场景表见 [故障恢复与配置备份](../Coder/故障恢复与配置备份.md)。
- **剩余边界**：ticket 缺失由 fixture 临时移除 ticket 模拟；本人实际 Server 的 SSO/MFA、插件认证、权限与 trigger 仍由 WIN-P0-03 验证。

### WIN-P1-02 — 本地数据备份与回滚（已完成）

- **目标**：能够备份并恢复 P4Deck 的非敏感配置、布局和必要本地状态，同时安全处理 ticket/trust 等外部凭据。
- **为何阻塞本机私用**：当前只有本地 Git；应用配置损坏、磁盘问题或误切 Profile 时，需要无需 remote 也能恢复可用状态。
- **具体实现/验收步骤**：识别本机应用数据目录、Profile 配置、布局、日志/Journal/诊断与 P4 外部 ticket/trust 的实际位置；列出“备份”“不备份/单独保护”“可删除重建”三类；关闭应用后制作本地离线备份；在临时副本或测试账户验证一次恢复；记录回滚到上一 Git commit 和恢复应用配置的命令。不得把凭据加入仓库或普通压缩包。
- **完成证据**：脱敏文件清单、备份时间/介质、恢复演练记录、校验结果和回滚手册；不提交备份本体。
- **负责端**：后端说明持久化边界；PM/本人执行备份恢复；前端核对恢复后的布局/Profile 表现。
- **当前证据**：Settings 已提供创建备份、打开目录、查看待恢复/最近结果和选择回滚包。Bundle schema v1 只含 `connection.json`、窗口位置与布局 localStorage allowlist；ticket/trust、密码、终端历史、文件选择、日志、Journal、诊断和 IndexedDB 缓存不入包。源文件有 SHA-256 和结构校验；恢复先暂存并在下次启动加载连接前执行，自动生成 pre-restore 包。恢复前捕获两份在线文件，任一替换失败会立即恢复两份旧文件；中途崩溃则 pending 清单保留并在下次启动幂等重做。2026-10-22 原生验收完成“创建备份 → 修改连接名/主题 → 恢复并完全退出重开 → 选择 pre-restore 包回滚并再次退出重开”闭环；手工包含连接、窗口位置和 26 个布局键，ticket/trust canary 命中为 0。150% DPI 下的窗口位置/尺寸 round trip 也已修复并验证。详细边界见 [故障恢复与配置备份](../Coder/故障恢复与配置备份.md)。

## P2：阶段收口

### WIN-P2-01 — 本机稳定性观察与最终文档收口（未验）

- **目标**：以实际个人使用强度验证当前机器稳定性，并把已知限制固化为可执行说明。
- **为何阻塞本机私用**：短时冒烟无法发现窗口恢复、缓存、连接代次、长列表或日志增长问题；没有最终记录也无法判断后续回归。
- **具体实现/验收步骤**：在最新通过 P0/P1 的构建上连续运行至少 2 小时，覆盖两次应用重启、一次 Profile/Workspace 切换、浏览/搜索/Pending/Submitted/Diff/Log 和至少一个测试数据 mutation；观察崩溃、CPU/内存异常增长、旧连接数据串入、窗口恢复和日志容量；将缺陷分为本阶段阻塞或已知限制，更新项目状态、操作说明和备份/恢复日期。
- **完成证据**：开始/结束时间、构建 SHA、Windows/CLI 版本摘要、执行动作、资源观察、崩溃/错误数、最终缺陷清单和 PM 关闭结论。
- **负责端**：PM/本人主责；前后端只处理被判定为本机私用阻塞的缺陷。

## 当前阶段非范围（PKG-01定向Windows体验包除外）

以下项目不阻塞“当前 Windows 机器本人私用”，不得混入本清单的完成判断：

- Git remote、远端 CI、异机恢复证明。
- macOS、Linux、Windows ARM64 与跨平台一致性。
- 正式代码签名、公证、自动更新及公开发布仍非范围；新增PKG-01只授权定向Windows体验包、必要安装说明和最小验收，由用户自行转发。
- 企业 SSO/MFA；仅当本人实际 Server 强制要求时，才升级为 WIN-P0-03 的真实阻塞。
- 第二 Server、Broker/Proxy、多 P4/P4D 版本、Unicode/non-Unicode Server 兼容矩阵。
- NVDA/VoiceOver、双平台读屏认证；当前保留键盘/ARIA/axe/对比度自动化基线。
- Label/Job 独立工作台与 Stream spec 写入等后续产品功能。Branch Mapping 前后端工作台已完成，Windows 原生点击及真实权限/trigger 行为仍须按本清单安全边界验收。
- 管理员 Force Unlock：按用户决定不面向普通用户提供，P4Deck 不再包含按钮、对话框或专用 API；需要时由管理员在后台执行，不进入本阶段验收。
- 菜单台账中 190 个 `phase: later` 项。

## 新增功能实施批次（不改变上述验收顺序）

- Stream Graph 前后端只读闭环已独立完成：正式全局 panel/Streams 入口、确定性 parent→child 分层、可访问虚拟树、过滤/分页/取消/重试、详情/键盘/390px、复用安全切换对话框，以及强类型契约、Tauri adapter、明确 simulated 的 Browser Mock、有界 `p4 streams` 采集、scope 复核、一次性分页游标和 Windows localhost fixture 均已落地。
- Web 组件与真实 Edge 已覆盖分页去重、游标失效重启、迟到隔离、大图 DOM 上限、390px 和 axe；这仍不表示 Windows Tauri 原生 panel/popout 已点击验收，需并入 WIN-P0-02 留证。
- Branch Mapping 前后端安全闭环已独立完成：正式全局 panel、Streams 页按钮/Dock/popout、虚拟列表与 opaque cursor、原样详情/View 语义、正反 `integrate -n` 只读影响预览，以及专用 preflight→confirm create/edit/delete 均已接入；Activity Bar 重复入口已移除。Client mapping/owner/unknown/TOCTOU/危险删除阻断、一次性 cursor/token、Tauri adapter 和明确 simulated 的 Browser Mock 均复用后端权威契约。Web 组件与真实 Edge 覆盖 390px、键盘、axe、大列表 DOM 上限、分页/迟到隔离和模拟增删改闭环。
- 历史记录：Force Unlock 曾完成前后端专用闭环并在首轮 Windows 原生验收执行过一次；用户随后明确决定移除该能力，因为 P4Deck 面向普通用户，管理员强制解锁应在后台执行。该历史不再代表当前产品能力或待验任务。
- Global Search 的 Stream/Shelf 深度搜索前后端闭环已完成：`SearchPage` 正式扩为七类筛选、facet、分组与 badge；Stream 结果显示服务端 path/name/owner/type/parent/description 摘要并显式定位到 Streams，Shelf 结果显示 numbered CL、owner/client/time/description 与后端已给出的匹配路径摘要并打开独立 Shelf detail。Shelf 仍按 500 条列表、128 个 detail 候选、8 个批次、每 shelf 256/总 20,000 文件及 20 秒预算保守截断，UI 会逐类别显示 `partialReason`，不宣称全量。分页保序去重、游标失效重搜、快速输入取消/迟到隔离、390px、键盘与 axe 已有 Web/真实 Edge 证据；Browser Mock 明示 simulated。
- 当前保留的三个用户优先功能为 Stream Graph、Branch Mapping、Global Search Stream/Shelf，均已完成代码闭环。上述浏览器或 fixture 证据不表示 Windows Tauri 原生 panel/popout/搜索导航、本人 Server 大规模与权限/trigger 已通过；它们分别并入 WIN-P0-02 与 WIN-P0-03/04，不改变 WIN-P0/P1/P2 的本机私用安全顺序，也不带入 Stream spec 写入。

### 2026-10-27 本轮增量说明

- UI-04：保留现有布局及视觉差异，工作区详情及其占位删除，切换按钮移到搜索行；分支流列表详情及侧栏占位也已删除，切换Stream保留原行右键入口，隐藏失效的“查看详情”菜单；未删除后端能力。列宽参数保存在各页面本地状态，与 History 一致；所有数据列均有键盘/指针拖动和最小宽度。
- GRAPH-01：调查弹窗按需读取，默认不扫描服务器；映射未匹配/复杂规则、权限或缺版本均为未知。预算为 API 尝试数（缓存命中也占保守预算），并非底层 P4 进程计数。CL detail沿用既有有界实现，可能另读集成元信息。新请求增加代次预检查，旧结果不写新连接缓存。调查不是内容包含证明。
- CON-04：Rename官方依据 https://help.perforce.com/helix-core/server-apps/cmdref/2026.1/Content/CmdRef/p4_renameclient.html 。本轮不执行真实P4；当前工作区和case-only重命名保守拒绝。失败不自动force/retry，未知结果需先检查日志和列表。
- 新增 Vitest 纯/mock用例已写，旧子进程权限拒绝仍未解除，未执行也未绕过；UI视觉/真实假P4未验收。本轮已通过 `tsc --noEmit`、离线 `cargo check --locked --lib`、限定 `app::connection_service::workspace_mutation::tests::` 的3项纯Rust测试（版本门槛、当前/无效名称拒绝、原生命令且不force）、两份CSS的PostCSS解析及diff空白检查。没有启动应用或实际调用P4。

### 修订图请求契约修复

`graphReads.ts` 的内部联合类型 `kind=graph` 曾泄漏到 `get_revision_graph`，触发 Rust `deny_unknown_fields`。已在共享调度边界显式构造 scope/revisionLimit/cursor/refresh/operationId；覆盖初始/刷新/分页/目标和CL调查共同路径，不放宽后端校验。Mock增加未知字段拒绝；新增共享读取请求形状、invoke序列化与Rust反序列化回归。无图且读取失败时显示数量未知，不再显示确定0个版本。此项是前端参数错误，不是已证实的旧后端不兼容，不需为此改后端契约或运行默认入口。

此接口修复验证：TypeScript、Prettier、diff检查通过；离线限定 `domain::revision_graph_wire_tests::` 的2项纯Rust测试通过（精确请求往返、kind仍拒绝），256项其他测试未运行。前端共享读取/invoke/错误计数回归已写，受既有Vitest权限限制未执行。未运行P4或应用。

### 已提交分类呈现简化（用户确认）

SUB-03/SUB-05：列表/筛选/周报类别选择共用普通提交、CI 合并、自动生成三个短名称，保留筛选“全部”。移除旧mergeClassification徽标和已提交状态列；表格改为CL、提交类型、描述、用户、时间五列。规则本身未变，分类仍是描述签名启发式，不证明CI身份。CL展开、详情、GoTo及周报数据逻辑不变。表头与虚拟行统一tracks及横向滚动，保留64/324行高与原定位；新增文案/列结构回归待运行。视觉仍未验收。

收起列表的文件数列已移除：`p4/changelists/parser.rs` 摘要默认file_count=0，只有按需详情/元信息读取才覆盖，因此原0不代表真实空CL。展开后仅用detail.files.length显示数量，complete才显示文件数，partial显示已加载数量/总数未知；加载/错误不显示数量，真实完整空列表才显示0。沿用懒加载与连接范围缓存，不额外逐行describe。

此批已通过TypeScript、7份修改文件Prettier、workbench.css PostCSS解析、git diff空白检查。新增三类呈现/五列结构/展开计数加载失败完整与partial及缓存复用的纯mock回归，仅写入未运行（旧Vitest子进程拒绝未绕过）；未进行视觉或P4验收，未新增逐行计数请求。

### 已提交展开区弹性高度（覆盖固定64/324方案）

已移除展开固定260px/总行高324px。CL摘要仍64px，展开内容自然流，按ResizeObserver正高度更新主虚拟列表估计和总高/后续偏移；隐藏页签的零测量被忽略。RevisionFileList在此模式使用外层滚动元素和相对scrollMargin，不再制造内层固定滚动框，文件区域由已加载行数×40px撑开，文件DOM仍按外层视口虚拟化。加载/错误/数量/partial说明高度一起测量；无新读取请求。新增0/1/2/多行及多CL展开、隐藏零测量、收起/resize回归；视觉与Vitest仍未运行。


### 2026-10-27 增量收束：Submitted 与修订图比较（已实现待运行验收）

- Submitted：五个数据列为 CL、提交类型、描述、用户、时间；全部复用 `useColumnWidths` 拖宽/键盘调宽，表头与行共用模板。主类型仅普通提交/CI 合并/自动生成，旧 merge badge、状态和收起文件数已移除。作者使用主文字字号/颜色。
- 展开文件采用正值 ResizeObserver 内容测量，64px 主行加实际详情高度；虚拟行位置/总高同步刷新，忽略隐藏页零测量。文件列表使用主列表滚动视口，少量文件没有固定 324px 留白或内层滚动条。此实现替代早期固定高度补丁。
- 标签最新需求覆盖独立列：完整原始描述中的 ASCII 方括号在原位置渲染 tag，文字/重复项顺序保留，React 文本转义；无独立标签列。组合筛选保留候选多选，也可手输文本回车加入，trim/去重/IME Enter 防误提交，取消勾选或清空移除。OR 匹配、与类型 AND；仅已加载数据范围，不改描述/导出/服务端参数；稳定服务器 query 对象防止本地标签切换触发额外请求。
- 内置“我的提交（默认）”首次/重置/重新选中时动态生成最近七天、当前连接用户、普通提交、Stream 不限、其余条件空。连接变化重取当前用户；缺用户报字段错误而非查询所有用户。内置项不写入用户预设，不覆盖同名自定义项；保存自定义仍保存用户指定日期。
- 修订图：原“所选与上一版”及页内 Diff 删除。候选复用 History 容量2 FIFO，蓝色先选/琥珀后选，aria 角色区分；聚焦/隐藏分支与比较选择分离。按钮紧跟缩放，两个有效候选才启用；新建并激活锁定 Diff，明确左文件#revision 与右文件#revision，无 have/workspace 回退。
- Diff 新增可选 `rightFileIdentity`，右侧独立检查/读取；缓存键包含右路径，后端显式跨文件请求只允许精确 depot 路径和正 revision。相同路径复用 inspection；原 History 同文件契约不变。运行旧二进制不支持新字段，需要后续在获准隔离入口更新前后端；本次未启动应用。
- 证据：`ChangelistPage.tsx`、`SubmittedChangeFiles.tsx`、`RevisionFileList.tsx`、`submittedTags.ts`、`SubmittedFilterPanel.tsx`、`SubmittedPage.tsx`、`FileReviewPage.tsx`、`panels.ts`、`useDockController.ts`、`file_service.rs`、`domain/mod.rs`。
- 已跑：TS noEmit、CSS PostCSS 解析、diff 空白检查；离线 Rust check；纯 Rust `domain::explicit_diff_pair_tests::` 1通过/258过滤（反序列化两端路径与版本、拒绝 have 和通配符）。
- 已写未跑：标签解析/原文保留/纯查询一致、动态默认、标签手输/IME/无额外请求、列模板同步、FIFO双色/精确新Diff参数和无内联、动态展开多行/零测量回归。Vitest 子进程既有拒绝未绕过；浏览器视觉限制未绕过。不将 TS/CSS 或纯合约测试标为视觉/P4功能验收。
- 剩余：真实隔离假 P4 端到端、宽窄窗口/缩放/多展开/滚动可视验收；修订图目标映射/CL逐文件证据调查原有缓存与预算切片继续列为部分实现，图可达性仍不代表内容包含。没有生产连接、默认应用启动或推送。

- 最新布局补充：标签筛选在 DOM 中紧接关键词，视觉与 Tab 顺序一致；日期/Depot 与 Stream 配对布局不变。
