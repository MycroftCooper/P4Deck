use crate::{domain::*, AppState};
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn custom_submit_start(
    _admission: crate::close_guard::Admission,
    request: crate::app::custom_submit::StartRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<crate::app::custom_submit_action::CustomSubmitActionResult, String> {
    let operation_id = request.request_id.clone();
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection".to_owned())?;
    let settle = |session: &crate::app::custom_submit::Session| {
        if crate::app::custom_submit_action::is_terminal(session) {
            let result =
                crate::app::custom_submit_action::project(session, Some(operation_id.clone()));
            if let Ok(value) = serde_json::to_value(&result) {
                let _ = state.journal.finish_action(&operation_id, &value);
            }
        }
    };
    if let Some(previous) = state.custom_submit.prior(&request)? {
        settle(&previous);
        return Ok(crate::app::custom_submit_action::project(
            &previous,
            Some(operation_id),
        ));
    }
    let payload = serde_json::json!({
        "changeId": request.change_id,
        "requestId": request.request_id,
        "connection": request.connection,
    });
    match state.journal.reserve_action(
        crate::app::custom_submit_action::KIND_CUSTOM_SUBMIT,
        &operation_id,
        &scope,
        &payload,
    )? {
        crate::persistence::operation_journal::action_receipts::Reservation::New => {}
        crate::persistence::operation_journal::action_receipts::Reservation::Existing(receipt) => {
            return receipt
                .result
                .map(serde_json::from_value)
                .transpose()
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "Existing operation is running or interrupted; query receipt, never retry with a new ID".to_owned());
        }
    }
    let _group = state
        .runner
        .begin_operation_group(format!("custom:{}", request.request_id));
    let guard = state
        .runner
        .lock_write_transaction(&context, &format!("custom:{}", request.request_id))
        .await
        .inspect_err(|error| {
            let failed = crate::app::custom_submit_action::failed_result(
                &operation_id,
                &request.change_id,
                error.as_str(),
            );
            if let Ok(value) = serde_json::to_value(&failed) {
                let _ = state.journal.finish_action(&operation_id, &value);
            }
        })?;
    let connection = state.connection.clone();
    let host = state.custom_submit.clone();
    let observer = host.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        connection.with_custom_submit_context(|profile, generation, context| {
            let current =
                crate::app::company_submit::from_host_snapshot(profile, generation, context)
                    .map_err(|_| "invalidConnection".to_owned())?;
            host.start_admitted(
                request,
                &current,
                &context.custom_submit_executable_path,
                guard,
            )
        })
    })
    .await
    .map_err(|_| "outcomeUnknown".to_owned())?;
    crate::app::custom_submit::watch(observer, app);
    match result {
        Ok(session) => {
            settle(&session);
            Ok(crate::app::custom_submit_action::project(
                &session,
                Some(operation_id),
            ))
        }
        Err(error) => {
            let failed = crate::app::custom_submit_action::failed_result(&operation_id, "", &error);
            if let Ok(value) = serde_json::to_value(&failed) {
                let _ = state.journal.finish_action(&operation_id, &value);
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub fn custom_submit_status(
    _admission: crate::close_guard::Admission,
    state: State<'_, AppState>,
) -> Option<crate::app::custom_submit_action::CustomSubmitActionResult> {
    let session = state.custom_submit.status()?;
    let result = crate::app::custom_submit_action::project(&session, None);
    if crate::app::custom_submit_action::is_terminal(&session) {
        if let Ok(value) = serde_json::to_value(&result) {
            let _ = state.journal.finish_action(&session.request_id, &value);
        }
    }
    Some(result)
}

/// Reads one existing in-memory snapshot. No CLI discovery or tool evidence.
#[tauri::command]
pub fn company_submit_connection_snapshot(
    _admission: crate::close_guard::Admission,
    state: State<'_, AppState>,
) -> Result<crate::app::company_submit::ConnectionSnapshot, crate::app::company_submit::Error> {
    let (profile_id, generation, context) = state.connection.swarm_snapshot();
    crate::app::company_submit::from_host_snapshot(profile_id, generation, &context)
}

#[tauri::command]
pub async fn workspace_disk_usage(
    _admission: crate::close_guard::Admission,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
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
    _admission: crate::close_guard::Admission,
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
            .decorations(true)
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
    _admission: crate::close_guard::Admission,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Vec<crate::p4::streams::StreamSummary>, String> {
    crate::p4::streams::list(&state.runner, state.connection.context(), &app).await
}

#[tauri::command]
pub async fn query_stream_graph(
    _admission: crate::close_guard::Admission,
    query: StreamGraphQuery,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<StreamGraphResult, StreamGraphRequestError> {
    state.stream_graph.query(query, Some(&app)).await
}

#[tauri::command]
pub async fn query_branch_mappings(
    _admission: crate::close_guard::Admission,
    query: BranchMappingQuery,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<BranchMappingPage, BranchMappingRequestError> {
    state.branch_mappings.list(query, Some(&app)).await
}

#[tauri::command]
pub async fn get_branch_mapping_detail(
    _admission: crate::close_guard::Admission,
    query: BranchMappingDetailQuery,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<BranchMappingDetailResult, BranchMappingRequestError> {
    state.branch_mappings.detail(query, Some(&app)).await
}

#[tauri::command]
pub async fn preview_branch_mapping_impact(
    _admission: crate::close_guard::Admission,
    query: BranchImpactPreviewQuery,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<BranchImpactPreview, BranchMappingRequestError> {
    state.branch_mappings.preview(query, Some(&app)).await
}

#[tauri::command]
pub async fn preflight_branch_mapping_mutation(
    _admission: crate::close_guard::Admission,
    request: BranchMutationPreflightRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<BranchMutationPreflight, String> {
    Ok(state.branch_mappings.preflight(request, Some(&app)).await)
}

#[tauri::command]
pub async fn confirm_branch_mapping_mutation(
    _admission: crate::close_guard::Admission,
    confirmation: BranchMutationConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<BranchMutationResult, String> {
    let mut confirmation = confirmation;
    let id = confirmation
        .operation_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    confirmation.operation_id = Some(id.clone());
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection")?;
    let payload = serde_json::to_value(&confirmation).map_err(|e| e.to_string())?;
    match state
        .journal
        .reserve_action("branchMapping", &id, &scope, &payload)?
    {
        crate::persistence::operation_journal::action_receipts::Reservation::New => {}
        crate::persistence::operation_journal::action_receipts::Reservation::Existing(receipt) => {
            return receipt
                .result
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| e.to_string())?
                .ok_or("Existing operation is running or interrupted; query receipt, never retry with a new ID".into());
        }
    }
    let _group = state.runner.begin_operation_group(id.clone());
    let guard = state.runner.lock_write_transaction(&context, &id).await?;
    let mut result = state
        .branch_mappings
        .confirm_admitted(confirmation, &guard, Some(&app))
        .await;
    let verified = matches!(
        result.outcome,
        BranchMutationOutcome::Succeeded | BranchMutationOutcome::Rejected
    );
    if let Err(error) = state.journal.finish_action(
        &id,
        &serde_json::to_value(&result).map_err(|e| e.to_string())?,
    ) {
        result.outcome = BranchMutationOutcome::Unknown;
        result.failure = Some(BranchMutationFailureCode::UncertainOutcome);
        result.message = format!("The Branch Mapping receipt could not be persisted ({error}); treat the outcome as unknown, refresh, and do not retry with a new ID.");
        let _ = guard.finish(false);
        return Ok(result);
    }
    guard.finish(verified)?;
    Ok(result)
}

#[tauri::command]
pub async fn preflight_stream_switch(
    _admission: crate::close_guard::Admission,
    request: StreamSwitchPreflightRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<StreamSwitchPreflight, String> {
    Ok(state.stream_switch.preflight(request, Some(&app)).await)
}

#[tauri::command]
pub async fn confirm_stream_switch(
    _admission: crate::close_guard::Admission,
    confirmation: StreamSwitchConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<StreamSwitchResult, String> {
    let mut confirmation = confirmation;
    let id = confirmation
        .operation_id
        .clone()
        .unwrap_or_else(|| format!("stream-switch-{}", uuid::Uuid::new_v4()));
    confirmation.operation_id = Some(id.clone());
    let expected_generation = confirmation.target.context_generation;
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection")?;
    let payload = serde_json::to_value(&confirmation).map_err(|e| e.to_string())?;
    match state
        .journal
        .reserve_action("streamSwitch", &id, &scope, &payload)?
    {
        crate::persistence::operation_journal::action_receipts::Reservation::New => {}
        crate::persistence::operation_journal::action_receipts::Reservation::Existing(receipt) => {
            return receipt
                .result
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| e.to_string())?
                .ok_or("Existing operation is running or interrupted; query receipt, never retry with a new ID".into());
        }
    }
    let _group = state.runner.begin_operation_group(id.clone());
    let guard = state.runner.lock_write_transaction(&context, &id).await?;
    let mut result = state
        .stream_switch
        .confirm_admitted(confirmation, &guard, Some(&app))
        .await;
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
    let verified = result.outcome == StreamSwitchOutcome::Succeeded
        && (result.runtime.is_some() || !result.stream_changed);
    if let Err(error) = state.journal.finish_action(
        &id,
        &serde_json::to_value(&result).map_err(|e| e.to_string())?,
    ) {
        result.outcome = StreamSwitchOutcome::Unknown;
        result.failure = Some(StreamSwitchFailureCode::UncertainOutcome);
        result.message = format!("The stream switch receipt could not be persisted ({error}); treat the outcome as unknown, refresh, and do not retry with a new ID.");
        let _ = guard.finish(false);
        return Ok(result);
    }
    guard.finish(verified)?;
    Ok(result)
}

#[tauri::command]
pub async fn list_user_workspaces(
    _admission: crate::close_guard::Admission,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Vec<crate::p4::workspaces::ClientWorkspace>, String> {
    crate::p4::workspaces::list(&state.runner, state.connection.context(), Some(&app)).await
}

#[tauri::command]
pub async fn browse_connection_users(
    _admission: crate::close_guard::Admission,
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
    _admission: crate::close_guard::Admission,
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
    _admission: crate::close_guard::Admission,
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
    _admission: crate::close_guard::Admission,
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
    _admission: crate::close_guard::Admission,
    confirmation: ConnectionSpecCreateConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ConnectionSpecCreateResult, String> {
    confirm_connection_spec_create(ConnectionSpecKind::UserSelf, confirmation, &state, &app).await
}

#[tauri::command]
pub async fn confirm_create_connection_workspace(
    _admission: crate::close_guard::Admission,
    confirmation: ConnectionSpecCreateConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ConnectionSpecCreateResult, String> {
    confirm_connection_spec_create(ConnectionSpecKind::Workspace, confirmation, &state, &app).await
}

#[tauri::command]
pub async fn runtime_info(
    _admission: crate::close_guard::Admission,
    state: State<'_, AppState>,
) -> Result<RuntimeInfo, String> {
    let connection = state.connection.clone();
    tauri::async_runtime::spawn_blocking(move || connection.runtime_info())
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_connection_profiles(
    _admission: crate::close_guard::Admission,
    state: State<'_, AppState>,
) -> ConnectionProfiles {
    state.connection.profiles()
}

#[tauri::command]
pub fn get_active_connection_profile(
    _admission: crate::close_guard::Admission,
    state: State<'_, AppState>,
) -> Option<ConnectionProfile> {
    state.connection.active_profile()
}

fn profile_control_error(message: String) -> ConnectionProfileError {
    ConnectionProfileError {
        code: ConnectionProfileErrorCode::PersistenceFailed,
        message,
    }
}

/// The requested settings cannot form a journal scope. That is a request/input
/// problem, never a storage write failure, so it must not surface the localized
/// "check disk and permissions" copy that `persistenceFailed` carries.
fn profile_invalid_context() -> ConnectionProfileError {
    profile_switch_error(
        ConnectionProfileErrorCode::InvalidInput,
        "The requested connection settings are incomplete or invalid.",
    )
}

fn profile_not_found() -> ConnectionProfileError {
    profile_switch_error(
        ConnectionProfileErrorCode::NotFound,
        "The connection profile was not found. Reload the saved connections and retry.",
    )
}

/// Scope for local connection-store writes (create/update/delete/activate).
///
/// Those writes are valid while no profile is active (first save, or after the
/// active profile was deleted), so an absent active profile becomes the empty
/// `profileId` the UI itself reports for "no active profile". P4 actions keep
/// using `from_host_snapshot`, which still requires an active profile.
fn profile_write_scope(
    profile: Option<String>,
    generation: u64,
    context: &P4Context,
) -> Result<crate::app::company_submit::ConnectionSnapshot, ConnectionProfileError> {
    crate::app::company_submit::from_profile_write(profile, generation, context)
        .map_err(|_| profile_invalid_context())
}

#[tauri::command]
pub async fn create_connection_profile(
    _admission: crate::close_guard::Admission,
    mut request: CreateConnectionProfileRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ConnectionProfiles, ConnectionProfileError> {
    use tauri::Emitter;
    let id = request
        .operation_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    request.operation_id = Some(id.clone());
    let (profile, generation, _active) = state.connection.swarm_snapshot();
    let scope = profile_write_scope(profile, generation, &request.context)?;
    let payload = serde_json::json!({ "kind": "profileCreate", "name": request.name, "expectedRevision": request.expected_revision });
    match state
        .journal
        .reserve_action("connectionProfileCreate", &id, &scope, &payload)
        .map_err(|error| profile_control_error(error.to_string()))?
    {
        crate::persistence::operation_journal::action_receipts::Reservation::New => {}
        crate::persistence::operation_journal::action_receipts::Reservation::Existing(receipt) => {
            return receipt
                .result
                .map(serde_json::from_value)
                .transpose()
                .map_err(|error| profile_control_error(error.to_string()))?
                .ok_or_else(|| profile_control_error("Existing operation is running or interrupted; query receipt, never retry with a new ID.".into()));
        }
    }
    let _group = state.runner.begin_operation_group(id.clone());
    let guard = state
        .runner
        .lock_write_transaction(&request.context, &id)
        .await
        .map_err(|error| profile_control_error(error.to_string()))?;
    let before = state.connection.context();
    let profiles = match state.connection.create_profile(request, Some(&app)).await {
        Ok(profiles) => profiles,
        Err(error) => {
            let _ = state.journal.finish_action(
                &id,
                &serde_json::json!({ "outcome": "rejected", "code": format!("{:?}", error.code) }),
            );
            let _ = guard.finish(false);
            return Err(error);
        }
    };
    if before != state.connection.context() {
        invalidate_after_context_change(&state);
        let _ = app.emit("connection-changed", state.connection.runtime_info());
    }
    if let Err(error) = state.journal.finish_action(
        &id,
        &serde_json::to_value(&profiles)
            .map_err(|error| profile_control_error(error.to_string()))?,
    ) {
        let _ = guard.finish(false);
        return Err(profile_control_error(format!("The profile receipt could not be persisted ({error}); treat the outcome as unknown and do not retry with a new ID.")));
    }
    guard
        .finish(true)
        .map_err(|error| profile_control_error(error.to_string()))?;
    Ok(profiles)
}

#[tauri::command]
pub async fn update_connection_profile(
    _admission: crate::close_guard::Admission,
    mut request: UpdateConnectionProfileRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ConnectionProfiles, ConnectionProfileError> {
    use tauri::Emitter;
    let id = request
        .operation_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    request.operation_id = Some(id.clone());
    let (profile, generation, _active) = state.connection.swarm_snapshot();
    let scope = profile_write_scope(profile, generation, &request.context)?;
    let payload = serde_json::json!({ "kind": "profileUpdate", "id": request.id, "expectedRevision": request.expected_revision });
    match state
        .journal
        .reserve_action("connectionProfileUpdate", &id, &scope, &payload)
        .map_err(|error| profile_control_error(error.to_string()))?
    {
        crate::persistence::operation_journal::action_receipts::Reservation::New => {}
        crate::persistence::operation_journal::action_receipts::Reservation::Existing(receipt) => {
            return receipt
                .result
                .map(serde_json::from_value)
                .transpose()
                .map_err(|error| profile_control_error(error.to_string()))?
                .ok_or_else(|| profile_control_error("Existing operation is running or interrupted; query receipt, never retry with a new ID.".into()));
        }
    }
    let _group = state.runner.begin_operation_group(id.clone());
    let guard = state
        .runner
        .lock_write_transaction(&request.context, &id)
        .await
        .map_err(|error| profile_control_error(error.to_string()))?;
    let before = state.connection.context();
    let profiles = match state.connection.update_profile(request, Some(&app)).await {
        Ok(profiles) => profiles,
        Err(error) => {
            let _ = state.journal.finish_action(
                &id,
                &serde_json::json!({ "outcome": "rejected", "code": format!("{:?}", error.code) }),
            );
            let _ = guard.finish(false);
            return Err(error);
        }
    };
    if before != state.connection.context() {
        invalidate_after_context_change(&state);
        let _ = app.emit("connection-changed", state.connection.runtime_info());
    }
    if let Err(error) = state.journal.finish_action(
        &id,
        &serde_json::to_value(&profiles)
            .map_err(|error| profile_control_error(error.to_string()))?,
    ) {
        let _ = guard.finish(false);
        return Err(profile_control_error(format!("The profile receipt could not be persisted ({error}); treat the outcome as unknown and do not retry with a new ID.")));
    }
    guard
        .finish(true)
        .map_err(|error| profile_control_error(error.to_string()))?;
    Ok(profiles)
}

#[tauri::command]
pub async fn delete_connection_profile(
    _admission: crate::close_guard::Admission,
    mut request: DeleteConnectionProfileRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ConnectionProfiles, ConnectionProfileError> {
    use tauri::Emitter;
    let id = request
        .operation_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    request.operation_id = Some(id.clone());
    let (profile, generation, active) = state.connection.swarm_snapshot();
    // Scope the store write to the target profile; no active profile is required.
    let target = state
        .connection
        .profile(&request.id)
        .ok_or_else(profile_not_found)?;
    let scope = profile_write_scope(profile, generation, &target.context)?;
    let payload = serde_json::json!({ "kind": "profileDelete", "id": request.id, "expectedRevision": request.expected_revision });
    match state
        .journal
        .reserve_action("connectionProfileDelete", &id, &scope, &payload)
        .map_err(|error| profile_control_error(error.to_string()))?
    {
        crate::persistence::operation_journal::action_receipts::Reservation::New => {}
        crate::persistence::operation_journal::action_receipts::Reservation::Existing(receipt) => {
            return receipt
                .result
                .map(serde_json::from_value)
                .transpose()
                .map_err(|error| profile_control_error(error.to_string()))?
                .ok_or_else(|| profile_control_error("Existing operation is running or interrupted; query receipt, never retry with a new ID.".into()));
        }
    }
    let _group = state.runner.begin_operation_group(id.clone());
    let guard = state
        .runner
        .lock_write_transaction(&active, &id)
        .await
        .map_err(|error| profile_control_error(error.to_string()))?;
    let before = state.connection.runtime_info().context_generation;
    let connection = state.connection.clone();
    let profiles = match tauri::async_runtime::spawn_blocking(move || {
        connection.delete_profile(request)
    })
    .await
    {
        Ok(Ok(profiles)) => profiles,
        Ok(Err(error)) => {
            let _ = state.journal.finish_action(
                &id,
                &serde_json::json!({ "outcome": "rejected", "code": format!("{:?}", error.code) }),
            );
            let _ = guard.finish(false);
            return Err(error);
        }
        Err(error) => {
            let _ = state.journal.finish_action(
                &id,
                &serde_json::json!({ "outcome": "unknown", "message": error.to_string() }),
            );
            let _ = guard.finish(false);
            return Err(profile_task_error(error.to_string()));
        }
    };
    let runtime = state.connection.runtime_info();
    if before != runtime.context_generation {
        invalidate_after_context_change(&state);
        let _ = app.emit("connection-changed", runtime);
    }
    if let Err(error) = state.journal.finish_action(
        &id,
        &serde_json::to_value(&profiles)
            .map_err(|error| profile_control_error(error.to_string()))?,
    ) {
        let _ = guard.finish(false);
        return Err(profile_control_error(format!("The profile receipt could not be persisted ({error}); treat the outcome as unknown and do not retry with a new ID.")));
    }
    guard
        .finish(true)
        .map_err(|error| profile_control_error(error.to_string()))?;
    Ok(profiles)
}

#[tauri::command]
pub async fn set_active_connection_profile(
    _admission: crate::close_guard::Admission,
    mut request: SetActiveConnectionProfileRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<RuntimeInfo, ConnectionProfileError> {
    use tauri::Emitter;
    let id = request
        .operation_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    request.operation_id = Some(id.clone());
    let (profile, generation, active) = state.connection.swarm_snapshot();
    // Scope the store write to the target profile; no active profile is required.
    let target = state
        .connection
        .profile(&request.id)
        .ok_or_else(profile_not_found)?;
    let scope = profile_write_scope(profile, generation, &target.context)?;
    let payload = serde_json::json!({ "kind": "profileSetActive", "id": request.id, "expectedRevision": request.expected_revision });
    match state
        .journal
        .reserve_action("connectionProfileSetActive", &id, &scope, &payload)
        .map_err(|error| profile_control_error(error.to_string()))?
    {
        crate::persistence::operation_journal::action_receipts::Reservation::New => {}
        crate::persistence::operation_journal::action_receipts::Reservation::Existing(receipt) => {
            return receipt
                .result
                .map(serde_json::from_value)
                .transpose()
                .map_err(|error| profile_control_error(error.to_string()))?
                .ok_or_else(|| profile_control_error("Existing operation is running or interrupted; query receipt, never retry with a new ID.".into()));
        }
    }
    let _group = state.runner.begin_operation_group(id.clone());
    let guard = state
        .runner
        .lock_write_transaction(&active, &id)
        .await
        .map_err(|error| profile_control_error(error.to_string()))?;
    let runtime = match state
        .connection
        .set_active_profile(request, Some(&app))
        .await
    {
        Ok(runtime) => runtime,
        Err(error) => {
            let _ = state.journal.finish_action(
                &id,
                &serde_json::json!({ "outcome": "rejected", "code": format!("{:?}", error.code) }),
            );
            let _ = guard.finish(false);
            return Err(error);
        }
    };
    invalidate_after_context_change(&state);
    let _ = app.emit("connection-changed", &runtime);
    if let Err(error) = state.journal.finish_action(
        &id,
        &serde_json::to_value(&runtime)
            .map_err(|error| profile_control_error(error.to_string()))?,
    ) {
        let _ = guard.finish(false);
        return Err(profile_control_error(format!("The profile receipt could not be persisted ({error}); treat the outcome as unknown and do not retry with a new ID.")));
    }
    guard
        .finish(true)
        .map_err(|error| profile_control_error(error.to_string()))?;
    Ok(runtime)
}

#[tauri::command]
pub async fn switch_workspace(
    _admission: crate::close_guard::Admission,
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
    _admission: crate::close_guard::Admission,
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
    _admission: crate::close_guard::Admission,
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
    _admission: crate::close_guard::Admission,
    context: P4Context,
    state: State<'_, AppState>,
) -> Result<ConnectionStatus, String> {
    Ok(state.connection.test_connection(context).await)
}

#[tauri::command]
pub async fn query_login_status(
    _admission: crate::close_guard::Admission,
    context: P4Context,
    state: State<'_, AppState>,
) -> Result<ConnectionStatus, String> {
    Ok(state.connection.login_status(context).await)
}

#[tauri::command]
pub async fn trust_server(
    _admission: crate::close_guard::Admission,
    mut request: TrustRequest,
    state: State<'_, AppState>,
) -> Result<ConnectionStatus, String> {
    let id = request
        .operation_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    request.operation_id = Some(id.clone());
    let (profile, generation, _active) = state.connection.swarm_snapshot();
    // Setup may trust an unsaved draft before the first profile exists.
    let scope =
        crate::app::company_submit::from_profile_write(profile, generation, &request.context)
            .map_err(|_| "invalidConnection")?;
    let payload = serde_json::json!({ "kind": "trust", "confirmed": request.confirmed });
    match state
        .journal
        .reserve_action("authTrust", &id, &scope, &payload)?
    {
        crate::persistence::operation_journal::action_receipts::Reservation::New => {}
        crate::persistence::operation_journal::action_receipts::Reservation::Existing(receipt) => {
            return receipt
                .result
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| e.to_string())?
                .ok_or("Existing operation is running or interrupted; query receipt, never retry with a new ID".into());
        }
    }
    let _group = state.runner.begin_operation_group(id.clone());
    let guard = state
        .runner
        .lock_write_transaction(&request.context, &id)
        .await?;
    let status = state.connection.trust(request).await;
    let verified = status.error_code.is_none();
    if let Err(error) = state.journal.finish_action(
        &id,
        &serde_json::to_value(&status).map_err(|e| e.to_string())?,
    ) {
        let _ = guard.finish(false);
        return Err(format!("The trust receipt could not be persisted ({error}); treat the outcome as unknown, refresh, and do not retry with a new ID."));
    }
    guard.finish(verified)?;
    Ok(status)
}

#[tauri::command]
pub async fn login(
    _admission: crate::close_guard::Admission,
    mut request: LoginRequest,
    state: State<'_, AppState>,
) -> Result<ConnectionStatus, String> {
    let id = request
        .operation_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    request.operation_id = Some(id.clone());
    let (profile, generation, _active) = state.connection.swarm_snapshot();
    // Setup may log in an unsaved draft before the first profile exists.
    let scope =
        crate::app::company_submit::from_profile_write(profile, generation, &request.context)
            .map_err(|_| "invalidConnection")?;
    // Credential material is never serialized into the receipt: only the intent is recorded.
    let payload = serde_json::json!({ "kind": "login", "confirmed": request.confirmed });
    match state
        .journal
        .reserve_action("authLogin", &id, &scope, &payload)?
    {
        crate::persistence::operation_journal::action_receipts::Reservation::New => {}
        crate::persistence::operation_journal::action_receipts::Reservation::Existing(receipt) => {
            return receipt
                .result
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| e.to_string())?
                .ok_or("Existing operation is running or interrupted; query receipt, never retry with a new ID".into());
        }
    }
    let _group = state.runner.begin_operation_group(id.clone());
    let guard = state
        .runner
        .lock_write_transaction(&request.context, &id)
        .await?;
    let status = state.connection.login(request).await;
    let verified = status.state == ConnectionState::Connected && status.error_code.is_none();
    if let Err(error) = state.journal.finish_action(
        &id,
        &serde_json::to_value(&status).map_err(|e| e.to_string())?,
    ) {
        let _ = guard.finish(false);
        return Err(format!("The login receipt could not be persisted ({error}); treat the outcome as unknown, refresh, and do not retry with a new ID."));
    }
    guard.finish(verified)?;
    Ok(status)
}

#[tauri::command]
pub async fn logout(
    _admission: crate::close_guard::Admission,
    mut request: AuthenticationRequest,
    state: State<'_, AppState>,
) -> Result<ConnectionStatus, String> {
    let id = request
        .operation_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    request.operation_id = Some(id.clone());
    let (profile, generation, _active) = state.connection.swarm_snapshot();
    // Setup may log out an unsaved draft before the first profile exists.
    let scope =
        crate::app::company_submit::from_profile_write(profile, generation, &request.context)
            .map_err(|_| "invalidConnection")?;
    let payload = serde_json::json!({ "kind": "logout", "confirmed": request.confirmed });
    match state
        .journal
        .reserve_action("authLogout", &id, &scope, &payload)?
    {
        crate::persistence::operation_journal::action_receipts::Reservation::New => {}
        crate::persistence::operation_journal::action_receipts::Reservation::Existing(receipt) => {
            return receipt
                .result
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| e.to_string())?
                .ok_or("Existing operation is running or interrupted; query receipt, never retry with a new ID".into());
        }
    }
    let _group = state.runner.begin_operation_group(id.clone());
    let guard = state
        .runner
        .lock_write_transaction(&request.context, &id)
        .await?;
    let status = state.connection.logout(request).await;
    let verified = status.state != ConnectionState::Connected && status.error_code.is_none();
    if let Err(error) = state.journal.finish_action(
        &id,
        &serde_json::to_value(&status).map_err(|e| e.to_string())?,
    ) {
        let _ = guard.finish(false);
        return Err(format!("The logout receipt could not be persisted ({error}); treat the outcome as unknown, refresh, and do not retry with a new ID."));
    }
    guard.finish(verified)?;
    Ok(status)
}

#[tauri::command]
pub async fn run_p4(
    _admission: crate::close_guard::Admission,
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
pub fn cancel_all_operations(
    _admission: crate::close_guard::Admission,
    state: State<'_, AppState>,
) -> crate::domain::CancelOperationResult {
    let matched = state.runner.cancel_all();
    crate::domain::CancelOperationResult {
        operation_id: "all".into(),
        state: if matched > 0 {
            "cancelRequested"
        } else {
            "notFound"
        }
        .into(),
        matched_operations: matched,
        server_rollback_claimed: false,
        message: if matched > 0 {
            "Cancellation was requested for live operations. This is not a rollback: submitted or already-applied effects are not undone and no automatic retry will run.".into()
        } else {
            "No live operation matched. Nothing was cancelled by this call; this is not proof that no work previously completed.".into()
        },
    }
}

#[tauri::command]
pub fn cancel_operation(
    _admission: crate::close_guard::Admission,
    operation_id: String,
    state: State<'_, AppState>,
) -> crate::domain::CancelOperationResult {
    if operation_id.trim().is_empty() || operation_id.len() > 256 {
        return crate::domain::CancelOperationResult {
            operation_id,
            state: "unknown".into(),
            matched_operations: 0,
            server_rollback_claimed: false,
            message: "Invalid operation id; no cancellation was requested.".into(),
        };
    }
    let matched = state.runner.cancel(&operation_id);
    state.search.cancel(&operation_id);
    state.stream_graph.cancel(&operation_id);
    state.branch_mappings.cancel(&operation_id);
    let state_name = if matched > 0 {
        "cancelRequested"
    } else {
        "notFound"
    };
    crate::domain::CancelOperationResult {
        operation_id,
        state: state_name.into(),
        matched_operations: matched,
        server_rollback_claimed: false,
        message: if matched > 0 {
            "Cancellation was requested for the exact operation and its children. This is not a rollback: completed writes/submits are not undone and no automatic retry will run.".into()
        } else {
            "No live operation matched this exact id. Nothing was cancelled by this call; this is not proof that no work previously completed.".into()
        },
    }
}

#[tauri::command]
pub async fn global_search(
    _admission: crate::close_guard::Admission,
    query: GlobalSearchQuery,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<GlobalSearchResult, GlobalSearchRequestError> {
    state.search.query(query, Some(&app)).await
}

#[tauri::command]
pub fn query_logs(
    _admission: crate::close_guard::Admission,
    query: LogQuery,
    state: State<'_, AppState>,
) -> Vec<LogEntry> {
    state.logs.query(&query)
}

#[tauri::command]
pub fn query_log_page(
    _admission: crate::close_guard::Admission,
    query: LogQuery,
    state: State<'_, AppState>,
) -> LogPage {
    state.logs.query_page(&query)
}

#[tauri::command]
pub fn get_log_policy(
    _admission: crate::close_guard::Admission,
    state: State<'_, AppState>,
) -> LogPolicy {
    state.logs.policy()
}

#[tauri::command]
pub fn set_log_policy(
    _admission: crate::close_guard::Admission,
    request: crate::app::control_plane_action::SetLogPolicyActionRequest,
    state: State<'_, AppState>,
) -> Result<crate::app::control_plane_action::ControlPlaneActionResult, String> {
    let operation_id = request.operation_id.clone();
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection".to_owned())?;
    if let Some(id) = operation_id.as_deref() {
        let payload = serde_json::to_value(&request).map_err(|error| error.to_string())?;
        match state.journal.reserve_action(
            crate::app::control_plane_action::KIND_LOG_POLICY_SET,
            id,
            &scope,
            &payload,
        )? {
            crate::persistence::operation_journal::action_receipts::Reservation::New => {}
            crate::persistence::operation_journal::action_receipts::Reservation::Existing(
                receipt,
            ) => {
                return receipt
                    .result
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| "Existing operation is running or interrupted; query receipt, never retry with a new ID".to_owned());
            }
        }
    }
    let legacy = state.logs.set_policy(request.policy);
    match legacy {
        Ok(written) => {
            let readback = state.logs.policy();
            let policy_file = crate::app::control_plane_action::file_facts(
                &state.logs.directory().join("policy.json"),
            );
            let result = crate::app::control_plane_action::project_log_policy_set(
                operation_id.clone(),
                &Ok(written),
                &readback,
                policy_file,
            );
            if let Some(id) = operation_id.as_deref() {
                let value = serde_json::to_value(&result).map_err(|error| error.to_string())?;
                state.journal.finish_action(id, &value)?;
            }
            Ok(result)
        }
        Err(error) => {
            if let Some(id) = operation_id.as_deref() {
                let failed = crate::app::control_plane_action::failed(
                    crate::app::control_plane_action::KIND_LOG_POLICY_SET,
                    Some(id.to_owned()),
                    &error,
                    crate::app::control_plane_action::ControlPlaneArtifact::missing(),
                );
                if let Ok(value) = serde_json::to_value(&failed) {
                    let _ = state.journal.finish_action(id, &value);
                }
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn open_logs_folder(
    _admission: crate::close_guard::Admission,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let path = state.logs.directory().to_owned();
    tauri::async_runtime::spawn_blocking(move || crate::app::system_open::open_log_directory(&path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn delete_all_logs(
    _admission: crate::close_guard::Admission,
    request: crate::app::control_plane_action::ClearLogsActionRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<crate::app::control_plane_action::ControlPlaneActionResult, String> {
    let operation_id = request.operation_id.clone();
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection".to_owned())?;
    if let Some(id) = operation_id.as_deref() {
        let payload = serde_json::to_value(&request).map_err(|error| error.to_string())?;
        match state.journal.reserve_action(
            crate::app::control_plane_action::KIND_LOG_CLEAR,
            id,
            &scope,
            &payload,
        )? {
            crate::persistence::operation_journal::action_receipts::Reservation::New => {}
            crate::persistence::operation_journal::action_receipts::Reservation::Existing(
                receipt,
            ) => {
                return receipt
                    .result
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| "Existing operation is running or interrupted; query receipt, never retry with a new ID".to_owned());
            }
        }
    }
    let logs = state.logs.clone();
    let legacy = tauri::async_runtime::spawn_blocking(move || logs.clear_all())
        .await
        .map_err(|error| error.to_string())?;
    match legacy {
        Ok(()) => {
            let remaining = state
                .logs
                .query_page(&crate::domain::LogQuery {
                    limit: Some(1),
                    ..Default::default()
                })
                .entries
                .len();
            let result = crate::app::control_plane_action::project_log_clear(
                operation_id.clone(),
                &Ok(()),
                remaining,
            );
            let _ = app.emit("logs-cleared", ());
            if let Some(id) = operation_id.as_deref() {
                let value = serde_json::to_value(&result).map_err(|error| error.to_string())?;
                state.journal.finish_action(id, &value)?;
            }
            Ok(result)
        }
        Err(error) => {
            if let Some(id) = operation_id.as_deref() {
                let failed = crate::app::control_plane_action::failed(
                    crate::app::control_plane_action::KIND_LOG_CLEAR,
                    Some(id.to_owned()),
                    &error,
                    crate::app::control_plane_action::ControlPlaneArtifact::missing(),
                );
                if let Ok(value) = serde_json::to_value(&failed) {
                    let _ = state.journal.finish_action(id, &value);
                }
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn export_diagnostics(
    _admission: crate::close_guard::Admission,
    request: crate::app::control_plane_action::DiagnosticsExportActionRequest,
    state: State<'_, AppState>,
) -> Result<crate::app::control_plane_action::ControlPlaneActionResult, String> {
    let operation_id = request.operation_id.clone();
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection".to_owned())?;
    if let Some(id) = operation_id.as_deref() {
        let payload = serde_json::to_value(&request).map_err(|error| error.to_string())?;
        match state.journal.reserve_action(
            crate::app::control_plane_action::KIND_DIAGNOSTICS_EXPORT,
            id,
            &scope,
            &payload,
        )? {
            crate::persistence::operation_journal::action_receipts::Reservation::New => {}
            crate::persistence::operation_journal::action_receipts::Reservation::Existing(
                receipt,
            ) => {
                return receipt
                    .result
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| "Existing operation is running or interrupted; query receipt, never retry with a new ID".to_owned());
            }
        }
    }
    let export_request = request.request.clone();
    let diagnostics = state.diagnostics.clone();
    let legacy = tauri::async_runtime::spawn_blocking(move || diagnostics.export(export_request))
        .await
        .map_err(|error| error.to_string())?;
    match legacy {
        Ok(value) => {
            let artifact =
                crate::app::control_plane_action::file_facts(std::path::Path::new(&value.path));
            let result = crate::app::control_plane_action::project_diagnostics_export(
                operation_id.clone(),
                &Ok(value),
                artifact,
            );
            if let Some(id) = operation_id.as_deref() {
                let value = serde_json::to_value(&result).map_err(|error| error.to_string())?;
                state.journal.finish_action(id, &value)?;
            }
            Ok(result)
        }
        Err(error) => {
            if let Some(id) = operation_id.as_deref() {
                let failed = crate::app::control_plane_action::failed(
                    crate::app::control_plane_action::KIND_DIAGNOSTICS_EXPORT,
                    Some(id.to_owned()),
                    &error,
                    crate::app::control_plane_action::ControlPlaneArtifact::missing(),
                );
                if let Ok(value) = serde_json::to_value(&failed) {
                    let _ = state.journal.finish_action(id, &value);
                }
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn create_config_backup(
    _admission: crate::close_guard::Admission,
    request: crate::app::control_plane_action::BackupCreateActionRequest,
    state: State<'_, AppState>,
) -> Result<crate::app::control_plane_action::ControlPlaneActionResult, String> {
    let operation_id = request.operation_id.clone();
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection".to_owned())?;
    if let Some(id) = operation_id.as_deref() {
        let payload = serde_json::to_value(&request).map_err(|error| error.to_string())?;
        match state.journal.reserve_action(
            crate::app::control_plane_action::KIND_BACKUP_CREATE,
            id,
            &scope,
            &payload,
        )? {
            crate::persistence::operation_journal::action_receipts::Reservation::New => {}
            crate::persistence::operation_journal::action_receipts::Reservation::Existing(
                receipt,
            ) => {
                return receipt
                    .result
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| "Existing operation is running or interrupted; query receipt, never retry with a new ID".to_owned());
            }
        }
    }
    let backup_request = request.request.clone();
    let backups = state.backups.clone();
    let legacy = tauri::async_runtime::spawn_blocking(move || backups.create(backup_request))
        .await
        .map_err(|error| error.to_string())?;
    match legacy {
        Ok(value) => {
            let artifact = crate::app::control_plane_action::file_facts(
                &state.backups.directory().join(&value.backup.file_name),
            );
            let result = crate::app::control_plane_action::project_backup_create(
                operation_id.clone(),
                &Ok(value),
                artifact,
            );
            if let Some(id) = operation_id.as_deref() {
                let value = serde_json::to_value(&result).map_err(|error| error.to_string())?;
                state.journal.finish_action(id, &value)?;
            }
            Ok(result)
        }
        Err(error) => {
            if let Some(id) = operation_id.as_deref() {
                let failed = crate::app::control_plane_action::failed(
                    crate::app::control_plane_action::KIND_BACKUP_CREATE,
                    Some(id.to_owned()),
                    &error,
                    crate::app::control_plane_action::ControlPlaneArtifact::missing(),
                );
                if let Ok(value) = serde_json::to_value(&failed) {
                    let _ = state.journal.finish_action(id, &value);
                }
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn list_config_backups(
    _admission: crate::close_guard::Admission,
    state: State<'_, AppState>,
) -> Result<crate::persistence::backup::ConfigBackupOverview, String> {
    let backups = state.backups.clone();
    tauri::async_runtime::spawn_blocking(move || backups.overview())
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn restore_config_backup(
    _admission: crate::close_guard::Admission,
    request: crate::app::control_plane_action::BackupRestoreActionRequest,
    state: State<'_, AppState>,
) -> Result<crate::app::control_plane_action::ControlPlaneActionResult, String> {
    let operation_id = request.operation_id.clone();
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection".to_owned())?;
    if let Some(id) = operation_id.as_deref() {
        let payload = serde_json::to_value(&request).map_err(|error| error.to_string())?;
        match state.journal.reserve_action(
            crate::app::control_plane_action::KIND_BACKUP_RESTORE,
            id,
            &scope,
            &payload,
        )? {
            crate::persistence::operation_journal::action_receipts::Reservation::New => {}
            crate::persistence::operation_journal::action_receipts::Reservation::Existing(
                receipt,
            ) => {
                return receipt
                    .result
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| "Existing operation is running or interrupted; query receipt, never retry with a new ID".to_owned());
            }
        }
    }
    let restore_request = request.request.clone();
    let backups = state.backups.clone();
    let legacy = tauri::async_runtime::spawn_blocking(move || backups.restore(restore_request))
        .await
        .map_err(|error| error.to_string())?;
    match legacy {
        Ok(value) => {
            let rollback = crate::app::control_plane_action::file_facts(
                &state.backups.directory().join(&value.rollback_file_name),
            );
            let pending = state.backups.overview().ok().and_then(|overview| {
                overview.pending_restore.map(|pending| {
                    crate::persistence::backup::ConfigBackupRestoreStatus {
                        state: crate::persistence::backup::RestoreState::Pending,
                        source_file_name: pending.source_file_name,
                        rollback_file_name: Some(pending.rollback_file_name),
                        completed_at: None,
                        message: None,
                    }
                })
            });
            let result = crate::app::control_plane_action::project_backup_restore(
                operation_id.clone(),
                &Ok(value),
                rollback,
                pending.as_ref(),
            );
            if let Some(id) = operation_id.as_deref() {
                let value = serde_json::to_value(&result).map_err(|error| error.to_string())?;
                state.journal.finish_action(id, &value)?;
            }
            Ok(result)
        }
        Err(error) => {
            if let Some(id) = operation_id.as_deref() {
                let failed = crate::app::control_plane_action::failed(
                    crate::app::control_plane_action::KIND_BACKUP_RESTORE,
                    Some(id.to_owned()),
                    &error,
                    crate::app::control_plane_action::ControlPlaneArtifact::missing(),
                );
                if let Ok(value) = serde_json::to_value(&failed) {
                    let _ = state.journal.finish_action(id, &value);
                }
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn open_config_backups_folder(
    _admission: crate::close_guard::Admission,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let path = state.backups.directory();
    tauri::async_runtime::spawn_blocking(move || crate::app::system_open::open_log_directory(&path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn status_cache_diagnostics(
    _admission: crate::close_guard::Admission,
    state: State<'_, AppState>,
) -> crate::app::status_cache::CacheDiagnostics {
    state.status_cache.diagnostics()
}

#[tauri::command]
pub fn query_operation_journal(
    _admission: crate::close_guard::Admission,
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
    _admission: crate::close_guard::Admission,
    operation_id: String,
    state: State<'_, AppState>,
) -> Option<crate::persistence::operation_journal::OperationRecord> {
    state.journal.get(&operation_id)
}

#[tauri::command]
pub async fn query_changelists(
    _admission: crate::close_guard::Admission,
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
    _admission: crate::close_guard::Admission,
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
    _admission: crate::close_guard::Admission,
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
    _admission: crate::close_guard::Admission,
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
    _admission: crate::close_guard::Admission,
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
    _admission: crate::close_guard::Admission,
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
    _admission: crate::close_guard::Admission,
    request: FileActionRequest,
    connection: Option<crate::app::company_submit::ConnectionSnapshot>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<FileActionResult, String> {
    if matches!(
        request.action,
        FileAction::Revert | FileAction::RevertUnchanged
    ) {
        return Err(
            "Revert must use confirm_revert_action with an exact connection snapshot".into(),
        );
    }
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
    if crate::app::generic_action::migrated(request.action)
        && !matches!(
            crate::p4::files::command::plan(&request)?,
            crate::p4::files::command::ActionPlan::DeleteLocal { .. }
        )
    {
        return perform_durable_file_action(
            request,
            connection.ok_or("A connection snapshot is required for modifying file actions")?,
            &state,
            &app,
        )
        .await;
    }
    state
        .files
        .perform(state.connection.context(), request, Some(&app))
        .await
}

#[tauri::command]
pub async fn preflight_rename_move(
    _admission: crate::close_guard::Admission,
    request: RenameMovePreflightRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<RenameMovePreflight, String> {
    Ok(state.rename.preflight(request, Some(&app)).await)
}

#[tauri::command]
pub async fn preflight_file_lock(
    _admission: crate::close_guard::Admission,
    request: FileLockPreflightRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<FileLockPreflight, String> {
    Ok(state.file_locks.preflight(request, Some(&app)).await)
}

#[tauri::command]
pub async fn confirm_file_lock(
    _admission: crate::close_guard::Admission,
    confirmation: FileLockConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<FileLockResult, String> {
    let mut confirmation = confirmation;
    let id = confirmation
        .operation_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    confirmation.operation_id = Some(id.clone());
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection")?;
    let payload = serde_json::to_value(&confirmation).map_err(|e| e.to_string())?;
    match state
        .journal
        .reserve_action("fileLock", &id, &scope, &payload)?
    {
        crate::persistence::operation_journal::action_receipts::Reservation::New => {}
        crate::persistence::operation_journal::action_receipts::Reservation::Existing(receipt) => {
            return receipt
                .result
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| e.to_string())?
                .ok_or("Existing operation is running or interrupted; query receipt, never retry with a new ID".into());
        }
    }
    let _group = state.runner.begin_operation_group(id.clone());
    let guard = state
        .file_locks
        .lock_write_transaction(&context, &id)
        .await?;
    let mut result = state
        .file_locks
        .confirm_admitted(confirmation, &guard, Some(&app))
        .await;
    if matches!(
        result.outcome,
        FileLockOutcome::Succeeded | FileLockOutcome::Partial | FileLockOutcome::Unknown
    ) {
        state.changelists.invalidate_pending_pages();
        state.search.clear_for_context_switch();
        state.files.clear_review_cache();
    }
    let verified = crate::app::file_lock_service::verified_completion(&result);
    if let Err(error) = state.journal.finish_action(
        &id,
        &serde_json::to_value(&result).map_err(|e| e.to_string())?,
    ) {
        result.outcome = FileLockOutcome::Unknown;
        result.failure = Some(FileLockFailureCode::UncertainOutcome);
        result.message = format!(
            "The lock receipt could not be persisted ({error}); treat the outcome as unknown, refresh, and do not retry with a new ID."
        );
        if let Some(execution) = result.execution.as_mut() {
            execution.outcome = "unknown".into();
        }
        let _ = guard.finish(false);
        return Ok(result);
    }
    guard.finish(verified)?;
    Ok(result)
}

#[tauri::command]
pub async fn confirm_rename_move(
    _admission: crate::close_guard::Admission,
    confirmation: RenameMoveConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<crate::app::local_io_action::LocalIoActionResult, String> {
    let operation_id = confirmation.operation_id.clone();
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection".to_owned())?;
    if let Some(id) = operation_id.as_deref() {
        let payload = serde_json::to_value(&confirmation).map_err(|e| e.to_string())?;
        match state.journal.reserve_action(
            crate::app::local_io_action::KIND_RENAME_MOVE,
            id,
            &scope,
            &payload,
        )? {
            crate::persistence::operation_journal::action_receipts::Reservation::New => {}
            crate::persistence::operation_journal::action_receipts::Reservation::Existing(
                receipt,
            ) => {
                return receipt
                    .result
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "Existing operation is running or interrupted; query receipt, never retry with a new ID".to_owned());
            }
        }
    }
    let legacy = state.rename.confirm(confirmation.clone(), Some(&app)).await;
    let mut facts = Vec::new();
    if let Some(id) = operation_id.as_deref() {
        let paths = vec![
            confirmation.target.source.depot_path.clone(),
            confirmation.target.target.depot_path.clone(),
        ];
        if let Ok(bounded) = crate::app::local_io_action::recheck_facts(
            &state.runner,
            &context,
            &paths,
            id,
            Some(&app),
        )
        .await
        {
            facts = bounded;
        }
    }
    let result = crate::app::local_io_action::project_rename(
        operation_id.clone(),
        &legacy,
        &facts,
        &confirmation.target.source.depot_path,
        &confirmation.target.target.depot_path,
    );
    if let Some(id) = operation_id.as_deref() {
        let value = serde_json::to_value(&result).map_err(|e| e.to_string())?;
        state.journal.finish_action(id, &value)?;
    }
    Ok(result)
}

#[tauri::command]
pub async fn inspect_p4vfs(
    _admission: crate::close_guard::Admission,
    request: P4VfsInspectRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<P4VfsStatus, String> {
    state.vfs.inspect(request, Some(&app)).await
}

#[tauri::command]
pub async fn preview_sync(
    _admission: crate::close_guard::Admission,
    request: SyncPreviewRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<SyncPreviewPlan, String> {
    Ok(state.sync.preview(request, Some(&app)).await)
}

#[tauri::command]
pub async fn confirm_sync(
    _admission: crate::close_guard::Admission,
    confirmation: SyncConfirmRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<crate::app::local_io_action::LocalIoActionResult, String> {
    let operation_id = confirmation.operation_id.clone();
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection".to_owned())?;
    if let Some(id) = operation_id.as_deref() {
        let payload = serde_json::to_value(&confirmation).map_err(|e| e.to_string())?;
        match state.journal.reserve_action(
            crate::app::local_io_action::KIND_SYNC_REVISION,
            id,
            &scope,
            &payload,
        )? {
            crate::persistence::operation_journal::action_receipts::Reservation::New => {}
            crate::persistence::operation_journal::action_receipts::Reservation::Existing(
                receipt,
            ) => {
                return receipt
                    .result
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "Existing operation is running or interrupted; query receipt, never retry with a new ID".to_owned());
            }
        }
    }
    let paths = confirmation.target.paths.clone();
    let proof = crate::app::local_io_action::sync_revision_proof(&confirmation.target.revision);
    let legacy = state.sync.confirm(confirmation.clone(), Some(&app)).await;
    let mut facts = Vec::new();
    if let Some(id) = operation_id.as_deref() {
        if let Ok(bounded) = crate::app::local_io_action::recheck_facts(
            &state.runner,
            &context,
            &paths,
            id,
            Some(&app),
        )
        .await
        {
            facts = bounded;
        }
    }
    let result = crate::app::local_io_action::project_sync(
        operation_id.clone(),
        &legacy,
        &facts,
        &paths,
        proof,
    );
    if let Some(id) = operation_id.as_deref() {
        let value = serde_json::to_value(&result).map_err(|e| e.to_string())?;
        state.journal.finish_action(id, &value)?;
    }
    Ok(result)
}

#[tauri::command]
pub async fn get_diff(
    _admission: crate::close_guard::Admission,
    request: DiffRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<DiffResult, String> {
    state.files.diff(request, Some(&app)).await
}

#[tauri::command]
pub async fn get_shelf_file_preview(
    _admission: crate::close_guard::Admission,
    request: ShelfFilePreviewRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ShelfFilePreview, String> {
    state.files.shelf_preview(request, Some(&app)).await
}

#[tauri::command]
pub async fn get_file_preview(
    _admission: crate::close_guard::Admission,
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
    _admission: crate::close_guard::Admission,
    request: FileHistoryRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<FileHistoryPage, String> {
    state.files.history(request, Some(&app)).await
}

#[tauri::command]
pub async fn get_revision_graph(
    _admission: crate::close_guard::Admission,
    request: RevisionGraphRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<RevisionGraph, String> {
    state.files.graph(request, Some(&app)).await
}

#[tauri::command]
pub async fn query_pending_changes(
    _admission: crate::close_guard::Admission,
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
    _admission: crate::close_guard::Admission,
    request: PendingChangeMutationRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<crate::app::pending_cl_action::PendingClActionResult, String> {
    if matches!(&request.mutation, PendingChangeMutation::MoveFiles { .. }) {
        return Err("GUI file moves must use the move preflight and confirmation APIs".into());
    }
    let operation_id = request.operation_id.clone();
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection".to_owned())?;
    if let Some(id) = operation_id.as_deref() {
        let kind = crate::app::pending_cl_action::kind_for(&request.mutation);
        let payload = serde_json::to_value(&request).map_err(|error| error.to_string())?;
        match state.journal.reserve_action(kind, id, &scope, &payload)? {
            crate::persistence::operation_journal::action_receipts::Reservation::New => {}
            crate::persistence::operation_journal::action_receipts::Reservation::Existing(
                receipt,
            ) => {
                return receipt
                    .result
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| "Existing operation is running or interrupted; query receipt, never retry with a new ID".to_owned());
            }
        }
    }
    match state
        .changelists
        .mutate_pending(state.connection.context(), request.clone(), Some(&app))
        .await
    {
        Ok(legacy) => {
            state.workflows.clear_shelf_details();
            let result = crate::app::pending_cl_action::project(
                &request.mutation,
                operation_id.clone(),
                &legacy,
            );
            if let Some(id) = operation_id.as_deref() {
                let value = serde_json::to_value(&result).map_err(|error| error.to_string())?;
                state.journal.finish_action(id, &value)?;
            }
            Ok(result)
        }
        Err(error) => {
            if let Some(id) = operation_id.as_deref() {
                let failed =
                    crate::app::pending_cl_action::failed_result(&request.mutation, id, &error);
                let value = serde_json::to_value(&failed).map_err(|error| error.to_string())?;
                let _ = state.journal.finish_action(id, &value);
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn get_shelf_detail(
    _admission: crate::close_guard::Admission,
    request: ShelfDetailRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ShelfDetail, ShelfDetailRequestError> {
    state.workflows.shelf_detail(request, Some(&app)).await
}

#[tauri::command]
pub async fn preflight_move_files(
    _admission: crate::close_guard::Admission,
    request: MoveFilesPreflightRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<MoveFilesPreflight, String> {
    Ok(state.workflows.preflight_move(request, Some(&app)).await)
}

#[tauri::command]
pub async fn confirm_move_files(
    _admission: crate::close_guard::Admission,
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
    _admission: crate::close_guard::Admission,
    request: SubmitPreflightRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<SubmitPreflight, String> {
    Ok(state.submit.preflight(request, Some(&app)).await)
}

#[tauri::command]
pub async fn confirm_submit(
    _admission: crate::close_guard::Admission,
    confirmation: SubmitConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<SubmitResult, String> {
    let mut confirmation = confirmation;
    let id = confirmation
        .operation_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    confirmation.operation_id = Some(id.clone());
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection")?;
    let payload = serde_json::to_value(&confirmation).map_err(|e| e.to_string())?;
    match state
        .journal
        .reserve_action("submit", &id, &scope, &payload)?
    {
        crate::persistence::operation_journal::action_receipts::Reservation::New => {}
        crate::persistence::operation_journal::action_receipts::Reservation::Existing(receipt) => {
            return receipt
                .result
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| e.to_string())?
                .ok_or("Existing operation is running or interrupted; query receipt, never retry with a new ID".into());
        }
    }
    let _group = state.runner.begin_operation_group(id.clone());
    let guard = state.runner.lock_write_transaction(&context, &id).await?;
    let mut result = state
        .submit
        .confirm_admitted(confirmation, &guard, Some(&app))
        .await;
    if result.outcome == SubmitOutcome::Submitted {
        state.changelists.invalidate_pending_pages();
        state.search.clear_for_context_switch();
        state.files.clear_review_cache();
    }
    let verified = result.outcome == SubmitOutcome::Submitted || result.execution.is_none();
    if let Err(error) = state.journal.finish_action(
        &id,
        &serde_json::to_value(&result).map_err(|e| e.to_string())?,
    ) {
        result.outcome = SubmitOutcome::Unknown;
        result.failure = Some(SubmitFailureCode::UncertainOutcome);
        result.message = format!(
            "The submit receipt could not be persisted ({error}); treat the outcome as unknown, refresh, and do not retry with a new ID."
        );
        if let Some(execution) = result.execution.as_mut() {
            execution.state = "unknown".into();
            execution.outcome = SubmitOutcome::Unknown;
        }
        let _ = guard.finish(false);
        return Ok(result);
    }
    guard.finish(verified)?;
    Ok(result)
}

#[tauri::command]
pub async fn preflight_shelf(
    _admission: crate::close_guard::Admission,
    request: ShelfPreflightRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ShelfPreflight, String> {
    Ok(state.workflows.preflight_shelf(request, Some(&app)).await)
}

#[tauri::command]
pub async fn confirm_shelf(
    _admission: crate::close_guard::Admission,
    confirmation: WorkflowConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<WorkflowResult, String> {
    let mut confirmation = confirmation;
    let id = confirmation
        .operation_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    confirmation.operation_id = Some(id.clone());
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection")?;
    let payload = serde_json::to_value(&confirmation).map_err(|e| e.to_string())?;
    match state
        .journal
        .reserve_action("shelf", &id, &scope, &payload)?
    {
        crate::persistence::operation_journal::action_receipts::Reservation::New => {}
        crate::persistence::operation_journal::action_receipts::Reservation::Existing(receipt) => {
            return receipt.result.map(serde_json::from_value).transpose().map_err(|e|e.to_string())?.ok_or("Existing operation is running or interrupted; query receipt, never retry with a new ID".into());
        }
    }
    let _group = state.runner.begin_operation_group(id.clone());
    let guard = state.runner.lock_write_transaction(&context, &id).await?;
    let result = state
        .workflows
        .confirm_shelf_admitted(confirmation, &guard, Some(&app))
        .await;
    if matches!(
        result.outcome,
        WorkflowOutcome::Succeeded | WorkflowOutcome::Partial
    ) {
        state.changelists.invalidate_pending_pages();
        state.files.clear_review_cache();
    }
    state.journal.finish_action(
        &id,
        &serde_json::to_value(&result).map_err(|e| e.to_string())?,
    )?;
    guard.finish(matches!(
        result.outcome,
        WorkflowOutcome::Succeeded | WorkflowOutcome::Rejected
    ))?;
    Ok(result)
}

#[tauri::command]
pub async fn delete_shelved_revisions(
    _admission: crate::close_guard::Admission,
    request: ShelfDeleteDirectRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<WorkflowResult, String> {
    let id = request
        .operation_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection")?;
    let payload = serde_json::to_value(&request).map_err(|e| e.to_string())?;
    match state
        .journal
        .reserve_action("shelfDelete", &id, &scope, &payload)?
    {
        crate::persistence::operation_journal::action_receipts::Reservation::New => {}
        crate::persistence::operation_journal::action_receipts::Reservation::Existing(receipt) => {
            return receipt
                .result
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "Existing operation is running or interrupted; query receipt, never retry with a new ID".to_owned());
        }
    }
    let preflight = state
        .workflows
        .preflight_shelf(
            ShelfPreflightRequest {
                change_id: request.change_id,
                depot_paths: request.depot_paths.clone(),
                mode: ShelfMode::Delete,
                replace: false,
            },
            Some(&app),
        )
        .await;
    let token_ready = preflight
        .token
        .as_deref()
        .is_some_and(|token| !token.is_empty());
    if !preflight.ready
        || !preflight.blockers.is_empty()
        || !token_ready
        || preflight.expires_at <= chrono::Utc::now().timestamp_millis()
    {
        let message = if preflight.blockers.is_empty() {
            "Shelved delete preflight is not ready; nothing was deleted.".to_owned()
        } else {
            preflight
                .blockers
                .iter()
                .map(|blocker| blocker.message.clone())
                .collect::<Vec<_>>()
                .join("; ")
        };
        let result = WorkflowResult {
            execution: None,
            outcome: WorkflowOutcome::Failed,
            failure: Some(WorkflowFailureCode::PreflightBlocked),
            message,
            operation_ids: vec![id.clone()],
            log_reference: preflight.log_reference.clone(),
            files: Vec::new(),
            refresh: WorkflowRefreshAdvice {
                pending_changes: true,
                workspace_status: true,
                depot_paths: preflight.target.depot_paths.clone(),
                reason: "shelved delete rejected before dispatch; nothing deleted".into(),
            },
        };
        state.journal.finish_action(
            &id,
            &serde_json::to_value(&result).map_err(|e| e.to_string())?,
        )?;
        return Ok(result);
    }
    let confirmation = WorkflowConfirmation {
        token: preflight.token.clone().unwrap_or_default(),
        target: preflight.target.clone(),
        operation_id: Some(id.clone()),
    };
    let _group = state.runner.begin_operation_group(id.clone());
    let guard = match state.runner.lock_write_transaction(&context, &id).await {
        Ok(guard) => guard,
        Err(error) => {
            let result = WorkflowResult {
                execution: None,
                outcome: WorkflowOutcome::Unknown,
                failure: Some(WorkflowFailureCode::UncertainOutcome),
                message: format!(
                    "Shelved delete could not acquire the write lease: {error}; outcome unknown."
                ),
                operation_ids: vec![id.clone()],
                log_reference: None,
                files: Vec::new(),
                refresh: WorkflowRefreshAdvice {
                    pending_changes: true,
                    workspace_status: true,
                    depot_paths: Vec::new(),
                    reason: "uncertain shelved delete; refresh and query receipt before retry"
                        .into(),
                },
            };
            let _ = state.journal.finish_action(
                &id,
                &serde_json::to_value(&result).map_err(|e| e.to_string())?,
            );
            return Err(error);
        }
    };
    let result = state
        .workflows
        .confirm_shelf_admitted(confirmation, &guard, Some(&app))
        .await;
    if matches!(
        result.outcome,
        WorkflowOutcome::Succeeded | WorkflowOutcome::Partial
    ) {
        state.changelists.invalidate_pending_pages();
        state.files.clear_review_cache();
    }
    state.journal.finish_action(
        &id,
        &serde_json::to_value(&result).map_err(|e| e.to_string())?,
    )?;
    guard.finish(matches!(
        result.outcome,
        WorkflowOutcome::Succeeded | WorkflowOutcome::Rejected
    ))?;
    Ok(result)
}

#[tauri::command]
pub async fn shelve_files(
    _admission: crate::close_guard::Admission,
    request: ShelveDirectRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<WorkflowResult, String> {
    let id = request
        .operation_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection")?;
    let payload = serde_json::to_value(&request).map_err(|e| e.to_string())?;
    match state
        .journal
        .reserve_action("shelve", &id, &scope, &payload)?
    {
        crate::persistence::operation_journal::action_receipts::Reservation::New => {}
        crate::persistence::operation_journal::action_receipts::Reservation::Existing(receipt) => {
            return receipt
                .result
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "Existing operation is running or interrupted; query receipt, never retry with a new ID".to_owned());
        }
    }
    let preflight = state
        .workflows
        .preflight_shelf(
            ShelfPreflightRequest {
                change_id: request.change_id,
                depot_paths: request.depot_paths.clone(),
                mode: ShelfMode::CreateOrUpdate,
                replace: request.replace.unwrap_or(false),
            },
            Some(&app),
        )
        .await;
    let token_ready = preflight
        .token
        .as_deref()
        .is_some_and(|token| !token.is_empty());
    if !preflight.ready
        || !preflight.blockers.is_empty()
        || !token_ready
        || preflight.expires_at <= chrono::Utc::now().timestamp_millis()
    {
        let message = if preflight.blockers.is_empty() {
            "Shelve preflight is not ready; nothing was written.".to_owned()
        } else {
            preflight
                .blockers
                .iter()
                .map(|blocker| blocker.message.clone())
                .collect::<Vec<_>>()
                .join("; ")
        };
        let result = WorkflowResult {
            execution: None,
            outcome: WorkflowOutcome::Failed,
            failure: Some(WorkflowFailureCode::PreflightBlocked),
            message,
            operation_ids: vec![id.clone()],
            log_reference: preflight.log_reference.clone(),
            files: Vec::new(),
            refresh: WorkflowRefreshAdvice {
                pending_changes: true,
                workspace_status: true,
                depot_paths: preflight.target.depot_paths.clone(),
                reason: "shelve rejected before dispatch; nothing written".into(),
            },
        };
        state.journal.finish_action(
            &id,
            &serde_json::to_value(&result).map_err(|e| e.to_string())?,
        )?;
        return Ok(result);
    }
    let confirmation = WorkflowConfirmation {
        token: preflight.token.clone().unwrap_or_default(),
        target: preflight.target.clone(),
        operation_id: Some(id.clone()),
    };
    let _group = state.runner.begin_operation_group(id.clone());
    let guard = match state.runner.lock_write_transaction(&context, &id).await {
        Ok(guard) => guard,
        Err(error) => {
            let result = WorkflowResult {
                execution: None,
                outcome: WorkflowOutcome::Unknown,
                failure: Some(WorkflowFailureCode::UncertainOutcome),
                message: format!(
                    "Shelve could not acquire the write lease: {error}; outcome unknown."
                ),
                operation_ids: vec![id.clone()],
                log_reference: None,
                files: Vec::new(),
                refresh: WorkflowRefreshAdvice {
                    pending_changes: true,
                    workspace_status: true,
                    depot_paths: Vec::new(),
                    reason: "uncertain shelve; refresh and query receipt before retry".into(),
                },
            };
            let _ = state.journal.finish_action(
                &id,
                &serde_json::to_value(&result).map_err(|e| e.to_string())?,
            );
            return Err(error);
        }
    };
    let result = state
        .workflows
        .confirm_shelf_admitted(confirmation, &guard, Some(&app))
        .await;
    if matches!(
        result.outcome,
        WorkflowOutcome::Succeeded | WorkflowOutcome::Partial
    ) {
        state.changelists.invalidate_pending_pages();
        state.files.clear_review_cache();
    }
    state.journal.finish_action(
        &id,
        &serde_json::to_value(&result).map_err(|e| e.to_string())?,
    )?;
    guard.finish(matches!(
        result.outcome,
        WorkflowOutcome::Succeeded | WorkflowOutcome::Rejected
    ))?;
    Ok(result)
}

#[tauri::command]
pub async fn unshelve_files(
    _admission: crate::close_guard::Admission,
    request: UnshelveDirectRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<WorkflowResult, String> {
    let id = request
        .operation_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection")?;
    let target_workspace = request
        .target_workspace
        .clone()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| context.client.clone());
    let preflight_request = UnshelvePreflightRequest {
        source_change_id: request.source_change_id,
        depot_paths: request.depot_paths.clone(),
        target_workspace,
        target_change_id: request.target_change_id.unwrap_or(0),
    };
    let payload = serde_json::to_value(&preflight_request).map_err(|e| e.to_string())?;
    match state
        .journal
        .reserve_action("unshelve", &id, &scope, &payload)?
    {
        crate::persistence::operation_journal::action_receipts::Reservation::New => {}
        crate::persistence::operation_journal::action_receipts::Reservation::Existing(receipt) => {
            return receipt
                .result
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "Existing operation is running or interrupted; query receipt, never retry with a new ID".to_owned());
        }
    }
    let preflight = state
        .workflows
        .preflight_unshelve(preflight_request, Some(&app))
        .await;
    let token_ready = preflight
        .token
        .as_deref()
        .is_some_and(|token| !token.is_empty());
    if !preflight.ready
        || !preflight.blockers.is_empty()
        || !token_ready
        || preflight.expires_at <= chrono::Utc::now().timestamp_millis()
    {
        let message = if preflight.blockers.is_empty() {
            "Unshelve preflight is not ready; nothing was written.".to_owned()
        } else {
            preflight
                .blockers
                .iter()
                .map(|blocker| blocker.message.clone())
                .collect::<Vec<_>>()
                .join("; ")
        };
        let result = WorkflowResult {
            execution: None,
            outcome: WorkflowOutcome::Failed,
            failure: Some(WorkflowFailureCode::PreflightBlocked),
            message,
            operation_ids: vec![id.clone()],
            log_reference: preflight.log_reference.clone(),
            files: Vec::new(),
            refresh: WorkflowRefreshAdvice {
                pending_changes: true,
                workspace_status: true,
                depot_paths: preflight.target.depot_paths.clone(),
                reason: "unshelve rejected before dispatch; nothing written".into(),
            },
        };
        state.journal.finish_action(
            &id,
            &serde_json::to_value(&result).map_err(|e| e.to_string())?,
        )?;
        return Ok(result);
    }
    let confirmation = WorkflowConfirmation {
        token: preflight.token.clone().unwrap_or_default(),
        target: preflight.target.clone(),
        operation_id: Some(id.clone()),
    };
    let _group = state.runner.begin_operation_group(id.clone());
    let guard = state.runner.lock_write_transaction(&context, &id).await?;
    let result = state
        .workflows
        .confirm_unshelve_admitted(confirmation, &guard, Some(&app))
        .await;
    if matches!(
        result.outcome,
        WorkflowOutcome::Succeeded | WorkflowOutcome::Partial
    ) {
        state.changelists.invalidate_pending_pages();
        state.files.clear_review_cache();
    }
    state.journal.finish_action(
        &id,
        &serde_json::to_value(&result).map_err(|e| e.to_string())?,
    )?;
    guard.finish(matches!(
        result.outcome,
        WorkflowOutcome::Succeeded | WorkflowOutcome::Rejected
    ))?;
    Ok(result)
}
#[tauri::command]
pub async fn preflight_unshelve(
    _admission: crate::close_guard::Admission,
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
    _admission: crate::close_guard::Admission,
    confirmation: WorkflowConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<WorkflowResult, String> {
    let mut confirmation = confirmation;
    let id = confirmation
        .operation_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    confirmation.operation_id = Some(id.clone());
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection")?;
    let payload = serde_json::to_value(&confirmation).map_err(|e| e.to_string())?;
    match state
        .journal
        .reserve_action("unshelve", &id, &scope, &payload)?
    {
        crate::persistence::operation_journal::action_receipts::Reservation::New => {}
        crate::persistence::operation_journal::action_receipts::Reservation::Existing(receipt) => {
            return receipt
                .result
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| e.to_string())?
                .ok_or("Existing operation is running or interrupted; query receipt, never retry with a new ID".into());
        }
    }
    let _group = state.runner.begin_operation_group(id.clone());
    let guard = state.runner.lock_write_transaction(&context, &id).await?;
    let result = state
        .workflows
        .confirm_unshelve_admitted(confirmation, &guard, Some(&app))
        .await;
    if matches!(
        result.outcome,
        WorkflowOutcome::Succeeded | WorkflowOutcome::Partial
    ) {
        state.changelists.invalidate_pending_pages();
        state.files.clear_review_cache();
    }
    state.journal.finish_action(
        &id,
        &serde_json::to_value(&result).map_err(|e| e.to_string())?,
    )?;
    guard.finish(matches!(
        result.outcome,
        WorkflowOutcome::Succeeded | WorkflowOutcome::Rejected
    ))?;
    Ok(result)
}

#[tauri::command]
pub async fn preflight_resolve(
    _admission: crate::close_guard::Admission,
    request: ResolvePreflightRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ResolvePreflight, String> {
    Ok(state.workflows.preflight_resolve(request, Some(&app)).await)
}

#[tauri::command]
pub async fn confirm_resolve(
    _admission: crate::close_guard::Admission,
    confirmation: ResolveConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<crate::app::merge_resolve_action::MergeResolveActionResult, String> {
    let operation_id = confirmation.operation_id.clone();
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection".to_owned())?;
    if let Some(id) = operation_id.as_deref() {
        let payload = serde_json::to_value(&confirmation).map_err(|e| e.to_string())?;
        match state.journal.reserve_action(
            crate::app::merge_resolve_action::KIND_RESOLVE,
            id,
            &scope,
            &payload,
        )? {
            crate::persistence::operation_journal::action_receipts::Reservation::New => {}
            crate::persistence::operation_journal::action_receipts::Reservation::Existing(
                receipt,
            ) => {
                return receipt
                    .result
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "Existing operation is running or interrupted; query receipt, never retry with a new ID".to_owned());
            }
        }
    }
    let paths = confirmation.target.depot_paths.clone();
    let legacy = state
        .workflows
        .confirm_resolve(confirmation.clone(), Some(&app))
        .await;
    let mut facts = Vec::new();
    if let Some(id) = operation_id.as_deref() {
        if let Ok(bounded) = crate::app::merge_resolve_action::recheck_facts(
            &state.runner,
            &context,
            &paths,
            id,
            Some(&app),
        )
        .await
        {
            facts = bounded;
        }
    }
    let result = crate::app::merge_resolve_action::project_resolve(
        crate::app::merge_resolve_action::KIND_RESOLVE,
        operation_id.clone(),
        &legacy,
        &facts,
        &paths,
    );
    if let Some(id) = operation_id.as_deref() {
        let value = serde_json::to_value(&result).map_err(|e| e.to_string())?;
        state.journal.finish_action(id, &value)?;
    }
    Ok(result)
}

#[tauri::command]
pub async fn open_manual_merge(
    _admission: crate::close_guard::Admission,
    request: ManualMergeOpenRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<crate::app::merge_resolve_action::MergeResolveActionResult, String> {
    let operation_id = request.operation_id.clone();
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection".to_owned())?;
    if let Some(id) = operation_id.as_deref() {
        let payload = serde_json::to_value(&request).map_err(|e| e.to_string())?;
        match state.journal.reserve_action(
            crate::app::merge_resolve_action::KIND_MANUAL_MERGE_SESSION,
            id,
            &scope,
            &payload,
        )? {
            crate::persistence::operation_journal::action_receipts::Reservation::New => {}
            crate::persistence::operation_journal::action_receipts::Reservation::Existing(
                receipt,
            ) => {
                return receipt
                    .result
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "Existing operation is running or interrupted; query receipt, never retry with a new ID".to_owned());
            }
        }
    }
    match state
        .workflows
        .open_manual_merge(request.clone(), Some(&app))
        .await
    {
        Ok(session) => {
            let result = crate::app::merge_resolve_action::project_session_open(
                operation_id.clone(),
                &session,
            );
            if let Some(id) = operation_id.as_deref() {
                let value = serde_json::to_value(&result).map_err(|e| e.to_string())?;
                state.journal.finish_action(id, &value)?;
            }
            Ok(result)
        }
        Err(error) => {
            if let Some(id) = operation_id.as_deref() {
                let failed = crate::app::merge_resolve_action::failed_result(
                    crate::app::merge_resolve_action::KIND_MANUAL_MERGE_SESSION,
                    id,
                    &error,
                );
                let value = serde_json::to_value(&failed).map_err(|e| e.to_string())?;
                let _ = state.journal.finish_action(id, &value);
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub fn validate_manual_merge(
    _admission: crate::close_guard::Admission,
    request: ManualMergeValidateRequest,
    state: State<'_, AppState>,
) -> Result<crate::app::merge_resolve_action::MergeResolveActionResult, String> {
    let operation_id = request.operation_id.clone();
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection".to_owned())?;
    if let Some(id) = operation_id.as_deref() {
        let payload = serde_json::to_value(&request).map_err(|e| e.to_string())?;
        match state.journal.reserve_action(
            crate::app::merge_resolve_action::KIND_MANUAL_MERGE_SESSION,
            id,
            &scope,
            &payload,
        )? {
            crate::persistence::operation_journal::action_receipts::Reservation::New => {}
            crate::persistence::operation_journal::action_receipts::Reservation::Existing(
                receipt,
            ) => {
                return receipt
                    .result
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "Existing operation is running or interrupted; query receipt, never retry with a new ID".to_owned());
            }
        }
    }
    match state.workflows.validate_manual_merge(request.clone()) {
        Ok(validation) => {
            let result = crate::app::merge_resolve_action::project_session_validation(
                operation_id.clone(),
                &validation,
                &request.session_id,
            );
            if let Some(id) = operation_id.as_deref() {
                let value = serde_json::to_value(&result).map_err(|e| e.to_string())?;
                state.journal.finish_action(id, &value)?;
            }
            Ok(result)
        }
        Err(error) => {
            if let Some(id) = operation_id.as_deref() {
                let failed = crate::app::merge_resolve_action::failed_result(
                    crate::app::merge_resolve_action::KIND_MANUAL_MERGE_SESSION,
                    id,
                    &error,
                );
                let value = serde_json::to_value(&failed).map_err(|e| e.to_string())?;
                let _ = state.journal.finish_action(id, &value);
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn confirm_manual_merge_save(
    _admission: crate::close_guard::Admission,
    confirmation: ManualMergeSaveConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<crate::app::merge_resolve_action::MergeResolveActionResult, String> {
    let operation_id = confirmation.operation_id.clone();
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection".to_owned())?;
    if let Some(id) = operation_id.as_deref() {
        let payload = serde_json::to_value(&confirmation).map_err(|e| e.to_string())?;
        match state.journal.reserve_action(
            crate::app::merge_resolve_action::KIND_MANUAL_MERGE_SAVE,
            id,
            &scope,
            &payload,
        )? {
            crate::persistence::operation_journal::action_receipts::Reservation::New => {}
            crate::persistence::operation_journal::action_receipts::Reservation::Existing(
                receipt,
            ) => {
                return receipt
                    .result
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "Existing operation is running or interrupted; query receipt, never retry with a new ID".to_owned());
            }
        }
    }
    match state
        .workflows
        .confirm_manual_merge_save(confirmation.clone(), Some(&app))
        .await
    {
        Ok(legacy) => {
            if matches!(
                legacy.outcome,
                WorkflowOutcome::Succeeded | WorkflowOutcome::Partial | WorkflowOutcome::Unknown
            ) {
                state.changelists.invalidate_pending_pages();
                state.search.clear_for_context_switch();
                state.files.clear_review_cache();
            }
            let result = crate::app::merge_resolve_action::project_manual_merge_save(
                operation_id.clone(),
                &legacy,
            );
            if let Some(id) = operation_id.as_deref() {
                let value = serde_json::to_value(&result).map_err(|e| e.to_string())?;
                state.journal.finish_action(id, &value)?;
            }
            Ok(result)
        }
        Err(error) => {
            if let Some(id) = operation_id.as_deref() {
                let failed = crate::app::merge_resolve_action::failed_result(
                    crate::app::merge_resolve_action::KIND_MANUAL_MERGE_SAVE,
                    id,
                    &error,
                );
                let value = serde_json::to_value(&failed).map_err(|e| e.to_string())?;
                let _ = state.journal.finish_action(id, &value);
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn confirm_manual_merge_resolve(
    _admission: crate::close_guard::Admission,
    confirmation: ManualMergeResolveConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<crate::app::merge_resolve_action::MergeResolveActionResult, String> {
    let operation_id = confirmation.operation_id.clone();
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection".to_owned())?;
    if let Some(id) = operation_id.as_deref() {
        let payload = serde_json::to_value(&confirmation).map_err(|e| e.to_string())?;
        match state.journal.reserve_action(
            crate::app::merge_resolve_action::KIND_MANUAL_MERGE_RESOLVE,
            id,
            &scope,
            &payload,
        )? {
            crate::persistence::operation_journal::action_receipts::Reservation::New => {}
            crate::persistence::operation_journal::action_receipts::Reservation::Existing(
                receipt,
            ) => {
                return receipt
                    .result
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "Existing operation is running or interrupted; query receipt, never retry with a new ID".to_owned());
            }
        }
    }
    let legacy = state
        .workflows
        .confirm_manual_merge_resolve(confirmation.clone(), Some(&app))
        .await;
    if matches!(
        legacy.outcome,
        WorkflowOutcome::Succeeded | WorkflowOutcome::Partial | WorkflowOutcome::Unknown
    ) {
        state.changelists.invalidate_pending_pages();
        state.search.clear_for_context_switch();
        state.files.clear_review_cache();
    }
    let paths: Vec<String> = legacy
        .files
        .iter()
        .map(|file| file.depot_path.clone())
        .collect();
    let mut facts = Vec::new();
    if let Some(id) = operation_id.as_deref() {
        if !paths.is_empty() {
            if let Ok(bounded) = crate::app::merge_resolve_action::recheck_facts(
                &state.runner,
                &context,
                &paths,
                id,
                Some(&app),
            )
            .await
            {
                facts = bounded;
            }
        }
    }
    let result = crate::app::merge_resolve_action::project_resolve(
        crate::app::merge_resolve_action::KIND_MANUAL_MERGE_RESOLVE,
        operation_id.clone(),
        &legacy,
        &facts,
        &paths,
    );
    if let Some(id) = operation_id.as_deref() {
        let value = serde_json::to_value(&result).map_err(|e| e.to_string())?;
        state.journal.finish_action(id, &value)?;
    }
    Ok(result)
}
#[tauri::command]
pub async fn open_local_path(
    _admission: crate::close_guard::Admission,
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
    _admission: crate::close_guard::Admission,
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
    _admission: crate::close_guard::Admission,
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
    _admission: crate::close_guard::Admission,
    request: crate::app::undo_service::UndoTarget,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<crate::app::undo_service::UndoPreview, String> {
    state.undo.preview(request, Some(&app)).await
}
#[tauri::command]
pub async fn confirm_undo(
    _admission: crate::close_guard::Admission,
    confirmation: crate::app::undo_service::UndoConfirmation,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<crate::app::local_io_action::LocalIoActionResult, String> {
    let operation_id = confirmation.operation_id.clone();
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection".to_owned())?;
    if let Some(id) = operation_id.as_deref() {
        let payload = serde_json::to_value(&confirmation).map_err(|e| e.to_string())?;
        match state.journal.reserve_action(
            crate::app::local_io_action::KIND_UNDO_CHANGE,
            id,
            &scope,
            &payload,
        )? {
            crate::persistence::operation_journal::action_receipts::Reservation::New => {}
            crate::persistence::operation_journal::action_receipts::Reservation::Existing(
                receipt,
            ) => {
                return receipt
                    .result
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "Existing operation is running or interrupted; query receipt, never retry with a new ID".to_owned());
            }
        }
    }
    let legacy = state.undo.confirm(confirmation.clone(), Some(&app)).await;
    let mut facts = Vec::new();
    if let Some(id) = operation_id.as_deref() {
        let paths = vec![confirmation.target.depot_path.clone()];
        if let Ok(bounded) = crate::app::local_io_action::recheck_facts(
            &state.runner,
            &context,
            &paths,
            id,
            Some(&app),
        )
        .await
        {
            facts = bounded;
        }
    }
    let result = crate::app::local_io_action::project_undo(
        operation_id.clone(),
        legacy,
        &facts,
        &confirmation.target.depot_path,
        confirmation.target.changelist_id as i64,
    );
    if let Some(id) = operation_id.as_deref() {
        let value = serde_json::to_value(&result).map_err(|e| e.to_string())?;
        state.journal.finish_action(id, &value)?;
    }
    Ok(result)
}

#[tauri::command]
pub async fn preflight_workspace_mutation(
    _admission: crate::close_guard::Admission,
    request: WorkspaceMutationRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<WorkspaceMutationPreview, String> {
    state
        .connection
        .preflight_workspace_mutation(request, Some(&app))
        .await
}
#[tauri::command]
pub async fn confirm_workspace_mutation(
    _admission: crate::close_guard::Admission,
    token: String,
    operation_id: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<WorkspaceMutationResult, String> {
    let id = operation_id
        .filter(|value| uuid::Uuid::parse_str(value).is_ok())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection")?;
    let payload = serde_json::json!({ "token": token, "operationId": id.clone() });
    match state
        .journal
        .reserve_action("workspaceMutation", &id, &scope, &payload)?
    {
        crate::persistence::operation_journal::action_receipts::Reservation::New => {}
        crate::persistence::operation_journal::action_receipts::Reservation::Existing(receipt) => {
            return receipt
                .result
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| e.to_string())?
                .ok_or("Existing operation is running or interrupted; query receipt, never retry with a new ID".into());
        }
    }
    let _group = state.runner.begin_operation_group(id.clone());
    let guard = state.runner.lock_write_transaction(&context, &id).await?;
    let result = match state
        .connection
        .confirm_workspace_mutation_admitted(token, &guard, Some(&app))
        .await
    {
        Ok(result) => result,
        Err(message) => {
            state
                .journal
                .finish_action(
                    &id,
                    &serde_json::json!({ "outcome": "rejected", "message": message }),
                )
                .ok();
            guard.finish(true)?;
            return Err(message);
        }
    };
    let verified = matches!(
        result.outcome,
        WorkflowOutcome::Succeeded | WorkflowOutcome::Rejected
    );
    if let Err(error) = state.journal.finish_action(
        &id,
        &serde_json::to_value(&result).map_err(|e| e.to_string())?,
    ) {
        let _ = guard.finish(false);
        return Err(format!("The workspace receipt could not be persisted ({error}); treat the outcome as unknown, refresh, and do not retry with a new ID."));
    }
    guard.finish(verified)?;
    Ok(result)
}

#[tauri::command]
pub async fn get_integration_trace(
    _admission: crate::close_guard::Admission,
    request: IntegrationTraceRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<IntegrationTraceBatch, String> {
    state.files.integration_trace(request, Some(&app)).await
}

#[tauri::command]
pub async fn selected_submit_prepare(
    _admission: crate::close_guard::Admission,
    request: crate::app::selected_submit::Request,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<crate::app::selected_submit::Receipt, String> {
    let (_, _, context) = state.connection.swarm_snapshot();

    let live = crate::app::selected_submit::Live {
        state: &state,
        context,
        app: &app,
        group: parking_lot::Mutex::new(None),
        transaction: parking_lot::Mutex::new(None),
    };
    state.selected_submit.prepare(request, &live).await
}
#[tauri::command]
pub fn selected_submit_status(
    _admission: crate::close_guard::Admission,
    request: crate::app::selected_submit::Lookup,
    state: State<'_, AppState>,
) -> Result<Option<crate::app::selected_submit::Receipt>, String> {
    state.selected_submit.status(&request)
}
#[tauri::command]
pub async fn selected_submit_claim(
    _admission: crate::close_guard::Admission,
    request: crate::app::selected_submit::Lookup,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<crate::app::selected_submit::Receipt, String> {
    let (_, _, context) = state.connection.swarm_snapshot();
    let live = crate::app::selected_submit::Live {
        state: &state,
        context,
        app: &app,
        group: parking_lot::Mutex::new(None),
        transaction: parking_lot::Mutex::new(None),
    };
    state.selected_submit.claim(request, &live).await
}

#[tauri::command]
pub async fn selected_move_execute(
    _admission: crate::close_guard::Admission,
    request: crate::app::selected_submit::MoveRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<crate::app::selected_submit::MoveReceipt, String> {
    let (_, _, context) = state.connection.swarm_snapshot();
    let configured_tool = context.custom_submit_executable_path.clone();
    let live = crate::app::selected_submit::Live {
        state: &state,
        context,
        app: &app,
        group: parking_lot::Mutex::new(None),
        transaction: parking_lot::Mutex::new(None),
    };
    state
        .selected_submit
        .move_files(request, configured_tool, &live)
        .await
}

#[tauri::command]
pub fn selected_move_status(
    _admission: crate::close_guard::Admission,
    request: crate::app::selected_submit::MoveLookup,
    state: State<'_, AppState>,
) -> Result<Option<crate::app::selected_submit::MoveReceipt>, String> {
    state.selected_submit.move_status(&request)
}

#[tauri::command]
pub fn record_frontend_operation_log(
    _admission: crate::close_guard::Admission,
    request: crate::app::frontend_log::Request,
    state: State<'_, AppState>,
) -> crate::app::frontend_log::Receipt {
    crate::app::frontend_log::record(&state.logs, request)
}

#[tauri::command]
pub fn selected_move_lookup(
    _admission: crate::close_guard::Admission,
    request: crate::app::selected_submit::MoveLookup,
    state: State<'_, AppState>,
) -> crate::app::selected_submit::MoveLookupResult {
    state.selected_submit.move_lookup(&request)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionSnapshot {
    pub connection: crate::app::company_submit::ConnectionSnapshot,
    pub fences: Vec<crate::persistence::operation_journal::admission::Fence>,
}
#[tauri::command]
pub fn action_write_fences(
    _admission: crate::close_guard::Admission,
    state: State<'_, AppState>,
) -> Result<AdmissionSnapshot, String> {
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let connection = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection")?;
    Ok(AdmissionSnapshot {
        fences: state.journal.fences(&context.server)?,
        connection,
    })
}
#[tauri::command]
pub fn action_release_unknown(
    _admission: crate::close_guard::Admission,
    request: crate::persistence::operation_journal::admission::ReleaseRequest,
    state: State<'_, AppState>,
    app: AppHandle,
) -> crate::persistence::operation_journal::admission::ReleaseResult {
    use crate::persistence::operation_journal::admission::ReleaseResult;
    let operation = state
        .journal
        .fences(&request.scope.server)
        .ok()
        .and_then(|rows| rows.into_iter().find(|f| f.fence_id == request.fence_id))
        .map(|f| f.operation_id);
    let result = state.journal.release_fence(&request);
    if result == ReleaseResult::Released {
        if let Some(id) = operation
            .as_deref()
            .and_then(|id| id.strip_prefix("custom:"))
        {
            state.custom_submit.release_ended_unknown(id);
        }
    }
    let _ = app;
    if result != ReleaseResult::Released {
        let _ = state.logs.push(crate::domain::LogEntry {
            id: uuid::Uuid::new_v4().to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            level: crate::domain::LogLevel::Error,
            operation_id: operation.unwrap_or_default(),
            source: crate::domain::OperationSource::Gui,
            server: request.scope.server,
            workspace: request.scope.client,
            command: "action-release-unknown".into(),
            message: format!("Release refused: {result:?}; no business operation was retried"),
            duration_ms: None,
            repeat_count: 1,
        });
    }
    result
}

#[tauri::command]
pub async fn selected_move_reconcile(
    _admission: crate::close_guard::Admission,
    request: crate::app::selected_submit::MoveLookup,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<crate::app::selected_submit::MoveReceipt, String> {
    let (_, _, context) = state.connection.swarm_snapshot();
    let live = crate::app::selected_submit::Live {
        state: &state,
        context,
        app: &app,
        group: parking_lot::Mutex::new(None),
        transaction: parking_lot::Mutex::new(None),
    };
    state.selected_submit.reconcile_move(&request, &live).await
}

#[tauri::command]
pub fn workflow_action_lookup(
    _admission: crate::close_guard::Admission,
    request: crate::persistence::operation_journal::action_receipts::ActionLookup,
    state: State<'_, AppState>,
) -> crate::persistence::operation_journal::action_receipts::LookupResult {
    state.journal.action_lookup(&request)
}

#[tauri::command]
pub async fn confirm_revert_action(
    _admission: crate::close_guard::Admission,
    request: FileActionRequest,
    connection: crate::app::company_submit::ConnectionSnapshot,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<WorkflowResult, String> {
    let plan = crate::app::revert_action::plan(&request)?;
    let id = request
        .operation_id
        .clone()
        .ok_or("Revert requires a stable operationId")?;
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let current = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection")?;
    if current != connection {
        return Err("connectionChanged".into());
    }
    let payload = serde_json::to_value(&request).map_err(|e| e.to_string())?;
    match state.journal.reserve_action("revert",&id,&connection,&payload)? {
        crate::persistence::operation_journal::action_receipts::Reservation::New=>{},
        crate::persistence::operation_journal::action_receipts::Reservation::Existing(r)=>return r.result.map(serde_json::from_value).transpose().map_err(|e|e.to_string())?.ok_or("Existing operation is running or interrupted; query receipt, never retry with a new ID".into()),
    }
    let _group = state.runner.begin_operation_group(id.clone());
    let guard = state.runner.lock_write_transaction(&context, &id).await?;
    let (profile, generation, latest) = state.connection.swarm_snapshot();
    if crate::app::company_submit::from_host_snapshot(profile, generation, &latest)
        .ok()
        .as_ref()
        != Some(&connection)
    {
        guard.finish(true)?;
        return Err(
            "connectionChangedBeforeDispatch; receipt retained without automatic replay".into(),
        );
    }
    let before = if request.action == FileAction::RevertUnchanged {
        crate::app::revert_action::retention::capture(
            &state.runner,
            &context,
            &request.paths,
            &format!("{id}:before"),
            &app,
        )
        .await
        .ok()
        .map(|(_, o)| o)
    } else {
        None
    };
    let (p, g, c) = state.connection.swarm_snapshot();
    if crate::app::company_submit::from_host_snapshot(p, g, &c)
        .ok()
        .as_ref()
        != Some(&connection)
    {
        guard.finish(true)?;
        return Err("connectionChangedBeforeDispatch".into());
    }
    let write = state
        .runner
        .run_with_mutation_guard_and_input(
            P4CommandRequest {
                operation_id: Some(id.clone()),
                source: OperationSource::Gui,
                command: plan.command.into(),
                args: plan.args,
                context: context.clone(),
                output_mode: OutputMode::JsonLines,
                timeout_ms: Some(600_000),
                input: None,
            },
            Some(&app),
            Some(request.paths.len()),
            plan.argument_input,
            &guard,
        )
        .await
        .map_err(|e| e.to_string());
    let mut after = None;
    let observed = if request.action == FileAction::RevertUnchanged {
        match crate::app::revert_action::retention::capture(
            &state.runner,
            &context,
            &request.paths,
            &format!("{id}:after"),
            &app,
        )
        .await
        {
            Ok((raw, o)) => {
                after = Some(o);
                Ok(raw)
            }
            Err(e) => Err(e),
        }
    } else {
        let mut query = crate::p4::workflows::command::fstat(&request.paths, None)?;
        query.args[2] = "depotFile,clientFile,action,change".into();
        query.args.remove(0);
        state
            .runner
            .run_with_progress(
                P4CommandRequest {
                    operation_id: Some(format!("{id}:reconcile")),
                    source: OperationSource::Gui,
                    command: query.command.into(),
                    args: query.args,
                    context: context.clone(),
                    output_mode: OutputMode::JsonLines,
                    timeout_ms: Some(300_000),
                    input: None,
                },
                Some(&app),
                None,
                query.argument_input,
            )
            .await
            .map_err(|e| e.to_string())
    };
    let evidence = before.as_ref().zip(after.as_ref());
    let result =
        crate::app::revert_action::result_with_retention(&request, write, observed, evidence);
    state.files.invalidate_status(
        &context,
        &request.paths,
        crate::app::status_cache::InvalidationReason::FileMutation,
    );
    state.changelists.invalidate_pending_pages();
    state.journal.finish_action(
        &id,
        &serde_json::to_value(&result).map_err(|e| e.to_string())?,
    )?;
    guard.finish(result.outcome == WorkflowOutcome::Succeeded)?;
    Ok(result)
}

async fn perform_durable_file_action(
    request: FileActionRequest,
    connection: crate::app::company_submit::ConnectionSnapshot,
    state: &AppState,
    app: &AppHandle,
) -> Result<FileActionResult, String> {
    let plan = crate::app::generic_action::plan(&request)?;
    let id = request
        .operation_id
        .clone()
        .ok_or("A stable operationId is required")?;
    let (profile, generation, context) = state.connection.swarm_snapshot();
    if crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .ok()
        .as_ref()
        != Some(&connection)
    {
        return Err("connectionChanged".into());
    }
    match state.journal.reserve_action(
        "fileAction",
        &id,
        &connection,
        &serde_json::to_value(&request).map_err(|e| e.to_string())?,
    )? {
        crate::persistence::operation_journal::action_receipts::Reservation::New => {}
        crate::persistence::operation_journal::action_receipts::Reservation::Existing(r) => {
            return r
                .result
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| e.to_string())?
                .ok_or(
                    "Existing operation is running or interrupted; query receipt without replay"
                        .into(),
                )
        }
    }
    let _group = state.runner.begin_operation_group(id.clone());
    let guard = state.runner.lock_write_transaction(&context, &id).await?;
    let (profile, generation, latest) = state.connection.swarm_snapshot();
    if crate::app::company_submit::from_host_snapshot(profile, generation, &latest)
        .ok()
        .as_ref()
        != Some(&connection)
    {
        guard.finish(true)?;
        return Err("connectionChangedBeforeDispatch".into());
    }
    let raw = state
        .runner
        .run_with_mutation_guard_and_input(
            P4CommandRequest {
                operation_id: Some(id.clone()),
                source: OperationSource::Gui,
                command: plan.command.into(),
                args: plan.args,
                context: context.clone(),
                output_mode: plan.output_mode,
                timeout_ms: Some(600_000),
                input: None,
            },
            Some(app),
            Some(request.paths.len()),
            plan.argument_input,
            &guard,
        )
        .await
        .map_err(|e| e.to_string());
    let result = crate::app::generic_action::result(&request, raw);
    state.files.invalidate_status(
        &context,
        &result.affected_paths,
        crate::app::status_cache::InvalidationReason::FileMutation,
    );

    state.journal.finish_action(
        &id,
        &serde_json::to_value(&result).map_err(|e| e.to_string())?,
    )?;
    guard.finish(
        result
            .execution
            .as_ref()
            .is_some_and(|e| e.outcome == "commandCompleted"),
    )?;
    Ok(result)
}

#[tauri::command]
pub fn get_server_status(
    _admission: crate::close_guard::Admission,
    state: State<'_, AppState>,
) -> Result<crate::p4::server_status::Snapshot, String> {
    state
        .runner
        .server_status()
        .ok_or_else(|| "Passive observer unavailable".to_owned())
}

#[tauri::command]
pub async fn check_server_status(
    _admission: crate::close_guard::Admission,
    expected_scope: crate::p4::server_status::Scope,
    request_id: String,
    state: State<'_, AppState>,
) -> Result<crate::p4::server_status::ManualReceipt, String> {
    Ok(state
        .runner
        .manual_server_check(expected_scope, request_id)
        .await)
}

async fn confirm_connection_spec_create(
    expected_kind: ConnectionSpecKind,
    mut confirmation: ConnectionSpecCreateConfirmation,
    state: &State<'_, AppState>,
    app: &AppHandle,
) -> Result<ConnectionSpecCreateResult, String> {
    let id = confirmation
        .operation_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    confirmation.operation_id = Some(id.clone());
    let (profile, generation, context) = state.connection.swarm_snapshot();
    let scope = crate::app::company_submit::from_host_snapshot(profile, generation, &context)
        .map_err(|_| "invalidConnection")?;
    let payload = serde_json::to_value(&confirmation).map_err(|e| e.to_string())?;
    let kind = match expected_kind {
        ConnectionSpecKind::UserSelf => "connectionCreateUser",
        ConnectionSpecKind::Workspace => "connectionCreateWorkspace",
    };
    match state.journal.reserve_action(kind, &id, &scope, &payload)? {
        crate::persistence::operation_journal::action_receipts::Reservation::New => {}
        crate::persistence::operation_journal::action_receipts::Reservation::Existing(receipt) => {
            return receipt
                .result
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| e.to_string())?
                .ok_or("Existing operation is running or interrupted; query receipt, never retry with a new ID".into());
        }
    }
    let _group = state.runner.begin_operation_group(id.clone());
    let guard = state.runner.lock_write_transaction(&context, &id).await?;
    let mut result = state
        .connection_setup
        .confirm_admitted(expected_kind, confirmation, &guard, Some(app))
        .await;
    let verified = matches!(
        result.outcome,
        ConnectionSpecCreateOutcome::Created | ConnectionSpecCreateOutcome::Rejected
    );
    if let Err(error) = state.journal.finish_action(
        &id,
        &serde_json::to_value(&result).map_err(|e| e.to_string())?,
    ) {
        result.outcome = ConnectionSpecCreateOutcome::Unknown;
        result.message = format!("The creation receipt could not be persisted ({error}); treat the outcome as unknown, refresh, and do not retry with a new ID.");
        let _ = guard.finish(false);
        return Ok(result);
    }
    guard.finish(verified)?;
    Ok(result)
}

#[cfg(test)]
mod profile_scope_tests {
    use super::*;

    fn context() -> P4Context {
        P4Context {
            server: "ssl:fixture.invalid:1666".into(),
            user: "mock-user".into(),
            client: "mock-client".into(),
            ..Default::default()
        }
    }

    #[test]
    fn clean_install_profile_write_scope_uses_the_empty_profile_id() {
        let scope = profile_write_scope(None, 1, &context()).unwrap();
        assert_eq!(scope.profile_id, "");
        assert_eq!(scope.generation, "1");
        assert_eq!(scope.server, "ssl:fixture.invalid:1666");
        assert_eq!(scope.user, "mock-user");
        assert_eq!(scope.client, "mock-client");
    }

    #[test]
    fn active_profile_keeps_its_identity_in_the_scope() {
        let scope = profile_write_scope(Some("profile-1".into()), 4, &context()).unwrap();
        assert_eq!(scope.profile_id, "profile-1");
        assert_eq!(scope.generation, "4");
    }

    #[test]
    fn invalid_settings_are_invalid_input_not_a_storage_failure() {
        let error = profile_write_scope(None, 1, &P4Context::default()).unwrap_err();
        assert_eq!(error.code, ConnectionProfileErrorCode::InvalidInput);
        assert!(!error.message.is_empty());
    }
}
