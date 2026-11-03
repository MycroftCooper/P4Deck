import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DiagnosticAlert, OperationEvent } from "../../shared/contracts";
import type { Backend } from "./contract";

export const tauriBackend: Backend = {
  selectedMoveLookup: (request) => invoke("selected_move_lookup", { request }),
  selectedMoveExecute: (request) =>
    invoke("selected_move_execute", { request }),
  selectedMoveStatus: (request) => invoke("selected_move_status", { request }),
  selectedSubmitPrepare: (request) =>
    invoke("selected_submit_prepare", { request }),
  selectedSubmitStatus: (request) =>
    invoke("selected_submit_status", { request }),
  selectedSubmitClaim: (request) =>
    invoke("selected_submit_claim", { request }),
  customSubmitStart: (request) =>
    invoke<
      | import("../../features/companySubmit/customSubmit").CustomSubmitSession
      | import("../../features/companySubmit/customSubmitLifecycle").CustomSubmitActionResult
    >("custom_submit_start", { request }),
  customSubmitStatus: () =>
    invoke<
      | import("../../features/companySubmit/customSubmit").CustomSubmitSession
      | import("../../features/companySubmit/customSubmitLifecycle").CustomSubmitActionResult
      | null
    >("custom_submit_status"),
  companySubmitConnectionSnapshot: () =>
    invoke("company_submit_connection_snapshot"),
  preflightWorkspaceMutation: (request) =>
    invoke("preflight_workspace_mutation", { request }),
  confirmWorkspaceMutation: (token, operationId) =>
    invoke("confirm_workspace_mutation", { token, operationId }),
  createConfigBackup: (request) => invoke("create_config_backup", { request }),
  listConfigBackups: () => invoke("list_config_backups"),
  restoreConfigBackup: (request) =>
    invoke("restore_config_backup", { request }),
  openConfigBackupsFolder: () => invoke("open_config_backups_folder"),
  statusCacheDiagnostics: () => invoke("status_cache_diagnostics"),
  queryOperationJournal: (query) =>
    invoke("query_operation_journal", { query }),
  getOperationRecord: (operationId) =>
    invoke("get_operation_record", { operationId }),
  queryLogPage: (query) => invoke("query_log_page", { query }),
  getLogPolicy: () => invoke("get_log_policy"),
  setLogPolicy: (request) => invoke("set_log_policy", { request }),
  openLogsFolder: () => invoke("open_logs_folder"),
  deleteAllLogs: (request) =>
    invoke("delete_all_logs", { request: request ?? {} }),
  subscribeLogsCleared: (callback) => listen("logs-cleared", callback),
  exportDiagnostics: (request) => invoke("export_diagnostics", { request }),
  subscribeDiagnosticAlerts: (callback) =>
    listen<DiagnosticAlert>("diagnostic-alert", (event) =>
      callback(event.payload),
    ),
  workspaceDiskUsage: () => invoke("workspace_disk_usage"),
  discoverP4Cli: (request) => invoke("discover_p4_cli", { request }),
  testConnection: (context) => invoke("test_connection", { context }),
  queryLoginStatus: (context) => invoke("query_login_status", { context }),
  trustServer: (request) => invoke("trust_server", { request }),
  login: (request) => invoke("login", { request }),
  logout: (request) => invoke("logout", { request }),
  listStreams: () => invoke("list_streams"),
  queryStreamGraph: (query) => invoke("query_stream_graph", { query }),
  queryBranchMappings: (query) => invoke("query_branch_mappings", { query }),
  getBranchMappingDetail: (query) =>
    invoke("get_branch_mapping_detail", { query }),
  previewBranchMappingImpact: (query) =>
    invoke("preview_branch_mapping_impact", { query }),
  preflightBranchMappingMutation: (request) =>
    invoke("preflight_branch_mapping_mutation", { request }),
  confirmBranchMappingMutation: (confirmation) =>
    invoke("confirm_branch_mapping_mutation", { confirmation }),
  preflightStreamSwitch: (request) =>
    invoke("preflight_stream_switch", { request }),
  confirmStreamSwitch: (confirmation) =>
    invoke("confirm_stream_switch", { confirmation }),
  listUserWorkspaces: () => invoke("list_user_workspaces"),
  browseConnectionUsers: (request) =>
    invoke("browse_connection_users", { request }),
  browseConnectionWorkspaces: (request) =>
    invoke("browse_connection_workspaces", { request }),
  preflightCreateConnectionUser: (request) =>
    invoke("preflight_create_connection_user", { request }),
  preflightCreateConnectionWorkspace: (request) =>
    invoke("preflight_create_connection_workspace", { request }),
  confirmCreateConnectionUser: (confirmation) =>
    invoke("confirm_create_connection_user", { confirmation }),
  confirmCreateConnectionWorkspace: (confirmation) =>
    invoke("confirm_create_connection_workspace", { confirmation }),
  listConnectionProfiles: () => invoke("list_connection_profiles"),
  getActiveConnectionProfile: () => invoke("get_active_connection_profile"),
  createConnectionProfile: (request) =>
    invoke("create_connection_profile", { request }),
  updateConnectionProfile: (request) =>
    invoke("update_connection_profile", { request }),
  deleteConnectionProfile: (request) =>
    invoke("delete_connection_profile", { request }),
  setActiveConnectionProfile: (request) =>
    invoke("set_active_connection_profile", { request }),
  switchWorkspace: (request) => invoke("switch_workspace", { request }),
  saveConnection: (context) => invoke("save_connection", { context }),
  runtimeInfo: () => invoke("runtime_info"),
  inspectP4Vfs: (request) => invoke("inspect_p4vfs", { request }),
  runP4: (request) => invoke("run_p4", { request }),
  cancelOperation: (operationId) =>
    invoke<import("../../shared/contracts").CancelOperationResult | void>(
      "cancel_operation",
      { operationId },
    ),
  cancelAllOperations: () =>
    invoke<import("../../shared/contracts").CancelOperationResult | void>(
      "cancel_all_operations",
    ),
  globalSearch: (query) => invoke("global_search", { query }),
  queryChangelists: (query) => invoke("query_changelists", { query }),
  getSubmittedChangeDetail: (request) =>
    invoke("get_submitted_change_detail", { request }),
  performClAction: (action) => invoke("perform_cl_action", { action }),
  queryLogs: (query) => invoke("query_logs", { query }),
  subscribeOperationEvents: (callback) =>
    listen<OperationEvent>("operation-event", (event) =>
      callback(event.payload),
    ),
  listWorkspaceChildren: (path, refresh, operationId, localOnly) =>
    invoke("list_workspace_children", {
      path,
      refresh,
      operationId,
      localOnly,
    }),
  listDepotChildren: (path) => invoke("list_depot_children", { path }),
  resolvePath: (request) => invoke("resolve_path", { request }),
  openLocalPath: (request) => invoke("open_local_path", { request }),
  openSwarmLink: (request) => invoke("open_swarm_link", { request }),
  localPathCapabilities: (path) => invoke("local_path_capabilities", { path }),
  performFileAction: (request, connection) =>
    invoke("perform_file_action", {
      request,
      ...(connection ? { connection } : {}),
    }),
  preflightFileLock: (request) => invoke("preflight_file_lock", { request }),
  confirmFileLock: (confirmation) =>
    invoke("confirm_file_lock", { confirmation }),
  preflightRenameMove: (request) =>
    invoke("preflight_rename_move", { request }),
  confirmRenameMove: (confirmation) =>
    invoke<
      | import("../../shared/contracts").RenameMoveResult
      | import("../../shared/contracts").LocalIoActionResult
    >("confirm_rename_move", { confirmation }),
  previewUndo: (request) => invoke("preview_undo", { request }),
  confirmUndo: (confirmation) =>
    invoke<
      | import("../../shared/contracts").OperationResult
      | import("../../shared/contracts").LocalIoActionResult
    >("confirm_undo", { confirmation }),
  previewSync: (request) => invoke("preview_sync", { request }),
  confirmSync: (confirmation) =>
    invoke<
      | import("../../shared/contracts").SyncResult
      | import("../../shared/contracts").LocalIoActionResult
    >("confirm_sync", { confirmation }),
  syncLatest: (request) => invoke("sync_latest", { request }),
  // Explicit nulls keep Tauri's optional command parameters unambiguous.
  getFilePreview: (path, options) =>
    invoke("get_file_preview", {
      path,
      sheetIndex: options?.sheetIndex ?? null,
      offset: options?.offset ?? null,
      limit: options?.limit ?? null,
    }),
  getDiff: (request) => invoke("get_diff", { request }),
  getFileHistory: (request) => invoke("get_file_history", { request }),
  getIntegrationTrace: (request) =>
    invoke("get_integration_trace", { request }),
  getRevisionGraph: (request) => invoke("get_revision_graph", { request }),
  queryPendingChanges: (query) => invoke("query_pending_changes", { query }),
  mutatePendingChange: (request) =>
    invoke<
      | import("../../shared/contracts").PendingChangeMutationResult
      | import("../../shared/contracts").PendingClActionResult
    >("mutate_pending_change", { request }),
  preflightSubmit: (request) => invoke("preflight_submit", { request }),
  confirmSubmit: (confirmation) => invoke("confirm_submit", { confirmation }),
  preflightShelf: (request) => invoke("preflight_shelf", { request }),
  confirmShelf: (confirmation) => invoke("confirm_shelf", { confirmation }),
  deleteShelvedRevisions: (request) =>
    invoke("delete_shelved_revisions", { request }),
  shelveFiles: (request) => invoke("shelve_files", { request }),
  getShelfDetail: (request) => invoke("get_shelf_detail", { request }),
  getShelfFilePreview: (request) =>
    invoke("get_shelf_file_preview", { request }),
  preflightMoveFiles: (request) => invoke("preflight_move_files", { request }),
  confirmMoveFiles: (confirmation) =>
    invoke("confirm_move_files", { confirmation }),
  actionWriteFences: () => invoke("action_write_fences"),
  actionReleaseUnknown: (request) =>
    invoke("action_release_unknown", { request }),
  preflightUnshelve: (request) => invoke("preflight_unshelve", { request }),
  confirmUnshelve: (confirmation) =>
    invoke("confirm_unshelve", { confirmation }),
  unshelveFiles: (request) => invoke("unshelve_files", { request }),
  preflightResolve: (request) => invoke("preflight_resolve", { request }),
  confirmResolve: (confirmation) =>
    invoke<
      | import("../../shared/contracts").WorkflowResult
      | import("../../shared/contracts").MergeResolveActionResult
    >("confirm_resolve", { confirmation }),
  resolveStats: (request) => invoke("resolve_stats", { request }),
  openManualMerge: (request) =>
    invoke<
      | import("../../shared/contracts").ManualMergeSession
      | import("../../shared/contracts").MergeResolveActionResult
    >("open_manual_merge", { request }),
  validateManualMerge: (request) =>
    invoke<
      | import("../../shared/contracts").ManualMergeValidation
      | import("../../shared/contracts").MergeResolveActionResult
    >("validate_manual_merge", { request }),
  confirmManualMergeSave: (confirmation) =>
    invoke<
      | import("../../shared/contracts").ManualMergeSaveResult
      | import("../../shared/contracts").MergeResolveActionResult
    >("confirm_manual_merge_save", { confirmation }),
  confirmManualMergeResolve: (confirmation) =>
    invoke<
      | import("../../shared/contracts").WorkflowResult
      | import("../../shared/contracts").MergeResolveActionResult
    >("confirm_manual_merge_resolve", { confirmation }),
  detectExternalMergeTool: () =>
    invoke<import("../../shared/contracts").ExternalMergeToolInfo>(
      "detect_external_merge_tool",
    ),
  runExternalMerge: (request) =>
    invoke<import("../../shared/contracts").ExternalMergeResult>(
      "run_external_merge",
      { request },
    ),
};
