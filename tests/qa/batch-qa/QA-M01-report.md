# M01 原断言复验结果

FE冻结labels SHA256 `746189efba5bb4a08bef04b27c8df8fc7c66bee3c78a6cb894e9eee9b0892507` 已确认，测试前后相同。仅运行原 `src/app/context-menu/model.test.ts` 两个受影响断言，无测试或产品改动，无人工验收fixture/服务改动。使用既有拒绝backend/Tauri的独立mock配置，经正式工具审批执行。

命令：`node node_modules/vitest/vitest.mjs run --config src/test/batch-qa/i2-vitest.config.mjs src/app/context-menu/model.test.ts -t 'registers every object and every leaf|translates every menu label' --reporter=json --outputFile=src/test/batch-qa/evidence/m01-original-assertions.json`

实际exit1：**1通过、1失败、64过滤未执行**，不称菜单全套通过。

- 英文翻译原断言通过。UI-02-B01“重命名工作区…”通过既有label规范化得到Rename workspace，未改菜单动作/顺序。
- 总表文字顺序已对齐，静态全对象比较无差异（m01-menu-differences.json）。此前缺C09/W01及公司3项的文档漂移已修。
- 原清单测试仍在model.test.ts:27的编号顺序断言失败。catalog.ts:1488将C09-09“追踪合并去向”置首，其后为C09-01…08；测试按文档项的位置生成C09-01…09。并非英文映射回归。

**这不是只改文档即可修复的差异。** 文档目前文字顺序与代码相同；把文档追踪项挪尾会使前一条文字顺序断言失败，而不改变代码ID序列。要同时满足现有两条断言，必须由PM决定显示顺序是否跟编号一致，以及现有ID是否需要保持稳定，再派对应产品/测试契约的最小修复。QA未重排菜单、重编号或放宽断言；不建议为让测试绿而擅改稳定ID。

本批不阻塞此前已通过限定dev人工验收。未启动浏览器/server/默认产品/P4/公司程序，未打包。早期I2失败证据、此次失败原样保留。labels单文件修复验收通过，QA无继续占用该文件；菜单编号契约项待PM决定，未虚报M01全部关闭。

最终文件hash与起止比较：evidence/m01-final-hashes.json。原测试JSON：evidence/m01-original-assertions.json。该新labels证据仅限菜单翻译，不嫁接为旧全部页面重新验收。
