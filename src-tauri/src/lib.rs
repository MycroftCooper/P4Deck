mod app;
mod close_guard;
mod domain;
mod ipc;
mod p4;
mod persistence;
mod security;
mod window_placement;

#[cfg(feature = "backend-perf")]
pub mod backend_perf;

#[cfg(test)]
mod e2e;

use app::branch_mapping_service::BranchMappingService;
use app::changelist_service::ChangelistService;
use app::connection_service::ConnectionService;
use app::connection_setup_service::ConnectionSetupService;
use app::diagnostics::DiagnosticService;
use app::file_lock_service::FileLockService;
use app::file_service::FileService;
use app::rename_service::RenameService;
use app::search_service::GlobalSearchService;
use app::status_cache::{shared_default, StatusCache};
use app::stream_graph_service::StreamGraphService;
use app::stream_switch_service::StreamSwitchService;
use app::submit_service::SubmitService;
use app::sync_service::SyncService;
use app::undo_service::UndoService;
use app::vfs_service::VfsService;
use app::workflow_service::WorkflowService;
use p4::context::ContextStore;
use p4::{
    changelists::ChangelistRepository, locks::LockRepository, rename::RenameRepository,
    runner::P4Runner, submit::SubmitRepository, vfs::P4VfsRepository,
    workflows::WorkflowRepository,
};
use persistence::{
    backup::ConfigBackupService, log_store::LogStore, operation_journal::OperationJournal,
};
use std::sync::Arc;
use tauri::Manager;

pub(crate) struct AppState {
    pub selected_submit: app::selected_submit::Host,
    pub custom_submit: Arc<app::custom_submit::Host>,
    pub runner: Arc<P4Runner>,
    pub logs: Arc<LogStore>,
    pub changelists: Arc<ChangelistService>,
    pub submit: Arc<SubmitService>,
    pub sync: Arc<SyncService>,
    pub undo: Arc<UndoService>,
    pub workflows: Arc<WorkflowService>,
    pub files: Arc<FileService>,
    pub file_locks: Arc<FileLockService>,
    pub rename: Arc<RenameService>,
    pub connection: Arc<ConnectionService>,
    pub connection_setup: Arc<ConnectionSetupService>,
    pub status_cache: Arc<StatusCache>,
    pub journal: Arc<OperationJournal>,
    pub diagnostics: Arc<DiagnosticService>,
    pub backups: Arc<ConfigBackupService>,
    pub search: Arc<GlobalSearchService>,
    pub stream_graph: Arc<StreamGraphService>,
    pub branch_mappings: Arc<BranchMappingService>,
    pub stream_switch: Arc<StreamSwitchService>,
    pub vfs: Arc<VfsService>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let application = tauri::Builder::default()
        .manage(close_guard::CloseGuard::default())
        .on_page_load(|webview, event| {
            close_guard::page_load(webview, event);
        })
        .on_window_event(|window, event| {
            close_guard::window_event(window, event);
        })
        .plugin(tauri_plugin_clipboard_manager::init())
        // Auto-update (GitHub Releases) + relaunch after a staged install.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Native file picker for the P4 executable / custom submit tool settings.
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let backups = Arc::new(ConfigBackupService::new(data_dir.clone()));
            // A staged restore must be applied before the connection store is loaded.
            let _ = backups.apply_pending();
            let contexts = Arc::new(
                ContextStore::load(&data_dir)
                    .map_err(|error| std::io::Error::other(error.to_string()))?,
            );
            let logs = Arc::new(
                LogStore::open(&data_dir.join("p4deck.sqlite")).map_err(std::io::Error::other)?,
            );
            let journal = Arc::new(
                OperationJournal::open(&data_dir.join("operations.sqlite"))
                    .map_err(std::io::Error::other)?,
            );
            journal.attach_events(app.handle().clone());
            let runner = Arc::new(P4Runner::try_new(logs.clone(), journal.clone())?);
            let observer = Arc::new(crate::p4::server_status::Observer::new(
                contexts.clone(),
                app.handle().clone(),
            ));
            runner.attach_status(observer);
            let connection_setup_repository =
                p4::connection_setup::ConnectionSetupRepository::new(runner.clone());
            let connection = Arc::new(ConnectionService::new(
                contexts.clone(),
                connection_setup_repository.clone(),
                logs.clone(),
                journal.clone(),
            ));
            let connection_setup =
                Arc::new(ConnectionSetupService::new(connection_setup_repository));
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
            let undo = Arc::new(UndoService::new(
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
            let file_locks = Arc::new(FileLockService::new(
                LockRepository::new(runner.clone()),
                contexts.clone(),
                status_cache.clone(),
            ));
            let search = Arc::new(GlobalSearchService::new(
                runner.clone(),
                changelists.clone(),
                contexts.clone(),
            ));
            let stream_graph = Arc::new(StreamGraphService::new(runner.clone(), contexts.clone()));
            let branch_mappings =
                Arc::new(BranchMappingService::new(runner.clone(), contexts.clone()));
            let vfs = Arc::new(VfsService::new(
                P4VfsRepository::new(runner.clone()),
                contexts.clone(),
            ));
            let stream_switch = Arc::new(StreamSwitchService::new(runner.clone(), contexts));
            app.manage(AppState {
                selected_submit: app::selected_submit::Host::open(
                    &data_dir.join("selected-submit.sqlite"),
                )
                .map_err(std::io::Error::other)?,
                custom_submit: Arc::new(app::custom_submit::Host::default()),
                runner,
                logs,
                changelists,
                submit,
                sync,
                undo,
                workflows,
                files,
                file_locks,
                rename,
                connection,
                connection_setup,
                status_cache,
                journal,
                diagnostics,
                backups,
                search,
                stream_graph,
                branch_mappings,
                stream_switch,
                vfs,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::commands::selected_submit_prepare,
            ipc::commands::selected_move_execute,
            ipc::commands::selected_move_status,
            ipc::commands::selected_move_lookup,
            ipc::commands::selected_move_reconcile,
            ipc::commands::action_write_fences,
            ipc::commands::action_release_unknown,
            ipc::commands::selected_submit_status,
            ipc::commands::selected_submit_claim,
            ipc::commands::company_submit_connection_snapshot,
            ipc::commands::custom_submit_start,
            ipc::commands::custom_submit_status,
            close_guard::close_guard_register,
            close_guard::close_guard_report,
            close_guard::close_guard_request,
            ipc::commands::workspace_disk_usage,
            ipc::commands::list_user_workspaces,
            ipc::commands::browse_connection_users,
            ipc::commands::browse_connection_workspaces,
            ipc::commands::preflight_create_connection_user,
            ipc::commands::preflight_create_connection_workspace,
            ipc::commands::confirm_create_connection_user,
            ipc::commands::confirm_create_connection_workspace,
            ipc::commands::list_streams,
            ipc::commands::query_stream_graph,
            ipc::commands::query_branch_mappings,
            ipc::commands::get_branch_mapping_detail,
            ipc::commands::preview_branch_mapping_impact,
            ipc::commands::preflight_branch_mapping_mutation,
            ipc::commands::confirm_branch_mapping_mutation,
            ipc::commands::preflight_stream_switch,
            ipc::commands::confirm_stream_switch,
            ipc::commands::open_panel_window,
            ipc::commands::runtime_info,
            ipc::commands::list_connection_profiles,
            ipc::commands::get_active_connection_profile,
            ipc::commands::create_connection_profile,
            ipc::commands::update_connection_profile,
            ipc::commands::delete_connection_profile,
            ipc::commands::set_active_connection_profile,
            ipc::commands::switch_workspace,
            ipc::commands::preflight_workspace_mutation,
            ipc::commands::confirm_workspace_mutation,
            ipc::commands::save_connection,
            ipc::commands::discover_p4_cli,
            ipc::commands::test_connection,
            ipc::commands::query_login_status,
            ipc::commands::trust_server,
            ipc::commands::login,
            ipc::commands::logout,
            ipc::commands::run_p4,
            ipc::commands::cancel_operation,
            ipc::commands::cancel_all_operations,
            ipc::commands::global_search,
            ipc::commands::query_logs,
            ipc::commands::record_frontend_operation_log,
            ipc::commands::query_log_page,
            ipc::commands::get_log_policy,
            ipc::commands::set_log_policy,
            ipc::commands::open_logs_folder,
            ipc::commands::delete_all_logs,
            ipc::commands::export_diagnostics,
            ipc::commands::create_config_backup,
            ipc::commands::list_config_backups,
            ipc::commands::restore_config_backup,
            ipc::commands::open_config_backups_folder,
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
            ipc::commands::open_swarm_link,
            ipc::commands::open_external_url,
            ipc::commands::local_path_capabilities,
            ipc::commands::perform_file_action,
            ipc::commands::confirm_revert_action,
            ipc::commands::preflight_rename_move,
            ipc::commands::confirm_rename_move,
            ipc::commands::preflight_file_lock,
            ipc::commands::confirm_file_lock,
            ipc::commands::inspect_p4vfs,
            ipc::commands::preview_undo,
            ipc::commands::confirm_undo,
            ipc::commands::preview_sync,
            ipc::commands::sync_latest,
            ipc::commands::confirm_sync,
            ipc::commands::get_diff,
            ipc::commands::get_shelf_file_preview,
            ipc::commands::get_file_preview,
            ipc::commands::get_file_history,
            ipc::commands::get_revision_graph,
            ipc::commands::get_integration_trace,
            ipc::commands::query_pending_changes,
            ipc::commands::mutate_pending_change,
            ipc::commands::get_shelf_detail,
            ipc::commands::preflight_move_files,
            ipc::commands::confirm_move_files,
            ipc::commands::preflight_submit,
            ipc::commands::confirm_submit,
            ipc::commands::preflight_shelf,
            ipc::commands::confirm_shelf,
            ipc::commands::delete_shelved_revisions,
            ipc::commands::shelve_files,
            ipc::commands::workflow_action_lookup,
            ipc::commands::unshelve_files,
            ipc::commands::preflight_unshelve,
            ipc::commands::confirm_unshelve,
            ipc::commands::preflight_resolve,
            ipc::commands::resolve_stats,
            ipc::commands::confirm_resolve,
            ipc::commands::open_manual_merge,
            ipc::commands::validate_manual_merge,
            ipc::commands::confirm_manual_merge_save,
            ipc::commands::confirm_manual_merge_resolve,
            ipc::commands::detect_external_merge_tool,
            ipc::commands::run_external_merge,
            ipc::commands::get_server_status,
            ipc::commands::check_server_status,
        ])
        .build(tauri::generate_context!());
    if let Some(app) = close_guard::initialized(application, close_guard::initialization_failure) {
        app.run(close_guard::run_event);
    }
}
