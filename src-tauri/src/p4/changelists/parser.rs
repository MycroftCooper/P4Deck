use crate::domain::{
    ChangelistSummary, MergeClassification, OperationEvent, OperationResult, PendingChange,
    PendingFile,
};
use chrono::{DateTime, Utc};
use serde_json::Value;

pub fn parse_change_events(events: &[OperationEvent]) -> Vec<ChangelistSummary> {
    events
        .iter()
        .filter_map(|event| event.message.as_deref())
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|value| value.get("code").and_then(Value::as_str) != Some("error"))
        .filter_map(parse_change)
        .collect()
}

fn parse_change(value: Value) -> Option<ChangelistSummary> {
    let id = number(&value, "change");
    if id == 0 {
        return None;
    }
    let description = text(&value, "desc");
    let user = text(&value, "user");
    let client = text(&value, "client");
    let status = text(&value, "status");
    let stream = value
        .get("stream")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Some(ChangelistSummary {
        id,
        merge_classification: classify(&description, &user, stream.as_deref()),
        description,
        user,
        client,
        status: status.clone(),
        time: timestamp(&value),
        file_count: 0,
        has_shelf: status == "shelved",
        jobs: Vec::new(),
        stream,
    })
}

fn classify(description: &str, user: &str, stream: Option<&str>) -> MergeClassification {
    let description = description.to_lowercase();
    let merge = description.contains("merge") || description.contains("integrat");
    if merge && user.to_lowercase().contains("build") && stream.is_some() {
        MergeClassification::ReliableMerge
    } else if merge {
        MergeClassification::SuspectedMerge
    } else {
        MergeClassification::Unknown
    }
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}
fn number(value: &Value, key: &str) -> i64 {
    value
        .get(key)
        .and_then(Value::as_i64)
        .or_else(|| {
            value
                .get(key)
                .and_then(Value::as_str)
                .and_then(|value| value.parse().ok())
        })
        .unwrap_or(0)
}
fn timestamp(value: &Value) -> String {
    DateTime::<Utc>::from_timestamp(number(value, "time"), 0)
        .unwrap_or_else(Utc::now)
        .to_rfc3339()
}

#[derive(Debug)]
pub struct PendingChangeSpec {
    pub id: i64,
    pub description: String,
    pub user: String,
    pub client: String,
    pub status: String,
    pub jobs: Vec<String>,
}

pub fn parse_pending_changes(
    events: &[OperationEvent],
    expected_user: &str,
    expected_client: &str,
) -> Vec<PendingChange> {
    json_values(events)
        .into_iter()
        .filter_map(|value| {
            let id = number_option(&value, "change")?;
            let user = text(&value, "user");
            let client = text(&value, "client");
            let status = text(&value, "status");
            (id > 0 && user == expected_user && client == expected_client && status == "pending")
                .then(|| PendingChange {
                    id,
                    description: normalized_multiline(&text(&value, "desc")),
                    user,
                    client,
                    status,
                    updated_at: timestamp_option(&value),
                    jobs: Vec::new(),
                    files: Vec::new(),
                    shelved_files: Vec::new(),
                })
        })
        .collect()
}

pub fn parse_change_spec(events: &[OperationEvent]) -> Option<PendingChangeSpec> {
    let value = json_values(events).into_iter().next()?;
    Some(PendingChangeSpec {
        id: number_option(&value, "Change")?,
        description: normalized_multiline(&text(&value, "Description")),
        user: text(&value, "User"),
        client: text(&value, "Client"),
        status: text(&value, "Status"),
        jobs: indexed_text(&value, "Jobs"),
    })
}

pub fn parse_opened_files(events: &[OperationEvent]) -> Vec<(i64, PendingFile)> {
    json_values(events)
        .into_iter()
        .filter_map(|value| {
            let depot_path = value.get("depotFile")?.as_str()?.to_owned();
            let action = text(&value, "action");
            let change_id = match value.get("change").and_then(Value::as_str) {
                Some("default") | None => 0,
                Some(value) => value.parse().ok()?,
            };
            Some((
                change_id,
                PendingFile {
                    depot_path,
                    state: opened_state(&action).map(str::to_owned),
                    action,
                    client_path: value
                        .get("clientFile")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    revision: number_option(&value, "rev"),
                    file_type: value.get("type").and_then(Value::as_str).map(str::to_owned),
                },
            ))
        })
        .collect()
}

pub fn parse_shelved_change_ids(
    events: &[OperationEvent],
    expected_user: &str,
    expected_client: &str,
) -> Vec<i64> {
    json_values(events)
        .into_iter()
        .filter(|value| text(value, "user") == expected_user)
        .filter(|value| text(value, "client") == expected_client)
        .filter_map(|value| number_option(&value, "change"))
        .filter(|id| *id > 0)
        .collect()
}

pub fn parse_shelved_files(events: &[OperationEvent]) -> Vec<(i64, PendingFile)> {
    let mut files = Vec::new();
    for value in json_values(events) {
        let Some(change_id) = number_option(&value, "change") else {
            continue;
        };
        for index in 0.. {
            let depot_key = format!("depotFile{index}");
            let Some(depot_path) = value.get(&depot_key).and_then(Value::as_str) else {
                break;
            };
            let action = text(&value, &format!("action{index}"));
            files.push((
                change_id,
                PendingFile {
                    depot_path: depot_path.to_owned(),
                    action,
                    state: None,
                    client_path: None,
                    revision: number_option(&value, &format!("rev{index}")),
                    file_type: value
                        .get(format!("type{index}"))
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                },
            ));
        }
    }
    files
}

pub fn parse_created_change_id(result: &OperationResult) -> Option<i64> {
    for value in json_values(&result.events) {
        if let Some(id) = number_option(&value, "change") {
            return Some(id);
        }
        if let Some(data) = value.get("data").and_then(Value::as_str) {
            if let Some(id) = created_id_from_text(data) {
                return Some(id);
            }
        }
    }
    result
        .events
        .iter()
        .filter_map(|event| event.message.as_deref())
        .find_map(created_id_from_text)
}

pub fn parse_where_paths(events: &[OperationEvent]) -> Vec<String> {
    json_values(events)
        .into_iter()
        .filter_map(|value| value.get("path").and_then(Value::as_str).map(str::to_owned))
        .collect()
}

pub fn parse_job_ids(events: &[OperationEvent]) -> Vec<String> {
    json_values(events)
        .into_iter()
        .filter_map(|value| value.get("Job").and_then(Value::as_str).map(str::to_owned))
        .collect()
}

fn json_values(events: &[OperationEvent]) -> Vec<Value> {
    events
        .iter()
        .filter_map(|event| event.message.as_deref())
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|value| value.get("code").and_then(Value::as_str) != Some("error"))
        .filter(|value| value.get("severity").and_then(Value::as_i64).unwrap_or(0) < 3)
        .collect()
}

fn indexed_text(value: &Value, prefix: &str) -> Vec<String> {
    let mut values = Vec::new();
    if let Some(single) = value.get(prefix).and_then(Value::as_str) {
        if !single.is_empty() {
            values.push(single.to_owned());
        }
    }
    for index in 0.. {
        let key = format!("{prefix}{index}");
        let Some(item) = value.get(&key).and_then(Value::as_str) else {
            break;
        };
        values.push(item.to_owned());
    }
    values
}

fn normalized_multiline(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim_end_matches('\n')
        .to_owned()
}

fn timestamp_option(value: &Value) -> Option<String> {
    let seconds = number_option(value, "time")?;
    DateTime::<Utc>::from_timestamp(seconds, 0).map(|value| value.to_rfc3339())
}

fn number_option(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
    })
}

fn opened_state(action: &str) -> Option<&'static str> {
    match action {
        "edit" => Some("openedEdit"),
        "add" | "move/add" | "branch" => Some("openedAdd"),
        "delete" | "move/delete" => Some("openedDelete"),
        _ => None,
    }
}

fn created_id_from_text(value: &str) -> Option<i64> {
    let rest = value.split("Change ").nth(1)?;
    let (id, suffix) = rest.split_once(' ')?;
    suffix
        .starts_with("created")
        .then(|| id.parse().ok())
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reliable_merge_requires_multiple_signals() {
        assert_eq!(
            classify("Merge dev", "buildbot", Some("//main")),
            MergeClassification::ReliableMerge
        );
        assert_eq!(
            classify("Merge dev", "alice", Some("//main")),
            MergeClassification::SuspectedMerge
        );
    }

    #[test]
    fn parses_default_and_numbered_opened_files_without_forging_shelf_state() {
        let events = [OperationEvent {
            operation_id: "op".into(),
            kind: crate::domain::EventKind::Stdout,
            message: Some(
                r#"{"action":"edit","change":"42","depotFile":"//depot/a","rev":"3","type":"text"}"#
                    .into(),
            ),
            progress: None,
            timestamp: "now".into(),
        }];
        let parsed = parse_opened_files(&events);
        assert_eq!(parsed[0].0, 42);
        assert_eq!(parsed[0].1.state.as_deref(), Some("openedEdit"));
        assert_eq!(parsed[0].1.revision, Some(3));
    }
}
