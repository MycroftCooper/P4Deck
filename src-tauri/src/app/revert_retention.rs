//! Evidence for a normal `revert -a` retained edit, never inferred from still-open alone.
use super::*;
use crate::p4::{runner::P4Runner, workflows::command};
use std::collections::{BTreeMap, BTreeSet};
use tauri::AppHandle;
#[derive(Default)]
pub struct Observation {
    pub facts: Vec<parser::WorkflowFileFact>,
    pub changed: BTreeSet<String>,
    pub identities: BTreeMap<String, String>,
    pub fingerprints: BTreeMap<String, String>,
}
impl Observation {
    pub fn proves_retained(&self, after: &Self, path: &str, cl: Option<i64>) -> bool {
        let a = self
            .facts
            .iter()
            .filter(|f| f.depot_path == path)
            .collect::<Vec<_>>();
        let b = after
            .facts
            .iter()
            .filter(|f| f.depot_path == path)
            .collect::<Vec<_>>();
        if a.len() != 1
            || b.len() != 1
            || a[0] != b[0]
            || a[0].action != "edit"
            || a[0].change_id.is_none()
            || !a[0].have_revision.is_some_and(|r| r > 0)
            || cl.is_some_and(|cl| a[0].change_id != Some(cl))
        {
            return false;
        }
        self.identities
            .get(path)
            .is_some_and(|v| after.identities.get(path) == Some(v))
            && self.changed.contains(path)
            && after.changed.contains(path)
            && self
                .fingerprints
                .get(path)
                .is_some_and(|h| after.fingerprints.get(path) == Some(h))
    }
}
fn changed_paths(result: &OperationResult, facts: &[parser::WorkflowFileFact]) -> BTreeSet<String> {
    if !clean(result) {
        return BTreeSet::new();
    }
    result
        .events
        .iter()
        .filter_map(|e| e.message.as_deref())
        .filter_map(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .filter(|v| v["status"] == "diff")
        .filter_map(|v| {
            let matches = facts
                .iter()
                .filter(|f| {
                    v["depotFile"].as_str() == Some(f.depot_path.as_str())
                        || f.client_path
                            .as_deref()
                            .is_some_and(|p| v["clientFile"].as_str() == Some(p))
                })
                .collect::<Vec<_>>();
            (matches.len() == 1).then(|| matches[0].depot_path.clone())
        })
        .collect()
}
fn identities(result: &OperationResult, user: &str) -> BTreeMap<String, String> {
    result
        .events
        .iter()
        .filter_map(|e| e.message.as_deref())
        .filter_map(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .filter_map(|v| {
            let path = v["depotFile"].as_str()?;
            let owner = v["actionOwner"].as_str()?;
            let rev = v["workRev"]
                .as_i64()
                .or_else(|| v["workRev"].as_str()?.parse().ok())?;
            (owner == user && !owner.is_empty() && rev > 0)
                .then(|| (path.to_owned(), format!("{owner}:{rev}")))
        })
        .collect()
}
fn comparison_paths(facts: &[parser::WorkflowFileFact]) -> Vec<String> {
    facts
        .iter()
        .filter(|f| f.action == "edit")
        .filter_map(|f| {
            f.have_revision
                .filter(|r| *r > 0)
                .map(|r| format!("{}#{r}", f.depot_path))
        })
        .collect()
}
fn fingerprints(
    context: &P4Context,
    facts: &[parser::WorkflowFileFact],
    changed: &BTreeSet<String>,
) -> BTreeMap<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut result = BTreeMap::new();
    let mut budget = 64 * 1024 * 1024u64;
    let Some(root) = context
        .cwd
        .as_ref()
        .and_then(|p| std::fs::canonicalize(p).ok())
    else {
        return result;
    };
    for fact in facts
        .iter()
        .filter(|f| f.action == "edit" && changed.contains(&f.depot_path))
    {
        let Some(path) = fact
            .client_path
            .as_ref()
            .and_then(|p| std::fs::canonicalize(p).ok())
            .filter(|p| p.starts_with(&root))
        else {
            continue;
        };
        let Ok(mut file) = std::fs::File::open(&path) else {
            continue;
        };
        let Ok(before) = file.metadata() else {
            continue;
        };
        if before.modified().is_err() {
            continue;
        }
        if !before.is_file() || before.len() > 16 * 1024 * 1024 || before.len() > budget {
            continue;
        }
        budget -= before.len();
        let mut bytes = Vec::new();
        if (&mut file)
            .take(before.len() + 1)
            .read_to_end(&mut bytes)
            .is_err()
        {
            continue;
        }
        let Ok(after) = file.metadata() else { continue };
        if bytes.len() as u64 != before.len()
            || before.len() != after.len()
            || before.modified().ok() != after.modified().ok()
        {
            continue;
        }
        result.insert(
            fact.depot_path.clone(),
            format!(
                "{}:{:?}:{:x}",
                before.len(),
                before.modified().ok(),
                Sha256::digest(&bytes)
            ),
        );
    }
    result
}
pub async fn capture(
    runner: &P4Runner,
    context: &P4Context,
    paths: &[String],
    id: &str,
    app: &AppHandle,
) -> Result<(OperationResult, Observation), String> {
    let mut query = command::fstat(paths, None)?;
    query.args[2].push_str(",actionOwner,workRev");
    query.args.remove(0); // no depot content hashing
    let observed = runner
        .run_with_progress(
            P4CommandRequest {
                operation_id: Some(format!("{id}:facts")),
                source: OperationSource::Gui,
                command: query.command.into(),
                args: query.args,
                context: context.clone(),
                output_mode: OutputMode::JsonLines,
                timeout_ms: Some(300_000),
                input: None,
            },
            Some(app),
            None,
            query.argument_input,
        )
        .await
        .map_err(|e| e.to_string())?;
    if !clean(&observed) {
        return Err("Retention facts unavailable".into());
    }
    let identities = identities(&observed, &context.user);
    let facts = parser::file_facts(&observed.events);
    let comparison_paths = comparison_paths(&facts);
    if comparison_paths.is_empty() {
        return Ok((
            observed,
            Observation {
                facts,
                ..Observation::default()
            },
        ));
    }
    let mut query = command::modified_paths(&comparison_paths, true)?;
    query.args[0] = "-sl".into();
    query.args.insert(0, "-f".into());
    let diff = runner
        .run_with_progress(
            P4CommandRequest {
                operation_id: Some(format!("{id}:changed")),
                source: OperationSource::Gui,
                command: query.command.into(),
                args: query.args,
                context: context.clone(),
                output_mode: OutputMode::JsonLines,
                timeout_ms: Some(300_000),
                input: None,
            },
            Some(app),
            None,
            query.argument_input,
        )
        .await
        .map_err(|e| e.to_string())?;
    let changed = changed_paths(&diff, &facts);
    let c = context.clone();
    let f = facts.clone();
    let d = changed.clone();
    let fingerprints = tokio::task::spawn_blocking(move || fingerprints(&c, &f, &d))
        .await
        .map_err(|e| e.to_string())?;
    Ok((
        observed,
        Observation {
            facts,
            changed,
            identities,
            fingerprints,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn op(rows: Vec<serde_json::Value>) -> OperationResult {
        OperationResult {
            operation_id: "fixture".into(),
            exit_code: 0,
            duration_ms: 0,
            events: rows
                .into_iter()
                .map(|v| OperationEvent {
                    operation_id: "fixture".into(),
                    kind: EventKind::Stdout,
                    message: Some(v.to_string()),
                    timestamp: String::new(),
                    progress: None,
                })
                .collect(),
        }
    }
    fn row() -> serde_json::Value {
        serde_json::json!({"depotFile":"//fixture/a","clientFile":"C:/synthetic/a","action":"edit","change":"41","haveRev":"3","headRev":"3","type":"text"})
    }
    fn observation() -> Observation {
        Observation {
            facts: parser::file_facts(&op(vec![row()]).events),
            changed: BTreeSet::from(["//fixture/a".into()]),
            identities: BTreeMap::from([("//fixture/a".into(), "tester:3".into())]),
            fingerprints: BTreeMap::from([("//fixture/a".into(), "stable-digest-mtime".into())]),
        }
    }
    fn request() -> FileActionRequest {
        serde_json::from_value(serde_json::json!({"operationId":"11111111-1111-4111-8111-111111111111","action":"revertUnchanged","paths":["//fixture/a"],"changelistId":41})).unwrap()
    }
    #[test]
    fn all_retained_is_terminal_without_claiming_restored_content() {
        let a = observation();
        let b = observation();
        let r = result_with_retention(
            &request(),
            Ok(op(vec![])),
            Ok(op(vec![row()])),
            Some((&a, &b)),
        );
        assert_eq!(r.outcome, WorkflowOutcome::Succeeded);
        assert_eq!(r.files[0].state, WorkflowFileState::Retained);
        assert!(r.failure.is_none());
    }
    #[test]
    fn mixed_reverted_and_retained_are_both_known() {
        let a = observation();
        let b = observation();
        let mut q = request();
        q.paths.push("//fixture/b".into());
        let r = result_with_retention(
            &q,
            Ok(op(vec![])),
            Ok(op(vec![
                row(),
                serde_json::json!({"depotFile":"//fixture/b"}),
            ])),
            Some((&a, &b)),
        );
        assert_eq!(r.outcome, WorkflowOutcome::Succeeded);
        assert_eq!(r.files[0].state, WorkflowFileState::Retained);
        assert_eq!(r.files[1].state, WorkflowFileState::Succeeded);
    }
    #[test]
    fn still_open_ordinary_revert_and_failed_reads_do_not_prove_retention() {
        let a = observation();
        let b = observation();
        let mut q = request();
        q.action = FileAction::Revert;
        assert_eq!(
            result_with_retention(&q, Ok(op(vec![])), Ok(op(vec![row()])), Some((&a, &b))).outcome,
            WorkflowOutcome::Unknown
        );
        q.action = FileAction::RevertUnchanged;
        assert_eq!(
            result_with_retention(
                &q,
                Ok(op(vec![])),
                Err("read failed".into()),
                Some((&a, &b))
            )
            .outcome,
            WorkflowOutcome::Unknown
        );
        assert_eq!(
            result_with_retention(
                &q,
                Err("cancelled".into()),
                Ok(op(vec![row()])),
                Some((&a, &b))
            )
            .outcome,
            WorkflowOutcome::Unknown
        );
        assert_eq!(
            result(&q, Ok(op(vec![])), Ok(op(vec![row()]))).outcome,
            WorkflowOutcome::Unknown
        );
    }
    #[test]
    fn content_version_owner_and_changed_evidence_races_remain_unknown() {
        let a = observation();
        for kind in 0..5 {
            let mut b = observation();
            match kind {
                0 => {
                    b.fingerprints.clear();
                }
                1 => {
                    b.fingerprints
                        .insert("//fixture/a".into(), "changed".into());
                }
                2 => {
                    b.facts[0].change_id = Some(42);
                }
                3 => {
                    b.facts[0].have_revision = Some(4);
                }
                _ => {
                    b.changed.clear();
                }
            }
            assert!(!a.proves_retained(&b, "//fixture/a", Some(41)));
        }
        assert!(!a.proves_retained(&observation(), "//fixture/a", Some(42)));
    }
    #[test]
    fn only_structured_diff_not_same_missing_or_unrelated_paths_is_changed() {
        let f = observation().facts;
        for status in ["same", "missing", "unknown"] {
            assert!(changed_paths(
                &op(vec![
                    serde_json::json!({"depotFile":"//fixture/a","status":status})
                ]),
                &f
            )
            .is_empty());
        }
        assert!(changed_paths(
            &op(vec![
                serde_json::json!({"depotFile":"//fixture/other","status":"diff"})
            ]),
            &f
        )
        .is_empty());
        assert!(changed_paths(
            &op(vec![
                serde_json::json!({"depotFile":"//fixture/a","status":"diff"})
            ]),
            &f
        )
        .contains("//fixture/a"));
    }
    #[test]
    fn comparison_is_pinned_to_have_not_head_and_hashes_are_bounded() {
        let mut f = observation().facts;
        f[0].head_revision = Some(99);
        assert_eq!(comparison_paths(&f), vec!["//fixture/a#3"]);
        let root = std::env::temp_dir().join(format!("p4deck-retention-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("synthetic.txt");
        std::fs::write(&path, b"synthetic changed content").unwrap();
        f[0].client_path = Some(path.to_string_lossy().into());
        let c = P4Context {
            cwd: Some(root.to_string_lossy().into()),
            ..Default::default()
        };
        let changed = BTreeSet::from(["//fixture/a".into()]);
        let a = fingerprints(&c, &f, &changed);
        assert_eq!(a.len(), 1);
        std::fs::write(&path, b"different synthetic content").unwrap();
        assert_ne!(a, fingerprints(&c, &f, &changed));
        std::fs::File::create(&path)
            .unwrap()
            .set_len(16 * 1024 * 1024 + 1)
            .unwrap();
        assert!(fingerprints(&c, &f, &changed).is_empty());
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&root).unwrap();
    }
    #[test]
    fn absent_changed_or_foreign_open_identity_is_unknown() {
        let before = observation();
        let mut after = observation();
        after.identities.clear();
        assert!(!before.proves_retained(&after, "//fixture/a", Some(41)));
        after = observation();
        after
            .identities
            .insert("//fixture/a".into(), "other:3".into());
        assert!(!before.proves_retained(&after, "//fixture/a", Some(41)));
        assert!(identities(&op(vec![row()]), "tester").is_empty());
        let mut r = row();
        r["actionOwner"] = serde_json::json!("tester");
        r["workRev"] = serde_json::json!("3");
        assert_eq!(identities(&op(vec![r.clone()]), "tester").len(), 1);
        assert!(identities(&op(vec![r]), "other").is_empty());
    }
}
