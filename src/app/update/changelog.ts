/**
 * In-app release history shown by Settings -> Updates -> "View changelog".
 *
 * Every release carries the same bullets in Chinese and English, because the
 * dialog follows the application locale. The notes are the user-facing summary;
 * the fuller release notes published with each GitHub release live in
 * `artifacts/release-notes-<version>.md` and are validated by
 * `scripts/validate-release-notes.mjs`. Newest release goes first in this list;
 * the dialog sorts defensively anyway so a mis-ordered edit cannot show an older
 * version above a newer one.
 *
 * Keep the two languages in step: `scripts/validate-changelog.mjs` fails when a
 * release is missing either language, and the notes are plain text (no markup)
 * because the dialog renders one bullet per line.
 */
export interface ChangelogNotes {
  /** Bullets shown when the application locale is Chinese. */
  zh: readonly string[];
  /** Bullets shown when the application locale is English. */
  en: readonly string[];
}

export interface ChangelogRelease {
  /** Semantic version without the leading `v` (e.g. "0.1.12"). */
  version: string;
  /** ISO date (YYYY-MM-DD) of the release, when known. */
  date?: string;
  /** One bullet per user-visible change, in both supported languages. */
  notes: ChangelogNotes;
}

const isChineseLocale = (locale: string) =>
  locale.toLowerCase().startsWith("zh");

/**
 * The bullets to render for one locale. A release that still misses one
 * language falls back to the other instead of showing an empty block, so an
 * incomplete translation never blanks the dialog.
 */
export function notesFor(
  release: ChangelogRelease,
  locale: string,
): readonly string[] {
  const primary = isChineseLocale(locale) ? release.notes.zh : release.notes.en;
  if (primary.length > 0) return primary;
  return isChineseLocale(locale) ? release.notes.en : release.notes.zh;
}

export const CHANGELOG: readonly ChangelogRelease[] = [
  {
    version: "0.1.12",
    date: "2026-11-07",
    notes: {
      zh: [
        "搜索页：结果类别从 7 类收敛为 6 类（移除 Job），改为点搜索或回车才查询，输入时不再自动触发",
        "搜索页去掉「搜索内容 / 搜索类别」标题与分割线，上下排列更紧凑；结果区铺满可用高度",
        "搜索页移除顶部信息条与模拟 / 实时徽标",
        "修复页面标题与活动栏显示本地化 key（例如 shell.search）而不是译文的问题",
        "工作区切换失败后自动重同步运行时状态，界面不再停留在旧工作区",
        "主机侧确认票据清理改为异步等待，不再阻塞异步运行时线程",
        "终端命令的 operationId 回显契约钉住；取消按钮连点只发一次取消",
        "桌面图标与标题栏品牌标更新为新的 P4 标识",
        "内部重构：9 个页面迁移到统一操作会话模型；样式收敛与字号 / 颜色 token 化；新增 IPC 接口面静态校验与分页 / 取消回归测试",
      ],
      en: [
        "Search: result categories reduced from seven to six (Job removed); queries run only on Search or Enter instead of on every keystroke",
        "Search: removed the Search content / Search categories heading and its divider, tightened the vertical layout, and let the results fill the available height",
        "Search: removed the top info strip and the simulated / live badges",
        "Fixed page titles and the activity bar showing localization keys (for example shell.search) instead of translated text",
        "Resynchronizes the runtime state after a failed workspace switch, so the UI no longer stays on the old workspace",
        "Host-side confirmation ticket cleanup now waits asynchronously instead of blocking an async runtime thread",
        "Pinned the terminal command's operationId echo contract; repeated clicks on Cancel now send one cancellation",
        "Desktop icon and titlebar brand mark updated to the new P4 identity",
        "Internal refactor: nine pages moved to the shared operation-session model; style consolidation with tokenized type scale and colors; added a static IPC surface check plus paging and cancellation regression tests",
      ],
    },
  },
  {
    version: "0.1.11",
    date: "2026-11-04",
    notes: {
      zh: [
        "文件预览支持 CSV/TSV 与 XLSX/XLSM 表格：可拖列宽、粘性表头、自定义冻结表头行数、表格右键菜单；中文 GBK 编码与多工作表切换；超大文件截断并提示原因",
        "CL 详情支持待提交 / 搁置 CL：显示真实状态徽标、只列 shelved 文件，并可「Unshelve 到新 CL…」",
        "Resolve 支持重新解决：已解决（未提交）文件显示「已解决」，可用 p4 resolve -f 基于上次结果再解",
        "Diff 默认折叠未改动上下文，同时保留每个改动块 3 行上下文；可一键「展开全部」",
        "获取最新改为「先预览再执行」：默认先跑 p4 sync -n，受影响文件超过阈值（设置里可调，默认 100）才弹确认对话框",
        "工具栏操作超时后自动解除忙碌并提示「结果未知，请刷新核对」，不再永久卡死",
        "修复待提交 CL「还原全部」后列表不刷新",
        "同步失败会显示真实 P4 原因（含 p4 where 预检），不再静默报成功",
        "操作日志超长时保留头尾，P4 报错末行不再被截断",
        "本地已修改文件允许签出 / Diff / 历史，获取最新时提示先签出或还原",
      ],
      en: [
        "File preview supports CSV/TSV and XLSX/XLSM tables: draggable column widths, sticky header, configurable frozen header rows, table context menu; GBK encoding and multi-sheet switching; oversized files truncate with the reason shown",
        "Changelist details now cover pending and shelved changelists: real status badges, shelved-only file lists, and an Unshelve to new CL action",
        "Resolve can re-resolve: already-resolved (unsubmitted) files show as resolved and can be re-resolved from the previous result with p4 resolve -f",
        "Diff folds unchanged context by default while keeping three context lines per hunk, with a one-click Expand all",
        "Get Latest now previews first: it runs p4 sync -n and only asks for confirmation when the affected file count exceeds the configurable threshold (default 100)",
        "A timed-out toolbar operation now clears the busy state and reports that the result is unknown, asking to refresh and verify, instead of hanging forever",
        "Fixed the pending changelist list not refreshing after Revert all",
        "A failed sync shows the real P4 reason (including the p4 where preflight) instead of silently reporting success",
        "Very long operation logs keep the head and tail, so the last line of a P4 error is no longer cut off",
        "Locally modified files can be checked out, diffed and have their history opened; Get Latest suggests checking out or reverting first",
      ],
    },
  },
  {
    version: "0.1.10",
    date: "2026-11-01",
    notes: {
      zh: [
        "Resolve 对话框重做：Base / 来源 / 目标 / 合并卡片，P4 原生 Diff chunks 统计，冲突块与自动合并判断，P4Merge 外部合并",
        "Diff / 合并工具与文件列表相关交互更新",
      ],
      en: [
        "Resolve dialog rebuilt: Base / source / target / merged cards, P4-native diff chunk statistics, conflict-block and auto-merge detection, and external merging with P4Merge",
        "Diff / merge tool and file-list interaction updates",
      ],
    },
  },
  {
    version: "0.1.9",
    date: "2026-10-30",
    notes: {
      zh: [
        "标签页 session：首次启动只自动打开「待提交」，之后恢复上次关闭前的标签页与激活页",
        "设置改版：单列布局 + 模块折叠 + 侧边导航；背景色可选并带动标题栏 / 工具栏 / 侧栏 / 状态栏同色系层次",
        "标题栏显示版本号",
        "P4 可执行文件 / 自定义提交工具支持文件选择按钮",
        "CL 详情文件表复用可拖列宽表格 + 独立文件名称列",
        "日志：被取消的操作显示「已取消」，不再误报 error",
        "修复 Submitted 时间筛选早 8 小时",
      ],
      en: [
        "Tab sessions: a fresh start opens Pending only; afterwards the tabs and active page from the last close are restored",
        "Settings redesign: single column with collapsible modules and side navigation; the optional background color drives matching shades across titlebar, toolbar, sidebar and status bar",
        "Titlebar shows the version number",
        "File pickers for the P4 executable and the custom submit tool",
        "Changelist detail files reuse the resizable table with a dedicated file-name column",
        "Logs: cancelled operations show as cancelled instead of a false error",
        "Fixed the Submitted time filter being eight hours early",
      ],
    },
  },
  {
    version: "0.1.8",
    notes: {
      zh: [
        "快捷键系统：P4V 键位映射、命令面板、设置里可改键 + 冲突检测 + 重启生效",
        "设置支持自定义背景色（深浅主题下保持可读）",
        "文件状态图标颜色语义统一，正常 checkout 显示绿色",
        "修复已解决冲突的 CL 被「未确认移动」永久阻止提交",
        "更新校验失败时的提示文案改为中性说明，不再误报为安装阶段失败",
      ],
      en: [
        "Keyboard shortcuts: P4V key map, command palette, rebindable in Settings with conflict detection, applied on restart",
        "Custom background color in Settings, readable in both light and dark themes",
        "Unified file-state icon colors; a normal checkout is green",
        "Fixed a changelist with resolved conflicts being permanently blocked by an unconfirmed move",
        "Update verification failures now use neutral wording instead of claiming the install stage failed",
      ],
    },
  },
  {
    version: "0.1.7",
    notes: {
      zh: [
        "首个自动更新版本：标题栏「有新版本」提示 → 下载 → 确认安装并重启（此版本需要手动安装一次）",
        "连接设置引导页可拖动、补窗口控件",
        "CL 描述 UTF-8 字符集",
        "自定义提交支持不同 CL 并发（同一 CL 独占）",
        "操作失败统一 toast",
      ],
      en: [
        "First auto-update release: titlebar update-available prompt, download, then confirm install and restart (this version still needs one manual install)",
        "Draggable connection-setup guide with window controls",
        "Changelist descriptions use UTF-8",
        "Custom submit allows different changelists concurrently (the same changelist stays exclusive)",
        "A uniform toast for failed operations",
      ],
    },
  },
];

function parts(version: string): number[] {
  return version
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

/** Newest semantic version first, regardless of the source array's order. */
export function releasesNewestFirst(
  releases: readonly ChangelogRelease[] = CHANGELOG,
): ChangelogRelease[] {
  return [...releases].sort((left, right) => {
    const a = parts(left.version);
    const b = parts(right.version);
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
      const difference = (b[index] ?? 0) - (a[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  });
}
