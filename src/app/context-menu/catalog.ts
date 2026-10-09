// Object/item IDs correspond to Designer/右键菜单对象与菜单项总表.md.
// Keep the complete UI inventory, including explicitly unavailable future capabilities.
export const menuCatalog = {
  F01: {
    title: "单个工作文件：工作区侧栏、Files",
    items: [
      {
        id: "F01-01",
        label: "文件预览",
        phase: "initial",
      },
      {
        id: "F01-02",
        label: "在新页签中预览",
        phase: "initial",
      },
      {
        id: "F01-03",
        label: "其他软件打开…",
        phase: "initial",
      },
      {
        id: "F01-04",
        label: "系统中定位",
        phase: "initial",
      },
      {
        id: "F01-05",
        label: "获取最新",
        phase: "initial",
      },
      {
        id: "F01-06",
        label: "获取指定版本…",
        phase: "initial",
      },
      {
        id: "F01-07",
        label: "签出…",
        phase: "initial",
      },
      {
        id: "F01-08",
        label: "添加到 P4…",
        phase: "initial",
      },
      {
        id: "F01-09",
        label: "标记删除…",
        phase: "initial",
      },
      {
        id: "F01-10",
        label: "还原…",
        phase: "initial",
      },
      {
        id: "F01-11",
        label: "与 have 版本比较",
        phase: "initial",
      },
      {
        id: "F01-12",
        label: "文件历史",
        phase: "initial",
      },
      {
        id: "F01-13",
        label: "修订图",
        phase: "initial",
      },
      {
        id: "F01-14",
        label: "在工作区中定位",
        phase: "initial",
      },
      {
        id: "F01-15",
        label: "在 Depot 中定位",
        phase: "initial",
      },
      {
        id: "F01-16",
        label: "复制 › 文件名",
        phase: "initial",
      },
      {
        id: "F01-17",
        label: "复制 › 本地绝对路径",
        phase: "initial",
      },
      {
        id: "F01-18",
        label: "复制 › 工作区相对路径",
        phase: "initial",
      },
      {
        id: "F01-19",
        label: "复制 › Depot 路径",
        phase: "initial",
      },
      {
        id: "F01-20",
        label: "刷新状态",
        phase: "initial",
      },
      {
        id: "F01-21",
        label: "签出并用其他软件打开…",
        phase: "later",
      },
      {
        id: "F01-22",
        label: "移到 CL…",
        phase: "later",
      },
      {
        id: "F01-23",
        label: "还原未修改文件",
        phase: "later",
      },
      {
        id: "F01-24",
        label: "解决冲突…",
        phase: "later",
      },
      {
        id: "F01-25",
        label: "更改文件类型…",
        phase: "later",
      },
      {
        id: "F01-26",
        label: "锁定文件",
        phase: "initial",
      },
      {
        id: "F01-27",
        label: "解锁文件",
        phase: "initial",
      },
      {
        id: "F01-28",
        label: "重命名/移动…",
        phase: "later",
      },
      {
        id: "F01-29",
        label: "从工作区移除…",
        phase: "later",
      },
      {
        id: "F01-30",
        label: "对账…",
        phase: "later",
      },
      {
        id: "F01-31",
        label: "与其他文件/版本比较…",
        phase: "later",
      },
      {
        id: "F01-32",
        label: "合并/集成…",
        phase: "later",
      },
      {
        id: "F01-33",
        label: "复制到…",
        phase: "later",
      },
      {
        id: "F01-34",
        label: "创建分支…",
        phase: "later",
      },
      {
        id: "F01-35",
        label: "撤销已提交变更…",
        phase: "later",
      },
      {
        id: "F01-36",
        label: "打标签…",
        phase: "later",
      },
      { id: "F01-37", label: "搁置此文件…", phase: "later" },
    ],
  },
  F02: {
    title: "单个 Depot 文件：Depot 侧栏",
    items: [
      {
        id: "F02-01",
        label: "文件预览",
        phase: "initial",
      },
      {
        id: "F02-02",
        label: "在新页签中预览",
        phase: "initial",
      },
      {
        id: "F02-03",
        label: "其他软件打开…",
        phase: "initial",
      },
      {
        id: "F02-04",
        label: "系统中定位",
        phase: "initial",
      },
      {
        id: "F02-05",
        label: "获取最新",
        phase: "initial",
      },
      {
        id: "F02-06",
        label: "获取指定版本…",
        phase: "initial",
      },
      {
        id: "F02-07",
        label: "签出…",
        phase: "initial",
      },
      {
        id: "F02-08",
        label: "标记删除…",
        phase: "initial",
      },
      {
        id: "F02-09",
        label: "还原…",
        phase: "initial",
      },
      {
        id: "F02-10",
        label: "与 have 版本比较",
        phase: "initial",
      },
      {
        id: "F02-11",
        label: "文件历史",
        phase: "initial",
      },
      {
        id: "F02-12",
        label: "修订图",
        phase: "initial",
      },
      {
        id: "F02-13",
        label: "在工作区中定位",
        phase: "initial",
      },
      {
        id: "F02-14",
        label: "在文件页中显示",
        phase: "initial",
      },
      {
        id: "F02-15",
        label: "复制 › 文件名",
        phase: "initial",
      },
      {
        id: "F02-16",
        label: "复制 › Depot 路径",
        phase: "initial",
      },
      {
        id: "F02-17",
        label: "复制 › 本地绝对路径",
        phase: "initial",
      },
      {
        id: "F02-18",
        label: "复制 › 工作区相对路径",
        phase: "initial",
      },
      {
        id: "F02-19",
        label: "刷新状态",
        phase: "initial",
      },
      {
        id: "F02-20",
        label: "签出并用其他软件打开…",
        phase: "later",
      },
      {
        id: "F02-21",
        label: "移到 CL…",
        phase: "later",
      },
      {
        id: "F02-22",
        label: "还原未修改文件",
        phase: "later",
      },
      {
        id: "F02-23",
        label: "解决冲突…",
        phase: "later",
      },
      {
        id: "F02-24",
        label: "更改文件类型…",
        phase: "later",
      },
      {
        id: "F02-25",
        label: "锁定文件",
        phase: "initial",
      },
      {
        id: "F02-26",
        label: "解锁文件",
        phase: "initial",
      },
      {
        id: "F02-27",
        label: "重命名/移动…",
        phase: "later",
      },
      {
        id: "F02-28",
        label: "从工作区移除…",
        phase: "later",
      },
      {
        id: "F02-29",
        label: "与其他文件/版本比较…",
        phase: "later",
      },
      {
        id: "F02-30",
        label: "合并/集成…",
        phase: "later",
      },
      {
        id: "F02-31",
        label: "复制到…",
        phase: "later",
      },
      {
        id: "F02-32",
        label: "创建分支…",
        phase: "later",
      },
      {
        id: "F02-33",
        label: "撤销已提交变更…",
        phase: "later",
      },
      {
        id: "F02-34",
        label: "打标签…",
        phase: "later",
      },
      {
        id: "F02-35",
        label: "在 Streams 中查找…",
        phase: "later",
      },
      { id: "F02-36", label: "搁置此文件…", phase: "later" },
    ],
  },
  F03: {
    title: "单个本地目录：工作区侧栏、Files",
    items: [
      {
        id: "F03-01",
        label: "浏览此目录",
        phase: "initial",
      },
      {
        id: "F03-02",
        label: "在文件页中显示",
        phase: "initial",
      },
      {
        id: "F03-03",
        label: "系统中定位",
        phase: "initial",
      },
      {
        id: "F03-04",
        label: "获取最新（递归）…",
        phase: "initial",
      },
      {
        id: "F03-05",
        label: "获取指定版本（递归）…",
        phase: "initial",
      },
      {
        id: "F03-06",
        label: "签出（递归）…",
        phase: "initial",
      },
      {
        id: "F03-07",
        label: "添加未跟踪文件（递归）…",
        phase: "initial",
      },
      {
        id: "F03-08",
        label: "标记删除（递归）…",
        phase: "initial",
      },
      {
        id: "F03-09",
        label: "还原（递归）…",
        phase: "initial",
      },
      {
        id: "F03-10",
        label: "在此目录搜索",
        phase: "initial",
      },
      {
        id: "F03-11",
        label: "在 Depot 中定位",
        phase: "initial",
      },
      {
        id: "F03-12",
        label: "复制 › 目录名",
        phase: "initial",
      },
      {
        id: "F03-13",
        label: "复制 › 本地绝对路径",
        phase: "initial",
      },
      {
        id: "F03-14",
        label: "复制 › 工作区相对路径",
        phase: "initial",
      },
      {
        id: "F03-15",
        label: "复制 › Depot 路径",
        phase: "initial",
      },
      {
        id: "F03-16",
        label: "刷新目录",
        phase: "initial",
      },
      {
        id: "F03-17",
        label: "在此目录打开命令行",
        phase: "later",
      },
      {
        id: "F03-18",
        label: "对账（递归）…",
        phase: "later",
      },
      {
        id: "F03-19",
        label: "还原未修改文件（递归）…",
        phase: "later",
      },
      {
        id: "F03-20",
        label: "从工作区移除（递归）…",
        phase: "later",
      },
      {
        id: "F03-21",
        label: "重命名/移动目录…",
        phase: "later",
      },
      {
        id: "F03-22",
        label: "合并/集成目录…",
        phase: "later",
      },
      {
        id: "F03-23",
        label: "复制目录到…",
        phase: "later",
      },
      {
        id: "F03-24",
        label: "创建目录分支…",
        phase: "later",
      },
      {
        id: "F03-25",
        label: "给目录文件打标签…",
        phase: "later",
      },
    ],
  },
  F04: {
    title: "单个 Depot 目录",
    items: [
      {
        id: "F04-01",
        label: "浏览此目录",
        phase: "initial",
      },
      {
        id: "F04-02",
        label: "在文件页中显示",
        phase: "initial",
      },
      {
        id: "F04-03",
        label: "在工作区中定位",
        phase: "initial",
      },
      {
        id: "F04-04",
        label: "系统中定位",
        phase: "initial",
      },
      {
        id: "F04-05",
        label: "获取最新（递归）…",
        phase: "initial",
      },
      {
        id: "F04-06",
        label: "获取指定版本（递归）…",
        phase: "initial",
      },
      {
        id: "F04-07",
        label: "签出（递归）…",
        phase: "initial",
      },
      {
        id: "F04-08",
        label: "标记删除（递归）…",
        phase: "initial",
      },
      {
        id: "F04-09",
        label: "还原（递归）…",
        phase: "initial",
      },
      {
        id: "F04-10",
        label: "在此目录搜索",
        phase: "initial",
      },
      {
        id: "F04-11",
        label: "复制 › 目录名",
        phase: "initial",
      },
      {
        id: "F04-12",
        label: "复制 › Depot 路径",
        phase: "initial",
      },
      {
        id: "F04-13",
        label: "复制 › 本地绝对路径",
        phase: "initial",
      },
      {
        id: "F04-14",
        label: "刷新目录",
        phase: "initial",
      },
      {
        id: "F04-15",
        label: "在此目录打开命令行",
        phase: "later",
      },
      {
        id: "F04-16",
        label: "从工作区移除（递归）…",
        phase: "later",
      },
      {
        id: "F04-17",
        label: "合并/集成目录…",
        phase: "later",
      },
      {
        id: "F04-18",
        label: "复制目录到…",
        phase: "later",
      },
      {
        id: "F04-19",
        label: "创建目录分支…",
        phase: "later",
      },
      {
        id: "F04-20",
        label: "给目录文件打标签…",
        phase: "later",
      },
    ],
  },
  F05: {
    title: "工作区树根",
    items: [
      {
        id: "F05-01",
        label: "在文件页中显示",
        phase: "initial",
      },
      {
        id: "F05-02",
        label: "系统中定位",
        phase: "initial",
      },
      {
        id: "F05-03",
        label: "获取整个工作区最新版本…",
        phase: "initial",
      },
      {
        id: "F05-04",
        label: "获取整个工作区指定版本…",
        phase: "initial",
      },
      {
        id: "F05-05",
        label: "签出整个工作区适用文件…",
        phase: "initial",
      },
      {
        id: "F05-06",
        label: "添加未跟踪文件（递归）…",
        phase: "initial",
      },
      {
        id: "F05-07",
        label: "标记删除整个工作区受控文件…",
        phase: "initial",
      },
      {
        id: "F05-08",
        label: "还原整个工作区…",
        phase: "initial",
      },
      {
        id: "F05-09",
        label: "在工作区中搜索",
        phase: "initial",
      },
      {
        id: "F05-10",
        label: "复制工作区根路径",
        phase: "initial",
      },
      {
        id: "F05-11",
        label: "刷新",
        phase: "initial",
      },
      {
        id: "F05-12",
        label: "在工作区根打开命令行",
        phase: "later",
      },
      {
        id: "F05-13",
        label: "对账整个工作区…",
        phase: "later",
      },
      {
        id: "F05-14",
        label: "还原整个工作区未修改文件…",
        phase: "later",
      },
    ],
  },
  F06: {
    title: "某个 Depot 根",
    items: [
      {
        id: "F06-01",
        label: "浏览此 Depot",
        phase: "initial",
      },
      {
        id: "F06-02",
        label: "在文件页中显示",
        phase: "initial",
      },
      {
        id: "F06-03",
        label: "获取映射范围最新版本…",
        phase: "initial",
      },
      {
        id: "F06-04",
        label: "获取映射范围指定版本…",
        phase: "initial",
      },
      {
        id: "F06-05",
        label: "签出映射范围适用文件…",
        phase: "initial",
      },
      {
        id: "F06-06",
        label: "标记删除映射范围受控文件…",
        phase: "initial",
      },
      {
        id: "F06-07",
        label: "还原映射范围文件…",
        phase: "initial",
      },
      {
        id: "F06-08",
        label: "在此 Depot 搜索",
        phase: "initial",
      },
      {
        id: "F06-09",
        label: "复制 Depot 路径",
        phase: "initial",
      },
      {
        id: "F06-10",
        label: "刷新",
        phase: "initial",
      },
      {
        id: "F06-11",
        label: "合并/集成…",
        phase: "later",
      },
      {
        id: "F06-12",
        label: "复制/分支…",
        phase: "later",
      },
    ],
  },
  F07: {
    title: "多个文件",
    items: [
      {
        id: "F07-01",
        label: "获取最新…",
        phase: "initial",
      },
      {
        id: "F07-02",
        label: "获取指定版本…",
        phase: "initial",
      },
      {
        id: "F07-03",
        label: "签出…",
        phase: "initial",
      },
      {
        id: "F07-04",
        label: "添加到 P4…",
        phase: "initial",
      },
      {
        id: "F07-05",
        label: "标记删除…",
        phase: "initial",
      },
      {
        id: "F07-06",
        label: "还原…",
        phase: "initial",
      },
      {
        id: "F07-07",
        label: "复制 › 文件名列表",
        phase: "initial",
      },
      {
        id: "F07-08",
        label: "复制 › 本地路径列表",
        phase: "initial",
      },
      {
        id: "F07-09",
        label: "复制 › 相对路径列表",
        phase: "initial",
      },
      {
        id: "F07-10",
        label: "复制 › Depot 路径列表",
        phase: "initial",
      },
      {
        id: "F07-11",
        label: "刷新状态",
        phase: "initial",
      },
      {
        id: "F07-12",
        label: "移到 CL…",
        phase: "later",
      },
      {
        id: "F07-13",
        label: "搁置所选文件…",
        phase: "later",
      },
      {
        id: "F07-14",
        label: "还原未修改文件",
        phase: "later",
      },
      {
        id: "F07-15",
        label: "解决冲突…",
        phase: "later",
      },
      {
        id: "F07-16",
        label: "更改文件类型…",
        phase: "later",
      },
      {
        id: "F07-17",
        label: "锁定",
        phase: "initial",
      },
      {
        id: "F07-18",
        label: "解锁",
        phase: "initial",
      },
      {
        id: "F07-19",
        label: "从工作区移除…",
        phase: "later",
      },
      {
        id: "F07-20",
        label: "对账…",
        phase: "later",
      },
      {
        id: "F07-21",
        label: "打标签…",
        phase: "later",
      },
      {
        id: "F07-22",
        label: "比较这两个文件…",
        phase: "later",
      },
    ],
  },
  F08: {
    title: "多个目录 / 文件目录混选",
    items: [
      {
        id: "F08-01",
        label: "获取最新（含递归）…",
        phase: "initial",
      },
      {
        id: "F08-02",
        label: "获取指定版本（含递归）…",
        phase: "initial",
      },
      {
        id: "F08-03",
        label: "签出（含递归）…",
        phase: "initial",
      },
      {
        id: "F08-04",
        label: "添加未跟踪文件（含递归）…",
        phase: "initial",
      },
      {
        id: "F08-05",
        label: "标记删除（含递归）…",
        phase: "initial",
      },
      {
        id: "F08-06",
        label: "还原（含递归）…",
        phase: "initial",
      },
      {
        id: "F08-07",
        label: "复制 › 名称列表",
        phase: "initial",
      },
      {
        id: "F08-08",
        label: "复制 › 本地路径列表",
        phase: "initial",
      },
      {
        id: "F08-09",
        label: "复制 › 相对路径列表",
        phase: "initial",
      },
      {
        id: "F08-10",
        label: "复制 › Depot 路径列表",
        phase: "initial",
      },
      {
        id: "F08-11",
        label: "刷新",
        phase: "initial",
      },
      {
        id: "F08-12",
        label: "对账（含递归）…",
        phase: "later",
      },
      {
        id: "F08-13",
        label: "还原未修改文件（含递归）…",
        phase: "later",
      },
      {
        id: "F08-14",
        label: "从工作区移除（含递归）…",
        phase: "later",
      },
    ],
  },
  F09: {
    title: "Files / 资源列表空白处",
    items: [
      {
        id: "F09-01",
        label: "刷新当前列表",
        phase: "initial",
      },
      {
        id: "F09-02",
        label: "全选当前筛选结果",
        phase: "initial",
      },
      {
        id: "F09-03",
        label: "清除选择",
        phase: "initial",
      },
      {
        id: "F09-04",
        label: "复制当前目录路径",
        phase: "initial",
      },
      {
        id: "F09-05",
        label: "系统中定位当前目录",
        phase: "initial",
      },
      {
        id: "F09-06",
        label: "在当前目录搜索",
        phase: "initial",
      },
      {
        id: "F09-07",
        label: "在当前目录打开命令行",
        phase: "later",
      },
    ],
  },
  F10: {
    title: "所有 Depot 的顶层容器（不是某个 Depot）",
    items: [
      {
        id: "F10-01",
        label: "刷新 Depot 列表",
        phase: "initial",
      },
      {
        id: "F10-02",
        label: "全选当前可见结果",
        phase: "initial",
      },
      {
        id: "F10-03",
        label: "清除选择",
        phase: "initial",
      },
    ],
  },
  C01: {
    title: "Default CL 标题",
    items: [
      {
        id: "C01-01",
        label: "展开/折叠",
        phase: "initial",
      },
      {
        id: "C01-02",
        label: "查看详情",
        phase: "initial",
      },
      {
        id: "C01-03",
        label: "复制标识 default",
        phase: "initial",
      },
      {
        id: "C01-04",
        label: "刷新",
        phase: "initial",
      },
      {
        id: "C01-05",
        label: "移动文件到编号 CL…",
        phase: "later",
      },
      {
        id: "C01-06",
        label: "创建编号 CL 并提交…",
        phase: "later",
      },
      {
        id: "C01-07",
        label: "创建编号 CL 并搁置…",
        phase: "later",
      },
      {
        id: "C01-08",
        label: "还原整个 Default CL…",
        phase: "later",
      },
      {
        id: "C01-09",
        label: "还原未修改文件",
        phase: "later",
      },
    ],
  },
  C02: {
    title: "当前用户/工作区的编号 Pending CL 标题",
    items: [
      {
        id: "C02-01",
        label: "展开/折叠",
        phase: "initial",
      },
      {
        id: "C02-02",
        label: "查看详情",
        phase: "initial",
      },
      {
        id: "C02-03",
        label: "提交整个 CL…",
        phase: "initial",
      },
      {
        id: "C02-04",
        label: "复制 CL 编号",
        phase: "initial",
      },
      {
        id: "C02-05",
        label: "复制描述",
        phase: "initial",
      },
      {
        id: "C02-06",
        label: "刷新",
        phase: "initial",
      },
      {
        id: "C02-07",
        label: "编辑 CL…",
        phase: "later",
      },
      {
        id: "C02-08",
        label: "移动文件到其他 CL…",
        phase: "later",
      },
      {
        id: "C02-09",
        label: "搁置…",
        phase: "later",
      },
      {
        id: "C02-10",
        label: "还原整个 CL…",
        phase: "later",
      },
      {
        id: "C02-11",
        label: "还原未修改文件",
        phase: "later",
      },
      {
        id: "C02-12",
        label: "删除空 CL…",
        phase: "later",
      },
      { id: "C02-13", label: "在 Swarm 中打开", phase: "initial" },
    ],
  },
  C03: {
    title: "其他用户/工作区的 Pending CL",
    items: [
      {
        id: "C03-01",
        label: "展开/折叠",
        phase: "initial",
      },
      {
        id: "C03-02",
        label: "查看详情",
        phase: "initial",
      },
      {
        id: "C03-03",
        label: "复制 CL 编号",
        phase: "initial",
      },
      {
        id: "C03-04",
        label: "复制描述",
        phase: "initial",
      },
      {
        id: "C03-05",
        label: "刷新",
        phase: "initial",
      },
      {
        id: "C03-06",
        label: "查看其搁置内容",
        phase: "later",
      },
      { id: "C03-07", label: "在 Swarm 中打开", phase: "initial" },
    ],
  },
  C04: {
    title: "Pending CL 内单个工作文件",
    items: [
      {
        id: "C04-01",
        label: "文件预览",
        phase: "initial",
      },
      {
        id: "C04-02",
        label: "在新页签中预览",
        phase: "initial",
      },
      {
        id: "C04-03",
        label: "其他软件打开…",
        phase: "initial",
      },
      {
        id: "C04-04",
        label: "系统中定位",
        phase: "initial",
      },
      {
        id: "C04-05",
        label: "与 have 版本比较",
        phase: "initial",
      },
      {
        id: "C04-06",
        label: "文件历史",
        phase: "initial",
      },
      {
        id: "C04-07",
        label: "修订图",
        phase: "initial",
      },
      {
        id: "C04-08",
        label: "标记删除…",
        phase: "initial",
      },
      {
        id: "C04-09",
        label: "还原此文件…",
        phase: "initial",
      },
      {
        id: "C04-10",
        label: "在工作区中定位",
        phase: "initial",
      },
      {
        id: "C04-11",
        label: "在 Depot 中定位",
        phase: "initial",
      },
      {
        id: "C04-12",
        label: "复制 › 文件名",
        phase: "initial",
      },
      {
        id: "C04-13",
        label: "复制 › 本地绝对路径",
        phase: "initial",
      },
      {
        id: "C04-14",
        label: "复制 › 相对路径",
        phase: "initial",
      },
      {
        id: "C04-15",
        label: "复制 › Depot 路径",
        phase: "initial",
      },
      {
        id: "C04-16",
        label: "刷新状态",
        phase: "initial",
      },
      {
        id: "C04-17",
        label: "移到 CL…",
        phase: "later",
      },
      {
        id: "C04-18",
        label: "搁置此文件…",
        phase: "later",
      },
      {
        id: "C04-19",
        label: "还原未修改文件",
        phase: "later",
      },
      {
        id: "C04-20",
        label: "解决冲突…",
        phase: "later",
      },
      {
        id: "C04-21",
        label: "更改文件类型…",
        phase: "later",
      },
      {
        id: "C04-22",
        label: "锁定文件",
        phase: "initial",
      },
      {
        id: "C04-23",
        label: "解锁文件",
        phase: "initial",
      },
    ],
  },
  C05: {
    title: "Pending CL 内多个工作文件",
    items: [
      {
        id: "C05-01",
        label: "标记删除所选文件…",
        phase: "initial",
      },
      {
        id: "C05-02",
        label: "还原所选文件…",
        phase: "initial",
      },
      {
        id: "C05-03",
        label: "复制 › 文件名列表",
        phase: "initial",
      },
      {
        id: "C05-04",
        label: "复制 › 本地路径列表",
        phase: "initial",
      },
      {
        id: "C05-05",
        label: "复制 › 相对路径列表",
        phase: "initial",
      },
      {
        id: "C05-06",
        label: "复制 › Depot 路径列表",
        phase: "initial",
      },
      {
        id: "C05-07",
        label: "刷新状态",
        phase: "initial",
      },
      {
        id: "C05-08",
        label: "移到 CL…",
        phase: "later",
      },
      {
        id: "C05-09",
        label: "搁置所选文件…",
        phase: "later",
      },
      {
        id: "C05-10",
        label: "还原未修改文件",
        phase: "later",
      },
      {
        id: "C05-11",
        label: "解决冲突…",
        phase: "later",
      },
      {
        id: "C05-12",
        label: "更改文件类型…",
        phase: "later",
      },
      {
        id: "C05-13",
        label: "锁定",
        phase: "initial",
      },
      {
        id: "C05-14",
        label: "解锁",
        phase: "initial",
      },
    ],
  },
  C06: {
    title: "Shelf 分组 / 搁置 CL",
    items: [
      {
        id: "C06-01",
        label: "展开/折叠",
        phase: "initial",
      },
      {
        id: "C06-02",
        label: "复制来源 CL 编号",
        phase: "initial",
      },
      {
        id: "C06-03",
        label: "刷新",
        phase: "initial",
      },
      {
        id: "C06-04",
        label: "查看搁置详情",
        phase: "later",
      },
      {
        id: "C06-05",
        label: "Unshelve 到 CL…",
        phase: "later",
      },
      {
        id: "C06-06",
        label: "删除搁置内容…",
        phase: "later",
      },
      { id: "C06-07", label: "在 Swarm 中打开", phase: "initial" },
    ],
  },
  C07: {
    title: "单个搁置文件",
    items: [
      {
        id: "C07-01",
        label: "复制 Depot 路径",
        phase: "initial",
      },
      {
        id: "C07-02",
        label: "复制搁置来源标识",
        phase: "initial",
      },
      {
        id: "C07-03",
        label: "刷新",
        phase: "initial",
      },
      {
        id: "C07-04",
        label: "查看搁置内容",
        phase: "later",
      },
      {
        id: "C07-05",
        label: "在新页签查看搁置内容",
        phase: "later",
      },
      {
        id: "C07-06",
        label: "与工作副本比较",
        phase: "later",
      },
      {
        id: "C07-07",
        label: "与基线比较",
        phase: "later",
      },
      {
        id: "C07-08",
        label: "Unshelve 此文件…",
        phase: "later",
      },
      {
        id: "C07-09",
        label: "删除此搁置文件…",
        phase: "later",
      },
      {
        id: "C07-10",
        label: "在工作区中定位",
        phase: "later",
      },
      {
        id: "C07-11",
        label: "文件历史",
        phase: "later",
      },
      {
        id: "C07-12",
        label: "修订图",
        phase: "later",
      },
    ],
  },
  C08: {
    title: "多个搁置文件",
    items: [
      {
        id: "C08-01",
        label: "复制 Depot 路径列表",
        phase: "initial",
      },
      {
        id: "C08-02",
        label: "复制搁置来源标识列表",
        phase: "initial",
      },
      {
        id: "C08-03",
        label: "刷新",
        phase: "initial",
      },
      {
        id: "C08-04",
        label: "Unshelve 所选搁置文件…",
        phase: "later",
      },
      {
        id: "C08-05",
        label: "删除所选搁置文件…",
        phase: "later",
      },
    ],
  },
  C09: {
    title: "Submitted CL",
    items: [
      {
        id: "C09-01",
        label: "查看详情",
        phase: "initial",
      },
      {
        id: "C09-02",
        label: "复制 CL 编号",
        phase: "initial",
      },
      {
        id: "C09-03",
        label: "复制描述",
        phase: "initial",
      },
      {
        id: "C09-04",
        label: "刷新",
        phase: "initial",
      },
      {
        id: "C09-05",
        label: "查看此 CL 的差异",
        phase: "later",
      },
      {
        id: "C09-06",
        label: "同步工作区到此 CL…",
        phase: "later",
      },
      {
        id: "C09-07",
        label: "撤销此 CL…",
        phase: "later",
      },
      { id: "C09-08", label: "在 Swarm 中打开", phase: "initial" },
    ],
  },
  C10: {
    title: "Submitted CL 内单个文件",
    items: [
      {
        id: "C10-01",
        label: "复制 Depot 路径",
        phase: "initial",
      },
      {
        id: "C10-02",
        label: "复制精确修订标识",
        phase: "initial",
      },
      {
        id: "C10-03",
        label: "复制所属 CL 编号",
        phase: "initial",
      },
      {
        id: "C10-04",
        label: "文件历史",
        phase: "initial",
      },
      {
        id: "C10-05",
        label: "修订图",
        phase: "initial",
      },
      {
        id: "C10-06",
        label: "在工作区中定位",
        phase: "initial",
      },
      {
        id: "C10-07",
        label: "在 Depot 中定位",
        phase: "initial",
      },
      {
        id: "C10-08",
        label: "查看此修订",
        phase: "later",
      },
      {
        id: "C10-09",
        label: "在新页签查看此修订",
        phase: "later",
      },
      {
        id: "C10-10",
        label: "与上一修订比较",
        phase: "later",
      },
      {
        id: "C10-11",
        label: "与工作副本比较",
        phase: "later",
      },
      {
        id: "C10-12",
        label: "获取此修订…",
        phase: "later",
      },
      { id: "C10-13", label: "在 Swarm 中打开", phase: "initial" },
    ],
  },
  C11: {
    title: "Submitted CL 内多个文件",
    items: [
      {
        id: "C11-01",
        label: "复制 Depot 路径列表",
        phase: "initial",
      },
      {
        id: "C11-02",
        label: "复制精确修订标识列表",
        phase: "initial",
      },
      {
        id: "C11-03",
        label: "获取所选文件的这些修订…",
        phase: "later",
      },
      {
        id: "C11-04",
        label: "查看所选文件差异",
        phase: "later",
      },
    ],
  },
  C12: {
    title: "多个 CL（Pending / Submitted）",
    items: [
      {
        id: "C12-01",
        label: "复制 CL 编号列表",
        phase: "initial",
      },
      {
        id: "C12-02",
        label: "复制摘要列表",
        phase: "initial",
      },
      {
        id: "C12-03",
        label: "刷新",
        phase: "initial",
      },
    ],
  },
  C13: {
    title: "Pending 列表空白处",
    items: [
      {
        id: "C13-01",
        label: "刷新",
        phase: "initial",
      },
      {
        id: "C13-02",
        label: "全选当前筛选结果",
        phase: "initial",
      },
      {
        id: "C13-03",
        label: "清除选择",
        phase: "initial",
      },
      {
        id: "C13-04",
        label: "新建 CL…",
        phase: "later",
      },
    ],
  },
  C14: {
    title: "Submitted 列表空白处",
    items: [
      {
        id: "C14-01",
        label: "刷新",
        phase: "initial",
      },
      {
        id: "C14-02",
        label: "全选当前筛选结果",
        phase: "initial",
      },
      {
        id: "C14-03",
        label: "清除选择",
        phase: "initial",
      },
    ],
  },
  V01: {
    title: "History 单个修订行 / Revgraph 单个节点",
    items: [
      {
        id: "V01-01",
        label: "复制 Depot 路径",
        phase: "initial",
      },
      {
        id: "V01-02",
        label: "复制精确修订标识",
        phase: "initial",
      },
      {
        id: "V01-03",
        label: "复制 CL 编号",
        phase: "initial",
      },
      {
        id: "V01-04",
        label: "打开所属 CL",
        phase: "later",
      },
      {
        id: "V01-05",
        label: "查看此修订",
        phase: "later",
      },
      {
        id: "V01-06",
        label: "在新页签查看此修订",
        phase: "later",
      },
      {
        id: "V01-07",
        label: "与上一修订比较",
        phase: "later",
      },
      {
        id: "V01-08",
        label: "与工作副本比较",
        phase: "later",
      },
      {
        id: "V01-09",
        label: "选择为比较基准",
        phase: "later",
      },
      {
        id: "V01-10",
        label: "与比较基准比较",
        phase: "later",
      },
      {
        id: "V01-11",
        label: "获取此修订…",
        phase: "later",
      },
      { id: "V01-12", label: "在 Swarm 中打开", phase: "initial" },
    ],
  },
  V02: {
    title: "恰好两个历史修订 / 图节点",
    items: [
      {
        id: "V02-01",
        label: "复制所选修订标识",
        phase: "initial",
      },
      {
        id: "V02-02",
        label: "比较所选修订",
        phase: "later",
      },
    ],
  },
  V03: {
    title: "三个及以上历史修订 / 图节点",
    items: [
      {
        id: "V03-01",
        label: "复制所选修订标识",
        phase: "initial",
      },
    ],
  },
  V04: {
    title: "Diff 某一侧文本内容",
    items: [
      {
        id: "V04-01",
        label: "复制所选文本",
        phase: "initial",
      },
      {
        id: "V04-02",
        label: "全选当前侧",
        phase: "initial",
      },
      {
        id: "V04-03",
        label: "复制当前侧文件/修订标识",
        phase: "initial",
      },
      {
        id: "V04-04",
        label: "在工作区中定位",
        phase: "initial",
      },
      {
        id: "V04-05",
        label: "在 Depot 中定位",
        phase: "initial",
      },
      {
        id: "V04-06",
        label: "打开当前侧精确版本",
        phase: "later",
      },
      { id: "V04-07", label: "在 Swarm 中打开", phase: "initial" },
    ],
  },
  V05: {
    title: "本地文本预览内容",
    items: [
      {
        id: "V05-01",
        label: "复制所选文本",
        phase: "initial",
      },
      {
        id: "V05-02",
        label: "全选",
        phase: "initial",
      },
      {
        id: "V05-03",
        label: "复制文件路径",
        phase: "initial",
      },
      {
        id: "V05-04",
        label: "系统中定位",
        phase: "initial",
      },
      {
        id: "V05-05",
        label: "其他软件打开…",
        phase: "initial",
      },
    ],
  },
  V06: {
    title: "本地图片预览内容",
    items: [
      {
        id: "V06-01",
        label: "适应窗口",
        phase: "initial",
      },
      {
        id: "V06-02",
        label: "原始尺寸",
        phase: "initial",
      },
      {
        id: "V06-03",
        label: "复制文件路径",
        phase: "initial",
      },
      {
        id: "V06-04",
        label: "系统中定位",
        phase: "initial",
      },
      {
        id: "V06-05",
        label: "其他软件打开…",
        phase: "initial",
      },
      {
        id: "V06-06",
        label: "复制图片",
        phase: "later",
      },
      {
        id: "V06-07",
        label: "图片另存为…",
        phase: "later",
      },
    ],
  },
  V07: {
    title: "预览不支持 / 加载失败区域",
    items: [
      {
        id: "V07-01",
        label: "重新加载",
        phase: "initial",
      },
      {
        id: "V07-02",
        label: "复制已知路径",
        phase: "initial",
      },
      {
        id: "V07-03",
        label: "系统中定位",
        phase: "initial",
      },
      {
        id: "V07-04",
        label: "其他软件打开…",
        phase: "initial",
      },
    ],
  },
  V08: {
    title: "History / Revgraph / Diff 空白区域",
    items: [
      {
        id: "V08-01",
        label: "刷新当前视图",
        phase: "initial",
      },
      {
        id: "V08-02",
        label: "复制当前目标标识",
        phase: "initial",
      },
      {
        id: "V08-03",
        label: "修订图适应视图",
        phase: "later",
      },
      {
        id: "V08-04",
        label: "修订图重置缩放",
        phase: "later",
      },
      { id: "V08-05", label: "在 Swarm 中打开", phase: "initial" },
    ],
  },
  S01: {
    title: "真实文件搜索结果：单文件",
    items: [
      {
        id: "S01-01",
        label: "文件预览",
        phase: "later",
      },
      {
        id: "S01-02",
        label: "在新页签中预览",
        phase: "later",
      },
      {
        id: "S01-03",
        label: "其他软件打开…",
        phase: "later",
      },
      {
        id: "S01-04",
        label: "系统中定位",
        phase: "later",
      },
      {
        id: "S01-05",
        label: "获取最新",
        phase: "later",
      },
      {
        id: "S01-06",
        label: "获取指定版本…",
        phase: "later",
      },
      {
        id: "S01-07",
        label: "签出…",
        phase: "later",
      },
      {
        id: "S01-08",
        label: "添加到 P4…",
        phase: "later",
      },
      {
        id: "S01-09",
        label: "标记删除…",
        phase: "later",
      },
      {
        id: "S01-10",
        label: "还原…",
        phase: "later",
      },
      {
        id: "S01-11",
        label: "与 have 版本比较",
        phase: "later",
      },
      {
        id: "S01-12",
        label: "文件历史",
        phase: "later",
      },
      {
        id: "S01-13",
        label: "修订图",
        phase: "later",
      },
      {
        id: "S01-14",
        label: "在所在目录显示",
        phase: "later",
      },
      {
        id: "S01-15",
        label: "在工作区中定位",
        phase: "later",
      },
      {
        id: "S01-16",
        label: "在 Depot 中定位",
        phase: "later",
      },
      {
        id: "S01-17",
        label: "复制 › 文件名",
        phase: "later",
      },
      {
        id: "S01-18",
        label: "复制 › 本地路径",
        phase: "later",
      },
      {
        id: "S01-19",
        label: "复制 › 相对路径",
        phase: "later",
      },
      {
        id: "S01-20",
        label: "复制 › Depot 路径",
        phase: "later",
      },
      {
        id: "S01-21",
        label: "刷新状态",
        phase: "later",
      },
    ],
  },
  S02: {
    title: "真实文件搜索结果：多文件",
    items: [
      {
        id: "S02-01",
        label: "获取最新…",
        phase: "later",
      },
      {
        id: "S02-02",
        label: "获取指定版本…",
        phase: "later",
      },
      {
        id: "S02-03",
        label: "签出…",
        phase: "later",
      },
      {
        id: "S02-04",
        label: "添加到 P4…",
        phase: "later",
      },
      {
        id: "S02-05",
        label: "标记删除…",
        phase: "later",
      },
      {
        id: "S02-06",
        label: "还原…",
        phase: "later",
      },
      {
        id: "S02-07",
        label: "复制 › 文件名列表",
        phase: "later",
      },
      {
        id: "S02-08",
        label: "复制 › 本地路径列表",
        phase: "later",
      },
      {
        id: "S02-09",
        label: "复制 › 相对路径列表",
        phase: "later",
      },
      {
        id: "S02-10",
        label: "复制 › Depot 路径列表",
        phase: "later",
      },
      {
        id: "S02-11",
        label: "刷新状态",
        phase: "later",
      },
    ],
  },
  S03: {
    title: "真实 CL 搜索结果",
    items: [
      {
        id: "S03-01",
        label: "打开 CL 详情",
        phase: "later",
      },
      {
        id: "S03-02",
        label: "复制 CL 编号",
        phase: "later",
      },
      {
        id: "S03-03",
        label: "复制描述",
        phase: "later",
      },
      {
        id: "S03-04",
        label: "刷新此结果",
        phase: "later",
      },
    ],
  },
  S04: {
    title: "演示搜索结果：文件 / CL",
    items: [
      {
        id: "S04-01",
        label: "复制展示的文件路径或 CL 编号",
        phase: "initial",
      },
      {
        id: "S04-02",
        label: "查看演示说明",
        phase: "initial",
      },
    ],
  },
  S05: {
    title: "搜索结果空白区",
    items: [
      {
        id: "S05-01",
        label: "复制当前查询条件",
        phase: "initial",
      },
      {
        id: "S05-02",
        label: "全选结果",
        phase: "initial",
      },
      {
        id: "S05-03",
        label: "清除选择",
        phase: "initial",
      },
      {
        id: "S05-04",
        label: "重新执行搜索",
        phase: "later",
      },
    ],
  },
  W01: {
    title: "单个 Workspace 记录",
    items: [
      {
        id: "W01-01",
        label: "查看详情",
        phase: "initial",
      },
      {
        id: "W01-02",
        label: "复制名称",
        phase: "initial",
      },
      {
        id: "W01-03",
        label: "复制根路径",
        phase: "initial",
      },
      {
        id: "W01-04",
        label: "复制 Stream 路径",
        phase: "initial",
      },
      {
        id: "W01-05",
        label: "刷新",
        phase: "initial",
      },
      {
        id: "W01-06",
        label: "切换到此工作区…",
        phase: "later",
      },
      {
        id: "W01-07",
        label: "编辑工作区…",
        phase: "later",
      },
      {
        id: "W01-08",
        label: "复制配置新建工作区…",
        phase: "later",
      },
      {
        id: "W01-09",
        label: "删除工作区…",
        phase: "later",
      },
      {
        id: "W01-10",
        label: "系统中定位根目录",
        phase: "later",
      },
    ],
  },
  W02: {
    title: "多个 Workspace 记录",
    items: [
      {
        id: "W02-01",
        label: "复制名称列表",
        phase: "initial",
      },
      {
        id: "W02-02",
        label: "复制根路径列表",
        phase: "initial",
      },
      {
        id: "W02-03",
        label: "刷新",
        phase: "initial",
      },
    ],
  },
  W03: {
    title: "Workspace 列表空白处",
    items: [
      {
        id: "W03-01",
        label: "刷新",
        phase: "initial",
      },
      {
        id: "W03-02",
        label: "全选结果",
        phase: "initial",
      },
      {
        id: "W03-03",
        label: "清除选择",
        phase: "initial",
      },
      {
        id: "W03-04",
        label: "新建工作区…",
        phase: "later",
      },
    ],
  },
  W04: {
    title: "单个 Stream 记录",
    items: [
      {
        id: "W04-01",
        label: "查看详情",
        phase: "initial",
      },
      {
        id: "W04-02",
        label: "复制 Stream 路径",
        phase: "initial",
      },
      {
        id: "W04-03",
        label: "复制名称",
        phase: "initial",
      },
      {
        id: "W04-04",
        label: "复制父 Stream 路径",
        phase: "initial",
      },
      {
        id: "W04-05",
        label: "刷新",
        phase: "initial",
      },
      {
        id: "W04-06",
        label: "查看相关工作区",
        phase: "later",
      },
      {
        id: "W04-07",
        label: "为此 Stream 创建工作区…",
        phase: "later",
      },
      {
        id: "W04-08",
        label: "切换当前工作区到此 Stream…",
        phase: "later",
      },
      {
        id: "W04-09",
        label: "编辑 Stream…",
        phase: "later",
      },
      {
        id: "W04-10",
        label: "新建子 Stream…",
        phase: "later",
      },
      {
        id: "W04-11",
        label: "合并/集成…",
        phase: "later",
      },
      {
        id: "W04-12",
        label: "复制变更…",
        phase: "later",
      },
    ],
  },
  W05: {
    title: "多个 Stream 记录",
    items: [
      {
        id: "W05-01",
        label: "复制 Stream 路径列表",
        phase: "initial",
      },
      {
        id: "W05-02",
        label: "复制名称列表",
        phase: "initial",
      },
      {
        id: "W05-03",
        label: "刷新",
        phase: "initial",
      },
    ],
  },
  W06: {
    title: "Stream 列表空白处",
    items: [
      {
        id: "W06-01",
        label: "刷新",
        phase: "initial",
      },
      {
        id: "W06-02",
        label: "全选结果",
        phase: "initial",
      },
      {
        id: "W06-03",
        label: "清除选择",
        phase: "initial",
      },
      {
        id: "W06-04",
        label: "新建 Stream…",
        phase: "later",
      },
    ],
  },
  T01: {
    title: "全局页签标题",
    items: [
      {
        id: "T01-01",
        label: "关闭",
        phase: "initial",
      },
      {
        id: "T01-02",
        label: "关闭其他页签",
        phase: "initial",
      },
      {
        id: "T01-03",
        label: "关闭右侧页签",
        phase: "initial",
      },
      {
        id: "T01-04",
        label: "关闭本组页签",
        phase: "initial",
      },
      {
        id: "T01-05",
        label: "关闭所有页签",
        phase: "initial",
      },
      {
        id: "T01-06",
        label: "移到右侧分屏",
        phase: "initial",
      },
      {
        id: "T01-07",
        label: "移到下方分屏",
        phase: "initial",
      },
      {
        id: "T01-08",
        label: "移到其他组 › 目标组",
        phase: "initial",
      },
      {
        id: "T01-09",
        label: "弹出独立窗口",
        phase: "initial",
      },
    ],
  },
  T02: {
    title: "文件类页签标题",
    items: [
      {
        id: "T02-01",
        label: "关闭",
        phase: "initial",
      },
      {
        id: "T02-02",
        label: "关闭其他页签",
        phase: "initial",
      },
      {
        id: "T02-03",
        label: "关闭右侧页签",
        phase: "initial",
      },
      {
        id: "T02-04",
        label: "关闭本组页签",
        phase: "initial",
      },
      {
        id: "T02-05",
        label: "关闭所有页签",
        phase: "initial",
      },
      {
        id: "T02-06",
        label: "移到右侧分屏",
        phase: "initial",
      },
      {
        id: "T02-07",
        label: "移到下方分屏",
        phase: "initial",
      },
      {
        id: "T02-08",
        label: "移到其他组 › 目标组",
        phase: "initial",
      },
      {
        id: "T02-09",
        label: "弹出独立窗口",
        phase: "initial",
      },
      {
        id: "T02-10",
        label: "锁定/解锁目标",
        phase: "initial",
      },
      {
        id: "T02-11",
        label: "在新页签打开同一目标",
        phase: "initial",
      },
      {
        id: "T02-12",
        label: "复制目标路径",
        phase: "initial",
      },
    ],
  },
  T03: {
    title: "页签栏空白处",
    items: [
      {
        id: "T03-01",
        label: "打开全局页签 › 文件",
        phase: "initial",
      },
      {
        id: "T03-02",
        label: "打开全局页签 › 搜索",
        phase: "initial",
      },
      {
        id: "T03-03",
        label: "打开全局页签 › Pending",
        phase: "initial",
      },
      {
        id: "T03-04",
        label: "打开全局页签 › Submitted",
        phase: "initial",
      },
      {
        id: "T03-05",
        label: "打开全局页签 › Workspaces",
        phase: "initial",
      },
      {
        id: "T03-06",
        label: "打开全局页签 › Streams",
        phase: "initial",
      },
      {
        id: "T03-07",
        label: "打开全局页签 › 设置",
        phase: "initial",
      },
      {
        id: "T03-08",
        label: "关闭本组页签",
        phase: "initial",
      },
      {
        id: "T03-09",
        label: "关闭所有页签",
        phase: "initial",
      },
    ],
  },
  T04: {
    title: "左侧固定活动栏空白 / 非输入区域",
    items: [
      {
        id: "T04-01",
        label: "显示/隐藏活动栏文字",
        phase: "initial",
      },
      {
        id: "T04-02",
        label: "打开设置",
        phase: "initial",
      },
    ],
  },
  T05: {
    title: "可折叠资源栏标题",
    items: [
      {
        id: "T05-01",
        label: "折叠/展开资源栏",
        phase: "initial",
      },
      {
        id: "T05-02",
        label: "刷新当前资源视图",
        phase: "initial",
      },
    ],
  },
  T06: {
    title: "底部命令行/日志栏标题",
    items: [
      {
        id: "T06-01",
        label: "折叠/展开工具栏",
        phase: "initial",
      },
      {
        id: "T06-02",
        label: "切到命令行",
        phase: "initial",
      },
      {
        id: "T06-03",
        label: "切到日志",
        phase: "initial",
      },
    ],
  },
  T07: {
    title: "顶部操作工具栏空白",
    items: [
      {
        id: "T07-01",
        label: "显示/隐藏工具文字",
        phase: "initial",
      },
      {
        id: "T07-02",
        label: "打开界面设置",
        phase: "initial",
      },
    ],
  },
  T08: {
    title: "文件 / CL / Workspace / Stream 表头",
    items: [
      {
        id: "T08-01",
        label: "按此列升序",
        phase: "later",
      },
      {
        id: "T08-02",
        label: "按此列降序",
        phase: "later",
      },
      {
        id: "T08-03",
        label: "清除排序",
        phase: "later",
      },
      {
        id: "T08-04",
        label: "显示列 › 各可选列",
        phase: "later",
      },
      {
        id: "T08-05",
        label: "重置列宽",
        phase: "later",
      },
      {
        id: "T08-06",
        label: "重置表格布局",
        phase: "later",
      },
    ],
  },
  U01: {
    title: "命令行内容区域",
    items: [
      {
        id: "U01-01",
        label: "复制所选文本",
        phase: "initial",
      },
      {
        id: "U01-02",
        label: "粘贴",
        phase: "initial",
      },
      {
        id: "U01-03",
        label: "全选",
        phase: "initial",
      },
      {
        id: "U01-04",
        label: "清空显示",
        phase: "initial",
      },
    ],
  },
  U02: {
    title: "单条日志",
    items: [
      {
        id: "U02-01",
        label: "复制消息",
        phase: "initial",
      },
      {
        id: "U02-02",
        label: "复制详细信息",
        phase: "initial",
      },
      {
        id: "U02-03",
        label: "按此操作筛选",
        phase: "later",
      },
      {
        id: "U02-04",
        label: "导出此操作日志…",
        phase: "later",
      },
    ],
  },
  U03: {
    title: "多条日志",
    items: [
      {
        id: "U03-01",
        label: "复制所选日志",
        phase: "initial",
      },
      {
        id: "U03-02",
        label: "导出所选日志…",
        phase: "later",
      },
    ],
  },
  U04: {
    title: "日志空白处",
    items: [
      {
        id: "U04-01",
        label: "刷新",
        phase: "initial",
      },
      {
        id: "U04-02",
        label: "全选当前筛选结果",
        phase: "initial",
      },
      {
        id: "U04-03",
        label: "清除选择",
        phase: "initial",
      },
      {
        id: "U04-04",
        label: "清空显示",
        phase: "initial",
      },
      {
        id: "U04-05",
        label: "导出当前筛选日志…",
        phase: "later",
      },
    ],
  },
  U05: {
    title: "单个执行中/排队任务",
    items: [
      {
        id: "U05-01",
        label: "查看任务详情",
        phase: "later",
      },
      {
        id: "U05-02",
        label: "查看相关日志",
        phase: "later",
      },
      {
        id: "U05-03",
        label: "复制任务 ID",
        phase: "later",
      },
      {
        id: "U05-04",
        label: "取消此任务",
        phase: "later",
      },
    ],
  },
  U06: {
    title: "多任务聚合进度条",
    items: [
      {
        id: "U06-01",
        label: "打开日志栏",
        phase: "initial",
      },
      {
        id: "U06-02",
        label: "查看任务列表",
        phase: "later",
      },
    ],
  },
  U07: {
    title: "输入框：地址、搜索、设置、描述",
    items: [
      {
        id: "U07-01",
        label: "保留系统/浏览器原生文本编辑菜单",
        phase: "initial",
      },
    ],
  },
  U08: {
    title: "磁盘状态、装饰区域、原生窗口按钮",
    items: [],
  },
} as const;
export type MenuObjectId = keyof typeof menuCatalog;
