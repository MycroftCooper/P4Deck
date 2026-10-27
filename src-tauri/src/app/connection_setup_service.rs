use crate::{
    app::confirmation::{ConfirmationStore, ExpiringConfirmation},
    domain::*,
    p4::{
        connection::{ConnectionAdapter, ConnectionOperation},
        connection_setup::{
            valid_entity_name, ConnectionSetupRepository, ServerIdentity, SpecWriteError,
            DIRECTORY_RESULT_LIMIT,
        },
        context::validate_connection_context,
    },
};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

const TOKEN_TTL_MS: i64 = 120_000;
const MAX_PREFIX: usize = 64;
const MAX_VIEW_LINES: usize = 128;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum StoredPlan {
    UserSelf(ConnectionUserCreatePlan),
    Workspace(ConnectionWorkspaceCreatePlan),
}

#[derive(Clone)]
struct TokenRecord {
    context: P4Context,
    request_generation: u64,
    identity: ServerIdentity,
    plan: StoredPlan,
    state_digest: String,
    expires_at: i64,
}

impl ExpiringConfirmation for TokenRecord {
    fn expires_at(&self) -> i64 {
        self.expires_at
    }
}

pub struct ConnectionSetupService {
    repository: ConnectionSetupRepository,
    tokens: ConfirmationStore<TokenRecord>,
    confirmation_gate: AsyncMutex<()>,
}

impl ConnectionSetupService {
    pub fn new(repository: ConnectionSetupRepository) -> Self {
        Self {
            repository,
            tokens: ConfirmationStore::default(),
            confirmation_gate: AsyncMutex::new(()),
        }
    }

    pub async fn browse_users(
        &self,
        request: ConnectionDirectoryRequest,
        app: Option<&AppHandle>,
    ) -> ConnectionUserDirectoryResult {
        let generation = request.request_generation;
        let status = connection_status(&request.context).await;
        let prefix = match validate_query(&request) {
            Ok(prefix) if status.state == ConnectionState::Connected => prefix,
            Ok(_) => return empty_users(generation, status),
            Err(_) => return empty_users(generation, invalid_query_status(&request.context)),
        };
        let operation = child_id(request.operation_id.as_deref(), "users");
        match self
            .repository
            .list_users(&request.context, prefix.as_deref(), &operation, app)
            .await
        {
            Ok(batch) => ConnectionUserDirectoryResult {
                request_generation: generation,
                stats: ConnectionDirectoryStats {
                    scanned_count: batch.scanned_count,
                    matched_count: batch.items.len(),
                    safety_limit: DIRECTORY_RESULT_LIMIT,
                },
                items: batch.items,
                partial: batch.truncated,
                truncated: batch.truncated,
                operation_ids: batch.operation_ids,
                connection: status,
                simulated: false,
            },
            Err(_) => empty_users(generation, failure_status(&request.context).await),
        }
    }

    pub async fn browse_workspaces(
        &self,
        request: ConnectionDirectoryRequest,
        app: Option<&AppHandle>,
    ) -> ConnectionWorkspaceDirectoryResult {
        let generation = request.request_generation;
        let status = connection_status(&request.context).await;
        let prefix = match validate_query(&request) {
            Ok(prefix) if status.state == ConnectionState::Connected => prefix,
            Ok(_) => return empty_workspaces(generation, status),
            Err(_) => return empty_workspaces(generation, invalid_query_status(&request.context)),
        };
        let operation = child_id(request.operation_id.as_deref(), "workspaces");
        match self
            .repository
            .list_workspaces(&request.context, prefix.as_deref(), &operation, app)
            .await
        {
            Ok(batch) => ConnectionWorkspaceDirectoryResult {
                request_generation: generation,
                stats: ConnectionDirectoryStats {
                    scanned_count: batch.scanned_count,
                    matched_count: batch.items.len(),
                    safety_limit: DIRECTORY_RESULT_LIMIT,
                },
                items: batch.items,
                partial: batch.truncated,
                truncated: batch.truncated,
                operation_ids: batch.operation_ids,
                connection: status,
                simulated: false,
            },
            Err(_) => empty_workspaces(generation, failure_status(&request.context).await),
        }
    }

    pub async fn preflight_user(
        &self,
        request: ConnectionUserCreatePreflightRequest,
        app: Option<&AppHandle>,
    ) -> ConnectionSpecCreatePreflight {
        let kind = ConnectionSpecKind::UserSelf;
        let name = request.plan.name.clone();
        let mut blockers = validate_user_plan(&request.context, &request.plan);
        let mut operation_ids = Vec::new();
        let mut identity = None;
        if blockers.is_empty() {
            let status = connection_status(&request.context).await;
            if status.state != ConnectionState::Connected {
                blockers.push(connection_issue(&status));
            } else {
                let root = request.operation_id.as_deref();
                match self
                    .repository
                    .inspect_identity(&request.context, &child_id(root, "info"), app)
                    .await
                {
                    Ok((observed, id)) if observed.user_name == request.context.user => {
                        operation_ids.push(id);
                        identity = Some(observed);
                    }
                    Ok((_, id)) => {
                        operation_ids.push(id);
                        blockers.push(issue(ConnectionSpecIssueCode::ConnectionChanged, "The server-reported user does not match the explicitly confirmed draft user."));
                    }
                    Err(_) => {
                        blockers.push(connection_issue(&failure_status(&request.context).await))
                    }
                }
                if identity.is_some() {
                    match self
                        .repository
                        .user_exists(&request.context, &name, &child_id(root, "exists"), app)
                        .await
                    {
                        Ok((true, id)) => {
                            operation_ids.push(id);
                            blockers.push(issue(
                                ConnectionSpecIssueCode::AlreadyExists,
                                "That user already exists; P4Deck will not overwrite it.",
                            ));
                        }
                        Ok((false, id)) => operation_ids.push(id),
                        Err(_) => {
                            blockers.push(connection_issue(&failure_status(&request.context).await))
                        }
                    }
                }
            }
        }
        self.finish_preflight(
            kind,
            name,
            request.context,
            request.request_generation,
            StoredPlan::UserSelf(request.plan),
            identity,
            blockers,
            operation_ids,
        )
    }

    pub async fn preflight_workspace(
        &self,
        request: ConnectionWorkspaceCreatePreflightRequest,
        app: Option<&AppHandle>,
    ) -> ConnectionSpecCreatePreflight {
        let kind = ConnectionSpecKind::Workspace;
        let name = request.plan.name.clone();
        let mut blockers = validate_workspace_plan(&request.context, &request.plan);
        let mut operation_ids = Vec::new();
        let mut identity = None;
        if blockers.is_empty() {
            let status = connection_status(&request.context).await;
            if status.state != ConnectionState::Connected {
                blockers.push(connection_issue(&status));
            } else {
                let root = request.operation_id.as_deref();
                match self
                    .repository
                    .inspect_identity(&request.context, &child_id(root, "info"), app)
                    .await
                {
                    Ok((observed, id)) if observed.user_name == request.context.user => {
                        operation_ids.push(id);
                        identity = Some(observed);
                    }
                    Ok((_, id)) => {
                        operation_ids.push(id);
                        blockers.push(issue(
                            ConnectionSpecIssueCode::ConnectionChanged,
                            "The server-reported user does not match the workspace owner.",
                        ));
                    }
                    Err(_) => {
                        blockers.push(connection_issue(&failure_status(&request.context).await))
                    }
                }
                if let Some(observed) = identity.as_ref() {
                    blockers.extend(vfs_plan_issues(&request.context, &request.plan, observed));
                }
                if identity.is_some() {
                    match self
                        .repository
                        .workspace_exists(&request.context, &name, &child_id(root, "exists"), app)
                        .await
                    {
                        Ok((true, id)) => {
                            operation_ids.push(id);
                            blockers.push(issue(
                                ConnectionSpecIssueCode::AlreadyExists,
                                "That workspace already exists; P4Deck will not overwrite it.",
                            ));
                        }
                        Ok((false, id)) => operation_ids.push(id),
                        Err(_) => {
                            blockers.push(connection_issue(&failure_status(&request.context).await))
                        }
                    }
                }
            }
        }
        self.finish_preflight(
            kind,
            name,
            request.context,
            request.request_generation,
            StoredPlan::Workspace(request.plan),
            identity,
            blockers,
            operation_ids,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn finish_preflight(
        &self,
        kind: ConnectionSpecKind,
        name: String,
        context: P4Context,
        request_generation: u64,
        plan: StoredPlan,
        identity: Option<ServerIdentity>,
        blockers: Vec<ConnectionSpecIssue>,
        operation_ids: Vec<String>,
    ) -> ConnectionSpecCreatePreflight {
        let expires_at = now_ms().saturating_add(TOKEN_TTL_MS);
        let state_digest = digest(&(kind, &context, request_generation, &identity, &plan));
        let ready = blockers.is_empty() && identity.is_some();
        let token = ready.then(|| {
            self.tokens.issue(
                TokenRecord {
                    context,
                    request_generation,
                    identity: identity.expect("ready preflight has identity"),
                    plan,
                    state_digest: state_digest.clone(),
                    expires_at,
                },
                now_ms(),
            )
        });
        ConnectionSpecCreatePreflight {
            ready,
            kind,
            name,
            request_generation,
            state_digest,
            token,
            expires_at,
            blockers,
            warnings: Vec::new(),
            operation_ids,
            simulated: false,
        }
    }

    pub async fn confirm(
        &self,
        expected_kind: ConnectionSpecKind,
        confirmation: ConnectionSpecCreateConfirmation,
        app: Option<&AppHandle>,
    ) -> ConnectionSpecCreateResult {
        let _confirmation = self.confirmation_gate.lock().await;
        let Some(record) = self.tokens.consume(&confirmation.token) else {
            return rejected(
                expected_kind,
                "",
                ConnectionSpecIssueCode::VerificationFailed,
                "The confirmation token is unknown or was already used.",
                Vec::new(),
            );
        };
        let (kind, name) = stored_identity(&record.plan);
        if kind != expected_kind
            || !confirmation.confirmed
            || record.expires_at <= now_ms()
            || record.context != confirmation.context
            || record.request_generation != confirmation.request_generation
            || record.state_digest != confirmation.state_digest
        {
            return rejected(
                kind,
                &name,
                ConnectionSpecIssueCode::ConnectionChanged,
                "The reviewed draft, confirmation, or token no longer matches.",
                Vec::new(),
            );
        }
        let plan_issues = match &record.plan {
            StoredPlan::UserSelf(plan) => validate_user_plan(&record.context, plan),
            StoredPlan::Workspace(plan) => validate_workspace_plan(&record.context, plan),
        };
        if !plan_issues.is_empty() {
            return rejected(
                kind,
                &name,
                ConnectionSpecIssueCode::InvalidInput,
                "The reviewed creation plan is no longer locally valid.",
                Vec::new(),
            );
        }
        let guard = self.repository.lock_mutations(&record.context.server).await;
        let mut operation_ids = Vec::new();
        let root = format!("connection-create-{}", Uuid::new_v4());
        let identity = match self
            .repository
            .inspect_identity(&record.context, &format!("{root}:info"), app)
            .await
        {
            Ok((identity, id)) => {
                operation_ids.push(id);
                identity
            }
            Err(_) => {
                return rejected(
                    kind,
                    &name,
                    ConnectionSpecIssueCode::VerificationFailed,
                    "The target server identity could not be reverified.",
                    operation_ids,
                )
            }
        };
        if identity != record.identity || identity.user_name != record.context.user {
            return rejected(
                kind,
                &name,
                ConnectionSpecIssueCode::ConnectionChanged,
                "The target server or authenticated user changed after preflight.",
                operation_ids,
            );
        }
        let exists = match kind {
            ConnectionSpecKind::UserSelf => {
                self.repository
                    .user_exists(&record.context, &name, &format!("{root}:exists"), app)
                    .await
            }
            ConnectionSpecKind::Workspace => {
                self.repository
                    .workspace_exists(&record.context, &name, &format!("{root}:exists"), app)
                    .await
            }
        };
        match exists {
            Ok((true, id)) => {
                operation_ids.push(id);
                return rejected(
                    kind,
                    &name,
                    ConnectionSpecIssueCode::AlreadyExists,
                    "The spec was created elsewhere after preflight; it was not overwritten.",
                    operation_ids,
                );
            }
            Ok((false, id)) => operation_ids.push(id),
            Err(_) => {
                return rejected(
                    kind,
                    &name,
                    ConnectionSpecIssueCode::VerificationFailed,
                    "Existence could not be reverified; no write was attempted.",
                    operation_ids,
                )
            }
        }
        let write = match &record.plan {
            StoredPlan::UserSelf(plan) => {
                self.repository
                    .create_user(
                        &record.context,
                        user_form(plan),
                        &format!("{root}:write"),
                        app,
                        &guard,
                    )
                    .await
            }
            StoredPlan::Workspace(plan) => {
                let mut write_context = record.context.clone();
                write_context.client = plan.name.clone();
                self.repository
                    .create_workspace(
                        &write_context,
                        workspace_form(&record.context.user, plan),
                        &format!("{root}:write"),
                        app,
                        &guard,
                    )
                    .await
            }
        };
        match write {
            Ok(id) => operation_ids.push(id),
            Err(SpecWriteError::Rejected(code)) => {
                let (failure, message) = match code {
                    ConnectionErrorCode::AuthRequired
                    | ConnectionErrorCode::TicketExpired
                    | ConnectionErrorCode::ExternalAuthRequired => (
                        ConnectionSpecIssueCode::AuthenticationRequired,
                        "The server rejected creation because authentication is required.",
                    ),
                    ConnectionErrorCode::PermissionDenied => (
                        ConnectionSpecIssueCode::PermissionDenied,
                        "The server rejected creation; the ordinary user is not permitted to create this spec.",
                    ),
                    _ => (
                        ConnectionSpecIssueCode::VerificationFailed,
                        "The server rejected the spec creation request; see the operation log.",
                    ),
                };
                return rejected(kind, &name, failure, message, operation_ids);
            }
            Err(SpecWriteError::Unknown) => return ConnectionSpecCreateResult { outcome: ConnectionSpecCreateOutcome::Unknown, failure: Some(ConnectionSpecIssueCode::VerificationFailed), kind, name, message: "The server did not provide a verified creation result. Inspect the operation log before retrying.".into(), operation_ids, workspace: None, simulated: false },
        }
        let verified = match &record.plan {
            StoredPlan::UserSelf(plan) => self
                .repository
                .read_user(&record.context, &name, &format!("{root}:verify"), app)
                .await
                .map(|(observed, id)| {
                    (
                        observed.is_some_and(|item| user_matches(plan, &item)),
                        None,
                        id,
                    )
                }),
            StoredPlan::Workspace(plan) => self
                .repository
                .read_workspace(&record.context, &name, &format!("{root}:verify"), app)
                .await
                .map(|(observed, id)| {
                    let workspace = observed.as_ref().and_then(|item| {
                        workspace_matches(&record.context.user, plan, item)
                            .then(|| {
                                crate::p4::connection_setup::workspace_candidate_from_spec(item)
                            })
                            .filter(|item| item.selectable)
                    });
                    (workspace.is_some(), workspace, id)
                }),
        };
        match verified {
            Ok((true, workspace, id)) => {
                operation_ids.push(id);
                ConnectionSpecCreateResult {
                    outcome: ConnectionSpecCreateOutcome::Created,
                    failure: None,
                    kind,
                    name,
                    message: "The new P4 spec was written and verified on the target server."
                        .into(),
                    operation_ids,
                    workspace,
                    simulated: false,
                }
            }
            Ok((false, _, id)) => {
                operation_ids.push(id);
                ConnectionSpecCreateResult {
                    outcome: ConnectionSpecCreateOutcome::Unknown,
                    failure: Some(ConnectionSpecIssueCode::VerificationFailed),
                    kind,
                    name,
                    message: "The write returned but the new spec could not be verified.".into(),
                    operation_ids,
                    workspace: None,
                    simulated: false,
                }
            }
            Err(_) => ConnectionSpecCreateResult {
                outcome: ConnectionSpecCreateOutcome::Unknown,
                failure: Some(ConnectionSpecIssueCode::VerificationFailed),
                kind,
                name,
                message: "The write outcome is unknown because post-write verification failed."
                    .into(),
                operation_ids,
                workspace: None,
                simulated: false,
            },
        }
    }
}

fn validate_query(request: &ConnectionDirectoryRequest) -> Result<Option<String>, ()> {
    validate_connection_context(&request.context).map_err(|_| ())?;
    request
        .prefix
        .as_deref()
        .map(validate_prefix)
        .transpose()
        .map(|prefix| prefix.filter(|value| !value.is_empty()))
}

fn validate_prefix(value: &str) -> Result<String, ()> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(String::new());
    }
    if value.chars().count() > MAX_PREFIX
        || value.starts_with('-')
        || value
            .chars()
            .any(|c| c.is_control() || matches!(c, '*' | '%' | '@' | '#'))
    {
        return Err(());
    }
    Ok(value.to_owned())
}

fn validate_user_plan(
    context: &P4Context,
    plan: &ConnectionUserCreatePlan,
) -> Vec<ConnectionSpecIssue> {
    let mut issues = Vec::new();
    if validate_connection_context(context).is_err()
        || !valid_entity_name(&plan.name)
        || plan.name != context.user
    {
        issues.push(issue(
            ConnectionSpecIssueCode::InvalidInput,
            "New User can only create the explicitly entered draft user identity.",
        ));
    }
    if !valid_text(&plan.full_name, 1, 256)
        || !valid_text(&plan.email, 3, 254)
        || !plan.email.contains('@')
    {
        issues.push(issue(
            ConnectionSpecIssueCode::InvalidInput,
            "Full name or email is invalid.",
        ));
    }
    issues
}

fn validate_workspace_plan(
    context: &P4Context,
    plan: &ConnectionWorkspaceCreatePlan,
) -> Vec<ConnectionSpecIssue> {
    let mut issues = Vec::new();
    if validate_connection_context(context).is_err() || !valid_entity_name(&plan.name) {
        issues.push(issue(
            ConnectionSpecIssueCode::InvalidInput,
            "Workspace name or draft connection identity is invalid.",
        ));
    }
    let root = Path::new(&plan.root);
    if !root.is_absolute() || !root.is_dir() || plan.root.chars().any(char::is_control) {
        issues.push(issue(
            ConnectionSpecIssueCode::InvalidInput,
            "Workspace Root must be an existing absolute directory; P4Deck will not create it.",
        ));
    }
    if plan
        .description
        .as_deref()
        .is_some_and(|value| !valid_text(value, 0, 1024))
    {
        issues.push(issue(
            ConnectionSpecIssueCode::InvalidInput,
            "Workspace description is invalid.",
        ));
    }
    if plan.sync_mode == WorkspaceSyncMode::Unknown {
        issues.push(issue(
            ConnectionSpecIssueCode::InvalidInput,
            "Choose either standard sync or virtual sync for a new workspace.",
        ));
    }
    match &plan.mapping {
        ConnectionWorkspaceMapping::Stream { stream } => {
            if !stream.starts_with("//")
                || stream.len() > 512
                || stream
                    .chars()
                    .any(|c| c.is_control() || matches!(c, '*' | '%' | '@' | '#'))
            {
                issues.push(issue(
                    ConnectionSpecIssueCode::InvalidInput,
                    "Stream must be one exact depot stream path.",
                ));
            }
        }
        ConnectionWorkspaceMapping::Classic { view } => {
            if view.is_empty()
                || view.len() > MAX_VIEW_LINES
                || view.iter().any(|line| !valid_view_line(&plan.name, line))
            {
                issues.push(issue(ConnectionSpecIssueCode::InvalidInput, "Classic View must contain 1–128 safe, compatible mappings for this exact workspace."));
            }
        }
    }
    issues
}

fn vfs_plan_issues(
    context: &P4Context,
    plan: &ConnectionWorkspaceCreatePlan,
    identity: &ServerIdentity,
) -> Vec<ConnectionSpecIssue> {
    if plan.sync_mode != WorkspaceSyncMode::Virtual {
        return Vec::new();
    }
    let mut issues = Vec::new();
    if !cfg!(windows) {
        issues.push(issue(
            ConnectionSpecIssueCode::InvalidInput,
            "P4VFS virtual workspaces are supported only on Windows clients.",
        ));
    }
    if !identity
        .server_version
        .as_deref()
        .is_some_and(crate::p4::vfs::version_supports_vfs)
    {
        issues.push(issue(
            ConnectionSpecIssueCode::VerificationFailed,
            "P4 Server 2023.1 or later is required for a virtual workspace.",
        ));
    }
    let cli = crate::p4::connection::ConnectionAdapter::discover(context.executable.as_deref());
    if !cli
        .version
        .as_deref()
        .is_some_and(crate::p4::vfs::version_supports_vfs)
    {
        issues.push(issue(
            ConnectionSpecIssueCode::VerificationFailed,
            "P4 CLI 2023.1 or later is required for a virtual workspace.",
        ));
    }
    if !crate::p4::vfs::agent_is_configured() {
        issues.push(issue(
            ConnectionSpecIssueCode::VerificationFailed,
            "P4ALTSYNC is not visible to P4Deck. Install P4VFS and restart P4Deck before creating a virtual workspace.",
        ));
    }
    issues
}

fn valid_text(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.chars().count()) && !value.chars().any(char::is_control)
}

fn valid_view_line(client: &str, line: &ConnectionClassicViewLine) -> bool {
    let safe = |value: &str| {
        value.len() <= 1024
            && value.starts_with("//")
            && !value.contains('"')
            && !value.chars().any(char::is_control)
    };
    safe(&line.depot_path)
        && safe(&line.client_path)
        && line.client_path.starts_with(&format!("//{client}/"))
        && wildcard_shape(&line.depot_path) == wildcard_shape(&line.client_path)
}

fn wildcard_shape(value: &str) -> (usize, usize) {
    (
        value.matches("...").count(),
        value.replace("...", "").matches('*').count(),
    )
}

fn user_matches(plan: &ConnectionUserCreatePlan, item: &ConnectionUserCandidate) -> bool {
    item.name == plan.name
        && item.full_name.as_deref() == Some(plan.full_name.as_str())
        && item.email.as_deref() == Some(plan.email.as_str())
}

fn workspace_matches(
    owner: &str,
    plan: &ConnectionWorkspaceCreatePlan,
    item: &crate::p4::connection_setup::WorkspaceSpecSnapshot,
) -> bool {
    if item.name != plan.name
        || item.owner != owner
        || item.root != plan.root
        || item.description.trim() != plan.description.as_deref().unwrap_or("Created by P4Deck")
        || crate::p4::connection_setup::workspace_sync_mode_from_options(&item.options)
            != plan.sync_mode
    {
        return false;
    }
    match &plan.mapping {
        ConnectionWorkspaceMapping::Stream { stream } => item.stream == *stream,
        ConnectionWorkspaceMapping::Classic { view } => {
            item.stream.is_empty()
                && item.view.len() == view.len()
                && item.view.iter().zip(view).all(|(observed, expected)| {
                    let rendered = format!(
                        "{} {}",
                        quote_mapping(&expected.depot_path),
                        quote_mapping(&expected.client_path)
                    );
                    let unquoted = format!("{} {}", expected.depot_path, expected.client_path);
                    observed == &rendered || observed == &unquoted
                })
        }
    }
}

fn user_form(plan: &ConnectionUserCreatePlan) -> String {
    format!(
        "User:\t{}\nEmail:\t{}\nFullName:\t{}\n",
        plan.name, plan.email, plan.full_name
    )
}

fn workspace_form(owner: &str, plan: &ConnectionWorkspaceCreatePlan) -> String {
    let sync_option = match plan.sync_mode {
        WorkspaceSyncMode::Virtual => " altsync",
        WorkspaceSyncMode::Standard => "",
        WorkspaceSyncMode::Unknown => " noaltsync",
    };
    let mut form = format!("Client:\t{}\nOwner:\t{}\nRoot:\t{}\nDescription:\n\t{}\nOptions:\tnoallwrite noclobber nocompress unlocked nomodtime normdir{}\nSubmitOptions:\tsubmitunchanged\nLineEnd:\tlocal\n", plan.name, owner, plan.root, plan.description.as_deref().unwrap_or("Created by P4Deck"), sync_option);
    match &plan.mapping {
        ConnectionWorkspaceMapping::Stream { stream } => {
            form.push_str(&format!("Stream:\t{stream}\n"))
        }
        ConnectionWorkspaceMapping::Classic { view } => {
            form.push_str("View:\n");
            for line in view {
                form.push_str(&format!(
                    "\t{} {}\n",
                    quote_mapping(&line.depot_path),
                    quote_mapping(&line.client_path)
                ));
            }
        }
    }
    form
}

fn quote_mapping(value: &str) -> String {
    if value.chars().any(char::is_whitespace) {
        format!("\"{value}\"")
    } else {
        value.to_owned()
    }
}

fn stored_identity(plan: &StoredPlan) -> (ConnectionSpecKind, String) {
    match plan {
        StoredPlan::UserSelf(plan) => (ConnectionSpecKind::UserSelf, plan.name.clone()),
        StoredPlan::Workspace(plan) => (ConnectionSpecKind::Workspace, plan.name.clone()),
    }
}

fn digest<T: serde::Serialize>(value: &T) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    format!("{:x}", Sha256::digest(bytes))
}

fn child_id(parent: Option<&str>, suffix: &str) -> String {
    parent
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!("{value}:{suffix}"))
        .unwrap_or_else(|| format!("connection-setup-{}:{suffix}", Uuid::new_v4()))
}

fn issue(code: ConnectionSpecIssueCode, message: impl Into<String>) -> ConnectionSpecIssue {
    ConnectionSpecIssue {
        code,
        message: message.into(),
    }
}

fn connection_issue(status: &ConnectionStatus) -> ConnectionSpecIssue {
    let code = match status.state {
        ConnectionState::AuthRequired
        | ConnectionState::TicketExpired
        | ConnectionState::ExternalAuthRequired => ConnectionSpecIssueCode::AuthenticationRequired,
        ConnectionState::PermissionDenied => ConnectionSpecIssueCode::PermissionDenied,
        _ => ConnectionSpecIssueCode::VerificationFailed,
    };
    issue(code, status.message.clone())
}

fn rejected(
    kind: ConnectionSpecKind,
    name: &str,
    failure: ConnectionSpecIssueCode,
    message: &str,
    operation_ids: Vec<String>,
) -> ConnectionSpecCreateResult {
    ConnectionSpecCreateResult {
        outcome: ConnectionSpecCreateOutcome::Rejected,
        failure: Some(failure),
        kind,
        name: name.into(),
        message: message.into(),
        operation_ids,
        workspace: None,
        simulated: false,
    }
}

async fn connection_status(context: &P4Context) -> ConnectionStatus {
    if validate_connection_context(context).is_err() {
        return ConnectionStatus {
            state: ConnectionState::InvalidConfig,
            error_code: Some(ConnectionErrorCode::InvalidConfig),
            message: "Server and an explicit User are required for this draft query.".into(),
            recovery: RecoveryAction::EditConfig,
            server: context.server.clone(),
            fingerprint: None,
        };
    }
    ConnectionAdapter::execute(context, ConnectionOperation::Info, None, None).await
}

fn invalid_query_status(context: &P4Context) -> ConnectionStatus {
    ConnectionStatus {
        state: ConnectionState::InvalidConfig,
        error_code: Some(ConnectionErrorCode::InvalidConfig),
        message: "The directory prefix is invalid or contains P4 wildcard syntax.".into(),
        recovery: RecoveryAction::EditConfig,
        server: context.server.clone(),
        fingerprint: None,
    }
}

async fn failure_status(context: &P4Context) -> ConnectionStatus {
    let login =
        ConnectionAdapter::execute(context, ConnectionOperation::LoginStatus, None, None).await;
    if login.state != ConnectionState::Connected {
        login
    } else {
        ConnectionStatus {
            state: ConnectionState::PermissionDenied,
            error_code: Some(ConnectionErrorCode::PermissionDenied),
            message: "The server refused this directory query.".into(),
            recovery: RecoveryAction::ContactAdmin,
            server: context.server.clone(),
            fingerprint: None,
        }
    }
}

fn empty_users(
    request_generation: u64,
    connection: ConnectionStatus,
) -> ConnectionUserDirectoryResult {
    ConnectionUserDirectoryResult {
        request_generation,
        items: Vec::new(),
        partial: true,
        truncated: false,
        stats: ConnectionDirectoryStats {
            scanned_count: 0,
            matched_count: 0,
            safety_limit: DIRECTORY_RESULT_LIMIT,
        },
        operation_ids: Vec::new(),
        connection,
        simulated: false,
    }
}

fn empty_workspaces(
    request_generation: u64,
    connection: ConnectionStatus,
) -> ConnectionWorkspaceDirectoryResult {
    ConnectionWorkspaceDirectoryResult {
        request_generation,
        items: Vec::new(),
        partial: true,
        truncated: false,
        stats: ConnectionDirectoryStats {
            scanned_count: 0,
            matched_count: 0,
            safety_limit: DIRECTORY_RESULT_LIMIT,
        },
        operation_ids: Vec::new(),
        connection,
        simulated: false,
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context() -> P4Context {
        P4Context {
            server: "localhost:1666".into(),
            user: "developer".into(),
            ..Default::default()
        }
    }

    #[test]
    fn query_prefix_rejects_server_wildcards_and_options() {
        let request = |prefix: &str| ConnectionDirectoryRequest {
            context: context(),
            request_generation: 1,
            operation_id: None,
            prefix: Some(prefix.into()),
        };
        assert!(validate_query(&request("feature-")).is_ok());
        assert!(validate_query(&request("-m")).is_err());
        assert!(validate_query(&request("dev*")).is_err());
    }

    #[test]
    fn user_plan_is_only_for_explicit_self() {
        let valid = ConnectionUserCreatePlan {
            name: "developer".into(),
            full_name: "Dev User".into(),
            email: "dev@example.test".into(),
        };
        assert!(validate_user_plan(&context(), &valid).is_empty());
        let mut other = valid;
        other.name = "admin".into();
        assert!(!validate_user_plan(&context(), &other).is_empty());
    }

    #[test]
    fn classic_view_is_bounded_and_tied_to_workspace() {
        let good = ConnectionClassicViewLine {
            depot_path: "//depot/main/...".into(),
            client_path: "//dev-ws/main/...".into(),
        };
        assert!(valid_view_line("dev-ws", &good));
        let wrong = ConnectionClassicViewLine {
            client_path: "//other/main/...".into(),
            ..good
        };
        assert!(!valid_view_line("dev-ws", &wrong));
    }

    #[test]
    fn generated_forms_have_no_force_or_shell_commands() {
        let form = user_form(&ConnectionUserCreatePlan {
            name: "developer".into(),
            full_name: "Dev User".into(),
            email: "dev@example.test".into(),
        });
        assert!(!form.contains("-f"));
        assert!(!form.contains("Password:"));

        let workspace = ConnectionWorkspaceCreatePlan {
            name: "dev-ws".into(),
            root: "C:\\work\\dev-ws".into(),
            description: None,
            mapping: ConnectionWorkspaceMapping::Stream {
                stream: "//depot/main".into(),
            },
            sync_mode: WorkspaceSyncMode::Virtual,
        };
        let virtual_form = workspace_form("developer", &workspace);
        assert!(virtual_form.contains(
            "Options:\tnoallwrite noclobber nocompress unlocked nomodtime normdir altsync"
        ));
        let standard_form = workspace_form(
            "developer",
            &ConnectionWorkspaceCreatePlan {
                sync_mode: WorkspaceSyncMode::Standard,
                ..workspace
            },
        );
        assert!(!standard_form.contains(" altsync"));
        assert!(!standard_form.contains("-f"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn fake_cli_user_create_is_self_only_and_tokens_are_single_use() {
        use crate::{
            p4::{connection_setup::ConnectionSetupRepository, runner::P4Runner},
            persistence::{log_store::LogStore, operation_journal::OperationJournal},
        };
        use std::{fs, sync::Arc};

        let directory = std::env::temp_dir().join(format!(
            "p4deck-connection-setup-fake-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).unwrap();
        let executable = directory.join("fake-p4.cmd");
        let state = directory.join("user-created");
        let calls = directory.join("calls.txt");
        let script = format!(
            r#"@echo off
echo %*>>"{calls}"
echo %* | findstr /C:" user -i" >nul
if %errorlevel%==0 (
  more >nul
  type nul >"{state}"
  echo User fake-user saved.
  exit /b 0
)
echo %* | findstr /C:" users " >nul
if %errorlevel%==0 (
  if exist "{state}" (
    echo {{"User":"fake-user","FullName":"Fake User","Email":"fake@example.test","Access":"1"}}
  ) else (
    echo {{"code":"error","generic":17,"severity":2,"data":"No such user(s)."}}
  )
  exit /b 0
)
echo %* | findstr /C:" info" >nul
if %errorlevel%==0 (
  echo %* | findstr /C:"-Mj" >nul
  if %errorlevel%==0 (
    echo {{"userName":"fake-user","serverAddress":"fake:1666","serverID":"fake-server"}}
  ) else (
    echo User name: fake-user
    echo Server address: fake:1666
  )
  exit /b 0
)
echo unexpected command 1>&2
exit /b 9
"#,
            calls = calls.display(),
            state = state.display()
        );
        fs::write(&executable, script).unwrap();
        let logs = Arc::new(LogStore::open(&directory.join("logs.sqlite")).unwrap());
        let journal =
            Arc::new(OperationJournal::open(&directory.join("operations.sqlite")).unwrap());
        let runner = Arc::new(P4Runner::new(logs.clone(), journal.clone()));
        let service = ConnectionSetupService::new(ConnectionSetupRepository::new(runner.clone()));
        let context = P4Context {
            executable: Some(executable.to_string_lossy().into_owned()),
            server: "fake:1666".into(),
            user: "fake-user".into(),
            ..Default::default()
        };
        let plan = ConnectionUserCreatePlan {
            name: "fake-user".into(),
            full_name: "Fake User".into(),
            email: "fake@example.test".into(),
        };

        let stale = service
            .preflight_user(
                ConnectionUserCreatePreflightRequest {
                    context: context.clone(),
                    request_generation: 7,
                    operation_id: Some("fake-stale".into()),
                    plan: plan.clone(),
                },
                None,
            )
            .await;
        assert!(stale.ready, "{:?}", stale.blockers);
        let stale_confirmation = ConnectionSpecCreateConfirmation {
            token: stale.token.unwrap(),
            context: context.clone(),
            request_generation: 8,
            state_digest: stale.state_digest,
            confirmed: true,
        };
        assert_eq!(
            service
                .confirm(
                    ConnectionSpecKind::UserSelf,
                    stale_confirmation.clone(),
                    None
                )
                .await
                .outcome,
            ConnectionSpecCreateOutcome::Rejected
        );
        assert_eq!(
            service
                .confirm(ConnectionSpecKind::UserSelf, stale_confirmation, None)
                .await
                .outcome,
            ConnectionSpecCreateOutcome::Rejected
        );
        assert!(!fs::read_to_string(&calls).unwrap().contains(" user -i"));

        let preflight = service
            .preflight_user(
                ConnectionUserCreatePreflightRequest {
                    context: context.clone(),
                    request_generation: 9,
                    operation_id: Some("fake-create".into()),
                    plan,
                },
                None,
            )
            .await;
        assert!(preflight.ready, "{:?}", preflight.blockers);
        let created = service
            .confirm(
                ConnectionSpecKind::UserSelf,
                ConnectionSpecCreateConfirmation {
                    token: preflight.token.unwrap(),
                    context,
                    request_generation: 9,
                    state_digest: preflight.state_digest,
                    confirmed: true,
                },
                None,
            )
            .await;
        assert_eq!(created.outcome, ConnectionSpecCreateOutcome::Created);
        let recorded = fs::read_to_string(&calls).unwrap();
        assert_eq!(recorded.matches(" user -i").count(), 1);
        assert!(!recorded.contains(" -f"));
        assert!(!recorded.contains(" sync"));

        drop((service, runner, logs, journal));
        fs::remove_dir_all(directory).unwrap();
    }
}
