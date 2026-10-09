use crate::{
    domain::*,
    p4::{
        connection::{ConnectionAdapter, ConnectionOperation},
        context::{validate_connection_context, ContextStore},
    },
};
use std::sync::Arc;

pub struct ConnectionService {
    contexts: Arc<ContextStore>,
}

impl ConnectionService {
    pub fn new(contexts: Arc<ContextStore>) -> Self {
        Self { contexts }
    }

    pub fn context(&self) -> P4Context {
        self.contexts.current()
    }

    pub fn save(&self, context: P4Context) -> Result<P4Context, ConnectionProfileError> {
        self.contexts.save(context)
    }

    pub fn profiles(&self) -> ConnectionProfiles {
        self.contexts.profiles()
    }

    pub fn active_profile(&self) -> Option<ConnectionProfile> {
        self.contexts.active_profile()
    }

    pub fn create_profile(
        &self,
        request: CreateConnectionProfileRequest,
    ) -> Result<ConnectionProfiles, ConnectionProfileError> {
        self.contexts
            .create(request.expected_revision, request.name, request.context)
    }

    pub fn update_profile(
        &self,
        request: UpdateConnectionProfileRequest,
    ) -> Result<ConnectionProfiles, ConnectionProfileError> {
        self.contexts.update(
            request.expected_revision,
            &request.id,
            request.name,
            request.context,
        )
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
        let connection = if cli.state == ConnectionState::CliMissing {
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
    ) -> Result<RuntimeInfo, ConnectionProfileError> {
        let profile = self
            .contexts
            .profile_at_revision(request.expected_revision, &request.id)?;
        let status = verify_switch(&profile.context).await?;
        self.contexts
            .activate_if_unchanged(request.expected_revision, &request.id)?;
        Ok(self.runtime_info_with_status(status))
    }

    pub async fn switch_workspace(
        &self,
        request: SwitchWorkspaceRequest,
        root: String,
    ) -> Result<RuntimeInfo, ConnectionProfileError> {
        let (mut candidate, generation) = self.contexts.snapshot();
        if generation != request.expected_generation {
            return Err(profile_switch_error(
                ConnectionProfileErrorCode::ContextChanged,
                "The active connection changed before workspace verification started.",
            ));
        }
        candidate.client = request.client;
        candidate.cwd = Some(root);
        let status = verify_switch(&candidate).await?;
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

    pub fn discover_cli(&self, request: CliDiscoveryRequest) -> CliDiscoveryResult {
        ConnectionAdapter::discover(request.executable.as_deref())
    }

    pub async fn test_connection(&self, context: P4Context) -> ConnectionStatus {
        if validate_connection_context(&context).is_err() {
            return invalid_config(&context.server);
        }
        ConnectionAdapter::execute(&context, ConnectionOperation::Info, None, None).await
    }

    pub async fn login_status(&self, context: P4Context) -> ConnectionStatus {
        if validate_connection_context(&context).is_err() {
            return invalid_config(&context.server);
        }
        ConnectionAdapter::execute(&context, ConnectionOperation::LoginStatus, None, None).await
    }

    pub async fn trust(&self, request: TrustRequest) -> ConnectionStatus {
        if !request.confirmed
            || validate_connection_context(&request.context).is_err()
            || !valid_fingerprint(&request.fingerprint)
        {
            return invalid_config(&request.context.server);
        }
        ConnectionAdapter::execute(
            &request.context,
            ConnectionOperation::Trust,
            Some(&request.fingerprint),
            None,
        )
        .await
    }

    pub async fn login(&self, request: LoginRequest) -> ConnectionStatus {
        if !request.confirmed
            || validate_connection_context(&request.context).is_err()
            || request.password.is_empty()
            || request.password.len() > 4096
            || request.password.chars().any(char::is_control)
        {
            return invalid_config(&request.context.server);
        }
        ConnectionAdapter::execute(
            &request.context,
            ConnectionOperation::Login,
            None,
            Some(&request.password),
        )
        .await
    }

    pub async fn logout(&self, request: AuthenticationRequest) -> ConnectionStatus {
        if !request.confirmed || validate_connection_context(&request.context).is_err() {
            return invalid_config(&request.context.server);
        }
        ConnectionAdapter::execute(&request.context, ConnectionOperation::Logout, None, None).await
    }
}

async fn verify_switch(context: &P4Context) -> Result<ConnectionStatus, ConnectionProfileError> {
    validate_connection_context(context).map_err(|message| {
        profile_switch_error(ConnectionProfileErrorCode::InvalidInput, message)
    })?;
    let connection =
        ConnectionAdapter::execute(context, ConnectionOperation::Info, None, None).await;
    if connection.state != ConnectionState::Connected {
        return Err(profile_switch_error(
            ConnectionProfileErrorCode::ConnectionFailed,
            format!("Connection verification failed: {}", connection.message),
        ));
    }
    let login =
        ConnectionAdapter::execute(context, ConnectionOperation::LoginStatus, None, None).await;
    if login.state != ConnectionState::Connected {
        return Err(profile_switch_error(
            ConnectionProfileErrorCode::AuthenticationRequired,
            format!("Authentication verification failed: {}", login.message),
        ));
    }
    Ok(login)
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
