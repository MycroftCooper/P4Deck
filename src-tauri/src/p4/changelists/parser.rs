use crate::domain::{
    ChangelistSummary, MergeClassification, OperationEvent, OperationResult, PendingChange,
    PendingFile, SubmittedChangeDetail, SubmittedChangeFile, SubmittedInspectionStatus,
    SubmittedIntegrationEvidence, SubmittedIntegrationEvidenceSource,
};
use chrono::{DateTime, Utc};
use serde_json::Value;

#[derive(Debug, Clone)]
pub struct SubmittedQueryMetadata {
    pub jobs: Vec<String>,
    pub file_count: usize,
    pub merge_classification: MergeClassification,
    pub search_text: String,
}

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

// Submitted paging must not turn diagnostics or unrecognized output into an
// exhausted page. A genuinely empty successful stdout remains an empty page.
pub fn parse_submitted_page(events: &[OperationEvent]) -> Result<Vec<ChangelistSummary>, String> {
    use crate::domain::EventKind;
    let mut rows = Vec::new();
    for event in events {
        match event.kind {
            EventKind::Cancelled | EventKind::Error | EventKind::Warning | EventKind::Stderr => {
                return Err("Submitted query returned a diagnostic or was cancelled; results are incomplete.".into());
            }
            EventKind::Stdout => {}
            _ => continue,
        }
        let Some(line) = event
            .message
            .as_deref()
            .filter(|line| !line.trim().is_empty())
        else {
            continue;
        };
        let value: Value = serde_json::from_str(line)
            .map_err(|_| "Submitted query returned unrecognized output; results are incomplete.")?;
        if value.get("severity").is_some()
            || value.get("code").is_some_and(|code| code != "stat")
            || value.get("desc").and_then(Value::as_str).is_none()
            || number(&value, "change") <= 0
        {
            return Err(
                "Submitted query returned incomplete records or a server diagnostic.".into(),
            );
        }
        rows.push(parse_change(value).ok_or("Invalid submitted change record")?);
    }
    Ok(rows)
}

pub fn parse_query_metadata(
    events: &[OperationEvent],
) -> std::collections::HashMap<i64, SubmittedQueryMetadata> {
    json_values(events)
        .into_iter()
        .filter_map(|value| {
            let change_id = number_option(&value, "change")?;
            let description = text(&value, "desc");
            let mut file_count = 0;
            let mut has_integration_action = false;
            let mut depot_paths = Vec::new();
            for index in 0.. {
                let Some(depot_path) = value
                    .get(format!("depotFile{index}"))
                    .and_then(Value::as_str)
                else {
                    break;
                };
                file_count += 1;
                depot_paths.push(depot_path);
                has_integration_action |=
                    is_integration_action(&text(&value, &format!("action{index}")));
            }
            let jobs = indexed_text(&value, "job");
            Some((
                change_id,
                SubmittedQueryMetadata {
                    search_text: format!("{} {}", jobs.join(" "), depot_paths.join(" ")),
                    jobs,
                    file_count,
                    merge_classification: if has_integration_action {
                        MergeClassification::ReliableMerge
                    } else {
                        classify_summary(&description)
                    },
                },
            ))
        })
        .collect()
}

pub fn parse_fix_change_ids(events: &[OperationEvent]) -> Vec<i64> {
    json_values(events)
        .iter()
        .filter_map(|value| {
            number_option(value, "Change").or_else(|| number_option(value, "change"))
        })
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
    if change_id != expected_change_id || user.trim().is_empty() {
        return Err("p4 describe returned an unexpected or malformed changelist".into());
    }
    let submitted = match status.as_str() {
        "submitted" => true,
        "pending" | "shelved" => false,
        _ => return Err("p4 describe returned an unexpected or malformed changelist".into()),
    };
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
        // `p4 -ztag -Mj describe -s` provides one bare action per file
        // ("integrate"/"branch"/"edit"); it is shown verbatim in the file list.
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
        if submitted && is_integration_action(&action) {
            integration_evidence.push(SubmittedIntegrationEvidence {
                source: SubmittedIntegrationEvidenceSource::DescribeAction,
                depot_path: file.depot_path.clone(),
                relationship: action,
                related_path: None,
            });
        }
        files.push(file);
    }
    if submitted && (files.is_empty() || files.iter().any(|file| file.revision.is_none())) {
        return Err("p4 describe returned malformed submitted file data".into());
    }
    // Pending/shelved changelists only expose shelved files and can legitimately
    // describe zero files; their integration state is not inspectable here.
    let merge_classification = if !submitted {
        MergeClassification::Unknown
    } else if integration_evidence.is_empty() {
        classify_summary(&description)
    } else {
        MergeClassification::ReliableMerge
    };
    Ok(SubmittedChangeDetail {
        change_id,
        status,
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

pub fn parse_pending_metadata(
    events: &[OperationEvent],
) -> std::collections::HashMap<i64, PendingChangeSpec> {
    json_values(events)
        .into_iter()
        .filter_map(|value| {
            let id = number_option(&value, "change")?;
            Some((
                id,
                PendingChangeSpec {
                    id,
                    description: normalized_multiline(&text(&value, "desc")),
                    user: text(&value, "user"),
                    client: text(&value, "client"),
                    status: text(&value, "status"),
                    jobs: indexed_text(&value, "job"),
                },
            ))
        })
        .collect()
}

/// `p4 resolve -n` preview: one line per unresolved file, shaped like
/// `<clientPath> - merging <depotPath>#<rev>`. Returned for row badges only; nothing is resolved.
#[derive(Debug, Default)]
pub struct ResolvePreview {
    pub client_paths: std::collections::HashSet<String>,
    pub depot_paths: std::collections::HashSet<String>,
}

/// Normalize a client path for comparison: separators unified, drive letter case-insensitive.
pub fn normalize_client_path(value: &str) -> String {
    // `p4 opened` may return a client-relative form ("//client/Assets/..."), while `resolve -n`
    // prints the absolute local path; compare both after separator/case normalization.
    value
        .replace('/', "\\")
        .trim_start_matches('\\')
        .to_lowercase()
}

pub fn parse_resolve_preview(events: &[OperationEvent]) -> ResolvePreview {
    let mut preview = ResolvePreview::default();
    for event in events {
        let Some(message) = event.message.as_deref() else {
            continue;
        };
        for line in message.lines() {
            let line = line.trim();
            if line.is_empty() || !line.contains(" - merging ") {
                if let Some(depot) = line.split_whitespace().find(|part| part.starts_with("//")) {
                    preview
                        .depot_paths
                        .insert(depot.split('#').next().unwrap_or(depot).to_owned());
                }
                continue;
            }
            let (client, source) = line.split_once(" - merging ").unwrap();
            preview
                .client_paths
                .insert(normalize_client_path(client.trim()));
            if let Some(depot) = source
                .split_whitespace()
                .find(|part| part.starts_with("//"))
            {
                preview
                    .depot_paths
                    .insert(depot.split('#').next().unwrap_or(depot).to_owned());
            }
        }
    }
    preview
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
                    resolve: None,
                    action,
                    client_path: value
                        .get("clientFile")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    revision: number_option(&value, "rev"),
                    head_revision: None,
                    file_type: value.get("type").and_then(Value::as_str).map(str::to_owned),
                    lock_ownership: None,
                    lock_owner: None,
                    other_open: Vec::new(),
                    exclusive_open: None,
                },
            ))
        })
        .collect()
}

pub fn merge_lock_status(
    files: &mut [(i64, PendingFile)],
    facts: &[crate::p4::locks::parser::FileFact],
) {
    let facts = facts
        .iter()
        .map(|fact| (fact.depot_path.as_str(), fact))
        .collect::<std::collections::HashMap<_, _>>();
    for (_, file) in files {
        let Some(fact) = facts.get(file.depot_path.as_str()) else {
            continue;
        };
        if !fact.file_type.is_empty() {
            file.file_type = Some(fact.file_type.clone());
        }
        file.lock_ownership = Some(fact.ownership);
        file.lock_owner.clone_from(&fact.lock_owner);
        file.other_open.clone_from(&fact.other_open);
        file.exclusive_open = Some(crate::p4::locks::parser::exclusive(&fact.file_type));
        // Known have may fill an absent opened revision, but never overwrite the
        // `p4 opened` revision semantics. Head stays optional: absence is unknown,
        // never an implicit "current".
        if file.revision.is_none() {
            file.revision = fact.have_revision;
        }
        file.head_revision = fact.head_revision;
    }
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
                    resolve: None,
                    client_path: None,
                    revision: number_option(&value, &format!("rev{index}")),
                    head_revision: None,
                    file_type: value
                        .get(format!("type{index}"))
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    lock_ownership: None,
                    lock_owner: None,
                    other_open: Vec::new(),
                    exclusive_open: None,
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
        "add" | "branch" => Some("openedAdd"),
        "move/add" => Some("openedMoveAdd"),
        "delete" => Some("openedDelete"),
        "move/delete" => Some("openedMoveDelete"),
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
    fn submitted_page_rejects_partial_or_diagnostic_output() {
        let valid = event(r#"{"change":"42","desc":"Body\n提交人: robot","status":"submitted"}"#);
        for bad in [
            "not json",
            r#"{"severity":2,"data":"permission denied"}"#,
            r#"{"code":"error","data":"maxresults exceeded"}"#,
            r#"{"change":"43"}"#,
        ] {
            assert!(parse_submitted_page(&[valid.clone(), event(bad)]).is_err());
        }
        for kind in [
            crate::domain::EventKind::Cancelled,
            crate::domain::EventKind::Warning,
            crate::domain::EventKind::Error,
            crate::domain::EventKind::Stderr,
        ] {
            let mut diagnostic = event("diagnostic");
            diagnostic.kind = kind;
            assert!(parse_submitted_page(&[valid.clone(), diagnostic]).is_err());
        }
    }

    #[test]
    fn submitted_page_preserves_distinct_changes_with_identical_full_descriptions() {
        let description = "Body\r\n提交人: robot\nCL号: 7";
        let events = [42, 43].map(|id| {
            event(
                &serde_json::json!({
                "change": id, "desc": description, "status": "submitted", "client": format!("workspace-{id}")
                })
                .to_string(),
            )
        });
        let rows = parse_submitted_page(&events).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].description, description);
        assert_eq!(rows[1].description, description);
        assert_ne!(rows[0].id, rows[1].id);
        assert_eq!(rows[0].client, "workspace-42");
        assert_eq!(rows[1].client, "workspace-43");
        assert!(parse_submitted_page(&[]).unwrap().is_empty());
    }

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
    fn submitted_summary_preserves_full_report_source() {
        let description = format!(
            "[CODE][DOC] {}\n第二行完整内容\n--> Task [project:story:123]\n提交人: original",
            "x".repeat(350)
        );
        let raw = serde_json::json!({
            "change":"4242", "status":"submitted", "user":"alice",
            "client":"alice_v2d1", "desc":description, "time":"1700000000"
        })
        .to_string();
        let rows = parse_change_events(&[event(&raw)]);
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.id, 4242);
        assert_eq!(row.description, description);
        assert_eq!(row.user, "alice");
        assert_eq!(row.client, "alice_v2d1");
        assert_eq!(row.time, "2023-11-14T22:13:20+00:00");
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
        assert_eq!(detail.status, "submitted");
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
    fn submitted_detail_keeps_the_real_action_per_file() {
        // Real `p4 -ztag -Mj describe -s 11562403` (captured from the live
        // server): six files, every action the bare word "integrate", and no
        // per-file integration block. The parsed action must stay verbatim so
        // the file list can show it in its own column.
        let events = [event(
            r#"{"action0":"integrate","action1":"integrate","action2":"integrate","change":"11562403","changeType":"public","client":"workspacepool_sid_3_stream_DM42.Beyond.Project-Development-Beyond_v2d0_uuid_2hbx98ek","depotFile0":"//DM42.Beyond.Project/Development/Beyond_v2d0/Assets/Beyond/Scripts/Gameplay/RemoteFactory/FormationZone/FormationZoneQuery.cs","depotFile1":"//DM42.Beyond.Project/Development/Beyond_v2d0/Assets/Beyond/Scripts/Gameplay/RemoteFactory/FormationZone/FormationZoneSolver.cs","depotFile2":"//DM42.Beyond.Project/Development/Beyond_v2d0/Assets/Beyond/Scripts/Gameplay/RemoteFactory/FormationZone/FormationZoneTypes.cs","desc":"[CODE]1.按水平范围合并阵法Zone","rev0":"14","rev1":"7","rev2":"11","status":"submitted","time":"1793765034","type0":"text","type1":"text","type2":"text","user":"fenganmeng"}"#,
        )];
        let detail = parse_submitted_detail(&events, 11_562_403).unwrap();
        assert_eq!(detail.status, "submitted");
        assert_eq!(detail.files.len(), 3);
        for (file, revision) in detail.files.iter().zip([14, 7, 11]) {
            assert_eq!(file.action, "integrate");
            assert_eq!(file.revision, Some(revision));
        }
        assert_eq!(
            detail.merge_classification,
            MergeClassification::ReliableMerge
        );
    }

    #[test]
    fn submitted_detail_never_invents_an_integration_source_revision() {
        // An integration block without P4's revision marker: the action stays
        // bare instead of guessing a revision from the source path.
        let events = [event(
            r#"{"change":"44","status":"submitted","user":"alice","client":"ws","desc":"Promote","time":"1700000000","depotFile0":"//depot/main/a","action0":"integrate","rev0":"4","how0":"integrate","file0":"//depot/dev/a","depotFile1":"//depot/main/b","action1":"branch","rev1":"9"}"#,
        )];
        let files = parse_submitted_detail(&events, 44).unwrap().files;
        assert_eq!(files[0].action, "integrate");
        assert_eq!(files[1].action, "branch");
    }

    #[test]
    fn pending_describe_without_shelved_files_is_a_valid_partial_detail() {
        // Real-world shape: `p4 -ztag -Mj describe -s 11544041` for a pending CL
        // that has no shelved files. This used to be rejected as malformed.
        let events = [event(
            r#"{"IsPromoted":"1","change":"11544041","changeType":"public","client":"beyond_build_BM_IT-DES004-00263_Beyond_v2d1_Tools_Proj","desc":"[Data][AutoGen] 牧场数据导出\n","shelved":"","status":"pending","time":"1793691022","user":"beyond_build"}"#,
        )];
        let detail = parse_submitted_detail(&events, 11_544_041).unwrap();
        assert_eq!(detail.status, "pending");
        assert_eq!(detail.change_id, 11_544_041);
        assert_eq!(detail.user, "beyond_build");
        assert_eq!(detail.description, "[Data][AutoGen] 牧场数据导出");
        assert!(detail.files.is_empty());
        assert!(detail.integration_evidence.is_empty());
        assert_eq!(detail.merge_classification, MergeClassification::Unknown);
        assert_eq!(detail.inspection_status, SubmittedInspectionStatus::Partial);
        // The repository supplies the pending explanation; the parser only flags Partial.
        assert!(detail.message.is_none());
    }

    #[test]
    fn pending_describe_with_shelved_files_parses_files_without_requiring_revisions() {
        // Shape of `p4 -ztag -Mj describe -s -S <id>` for a pending CL: shelf files
        // are indexed depotFileN/actionN/revN/typeN records. `add` shelves carry no
        // revision and must not be rejected for a pending changelist.
        let events = [event(
            r#"{"change":"77","status":"pending","user":"alice","client":"ws","desc":"shelf","time":"1700000000","depotFile0":"//depot/main/a","action0":"edit","rev0":"3","type0":"text","depotFile1":"//depot/main/b","action1":"add","type1":"binary"}"#,
        )];
        let detail = parse_submitted_detail(&events, 77).unwrap();
        assert_eq!(detail.status, "pending");
        assert_eq!(detail.files.len(), 2);
        assert_eq!(detail.files[0].depot_path, "//depot/main/a");
        assert_eq!(detail.files[0].action, "edit");
        assert_eq!(detail.files[0].revision, Some(3));
        assert_eq!(detail.files[0].file_type.as_deref(), Some("text"));
        assert_eq!(detail.files[1].depot_path, "//depot/main/b");
        assert_eq!(detail.files[1].revision, None);
        assert!(detail.integration_evidence.is_empty());
        assert_eq!(detail.merge_classification, MergeClassification::Unknown);
        assert_eq!(detail.inspection_status, SubmittedInspectionStatus::Partial);
    }

    #[test]
    fn describe_status_gate_accepts_only_submitted_pending_and_shelved() {
        for status in ["privat", "deleted", "submitted-pending", ""] {
            let raw = format!(r#"{{"change":"9","status":"{status}","user":"alice","desc":"x"}}"#);
            assert!(parse_submitted_detail(&[event(&raw)], 9).is_err());
        }
        let shelved = parse_submitted_detail(
            &[event(
                r#"{"change":"9","status":"shelved","user":"alice","client":"ws","desc":"x"}"#,
            )],
            9,
        )
        .unwrap();
        assert_eq!(shelved.status, "shelved");
        assert!(shelved.files.is_empty());
        assert_eq!(
            shelved.inspection_status,
            SubmittedInspectionStatus::Partial
        );

        // Identity and authorship guards survive for every status.
        assert!(parse_submitted_detail(
            &[event(
                r#"{"change":"10","status":"pending","user":"alice","desc":"x"}"#
            )],
            9
        )
        .is_err());
        assert!(parse_submitted_detail(
            &[event(
                r#"{"change":"9","status":"pending","user":" ","desc":"x"}"#
            )],
            9
        )
        .is_err());
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

    #[test]
    fn batched_pending_metadata_preserves_full_descriptions_jobs_and_scope() {
        let events = [
            event(
                r#"{"change":"41","status":"pending","user":"alice","client":"ws","desc":"Line one\nJobs:\nChange: still description\n","job0":"JOB-A","job1":"JOB-B"}"#,
            ),
            event(
                r#"{"change":"42","status":"pending","user":"alice","client":"other","desc":"Other workspace\n"}"#,
            ),
            event(r#"{"code":"error","data":"not found"}"#),
        ];
        let metadata = parse_pending_metadata(&events);
        assert_eq!(metadata.len(), 2);
        assert_eq!(
            metadata[&41].description,
            "Line one\nJobs:\nChange: still description"
        );
        assert_eq!(metadata[&41].jobs, ["JOB-A", "JOB-B"]);
        assert_eq!(metadata[&41].user, "alice");
        assert_eq!(metadata[&41].client, "ws");
        assert_eq!(metadata[&42].client, "other");
    }

    #[test]
    fn merge_lock_status_adds_head_revision_without_overwriting_opened_revision() {
        let events = [event(
            r#"{"action":"edit","change":"42","depotFile":"//depot/a","rev":"3","type":"text"}"#,
        )];
        let facts = crate::p4::locks::parser::file_facts(&[event(
            r#"{"depotFile":"//depot/a","type":"text","haveRev":"79","headRev":"80"}"#,
        )]);
        let mut files = parse_opened_files(&events);
        merge_lock_status(&mut files, &facts);
        // `p4 opened` revision semantics win over the fstat have revision.
        assert_eq!(files[0].1.revision, Some(3));
        assert_eq!(files[0].1.head_revision, Some(80));

        // A missing head keeps None: partial fstat never claims "current".
        let facts = crate::p4::locks::parser::file_facts(&[event(
            r#"{"depotFile":"//depot/a","type":"text","haveRev":"79"}"#,
        )]);
        let mut files = parse_opened_files(&events);
        merge_lock_status(&mut files, &facts);
        assert_eq!(files[0].1.head_revision, None);
        assert_eq!(files[0].1.revision, Some(3));

        // Without any fstat fact the opened revision is untouched and head is unknown.
        let mut files = parse_opened_files(&events);
        merge_lock_status(&mut files, &[]);
        assert_eq!(files[0].1.revision, Some(3));
        assert_eq!(files[0].1.head_revision, None);

        // A known have may fill a missing opened revision; it is never fabricated.
        let no_rev_events = [event(
            r#"{"action":"edit","change":"42","depotFile":"//depot/b","type":"text"}"#,
        )];
        let facts = crate::p4::locks::parser::file_facts(&[event(
            r#"{"depotFile":"//depot/b","haveRev":"5"}"#,
        )]);
        let mut files = parse_opened_files(&no_rev_events);
        merge_lock_status(&mut files, &facts);
        assert_eq!(files[0].1.revision, Some(5));
        assert_eq!(files[0].1.head_revision, None);
    }
}
