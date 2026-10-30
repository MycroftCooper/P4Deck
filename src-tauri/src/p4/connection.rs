//! Controlled P4 CLI adapter for connection and authentication operations.

use crate::domain::{
    CliDiscoveryResult, ConnectionErrorCode, ConnectionState, ConnectionStatus, P4Context,
    RecoveryAction,
};
use std::{
    path::PathBuf,
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::{io::AsyncWriteExt, process::Command};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectionOperation {
    Info,
    LoginStatus,
    Trust,
    Login,
    Logout,
}

pub struct ConnectionAdapter;

impl ConnectionAdapter {
    pub fn discover(explicit: Option<&str>) -> CliDiscoveryResult {
        let Some(executable) = resolve_executable(explicit) else {
            return CliDiscoveryResult {
                state: ConnectionState::CliMissing,
                executable: None,
                version: None,
                error_code: Some(ConnectionErrorCode::CliMissing),
                message: "P4 CLI was not found. Configure a trusted p4 executable.".into(),
            };
        };
        let Some(output) = bounded_version_output(&executable) else {
            return invalid_cli(executable);
        };
        let combined = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let version = combined
            .lines()
            .find(|line| line.trim_start().starts_with("Rev."))
            .map(|line| line.trim().chars().take(256).collect::<String>());
        if !output.status.success() || version.is_none() {
            return invalid_cli(executable);
        }
        CliDiscoveryResult {
            state: ConnectionState::NotTested,
            executable: Some(executable.to_string_lossy().into_owned()),
            version,
            error_code: None,
            message: "P4 CLI is available; server connectivity has not been tested.".into(),
        }
    }

    pub async fn execute(
        context: &P4Context,
        operation: ConnectionOperation,
        value: Option<&str>,
        secret_stdin: Option<&str>,
    ) -> ConnectionStatus {
        let mut automatic_unicode = false;
        loop {
            let Some(executable) = resolve_executable(context.executable.as_deref()) else {
                return status(
                    ConnectionState::CliMissing,
                    Some(ConnectionErrorCode::CliMissing),
                    RecoveryAction::ConfigureCli,
                    &context.server,
                    None,
                );
            };

            let mut command = Command::from(super::process::command(executable));
            append_context(&mut command, context);
            if automatic_unicode {
                command.env("P4CHARSET", "auto");
            }
            append_operation(&mut command, operation, value);
            command
                .env_remove("P4PASSWD")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(_) => {
                    return status(
                        ConnectionState::CliMissing,
                        Some(ConnectionErrorCode::CliMissing),
                        RecoveryAction::ConfigureCli,
                        &context.server,
                        None,
                    )
                }
            };
            let mut input_failed = false;
            if let Some(secret) = secret_stdin {
                if let Some(mut stdin) = child.stdin.take() {
                    if stdin.write_all(secret.as_bytes()).await.is_err()
                        || stdin.write_all(b"\n").await.is_err()
                        || stdin.shutdown().await.is_err()
                    {
                        // A server can reject the charset before consuming stdin.
                        // Read its error before deciding whether this was a pipe failure.
                        input_failed = true;
                    }
                }
            } else {
                drop(child.stdin.take());
            }
            let output =
                match tokio::time::timeout(Duration::from_secs(20), child.wait_with_output()).await
                {
                    Ok(Ok(output)) => output,
                    _ => {
                        return status(
                            ConnectionState::NetworkError,
                            Some(ConnectionErrorCode::NetworkError),
                            RecoveryAction::Retry,
                            &context.server,
                            None,
                        )
                    }
                };
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            if !output.status.success()
                && !automatic_unicode
                && context.charset.as_deref().is_none_or(str::is_empty)
                && requires_unicode(&format!("{stdout}\n{stderr}"))
            {
                // Only negotiate when the server explicitly rejects non-Unicode mode.
                // An explicit charset (including `none`) is never overridden.
                automatic_unicode = true;
                continue;
            }
            if input_failed && output.status.success() {
                return status(
                    ConnectionState::Disconnected,
                    Some(ConnectionErrorCode::Disconnected),
                    RecoveryAction::Retry,
                    &context.server,
                    None,
                );
            }
            return classify(
                operation,
                output.status.success(),
                &stdout,
                &stderr,
                &context.server,
            );
        }
    }
}

fn bounded_version_output(executable: &std::path::Path) -> Option<std::process::Output> {
    let mut child = super::process::command(executable)
        .arg("-V")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().ok(),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

pub(crate) fn resolve_executable(explicit: Option<&str>) -> Option<PathBuf> {
    let requested = explicit.map(str::trim).filter(|value| !value.is_empty());
    if let Some(requested) = requested {
        let path = PathBuf::from(requested);
        if path.is_absolute() || path.components().count() > 1 {
            return path.is_file().then_some(path);
        }
        return search_path(requested).or_else(|| {
            cfg!(windows)
                .then(|| search_path(&format!("{requested}.exe")))
                .flatten()
        });
    }
    search_path(if cfg!(windows) { "p4.exe" } else { "p4" }).or_else(|| {
        if !cfg!(windows) {
            return None;
        }
        standard_installation(
            ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
                .into_iter()
                .filter_map(std::env::var_os)
                .map(PathBuf::from),
            |path| path.is_file(),
        )
    })
}

fn standard_installation(
    roots: impl IntoIterator<Item = PathBuf>,
    is_file: impl Fn(&std::path::Path) -> bool,
) -> Option<PathBuf> {
    roots
        .into_iter()
        .filter(|root| root.is_absolute())
        .map(|root| root.join("Perforce").join("p4.exe"))
        .find(|path| is_file(path))
}

fn search_path(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|directory| directory.join(name))
        .find(|path| path.is_file())
}

fn invalid_cli(executable: PathBuf) -> CliDiscoveryResult {
    CliDiscoveryResult {
        state: ConnectionState::InvalidConfig,
        executable: Some(executable.to_string_lossy().into_owned()),
        version: None,
        error_code: Some(ConnectionErrorCode::InvalidConfig),
        message: "The configured executable is not a supported P4 CLI.".into(),
    }
}

fn append_context(command: &mut Command, context: &P4Context) {
    // Connection probes must use the explicit draft, never a stale active workspace or a
    // machine-level P4CONFIG/P4ENVIRO value. Explicit credential file paths are restored below.
    for name in [
        "P4CONFIG",
        "P4ENVIRO",
        "P4PORT",
        "P4USER",
        "P4CLIENT",
        "P4CHARSET",
    ] {
        command.env_remove(name);
    }
    // Removing P4CHARSET exposes the Windows registry fallback. An omitted draft charset must
    // not fall back to "none": Helix servers store descriptions in Unicode, and "none" makes P4
    // emit raw bytes (mojibake) or the literal "untranslatable" for CJK text. Default to utf8
    // unless the profile explicitly asks for another charset (including "none").
    let charset = context
        .charset
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or("utf8");
    command.env("P4CHARSET", charset);
    command.args(["-p", &context.server, "-u", &context.user]);
    if !context.client.is_empty() {
        command.args(["-c", &context.client]);
    }
    command.args(["-C", charset]);
    if let Some(cwd) = context.cwd.as_deref().filter(|value| !value.is_empty()) {
        command.args(["-d", cwd]);
    }
    if let Some(path) = &context.trust_path {
        command.env("P4TRUST", path);
    }
    if let Some(path) = &context.tickets_path {
        command.env("P4TICKETS", path);
    }
}

fn append_operation(command: &mut Command, operation: ConnectionOperation, value: Option<&str>) {
    match operation {
        ConnectionOperation::Info => {
            command.arg("info");
        }
        ConnectionOperation::LoginStatus => {
            command.args(["login", "-s"]);
        }
        ConnectionOperation::Trust => {
            command.args(["trust", "-i", value.expect("validated fingerprint")]);
        }
        ConnectionOperation::Login => {
            command.arg("login");
        }
        ConnectionOperation::Logout => {
            command.arg("logout");
        }
    }
}

fn classify(
    operation: ConnectionOperation,
    success: bool,
    stdout: &str,
    stderr: &str,
    server: &str,
) -> ConnectionStatus {
    let combined = format!("{stdout}\n{stderr}");
    let lower = combined.to_ascii_lowercase();
    if success {
        return match operation {
            ConnectionOperation::Logout => status(
                ConnectionState::AuthRequired,
                Some(ConnectionErrorCode::AuthRequired),
                RecoveryAction::Login,
                server,
                None,
            ),
            ConnectionOperation::Trust => status(
                ConnectionState::NotTested,
                None,
                RecoveryAction::Retry,
                server,
                None,
            ),
            _ => status(
                ConnectionState::Connected,
                None,
                RecoveryAction::None,
                server,
                None,
            ),
        };
    }
    if contains_any(
        &lower,
        &[
            "single sign-on",
            "sso",
            "multi-factor",
            "mfa",
            "open your browser",
        ],
    ) {
        return status(
            ConnectionState::ExternalAuthRequired,
            Some(ConnectionErrorCode::ExternalAuthRequired),
            RecoveryAction::CompleteExternalAuth,
            server,
            None,
        );
    }
    if contains_any(
        &lower,
        &["authenticity", "not trusted", "p4trust", "ssl trust"],
    ) {
        return status(
            ConnectionState::SslUntrusted,
            Some(ConnectionErrorCode::SslUntrusted),
            RecoveryAction::TrustServer,
            server,
            extract_fingerprint(&combined),
        );
    }
    if contains_any(
        &lower,
        &[
            "ticket expired",
            "session has expired",
            "login ticket expired",
        ],
    ) {
        return status(
            ConnectionState::TicketExpired,
            Some(ConnectionErrorCode::TicketExpired),
            RecoveryAction::Login,
            server,
            None,
        );
    }
    if contains_any(
        &lower,
        &[
            "password invalid",
            "password (p4passwd) invalid",
            "must login",
            "not logged in",
        ],
    ) {
        return status(
            ConnectionState::AuthRequired,
            Some(ConnectionErrorCode::AuthRequired),
            RecoveryAction::Login,
            server,
            None,
        );
    }
    if contains_any(
        &lower,
        &["permission denied", "protections table", "no permission"],
    ) {
        return status(
            ConnectionState::PermissionDenied,
            Some(ConnectionErrorCode::PermissionDenied),
            RecoveryAction::ContactAdmin,
            server,
            None,
        );
    }
    if contains_any(
        &lower,
        &[
            "tcp connect",
            "connect to server failed",
            "connection refused",
            "connection timed out",
            "network is unreachable",
            "name or service not known",
            "nodename nor servname",
            "unknown host",
        ],
    ) {
        return status(
            ConnectionState::NetworkError,
            Some(ConnectionErrorCode::NetworkError),
            RecoveryAction::Retry,
            server,
            None,
        );
    }
    if contains_any(
        &lower,
        &["server is not responding", "partner exited unexpectedly"],
    ) {
        return status(
            ConnectionState::Disconnected,
            Some(ConnectionErrorCode::Disconnected),
            RecoveryAction::Retry,
            server,
            None,
        );
    }
    if contains_any(
        &lower,
        &[
            "client unknown",
            "unicode server permits only unicode enabled clients",
            "unicode clients require a unicode enabled server",
            "invalid character set",
            "client name is required",
            "p4port unset",
            "usage:",
            "invalid option",
        ],
    ) {
        return status(
            ConnectionState::InvalidConfig,
            Some(ConnectionErrorCode::InvalidConfig),
            RecoveryAction::EditConfig,
            server,
            None,
        );
    }
    status(
        ConnectionState::Unknown,
        Some(ConnectionErrorCode::Unknown),
        RecoveryAction::Retry,
        server,
        None,
    )
}

fn contains_any(value: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| value.contains(needle))
}

fn requires_unicode(value: &str) -> bool {
    value
        .to_ascii_lowercase()
        .contains("unicode server permits only unicode enabled clients")
}

pub fn classify_connection_error(value: &str) -> ConnectionErrorCode {
    classify(ConnectionOperation::Info, false, "", value, "")
        .error_code
        .unwrap_or(ConnectionErrorCode::Unknown)
}

fn extract_fingerprint(value: &str) -> Option<String> {
    value
        .split_whitespace()
        .map(|part| {
            part.trim_matches(|character: char| !character.is_ascii_hexdigit() && character != ':')
        })
        .find(|part| {
            let hex = part
                .chars()
                .filter(|character| character.is_ascii_hexdigit())
                .count();
            hex >= 32
                && part
                    .chars()
                    .all(|character| character.is_ascii_hexdigit() || character == ':')
        })
        .map(str::to_owned)
}

fn status(
    state: ConnectionState,
    error_code: Option<ConnectionErrorCode>,
    recovery: RecoveryAction,
    server: &str,
    fingerprint: Option<String>,
) -> ConnectionStatus {
    let message = match state {
        ConnectionState::CliMissing => "P4 CLI is unavailable.",
        ConnectionState::NotTested => "Server connectivity has not been tested.",
        ConnectionState::Disconnected => "The P4 server is not responding.",
        ConnectionState::SslUntrusted => "The server certificate requires explicit trust.",
        ConnectionState::AuthRequired => "Authentication is required.",
        ConnectionState::Connected => "The P4 connection is ready.",
        ConnectionState::TicketExpired => "The login ticket has expired.",
        ConnectionState::NetworkError => "The P4 server could not be reached.",
        ConnectionState::PermissionDenied => "The authenticated user lacks permission.",
        ConnectionState::InvalidConfig => "The connection configuration is invalid.",
        ConnectionState::ExternalAuthRequired => "Authentication must be completed externally.",
        ConnectionState::Unsupported => "This authentication flow is not supported in-app.",
        ConnectionState::Unknown => "The P4 command failed for an unknown reason.",
    };
    ConnectionStatus {
        state,
        error_code,
        message: message.into(),
        recovery,
        server: server.into(),
        fingerprint,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_cli_discovery_is_bounded_and_does_not_execute() {
        let root = std::env::temp_dir().join("synthetic-program-files");
        let first = root.join("first");
        let second = root.join("second");
        let expected = second.join("Perforce").join("p4.exe");
        assert_eq!(
            standard_installation([first, second], |path| path == expected),
            Some(expected)
        );
        assert!(standard_installation([root], |_| false).is_none());
        assert!(standard_installation([PathBuf::from("relative")], |_| true).is_none());
    }

    #[test]
    fn draft_charset_overrides_registry_and_environment_defaults() {
        for (charset, expected) in [(None, "utf8"), (Some(""), "utf8"), (Some("utf8"), "utf8")] {
            let context = P4Context {
                charset: charset.map(str::to_owned),
                ..P4Context::default()
            };
            let mut command = Command::new("p4");
            append_context(&mut command, &context);
            let value = command
                .as_std()
                .get_envs()
                .find(|(name, _)| *name == "P4CHARSET")
                .and_then(|(_, value)| value);
            assert_eq!(value, Some(std::ffi::OsStr::new(expected)));
        }
    }

    fn classified(message: &str) -> ConnectionStatus {
        classify(
            ConnectionOperation::Info,
            false,
            "",
            message,
            "ssl:test:1666",
        )
    }

    #[test]
    fn classifies_actionable_p4_failures_without_returning_raw_output() {
        let cases = [
            ("The authenticity of ssl:test can't be established AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99", ConnectionState::SslUntrusted),
            ("Perforce password (P4PASSWD) invalid or unset", ConnectionState::AuthRequired),
            ("Your session has expired; ticket expired", ConnectionState::TicketExpired),
            ("TCP connect to test failed", ConnectionState::NetworkError),
            ("Partner exited unexpectedly", ConnectionState::Disconnected),
            ("Permission denied by protections table", ConnectionState::PermissionDenied),
            ("Client unknown", ConnectionState::InvalidConfig),
            ("Unicode server permits only unicode enabled clients.", ConnectionState::InvalidConfig),
            ("Unicode clients require a unicode enabled server.", ConnectionState::InvalidConfig),
            ("Run SSO and open your browser", ConnectionState::ExternalAuthRequired),
            ("totally novel failure secret-value", ConnectionState::Unknown),
        ];
        for (raw, expected) in cases {
            let result = classified(raw);
            assert_eq!(result.state, expected);
            assert!(!result.message.contains(raw));
            assert!(!result.message.contains("secret-value"));
        }
    }

    #[test]
    fn serializes_the_camel_case_ipc_contract() {
        let value = serde_json::to_value(status(
            ConnectionState::SslUntrusted,
            Some(ConnectionErrorCode::SslUntrusted),
            RecoveryAction::TrustServer,
            "ssl:test:1666",
            None,
        ))
        .unwrap();
        assert_eq!(value["state"], "sslUntrusted");
        assert_eq!(value["errorCode"], "sslUntrusted");
        assert_eq!(value["recovery"], "trustServer");
    }

    #[test]
    fn successful_info_is_connected_and_missing_cli_is_structured() {
        let connected = classify(
            ConnectionOperation::Info,
            true,
            "User name: tester\nServer address: localhost:1666",
            "",
            "localhost:1666",
        );
        assert_eq!(connected.state, ConnectionState::Connected);
        let missing = ConnectionAdapter::discover(Some("/definitely/missing/p4"));
        assert_eq!(missing.state, ConnectionState::CliMissing);
        assert_eq!(missing.error_code, Some(ConnectionErrorCode::CliMissing));
    }

    #[tokio::test]
    #[ignore = "Requires P4DECK_CHARSET_PROBE_CASES with read-only login-status contexts"]
    async fn live_charset_login_status_regression() {
        let cases: Vec<(P4Context, ConnectionState)> = serde_json::from_str(
            &std::env::var("P4DECK_CHARSET_PROBE_CASES").expect("explicit probe cases required"),
        )
        .unwrap();
        assert!(!cases.is_empty());
        for (context, expected) in cases {
            let result =
                ConnectionAdapter::execute(&context, ConnectionOperation::LoginStatus, None, None)
                    .await;
            assert_eq!(result.state, expected);
        }
    }

    #[test]
    fn controlled_authentication_operations_keep_their_narrow_cli_shapes() {
        let cases = [
            (
                ConnectionOperation::Trust,
                Some("AA:BB"),
                vec!["trust", "-i", "AA:BB"],
            ),
            (ConnectionOperation::Login, None, vec!["login"]),
            (ConnectionOperation::Logout, None, vec!["logout"]),
        ];
        for (operation, value, expected) in cases {
            let mut command = Command::new("p4");
            append_operation(&mut command, operation, value);
            let args = command
                .as_std()
                .get_args()
                .map(|value| value.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            assert_eq!(args, expected);
        }
    }
}
