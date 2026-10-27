use crate::{domain::*, AppState};
use tauri::{AppHandle, Emitter, State};

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

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelRuntimeBinding {
    profile_id: Option<String>,
    context_generation: u64,
    connection_key: String,
}

fn logical_window_placement(
    position: tauri::PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
    scale_factor: f64,
    maximized: bool,
) -> crate::window_placement::WindowPlacement {
    let position = position.to_logical::<i32>(scale_factor.max(f64::EPSILON));
    let size = size.to_logical::<u32>(scale_factor.max(f64::EPSILON));
    crate::window_placement::WindowPlacement {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized,
    }
}

#[tauri::command]
pub async fn open_panel_window(
    page: String,
    binding: Option<PanelRuntimeBinding>,
    app: AppHandle,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    let kind = panel_window_kind(&page)?;
    let label = format!("panel-{page}");
    if let Some(window) = app.get_webview_window(&label) {
        return window.set_focus().map_err(|e| e.to_string());
    }
    let route = panel_window_url(&page, kind, binding.as_ref());
    let placement_path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("window-placement-v1.json");
    let monitors = app
        .get_webview_window("main")
        .and_then(|window| window.available_monitors().ok())
        .unwrap_or_default();
    let screens: Vec<crate::window_placement::ScreenRect> = monitors
        .iter()
        .map(|monitor| {
            let position = monitor.position().to_logical::<i32>(monitor.scale_factor());
            let size = monitor.size().to_logical::<u32>(monitor.scale_factor());
            crate::window_placement::ScreenRect {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            }
        })
        .collect();
    let fallback = screens
        .first()
        .copied()
        .unwrap_or(crate::window_placement::ScreenRect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        });
    let placement = crate::window_placement::load(&placement_path, &page)
        .map(|value| crate::window_placement::sanitize(value, &screens, fallback));
    let mut builder =
        tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(route.into()))
            .title(format!("P4Deck · {page}"))
            .inner_size(1100.0, 760.0)
            .min_inner_size(390.0, 450.0)
            .disable_drag_drop_handler();
    if let Some(value) = placement {
        builder = builder
            .position(value.x as f64, value.y as f64)
            .inner_size(value.width as f64, value.height as f64);
    }
    let window = builder.build().map_err(|e| e.to_string())?;
    if let Some(value) = placement {
        window
            .set_position(tauri::LogicalPosition::new(value.x, value.y))
            .map_err(|e| e.to_string())?;
    }
    if placement.is_some_and(|value| value.maximized) {
        let _ = window.maximize();
    }
    let placement_window = window.clone();
    let placement_key = page.clone();
    let last_placement = std::sync::Arc::new(std::sync::Mutex::new(placement.unwrap_or(
        crate::window_placement::WindowPlacement {
            x: fallback.x,
            y: fallback.y,
            width: 1100.min(fallback.width),
            height: 760.min(fallback.height),
            maximized: false,
        },
    )));
    window.on_window_event(move |event| {
        if matches!(
            event,
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
        ) {
            if let (Ok(position), Ok(size), Ok(scale), Ok(maximized), Ok(mut previous)) = (
                placement_window.outer_position(),
                placement_window.inner_size(),
                placement_window.scale_factor(),
                placement_window.is_maximized(),
                last_placement.lock(),
            ) {
                if !maximized {
                    let next = logical_window_placement(position, size, scale, false);
                    previous.x = next.x;
                    previous.y = next.y;
                    previous.width = next.width;
                    previous.height = next.height;
                }
                previous.maximized = maximized;
                let _ = crate::window_placement::save(&placement_path, &placement_key, *previous);
            }
        }
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let _ = app.emit_to("main", "panel-returned", page.clone());
        }
    });
    Ok(())
}

fn panel_window_url(page: &str, kind: &str, binding: Option<&PanelRuntimeBinding>) -> String {
    let mut query = format!("panel={}", urlencoding::encode(page));
    if let Some(binding) = binding {
        if let Some(profile_id) = binding.profile_id.as_deref() {
            query.push_str("&profileId=");
            query.push_str(&urlencoding::encode(profile_id));
        }
        query.push_str("&contextGeneration=");
        query.push_str(&binding.context_generation.to_string());
        query.push_str("&connectionKey=");
        query.push_str(&urlencoding::encode(&binding.connection_key));
    }
    format!("index.html?{query}#/{kind}")
}

fn panel_window_kind(page: &str) -> Result<&str, String> {
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
        "streamgraph",
        "branchmappings",
        "terminal",
        "p4log",
        "diff",
        "shelf",
        "revgraph",
        "settings",
        "preview",
    ]
    .contains(&kind)
    {
        return Err("Unknown panel".into());
    }
    Ok(kind)
}

#[tauri::command]
pub async fn list_streams(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Vec<crate::p4::streams::StreamSummary>, String> {
    crate::p4::streams::list(&state.runner, state.connection.context(), &app).await
}

#[tauri::command]
pub async fn query_stream_graph(
    query: StreamGraphQuery,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<StreamGraphResult, StreamGraphRequestError> {
    state.stream_graph.query(query, Some(&app)).await
}

#[tauri::command]
pub async fn query_branch_mappings(
    query: BranchMappingQuery,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<BranchMappingPage, BranchMappingRequestError> {
    state.branch_mappings.list(query, Some(&app)).await
}

#[tauri::command]
pub async fn get_branch_mapping_detail(
    query: BranchMappingDetailQuery,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<BranchMappingDetailResult, BranchMappingRequestError> {
    state.branch_mappings.detail(query, Some(&app)).await
}

#[tauri::command]
pub async fn preview_branch_mapping_impact(
    query: BranchImpactPreviewQuery,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<BranchImpactPreview, BranchMappingRequestError> {
    state.branch_mappings.preview(query, Some(&app)).await
}

#[tauri::command]
pub async fn preflight_branch_mapping_mutation(
    request: BranchMutationPreflightRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<BranchMutationPreflight, String> {
    Ok(state.branch_mappings.preflight(request, Some(&app)).await)
}

#[tauri::command]
pub async fn confirm_branch_mapping_mutation(
    confirmation: BranchMutationConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<BranchMutationResult, String> {
    Ok(state
        .branch_mappings
        .confirm(confirmation, Some(&app))
        .await)
}

#[tauri::command]
pub async fn preflight_stream_switch(
    request: StreamSwitchPreflightRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<StreamSwitchPreflight, String> {
    Ok(state.stream_switch.preflight(request, Some(&app)).await)
}

#[tauri::command]
pub async fn confirm_stream_switch(
    confirmation: StreamSwitchConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<StreamSwitchResult, String> {
    let expected_generation = confirmation.target.context_generation;
    let mut result = state.stream_switch.confirm(confirmation, Some(&app)).await;
    let runtime = state.connection.runtime_info();
    if result.stream_changed {
        invalidate_after_context_change(&state);
        if runtime.context_generation == expected_generation.saturating_add(1) {
            result.runtime = Some(state.connection.verified_runtime(
                "Client Stream and workspace state were verified after switching.",
            ));
        }
    } else if result.sync_performed
        || result.outcome == StreamSwitchOutcome::Unknown
        || result.failure == Some(StreamSwitchFailureCode::VerificationFailed)
    {
        invalidate_workspace_dependent_caches(&state);
    }
    Ok(result)
}

#[tauri::command]
pub async fn list_user_workspaces(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Vec<crate::p4::workspaces::ClientWorkspace>, String> {
    crate::p4::workspaces::list(&state.runner, state.connection.context(), Some(&app)).await
}

#[tauri::command]
pub async fn browse_connection_users(
    request: ConnectionDirectoryRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ConnectionUserDirectoryResult, String> {
    Ok(state
        .connection_setup
        .browse_users(request, Some(&app))
        .await)
}

#[tauri::command]
pub async fn browse_connection_workspaces(
    request: ConnectionDirectoryRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ConnectionWorkspaceDirectoryResult, String> {
    Ok(state
        .connection_setup
        .browse_workspaces(request, Some(&app))
        .await)
}

#[tauri::command]
pub async fn preflight_create_connection_user(
    request: ConnectionUserCreatePreflightRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ConnectionSpecCreatePreflight, String> {
    Ok(state
        .connection_setup
        .preflight_user(request, Some(&app))
        .await)
}

#[tauri::command]
pub async fn preflight_create_connection_workspace(
    request: ConnectionWorkspaceCreatePreflightRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ConnectionSpecCreatePreflight, String> {
    Ok(state
        .connection_setup
        .preflight_workspace(request, Some(&app))
        .await)
}

#[tauri::command]
pub async fn confirm_create_connection_user(
    confirmation: ConnectionSpecCreateConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ConnectionSpecCreateResult, String> {
    Ok(state
        .connection_setup
        .confirm(ConnectionSpecKind::UserSelf, confirmation, Some(&app))
        .await)
}

#[tauri::command]
pub async fn confirm_create_connection_workspace(
    confirmation: ConnectionSpecCreateConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ConnectionSpecCreateResult, String> {
    Ok(state
        .connection_setup
        .confirm(ConnectionSpecKind::Workspace, confirmation, Some(&app))
        .await)
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
    let profiles = state.connection.create_profile(request, Some(&app)).await?;
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
    let profiles = state.connection.update_profile(request, Some(&app)).await?;
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
    app: AppHandle,
) -> Result<ConnectionProfiles, ConnectionProfileError> {
    use tauri::Emitter;
    let before = state.connection.runtime_info().context_generation;
    let connection = state.connection.clone();
    let profiles = tauri::async_runtime::spawn_blocking(move || connection.delete_profile(request))
        .await
        .map_err(|error| profile_task_error(error.to_string()))??;
    let runtime = state.connection.runtime_info();
    if before != runtime.context_generation {
        invalidate_after_context_change(&state);
        let _ = app.emit("connection-changed", runtime);
    }
    Ok(profiles)
}

#[tauri::command]
pub async fn set_active_connection_profile(
    request: SetActiveConnectionProfileRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<RuntimeInfo, ConnectionProfileError> {
    use tauri::Emitter;
    let runtime = state
        .connection
        .set_active_profile(request, Some(&app))
        .await?;
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
    let runtime = state
        .connection
        .switch_workspace(request, Some(&app))
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
    let saved = state
        .connection
        .save(context, Some(&app))
        .await
        .map_err(|error| error.to_string())?;
    invalidate_after_context_change(&state);
    let _ = app.emit("connection-changed", state.connection.runtime_info());
    Ok(saved)
}

fn invalidate_after_context_change(state: &AppState) {
    state.runner.cancel_all();
    state.changelists.clear_caches();
    state.search.clear_for_context_switch();
    state.stream_graph.clear_for_context_switch();
    state.branch_mappings.clear_for_context_switch();
    state.submit.clear_confirmations();
    state.sync.clear_confirmations();
    state.undo.clear_confirmations();
    state.workflows.clear_confirmations();
    state.workflows.clear_shelf_details();
    state.files.clear_review_cache();
    state.rename.clear_confirmations();
    state.file_locks.clear_confirmations();
    state.stream_switch.clear_confirmations();
    state.status_cache.clear_for_context_switch();
}

fn invalidate_workspace_dependent_caches(state: &AppState) {
    state.changelists.clear_caches();
    state.search.clear_for_context_switch();
    state.stream_graph.clear_for_context_switch();
    state.branch_mappings.clear_for_context_switch();
    state.files.clear_review_cache();
    state.file_locks.clear_confirmations();
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
    crate::p4::context::validate_connection_context(&request.context)?;
    if request.input.is_some() {
        return Err("Generic IPC commands cannot provide stdin".into());
    }
    if generic_lock_command_blocked(&request.command) {
        return Err("Lock and unlock are blocked in Terminal and generic run_p4; use the dedicated preflight and confirmation workflow".into());
    }
    if generic_gui_requires_dedicated_api(&request.source, &request.command) {
        return Err("GUI mutations, including client/stream changes, must use their dedicated preview/preflight and confirmation APIs".into());
    }
    state
        .runner
        .run(request, Some(&app))
        .await
        .map_err(|error| error.to_string())
}

fn generic_lock_command_blocked(command: &str) -> bool {
    matches!(command.to_ascii_lowercase().as_str(), "lock" | "unlock")
}

fn generic_gui_requires_dedicated_api(source: &OperationSource, command: &str) -> bool {
    matches!(source, OperationSource::Gui)
        && matches!(
            command.to_ascii_lowercase().as_str(),
            "submit"
                | "shelve"
                | "unshelve"
                | "resolve"
                | "sync"
                | "move"
                | "reopen"
                | "client"
                | "user"
                | "branch"
                | "stream"
                | "switch"
        )
}

#[tauri::command]
pub fn cancel_all_operations(state: State<'_, AppState>) {
    state.runner.cancel_all();
}

#[tauri::command]
pub fn cancel_operation(operation_id: String, state: State<'_, AppState>) {
    state.runner.cancel(&operation_id);
    state.search.cancel(&operation_id);
    state.stream_graph.cancel(&operation_id);
    state.branch_mappings.cancel(&operation_id);
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
pub async fn open_logs_folder(state: State<'_, AppState>) -> Result<(), String> {
    let path = state.logs.directory().to_owned();
    tauri::async_runtime::spawn_blocking(move || crate::app::system_open::open_log_directory(&path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn delete_all_logs(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let logs = state.logs.clone();
    let result = tauri::async_runtime::spawn_blocking(move || logs.clear_all())
        .await
        .map_err(|error| error.to_string())?;
    let _ = app.emit("logs-cleared", ());
    result
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
pub async fn create_config_backup(
    request: crate::persistence::backup::ConfigBackupCreateRequest,
    state: State<'_, AppState>,
) -> Result<crate::persistence::backup::ConfigBackupCreateResult, String> {
    let backups = state.backups.clone();
    tauri::async_runtime::spawn_blocking(move || backups.create(request))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn list_config_backups(
    state: State<'_, AppState>,
) -> Result<crate::persistence::backup::ConfigBackupOverview, String> {
    let backups = state.backups.clone();
    tauri::async_runtime::spawn_blocking(move || backups.overview())
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn restore_config_backup(
    request: crate::persistence::backup::ConfigBackupRestoreRequest,
    state: State<'_, AppState>,
) -> Result<crate::persistence::backup::ConfigBackupRestoreResult, String> {
    let backups = state.backups.clone();
    tauri::async_runtime::spawn_blocking(move || backups.restore(request))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn open_config_backups_folder(state: State<'_, AppState>) -> Result<(), String> {
    let path = state.backups.directory();
    tauri::async_runtime::spawn_blocking(move || crate::app::system_open::open_log_directory(&path))
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
    local_only: Option<bool>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<WorkspaceListing, String> {
    if local_only.unwrap_or(false) {
        let context = state.connection.context();
        return tauri::async_runtime::spawn_blocking(move || {
            crate::app::file_service::FileService::workspace_directory(&context, path.as_deref())
        })
        .await
        .map_err(|error| error.to_string())?;
    }
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
    if matches!(request.action, FileAction::Lock | FileAction::Unlock) {
        return Err(
            "GUI lock/unlock must use the dedicated preflight and confirmation APIs".into(),
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
pub async fn preflight_file_lock(
    request: FileLockPreflightRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<FileLockPreflight, String> {
    Ok(state.file_locks.preflight(request, Some(&app)).await)
}

#[tauri::command]
pub async fn confirm_file_lock(
    confirmation: FileLockConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<FileLockResult, String> {
    let result = state.file_locks.confirm(confirmation, Some(&app)).await;
    if matches!(
        result.outcome,
        FileLockOutcome::Succeeded | FileLockOutcome::Partial | FileLockOutcome::Unknown
    ) {
        state.changelists.invalidate_pending_pages();
        state.search.clear_for_context_switch();
        state.files.clear_review_cache();
    }
    Ok(result)
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
pub async fn inspect_p4vfs(
    request: P4VfsInspectRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<P4VfsStatus, String> {
    state.vfs.inspect(request, Some(&app)).await
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
    let root = context
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("Workspace Root has not been verified")?
        .to_owned();
    if !std::path::Path::new(&root).is_absolute() {
        return Err("Workspace Root must be an absolute path".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        crate::app::preview::read(std::path::Path::new(&root), &local)
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
    query: PendingChangeQuery,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<PendingChangePage, String> {
    state
        .changelists
        .query_pending_page(state.connection.context(), query, Some(&app))
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
) -> Result<ShelfDetail, ShelfDetailRequestError> {
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
    let result = state.workflows.confirm_move(confirmation, Some(&app)).await;
    if matches!(
        result.outcome,
        WorkflowOutcome::Succeeded | WorkflowOutcome::Partial
    ) {
        state.changelists.invalidate_pending_pages();
    }
    Ok(result)
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
    let result = state.submit.confirm(confirmation, Some(&app)).await;
    if result.outcome == SubmitOutcome::Submitted {
        state.changelists.invalidate_pending_pages();
    }
    Ok(result)
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
        state.changelists.invalidate_pending_pages();
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
    let result = state
        .workflows
        .confirm_unshelve(confirmation, Some(&app))
        .await;
    if matches!(
        result.outcome,
        WorkflowOutcome::Succeeded | WorkflowOutcome::Partial
    ) {
        state.changelists.invalidate_pending_pages();
    }
    Ok(result)
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
pub async fn open_manual_merge(
    request: ManualMergeOpenRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ManualMergeSession, String> {
    state.workflows.open_manual_merge(request, Some(&app)).await
}

#[tauri::command]
pub fn validate_manual_merge(
    request: ManualMergeValidateRequest,
    state: State<'_, AppState>,
) -> Result<ManualMergeValidation, String> {
    state.workflows.validate_manual_merge(request)
}

#[tauri::command]
pub async fn confirm_manual_merge_save(
    confirmation: ManualMergeSaveConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ManualMergeSaveResult, String> {
    let result = state
        .workflows
        .confirm_manual_merge_save(confirmation, Some(&app))
        .await?;
    if matches!(
        result.outcome,
        WorkflowOutcome::Succeeded | WorkflowOutcome::Partial | WorkflowOutcome::Unknown
    ) {
        state.changelists.invalidate_pending_pages();
        state.search.clear_for_context_switch();
        state.files.clear_review_cache();
    }
    Ok(result)
}

#[tauri::command]
pub async fn confirm_manual_merge_resolve(
    confirmation: ManualMergeResolveConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<WorkflowResult, String> {
    let result = state
        .workflows
        .confirm_manual_merge_resolve(confirmation, Some(&app))
        .await;
    if matches!(
        result.outcome,
        WorkflowOutcome::Succeeded | WorkflowOutcome::Partial | WorkflowOutcome::Unknown
    ) {
        state.changelists.invalidate_pending_pages();
        state.search.clear_for_context_switch();
        state.files.clear_review_cache();
    }
    Ok(result)
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
pub async fn open_swarm_link(
    request: OpenSwarmLinkRequest,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (profile_id, generation, context) = state.connection.swarm_snapshot();
    crate::app::swarm_open::validate_binding(profile_id.as_deref(), generation, &request)?;
    let base = context
        .swarm_base_url
        .ok_or("Configure a Swarm base URL for the active profile first.")?;
    tauri::async_runtime::spawn_blocking(move || crate::app::swarm_open::open(&base, &request))
        .await
        .map_err(|_| "The Swarm opener did not complete.".to_string())?
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

#[cfg(test)]
mod tests {
    use super::{
        generic_gui_requires_dedicated_api, generic_lock_command_blocked, logical_window_placement,
        panel_window_kind, panel_window_url, PanelRuntimeBinding,
    };
    use crate::domain::OperationSource;

    #[test]
    fn generic_gui_branch_commands_cannot_bypass_the_dedicated_api() {
        assert!(generic_gui_requires_dedicated_api(
            &OperationSource::Gui,
            "branch"
        ));
        assert!(!generic_gui_requires_dedicated_api(
            &OperationSource::Terminal,
            "branch"
        ));
        assert!(!generic_gui_requires_dedicated_api(
            &OperationSource::Gui,
            "branches"
        ));
        assert!(generic_gui_requires_dedicated_api(
            &OperationSource::Gui,
            "client"
        ));
        assert!(generic_gui_requires_dedicated_api(
            &OperationSource::Gui,
            "user"
        ));
    }

    #[test]
    fn generic_runner_cannot_bypass_the_dedicated_lock_workflow() {
        assert!(generic_lock_command_blocked("lock"));
        assert!(generic_lock_command_blocked("UNLOCK"));
        assert!(!generic_lock_command_blocked("opened"));
    }

    #[test]
    fn detached_shelf_panel_is_whitelisted_and_deep_link_safe() {
        assert_eq!(
            panel_window_kind("shelf--550e8400-e29b-41d4-a716-446655440000"),
            Ok("shelf")
        );
        assert_eq!(panel_window_kind("shelf"), Ok("shelf"));
        assert!(panel_window_kind("unknown--1").is_err());
        assert!(panel_window_kind("shelf?panel=files").is_err());
    }

    #[test]
    fn terminal_and_log_panels_are_whitelisted_with_encoded_runtime_binding() {
        assert_eq!(panel_window_kind("terminal"), Ok("terminal"));
        assert_eq!(panel_window_kind("p4log"), Ok("p4log"));
        assert_eq!(panel_window_kind("streamgraph"), Ok("streamgraph"));
        assert_eq!(panel_window_kind("branchmappings"), Ok("branchmappings"));
        let binding = PanelRuntimeBinding {
            profile_id: Some("team/profile".into()),
            context_generation: 9,
            connection_key: "profile:9:ssl:1666".into(),
        };
        assert_eq!(
            panel_window_url("terminal", "terminal", Some(&binding)),
            "index.html?panel=terminal&profileId=team%2Fprofile&contextGeneration=9&connectionKey=profile%3A9%3Assl%3A1666#/terminal"
        );
        assert!(panel_window_kind("terminal--unexpected-instance").is_ok());
        assert!(panel_window_kind("p4log?panel=terminal").is_err());
    }

    #[test]
    fn window_placement_round_trips_in_logical_pixels_at_150_percent_dpi() {
        let placement = logical_window_placement(
            tauri::PhysicalPosition::new(630, 270),
            tauri::PhysicalSize::new(1767, 1116),
            1.5,
            false,
        );
        assert_eq!(placement.x, 420);
        assert_eq!(placement.y, 180);
        assert_eq!(placement.width, 1178);
        assert_eq!(placement.height, 744);
    }
}

#[tauri::command]
pub async fn preview_undo(
    request: crate::app::undo_service::UndoTarget,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<crate::app::undo_service::UndoPreview, String> {
    state.undo.preview(request, Some(&app)).await
}
#[tauri::command]
pub async fn confirm_undo(
    confirmation: crate::app::undo_service::UndoConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<OperationResult, String> {
    state.undo.confirm(confirmation, Some(&app)).await
}
