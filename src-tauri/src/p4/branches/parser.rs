use crate::domain::*;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

pub fn json_records(events: &[OperationEvent]) -> (Vec<Value>, usize) {
    let mut records = Vec::new();
    let mut invalid = 0usize;
    for event in events {
        if !matches!(event.kind, EventKind::Stdout | EventKind::Stderr) {
            continue;
        }
        let Some(message) = event.message.as_deref() else {
            continue;
        };
        for line in message.lines().filter(|line| !line.trim().is_empty()) {
            match serde_json::from_str::<Value>(line) {
                Ok(value) if value.is_object() => records.push(value),
                _ => invalid += 1,
            }
        }
    }
    (records, invalid)
}

pub fn summaries(records: &[Value]) -> (Vec<BranchMappingSummary>, usize, bool) {
    let mut items = Vec::new();
    let mut invalid = 0usize;
    let mut server_error = false;
    for value in records {
        if severity(value) >= 3 {
            server_error = true;
        }
        let Some(name) = string(value, &["branch", "Branch"]) else {
            if !is_info_message(value) {
                invalid += 1;
            }
            continue;
        };
        items.push(BranchMappingSummary {
            name,
            owner: string(value, &["Owner", "owner"]),
            update: string(value, &["Update", "update"]),
            access: string(value, &["Access", "access"]),
            description: string(value, &["Description", "description"]),
            options: string(value, &["Options", "options"]),
        });
    }
    (items, invalid, server_error)
}

pub fn detail(
    records: &[Value],
    operation_id: String,
) -> Result<Option<BranchMappingDetail>, String> {
    let value = records
        .iter()
        .find(|value| value.get("Branch").is_some() || value.get("branch").is_some());
    let Some(value) = value else {
        if records.iter().any(|value| severity(value) >= 3) {
            return Err("branch detail query was rejected by the server".into());
        }
        return Ok(None);
    };
    let name =
        string(value, &["Branch", "branch"]).ok_or("branch detail omitted the Branch field")?;
    let update = string(value, &["Update", "update"]);
    let access = string(value, &["Access", "access"]);
    // `p4 branch -o missing-name` returns an unsaved template with exit code 0.
    // Persisted specs always carry Update (and normally Access), so do not mistake
    // that template for an existing Branch Mapping.
    if update.is_none() && access.is_none() {
        return Ok(None);
    }
    let owner = string(value, &["Owner", "owner"]).unwrap_or_default();
    let options = string(value, &["Options", "options"]).unwrap_or_default();
    let raw_view = view_values(value);
    let view = raw_view
        .iter()
        .map(|line| parse_view_line(line))
        .collect::<Vec<_>>();
    let known = [
        "Branch",
        "branch",
        "Owner",
        "owner",
        "Update",
        "update",
        "Access",
        "access",
        "Description",
        "description",
        "Options",
        "options",
        "View",
    ];
    let mut unknown_fields = value
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(key, _)| {
            !known.contains(&key.as_str())
                && !key
                    .strip_prefix("View")
                    .is_some_and(|suffix| suffix.parse::<usize>().is_ok())
                && !is_protocol_field(key)
        })
        .map(|(name, value)| BranchUnknownField {
            name: name.clone(),
            value: value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| value.to_string()),
        })
        .collect::<Vec<_>>();
    unknown_fields.sort_by(|left, right| left.name.cmp(&right.name));
    let editable = !owner.is_empty()
        && !view.is_empty()
        && unknown_fields.is_empty()
        && view.iter().all(|line| {
            !matches!(line.modifier, BranchViewModifier::Unknown)
                && line.source.is_some()
                && line.target.is_some()
                && line.comment.is_none()
                && line.unknown.is_none()
        });
    Ok(Some(BranchMappingDetail {
        name,
        owner,
        update,
        access,
        description: string(value, &["Description", "description"]).unwrap_or_default(),
        locked: options
            .split_whitespace()
            .any(|option| option.eq_ignore_ascii_case("locked")),
        view,
        unknown_fields,
        editable,
        operation_ids: vec![operation_id],
        simulated: false,
    }))
}

pub fn preview_items(records: &[Value]) -> (Vec<BranchImpactItem>, usize, bool) {
    let mut items = Vec::new();
    let mut invalid = 0usize;
    let mut server_error = false;
    for value in records {
        if severity(value) >= 3 {
            server_error = true;
        }
        let source = string(value, &["fromFile", "sourceFile", "from"]);
        let target = string(value, &["depotFile", "toFile", "targetFile", "to"]);
        let file = string(value, &["clientFile", "path"]);
        let action = string(value, &["action", "how"]);
        if source.is_some() || target.is_some() || file.is_some() || action.is_some() {
            items.push(BranchImpactItem {
                file,
                source,
                target,
                action,
            });
        } else if !is_info_message(value) {
            invalid += 1;
        }
    }
    (items, invalid, server_error)
}

pub fn where_complete(records: &[Value], expected: usize) -> bool {
    if expected == 0 || records.iter().any(|value| severity(value) >= 3) {
        return false;
    }
    let mapped = records
        .iter()
        .filter(|value| {
            string(value, &["depotFile"]).is_some()
                && string(value, &["clientFile"]).is_some()
                && string(value, &["path"]).is_some()
        })
        .count();
    mapped >= expected
}

pub fn has_permission_error(records: &[Value]) -> bool {
    records.iter().any(|value| {
        if severity(value) < 3 {
            return false;
        }
        string(value, &["data", "message"]).is_some_and(|message| {
            let message = message.to_ascii_lowercase();
            message.contains("permission")
                || message.contains("protect")
                || message.contains("access for user")
        })
    })
}

pub fn parse_view_line(raw: &str) -> BranchViewLine {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return BranchViewLine {
            modifier: BranchViewModifier::Unknown,
            source: None,
            target: None,
            comment: trimmed
                .strip_prefix('#')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned),
            unknown: (!trimmed.is_empty()).then(|| trimmed.to_owned()),
        };
    }
    let (mapping, comment) = split_comment(trimmed);
    let Ok(mut tokens) = tokenize(mapping) else {
        return unknown_line(trimmed);
    };
    if tokens.len() != 2 {
        return unknown_line(trimmed);
    }
    let mut source = tokens.remove(0);
    let target = tokens.remove(0);
    let modifier = match source.chars().next() {
        Some('-') => {
            source.remove(0);
            BranchViewModifier::Exclude
        }
        Some('+') => {
            source.remove(0);
            BranchViewModifier::Overlay
        }
        _ => BranchViewModifier::Map,
    };
    if source.is_empty() || target.is_empty() {
        return unknown_line(trimmed);
    }
    BranchViewLine {
        modifier,
        source: Some(source),
        target: Some(target),
        comment,
        unknown: None,
    }
}

fn view_values(value: &Value) -> Vec<String> {
    if let Some(values) = value.get("View").and_then(Value::as_array) {
        return values
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
    }
    let mut indexed = BTreeMap::new();
    for (key, value) in value.as_object().into_iter().flatten() {
        if let Some(index) = key
            .strip_prefix("View")
            .and_then(|suffix| suffix.parse::<usize>().ok())
        {
            if let Some(value) = value.as_str() {
                indexed.insert(index, value.to_owned());
            }
        }
    }
    indexed.into_values().collect()
}

fn split_comment(value: &str) -> (&str, Option<String>) {
    let mut quoted = false;
    let mut escaped = false;
    for (index, character) in value.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && quoted {
            escaped = true;
            continue;
        }
        if character == '"' {
            quoted = !quoted;
        } else if character == '#' && !quoted && index > 0 {
            let before = &value[..index];
            if before.chars().last().is_some_and(char::is_whitespace) {
                return (
                    before.trim_end(),
                    Some(value[index + 1..].trim().to_owned()).filter(|item| !item.is_empty()),
                );
            }
        }
    }
    (value, None)
}

fn tokenize(value: &str) -> Result<Vec<String>, ()> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut escaped = false;
    for character in value.chars() {
        if escaped {
            current.push(character);
            escaped = false;
        } else if character == '\\' && quoted {
            escaped = true;
        } else if character == '"' {
            quoted = !quoted;
        } else if character.is_whitespace() && !quoted {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
        } else {
            current.push(character);
        }
    }
    if quoted || escaped {
        return Err(());
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    Ok(tokens)
}

fn unknown_line(raw: &str) -> BranchViewLine {
    BranchViewLine {
        modifier: BranchViewModifier::Unknown,
        source: None,
        target: None,
        comment: None,
        unknown: Some(raw.to_owned()),
    }
}

fn string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    })
}

fn severity(value: &Value) -> u64 {
    value
        .get("severity")
        .and_then(Value::as_u64)
        .unwrap_or_default()
}

fn is_info_message(value: &Value) -> bool {
    value.get("generic").is_some() || value.get("code0").is_some()
}

fn is_protocol_field(key: &str) -> bool {
    let protocol = HashSet::from([
        "code",
        "severity",
        "generic",
        "data",
        "fmt0",
        "code0",
        "severityformat",
    ]);
    protocol.contains(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tagged_list_and_structured_detail_with_unknowns() {
        let values = vec![serde_json::json!({
            "branch":"release-map","Owner":"alice","Update":"42","Access":41,
            "Description":"Unicode 分支","Options":"locked"
        })];
        let (items, invalid, failed) = summaries(&values);
        assert_eq!(items[0].name, "release-map");
        assert_eq!(items[0].update.as_deref(), Some("42"));
        assert_eq!(invalid, 0);
        assert!(!failed);

        let detail = detail(
            &[serde_json::json!({
                "Branch":"release-map","Owner":"alice","Update":"42","Access":"40",
                "Description":"Unicode 分支","Options":"locked",
                "View0":"\"//depot/源 路径/...\" \"//depot/目标 路径/...\"",
                "View1":"-//depot/源/test/... //depot/目标/test/... # keep",
                "FutureField":"future"
            })],
            "detail-op".into(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            detail.view[0].source.as_deref(),
            Some("//depot/源 路径/...")
        );
        assert_eq!(detail.view[1].modifier, BranchViewModifier::Exclude);
        assert_eq!(detail.view[1].comment.as_deref(), Some("keep"));
        assert!(!detail.editable);
        assert_eq!(detail.unknown_fields[0].name, "FutureField");
    }

    #[test]
    fn malformed_view_lines_are_preserved_and_not_guessed() {
        let malformed = parse_view_line("//depot/a/... only-one");
        assert_eq!(malformed.modifier, BranchViewModifier::Map);
        let broken = parse_view_line("\"//depot/a/... //depot/b/...");
        assert_eq!(broken.modifier, BranchViewModifier::Unknown);
        assert!(broken.unknown.is_some());
        let comment = parse_view_line("# server-specific comment");
        assert_eq!(comment.modifier, BranchViewModifier::Unknown);
        assert!(comment.unknown.is_some());
    }

    #[test]
    fn unsaved_branch_template_is_not_reported_as_an_existing_spec() {
        let template = serde_json::json!({
            "Branch":"missing-map",
            "Owner":"alice",
            "Description":"Created by alice.\n",
            "Options":"unlocked",
            "View0":"//depot/... //depot/..."
        });
        assert!(detail(&[template], "detail-missing".into())
            .unwrap()
            .is_none());
    }

    #[test]
    fn preview_parser_keeps_unknown_fields_optional() {
        let (items, invalid, failed) = preview_items(&[
            serde_json::json!({"fromFile":"//d/a","depotFile":"//d/b","clientFile":"C:/w/b","action":"branch"}),
            serde_json::json!({"generic":17,"severity":2,"data":"empty"}),
        ]);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].action.as_deref(), Some("branch"));
        assert_eq!(invalid, 0);
        assert!(!failed);
    }

    #[test]
    fn permission_failures_are_classified_without_returning_server_text() {
        assert!(has_permission_error(&[serde_json::json!({
            "severity": 3,
            "generic": 6,
            "data": "Protections table denies permission for user alice"
        })]));
        assert!(!has_permission_error(&[serde_json::json!({
            "severity": 3,
            "generic": 17,
            "data": "no such file(s)"
        })]));
    }
}
