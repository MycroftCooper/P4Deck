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
pub async fn save_connection(
    context: P4Context,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<P4Context, String> {
    use tauri::Emitter;
    let previous = state.connection.context();
    let connection = state.connection.clone();
    let saved = tauri::async_runtime::spawn_blocking(move || connection.save(context))
        .await
        .map_err(|error| error.to_string())??;
    state.status_cache.invalidate(
        &previous.server,
        &previous.user,
        &previous.client,
        &[],
        &[],
        crate::app::status_cache::InvalidationReason::ConnectionChanged,
    );
    let _ = app.emit("connection-changed", &saved);
    Ok(saved)
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
    state
        .runner
        .run(request, Some(&app))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn cancel_operation(operation_id: String, state: State<'_, AppState>) {
    state.runner.cancel(&operation_id);
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
    query: crate::persistence::operation_journal::OperationJournalQuery,
    state: State<'_, AppState>,
) -> Result<crate::persistence::operation_journal::OperationJournalPage, String> {
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
        .query(state.connection.context(), query, &app)
        .await
}

#[tauri::command]
pub async fn perform_cl_action(
    action: ClAction,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ClActionResult, String> {
    let context = state.connection.context();
    let result = state
        .changelists
        .perform(context.clone(), action.clone(), &app)
        .await?;
    let reason = if matches!(action, ClAction::SubmitValidate { .. }) {
        crate::app::status_cache::InvalidationReason::Submit
    } else {
        crate::app::status_cache::InvalidationReason::ChangelistMutation
    };
    state.status_cache.invalidate(
        &context.server,
        &context.user,
        &context.client,
        &[],
        &[
            crate::app::status_cache::StatusQueryKind::WorkspaceStatus,
            crate::app::status_cache::StatusQueryKind::Opened,
            crate::app::status_cache::StatusQueryKind::Reconcile,
        ],
        reason,
    );
    Ok(result)
}

#[tauri::command]
pub async fn list_workspace_children(
    path: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Vec<WorkspaceNode>, String> {
    state
        .files
        .workspace_children(state.connection.context(), path, Some(&app))
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
    state
        .files
        .perform(state.connection.context(), request, Some(&app))
        .await
}

#[tauri::command]
pub async fn get_diff(
    path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<DiffResult, String> {
    state
        .files
        .diff(state.connection.context(), path, Some(&app))
        .await
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
    path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Vec<FileRevision>, String> {
    state
        .files
        .history(state.connection.context(), path, Some(&app))
        .await
}

#[tauri::command]
pub async fn get_revision_graph(
    path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<RevisionGraph, String> {
    state
        .files
        .graph(state.connection.context(), path, Some(&app))
        .await
}

#[tauri::command]
pub async fn query_pending_changes(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Vec<PendingChange>, String> {
    let result = state
        .runner
        .run(
            P4CommandRequest {
                operation_id: None,
                source: OperationSource::Gui,
                command: "opened".into(),
                args: vec![],
                context: state.connection.context(),
                output_mode: OutputMode::JsonLines,
                timeout_ms: Some(120_000),
                input: None,
            },
            Some(&app),
        )
        .await
        .map_err(|error| error.to_string())?;
    let files = result
        .events
        .iter()
        .filter_map(|event| event.message.as_deref())
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter_map(|value| {
            let path = value.get("depotFile")?.as_str()?;
            let action = value
                .get("action")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("edit");
            let mut characters = action.chars();
            let title = characters
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + characters.as_str())
                .unwrap_or_else(|| "Edit".into());
            Some(PendingFile {
                depot_path: path.into(),
                action: action.into(),
                state: format!("opened{title}"),
            })
        })
        .collect();
    Ok(vec![PendingChange {
        id: 0,
        description: "Default changelist".into(),
        files,
        shelved_files: vec![],
    }])
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
