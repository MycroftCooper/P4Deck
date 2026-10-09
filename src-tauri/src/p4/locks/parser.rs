use crate::domain::{FileLockOwnership, FileLockPermission, OperationEvent};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub struct Mapping {
    pub depot_path: String,
    pub client_path: String,
    pub local_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FileFact {
    pub depot_path: String,
    pub local_path: Option<String>,
    pub action: Option<String>,
    pub change_id: i64,
    pub file_type: String,
    pub ownership: FileLockOwnership,
    pub lock_owner: Option<String>,
    pub other_open: Vec<String>,
}

pub fn mappings(events: &[OperationEvent]) -> Vec<Mapping> {
    values(events)
        .into_iter()
        .filter_map(|value| {
            Some(Mapping {
                depot_path: string(&value, "depotFile")?,
                client_path: string(&value, "clientFile")?,
                local_path: string(&value, "path"),
            })
        })
        .collect()
}

pub fn file_facts(events: &[OperationEvent]) -> Vec<FileFact> {
    values(events)
        .into_iter()
        .filter_map(|value| {
            let depot_path = string(&value, "depotFile")?;
            let other_open = other_open_owners(&value);
            let ownership = if value.get("ourLock").is_some() {
                FileLockOwnership::Ours
            } else if has_field(&value, "otherLock") {
                FileLockOwnership::Other
            } else {
                FileLockOwnership::Unlocked
            };
            Some(FileFact {
                depot_path,
                local_path: string(&value, "path"),
                action: string(&value, "action"),
                change_id: change_id(&value),
                file_type: string(&value, "type")
                    .or_else(|| string(&value, "headType"))
                    .unwrap_or_default(),
                ownership,
                lock_owner: other_lock_owner(&value),
                other_open,
            })
        })
        .collect()
}

pub fn permissions(events: &[OperationEvent]) -> BTreeMap<String, FileLockPermission> {
    let mut result = BTreeMap::new();
    for value in values(events) {
        let Some(permission) = value
            .get("perm")
            .or_else(|| value.get("permMax"))
            .or_else(|| value.get("permission"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let level = match permission
            .trim_start_matches('=')
            .to_ascii_lowercase()
            .as_str()
        {
            "open" | "write" | "admin" | "super" => FileLockPermission::Allowed,
            _ => FileLockPermission::Denied,
        };
        if let Some(path) = value
            .get("depotFile")
            .or_else(|| value.get("path"))
            .and_then(Value::as_str)
        {
            result.insert(path.to_owned(), level);
        } else {
            result.insert("*".into(), level);
        }
    }
    result
}

pub fn permission_for(
    map: &BTreeMap<String, FileLockPermission>,
    depot_path: &str,
) -> FileLockPermission {
    map.get(depot_path)
        .or_else(|| map.get("*"))
        .copied()
        .unwrap_or(FileLockPermission::Unknown)
}

pub fn matches_input(input: &str, mapping: &Mapping) -> bool {
    let decoded = crate::p4::history::decode_filespec(input).replace('\\', "/");
    [&mapping.depot_path, &mapping.client_path]
        .into_iter()
        .any(|path| crate::p4::history::decode_filespec(path).replace('\\', "/") == decoded)
        || mapping.local_path.as_ref().is_some_and(|path| {
            let path = path.replace('\\', "/");
            if cfg!(windows) {
                path.eq_ignore_ascii_case(&decoded)
            } else {
                path == decoded
            }
        })
}

pub fn exclusive(file_type: &str) -> bool {
    file_type
        .split_once('+')
        .is_some_and(|(_, modifiers)| modifiers.contains('l'))
}

pub fn other_open_owners(value: &Value) -> Vec<String> {
    let users = indexed_map(value, "otherUser");
    let clients = indexed_map(value, "otherClient");
    let mut indices = users
        .keys()
        .chain(clients.keys())
        .copied()
        .collect::<Vec<_>>();
    indices.sort_unstable();
    indices.dedup();
    let owners = indices
        .into_iter()
        .filter_map(|index| match (users.get(&index), clients.get(&index)) {
            (Some(user), Some(client)) => Some(format!("{user}@{client}")),
            (Some(user), None) => Some(user.clone()),
            (None, Some(client)) => Some(client.clone()),
            (None, None) => None,
        })
        .collect::<Vec<_>>();
    if owners.is_empty() {
        indexed(value, "otherOpen")
            .into_iter()
            .filter(|owner| owner.parse::<usize>().is_err())
            .collect()
    } else {
        owners
    }
}

pub fn other_lock_owner(value: &Value) -> Option<String> {
    if !has_field(value, "otherLock") {
        return None;
    }
    indexed(value, "otherLock")
        .into_iter()
        .find(|owner| !owner.is_empty() && owner.parse::<usize>().is_err())
        .or_else(|| other_open_owners(value).into_iter().next())
}

fn values(events: &[OperationEvent]) -> Vec<Value> {
    events
        .iter()
        .filter_map(|event| event.message.as_deref())
        .filter_map(|line| serde_json::from_str(line).ok())
        .filter(|value: &Value| {
            value.is_object() && value.get("code").and_then(Value::as_str) != Some("error")
        })
        .collect()
}

fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn change_id(value: &Value) -> i64 {
    match value.get("change").and_then(Value::as_str) {
        None | Some("default") => 0,
        Some(value) => value.parse().unwrap_or(-1),
    }
}

fn has_field(value: &Value, prefix: &str) -> bool {
    value.as_object().is_some_and(|object| {
        object.keys().any(|key| {
            key == prefix
                || key
                    .strip_prefix(prefix)
                    .is_some_and(|suffix| suffix.chars().all(|c| c.is_ascii_digit()))
        })
    })
}

fn indexed(value: &Value, prefix: &str) -> Vec<String> {
    let Some(object) = value.as_object() else {
        return Vec::new();
    };
    let mut values = object
        .iter()
        .filter_map(|(key, value)| {
            let index = if key == prefix {
                0
            } else {
                key.strip_prefix(prefix)?
                    .parse::<usize>()
                    .ok()?
                    .saturating_add(1)
            };
            let value = value.as_str()?.trim();
            (!value.is_empty()).then(|| (index, value.to_owned()))
        })
        .collect::<Vec<_>>();
    values.sort_by_key(|(index, _)| *index);
    values.into_iter().map(|(_, value)| value).collect()
}

fn indexed_map(value: &Value, prefix: &str) -> BTreeMap<usize, String> {
    let Some(object) = value.as_object() else {
        return BTreeMap::new();
    };
    object
        .iter()
        .filter_map(|(key, value)| {
            let index = if key == prefix {
                0
            } else {
                key.strip_prefix(prefix)?.parse::<usize>().ok()?
            };
            let value = value.as_str()?.trim();
            (!value.is_empty()).then(|| (index, value.to_owned()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::EventKind;
    fn event(message: &str) -> OperationEvent {
        OperationEvent {
            operation_id: "x".into(),
            kind: EventKind::Stdout,
            message: Some(message.into()),
            progress: None,
            timestamp: String::new(),
        }
    }

    #[test]
    fn parses_structured_ours_other_exclusive_and_unicode() {
        let ours = file_facts(&[event(
            r#"{"depotFile":"//depot/空 格%40.bin","clientFile":"//ws/空 格%40.bin","path":"C:/ws/空 格@.bin","action":"edit","change":"default","type":"binary+l","ourLock":""}"#,
        )]);
        assert_eq!(ours[0].ownership, FileLockOwnership::Ours);
        assert!(exclusive(&ours[0].file_type));
        let other = file_facts(&[event(
            r#"{"depotFile":"//depot/a","clientFile":"//ws/a","action":"integrate","change":"7","type":"binary","otherLock":"","otherLock0":"bob@other","otherOpen":"1","otherOpen0":"bob@other"}"#,
        )]);
        assert_eq!(other[0].lock_owner.as_deref(), Some("bob@other"));
        assert_eq!(other[0].other_open, ["bob@other"]);
    }
}
