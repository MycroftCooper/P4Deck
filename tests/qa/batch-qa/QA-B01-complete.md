# QA-B01 完成与冻结释放

本报告覆盖早期 QA-B01-report.md 的“待配置”状态；其中 UI-07 原生计划及未覆盖原生范围继续有效。PM 续批授权后仅变更专用 preview-audit/vite.config.mjs，并新增 batch-qa 文件。没有产品实现变更。

## 已执行与边界

- 专用 Vite 内存构建解析 1727 模块成功，未写 build 包，`evidence/graph.json` 保存完整解析图，forbidden=[]。CommandBar/ActivityBar/commandPolicy/panels/pageIcons 使用真实代码；commandStubs 明确逐 importer/specifier 隔离 cache/backend/clipboard/context/menu/dialog 等。缺白名单源码在 load 阶段拒绝。默认 App/main、真实 infrastructure 与 Tauri 不进入图。
- 真实 CommandBar 在 1440/390、文字/icon、横向滚动到末端均无“提交 CL”；真实 ActivityBar 的待提交按钮可点击且回调为 pending。页面承接区为合成目标，不声称 App/Dockview 页签生命周期通过。两宽度 TopBar 无重复窗控。没有虚构产品不存在的溢出菜单；现有实现为横向滚动。
- 同冻结源码代表回归：Branch 隐藏恢复与索引95末行无重叠；JSON 零尺寸恢复后9行及 Unicode 正文可见；Gate 拒绝关闭后保留、设置可达且草稿保留；Pending Default/2/10/100数值序、选择保留且读取计数0；真实 ResizableTable 双主题横纵鼠标拖动均至末端（本次横向仅11px溢出，历史大溢出矩阵按旧范围复用）。
- SubmitDialog 11项定向 mock 全过（evidence/submit-tests.json）：预检/显式whole-CL确认/精确目标、身份不匹配、过期、失败/unknown、不重复提交、连接变化。真实 Dialog/TargetList，通知为无操作替身，check/submit 是测试 callback，没有 backend。
- 新 pending-submit.test.tsx 1项全过（evidence/pending-submit-tests.json）：真实Pending CL10按钮仅分派 submit + {type:pending,id:10,count:1} +来源button，Default禁用。该测试证明按钮目标；确认链由上述真实SubmitDialog测试另证，没有把stub dialog冒充真实确认链，也不声称完整App适配器端到端通过。
- `tsc --noEmit --incremental false -p tsconfig.app.json` exit0；限定 diff --check exit0。12项mock不与历史套件累计为额外完成工作包。

## 实际失败及修复记录

首次内存图运行沙箱 spawn EPERM，原命令正式 require_escalated 后获准；没有自动审批拒绝/绕过。第一次图检查发现QA新增路径比较未去尾分隔符，修QA配置后成功。首次浏览器 session 在 Gate 处选择器同时匹配两个“退出应用”而失败；不是产品错误，证据 `session.json` 保留失败和此前通过项。修为 dialog 内按钮，`session-remaining.json` 仅补剩余场景通过。两次均自动关闭自身浏览器/server，因此本批实际是一次首测＋一次必要补测，不虚报全程单会话成功。

两份 session 记录 errors=[]、blocked=[]，request清单全部 loopback1437。会话identity记录本次PID/地址，strictPort不复用未知服务；结束 browserClosed/serverClosed 均true。后续 netstat仅 TIME_WAIT/PID0，无1437 LISTENING。未运行默认产品、Tauri、P4、公司工具、安装器；无外发/部署。

实际查看新增 toolbar-390-true.png、toolbar-1440-false.png、scroll-dark.png、gate-settings.png：窄窗横滑边界与设置可见，宽窗导航选中态、暗色横纵滑块可辨；Gate为明确合成设置卡片。旧Pending/TopBar图片查看记录见前报告。截图已滑到末端时待提交入口可能在左侧滚出，这不否定前面的实际scrollIntoView+点击断言。

## 复用及剩余缺口

7个既有源码hash匹配，Branch/JSON/Gate/Pending/scroll历史完整矩阵仅按原范围复用，不重复全量运行。TopBar旧证据无hash，已用本次真实TopBar及新hash替代限定无重复窗控结论。历史依赖未完整hash不作全树未变证明，本轮完整浏览器图＋最终hash重新绑定。

UI-07原生 CloseRequested/MessageBox/Alt+F4、WebView初始化失败、原生安装/卸载/跨设备、真实P4/公司工具均未验；不宣称整UI07或生产提交通过。App导航承接、真实提交适配器及后端原子校验不在本轮浏览器端到端范围。

## 明确释放与QA-I2交接

QA-B01限定synthetic阶段完成；**现在释放本批冻结产品路径供PM批准的FE-I2最小接入使用**：PendingPage.tsx、相关菜单、设置/App、backend contract及其原有依赖，精确旧终态见 `evidence/b01-final-hashes.json`。这只解除QA占用，不扩大FE-I2任务范围。97个初始记录中仅授权专用配置hash改变，其余无漂移；终态另补本次图解析源码hash。

专用测试配置仍由QA维护。FE接入后须给实际改动文件及最终hash/可测试接口，QA再冻结新集成代码并接QA-I2；当前不能把正在开发的companySubmit模块或旧B01 hash当作新CL06集成已验。CL06-I2真实启动恒禁用，模拟状态不是提交成功。
