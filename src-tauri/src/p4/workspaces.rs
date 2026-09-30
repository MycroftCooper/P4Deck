use crate::{domain::*, p4::runner::P4Runner};
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientWorkspace {
    name: String,
    owner: String,
    host: String,
    root: String,
    stream: String,
    description: String,
    updated: Option<i64>,
    accessed: Option<i64>,
}

fn parse(value: &Value) -> Option<ClientWorkspace> {
    let field = |name: &str| {
        value
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    let timestamp = |name: &str| {
        value
            .get(name)
            .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()))
    };
    let name = field("client");
    if name.is_empty() {
        return None;
    }
    Some(ClientWorkspace {
        name,
        owner: field("Owner"),
        host: field("Host"),
        root: field("Root"),
        stream: field("Stream"),
        description: field("Description"),
        updated: timestamp("Update"),
        accessed: timestamp("Access"),
    })
}

pub async fn list(
    runner: &P4Runner,
    context: P4Context,
    app: &AppHandle,
) -> Result<Vec<ClientWorkspace>, String> {
    // --me resolves the effective P4 user, including P4CONFIG, on the server.
    let result = runner
        .run(
            P4CommandRequest {
                operation_id: None,
                source: OperationSource::Gui,
                command: "clients".into(),
                args: vec!["--me".into(), "-t".into()],
                context,
                output_mode: OutputMode::JsonLines,
                timeout_ms: Some(30_000),
                input: None,
            },
            Some(app),
        )
        .await
        .map_err(|error| error.to_string())?;
    if result.exit_code != 0 {
        return Err("无法加载当前用户的 Workspace，请检查连接和登录状态；详细信息见日志。".into());
    }
    let mut workspaces = Vec::new();
    for event in result.events {
        if let Some(message) = event.message {
            for line in message.lines() {
                if let Ok(value) = serde_json::from_str::<Value>(line) {
                    if value.get("code").and_then(Value::as_str) == Some("error") {
                        return Err("P4 查询失败，请检查连接、权限和日志。".into());
                    }
                    if let Some(workspace) = parse(&value) {
                        workspaces.push(workspace);
                    }
                }
            }
        }
    }
    workspaces.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(workspaces)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_client_fixture_and_optional_fields() {
        let values: Vec<Value> = include_str!("workspaces.fixture.jsonl")
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let windows = parse(&values[0]).unwrap();
        assert_eq!(windows.root, "D:\\项目\\Atlas Release");
        assert_eq!(windows.owner, "artist");
        assert_eq!(windows.updated, Some(1700000000));
        let classic = parse(&values[1]).unwrap();
        assert_eq!(classic.host, "");
        assert_eq!(classic.stream, "");
        assert_eq!(classic.accessed, None);
        assert!(parse(&values[2]).is_none());
    }
}
