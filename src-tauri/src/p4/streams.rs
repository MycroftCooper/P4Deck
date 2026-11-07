use crate::{domain::*, p4::runner::P4Runner};
use serde::Serialize;
use serde_json::Value;
use std::{collections::HashSet, sync::Arc};
use tauri::AppHandle;
use uuid::Uuid;

pub const STREAM_SCAN_LIMIT: usize = 5_000;
const STREAM_FIELD_LIST: &str = "Stream,Name,Owner,Parent,Type,desc,Options,ParentView,deleted";

#[derive(Debug, Serialize)]
pub struct StreamSummary {
    stream: String,
    name: String,
    owner: String,
    parent: String,
    kind: String,
    description: String,
}

#[derive(Debug)]
pub struct StreamBatch {
    pub nodes: Vec<StreamGraphNode>,
    pub operation_ids: Vec<String>,
    pub scanned_count: usize,
    pub invalid_record_count: usize,
    pub truncated: bool,
}

pub struct StreamRepository {
    runner: Arc<P4Runner>,
}

impl StreamRepository {
    pub fn new(runner: Arc<P4Runner>) -> Self {
        Self { runner }
    }

    pub async fn query(
        &self,
        context: &P4Context,
        operation_id: &str,
        depot_prefix: Option<&str>,
        text: Option<&str>,
        include_deleted: bool,
        app: Option<&AppHandle>,
    ) -> Result<StreamBatch, String> {
        let result = self
            .runner
            .run(
                P4CommandRequest {
                    bound: crate::p4::bounds::IoBound::Read,
                    operation_id: Some(operation_id.to_owned()),
                    source: OperationSource::Gui,
                    command: "streams".into(),
                    args: build_stream_args(depot_prefix, include_deleted),
                    context: context.clone(),
                    output_mode: OutputMode::JsonLines,
                    timeout_ms: None,
                    input: None,
                },
                app,
            )
            .await
            .map_err(|error| error.to_string())?;
        let mut nodes = Vec::new();
        let mut invalid_record_count = 0usize;
        let mut structured_messages = Vec::new();
        let mut server_error = false;
        for event in &result.events {
            if !matches!(event.kind, EventKind::Stdout | EventKind::Stderr) {
                continue;
            }
            let Some(message) = event.message.as_deref() else {
                continue;
            };
            for line in message.lines().filter(|line| !line.trim().is_empty()) {
                let Ok(value) = serde_json::from_str::<Value>(line) else {
                    invalid_record_count += 1;
                    continue;
                };
                if value.get("Stream").is_none() && value.get("stream").is_none() {
                    structured_messages.push(value.clone());
                }
                if value.get("code").and_then(Value::as_str) == Some("error")
                    || value
                        .get("severity")
                        .and_then(Value::as_u64)
                        .is_some_and(|severity| severity >= 3)
                {
                    server_error = true;
                }
                match parse(&value) {
                    Some(node) => nodes.push(node),
                    None => invalid_record_count += 1,
                }
            }
        }
        let structured_no_match = is_scoped_no_match(depot_prefix, &structured_messages);
        if server_error && !structured_no_match {
            return Err(
                "Stream Graph query returned a server error; inspect the operation log.".into(),
            );
        }
        if result.exit_code != 0 && !structured_no_match {
            return Err("Stream Graph query failed; inspect the operation log.".into());
        }
        if structured_no_match {
            nodes.clear();
            invalid_record_count = 0;
        }
        let scanned_count = nodes.len();
        let truncated = nodes.len() > STREAM_SCAN_LIMIT;
        nodes.truncate(STREAM_SCAN_LIMIT);
        nodes.retain(|node| {
            depot_prefix.is_none_or(|prefix| stream_in_prefix(&node.stream, prefix))
                && text.is_none_or(|needle| node_matches_text(node, needle))
                && (include_deleted || node.deleted != Some(true))
        });
        Ok(StreamBatch {
            nodes,
            operation_ids: vec![result.operation_id],
            scanned_count,
            invalid_record_count,
            truncated,
        })
    }
}

fn build_stream_args(depot_prefix: Option<&str>, include_deleted: bool) -> Vec<String> {
    let mut args = vec![
        "-T".into(),
        STREAM_FIELD_LIST.into(),
        "-m".into(),
        (STREAM_SCAN_LIMIT + 1).to_string(),
    ];
    if include_deleted {
        args.push("-a".into());
    }
    if let Some(prefix) = depot_prefix {
        args.push(format!("{}/...", prefix.trim_end_matches('/')));
    }
    args
}

fn stream_in_prefix(stream: &str, prefix: &str) -> bool {
    let prefix = prefix.trim_end_matches('/');
    stream == prefix || stream.starts_with(&format!("{prefix}/"))
}

fn is_scoped_no_match(depot_prefix: Option<&str>, messages: &[Value]) -> bool {
    depot_prefix.is_some()
        && !messages.is_empty()
        && messages
            .iter()
            .all(|value| value.get("generic").and_then(Value::as_u64) == Some(17))
}

fn node_matches_text(node: &StreamGraphNode, text: &str) -> bool {
    let needle = text.to_lowercase();
    [
        Some(node.stream.as_str()),
        node.name.as_deref(),
        node.owner.as_deref(),
        node.parent.as_deref(),
        node.kind.as_deref(),
        node.description.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|value| value.to_lowercase().contains(&needle))
}

fn optional_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|field| !field.is_empty())
            .map(str::to_owned)
    })
}

fn tagged_bool(value: &Value, key: &str) -> Option<bool> {
    let field = value.get(key)?;
    match field {
        Value::Bool(value) => Some(*value),
        Value::Number(value) => Some(value.as_i64().unwrap_or_default() != 0),
        Value::String(value) => match value.trim().to_ascii_lowercase().as_str() {
            "" | "1" | "true" | "yes" => Some(true),
            "0" | "false" | "no" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn parse_flow_options(raw: Option<&str>) -> StreamFlowOptions {
    let Some(raw) = raw else {
        return StreamFlowOptions::default();
    };
    let tokens = raw
        .split_whitespace()
        .map(str::to_ascii_lowercase)
        .collect::<HashSet<_>>();
    let paired = |positive: &str, negative: &str| {
        if tokens.contains(positive) {
            Some(true)
        } else if tokens.contains(negative) {
            Some(false)
        } else {
            None
        }
    };
    let merge_mode = if tokens.contains("mergedown") {
        Some("mergeDown".into())
    } else if tokens.contains("mergeany") {
        Some("mergeAny".into())
    } else {
        None
    };
    StreamFlowOptions {
        to_parent: paired("toparent", "notoparent"),
        from_parent: paired("fromparent", "nofromparent"),
        merge_mode,
        locked: paired("locked", "unlocked"),
        all_submit: paired("allsubmit", "ownersubmit"),
    }
}

fn parse(value: &Value) -> Option<StreamGraphNode> {
    let stream = optional_string(value, &["Stream", "stream"])?;
    if !stream.starts_with("//") || stream.chars().any(char::is_control) {
        return None;
    }
    let parent = optional_string(value, &["Parent", "parent"])
        .filter(|parent| !parent.eq_ignore_ascii_case("none"));
    let options = optional_string(value, &["Options", "options"]);
    Some(StreamGraphNode {
        stream,
        name: optional_string(value, &["Name", "name"]),
        owner: optional_string(value, &["Owner", "owner"]),
        parent,
        kind: optional_string(value, &["Type", "type"]),
        description: optional_string(value, &["desc", "Description", "description"]),
        parent_view: optional_string(value, &["ParentView", "parentView"]),
        flow_options: parse_flow_options(options.as_deref()),
        deleted: tagged_bool(value, "deleted"),
    })
}

pub async fn list(
    runner: &Arc<P4Runner>,
    context: P4Context,
    app: &AppHandle,
) -> Result<Vec<StreamSummary>, String> {
    let batch = StreamRepository::new(runner.clone())
        .query(
            &context,
            &format!("streams-list-{}", Uuid::new_v4()),
            None,
            None,
            false,
            Some(app),
        )
        .await?;
    Ok(batch
        .nodes
        .into_iter()
        .map(|node| StreamSummary {
            stream: node.stream,
            name: node.name.unwrap_or_default(),
            owner: node.owner.unwrap_or_default(),
            parent: node.parent.unwrap_or_else(|| "none".into()),
            kind: node.kind.unwrap_or_default(),
            description: node.description.unwrap_or_default(),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_stream_fields_unicode_deleted_and_unknowns() {
        let value = serde_json::json!({
            "Stream":"//atlas/开发",
            "Name":"开发流",
            "Owner":"工程师",
            "Parent":"//atlas/main",
            "Type":"future-type",
            "desc":"Unicode 描述\n",
            "Options":"ownersubmit locked notoparent fromparent mergeany",
            "ParentView":"noinherit",
            "deleted":""
        });
        let stream = parse(&value).unwrap();
        assert_eq!(stream.stream, "//atlas/开发");
        assert_eq!(stream.kind.as_deref(), Some("future-type"));
        assert_eq!(stream.parent_view.as_deref(), Some("noinherit"));
        assert_eq!(stream.flow_options.to_parent, Some(false));
        assert_eq!(stream.flow_options.from_parent, Some(true));
        assert_eq!(stream.flow_options.merge_mode.as_deref(), Some("mergeAny"));
        assert_eq!(stream.flow_options.locked, Some(true));
        assert_eq!(stream.flow_options.all_submit, Some(false));
        assert_eq!(stream.deleted, Some(true));

        let missing = parse(&serde_json::json!({"Stream":"//atlas/minimal"})).unwrap();
        assert_eq!(missing.owner, None);
        assert_eq!(missing.parent_view, None);
        assert_eq!(missing.flow_options, StreamFlowOptions::default());
        assert!(parse(&serde_json::json!({"code":"error"})).is_none());
    }

    #[test]
    fn command_is_bounded_and_scope_is_rechecked_client_side() {
        let args = build_stream_args(Some("//atlas"), true);
        assert_eq!(
            args,
            vec!["-T", STREAM_FIELD_LIST, "-m", "5001", "-a", "//atlas/..."]
        );
        assert!(stream_in_prefix("//atlas/dev", "//atlas"));
        assert!(!stream_in_prefix("//atlas2/dev", "//atlas"));
        assert!(!build_stream_args(None, false).is_empty());
    }

    #[test]
    fn only_scoped_structured_no_match_is_an_empty_result() {
        let no_match = serde_json::json!({"generic":17,"severity":2,"code":"error"});
        assert!(is_scoped_no_match(
            Some("//atlas/missing"),
            std::slice::from_ref(&no_match)
        ));
        assert!(!is_scoped_no_match(None, &[no_match]));
        assert!(!is_scoped_no_match(
            Some("//atlas/missing"),
            &[serde_json::json!({"generic":2,"severity":3,"code":"error"})]
        ));
        assert!(!is_scoped_no_match(
            Some("//atlas/missing"),
            &[
                serde_json::json!({"generic":17,"severity":2}),
                serde_json::json!({"generic":3,"severity":3})
            ]
        ));
    }
}
