use crate::domain::{OperationEvent, ResolveVersionSource, ShelfDetailFile, ShelfInspectionStatus};
use chrono::{DateTime, Utc};
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
    pub size: Option<u64>,
    pub shelved_size: Option<u64>,
    pub shelved_type: Option<String>,
    pub unresolved: usize,
    /// Already resolved but not yet submitted integration records (`fstat -T resolved`).
    pub resolved: usize,
    pub other_open: usize,
    pub other_lock: usize,
    pub our_lock: usize,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolveRecord {
    pub target_file: Option<String>,
    pub base_file: Option<String>,
    pub base_revision: Option<i64>,
    pub from_file: Option<String>,
    pub end_from_revision: Option<i64>,
    pub resolve_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilelogRevision {
    pub revision: Option<i64>,
    pub change: Option<i64>,
    pub user: Option<String>,
    /// RFC 3339 when P4 returned a parseable epoch second.
    pub time: Option<String>,
    pub description: Option<String>,
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
                size: unsigned(&value, "fileSize"),
                shelved_size: unsigned(&value, "shelvedSize"),
                shelved_type: value
                    .get("shelvedType")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                unresolved: count(&value, "unresolved"),
                resolved: count(&value, "resolved"),
                other_open: count(&value, "otherOpen"),
                other_lock: count(&value, "otherLock"),
                our_lock: count(&value, "ourLock"),
            })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedShelfDetail {
    pub description: String,
    pub time: String,
    pub owner: String,
    pub user: String,
    pub client: String,
    pub jobs: Vec<String>,
    pub files: Vec<ShelfDetailFile>,
    pub inspection_status: ShelfInspectionStatus,
    pub message: Option<String>,
}

pub fn shelf_detail(
    events: &[OperationEvent],
    expected_change: i64,
    facts: &[WorkflowFileFact],
) -> Result<ParsedShelfDetail, String> {
    let value = json_values(events)
        .into_iter()
        .find(|value| number(value, "change") == Some(expected_change))
        .ok_or("p4 describe -S returned no structured shelf")?;
    if text(&value, "status") == "submitted" {
        return Err("the requested changelist is submitted, not a shelf".into());
    }
    let mut files = Vec::new();
    for index in 0.. {
        let Some(path) = value
            .get(format!("depotFile{index}"))
            .and_then(Value::as_str)
        else {
            break;
        };
        let action = text(&value, &format!("action{index}"));
        let described_type = value
            .get(format!("type{index}"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let fact = facts.iter().find(|fact| fact.depot_path == path);
        let file_type = fact
            .and_then(|fact| fact.shelved_type.clone())
            .or(described_type);
        let lowered_type = file_type
            .as_deref()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let lowered_action = action.to_ascii_lowercase();
        files.push(ShelfDetailFile {
            depot_path: path.to_owned(),
            action,
            revision: number(&value, &format!("rev{index}")),
            file_type,
            size: fact.and_then(|fact| fact.shelved_size.or(fact.size)),
            digest: fact.and_then(|fact| {
                (!fact.shelved_digest.is_empty())
                    .then(|| fact.shelved_digest.clone())
                    .or_else(|| (!fact.digest.is_empty()).then(|| fact.digest.clone()))
            }),
            binary: lowered_type.contains("binary") || lowered_type.contains("apple"),
            symlink: lowered_type.starts_with("symlink"),
            deleted: matches!(lowered_action.as_str(), "delete" | "move/delete" | "purge"),
        });
    }
    if files.is_empty() {
        return Err("the changelist has no visible shelved files".into());
    }
    files.sort_by(|left, right| left.depot_path.cmp(&right.depot_path));
    let missing_metadata = files
        .iter()
        .filter(|file| !file.deleted && (file.file_type.is_none() || file.digest.is_none()))
        .count();
    Ok(ParsedShelfDetail {
        description: normalized_multiline(&text(&value, "desc")),
        time: timestamp(&value),
        owner: text(&value, "user"),
        user: text(&value, "user"),
        client: text(&value, "client"),
        jobs: indexed_text(&value, "job"),
        files,
        inspection_status: if missing_metadata == 0 {
            ShelfInspectionStatus::Complete
        } else {
            ShelfInspectionStatus::Partial
        },
        message: (missing_metadata > 0)
            .then(|| format!("Metadata is unavailable for {missing_metadata} shelved file(s).")),
    })
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolveDiffCounts {
    pub yours: usize,
    pub theirs: usize,
    pub both: usize,
    pub conflicting: usize,
}

/// P4's own merge engine prints the authoritative summary:
/// `Diff chunks: 4 yours + 2 theirs + 1 both + 1 conflicting`.
/// P4V's "Differences from base" / "Conflicts" are these same counts.
pub fn resolve_diff_counts(lines: &[String]) -> Option<ResolveDiffCounts> {
    let line = lines
        .iter()
        .find_map(|line| line.split_once("Diff chunks:").map(|(_, rest)| rest))?;
    let mut counts = ResolveDiffCounts {
        yours: 0,
        theirs: 0,
        both: 0,
        conflicting: 0,
    };
    let tokens = line.split_whitespace().collect::<Vec<_>>();
    for pair in tokens.windows(2) {
        let Ok(number) = pair[0].parse::<usize>() else {
            continue;
        };
        match pair[1].trim_end_matches(',') {
            "yours" => counts.yours = number,
            "theirs" => counts.theirs = number,
            "both" => counts.both = number,
            "conflicting" => counts.conflicting = number,
            _ => {}
        }
    }
    (counts.yours + counts.theirs + counts.both + counts.conflicting > 0).then_some(counts)
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

pub fn resolve_records(events: &[OperationEvent]) -> Vec<ResolveRecord> {
    json_values(events)
        .into_iter()
        .filter_map(|value| {
            let pick = |keys: &[&str]| {
                keys.iter()
                    .find_map(|key| value.get(*key).and_then(Value::as_str))
                    .map(str::to_owned)
            };
            let revision = |keys: &[&str]| {
                keys.iter().find_map(|key| {
                    value.get(*key).and_then(|item| {
                        item.as_i64().or_else(|| {
                            item.as_str()
                                .and_then(|text| text.trim_start_matches('#').parse().ok())
                        })
                    })
                })
            };
            let record = ResolveRecord {
                target_file: pick(&["clientFile", "toFile", "depotFile"]),
                base_file: pick(&["resolveBaseFile", "baseFile"]),
                base_revision: revision(&["resolveBaseRev", "baseRev"]),
                from_file: pick(&["resolveFromFile", "fromFile"]),
                end_from_revision: revision(&["resolveEndFromRev", "endFromRev"]),
                resolve_type: pick(&["resolveType"]),
            };
            (record.base_file.is_some()
                || record.from_file.is_some()
                || record.resolve_type.is_some())
            .then_some(record)
        })
        .collect()
}

/// Latest `p4 filelog -m 1 -t` revision metadata for one depot file. Accepts
/// both the unindexed (`rev`/`change`/`desc`) and indexed (`rev0`/`change0`)
/// marshal shapes; unknown fields stay `None`.
pub fn filelog_revision(events: &[OperationEvent]) -> Option<FilelogRevision> {
    let mut best: Option<(i64, FilelogRevision)> = None;
    for value in json_values(events) {
        let Some(object) = value.as_object() else {
            continue;
        };
        let mut revision: Option<i64> = None;
        let mut suffix = String::new();
        for (key, item) in object {
            let Some(rest) = key.strip_prefix("rev") else {
                continue;
            };
            if !rest.chars().all(|ch| ch.is_ascii_digit()) {
                continue;
            }
            let Some(parsed) = item
                .as_i64()
                .or_else(|| item.as_str().and_then(|text| text.parse().ok()))
            else {
                continue;
            };
            if revision.is_none_or(|current| parsed > current) {
                revision = Some(parsed);
                suffix = rest.to_owned();
            }
        }
        let Some(revision) = revision else {
            continue;
        };
        let text = |prefix: &str| {
            value
                .get(format!("{prefix}{suffix}"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let record = FilelogRevision {
            revision: Some(revision),
            change: text("change").and_then(|value| value.parse().ok()),
            user: text("user"),
            time: text("time").and_then(|value| rfc3339_epoch(&value)),
            description: text("desc")
                .map(|value| value.trim_end().to_owned())
                .filter(|value| !value.is_empty()),
        };
        if best.as_ref().is_none_or(|(current, _)| revision > *current) {
            best = Some((revision, record));
        }
    }
    best.map(|(_, record)| record)
}

fn rfc3339_epoch(value: &str) -> Option<String> {
    value
        .trim()
        .parse::<i64>()
        .ok()
        .and_then(|seconds| DateTime::<Utc>::from_timestamp(seconds, 0))
        .map(|value| value.to_rfc3339())
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

fn unsigned(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(|value| {
        value
            .as_u64()
            .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
    })
}

fn indexed_text(value: &Value, prefix: &str) -> Vec<String> {
    (0..)
        .map_while(|index| {
            value
                .get(format!("{prefix}{index}"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}

fn normalized_multiline(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
}

fn timestamp(value: &Value) -> String {
    number(value, "time")
        .and_then(|value| DateTime::<Utc>::from_timestamp(value, 0))
        .unwrap_or_else(Utc::now)
        .to_rfc3339()
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
        let records = resolve_records(&[event(
            r##"{"clientFile":"//client/a","resolveBaseFile":"//depot/a","resolveBaseRev":"#2","resolveFromFile":"//depot/a","resolveEndFromRev":"3","resolveType":"content"}"##,
        )]);
        assert_eq!(records[0].base_revision, Some(2));
        assert_eq!(records[0].end_from_revision, Some(3));
        assert_eq!(records[0].resolve_type.as_deref(), Some("content"));
    }

    #[test]
    fn parses_p4_engine_diff_chunk_counts() {
        let lines = preview_lines(&[event(
            "Diff chunks: 4 yours + 2 theirs + 1 both + 1 conflicting",
        )]);
        let counts = resolve_diff_counts(&lines).expect("counts");
        assert_eq!(counts.yours, 4);
        assert_eq!(counts.theirs, 2);
        assert_eq!(counts.both, 1);
        assert_eq!(counts.conflicting, 1);
        assert!(resolve_diff_counts(&["no summary".into()]).is_none());
    }

    #[test]
    fn parses_sorted_shelf_detail_with_binary_delete_and_special_paths() {
        let events = [event(
            r#"{"change":"7","status":"shelved","user":"tester","client":"ws","time":"1700000000","desc":"Shelf\n","job0":"JOB-1","depotFile0":"//depot/z bin@#%.dat","action0":"edit","type0":"binary","rev0":"3","depotFile1":"//depot/a 删除.txt","action1":"delete","type1":"text","rev1":"2"}"#,
        )];
        let facts = file_facts(&[event(
            r#"{"depotFile":"//depot/z bin@#%.dat","shelvedType":"binary","shelvedSize":"4096","shelvedDigest":"ABC"}"#,
        )]);
        let detail = shelf_detail(&events, 7, &facts).unwrap();
        assert_eq!(detail.jobs, ["JOB-1"]);
        assert_eq!(detail.files[0].depot_path, "//depot/a 删除.txt");
        assert!(detail.files[0].deleted);
        assert!(detail.files[1].binary);
        assert_eq!(detail.files[1].size, Some(4096));
        assert_eq!(detail.inspection_status, ShelfInspectionStatus::Complete);
    }

    #[test]
    fn parses_filelog_revision_metadata_in_both_marshal_shapes() {
        let plain = filelog_revision(&[event(
            r#"{"depotFile":"//depot/a","rev":"2","change":"42","user":"alice","time":"1700000000","desc":"Add feature\n\n"}"#,
        )])
        .unwrap();
        assert_eq!(plain.revision, Some(2));
        assert_eq!(plain.change, Some(42));
        assert_eq!(plain.user.as_deref(), Some("alice"));
        assert_eq!(plain.time.as_deref(), Some("2023-11-14T22:13:20+00:00"));
        assert_eq!(plain.description.as_deref(), Some("Add feature"));

        let indexed = filelog_revision(&[event(
            r#"{"depotFile":"//depot/a","rev0":"2","change0":"42","user0":"alice","time0":"1700000000","desc0":"Indexed"}"#,
        )])
        .unwrap();
        assert_eq!(indexed.revision, Some(2));
        assert_eq!(indexed.change, Some(42));
        assert_eq!(indexed.user.as_deref(), Some("alice"));
        assert_eq!(indexed.description.as_deref(), Some("Indexed"));

        // Missing fields stay None; malformed/absent revisions are not fabricated.
        let sparse = filelog_revision(&[event(r#"{"depotFile":"//depot/a","rev":"1"}"#)]).unwrap();
        assert_eq!(sparse.change, None);
        assert_eq!(sparse.user, None);
        assert_eq!(sparse.time, None);
        assert_eq!(sparse.description, None);
        assert!(filelog_revision(&[event(r#"{"depotFile":"//depot/a"}"#)]).is_none());
    }
}
