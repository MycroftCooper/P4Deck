use crate::domain::{OperationEvent, RenameMoveMapping, RenameMoveSourceState};
use serde_json::Value;

pub fn mapping(events: &[OperationEvent]) -> Option<RenameMoveMapping> {
    values(events).into_iter().find_map(|value| {
        if value.get("code").and_then(Value::as_str) == Some("error") {
            return None;
        }
        let depot_path = string(&value, "depotFile")?;
        let client_path = string(&value, "clientFile")?;
        let local_path = string(&value, "path")?;
        if depot_path.starts_with('-')
            || client_path.starts_with('-')
            || local_path.starts_with('-')
        {
            return None;
        }
        Some(RenameMoveMapping {
            depot_path,
            client_path,
            local_path,
        })
    })
}

pub fn source_state(events: &[OperationEvent]) -> Option<RenameMoveSourceState> {
    values(events).into_iter().find_map(|value| {
        let action = string(&value, "action")?;
        Some(RenameMoveSourceState {
            action,
            change_id: change_id(&value),
            file_type: string(&value, "type"),
            have_revision: number(&value, "haveRev"),
            head_revision: number(&value, "headRev"),
        })
    })
}

pub fn source_is_controlled(events: &[OperationEvent]) -> bool {
    values(events).into_iter().any(|value| {
        value.get("depotFile").and_then(Value::as_str).is_some()
            && value.get("headAction").and_then(Value::as_str) != Some("delete")
    })
}

pub fn target_exists(events: &[OperationEvent]) -> bool {
    values(events).into_iter().any(|value| {
        value.get("depotFile").and_then(Value::as_str).is_some()
            && (value.get("action").and_then(Value::as_str).is_some()
                || value.get("headAction").and_then(Value::as_str) != Some("delete"))
    })
}

pub fn changelist_is_valid(
    events: &[OperationEvent],
    expected_id: i64,
    expected_client: &str,
    expected_user: &str,
) -> bool {
    values(events).into_iter().any(|value| {
        number(&value, "Change") == Some(expected_id)
            && string(&value, "Status").as_deref() == Some("pending")
            && string(&value, "Client").as_deref() == Some(expected_client)
            && string(&value, "User").as_deref() == Some(expected_user)
    })
}

fn values(events: &[OperationEvent]) -> Vec<Value> {
    events
        .iter()
        .filter_map(|event| event.message.as_deref())
        .filter_map(|line| serde_json::from_str(line).ok())
        .filter(Value::is_object)
        .collect()
}

fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn number(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64).or_else(|| {
        value
            .get(key)
            .and_then(Value::as_str)
            .and_then(|value| value.parse().ok())
    })
}

fn change_id(value: &Value) -> i64 {
    match value.get("change").and_then(Value::as_str) {
        None | Some("default") => 0,
        Some(value) => value.parse().unwrap_or(-1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::EventKind;

    fn event(message: &str) -> OperationEvent {
        OperationEvent {
            operation_id: "test".into(),
            kind: EventKind::Stdout,
            message: Some(message.into()),
            progress: None,
            timestamp: String::new(),
        }
    }

    #[test]
    fn parses_mapping_opened_state_and_changelist_ownership() {
        let mapping_event =
            event(r#"{"depotFile":"//depot/a","clientFile":"//ws/a","path":"C:/ws/a"}"#);
        assert_eq!(mapping(&[mapping_event]).unwrap().local_path, "C:/ws/a");
        let state_event = event(
            r#"{"action":"edit","change":"default","type":"text","haveRev":"1","headRev":"2"}"#,
        );
        let state = source_state(&[state_event]).unwrap();
        assert_eq!(state.action, "edit");
        assert_eq!(state.change_id, 0);
        let change_event =
            event(r#"{"Change":"42","Status":"pending","Client":"ws","User":"alice"}"#);
        assert!(changelist_is_valid(&[change_event], 42, "ws", "alice"));
    }
}
