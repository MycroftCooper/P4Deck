/**
 * English catalog.
 *
 * Typed as Record<MsgKey, string> against the Chinese catalog, so a key that
 * exists in zh-CN but is missing here is a compile-time error.
 */
import type { Catalog } from "./types";
import type { MsgKey } from "./catalog.zh";

export const en: Catalog & Record<MsgKey, string> = {
  // ---- common -----------------------------------------------------------
  "common.app": "P4Deck",
  "common.refresh": "Refresh",
  "common.close": "Close",
  "common.cancel": "Cancel",
  "common.retry": "Retry",
  "common.delete": "Delete",
  "common.move": "Move files",
  "common.shelve": "Shelve",
  "common.unshelve": "Unshelve",
  "common.submit": "Submit",
  "common.checkout": "Checkout",
  "common.add": "Add",
  "common.revert": "Revert",
  "common.diff": "Diff",
  "common.run": "Run",
  "common.clear": "Clear",
  "common.more": "More actions",
  "common.hidden": "Hidden",
  "common.warning": "Warning",
  "common.error": "Error",
  "common.info": "Info",

  // ---- navigation / pages ------------------------------------------------
  "nav.changes": "Workspace",
  "nav.changelists": "Changelists",
  "nav.depot": "Depot",
  "nav.history": "History",
  "nav.streams": "Streams",
  "nav.terminal": "Terminal",
  "nav.logs": "Log",
  "nav.openTools": "Open tools",
  "page.files": "Files",
  "page.pending": "Pending",
  "page.submitted": "Submitted",
  "page.streams": "Streams",

  // ---- theme / appearance ------------------------------------------------
  "theme.light": "Light",
  "theme.dark": "Dark",
  "theme.system": "System",
  "locale.switch": "切换到中文",

  // ---- changelists -------------------------------------------------------
  "changes.title": "Changelists",
  "changes.search": "Search ID, description, user, path, or job…",
  "changes.filters": "Filters",
  "changes.allStatuses": "All statuses",
  "changes.pending": "Pending",
  "changes.submitted": "Submitted",
  "changes.shelved": "Shelved",
  "changes.last30": "Last 30 days",
  "changes.hideMerges": "Hide reliable merges",
  "changes.empty": "No matching changelists",
  "changes.count": "{count, one: # change, other: # changes}",
  /** Bare unit word used where the number is rendered separately. */
  "changes.countUnit": "changes",
  "changes.columns.files": "Files",
  "changes.columns.user": "User",
  "changes.columns.workspace": "Workspace",
  "changes.columns.time": "Time",
  "changes.columns.status": "Status",
  "changes.columns.action": "Action",
  "changes.columns.fileType": "File type",
  "changes.columns.path": "Path",
  "changes.columns.revision": "Revision",
  "changes.columns.cl": "CL",
  "changes.columns.modified": "Modified",
  "changes.columns.localState": "Local State",

  // ---- merge classification ---------------------------------------------
  "merge.classification": "Merge classification",
  "merge.branch": "Branch merge",
  "merge.suspected": "Suspected merge",
  "merge.normal": "Normal change",
  "merge.unknown": "Classification unknown",
  "merge.inspection": "Inspection",
  "merge.inspectionComplete": "Complete",
  "merge.inspectionPartial": "Partial",
  "merge.inspectionUnavailable": "Unavailable",
  "merge.reliableHint":
    "Only explicit describe/filelog integration evidence is classified as a reliable merge.",
  "merge.suspectedHint":
    "Suspected changes stay visible and are not filtered by Hide reliable merges.",
  "merge.unknownHint":
    "Inspection was incomplete or failed, so this is not treated as normal or as a reliable merge.",

  // ---- submitted detail --------------------------------------------------
  "submitted.detailLoading": "Loading the real submitted change detail…",
  "submitted.detailError": "Could not load submitted change detail",
  "submitted.jobs": "Jobs",
  "submitted.noJobs": "No linked jobs",
  "submitted.integrationEvidence": "Integration evidence",
  "submitted.noIntegrationEvidence": "No explicit integration evidence found",
  "submitted.files": "Submitted files",
  "submitted.noFiles": "This change contains no files",

  // ---- tools -------------------------------------------------------------
  "tools.commandPlaceholder": "Enter a p4 command, e.g. opened",
  "tools.noLogs": "No log entries",
  "tools.connected": "Connected",
  "mock.badge": "Browser mock",
  "mock.detailNotice": "Mock data · no real P4 Server or network was accessed",

  // ---- files -------------------------------------------------------------
  "files.address": "Enter relative, absolute, or //depot path",
  "files.getLatest": "Get Latest",
  "files.getRevision": "Get Revision",
  "files.revGraph": "Rev Graph",
  "files.newCl": "New CL",
  "files.validateSubmit": "Validate submit",
  "files.workspaceTree": "Workspace",
  "files.depotTree": "Depot",
  "files.shelves": "Shelved Files",
  "files.openedFiles": "Opened Files",
  "files.inspector": "File Inspector",
  "files.noSelection": "Select a Workspace file first",
  "files.locateFailed": "Path is outside the current Workspace",
  "files.confirmDelete":
    "Delete selected files? Controlled files will run p4 delete.",
  "files.externalMerge": "Merge with P4Merge",
  "files.externalMergeDetecting": "Detecting P4Merge…",
  "files.externalMergeUnavailable": "P4Merge was not detected",
  "files.externalMergeRunning": "Waiting for P4Merge…",
  "files.externalMergeCompleted":
    "Read back the P4Merge result; review it before validate/save",
  "files.externalMergeUnchanged": "P4Merge did not change the result",
  "files.externalMergeCancelled":
    "P4Merge closed without saving; nothing was written to disk",
  "files.externalMergeTimeout":
    "P4Merge did not save in time; nothing was written to disk",
  "files.externalMergeFailed": "P4Merge did not complete",
  "files.externalMergeNotInstalled": "P4Merge was not detected",

  // ---- streams -----------------------------------------------------------
  "streams.soon":
    "The Stream workbench will connect real operations in a later batch.",
};
