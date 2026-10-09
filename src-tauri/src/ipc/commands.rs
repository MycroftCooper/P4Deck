use crate::{domain::*, AppState};
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn workspace_disk_usage(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let path = state
        .connection
        .context()
        .cwd
        .ok_or("Workspace directory is not configured")?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
        let total = fs2::total_space(&path).map_err(|e| e.to_string())?;
        let available = fs2::available_space(&path).map_err(|e| e.to_string())?;
        Ok(serde_json::json!({ "path": path.to_string_lossy(), "total": total, "available": available }))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_panel_window(page: String, app: AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    let kind = page.split("--").next().unwrap_or("");
    if page.len() > 100 || !page.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Invalid panel ID".into());
    }
    if ![
        "files",
        "search",
        "pending",
        "submitted",
        "workspaces",
        "history",
        "streams",
        "diff",
        "revgraph",
        "settings",
        "preview",
    ]
    .contains(&kind)
    {
        return Err("Unknown panel".into());
    }
    let label = format!("panel-{page}");
    if let Some(window) = app.get_webview_window(&label) {
        return window.set_focus().map_err(|e| e.to_string());
    }
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App(format!("index.html?panel={page}#/{kind}").into()),
    )
    .title(format!("P4Deck · {page}"))
    .inner_size(1100.0, 760.0)
    .min_inner_size(640.0, 450.0)
    .disable_drag_drop_handler()
    .build()
    .map_err(|e| e.to_string())?;
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let _ = app.emit_to("main", "panel-returned", page.clone());
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn list_streams(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Vec<crate::p4::streams::StreamSummary>, String> {
    crate::p4::streams::list(&state.runner, state.connection.context(), &app).await
}

#[tauri::command]
pub async fn list_user_workspaces(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Vec<crate::p4::workspaces::ClientWorkspace>, String> {
    crate::p4::workspaces::list(&state.runner, state.connection.context(), Some(&app)).await
}

#[tauri::command]
pub async fn runtime_info(state: State<'_, AppState>) -> Result<RuntimeInfo, String> {
    let connection = state.connection.clone();
    tauri::async_runtime::spawn_blocking(move || connection.runtime_info())
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_connection_profiles(state: State<'_, AppState>) -> ConnectionProfiles {
    state.connection.profiles()
}

#[tauri::command]
pub fn get_active_connection_profile(state: State<'_, AppState>) -> Option<ConnectionProfile> {
    state.connection.active_profile()
}

#[tauri::command]
pub async fn create_connection_profile(
    request: CreateConnectionProfileRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ConnectionProfiles, ConnectionProfileError> {
    use tauri::Emitter;
    let before = state.connection.context();
    let connection = state.connection.clone();
    let profiles = tauri::async_runtime::spawn_blocking(move || connection.create_profile(request))
        .await
        .map_err(|error| profile_task_error(error.to_string()))??;
    if before != state.connection.context() {
        invalidate_after_context_change(&state);
        let _ = app.emit("connection-changed", state.connection.runtime_info());
    }
    Ok(profiles)
}

#[tauri::command]
pub async fn update_connection_profile(
    request: UpdateConnectionProfileRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ConnectionProfiles, ConnectionProfileError> {
    use tauri::Emitter;
    let before = state.connection.context();
    let connection = state.connection.clone();
    let profiles = tauri::async_runtime::spawn_blocking(move || connection.update_profile(request))
        .await
        .map_err(|error| profile_task_error(error.to_string()))??;
    if before != state.connection.context() {
        invalidate_after_context_change(&state);
        let _ = app.emit("connection-changed", state.connection.runtime_info());
    }
    Ok(profiles)
}

#[tauri::command]
pub async fn delete_connection_profile(
    request: DeleteConnectionProfileRequest,
    state: State<'_, AppState>,
) -> Result<ConnectionProfiles, ConnectionProfileError> {
    let connection = state.connection.clone();
    tauri::async_runtime::spawn_blocking(move || connection.delete_profile(request))
        .await
        .map_err(|error| profile_task_error(error.to_string()))?
}

#[tauri::command]
pub async fn set_active_connection_profile(
    request: SetActiveConnectionProfileRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<RuntimeInfo, ConnectionProfileError> {
    use tauri::Emitter;
    let runtime = state.connection.set_active_profile(request).await?;
    invalidate_after_context_change(&state);
    let _ = app.emit("connection-changed", &runtime);
    Ok(runtime)
}

#[tauri::command]
pub async fn switch_workspace(
    request: SwitchWorkspaceRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<RuntimeInfo, ConnectionProfileError> {
    use tauri::Emitter;
    let workspaces =
        crate::p4::workspaces::list(&state.runner, state.connection.context(), Some(&app))
            .await
            .map_err(|message| {
                profile_switch_error(
                    ConnectionProfileErrorCode::ConnectionFailed,
                    format!("Failed to list workspaces before switching: {message}"),
                )
            })?;
    let workspace = workspaces
        .into_iter()
        .find(|workspace| workspace.name == request.client)
        .ok_or_else(|| {
            profile_switch_error(
                ConnectionProfileErrorCode::NotFound,
                "The selected workspace is not owned by the current user or no longer exists.",
            )
        })?;
    if workspace.root.trim().is_empty() {
        return Err(profile_switch_error(
            ConnectionProfileErrorCode::InvalidInput,
            "The selected workspace has no usable Root.",
        ));
    }
    let runtime = state
        .connection
        .switch_workspace(request, workspace.root)
        .await?;
    invalidate_after_context_change(&state);
    let _ = app.emit("connection-changed", &runtime);
    Ok(runtime)
}

#[tauri::command]
pub async fn save_connection(
    context: P4Context,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<P4Context, String> {
    use tauri::Emitter;
    let connection = state.connection.clone();
    let saved = tauri::async_runtime::spawn_blocking(move || connection.save(context))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    invalidate_after_context_change(&state);
    let _ = app.emit("connection-changed", state.connection.runtime_info());
    Ok(saved)
}

fn invalidate_after_context_change(state: &AppState) {
    state.runner.cancel_all();
    state.changelists.clear_caches();
    state.search.clear_for_context_switch();
    state.submit.clear_confirmations();
    state.sync.clear_confirmations();
    state.workflows.clear_confirmations();
    state.workflows.clear_shelf_details();
    state.files.clear_review_cache();
    state.rename.clear_confirmations();
    state.status_cache.clear_for_context_switch();
}

fn profile_task_error(message: String) -> ConnectionProfileError {
    profile_switch_error(ConnectionProfileErrorCode::PersistenceFailed, message)
}

fn profile_switch_error(
    code: ConnectionProfileErrorCode,
    message: impl Into<String>,
) -> ConnectionProfileError {
    ConnectionProfileError {
        code,
        message: message.into(),
    }
}

#[tauri::command]
pub async fn discover_p4_cli(
    request: CliDiscoveryRequest,
    state: State<'_, AppState>,
) -> Result<CliDiscoveryResult, String> {
    let connection = state.connection.clone();
    tauri::async_runtime::spawn_blocking(move || connection.discover_cli(request))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn test_connection(
    context: P4Context,
    state: State<'_, AppState>,
) -> Result<ConnectionStatus, String> {
    Ok(state.connection.test_connection(context).await)
}

#[tauri::command]
pub async fn query_login_status(
    context: P4Context,
    state: State<'_, AppState>,
) -> Result<ConnectionStatus, String> {
    Ok(state.connection.login_status(context).await)
}

#[tauri::command]
pub async fn trust_server(
    request: TrustRequest,
    state: State<'_, AppState>,
) -> Result<ConnectionStatus, String> {
    Ok(state.connection.trust(request).await)
}

#[tauri::command]
pub async fn login(
    request: LoginRequest,
    state: State<'_, AppState>,
) -> Result<ConnectionStatus, String> {
    Ok(state.connection.login(request).await)
}

#[tauri::command]
pub async fn logout(
    request: AuthenticationRequest,
    state: State<'_, AppState>,
) -> Result<ConnectionStatus, String> {
    Ok(state.connection.logout(request).await)
}

#[tauri::command]
pub async fn run_p4(
    request: P4CommandRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<OperationResult, String> {
    if request.input.is_some() {
        return Err("Generic IPC commands cannot provide stdin".into());
    }
    if matches!(request.source, OperationSource::Gui)
        && matches!(
            request.command.to_ascii_lowercase().as_str(),
            "submit" | "shelve" | "unshelve" | "resolve" | "sync" | "move" | "reopen"
        )
    {
        return Err("GUI submit, shelf, unshelve, resolve, sync, move and reopen must use their preview/preflight and confirmation APIs".into());
    }
    state
        .runner
        .run(request, Some(&app))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn cancel_operation(operation_id: String, state: State<'_, AppState>) {
    state.runner.cancel(&operation_id);
    state.search.cancel(&operation_id);
}

#[tauri::command]
pub async fn global_search(
    query: GlobalSearchQuery,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<GlobalSearchResult, GlobalSearchRequestError> {
    state.search.query(query, Some(&app)).await
}

#[tauri::command]
pub fn query_logs(query: LogQuery, state: State<'_, AppState>) -> Vec<LogEntry> {
    state.logs.query(&query)
}

#[tauri::command]
pub fn query_log_page(query: LogQuery, state: State<'_, AppState>) -> LogPage {
    state.logs.query_page(&query)
}

#[tauri::command]
pub fn get_log_policy(state: State<'_, AppState>) -> LogPolicy {
    state.logs.policy()
}

#[tauri::command]
pub fn set_log_policy(policy: LogPolicy, state: State<'_, AppState>) -> Result<LogPolicy, String> {
    state.logs.set_policy(policy)
}

#[tauri::command]
pub async fn export_diagnostics(
    request: DiagnosticExportRequest,
    state: State<'_, AppState>,
) -> Result<DiagnosticExportResult, String> {
    let diagnostics = state.diagnostics.clone();
    tauri::async_runtime::spawn_blocking(move || diagnostics.export(request))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn status_cache_diagnostics(
    state: State<'_, AppState>,
) -> crate::app::status_cache::CacheDiagnostics {
    state.status_cache.diagnostics()
}

#[tauri::command]
pub fn query_operation_journal(
    mut query: crate::persistence::operation_journal::OperationJournalQuery,
    state: State<'_, AppState>,
) -> Result<crate::persistence::operation_journal::OperationJournalPage, String> {
    if query.connection_id.is_none() {
        let context = state.connection.context();
        query.connection_id = Some(crate::persistence::operation_journal::connection_id(
            &context.server,
            &context.user,
            &context.client,
        ));
    }
    state.journal.query(&query)
}

#[tauri::command]
pub fn get_operation_record(
    operation_id: String,
    state: State<'_, AppState>,
) -> Option<crate::persistence::operation_journal::OperationRecord> {
    state.journal.get(&operation_id)
}

#[tauri::command]
pub async fn query_changelists(
    query: ClQuery,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ClQueryResult, String> {
    state
        .changelists
        .query(state.connection.context(), query, Some(&app))
        .await
}

#[tauri::command]
pub async fn get_submitted_change_detail(
    request: SubmittedChangeDetailRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<SubmittedChangeDetail, String> {
    Ok(state
        .changelists
        .submitted_detail(request, Some(&app))
        .await)
}

#[tauri::command]
pub async fn perform_cl_action(
    action: ClAction,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ClActionResult, String> {
    state
        .changelists
        .perform(state.connection.context(), action, Some(&app))
        .await
}

#[tauri::command]
pub async fn list_workspace_children(
    path: Option<String>,
    refresh: Option<bool>,
    operation_id: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<WorkspaceListing, String> {
    state
        .files
        .workspace_children_with_operation(
            state.connection.context(),
            path,
            refresh.unwrap_or(false),
            operation_id,
            Some(&app),
        )
        .await
}

#[tauri::command]
pub async fn list_depot_children(
    path: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Vec<DepotNode>, String> {
    state
        .files
        .depot_children(state.connection.context(), path, Some(&app))
        .await
}

#[tauri::command]
pub async fn resolve_path(
    request: PathResolveRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<PathResolveResult, String> {
    state
        .files
        .resolve_path(state.connection.context(), request, Some(&app))
        .await
}

#[tauri::command]
pub async fn perform_file_action(
    request: FileActionRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<FileActionResult, String> {
    if request.action == FileAction::MoveToChangelist {
        return Err(
            "GUI changelist moves must use the move preflight and confirmation APIs".into(),
        );
    }
    state
        .files
        .perform(state.connection.context(), request, Some(&app))
        .await
}

#[tauri::command]
pub async fn preflight_rename_move(
    request: RenameMovePreflightRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<RenameMovePreflight, String> {
    Ok(state.rename.preflight(request, Some(&app)).await)
}

#[tauri::command]
pub async fn confirm_rename_move(
    confirmation: RenameMoveConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<RenameMoveResult, String> {
    Ok(state.rename.confirm(confirmation, Some(&app)).await)
}

#[tauri::command]
pub async fn preview_sync(
    request: SyncPreviewRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<SyncPreviewPlan, String> {
    Ok(state.sync.preview(request, Some(&app)).await)
}

#[tauri::command]
pub async fn confirm_sync(
    confirmation: SyncConfirmRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<SyncResult, String> {
    Ok(state.sync.confirm(confirmation, Some(&app)).await)
}

#[tauri::command]
pub async fn get_diff(
    request: DiffRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<DiffResult, String> {
    state.files.diff(request, Some(&app)).await
}

#[tauri::command]
pub async fn get_shelf_file_preview(
    request: ShelfFilePreviewRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ShelfFilePreview, String> {
    state.files.shelf_preview(request, Some(&app)).await
}

#[tauri::command]
pub async fn get_file_preview(
    path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<crate::app::preview::FilePreview, String> {
    let context = state.connection.context();
    let local = if path.starts_with("//") {
        state
            .files
            .resolve_path(
                context.clone(),
                PathResolveRequest { input: path },
                Some(&app),
            )
            .await?
            .absolute_path
            .ok_or("Depot file is not mapped to this workspace")?
    } else {
        path
    };
    tauri::async_runtime::spawn_blocking(move || {
        crate::app::preview::read(
            std::path::Path::new(context.cwd.as_deref().unwrap_or(".")),
            &local,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_file_history(
    request: FileHistoryRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<FileHistoryPage, String> {
    state.files.history(request, Some(&app)).await
}

#[tauri::command]
pub async fn get_revision_graph(
    request: RevisionGraphRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<RevisionGraph, String> {
    state.files.graph(request, Some(&app)).await
}

#[tauri::command]
pub async fn query_pending_changes(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Vec<PendingChange>, String> {
    state
        .changelists
        .query_pending(state.connection.context(), Some(&app))
        .await
}

#[tauri::command]
pub async fn mutate_pending_change(
    request: PendingChangeMutationRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<PendingChangeMutationResult, String> {
    if matches!(&request.mutation, PendingChangeMutation::MoveFiles { .. }) {
        return Err("GUI file moves must use the move preflight and confirmation APIs".into());
    }
    let result = state
        .changelists
        .mutate_pending(state.connection.context(), request, Some(&app))
        .await?;
    state.workflows.clear_shelf_details();
    Ok(result)
}

#[tauri::command]
pub async fn get_shelf_detail(
    request: ShelfDetailRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ShelfDetail, String> {
    state.workflows.shelf_detail(request, Some(&app)).await
}

#[tauri::command]
pub async fn preflight_move_files(
    request: MoveFilesPreflightRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<MoveFilesPreflight, String> {
    Ok(state.workflows.preflight_move(request, Some(&app)).await)
}

#[tauri::command]
pub async fn confirm_move_files(
    confirmation: WorkflowConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<MoveFilesResult, String> {
    Ok(state.workflows.confirm_move(confirmation, Some(&app)).await)
}

#[tauri::command]
pub async fn preflight_submit(
    request: SubmitPreflightRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<SubmitPreflight, String> {
    Ok(state.submit.preflight(request, Some(&app)).await)
}

#[tauri::command]
pub async fn confirm_submit(
    confirmation: SubmitConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<SubmitResult, String> {
    Ok(state.submit.confirm(confirmation, Some(&app)).await)
}

#[tauri::command]
pub async fn preflight_shelf(
    request: ShelfPreflightRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ShelfPreflight, String> {
    Ok(state.workflows.preflight_shelf(request, Some(&app)).await)
}

#[tauri::command]
pub async fn confirm_shelf(
    confirmation: WorkflowConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<WorkflowResult, String> {
    let result = state
        .workflows
        .confirm_shelf(confirmation, Some(&app))
        .await;
    if matches!(
        result.outcome,
        WorkflowOutcome::Succeeded | WorkflowOutcome::Partial
    ) {
        state.files.clear_review_cache();
    }
    Ok(result)
}

#[tauri::command]
pub async fn preflight_unshelve(
    request: UnshelvePreflightRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<UnshelvePreflight, String> {
    Ok(state
        .workflows
        .preflight_unshelve(request, Some(&app))
        .await)
}

#[tauri::command]
pub async fn confirm_unshelve(
    confirmation: WorkflowConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<WorkflowResult, String> {
    Ok(state
        .workflows
        .confirm_unshelve(confirmation, Some(&app))
        .await)
}

#[tauri::command]
pub async fn preflight_resolve(
    request: ResolvePreflightRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ResolvePreflight, String> {
    Ok(state.workflows.preflight_resolve(request, Some(&app)).await)
}

#[tauri::command]
pub async fn confirm_resolve(
    confirmation: ResolveConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<WorkflowResult, String> {
    Ok(state
        .workflows
        .confirm_resolve(confirmation, Some(&app))
        .await)
}
#[tauri::command]
pub async fn open_local_path(
    request: crate::app::system_open::OpenLocalPathRequest,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let context = state.connection.context();
    let root = std::path::PathBuf::from(
        context
            .cwd
            .ok_or("Current workspace root is not configured")?,
    );
    tauri::async_runtime::spawn_blocking(move || crate::app::system_open::open(&root, request))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn local_path_capabilities(
    path: String,
    state: State<'_, AppState>,
) -> Result<crate::app::system_open::LocalPathCapabilities, String> {
    let root = std::path::PathBuf::from(
        state
            .connection
            .context()
            .cwd
            .ok_or("Current workspace root is not configured")?,
    );
    tauri::async_runtime::spawn_blocking(move || crate::app::system_open::capabilities(&root, path))
        .await
        .map_err(|error| error.to_string())
}
