use crate::domain::{
    ChangelistSummary, MergeClassification, OperationEvent, OperationResult, PendingChange,
    PendingFile, SubmittedChangeDetail, SubmittedChangeFile, SubmittedInspectionStatus,
    SubmittedIntegrationEvidence, SubmittedIntegrationEvidenceSource,
};
use chrono::{DateTime, Utc};
use serde_json::Value;

pub fn parse_change_events(events: &[OperationEvent]) -> Vec<ChangelistSummary> {
    events
        .iter()
        .filter_map(|event| event.message.as_deref())
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(Value::is_object)
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
        merge_classification: classify_summary(&description),
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

fn classify_summary(description: &str) -> MergeClassification {
    let description = description.to_lowercase();
    let merge = description.contains("merge")
        || description.contains("integrat")
        || description.contains("branch");
    if merge {
        MergeClassification::SuspectedMerge
    } else {
        MergeClassification::Unknown
    }
}

pub fn parse_submitted_detail(
    events: &[OperationEvent],
    expected_change_id: i64,
) -> Result<SubmittedChangeDetail, String> {
    let value = json_values(events)
        .into_iter()
        .next()
        .ok_or("p4 describe returned no structured changelist")?;
    let change_id =
        number_option(&value, "change").ok_or("p4 describe omitted the submitted changelist ID")?;
    let status = text(&value, "status");
    let user = text(&value, "user");
    if change_id != expected_change_id || status != "submitted" || user.trim().is_empty() {
        return Err("p4 describe returned an unexpected or malformed changelist".into());
    }
    let description = normalized_multiline(&text(&value, "desc"));
    let mut files = Vec::new();
    let mut integration_evidence = Vec::new();
    for index in 0.. {
        let Some(depot_path) = value
            .get(format!("depotFile{index}"))
            .and_then(Value::as_str)
        else {
            break;
        };
        let action = text(&value, &format!("action{index}"));
        let file = SubmittedChangeFile {
            depot_path: depot_path.to_owned(),
            action: action.clone(),
            revision: number_option(&value, &format!("rev{index}")),
            file_type: value
                .get(format!("type{index}"))
                .and_then(Value::as_str)
                .map(str::to_owned),
        };
        if is_integration_action(&action) {
            integration_evidence.push(SubmittedIntegrationEvidence {
                source: SubmittedIntegrationEvidenceSource::DescribeAction,
                depot_path: file.depot_path.clone(),
                relationship: action,
                related_path: None,
            });
        }
        files.push(file);
    }
    if files.is_empty() || files.iter().any(|file| file.revision.is_none()) {
        return Err("p4 describe returned malformed submitted file data".into());
    }
    let merge_classification = if integration_evidence.is_empty() {
        classify_summary(&description)
    } else {
        MergeClassification::ReliableMerge
    };
    Ok(SubmittedChangeDetail {
        change_id,
        description,
        user,
        client: text(&value, "client"),
        time: timestamp(&value),
        jobs: indexed_text(&value, "job"),
        files,
        integration_evidence,
        merge_classification,
        inspection_status: SubmittedInspectionStatus::Partial,
        message: None,
    })
}

pub fn parse_filelog_integration_evidence(
    events: &[OperationEvent],
    expected_change_id: i64,
    expected_files: &[SubmittedChangeFile],
) -> Result<Vec<SubmittedIntegrationEvidence>, String> {
    let values = json_values(events);
    if values.is_empty() {
        return Err("p4 filelog returned no structured file history".into());
    }
    let mut evidence = Vec::new();
    let mut inspected = std::collections::HashSet::new();
    for value in values {
        let depot_path = value
            .get("depotFile")
            .and_then(Value::as_str)
            .ok_or("p4 filelog omitted depotFile")?;
        let Some(expected_file) = expected_files
            .iter()
            .find(|file| file.depot_path == depot_path)
        else {
            continue;
        };
        if number_option(&value, "change0") != Some(expected_change_id)
            || number_option(&value, "rev0") != expected_file.revision
        {
            return Err("p4 filelog did not return the requested submitted revision".into());
        }
        inspected.insert(depot_path.to_owned());
        let object = value
            .as_object()
            .ok_or("p4 filelog returned a non-object record")?;
        for (key, relationship) in object {
            let Some(suffix) = key.strip_prefix("how") else {
                continue;
            };
            let Some(relationship) = relationship.as_str() else {
                return Err("p4 filelog returned malformed integration metadata".into());
            };
            if !is_filelog_integration(relationship) {
                continue;
            }
            evidence.push(SubmittedIntegrationEvidence {
                source: SubmittedIntegrationEvidenceSource::Filelog,
                depot_path: depot_path.to_owned(),
                relationship: relationship.to_owned(),
                related_path: value
                    .get(format!("file{suffix}"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            });
        }
    }
    if inspected.len() != expected_files.len() {
        return Err("p4 filelog omitted one or more submitted files".into());
    }
    Ok(evidence)
}

pub fn finalize_submitted_classification(
    detail: &mut SubmittedChangeDetail,
    filelog_evidence: Vec<SubmittedIntegrationEvidence>,
) {
    detail.integration_evidence.extend(filelog_evidence);
    detail.inspection_status = SubmittedInspectionStatus::Complete;
    detail.merge_classification = if !detail.integration_evidence.is_empty() {
        MergeClassification::ReliableMerge
    } else if classify_summary(&detail.description) == MergeClassification::SuspectedMerge {
        MergeClassification::SuspectedMerge
    } else {
        MergeClassification::Normal
    };
}

fn is_integration_action(action: &str) -> bool {
    matches!(action.to_ascii_lowercase().as_str(), "integrate" | "branch")
}

fn is_filelog_integration(relationship: &str) -> bool {
    let relationship = relationship.to_ascii_lowercase();
    [
        "merge", "branch", "copy", "add", "ignored", "delete", "edit",
    ]
    .iter()
    .any(|kind| relationship.starts_with(kind))
        && (relationship.ends_with(" from") || relationship.ends_with(" into"))
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
        .filter(Value::is_object)
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

    fn event(message: &str) -> OperationEvent {
        OperationEvent {
            operation_id: "op".into(),
            kind: crate::domain::EventKind::Stdout,
            message: Some(message.into()),
            progress: None,
            timestamp: "now".into(),
        }
    }

    #[test]
    fn summary_text_can_only_raise_suspicion() {
        assert_eq!(
            classify_summary("Merge dev"),
            MergeClassification::SuspectedMerge
        );
        assert_eq!(
            classify_summary("Branch release"),
            MergeClassification::SuspectedMerge
        );
        assert_eq!(
            classify_summary("ordinary change"),
            MergeClassification::Unknown
        );
    }

    #[test]
    fn parses_submitted_detail_and_requires_explicit_integration_evidence() {
        let events = [event(
            r#"{"change":"42","status":"submitted","user":"buildbot","client":"ws","desc":"Merge by name only","time":"1700000000","job0":"JOB-1","depotFile0":"//depot/main/a","action0":"edit","rev0":"3","type0":"text"}"#,
        )];
        let mut detail = parse_submitted_detail(&events, 42).unwrap();
        assert_eq!(
            detail.merge_classification,
            MergeClassification::SuspectedMerge
        );
        assert!(detail.integration_evidence.is_empty());
        finalize_submitted_classification(&mut detail, Vec::new());
        assert_eq!(
            detail.merge_classification,
            MergeClassification::SuspectedMerge
        );

        let events = [event(
            r#"{"change":"41","status":"submitted","user":"alice","client":"ws","desc":"Ordinary edit","time":"1700000000","depotFile0":"//depot/main/a","action0":"edit","rev0":"2"}"#,
        )];
        let mut ordinary = parse_submitted_detail(&events, 41).unwrap();
        finalize_submitted_classification(&mut ordinary, Vec::new());
        assert_eq!(ordinary.merge_classification, MergeClassification::Normal);

        let events = [event(
            r#"{"change":"43","status":"submitted","user":"alice","client":"ws","desc":"Promote","time":"1700000000","depotFile0":"//depot/main/a","action0":"integrate","rev0":"4"}"#,
        )];
        let detail = parse_submitted_detail(&events, 43).unwrap();
        assert_eq!(
            detail.merge_classification,
            MergeClassification::ReliableMerge
        );
    }

    #[test]
    fn filelog_evidence_is_parsed_and_malformed_describe_is_rejected() {
        let files = [SubmittedChangeFile {
            depot_path: "//depot/main/a".into(),
            action: "edit".into(),
            revision: Some(3),
            file_type: None,
        }];
        let evidence = parse_filelog_integration_evidence(
            &[
                event(
                    r#"{"depotFile":"//depot/main/a","rev0":"3","change0":"42","how0,0":"merge from","file0,0":"//depot/dev/a"}"#,
                ),
                event("0"),
            ],
            42,
            &files,
        )
        .unwrap();
        assert_eq!(evidence.len(), 1);
        assert_eq!(evidence[0].related_path.as_deref(), Some("//depot/dev/a"));
        assert!(parse_filelog_integration_evidence(
            &[event(
                r#"{"depotFile":"//depot/main/a","rev0":"2","change0":"40","how0,0":"merge from"}"#
            )],
            42,
            &files,
        )
        .is_err());
        assert!(parse_submitted_detail(
            &[event(
                r#"{"change":"44","status":"submitted","user":"alice"}"#
            )],
            44
        )
        .is_err());
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
