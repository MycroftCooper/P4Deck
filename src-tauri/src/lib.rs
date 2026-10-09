mod app;
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

use app::changelist_service::ChangelistService;
use app::connection_service::ConnectionService;
use app::diagnostics::DiagnosticService;
use app::file_lock_service::FileLockService;
use app::file_service::FileService;
use app::rename_service::RenameService;
use app::search_service::GlobalSearchService;
use app::status_cache::{shared_default, StatusCache};
use app::stream_switch_service::StreamSwitchService;
use app::submit_service::SubmitService;
use app::sync_service::SyncService;
use app::workflow_service::WorkflowService;
use p4::context::ContextStore;
use p4::{
    changelists::ChangelistRepository, locks::LockRepository, rename::RenameRepository,
    runner::P4Runner, submit::SubmitRepository, workflows::WorkflowRepository,
};
use persistence::{log_store::LogStore, operation_journal::OperationJournal};
use std::sync::Arc;
use tauri::{Emitter, Manager};

pub(crate) struct AppState {
    pub runner: Arc<P4Runner>,
    pub logs: Arc<LogStore>,
    pub changelists: Arc<ChangelistService>,
    pub submit: Arc<SubmitService>,
    pub sync: Arc<SyncService>,
    pub workflows: Arc<WorkflowService>,
    pub files: Arc<FileService>,
    pub file_locks: Arc<FileLockService>,
    pub rename: Arc<RenameService>,
    pub connection: Arc<ConnectionService>,
    pub status_cache: Arc<StatusCache>,
    pub journal: Arc<OperationJournal>,
    pub diagnostics: Arc<DiagnosticService>,
    pub search: Arc<GlobalSearchService>,
    pub stream_switch: Arc<StreamSwitchService>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .menu(|app| {
            use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};
            let palette = MenuItem::with_id(
                app,
                "app.commandPalette",
                "Command Palette…",
                true,
                Some("CmdOrCtrl+Shift+P"),
            )?;
            let refresh = MenuItem::with_id(
                app,
                "view.refresh",
                "Refresh Current Data",
                true,
                Some("CmdOrCtrl+R"),
            )?;
            let search = MenuItem::with_id(
                app,
                "view.search",
                "Global Search",
                true,
                Some("CmdOrCtrl+Shift+F"),
            )?;
            let settings =
                MenuItem::with_id(app, "view.settings", "Settings", true, Some("CmdOrCtrl+,"))?;
            let terminal = MenuItem::with_id(
                app,
                "tools.openTerminal",
                "Terminal",
                true,
                Some("CmdOrCtrl+Alt+T"),
            )?;
            let log = MenuItem::with_id(
                app,
                "tools.openP4Log",
                "P4 Log",
                true,
                Some("CmdOrCtrl+Alt+L"),
            )?;
            let dock_back = MenuItem::with_id(
                app,
                "panel.dockBack",
                "Dock Back to Main Window",
                true,
                Some("CmdOrCtrl+Alt+D"),
            )?;
            let connection = SubmenuBuilder::new(app, "Connection")
                .text("connection.manageProfiles", "Connect / Switch Profile")
                .item(&settings)
                .build()?;
            let changes = SubmenuBuilder::new(app, "Changes")
                .text("workspace.sync", "Sync Selected Target…")
                .text("workspace.syncRevision", "Sync to Revision…")
                .text("changelist.shelf", "Shelf Selected Files…")
                .text("changelist.moveFiles", "Move Selected Files to Changelist…")
                .text("changelist.submit", "Submit Selected Changelist…")
                .separator()
                .text("file.rename", "Rename / Move…")
                .text("file.lock", "Lock…")
                .text("file.unlock", "Unlock…")
                .text("file.resolve", "Resolve…")
                .text("file.checkout", "Checkout")
                .text("file.add", "Add")
                .text("file.delete", "Mark for Delete…")
                .text("file.revert", "Revert…")
                .separator()
                .text("operation.cancel", "Cancel Current Operation")
                .build()?;
            let navigate = SubmenuBuilder::new(app, "Navigate")
                .item(&search)
                .text("view.pending", "Pending")
                .text("view.submitted", "Submitted")
                .text("view.workspaces", "Workspaces")
                .text("view.streams", "Streams")
                .separator()
                .text("file.diff", "Diff")
                .text("file.history", "History")
                .text("file.revgraph", "Revision Graph")
                .text("file.preview", "Preview")
                .text("file.reveal", "Reveal in System")
                .text("file.openWith", "Open With…")
                .text("swarm.open", "Open in Swarm")
                .build()?;
            let view = SubmenuBuilder::new(app, "View")
                .items(&[&palette, &refresh, &terminal, &log])
                .separator()
                .text("view.diagnostics", "Diagnostics")
                .text("tools.popoutTerminal", "Open Terminal in New Window")
                .text("tools.popoutP4Log", "Open P4 Log in New Window")
                .text("refresh.toggleAuto", "Pause / Resume Auto Refresh")
                .item(&dock_back)
                .build()?;
            MenuBuilder::new(app)
                .item(&connection)
                .item(&changes)
                .item(&navigate)
                .item(&view)
                .build()
        })
        .on_menu_event(|app, event| {
            let target = app
                .webview_windows()
                .into_iter()
                .find_map(|(label, window)| {
                    window
                        .is_focused()
                        .ok()
                        .filter(|value| *value)
                        .map(|_| label)
                })
                .unwrap_or_else(|| "main".to_owned());
            let _ = app.emit_to(target, "app-command", event.id().as_ref());
        })
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
            let stream_switch = Arc::new(StreamSwitchService::new(runner.clone(), contexts));
            app.manage(AppState {
                runner,
                logs,
                changelists,
                submit,
                sync,
                workflows,
                files,
                file_locks,
                rename,
                connection,
                status_cache,
                journal,
                diagnostics,
                search,
                stream_switch,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::commands::workspace_disk_usage,
            ipc::commands::list_user_workspaces,
            ipc::commands::list_streams,
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
            ipc::commands::open_swarm_link,
            ipc::commands::local_path_capabilities,
            ipc::commands::perform_file_action,
            ipc::commands::preflight_rename_move,
            ipc::commands::confirm_rename_move,
            ipc::commands::preflight_file_lock,
            ipc::commands::confirm_file_lock,
            ipc::commands::preview_sync,
            ipc::commands::confirm_sync,
            ipc::commands::get_diff,
            ipc::commands::get_shelf_file_preview,
            ipc::commands::get_file_preview,
            ipc::commands::get_file_history,
            ipc::commands::get_revision_graph,
            ipc::commands::query_pending_changes,
            ipc::commands::mutate_pending_change,
            ipc::commands::get_shelf_detail,
            ipc::commands::preflight_move_files,
            ipc::commands::confirm_move_files,
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
