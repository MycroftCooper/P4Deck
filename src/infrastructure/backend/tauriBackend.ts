import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  DiagnosticAlert,
  OperationEvent,
} from "../../shared/contracts/types";
import type { Backend } from "./contract";

export const tauriBackend: Backend = {
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
  setLogPolicy: (policy) => invoke("set_log_policy", { policy }),
  openLogsFolder: () => invoke("open_logs_folder"),
  deleteAllLogs: () => invoke("delete_all_logs"),
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
  cancelOperation: (operationId) => invoke("cancel_operation", { operationId }),
  cancelAllOperations: () => invoke("cancel_all_operations"),
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
  performFileAction: (request) => invoke("perform_file_action", { request }),
  preflightFileLock: (request) => invoke("preflight_file_lock", { request }),
  confirmFileLock: (confirmation) =>
    invoke("confirm_file_lock", { confirmation }),
  preflightRenameMove: (request) =>
    invoke("preflight_rename_move", { request }),
  confirmRenameMove: (confirmation) =>
    invoke("confirm_rename_move", { confirmation }),
  previewUndo: (request) => invoke("preview_undo", { request }),
  confirmUndo: (confirmation) => invoke("confirm_undo", { confirmation }),
  previewSync: (request) => invoke("preview_sync", { request }),
  confirmSync: (confirmation) => invoke("confirm_sync", { confirmation }),
  getFilePreview: (path) => invoke("get_file_preview", { path }),
  getDiff: (request) => invoke("get_diff", { request }),
  getFileHistory: (request) => invoke("get_file_history", { request }),
  getRevisionGraph: (request) => invoke("get_revision_graph", { request }),
  queryPendingChanges: (query) => invoke("query_pending_changes", { query }),
  mutatePendingChange: (request) =>
    invoke("mutate_pending_change", { request }),
  preflightSubmit: (request) => invoke("preflight_submit", { request }),
  confirmSubmit: (confirmation) => invoke("confirm_submit", { confirmation }),
  preflightShelf: (request) => invoke("preflight_shelf", { request }),
  confirmShelf: (confirmation) => invoke("confirm_shelf", { confirmation }),
  getShelfDetail: (request) => invoke("get_shelf_detail", { request }),
  getShelfFilePreview: (request) =>
    invoke("get_shelf_file_preview", { request }),
  preflightMoveFiles: (request) => invoke("preflight_move_files", { request }),
  confirmMoveFiles: (confirmation) =>
    invoke("confirm_move_files", { confirmation }),
  preflightUnshelve: (request) => invoke("preflight_unshelve", { request }),
  confirmUnshelve: (confirmation) =>
    invoke("confirm_unshelve", { confirmation }),
  preflightResolve: (request) => invoke("preflight_resolve", { request }),
  confirmResolve: (confirmation) => invoke("confirm_resolve", { confirmation }),
  openManualMerge: (request) => invoke("open_manual_merge", { request }),
  validateManualMerge: (request) =>
    invoke("validate_manual_merge", { request }),
  confirmManualMergeSave: (confirmation) =>
    invoke("confirm_manual_merge_save", { confirmation }),
  confirmManualMergeResolve: (confirmation) =>
    invoke("confirm_manual_merge_resolve", { confirmation }),
};
