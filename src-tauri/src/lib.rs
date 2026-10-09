mod app;
mod domain;
mod ipc;
mod p4;
mod persistence;

#[cfg(feature = "backend-perf")]
pub mod backend_perf;

#[cfg(test)]
mod e2e;

use app::changelist_service::ChangelistService;
use app::connection_service::ConnectionService;
use app::diagnostics::DiagnosticService;
use app::file_service::FileService;
use app::rename_service::RenameService;
use app::search_service::GlobalSearchService;
use app::status_cache::{shared_default, StatusCache};
use app::submit_service::SubmitService;
use app::sync_service::SyncService;
use app::workflow_service::WorkflowService;
use p4::context::ContextStore;
use p4::{
    changelists::ChangelistRepository, rename::RenameRepository, runner::P4Runner,
    submit::SubmitRepository, workflows::WorkflowRepository,
};
use persistence::{log_store::LogStore, operation_journal::OperationJournal};
use std::sync::Arc;
use tauri::Manager;

pub(crate) struct AppState {
    pub runner: Arc<P4Runner>,
    pub logs: Arc<LogStore>,
    pub changelists: Arc<ChangelistService>,
    pub submit: Arc<SubmitService>,
    pub sync: Arc<SyncService>,
    pub workflows: Arc<WorkflowService>,
    pub files: Arc<FileService>,
    pub rename: Arc<RenameService>,
    pub connection: Arc<ConnectionService>,
    pub status_cache: Arc<StatusCache>,
    pub journal: Arc<OperationJournal>,
    pub diagnostics: Arc<DiagnosticService>,
    pub search: Arc<GlobalSearchService>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let contexts = Arc::new(
                ContextStore::load(&data_dir)
                    .map_err(|error| std::io::Error::other(error.to_string()))?,
            );
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
                contexts.clone(),
            ));
            let submit = Arc::new(SubmitService::new(
                SubmitRepository::new(runner.clone()),
                contexts.clone(),
                status_cache.clone(),
            ));
            let sync = Arc::new(SyncService::new(
                runner.clone(),
                contexts.clone(),
                status_cache.clone(),
            ));
            let workflows = Arc::new(WorkflowService::new(
                WorkflowRepository::new(runner.clone()),
                contexts.clone(),
                status_cache.clone(),
            ));
            let files = Arc::new(FileService::new(
                runner.clone(),
                status_cache.clone(),
                journal.clone(),
                contexts.clone(),
            ));
            let rename = Arc::new(RenameService::new(
                RenameRepository::new(runner.clone()),
                contexts.clone(),
                status_cache.clone(),
            ));
            let search = Arc::new(GlobalSearchService::new(
                runner.clone(),
                changelists.clone(),
                contexts,
            ));
            app.manage(AppState {
                runner,
                logs,
                changelists,
                submit,
                sync,
                workflows,
                files,
                rename,
                connection,
                status_cache,
                journal,
                diagnostics,
                search,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::commands::workspace_disk_usage,
            ipc::commands::list_user_workspaces,
            ipc::commands::list_streams,
            ipc::commands::open_panel_window,
            ipc::commands::runtime_info,
            ipc::commands::list_connection_profiles,
            ipc::commands::get_active_connection_profile,
            ipc::commands::create_connection_profile,
            ipc::commands::update_connection_profile,
            ipc::commands::delete_connection_profile,
            ipc::commands::set_active_connection_profile,
            ipc::commands::switch_workspace,
            ipc::commands::save_connection,
            ipc::commands::discover_p4_cli,
            ipc::commands::test_connection,
            ipc::commands::query_login_status,
            ipc::commands::trust_server,
            ipc::commands::login,
            ipc::commands::logout,
            ipc::commands::run_p4,
            ipc::commands::cancel_operation,
            ipc::commands::global_search,
            ipc::commands::query_logs,
            ipc::commands::query_log_page,
            ipc::commands::get_log_policy,
            ipc::commands::set_log_policy,
            ipc::commands::export_diagnostics,
            ipc::commands::status_cache_diagnostics,
            ipc::commands::query_operation_journal,
            ipc::commands::get_operation_record,
            ipc::commands::query_changelists,
            ipc::commands::get_submitted_change_detail,
            ipc::commands::perform_cl_action,
            ipc::commands::list_workspace_children,
            ipc::commands::list_depot_children,
            ipc::commands::resolve_path,
            ipc::commands::open_local_path,
            ipc::commands::local_path_capabilities,
            ipc::commands::perform_file_action,
            ipc::commands::preflight_rename_move,
            ipc::commands::confirm_rename_move,
            ipc::commands::preview_sync,
            ipc::commands::confirm_sync,
            ipc::commands::get_diff,
            ipc::commands::get_file_preview,
            ipc::commands::get_file_history,
            ipc::commands::get_revision_graph,
            ipc::commands::query_pending_changes,
            ipc::commands::mutate_pending_change,
            ipc::commands::preflight_submit,
            ipc::commands::confirm_submit,
            ipc::commands::preflight_shelf,
            ipc::commands::confirm_shelf,
            ipc::commands::preflight_unshelve,
            ipc::commands::confirm_unshelve,
            ipc::commands::preflight_resolve,
            ipc::commands::confirm_resolve
        ])
        .run(tauri::generate_context!())
        .expect("error while running P4Deck");
}
