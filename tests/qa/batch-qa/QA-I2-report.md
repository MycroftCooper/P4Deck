# QA-I2 集成验收：限定mock通过，菜单清单待PM收尾

读取FE i2-handoff.json，16个冻结文件起止hash均匹配，未改产品实现。最终范围与hash见 evidence/i2-final-hashes.json。共享golden SHA256为6ff9d6fc9f98427ee9d6f07cd335670c574575ed5b1544798127a2c991c4ef75，与PM记录一致，未复制或自造第二套规划器。

## 实际结果

| 项目 | 本轮结果与证据 |
|---|---|
| 隔离解析图 | 内存构建1688模块通过，graph-i2.json的forbidden为空；无App/main、真实infrastructure/backend、Tauri运行时 |
| 浏览器集成 | i2-session.json：19检查均通过，errors/blocked为空，所有请求loopback1437 |
| QA独立mock | i2-tests.json：11通过、0失败；精确字符串代次/重复读取合并/切换迟到、9个BE golden渲染、旧计划/unknown模拟保护 |
| 普通Submit | i2-normal-submit.json：新Pending上的1项目标与Default保护通过；浏览器也核CL10分派。SubmitDialog/useCommandDialogs源码保持B01版本，复用B01 11项真实确认链mock，不重计 |
| TS / diff | tsc --noEmit --incremental false -p tsconfig.app.json，限定git diff --check均exit0 |
| 菜单总表原断言 | i2-menu-inventory.json：0通过、1失败、65过滤未执行；失败C09，不把过滤项计通过 |

19浏览器检查含冻结/桥/请求安全检查，不冒充19个独立功能测试。11mock中的golden覆盖是渲染宿主预期结果，**不证明前端执行了宿主验证器**。真实规划/启动未接通是冻结方案边界，产品界面显示等待宿主规划及工具未核实。

## 集成覆盖与替身边界

真实PendingPage→CompanySubmitDialog→CompanySubmitPreparation→useCompanySubmitSnapshot→CompanySubmitPreview及Dialog。Pending缓存/文件子列表等复用合成替身；上下文菜单呈现是测试替身，但读取真实Pending生成的菜单bindings并执行其回调，未替代入口启用判断。backend只有合成companySubmitConnectionSnapshot；不存在文件探测、生产配置读取、规划IPC或spawn。

- Default和Ctrl多选入口禁用；编号CL10可打开，标题/目标正确。
- 宿主身份缺失、数字generation、读取失败均禁用；真正u64::MAX字符串通过hook不转Number。切换连接关闭旧dialog，旧异步返回不能覆盖新连接失败态；显式重试仍不开放启动。刷新加载态禁用，独立hook测试证明重复请求合并。
- 路径可输入，关闭重开清空，不能从路径声称工具存在；真实界面无reserved/running等模拟推进按钮。普通Submit按钮保持原目标分派，未自动回退提交。
- BE共同样例直接覆盖leading-zero、above-js-safe、u64-max、overflow、UNC、空profile、旧generation、unknown/missing-tool渲染；成功计划argv逐项等于BE golden，realStartAllowed=false。unknown模拟不允许重复/迟到状态解锁、退出码0不代表成功。
- 1100与390窄窗截图落盘，已实际查看i2-narrow.png：标题、路径、宿主未核实说明、禁用启动与关闭按钮在视口内，无遮挡。

本次browser/server均已自动关闭，netstat1437仅TIME_WAIT/PID0，无LISTENING。没有默认产品/P4/公司工具/真实spawn/安装器/打包/外部请求。

## 菜单异常：交PM，不改实现或断言

PM新增C01-10/C02-14/C12-04后，原全清单断言仍失败于C09。额外只读AST完整比较记录在i2-menu-differences.json：

1. C09：代码首项“追踪合并去向”，文档遗漏，后续顺序整体偏移。
2. W01：代码4项“切换到此工作区… / 新建工作区… / 重命名工作区… / 删除工作区…”，文档仍为旧10项。

公司提交三个新增位置当前匹配；不能以此宣称整个菜单总表通过。workspace rename英文缺失为作者已报、PM已登记UI02-B01，本轮未重复已知失败的翻译全量测试，未改labels。

## 自然批末释放与后继

本轮CL06限定集成mock接受为通过；全菜单收尾仍有上述独立文档失败。**现在释放src/app/context-menu/labels.ts供PM已排FE UI02-B01最小翻译修复**，释放hash：eb58d7a12be8199408b21f08caa3f383c2f1869b6526c44df8a39721a85cd4ba。同时本轮I2验证结束，其他共享产品路径不再由QA占用；最终hash作本轮证据，不嫁接随后产品改动。FE交新labels hash后需定向重验翻译，PM总表调整后重验原清单断言。QA不派新产品任务。

原生宿主故障/真实工具cwd、认证、后台会话、公司提交/P4、安装跨设备仍未验证。不得说公司工具已能提交；自动更新未推进。
