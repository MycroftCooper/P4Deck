use crate::{
    domain::{
        ConnectionErrorCode, ConnectionUserCandidate, ConnectionWorkspaceCandidate,
        ConnectionWorkspaceRootStatus, OperationResult, OperationSource, OutputMode,
        P4CommandRequest, P4Context, WorkspaceSyncMode,
    },
    p4::runner::{MutationGuard, P4Runner},
};
use serde_json::Value;
use std::sync::Arc;
use tauri::AppHandle;

pub const DIRECTORY_SENTINEL_LIMIT: usize = 501;
pub const DIRECTORY_RESULT_LIMIT: usize = 500;
const MAX_ENTITY_NAME: usize = 128;

pub fn valid_entity_name(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_ENTITY_NAME
        && !value.starts_with('-')
        && value.chars().all(|c| {
            !c.is_control() && !c.is_whitespace() && !matches!(c, '*' | '%' | '@' | '#' | '"')
        })
}

#[derive(Debug)]
pub struct DirectoryBatch<T> {
    pub items: Vec<T>,
    pub scanned_count: usize,
    pub truncated: bool,
    pub operation_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerIdentity {
    pub server_id: Option<String>,
    pub server_address: String,
    pub user_name: String,
    pub server_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceSpecSnapshot {
    pub name: String,
    pub owner: String,
    pub host: String,
    pub root: String,
    pub stream: String,
    pub description: String,
    pub options: String,
    pub view: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceRuntimeIdentity {
    pub client_name: String,
    pub client_root: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpecWriteError {
    Rejected(ConnectionErrorCode),
    Unknown,
}

#[derive(Clone)]
pub struct ConnectionSetupRepository {
    runner: Arc<P4Runner>,
}

impl ConnectionSetupRepository {
    pub fn new(runner: Arc<P4Runner>) -> Self {
        Self { runner }
    }

    pub async fn list_users(
        &self,
        context: &P4Context,
        prefix: Option<&str>,
        operation_id: &str,
        app: Option<&AppHandle>,
    ) -> Result<DirectoryBatch<ConnectionUserCandidate>, String> {
        let mut args = vec!["-m".into(), DIRECTORY_SENTINEL_LIMIT.to_string()];
        if let Some(prefix) = prefix {
            args.push(format!("{prefix}*"));
        }
        let result = self
            .run_read(context, "users", args, operation_id, app)
            .await?;
        let mut items = json_records(&result)?
            .into_iter()
            .filter_map(parse_user)
            .filter(|item| prefix_matches(&item.name, prefix))
            .collect::<Vec<_>>();
        items.sort_by(|left, right| left.name.cmp(&right.name));
        let scanned_count = items.len();
        let truncated = scanned_count >= DIRECTORY_SENTINEL_LIMIT;
        items.truncate(DIRECTORY_RESULT_LIMIT);
        Ok(DirectoryBatch {
            items,
            scanned_count,
            truncated,
            operation_ids: vec![result.operation_id],
        })
    }

    pub async fn list_workspaces(
        &self,
        context: &P4Context,
        prefix: Option<&str>,
        operation_id: &str,
        app: Option<&AppHandle>,
    ) -> Result<DirectoryBatch<ConnectionWorkspaceCandidate>, String> {
        let mut args = vec![
            "--me".into(),
            "-t".into(),
            "-m".into(),
            DIRECTORY_SENTINEL_LIMIT.to_string(),
        ];
        if let Some(prefix) = prefix {
            args.extend(["-e".into(), format!("{prefix}*")]);
        }
        let result = self
            .run_read(context, "clients", args, operation_id, app)
            .await?;
        let mut items = json_records(&result)?
            .into_iter()
            .filter_map(parse_workspace)
            .filter(|item| prefix_matches(&item.name, prefix))
            .collect::<Vec<_>>();
        items.sort_by(|left, right| left.name.cmp(&right.name));
        let scanned_count = items.len();
        let truncated = scanned_count >= DIRECTORY_SENTINEL_LIMIT;
        items.truncate(DIRECTORY_RESULT_LIMIT);
        Ok(DirectoryBatch {
            items,
            scanned_count,
            truncated,
            operation_ids: vec![result.operation_id],
        })
    }

    pub async fn inspect_identity(
        &self,
        context: &P4Context,
        operation_id: &str,
        app: Option<&AppHandle>,
    ) -> Result<(ServerIdentity, String), String> {
        let result = self
            .run_read(context, "info", Vec::new(), operation_id, app)
            .await?;
        let identity = json_records(&result)?
            .into_iter()
            .find_map(parse_identity)
            .ok_or_else(|| "P4 info did not return a verifiable server identity.".to_owned())?;
        Ok((identity, result.operation_id))
    }

    pub async fn inspect_workspace_runtime(
        &self,
        context: &P4Context,
        operation_id: &str,
        app: Option<&AppHandle>,
    ) -> Result<(WorkspaceRuntimeIdentity, String), String> {
        let result = self
            .run_read(context, "info", Vec::new(), operation_id, app)
            .await?;
        let identity = json_records(&result)?
            .into_iter()
            .find_map(parse_workspace_runtime)
            .ok_or_else(|| "P4 info did not return a verifiable workspace Root.".to_owned())?;
        Ok((identity, result.operation_id))
    }

    pub async fn user_exists(
        &self,
        context: &P4Context,
        name: &str,
        operation_id: &str,
        app: Option<&AppHandle>,
    ) -> Result<(bool, String), String> {
        let result = self
            .run_read(
                context,
                "users",
                vec!["-m".into(), "2".into(), name.into()],
                operation_id,
                app,
            )
            .await?;
        let exists = json_records(&result)?
            .into_iter()
            .filter_map(parse_user)
            .next()
            .is_some();
        Ok((exists, result.operation_id))
    }

    pub async fn workspace_exists(
        &self,
        context: &P4Context,
        name: &str,
        operation_id: &str,
        app: Option<&AppHandle>,
    ) -> Result<(bool, String), String> {
        let result = self
            .run_read(
                context,
                "clients",
                vec!["-m".into(), "2".into(), "-e".into(), name.into()],
                operation_id,
                app,
            )
            .await?;
        let exists = json_records(&result)?
            .into_iter()
            .filter_map(parse_workspace)
            .next()
            .is_some();
        Ok((exists, result.operation_id))
    }

    pub async fn read_user(
        &self,
        context: &P4Context,
        name: &str,
        operation_id: &str,
        app: Option<&AppHandle>,
    ) -> Result<(Option<ConnectionUserCandidate>, String), String> {
        let result = self
            .run_read(
                context,
                "users",
                vec!["-m".into(), "2".into(), name.into()],
                operation_id,
                app,
            )
            .await?;
        let user = json_records(&result)?
            .into_iter()
            .filter_map(parse_user)
            .find(|user| names_equal(&user.name, name));
        Ok((user, result.operation_id))
    }

    pub async fn read_workspace(
        &self,
        context: &P4Context,
        name: &str,
        operation_id: &str,
        app: Option<&AppHandle>,
    ) -> Result<(Option<WorkspaceSpecSnapshot>, String), String> {
        let result = self
            .run_read(
                context,
                "client",
                vec!["-o".into(), name.into()],
                operation_id,
                app,
            )
            .await?;
        let spec = json_records(&result)?
            .into_iter()
            .find_map(parse_workspace_spec);
        Ok((spec, result.operation_id))
    }

    pub async fn create_user(
        &self,
        context: &P4Context,
        form: String,
        operation_id: &str,
        app: Option<&AppHandle>,
        guard: &MutationGuard,
    ) -> Result<String, SpecWriteError> {
        self.run_write(
            context,
            "user",
            vec!["-i".into()],
            form,
            operation_id,
            app,
            guard,
        )
        .await
    }

    pub async fn create_workspace(
        &self,
        context: &P4Context,
        form: String,
        operation_id: &str,
        app: Option<&AppHandle>,
        guard: &MutationGuard,
    ) -> Result<String, SpecWriteError> {
        self.run_write(
            context,
            "client",
            vec!["-i".into()],
            form,
            operation_id,
            app,
            guard,
        )
        .await
    }

    pub async fn lock_mutations(&self, server: &str) -> MutationGuard {
        self.runner.lock_mutations(server).await
    }

    async fn run_read(
        &self,
        context: &P4Context,
        command: &str,
        args: Vec<String>,
        operation_id: &str,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        let result = self
            .runner
            .run(
                P4CommandRequest {
                    operation_id: Some(operation_id.into()),
                    source: OperationSource::Gui,
                    command: command.into(),
                    args,
                    context: context.clone(),
                    output_mode: OutputMode::JsonLines,
                    timeout_ms: Some(30_000),
                    input: None,
                },
                app,
            )
            .await
            .map_err(|_| {
                "The P4 query could not be completed; see the operation log.".to_owned()
            })?;
        if result.exit_code != 0 {
            return Err(
                "The P4 query failed; check authentication, permission, and the operation log."
                    .into(),
            );
        }
        Ok(result)
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_write(
        &self,
        context: &P4Context,
        command: &str,
        args: Vec<String>,
        input: String,
        operation_id: &str,
        app: Option<&AppHandle>,
        guard: &MutationGuard,
    ) -> Result<String, SpecWriteError> {
        let result = self
            .runner
            .run_with_mutation_guard(
                P4CommandRequest {
                    operation_id: Some(operation_id.into()),
                    source: OperationSource::Gui,
                    command: command.into(),
                    args,
                    context: context.clone(),
                    // P4 form stdin is plain text. `-Mj` changes the accepted stdin
                    // protocol for `user -i` / `client -i`, so writes must stay text.
                    output_mode: OutputMode::Text,
                    timeout_ms: Some(30_000),
                    input: Some(input),
                },
                app,
                None,
                guard,
            )
            .await
            .map_err(|_| SpecWriteError::Unknown)?;
        if result.exit_code != 0 {
            let output = result
                .events
                .iter()
                .filter_map(|event| event.message.as_deref())
                .collect::<Vec<_>>()
                .join("\n");
            return Err(SpecWriteError::Rejected(
                crate::p4::connection::classify_connection_error(&output),
            ));
        }
        Ok(result.operation_id)
    }
}

fn json_records(result: &OperationResult) -> Result<Vec<Value>, String> {
    let mut records = Vec::new();
    for event in &result.events {
        if !matches!(
            event.kind,
            crate::domain::EventKind::Stdout | crate::domain::EventKind::Stderr
        ) {
            continue;
        }
        let Some(message) = event.message.as_deref() else {
            continue;
        };
        for line in message.lines().filter(|line| !line.trim().is_empty()) {
            let value: Value = serde_json::from_str(line)
                .map_err(|_| "P4 returned malformed structured output.".to_owned())?;
            if !value.is_object() {
                return Err("P4 returned a non-object structured record.".into());
            }
            let severity = value.get("severity").and_then(Value::as_u64).unwrap_or(0);
            let generic = value.get("generic").and_then(Value::as_u64);
            if severity >= 3
                || (value.get("code").and_then(Value::as_str) == Some("error")
                    && generic != Some(17))
            {
                return Err("P4 returned a structured server error.".into());
            }
            records.push(value);
        }
    }
    Ok(records)
}

fn value_string(value: &Value, names: &[&str]) -> String {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(Value::as_str))
        .unwrap_or("")
        .to_owned()
}

fn value_i64(value: &Value, names: &[&str]) -> Option<i64> {
    names.iter().find_map(|name| {
        value
            .get(*name)
            .and_then(|item| item.as_i64().or_else(|| item.as_str()?.parse().ok()))
    })
}

fn parse_user(value: Value) -> Option<ConnectionUserCandidate> {
    let name = value_string(&value, &["User", "user"]);
    (!name.is_empty()).then(|| ConnectionUserCandidate {
        name,
        full_name: nonempty(value_string(&value, &["FullName", "fullName"])),
        email: nonempty(value_string(&value, &["Email", "email"])),
        accessed: value_i64(&value, &["Access", "access"]),
    })
}

fn parse_workspace(value: Value) -> Option<ConnectionWorkspaceCandidate> {
    let name = value_string(&value, &["client", "Client"]);
    let host = value_string(&value, &["Host", "host"]);
    let root = value_string(&value, &["Root", "root"]);
    let options = value_string(&value, &["Options", "options"]);
    let (root_status, selectable) = workspace_root_status(&host, &root);
    (!name.is_empty()).then(|| ConnectionWorkspaceCandidate {
        name,
        owner: value_string(&value, &["Owner", "owner"]),
        host,
        root,
        stream: value_string(&value, &["Stream", "stream"]),
        description: value_string(&value, &["Description", "description"]),
        updated: value_i64(&value, &["Update", "update"]),
        accessed: value_i64(&value, &["Access", "access"]),
        root_status,
        selectable,
        sync_mode: workspace_sync_mode_from_options(&options),
    })
}

fn parse_identity(value: Value) -> Option<ServerIdentity> {
    let server_address = value_string(&value, &["serverAddress"]);
    let user_name = value_string(&value, &["userName"]);
    (!server_address.is_empty() && !user_name.is_empty()).then(|| ServerIdentity {
        server_id: nonempty(value_string(&value, &["serverID"])),
        server_address,
        user_name,
        server_version: nonempty(value_string(&value, &["serverVersion"])),
    })
}

fn parse_workspace_spec(value: Value) -> Option<WorkspaceSpecSnapshot> {
    let name = value_string(&value, &["Client", "client"]);
    if name.is_empty() {
        return None;
    }
    let mut view = value
        .as_object()
        .into_iter()
        .flat_map(|object| object.iter())
        .filter_map(|(key, value)| {
            key.strip_prefix("View")
                .and_then(|index| index.parse::<usize>().ok())
                .zip(value.as_str())
                .map(|(index, value)| (index, value.to_owned()))
        })
        .collect::<Vec<_>>();
    view.sort_by_key(|(index, _)| *index);
    Some(WorkspaceSpecSnapshot {
        name,
        owner: value_string(&value, &["Owner", "owner"]),
        host: value_string(&value, &["Host", "host"]),
        root: value_string(&value, &["Root", "root"]),
        stream: value_string(&value, &["Stream", "stream"]),
        description: value_string(&value, &["Description", "description"]),
        options: value_string(&value, &["Options", "options"]),
        view: view.into_iter().map(|(_, value)| value).collect(),
    })
}

fn parse_workspace_runtime(value: Value) -> Option<WorkspaceRuntimeIdentity> {
    let client_name = value_string(&value, &["clientName"]);
    let client_root = value_string(&value, &["clientRoot"]);
    (!client_name.is_empty() && !client_root.is_empty()).then_some(WorkspaceRuntimeIdentity {
        client_name,
        client_root,
    })
}

pub fn workspace_candidate_from_spec(spec: &WorkspaceSpecSnapshot) -> ConnectionWorkspaceCandidate {
    let (root_status, selectable) = workspace_root_status(&spec.host, &spec.root);
    ConnectionWorkspaceCandidate {
        name: spec.name.clone(),
        owner: spec.owner.clone(),
        host: spec.host.clone(),
        root: spec.root.clone(),
        stream: spec.stream.clone(),
        description: spec.description.clone(),
        updated: None,
        accessed: None,
        root_status,
        selectable,
        sync_mode: workspace_sync_mode_from_options(&spec.options),
    }
}

pub fn workspace_sync_mode_from_options(options: &str) -> WorkspaceSyncMode {
    let options = options
        .split_ascii_whitespace()
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();
    if options.iter().any(|option| option == "altsync") {
        WorkspaceSyncMode::Virtual
    } else if !options.is_empty() {
        WorkspaceSyncMode::Standard
    } else {
        WorkspaceSyncMode::Unknown
    }
}

pub fn workspace_root_status(host: &str, root: &str) -> (ConnectionWorkspaceRootStatus, bool) {
    if !host.trim().is_empty() {
        match local_host_name() {
            Some(local) if local.eq_ignore_ascii_case(host.trim()) => {}
            Some(_) => return (ConnectionWorkspaceRootStatus::OtherHost, false),
            None => return (ConnectionWorkspaceRootStatus::Unsupported, false),
        }
    }
    let root = root.trim();
    if root.is_empty() {
        return (ConnectionWorkspaceRootStatus::Missing, false);
    }
    if root.eq_ignore_ascii_case("null") || !std::path::Path::new(root).is_absolute() {
        return (ConnectionWorkspaceRootStatus::Unsupported, false);
    }
    match std::fs::metadata(root) {
        Ok(metadata) if metadata.is_dir() => (ConnectionWorkspaceRootStatus::Usable, true),
        Ok(_) => (ConnectionWorkspaceRootStatus::NotDirectory, false),
        Err(_) => (ConnectionWorkspaceRootStatus::Missing, false),
    }
}

fn local_host_name() -> Option<String> {
    ["COMPUTERNAME", "HOSTNAME"]
        .into_iter()
        .find_map(|name| std::env::var(name).ok())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn prefix_matches(value: &str, prefix: Option<&str>) -> bool {
    prefix.is_none_or(|prefix| value.to_lowercase().starts_with(&prefix.to_lowercase()))
}

fn names_equal(left: &str, right: &str) -> bool {
    left.to_lowercase() == right.to_lowercase()
}

fn nonempty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_candidates_and_checks_prefix_again() {
        let user = parse_user(serde_json::json!({
            "User":"开发者", "FullName":"Developer", "Email":"dev@example.test", "Access":"12"
        }))
        .unwrap();
        assert_eq!(user.name, "开发者");
        assert_eq!(user.accessed, Some(12));
        assert!(prefix_matches("Feature-Workspace", Some("feature")));
        assert!(!prefix_matches("other", Some("feature")));

        let workspace = parse_workspace(serde_json::json!({
            "client":"ws one", "Owner":"dev", "Root":"D:\\\\Work Space", "Stream":"//stream/main"
        }))
        .unwrap();
        assert_eq!(workspace.name, "ws one");
        assert_eq!(workspace.owner, "dev");
    }

    #[test]
    fn parses_ordered_workspace_view() {
        let spec = parse_workspace_spec(serde_json::json!({
            "Client":"dev-ws", "Owner":"dev", "Root":"D:\\\\work",
            "Options":"noallwrite noclobber altsync normdir",
            "View1":"//depot/b/... //dev-ws/b/...", "View0":"//depot/a/... //dev-ws/a/..."
        }))
        .unwrap();
        assert_eq!(spec.view[0], "//depot/a/... //dev-ws/a/...");
        assert_eq!(spec.view[1], "//depot/b/... //dev-ws/b/...");
        assert_eq!(
            workspace_sync_mode_from_options(&spec.options),
            WorkspaceSyncMode::Virtual
        );
    }

    #[test]
    fn parses_server_version_for_vfs_preflight() {
        let identity = parse_identity(serde_json::json!({
            "serverAddress": "ssl:fixture:1666",
            "userName": "developer",
            "serverID": "fixture-server",
            "serverVersion": "P4D/NTX64/2026.1/1"
        }))
        .unwrap();
        assert_eq!(
            identity.server_version.as_deref(),
            Some("P4D/NTX64/2026.1/1")
        );
        assert_eq!(
            workspace_sync_mode_from_options("noallwrite noclobber normdir"),
            WorkspaceSyncMode::Standard
        );
        assert_eq!(
            workspace_sync_mode_from_options(""),
            WorkspaceSyncMode::Unknown
        );
    }

    #[test]
    fn classifies_workspace_roots_without_guessing_a_fallback() {
        let directory =
            std::env::temp_dir().join(format!("p4deck-workspace-root-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        assert_eq!(
            workspace_root_status("", &directory.to_string_lossy()),
            (ConnectionWorkspaceRootStatus::Usable, true)
        );
        assert_eq!(
            workspace_root_status("", ""),
            (ConnectionWorkspaceRootStatus::Missing, false)
        );
        assert_eq!(
            workspace_root_status("", "null"),
            (ConnectionWorkspaceRootStatus::Unsupported, false)
        );
        assert_eq!(
            workspace_root_status("", &directory.join("absent").to_string_lossy()),
            (ConnectionWorkspaceRootStatus::Missing, false)
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn parses_effective_workspace_identity_from_info() {
        let identity = parse_workspace_runtime(serde_json::json!({
            "clientName": "fixture-client",
            "clientRoot": "D:\\fixture root"
        }))
        .unwrap();
        assert_eq!(identity.client_name, "fixture-client");
        assert_eq!(identity.client_root, "D:\\fixture root");
        assert!(parse_workspace_runtime(serde_json::json!({
            "clientName": "fixture-client"
        }))
        .is_none());
    }

    #[test]
    fn existence_name_comparison_is_case_folded() {
        assert!(names_equal("PROJ", "proj"));
        assert!(names_equal("ÄUSER", "äuser"));
    }

    #[test]
    fn workspace_identity_is_one_literal_cli_argument() {
        assert!(valid_entity_name("workspace-01_开发"));
        for value in [
            "",
            "-workspace",
            "space name",
            "wild*",
            "revision@",
            "label#",
            "percent%",
            "line\nname",
        ] {
            assert!(
                !valid_entity_name(value),
                "accepted unsafe client: {value:?}"
            );
        }
    }

    #[test]
    fn structured_errors_and_malformed_json_fail_closed() {
        let result = OperationResult {
            operation_id: "test".into(),
            exit_code: 0,
            duration_ms: 1,
            events: vec![crate::domain::OperationEvent {
                operation_id: "test".into(),
                kind: crate::domain::EventKind::Stdout,
                message: Some("not-json".into()),
                progress: None,
                timestamp: "now".into(),
            }],
        };
        assert!(json_records(&result).is_err());

        let mut error = result;
        error.events[0].message = Some(r#"{"code":"error","severity":3,"generic":17}"#.into());
        assert!(json_records(&error).is_err());
        error.events[0].message = Some(r#"{"code":"error","severity":2,"generic":17}"#.into());
        assert!(json_records(&error).unwrap().len() == 1);
    }
}
