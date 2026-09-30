use crate::domain::{ChangelistSummary, MergeClassification, OperationEvent};
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
}
