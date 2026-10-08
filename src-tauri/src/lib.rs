mod app;
mod domain;
mod ipc;
mod p4;
mod persistence;

#[cfg(test)]
mod e2e;

use app::changelist_service::ChangelistService;
use app::connection_service::ConnectionService;
use app::diagnostics::DiagnosticService;
use app::file_service::FileService;
use app::status_cache::{shared_default, StatusCache};
use app::submit_service::SubmitService;
use p4::context::ContextStore;
use p4::{changelists::ChangelistRepository, runner::P4Runner, submit::SubmitRepository};
use persistence::{log_store::LogStore, operation_journal::OperationJournal};
use std::sync::Arc;
use tauri::Manager;

pub(crate) struct AppState {
    pub runner: Arc<P4Runner>,
    pub logs: Arc<LogStore>,
    pub changelists: Arc<ChangelistService>,
    pub submit: Arc<SubmitService>,
    pub files: Arc<FileService>,
    pub connection: Arc<ConnectionService>,
    pub status_cache: Arc<StatusCache>,
    pub journal: Arc<OperationJournal>,
    pub diagnostics: Arc<DiagnosticService>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let contexts = Arc::new(ContextStore::load(&data_dir));
            let connection = Arc::new(ConnectionService::new(contexts.clone()));
            let logs = Arc::new(
                LogStore::open(&data_dir.join("p4deck.sqlite")).map_err(std::io::Error::other)?,
            );
            let journal = Arc::new(
                OperationJournal::open(&data_dir.join("operations.sqlite"))
                    .map_err(std::io::Error::other)?,
            );
            let runner = Arc::new(P4Runner::new(logs.clone(), journal.clone()));
            let diagnostics = Arc::new(DiagnosticService::new(
                data_dir.join("diagnostics"),
                logs.clone(),
                journal.clone(),
            ));
            let status_cache = shared_default();
            let changelists = Arc::new(ChangelistService::new(
                ChangelistRepository::new(runner.clone()),
                status_cache.clone(),
            ));
            let submit = Arc::new(SubmitService::new(
                SubmitRepository::new(runner.clone()),
                contexts,
                status_cache.clone(),
            ));
            let files = Arc::new(FileService::new(
                runner.clone(),
                status_cache.clone(),
                journal.clone(),
            ));
            app.manage(AppState {
                runner,
                logs,
                changelists,
                submit,
                files,
                connection,
                status_cache,
                journal,
                diagnostics,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::commands::workspace_disk_usage,
            ipc::commands::list_user_workspaces,
            ipc::commands::list_streams,
            ipc::commands::open_panel_window,
            ipc::commands::runtime_info,
            ipc::commands::save_connection,
            ipc::commands::discover_p4_cli,
            ipc::commands::test_connection,
            ipc::commands::query_login_status,
            ipc::commands::trust_server,
            ipc::commands::login,
            ipc::commands::logout,
            ipc::commands::run_p4,
            ipc::commands::cancel_operation,
            ipc::commands::query_logs,
            ipc::commands::query_log_page,
            ipc::commands::get_log_policy,
            ipc::commands::set_log_policy,
            ipc::commands::export_diagnostics,
            ipc::commands::status_cache_diagnostics,
            ipc::commands::query_operation_journal,
            ipc::commands::get_operation_record,
            ipc::commands::query_changelists,
            ipc::commands::perform_cl_action,
            ipc::commands::list_workspace_children,
            ipc::commands::list_depot_children,
            ipc::commands::resolve_path,
            ipc::commands::open_local_path,
            ipc::commands::local_path_capabilities,
            ipc::commands::perform_file_action,
            ipc::commands::get_diff,
            ipc::commands::get_file_preview,
            ipc::commands::get_file_history,
            ipc::commands::get_revision_graph,
            ipc::commands::query_pending_changes,
            ipc::commands::mutate_pending_change,
            ipc::commands::preflight_submit,
            ipc::commands::confirm_submit
        ])
        .run(tauri::generate_context!())
        .expect("error while running P4Deck");
}
