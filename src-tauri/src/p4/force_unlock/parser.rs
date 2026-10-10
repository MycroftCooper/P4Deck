use crate::domain::{ForceUnlockPermission, OperationEvent};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerFacts {
    pub services: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockFact {
    pub depot_path: String,
    pub exists: bool,
    pub our_lock: bool,
    pub owners: Vec<LockOwnerFact>,
    pub file_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockOwnerFact {
    pub owner: Option<String>,
    pub user: Option<String>,
    pub client: Option<String>,
    pub change_id: Option<i64>,
    pub action: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenedFact {
    pub depot_path: String,
    pub user: Option<String>,
    pub client: Option<String>,
    pub change_id: Option<i64>,
    pub action: Option<String>,
}

pub fn server_facts(events: &[OperationEvent]) -> Option<ServerFacts> {
    values(events).into_iter().find_map(|value| {
        let services = string(&value, "serverServices");
        (services.is_some() || value.get("serverVersion").is_some())
            .then_some(ServerFacts { services })
    })
}

pub fn lock_facts(events: &[OperationEvent]) -> Vec<LockFact> {
    values(events)
        .into_iter()
        .filter_map(|value| {
            let depot_path = string(&value, "depotFile")?;
            let users = indexed(&value, "otherUser");
            let clients = indexed(&value, "otherClient");
            let changes = indexed(&value, "otherChange");
            let actions = indexed(&value, "otherAction");
            let locks = indexed_presence(&value, "otherLock");
            let mut owners = Vec::new();
            for index in locks {
                let lock_value = indexed_value(&value, "otherLock", index);
                let owner = lock_value
                    .clone()
                    .filter(|item| !item.is_empty() && item.parse::<usize>().is_err())
                    .or_else(|| match (users.get(&index), clients.get(&index)) {
                        (Some(user), Some(client)) => Some(format!("{user}@{client}")),
                        _ => None,
                    });
                let (owner_user, owner_client) = owner
                    .as_deref()
                    .and_then(|owner| owner.split_once('@'))
                    .map(|(user, client)| (Some(user.to_owned()), Some(client.to_owned())))
                    .unwrap_or((None, None));
                let user = users.get(&index).cloned().or(owner_user);
                let client = clients.get(&index).cloned().or(owner_client);
                owners.push(LockOwnerFact {
                    owner,
                    user,
                    client,
                    change_id: changes.get(&index).and_then(|value| parse_change(value)),
                    action: actions.get(&index).cloned(),
                });
            }
            Some(LockFact {
                depot_path,
                exists: true,
                our_lock: value.get("ourLock").is_some(),
                owners,
                file_type: string(&value, "type").or_else(|| string(&value, "headType")),
            })
        })
        .collect()
}

pub fn opened_facts(events: &[OperationEvent]) -> Vec<OpenedFact> {
    values(events)
        .into_iter()
        .filter_map(|value| {
            Some(OpenedFact {
                depot_path: string(&value, "depotFile")?,
                user: string(&value, "user"),
                client: string(&value, "client"),
                change_id: string(&value, "change").and_then(|value| parse_change(&value)),
                action: string(&value, "action"),
            })
        })
        .collect()
}

pub fn permissions(events: &[OperationEvent]) -> BTreeMap<String, ForceUnlockPermission> {
    let mut result = BTreeMap::new();
    for value in values(events) {
        let level = ["permMax", "perm", "permission"]
            .into_iter()
            .find_map(|key| string(&value, key))
            .map(
                |value| match value.trim_start_matches('=').to_ascii_lowercase().as_str() {
                    "super" => ForceUnlockPermission::Super,
                    "admin" => ForceUnlockPermission::Admin,
                    _ => ForceUnlockPermission::Denied,
                },
            )
            .unwrap_or(ForceUnlockPermission::Unknown);
        let path = string(&value, "depotFile")
            .or_else(|| string(&value, "path"))
            .unwrap_or_else(|| "*".into());
        result.insert(path, level);
    }
    result
}

pub fn permission_for(
    permissions: &BTreeMap<String, ForceUnlockPermission>,
    path: &str,
) -> ForceUnlockPermission {
    permissions
        .get(path)
        .or_else(|| permissions.get("*"))
        .copied()
        .unwrap_or(ForceUnlockPermission::Unknown)
}

pub fn has_error(events: &[OperationEvent]) -> bool {
    values(events).iter().any(|value| {
        value.get("severity").and_then(Value::as_u64).unwrap_or(0) >= 3
            || value.get("code").and_then(Value::as_str) == Some("error")
    })
}

fn values(events: &[OperationEvent]) -> Vec<Value> {
    events
        .iter()
        .filter_map(|event| event.message.as_deref())
        .flat_map(str::lines)
        .filter_map(|line| serde_json::from_str(line).ok())
        .filter(Value::is_object)
        .collect()
}

fn string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn indexed(value: &Value, prefix: &str) -> BTreeMap<usize, String> {
    value
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(key, value)| {
            let index = key.strip_prefix(prefix)?.parse::<usize>().ok()?;
            let value = value.as_str()?.trim();
            (!value.is_empty()).then(|| (index, value.to_owned()))
        })
        .collect()
}

fn indexed_presence(value: &Value, prefix: &str) -> Vec<usize> {
    let Some(object) = value.as_object() else {
        return Vec::new();
    };
    let mut indices = object
        .keys()
        .filter_map(|key| key.strip_prefix(prefix)?.parse::<usize>().ok())
        .collect::<Vec<_>>();
    if indices.is_empty() && object.contains_key(prefix) {
        let count = object
            .get(prefix)
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(1);
        indices.extend(0..count);
    }
    indices.sort_unstable();
    indices.dedup();
    indices
}

fn indexed_value(value: &Value, prefix: &str, index: usize) -> Option<String> {
    string(value, &format!("{prefix}{index}"))
}

fn parse_change(value: &str) -> Option<i64> {
    if value.eq_ignore_ascii_case("default") {
        Some(0)
    } else {
        value.parse().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::EventKind;

    fn event(json: &str) -> OperationEvent {
        OperationEvent {
            operation_id: "force-probe".into(),
            kind: EventKind::Stdout,
            message: Some(json.into()),
            progress: None,
            timestamp: String::new(),
        }
    }

    #[test]
    fn parses_indexed_lock_owner_change_and_admin_permission() {
        let facts = lock_facts(&[event(
            r#"{"depotFile":"//depot/空 格.bin","type":"binary+l","otherLock":"1","otherLock0":"","otherUser0":"bob","otherClient0":"ws","otherChange0":"42","otherAction0":"edit"}"#,
        )]);
        assert_eq!(facts[0].owners[0].owner.as_deref(), Some("bob@ws"));
        assert_eq!(facts[0].owners[0].change_id, Some(42));
        let permission = permissions(&[event(r#"{"permMax":"admin"}"#)]);
        assert_eq!(
            permission_for(&permission, "//depot/a"),
            ForceUnlockPermission::Admin
        );
    }

    #[test]
    fn parses_real_fstat_other_lock_owner_shape() {
        let facts = lock_facts(&[event(
            r#"{"depotFile":"//depot/a","type":"text","otherLock":"","otherLock0":"bob@ws","otherChange0":"default","otherAction0":"edit"}"#,
        )]);

        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].owners.len(), 1);
        assert_eq!(facts[0].owners[0].owner.as_deref(), Some("bob@ws"));
        assert_eq!(facts[0].owners[0].user.as_deref(), Some("bob"));
        assert_eq!(facts[0].owners[0].client.as_deref(), Some("ws"));
        assert_eq!(facts[0].owners[0].change_id, Some(0));
    }
}
