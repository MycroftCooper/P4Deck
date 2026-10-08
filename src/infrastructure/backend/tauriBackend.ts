import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { OperationEvent } from "../../shared/contracts/types";
import type { Backend } from "./contract";

export const tauriBackend: Backend = {
  statusCacheDiagnostics: () => invoke("status_cache_diagnostics"),
  queryOperationJournal: (query) =>
    invoke("query_operation_journal", { query }),
  getOperationRecord: (operationId) =>
    invoke("get_operation_record", { operationId }),
  queryLogPage: (query) => invoke("query_log_page", { query }),
  getLogPolicy: () => invoke("get_log_policy"),
  setLogPolicy: (policy) => invoke("set_log_policy", { policy }),
  exportDiagnostics: (request) => invoke("export_diagnostics", { request }),
  workspaceDiskUsage: () => invoke("workspace_disk_usage"),
  discoverP4Cli: (request) => invoke("discover_p4_cli", { request }),
  testConnection: (context) => invoke("test_connection", { context }),
  queryLoginStatus: (context) => invoke("query_login_status", { context }),
  trustServer: (request) => invoke("trust_server", { request }),
  login: (request) => invoke("login", { request }),
  logout: (request) => invoke("logout", { request }),
  listStreams: () => invoke("list_streams"),
  listUserWorkspaces: () => invoke("list_user_workspaces"),
  saveConnection: (context) => invoke("save_connection", { context }),
  runtimeInfo: () => invoke("runtime_info"),
  runP4: (request) => invoke("run_p4", { request }),
  cancelOperation: (operationId) => invoke("cancel_operation", { operationId }),
  queryChangelists: (query) => invoke("query_changelists", { query }),
  performClAction: (action) => invoke("perform_cl_action", { action }),
  queryLogs: (query) => invoke("query_logs", { query }),
  subscribeOperationEvents: (callback) =>
    listen<OperationEvent>("operation-event", (event) =>
      callback(event.payload),
    ),
  listWorkspaceChildren: (path) => invoke("list_workspace_children", { path }),
  listDepotChildren: (path) => invoke("list_depot_children", { path }),
  resolvePath: (request) => invoke("resolve_path", { request }),
  openLocalPath: (request) => invoke("open_local_path", { request }),
  localPathCapabilities: (path) => invoke("local_path_capabilities", { path }),
  performFileAction: (request) => invoke("perform_file_action", { request }),
  getFilePreview: (path) => invoke("get_file_preview", { path }),
  getDiff: (path) => invoke("get_diff", { path }),
  getFileHistory: (path) => invoke("get_file_history", { path }),
  getRevisionGraph: (path) => invoke("get_revision_graph", { path }),
  queryPendingChanges: () => invoke("query_pending_changes"),
  mutatePendingChange: (request) =>
    invoke("mutate_pending_change", { request }),
  preflightSubmit: (request) => invoke("preflight_submit", { request }),
  confirmSubmit: (confirmation) => invoke("confirm_submit", { confirmation }),
};
