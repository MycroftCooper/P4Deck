use crate::{domain::*, p4::runner::P4Runner};
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

#[derive(Debug, Serialize)]
pub struct StreamSummary {
    stream: String,
    name: String,
    owner: String,
    parent: String,
    kind: String,
    description: String,
}
fn parse(value: &Value) -> Option<StreamSummary> {
    let field = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    let stream = field("Stream");
    if stream.is_empty() {
        return None;
    }
    Some(StreamSummary {
        stream,
        name: field("Name"),
        owner: field("Owner"),
        parent: field("Parent"),
        kind: field("Type"),
        description: field("desc"),
    })
}
pub async fn list(
    runner: &P4Runner,
    context: P4Context,
    app: &AppHandle,
) -> Result<Vec<StreamSummary>, String> {
    let result = runner
        .run(
            P4CommandRequest {
                operation_id: None,
                source: OperationSource::Gui,
                command: "streams".into(),
                args: vec![],
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
        return Err("无法加载 Streams，请检查连接、权限和日志。".into());
    }
    let mut streams = Vec::new();
    for event in result.events {
        if let Some(message) = event.message {
            for line in message.lines() {
                if let Ok(value) = serde_json::from_str::<Value>(line) {
                    if value.get("code").and_then(Value::as_str) == Some("error") {
                        return Err("P4 Streams 查询失败，请查看日志。".into());
                    }
                    if let Some(stream) = parse(&value) {
                        streams.push(stream);
                    }
                }
            }
        }
    }
    Ok(streams)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_stream_fixture() {
        let value: Value = serde_json::from_str(include_str!("streams.fixture.json")).unwrap();
        let stream = parse(&value).unwrap();
        assert_eq!(stream.stream, "//atlas/dev");
        assert_eq!(stream.parent, "//atlas/main");
        assert_eq!(stream.kind, "development");
        assert_eq!(stream.description, "开发分支\n");
        assert!(parse(&serde_json::json!({"code":"error"})).is_none());
    }
}
