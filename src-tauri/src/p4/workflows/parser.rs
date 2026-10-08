use crate::domain::{OperationEvent, ResolveVersionSource};
use serde_json::Value;

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowFileFact {
    pub depot_path: String,
    pub client_path: Option<String>,
    pub action: String,
    pub change_id: Option<i64>,
    pub have_revision: Option<i64>,
    pub head_revision: Option<i64>,
    pub file_type: String,
    pub digest: String,
    pub shelved_digest: String,
    pub unresolved: usize,
    pub other_open: usize,
    pub other_lock: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionFact {
    pub depot_path: Option<String>,
    pub permission: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceSpec {
    pub client: String,
    pub owner: String,
    pub root: String,
}

pub fn file_facts(events: &[OperationEvent]) -> Vec<WorkflowFileFact> {
    json_values(events)
        .into_iter()
        .filter_map(|value| {
            Some(WorkflowFileFact {
                depot_path: value.get("depotFile")?.as_str()?.to_owned(),
                client_path: value
                    .get("clientFile")
                    .or_else(|| value.get("path"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                action: text(&value, "action"),
                change_id: change_number(&value, "change"),
                have_revision: number(&value, "haveRev"),
                head_revision: number(&value, "headRev"),
                file_type: value
                    .get("shelvedType")
                    .or_else(|| value.get("type"))
                    .or_else(|| value.get("headType"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                digest: text(&value, "digest"),
                shelved_digest: text(&value, "shelvedDigest"),
                unresolved: count(&value, "unresolved"),
                other_open: count(&value, "otherOpen"),
                other_lock: count(&value, "otherLock"),
            })
        })
        .collect()
}

pub fn permissions(events: &[OperationEvent]) -> Vec<PermissionFact> {
    json_values(events)
        .into_iter()
        .filter_map(|value| {
            let permission = value
                .get("perm")
                .or_else(|| value.get("permMax"))
                .or_else(|| value.get("permission"))
                .and_then(Value::as_str)?
                .to_owned();
            Some(PermissionFact {
                depot_path: value
                    .get("depotFile")
                    .or_else(|| value.get("path"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                permission,
            })
        })
        .collect()
}

pub fn mappings(events: &[OperationEvent]) -> Vec<(String, String)> {
    json_values(events)
        .into_iter()
        .filter_map(|value| {
            Some((
                value.get("depotFile")?.as_str()?.to_owned(),
                value
                    .get("path")
                    .or_else(|| value.get("clientFile"))?
                    .as_str()?
                    .to_owned(),
            ))
        })
        .collect()
}

pub fn workspace_spec(events: &[OperationEvent]) -> Option<WorkspaceSpec> {
    let value = json_values(events).into_iter().next()?;
    Some(WorkspaceSpec {
        client: text(&value, "Client"),
        owner: text(&value, "Owner"),
        root: text(&value, "Root"),
    })
}

pub fn path_output(events: &[OperationEvent]) -> Vec<String> {
    let mut result = Vec::new();
    for event in events {
        let Some(message) = event.message.as_deref() else {
            continue;
        };
        if let Ok(value) = serde_json::from_str::<Value>(message) {
            if value.get("severity").and_then(Value::as_i64).unwrap_or(0) >= 3 {
                continue;
            }
            for key in ["depotFile", "clientFile", "path"] {
                if let Some(path) = value.get(key).and_then(Value::as_str) {
                    result.push(path.to_owned());
                    break;
                }
            }
        }
    }
    result.sort();
    result.dedup();
    result
}

pub fn preview_lines(events: &[OperationEvent]) -> Vec<String> {
    let mut lines = Vec::new();
    for event in events {
        let Some(message) = event.message.as_deref() else {
            continue;
        };
        if let Ok(value) = serde_json::from_str::<Value>(message) {
            for key in ["data", "message"] {
                if let Some(line) = value.get(key).and_then(Value::as_str) {
                    let line = line.trim();
                    if !line.is_empty() {
                        lines.push(line.to_owned());
                    }
                }
            }
        } else {
            let line = message.trim();
            if !line.is_empty() && line != "0" {
                lines.push(line.to_owned());
            }
        }
    }
    lines.sort();
    lines.dedup();
    lines
}

pub fn resolve_sources(lines: &[String]) -> Vec<ResolveVersionSource> {
    let joined = lines.join(" ");
    let mut sources = Vec::new();
    for (role, marker) in [("base", "using base "), ("theirs", "merging ")] {
        if let Some(rest) = joined.split(marker).nth(1) {
            if let Some(spec) = rest.split_whitespace().next() {
                let (path, revision) = split_revision(spec);
                sources.push(ResolveVersionSource {
                    role: role.into(),
                    depot_path: path,
                    revision,
                    description: format!("{role} integration source"),
                });
            }
        }
    }
    sources
}

fn split_revision(value: &str) -> (Option<String>, Option<i64>) {
    match value.rsplit_once('#') {
        Some((path, revision)) if path.starts_with("//") => {
            (Some(path.to_owned()), revision.parse().ok())
        }
        _ if value.starts_with("//") => (Some(value.to_owned()), None),
        _ => (None, None),
    }
}

fn json_values(events: &[OperationEvent]) -> Vec<Value> {
    events
        .iter()
        .filter_map(|event| event.message.as_deref())
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|value| value.get("severity").and_then(Value::as_i64).unwrap_or(0) < 3)
        .collect()
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn number(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
    })
}

fn change_number(value: &Value, key: &str) -> Option<i64> {
    match value.get(key).and_then(Value::as_str) {
        Some("default") => Some(0),
        _ => number(value, key),
    }
}

fn count(value: &Value, key: &str) -> usize {
    number(value, key)
        .and_then(|value| usize::try_from(value).ok())
        .or_else(|| value.get(key).and_then(Value::as_str).map(|_| 1))
        .unwrap_or_else(|| {
            (0..)
                .take_while(|index| value.get(format!("{key}{index}")).is_some())
                .count()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::EventKind;

    fn event(message: &str) -> OperationEvent {
        OperationEvent {
            operation_id: "op".into(),
            kind: EventKind::Stdout,
            message: Some(message.into()),
            progress: None,
            timestamp: "now".into(),
        }
    }

    #[test]
    fn parses_shelf_and_conflict_facts_conservatively() {
        let facts = file_facts(&[event(
            r#"{"depotFile":"//depot/a","change":"7","shelvedDigest":"abc","unresolved":"1","otherLock0":"bob@ws"}"#,
        )]);
        assert_eq!(facts[0].shelved_digest, "abc");
        assert_eq!(facts[0].unresolved, 1);
        assert_eq!(facts[0].other_lock, 1);
        let sources =
            resolve_sources(&["//client/a - merging //depot/a#3 using base //depot/a#2".into()]);
        assert_eq!(sources.len(), 2);
    }
}
