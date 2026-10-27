use crate::{
    domain::*,
    p4::{
        connection::{ConnectionAdapter, ConnectionOperation},
        connection_setup::{
            valid_entity_name, workspace_candidate_from_spec, ConnectionSetupRepository,
        },
        context::{validate_connection_context, ContextStore},
    },
    persistence::{
        log_store::LogStore,
        operation_journal::{
            connection_id, JournalState, OperationCategory, OperationFailureKind, OperationJournal,
        },
    },
};
use chrono::Utc;
use std::{path::PathBuf, sync::Arc, time::Instant};
use tauri::AppHandle;
use uuid::Uuid;
use zeroize::Zeroize;

pub struct ConnectionService {
    contexts: Arc<ContextStore>,
    setup: ConnectionSetupRepository,
    logs: Arc<LogStore>,
    journal: Arc<OperationJournal>,
}

impl ConnectionService {
    pub fn new(
        contexts: Arc<ContextStore>,
        setup: ConnectionSetupRepository,
        logs: Arc<LogStore>,
        journal: Arc<OperationJournal>,
    ) -> Self {
        Self {
            contexts,
            setup,
            logs,
            journal,
        }
    }

    pub fn context(&self) -> P4Context {
        self.contexts.current()
    }

    pub fn swarm_snapshot(&self) -> (Option<String>, u64, P4Context) {
        self.contexts.swarm_snapshot()
    }

    pub async fn save(
        &self,
        context: P4Context,
        app: Option<&AppHandle>,
    ) -> Result<P4Context, ConnectionProfileError> {
        let generation = self.contexts.snapshot().1;
        let resolved = self.resolve_workspace_context(&context, app).await?;
        self.contexts.save_if_unchanged(generation, resolved)
    }

    pub fn profiles(&self) -> ConnectionProfiles {
        self.contexts.profiles()
    }

    pub fn active_profile(&self) -> Option<ConnectionProfile> {
        self.contexts.active_profile()
    }

    pub async fn create_profile(
        &self,
        request: CreateConnectionProfileRequest,
        app: Option<&AppHandle>,
    ) -> Result<ConnectionProfiles, ConnectionProfileError> {
        let context = if self.contexts.profiles().active_profile_id.is_none() {
            self.resolve_workspace_context(&request.context, app)
                .await?
        } else {
            request.context
        };
        self.contexts
            .create(request.expected_revision, request.name, context)
    }

    pub async fn update_profile(
        &self,
        request: UpdateConnectionProfileRequest,
        app: Option<&AppHandle>,
    ) -> Result<ConnectionProfiles, ConnectionProfileError> {
        let active = self.contexts.active_profile_id().as_deref() == Some(&request.id);
        let expected_generation = self.contexts.snapshot().1;
        let context = if active {
            self.resolve_workspace_context(&request.context, app)
                .await?
        } else {
            request.context
        };
        if active {
            self.contexts.update_if_context_unchanged(
                request.expected_revision,
                expected_generation,
                &request.id,
                request.name,
                context,
            )
        } else {
            self.contexts.update(
                request.expected_revision,
                &request.id,
                request.name,
                context,
            )
        }
    }

    pub fn delete_profile(
        &self,
        request: DeleteConnectionProfileRequest,
    ) -> Result<ConnectionProfiles, ConnectionProfileError> {
        self.contexts.delete(request.expected_revision, &request.id)
    }

    pub fn runtime_info(&self) -> RuntimeInfo {
        let (context, context_generation) = self.contexts.snapshot();
        let cli = ConnectionAdapter::discover(context.executable.as_deref());
        let connection = if context.server.is_empty() && context.user.is_empty() {
            ConnectionStatus {
                state: ConnectionState::Disconnected,
                error_code: Some(ConnectionErrorCode::Disconnected),
                message: "No active connection. Create or select a saved connection in Settings."
                    .into(),
                recovery: RecoveryAction::EditConfig,
                server: String::new(),
                fingerprint: None,
            }
        } else if cli.state == ConnectionState::CliMissing {
            connection_error(
                ConnectionState::CliMissing,
                ConnectionErrorCode::CliMissing,
                RecoveryAction::ConfigureCli,
                &context.server,
            )
        } else if cli.state == ConnectionState::InvalidConfig
            || validate_connection_context(&context).is_err()
        {
            connection_error(
                ConnectionState::InvalidConfig,
                ConnectionErrorCode::InvalidConfig,
                RecoveryAction::ConfigureCli,
                &context.server,
            )
        } else {
            ConnectionStatus {
                state: ConnectionState::NotTested,
                error_code: None,
                message: "Server connectivity has not been tested.".into(),
                recovery: RecoveryAction::Retry,
                server: context.server.clone(),
                fingerprint: None,
            }
        };
        RuntimeInfo {
            mode: "tauri".into(),
            p4_version: cli.version.unwrap_or_else(|| "P4 CLI not found".into()),
            active_profile_id: self.contexts.active_profile_id(),
            context_generation,
            context,
            connection,
        }
    }

    pub async fn set_active_profile(
        &self,
        request: SetActiveConnectionProfileRequest,
        app: Option<&AppHandle>,
    ) -> Result<RuntimeInfo, ConnectionProfileError> {
        let expected_generation = self.contexts.snapshot().1;
        let profile = self
            .contexts
            .profile_at_revision(request.expected_revision, &request.id)?;
        let (resolved, status) = self.verify_switch(&profile.context, app).await?;
        self.contexts.activate_context_if_unchanged(
            request.expected_revision,
            expected_generation,
            &request.id,
            resolved,
        )?;
        Ok(self.runtime_info_with_status(status))
    }

    pub async fn switch_workspace(
        &self,
        request: SwitchWorkspaceRequest,
        app: Option<&AppHandle>,
    ) -> Result<RuntimeInfo, ConnectionProfileError> {
        let (mut candidate, generation) = self.contexts.snapshot();
        if generation != request.expected_generation {
            return Err(profile_switch_error(
                ConnectionProfileErrorCode::ContextChanged,
                "The active connection changed before workspace verification started.",
            ));
        }
        candidate.client = request.client;
        candidate.cwd = None;
        let (candidate, status) = self.verify_switch(&candidate, app).await?;
        self.contexts
            .switch_workspace_if_unchanged(request.expected_generation, candidate)?;
        Ok(self.runtime_info_with_status(status))
    }

    fn runtime_info_with_status(&self, connection: ConnectionStatus) -> RuntimeInfo {
        let (context, context_generation) = self.contexts.snapshot();
        let cli = ConnectionAdapter::discover(context.executable.as_deref());
        RuntimeInfo {
            mode: "tauri".into(),
            p4_version: cli.version.unwrap_or_else(|| "P4 CLI not found".into()),
            active_profile_id: self.contexts.active_profile_id(),
            context_generation,
            context,
            connection,
        }
    }

    pub(crate) fn verified_runtime(&self, message: impl Into<String>) -> RuntimeInfo {
        let context = self.contexts.current();
        self.runtime_info_with_status(ConnectionStatus {
            state: ConnectionState::Connected,
            error_code: None,
            message: message.into(),
            recovery: RecoveryAction::None,
            server: context.server,
            fingerprint: None,
        })
    }

    pub fn discover_cli(&self, request: CliDiscoveryRequest) -> CliDiscoveryResult {
        let started = Instant::now();
        let result = ConnectionAdapter::discover(request.executable.as_deref());
        self.record_discovery(started, &result);
        result
    }

    pub async fn test_connection(&self, context: P4Context) -> ConnectionStatus {
        let started = Instant::now();
        if validate_connection_context(&context).is_err() {
            let status = invalid_config(&context.server);
            self.record_status("connection info", &context, started, &status, false);
            return status;
        }
        let probe = connection_probe_context(&context);
        let status =
            ConnectionAdapter::execute(&probe, ConnectionOperation::Info, None, None).await;
        self.record_status(
            "connection info",
            &probe,
            started,
            &status,
            status.state == ConnectionState::Connected,
        );
        status
    }

    pub async fn login_status(&self, context: P4Context) -> ConnectionStatus {
        let started = Instant::now();
        if validate_connection_context(&context).is_err() {
            let status = invalid_config(&context.server);
            self.record_status("connection login-status", &context, started, &status, false);
            return status;
        }
        let probe = connection_probe_context(&context);
        let status =
            ConnectionAdapter::execute(&probe, ConnectionOperation::LoginStatus, None, None).await;
        self.record_status(
            "connection login-status",
            &probe,
            started,
            &status,
            status.state == ConnectionState::Connected,
        );
        status
    }

    pub async fn trust(&self, request: TrustRequest) -> ConnectionStatus {
        let started = Instant::now();
        if !request.confirmed
            || validate_connection_context(&request.context).is_err()
            || !valid_fingerprint(&request.fingerprint)
        {
            let status = invalid_config(&request.context.server);
            self.record_status(
                "connection trust",
                &request.context,
                started,
                &status,
                false,
            );
            return status;
        }
        let probe = connection_probe_context(&request.context);
        let status = ConnectionAdapter::execute(
            &probe,
            ConnectionOperation::Trust,
            Some(&request.fingerprint),
            None,
        )
        .await;
        self.record_status(
            "connection trust",
            &probe,
            started,
            &status,
            status.error_code.is_none(),
        );
        status
    }

    pub async fn login(&self, request: LoginRequest) -> ConnectionStatus {
        let started = Instant::now();
        let LoginRequest {
            context,
            mut password,
            confirmed,
        } = request;
        if !confirmed
            || validate_connection_context(&context).is_err()
            || password.is_empty()
            || password.len() > 4096
            || password.chars().any(char::is_control)
        {
            password.zeroize();
            let status = invalid_config(&context.server);
            self.record_status("connection login", &context, started, &status, false);
            return status;
        }
        let probe = connection_probe_context(&context);
        let status =
            ConnectionAdapter::execute(&probe, ConnectionOperation::Login, None, Some(&password))
                .await;
        password.zeroize();
        self.record_status(
            "connection login",
            &probe,
            started,
            &status,
            status.state == ConnectionState::Connected,
        );
        status
    }

    pub async fn logout(&self, request: AuthenticationRequest) -> ConnectionStatus {
        let started = Instant::now();
        if !request.confirmed || validate_connection_context(&request.context).is_err() {
            let status = invalid_config(&request.context.server);
            self.record_status(
                "connection logout",
                &request.context,
                started,
                &status,
                false,
            );
            return status;
        }
        let probe = connection_probe_context(&request.context);
        let status =
            ConnectionAdapter::execute(&probe, ConnectionOperation::Logout, None, None).await;
        self.record_status(
            "connection logout",
            &probe,
            started,
            &status,
            logout_completed(&status),
        );
        status
    }

    async fn verify_switch(
        &self,
        context: &P4Context,
        app: Option<&AppHandle>,
    ) -> Result<(P4Context, ConnectionStatus), ConnectionProfileError> {
        validate_connection_context(context).map_err(|message| {
            profile_switch_error(ConnectionProfileErrorCode::InvalidInput, message)
        })?;
        let probe = connection_probe_context(context);
        let started = Instant::now();
        let connection =
            ConnectionAdapter::execute(&probe, ConnectionOperation::Info, None, None).await;
        self.record_status(
            "connection switch-verify",
            &probe,
            started,
            &connection,
            connection.state == ConnectionState::Connected,
        );
        if connection.state != ConnectionState::Connected {
            return Err(profile_switch_error(
                ConnectionProfileErrorCode::ConnectionFailed,
                format!("Connection verification failed: {}", connection.message),
            ));
        }
        let started = Instant::now();
        let login =
            ConnectionAdapter::execute(&probe, ConnectionOperation::LoginStatus, None, None).await;
        self.record_status(
            "connection switch-verify",
            &probe,
            started,
            &login,
            login.state == ConnectionState::Connected,
        );
        if login.state != ConnectionState::Connected {
            return Err(profile_switch_error(
                ConnectionProfileErrorCode::AuthenticationRequired,
                format!("Authentication verification failed: {}", login.message),
            ));
        }
        let resolved = self.resolve_workspace_context(context, app).await?;
        Ok((resolved, login))
    }

    async fn resolve_workspace_context(
        &self,
        context: &P4Context,
        app: Option<&AppHandle>,
    ) -> Result<P4Context, ConnectionProfileError> {
        if !valid_entity_name(&context.client) {
            return Err(profile_switch_error(
                ConnectionProfileErrorCode::InvalidInput,
                "Workspace must be one exact literal client name.",
            ));
        }
        let operation_root = format!("connection-root-{}", Uuid::new_v4());
        let probe = connection_probe_context(context);
        let (exists, _) = self
            .setup
            .workspace_exists(
                &probe,
                &context.client,
                &format!("{operation_root}:exists"),
                app,
            )
            .await
            .map_err(|_| workspace_verification_failed())?;
        if !exists {
            return Err(profile_switch_error(
                ConnectionProfileErrorCode::NotFound,
                "The selected workspace no longer exists on the target server.",
            ));
        }
        let (spec, _) = self
            .setup
            .read_workspace(
                &probe,
                &context.client,
                &format!("{operation_root}:spec"),
                app,
            )
            .await
            .map_err(|_| workspace_verification_failed())?;
        let spec = spec.ok_or_else(workspace_verification_failed)?;
        let candidate = workspace_candidate_from_spec(&spec);
        let mut info_context = context.clone();
        info_context.client = spec.name.clone();
        info_context.cwd = Some(candidate.root.clone());
        let (runtime, _) = self
            .setup
            .inspect_workspace_runtime(&info_context, &format!("{operation_root}:info"), app)
            .await
            .map_err(|_| workspace_verification_failed())?;
        resolve_server_workspace(context, &spec, &runtime)
    }

    fn record_discovery(&self, started: Instant, result: &CliDiscoveryResult) {
        let context = P4Context::default();
        let succeeded = result.error_code.is_none();
        self.record_audit(
            "connection discover",
            &context,
            started,
            state_name(result.state),
            result.error_code.map(error_name),
            succeeded,
        );
    }

    fn record_status(
        &self,
        command: &str,
        context: &P4Context,
        started: Instant,
        status: &ConnectionStatus,
        succeeded: bool,
    ) {
        self.record_audit(
            command,
            context,
            started,
            state_name(status.state),
            status.error_code.map(error_name),
            succeeded,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn record_audit(
        &self,
        command: &str,
        context: &P4Context,
        started: Instant,
        state: &'static str,
        error_code: Option<&'static str>,
        succeeded: bool,
    ) {
        let operation_id = format!("connection-audit-{}", Uuid::new_v4());
        let connection = connection_id(&context.server, &context.user, &context.client);
        let _ = self.journal.start(
            &operation_id,
            &connection,
            "",
            OperationSource::Gui,
            OperationCategory::Authentication,
        );
        let failure = (!succeeded).then(|| journal_failure(error_code));
        let _ = self.journal.finish(
            &operation_id,
            if succeeded {
                JournalState::Succeeded
            } else {
                JournalState::Failed
            },
            failure,
        );
        let _ = self.logs.push(LogEntry {
            id: Uuid::new_v4().to_string(),
            timestamp: Utc::now().to_rfc3339(),
            level: if succeeded {
                LogLevel::Info
            } else {
                LogLevel::Error
            },
            operation_id,
            source: OperationSource::Gui,
            server: String::new(),
            workspace: String::new(),
            command: command.into(),
            message: format!("state={state} errorCode={}", error_code.unwrap_or("none")),
            duration_ms: Some(started.elapsed().as_millis() as u64),
            repeat_count: 1,
        });
    }
}

fn connection_probe_context(context: &P4Context) -> P4Context {
    let mut probe = context.clone();
    probe.client.clear();
    probe.cwd = None;
    probe
}

fn canonical_directory(value: &str) -> Result<PathBuf, ConnectionProfileError> {
    if value.trim().is_empty() || value.eq_ignore_ascii_case("null") {
        return Err(profile_switch_error(
            ConnectionProfileErrorCode::InvalidInput,
            "The workspace Root is empty or unsupported.",
        ));
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(profile_switch_error(
            ConnectionProfileErrorCode::InvalidInput,
            "The workspace Root must be an absolute path.",
        ));
    }
    let path = path.canonicalize().map_err(|_| {
        profile_switch_error(
            ConnectionProfileErrorCode::InvalidInput,
            "The workspace Root does not exist on this host.",
        )
    })?;
    if !path.is_dir() {
        return Err(profile_switch_error(
            ConnectionProfileErrorCode::InvalidInput,
            "The workspace Root is not a directory.",
        ));
    }
    Ok(path)
}

fn resolve_server_workspace(
    context: &P4Context,
    spec: &crate::p4::connection_setup::WorkspaceSpecSnapshot,
    runtime: &crate::p4::connection_setup::WorkspaceRuntimeIdentity,
) -> Result<P4Context, ConnectionProfileError> {
    if !spec.name.eq_ignore_ascii_case(context.client.trim())
        || !spec.owner.eq_ignore_ascii_case(context.user.trim())
    {
        return Err(profile_switch_error(
            ConnectionProfileErrorCode::ConnectionFailed,
            "The selected workspace identity or owner does not match the draft connection.",
        ));
    }
    let candidate = workspace_candidate_from_spec(spec);
    if !candidate.selectable {
        return Err(profile_switch_error(
            ConnectionProfileErrorCode::InvalidInput,
            format!(
                "The selected workspace Root is not usable on this host ({:?}).",
                candidate.root_status
            ),
        ));
    }
    let canonical = canonical_directory(&candidate.root)?;
    let effective_root = canonical_directory(&runtime.client_root)?;
    if !runtime.client_name.eq_ignore_ascii_case(&spec.name) || effective_root != canonical {
        return Err(profile_switch_error(
            ConnectionProfileErrorCode::ConnectionFailed,
            "P4 info did not confirm the selected workspace and effective Client root.",
        ));
    }
    let mut resolved = context.clone();
    resolved.client = spec.name.clone();
    resolved.cwd = Some(canonical.to_string_lossy().into_owned());
    Ok(resolved)
}

fn workspace_verification_failed() -> ConnectionProfileError {
    profile_switch_error(
        ConnectionProfileErrorCode::ConnectionFailed,
        "The workspace spec and effective Root could not be verified.",
    )
}

fn state_name(state: ConnectionState) -> &'static str {
    match state {
        ConnectionState::CliMissing => "cliMissing",
        ConnectionState::NotTested => "notTested",
        ConnectionState::Disconnected => "disconnected",
        ConnectionState::SslUntrusted => "sslUntrusted",
        ConnectionState::AuthRequired => "authRequired",
        ConnectionState::Connected => "connected",
        ConnectionState::TicketExpired => "ticketExpired",
        ConnectionState::NetworkError => "networkError",
        ConnectionState::PermissionDenied => "permissionDenied",
        ConnectionState::InvalidConfig => "invalidConfig",
        ConnectionState::ExternalAuthRequired => "externalAuthRequired",
        ConnectionState::Unsupported => "unsupported",
        ConnectionState::Unknown => "unknown",
    }
}

fn error_name(error: ConnectionErrorCode) -> &'static str {
    match error {
        ConnectionErrorCode::CliMissing => "cliMissing",
        ConnectionErrorCode::Disconnected => "disconnected",
        ConnectionErrorCode::SslUntrusted => "sslUntrusted",
        ConnectionErrorCode::AuthRequired => "authRequired",
        ConnectionErrorCode::TicketExpired => "ticketExpired",
        ConnectionErrorCode::NetworkError => "networkError",
        ConnectionErrorCode::PermissionDenied => "permissionDenied",
        ConnectionErrorCode::InvalidConfig => "invalidConfig",
        ConnectionErrorCode::ExternalAuthRequired => "externalAuthRequired",
        ConnectionErrorCode::Unsupported => "unsupported",
        ConnectionErrorCode::Unknown => "unknown",
    }
}

fn journal_failure(error: Option<&str>) -> OperationFailureKind {
    match error {
        Some("authRequired" | "ticketExpired" | "externalAuthRequired") => {
            OperationFailureKind::AuthExpired
        }
        Some("permissionDenied") => OperationFailureKind::PermissionDenied,
        Some("networkError" | "disconnected") => OperationFailureKind::ServerUnreachable,
        _ => OperationFailureKind::CommandFailure,
    }
}

fn logout_completed(status: &ConnectionStatus) -> bool {
    status.state == ConnectionState::AuthRequired
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

fn valid_fingerprint(value: &str) -> bool {
    let hex = value
        .chars()
        .filter(|character| character.is_ascii_hexdigit())
        .count();
    (32..=128).contains(&hex)
        && value
            .chars()
            .all(|character| character.is_ascii_hexdigit() || character == ':')
}

fn invalid_config(server: &str) -> ConnectionStatus {
    connection_error(
        ConnectionState::InvalidConfig,
        ConnectionErrorCode::InvalidConfig,
        RecoveryAction::EditConfig,
        server,
    )
}

fn connection_error(
    state: ConnectionState,
    code: ConnectionErrorCode,
    recovery: RecoveryAction,
    server: &str,
) -> ConnectionStatus {
    ConnectionStatus {
        state,
        error_code: Some(code),
        message: match state {
            ConnectionState::CliMissing => "P4 CLI is unavailable.",
            ConnectionState::InvalidConfig => "The connection configuration is invalid.",
            _ => "The connection is unavailable.",
        }
        .into(),
        recovery,
        server: server.into(),
        fingerprint: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_owned_root_replaces_an_existing_but_wrong_draft_directory() {
        let base = std::env::temp_dir().join(format!("p4deck-root-{}", Uuid::new_v4()));
        let server_root = base.join("server-root");
        let wrong_root = base.join("wrong-existing-root");
        std::fs::create_dir_all(&server_root).unwrap();
        std::fs::create_dir_all(&wrong_root).unwrap();
        let context = P4Context {
            server: "localhost:1666".into(),
            user: "tester".into(),
            client: "fixture-client".into(),
            cwd: Some(wrong_root.to_string_lossy().into_owned()),
            ..Default::default()
        };
        let spec = crate::p4::connection_setup::WorkspaceSpecSnapshot {
            name: "fixture-client".into(),
            owner: "tester".into(),
            host: String::new(),
            root: server_root.to_string_lossy().into_owned(),
            stream: String::new(),
            description: String::new(),
            options: "noallwrite noclobber noaltsync normdir".into(),
            view: vec!["//depot/... //fixture-client/...".into()],
        };
        let runtime = crate::p4::connection_setup::WorkspaceRuntimeIdentity {
            client_name: "fixture-client".into(),
            client_root: server_root.to_string_lossy().into_owned(),
        };
        let resolved = resolve_server_workspace(&context, &spec, &runtime).unwrap();
        assert_eq!(
            PathBuf::from(resolved.cwd.unwrap()).canonicalize().unwrap(),
            server_root.canonicalize().unwrap()
        );

        let mismatched = crate::p4::connection_setup::WorkspaceRuntimeIdentity {
            client_name: "fixture-client".into(),
            client_root: wrong_root.to_string_lossy().into_owned(),
        };
        assert!(resolve_server_workspace(&context, &spec, &mismatched).is_err());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[tokio::test]
    async fn connection_audit_is_structured_and_does_not_store_connection_values() {
        let base = std::env::temp_dir().join(format!("p4deck-audit-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let contexts = Arc::new(ContextStore::load(&base).unwrap());
        let logs = Arc::new(LogStore::open(&base.join("logs.sqlite")).unwrap());
        let journal = Arc::new(OperationJournal::open(&base.join("ops.sqlite")).unwrap());
        let runner = Arc::new(crate::p4::runner::P4Runner::new(
            logs.clone(),
            journal.clone(),
        ));
        let service = ConnectionService::new(
            contexts,
            ConnectionSetupRepository::new(runner),
            logs.clone(),
            journal.clone(),
        );
        let secret_server = "secret-company-server:1666";
        let status = service
            .test_connection(P4Context {
                server: secret_server.into(),
                user: String::new(),
                client: "secret-workspace".into(),
                ..Default::default()
            })
            .await;
        assert_eq!(status.state, ConnectionState::InvalidConfig);
        let entries = logs.query(&LogQuery::default());
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].command, "connection info");
        assert_eq!(
            entries[0].message,
            "state=invalidConfig errorCode=invalidConfig"
        );
        assert!(entries[0].server.is_empty());
        assert!(entries[0].workspace.is_empty());
        let serialized = serde_json::to_string(&entries).unwrap();
        assert!(!serialized.contains(secret_server));
        assert!(!serialized.contains("secret-workspace"));
        let record = journal.get(&entries[0].operation_id).unwrap();
        assert_eq!(record.category, OperationCategory::Authentication);
        assert_eq!(record.state, JournalState::Failed);
        drop(service);
        drop(logs);
        drop(journal);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn trust_requires_confirmation_and_a_fingerprint() {
        assert!(!valid_fingerprint("-y"));
        assert!(!valid_fingerprint("short"));
        assert!(valid_fingerprint(
            "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"
        ));

        let login: LoginRequest = serde_json::from_value(serde_json::json!({
            "context": { "server": "localhost:1666", "user": "tester", "client": "fixture" },
            "password": "single-use",
            "confirmed": true
        }))
        .unwrap();
        assert!(login.confirmed);
        assert_eq!(login.context.client, "fixture");
    }

    #[test]
    fn logout_audit_does_not_turn_transport_failures_into_success() {
        assert!(logout_completed(&connection_error(
            ConnectionState::AuthRequired,
            ConnectionErrorCode::AuthRequired,
            RecoveryAction::Login,
            "server",
        )));
        assert!(!logout_completed(&connection_error(
            ConnectionState::NetworkError,
            ConnectionErrorCode::NetworkError,
            RecoveryAction::Retry,
            "server",
        )));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_cli_receives_password_only_on_stdin() {
        use std::{fs, os::unix::fs::PermissionsExt};

        let directory = std::env::temp_dir().join(format!("p4deck-login-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let executable = directory.join("fake-p4");
        fs::write(
            &executable,
            r#"#!/bin/sh
if [ "$1" = "-V" ]; then echo "Rev. P4/FAKE/2026.1"; exit 0; fi
case "$*" in *"single-use-secret"*) echo "secret was passed as an argument" >&2; exit 9;; esac
if [ "$*" = "-p localhost:1666 -u tester -c fixture trust -i AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99" ]; then echo "Trust added."; exit 0; fi
if [ "$*" != "-p localhost:1666 -u tester -c fixture login" ]; then echo "unexpected arguments" >&2; exit 8; fi
read supplied
if [ "$supplied" = "single-use-secret" ]; then echo "User logged in."; exit 0; fi
echo "Perforce password (P4PASSWD) invalid or unset" >&2
exit 1
"#,
        )
        .unwrap();
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&executable, permissions).unwrap();
        let context = P4Context {
            executable: Some(executable.to_string_lossy().into_owned()),
            server: "localhost:1666".into(),
            user: "tester".into(),
            client: "fixture".into(),
            ..Default::default()
        };

        let discovery = ConnectionAdapter::discover(context.executable.as_deref());
        assert_eq!(discovery.state, ConnectionState::NotTested);
        assert_eq!(discovery.version.as_deref(), Some("Rev. P4/FAKE/2026.1"));

        let result = ConnectionAdapter::execute(
            &context,
            ConnectionOperation::Login,
            None,
            Some("single-use-secret"),
        )
        .await;
        assert_eq!(result.state, ConnectionState::Connected);
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("single-use-secret"));
        let trusted = ConnectionAdapter::execute(
            &context,
            ConnectionOperation::Trust,
            Some("AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"),
            None,
        )
        .await;
        assert_eq!(trusted.state, ConnectionState::NotTested);
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);

        fs::remove_dir_all(directory).unwrap();
    }
}
