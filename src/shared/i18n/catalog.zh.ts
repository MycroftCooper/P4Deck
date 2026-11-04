/**
 * Chinese catalog — the single source of truth for every user-facing string.
 *
 * Rules:
 *  - Keys are grouped by owning business domain (`common`, `files`, `merge`…),
 *    never by page or component.
 *  - Values may use `{name}` placeholders and the inline plural form
 *    `{count, one: # file, other: # files}`. Prefer restructuring a sentence
 *    over concatenating two keys.
 *  - This file is the only place Chinese literals are allowed in `src/`
 *    (enforced by scripts/validate-no-cjk-literals.mjs).
 */
import type { Catalog } from "./types";

export const zh = {
  // ---- common -----------------------------------------------------------
  "common.app": "P4Deck",
  "common.refresh": "刷新",
  "common.close": "关闭",
  "common.cancel": "中断",
  "common.retry": "重试",
  "common.delete": "删除",
  "common.move": "移动文件",
  "common.shelve": "Shelve",
  "common.unshelve": "Unshelve",
  "common.submit": "提交",
  "common.checkout": "Checkout",
  "common.add": "Add",
  "common.revert": "Revert",
  "common.diff": "差异",
  "common.run": "运行",
  "common.clear": "清屏",
  "common.more": "更多操作",
  "common.hidden": "已隐藏",
  "common.warning": "警告",
  "common.error": "错误",
  "common.info": "信息",

  // ---- navigation / pages ------------------------------------------------
  "nav.changes": "工作区",
  "nav.changelists": "变更列表",
  "nav.depot": "仓库",
  "nav.history": "历史记录",
  "nav.streams": "分支流",
  "nav.terminal": "命令行",
  "nav.logs": "日志",
  "nav.openTools": "打开工具区",
  "page.files": "文件",
  "page.pending": "Pending",
  "page.submitted": "Submitted",
  "page.streams": "Streams",

  // ---- theme / appearance ------------------------------------------------
  "theme.light": "亮色",
  "theme.dark": "暗色",
  "theme.system": "跟随系统",
  "locale.switch": "Switch to English",

  // ---- changelists -------------------------------------------------------
  "changes.title": "变更列表",
  "changes.search": "搜索编号、描述、用户、路径或 Job…",
  "changes.filters": "筛选",
  "changes.allStatuses": "全部状态",
  "changes.pending": "待提交",
  "changes.submitted": "已提交",
  "changes.shelved": "已搁置",
  "changes.last30": "最近 30 天",
  "changes.hideMerges": "隐藏可靠合并",
  "changes.empty": "没有匹配的 Changelist",
  "changes.count": "{count} 条",
  /** Bare unit word used where the number is rendered separately. */
  "changes.countUnit": "条",
  "changes.columns.files": "文件",
  "changes.columns.user": "用户",
  "changes.columns.workspace": "工作区",
  "changes.columns.time": "时间",
  "changes.columns.status": "状态",
  "changes.columns.action": "动作",
  "changes.columns.fileType": "文件类型",
  "changes.columns.path": "路径",
  "changes.columns.revision": "版本",
  "changes.columns.cl": "CL",
  "changes.columns.modified": "修改时间",
  "changes.columns.localState": "本地状态",

  // ---- merge classification ---------------------------------------------
  "merge.classification": "合并分类",
  "merge.branch": "分支合并",
  "merge.suspected": "疑似合并",
  "merge.normal": "普通提交",
  "merge.unknown": "分类未知",
  "merge.inspection": "检查完整性",
  "merge.inspectionComplete": "完整",
  "merge.inspectionPartial": "部分完成",
  "merge.inspectionUnavailable": "不可用",
  "merge.reliableHint": "仅明确的 describe/filelog Integration 证据会标记为可靠合并。",
  "merge.suspectedHint": "疑似项保持可见，不会被“隐藏可靠合并”过滤。",
  "merge.unknownHint":
    "检查不完整或失败，未将此项当作普通提交或可靠合并。",

  // ---- submitted detail --------------------------------------------------
  "submitted.detailLoading": "正在加载真实提交详情…",
  "submitted.detailError": "无法加载提交详情",
  "submitted.jobs": "Jobs",
  "submitted.noJobs": "没有关联 Job",
  "submitted.integrationEvidence": "Integration 证据",
  "submitted.noIntegrationEvidence": "未发现明确的 Integration 证据",
  "submitted.files": "提交文件",
  "submitted.noFiles": "此提交没有文件",

  // ---- tools -------------------------------------------------------------
  "tools.commandPlaceholder": "输入 p4 命令，例如 opened",
  "tools.noLogs": "暂无日志",
  "tools.connected": "已连接",
  "mock.badge": "浏览器模拟",
  "mock.detailNotice": "模拟数据 · 未访问真实 P4 Server 或网络",

  // ---- files -------------------------------------------------------------
  "files.address": "输入相对路径、本地绝对路径或 //depot 路径",
  "files.getLatest": "获取最新",
  "files.getRevision": "获取版本",
  "files.revGraph": "修订图",
  "files.newCl": "新建 CL",
  "files.validateSubmit": "提交检查",
  "files.workspaceTree": "工作区",
  "files.depotTree": "Depot",
  "files.shelves": "已搁置文件",
  "files.openedFiles": "Opened Files",
  "files.inspector": "文件检查器",
  "files.noSelection": "请先在 Workspace 中选择文件",
  "files.locateFailed": "无法在当前 Workspace 定位路径",
  "files.confirmDelete": "确认删除选中的文件？受控文件将执行 p4 delete。",
  "files.externalMerge": "用 P4Merge 合并",
  "files.externalMergeDetecting": "正在检测 P4Merge…",
  "files.externalMergeUnavailable": "未检测到 P4Merge",
  "files.externalMergeRunning": "等待 P4Merge 完成…",
  "files.externalMergeCompleted": "已读回 P4Merge 结果，请复核后验证/保存",
  "files.externalMergeUnchanged": "P4Merge 未修改结果，编辑器内容保持不变",
  "files.externalMergeCancelled": "P4Merge 未保存结果即被关闭，未写入任何文件",
  "files.externalMergeTimeout": "P4Merge 超时未保存结果，未写入任何文件",
  "files.externalMergeFailed": "P4Merge 未完成",
  "files.externalMergeNotInstalled": "未检测到 P4Merge，无法启动外部合并",

  // ---- streams -----------------------------------------------------------
  "streams.soon": "Stream 工作台将在后续批次接入真实操作。",
} as const satisfies Catalog;

/** Every valid message key, derived from the Chinese catalog. */
export type MsgKey = keyof typeof zh;
