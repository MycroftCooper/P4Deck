use crate::domain::{OperationEvent, OperationResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubmitFileFact {
    pub depot_path: String,
    pub action: String,
    pub have_revision: Option<i64>,
    pub head_revision: Option<i64>,
    pub file_type: String,
    pub unresolved: usize,
    pub other_open: usize,
    pub other_lock: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionFact {
    pub depot_path: Option<String>,
    pub permission: String,
}

pub fn file_facts(events: &[OperationEvent]) -> Vec<SubmitFileFact> {
    json_values(events)
        .into_iter()
        .filter_map(|value| {
            Some(SubmitFileFact {
                depot_path: value.get("depotFile")?.as_str()?.to_owned(),
                action: text(&value, "action"),
                have_revision: number(&value, "haveRev"),
                head_revision: number(&value, "headRev"),
                file_type: value
                    .get("type")
                    .or_else(|| value.get("headType"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
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

pub fn job_ids(events: &[OperationEvent]) -> Vec<String> {
    json_values(events)
        .into_iter()
        .filter_map(|value| value.get("Job").and_then(Value::as_str).map(str::to_owned))
        .collect()
}

pub fn submitted_change_id(result: &OperationResult) -> Option<i64> {
    for value in json_values(&result.events) {
        for key in ["submittedChange", "change"] {
            if let Some(value) = number(&value, key) {
                return Some(value);
            }
        }
        if let Some(data) = value.get("data").and_then(Value::as_str) {
            if let Some(value) = submitted_id_from_text(data) {
                return Some(value);
            }
        }
    }
    result
        .events
        .iter()
        .filter_map(|event| event.message.as_deref())
        .find_map(submitted_id_from_text)
}

fn submitted_id_from_text(text: &str) -> Option<i64> {
    let lower = text.to_ascii_lowercase();
    let marker = lower.find("change ")? + "change ".len();
    let digits = text[marker..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>();
    (!digits.is_empty() && lower.contains("submitted"))
        .then(|| digits.parse().ok())
        .flatten()
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
    fn parses_submit_safety_facts_without_stderr_matching() {
        let facts = file_facts(&[event(
            r#"{"depotFile":"//depot/a","action":"edit","haveRev":"2","headRev":"3","type":"binary+l","unresolved":"1","otherOpen":"1","otherLock0":"bob@ws"}"#,
        )]);
        assert_eq!(facts[0].unresolved, 1);
        assert_eq!(facts[0].other_open, 1);
        assert_eq!(facts[0].other_lock, 1);
        assert_eq!(facts[0].file_type, "binary+l");
    }
}
