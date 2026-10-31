//! S4F: unified durable lifecycle for pending changelist create/edit/delete.
//!
//! Optimistic policy (user-confirmed boundary): a pending CL create/edit/delete is a
//! server-side, content-irreversible transaction, so FE optimistic projection may only
//! show **intent/progress** (in-flight / duplicate submission disabled). It MUST NOT
//! render "CL created" / "CL deleted" (or an edit applied) before the authoritative host
//! result arrives.
//!
//! Temporary-CL → real-CL mapping rule: FE placeholders (draft rows / optimistic entries)
//! may only carry the operationId. A real changelist number comes exclusively from this
//! host result (`createdChangeId` / `changes[].changeId`, derived from the post-mutation
//! `p4 changes` readback or the `Change N created.` command output). The client must never
//! generate or guess CL numbers; edit/delete always reference an existing authoritative id.
//!
//! Admission/lease: the IPC command keeps `_admission` and is invoked after admission; the
//! changelist service performs the write through the normal runner. This module adds the
//! durable receipt + per-CL facts projection on top of that existing write path.
use crate::domain::*;
use serde::{Deserialize, Serialize};

pub const KIND_PENDING_CL_CREATE: &str = "pendingClCreate";
pub const KIND_PENDING_CL_EDIT: &str = "pendingClEdit";
pub const KIND_PENDING_CL_DELETE: &str = "pendingClDelete";
pub const OPTIMISTIC_POLICY: &str = "intentOnly";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingClFact {
    pub change_id: i64,
    pub description: String,
    pub file_count: usize,
    pub jobs: Vec<String>,
    /// true when the CL is present in the authoritative post-mutation readback.
    pub present: bool,
}

/// Authoritative temporary/placeholder → real CL mapping. Only host results may
/// populate `authoritative_change_id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingClMapping {
    pub placeholder: String,
    pub authoritative_change_id: Option<i64>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingClActionResult {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    /// intent | committed | unknown | rejected | legacy
    pub state: String,
    pub outcome: WorkflowOutcome,
    pub changes: Vec<PendingClFact>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_change_id: Option<i64>,
    pub mapping: PendingClMapping,
    pub optimistic: String,
    pub message: String,
    pub legacy: serde_json::Value,
}

pub fn kind_for(mutation: &PendingChangeMutation) -> &'static str {
    match mutation {
        PendingChangeMutation::Create { .. } => KIND_PENDING_CL_CREATE,
        PendingChangeMutation::Edit { .. } => KIND_PENDING_CL_EDIT,
        PendingChangeMutation::Delete { .. } => KIND_PENDING_CL_DELETE,
        PendingChangeMutation::MoveFiles { .. } => KIND_PENDING_CL_DELETE,
    }
}

fn value_of<T: Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or(serde_json::Value::Null)
}

fn fact_of(change: &PendingChange, present: bool) -> PendingClFact {
    PendingClFact {
        change_id: change.id,
        description: change.description.clone(),
        file_count: change.files.len(),
        jobs: change.jobs.clone(),
        present,
    }
}

fn requested_existing_id(mutation: &PendingChangeMutation) -> Option<i64> {
    match mutation {
        PendingChangeMutation::Edit { change_id, .. }
        | PendingChangeMutation::Delete { change_id, .. } => Some(*change_id),
        _ => None,
    }
}

fn mapping_for(
    operation_id: Option<&str>,
    mutation: &PendingChangeMutation,
    created: Option<i64>,
) -> PendingClMapping {
    let placeholder = operation_id.unwrap_or("legacy").to_owned();
    match mutation {
        PendingChangeMutation::Create { .. } => PendingClMapping {
            placeholder,
            authoritative_change_id: created,
            source: "host-post-create-readback".into(),
        },
        PendingChangeMutation::Edit { change_id, .. } => PendingClMapping {
            placeholder,
            authoritative_change_id: Some(*change_id),
            source: "existing-authoritative-id".into(),
        },
        PendingChangeMutation::Delete { change_id, .. } => PendingClMapping {
            placeholder,
            authoritative_change_id: Some(*change_id),
            source: "existing-authoritative-id".into(),
        },
        PendingChangeMutation::MoveFiles { .. } => PendingClMapping {
            placeholder,
            authoritative_change_id: None,
            source: "unsupported".into(),
        },
    }
}

fn clean_operation(result: &OperationResult) -> bool {
    crate::app::revert_action::clean(result)
}

/// Project the legacy mutation result into authoritative per-CL facts.
///
/// Rules (never exitCode/affectedPaths alone):
/// - create: clean write + no refresh error + `created_change_id` present + the post-write
///   readback contains that id with the requested description.
/// - edit: clean write + no refresh error + readback contains the id with the requested
///   description (stale description = unknown).
/// - delete: clean write + no refresh error + the id was affected and is absent from the
///   post-write readback (still present = unknown).
pub fn project(
    mutation: &PendingChangeMutation,
    operation_id: Option<String>,
    legacy: &PendingChangeMutationResult,
) -> PendingClActionResult {
    let kind = kind_for(mutation);
    let write_clean = clean_operation(&legacy.operation);
    let refresh_ok = legacy.refresh_error.is_none();
    let fact_source = if operation_id.is_some() {
        &legacy.refreshed_changes
    } else {
        &Vec::new()
    };
    let changes: Vec<PendingClFact> = fact_source
        .iter()
        .map(|change| fact_of(change, true))
        .collect();
    let mut created = legacy.created_change_id.filter(|id| *id > 0);
    let mut committed = false;
    if operation_id.is_some() && write_clean && refresh_ok {
        match mutation {
            PendingChangeMutation::Create { description, .. } => {
                if let Some(id) = created {
                    if let Some(change) = legacy.refreshed_changes.iter().find(|c| c.id == id) {
                        if change.description.trim() == description.trim() {
                            committed = true;
                        }
                    }
                }
            }
            PendingChangeMutation::Edit {
                change_id,
                description,
                ..
            } => {
                if let Some(change) = legacy.refreshed_changes.iter().find(|c| c.id == *change_id) {
                    if change.description.trim() == description.trim() {
                        committed = true;
                    }
                }
            }
            PendingChangeMutation::Delete { change_id } => {
                let affected = legacy.affected_changes.contains(change_id);
                let still_present = legacy.refreshed_changes.iter().any(|c| c.id == *change_id);
                committed = affected && !still_present;
            }
            PendingChangeMutation::MoveFiles { .. } => {}
        }
    }
    if !committed
        && matches!(mutation, PendingChangeMutation::Create { .. })
        && operation_id.is_some()
    {
        // created id may exist but not be provable (readback miss/mismatch) — keep it only
        // as a candidate; the state stays unknown and FE must not present it as created.
        created = created.filter(|_| false);
    }
    let outcome = if operation_id.is_none() {
        if write_clean {
            WorkflowOutcome::Succeeded
        } else {
            WorkflowOutcome::Unknown
        }
    } else if committed {
        WorkflowOutcome::Succeeded
    } else {
        WorkflowOutcome::Unknown
    };
    let state = if operation_id.is_none() {
        "legacy"
    } else if committed {
        "committed"
    } else {
        "unknown"
    };
    let message = match mutation {
        PendingChangeMutation::Create { .. } if committed => {
            "Pending changelist creation confirmed by authoritative post-write readback."
        }
        PendingChangeMutation::Edit { .. } if committed => {
            "Pending changelist edit confirmed by authoritative post-write readback."
        }
        PendingChangeMutation::Delete { .. } if committed => {
            "Pending changelist deletion confirmed by authoritative post-write readback."
        }
        _ => "Changelist effect is unconfirmed; keep unknown, do not show success and never retry with a new id.",
    };
    PendingClActionResult {
        kind: kind.into(),
        operation_id: operation_id.clone(),
        state: state.into(),
        outcome,
        changes,
        created_change_id: created,
        mapping: mapping_for(operation_id.as_deref(), mutation, created),
        optimistic: OPTIMISTIC_POLICY.into(),
        message: message.into(),
        legacy: value_of(legacy),
    }
}

/// Failure shape persisted when a durable operation errors (unknown, never "not applied").
pub fn failed_result(
    mutation: &PendingChangeMutation,
    operation_id: &str,
    error: &str,
) -> PendingClActionResult {
    PendingClActionResult {
        kind: kind_for(mutation).into(),
        operation_id: Some(operation_id.into()),
        state: "unknown".into(),
        outcome: WorkflowOutcome::Unknown,
        changes: Vec::new(),
        created_change_id: None,
        mapping: PendingClMapping {
            placeholder: operation_id.into(),
            authoritative_change_id: requested_existing_id(mutation),
            source: "request-existing-id".into(),
        },
        optimistic: OPTIMISTIC_POLICY.into(),
        message: format!(
            "Changelist mutation failed before an authoritative result could be proven: {error}"
        ),
        legacy: serde_json::Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(id: i64, description: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "description": description,
            "user": "fixture",
            "client": "fixture-client",
            "status": "pending",
            "jobs": [],
            "files": [],
            "shelvedFiles": []
        })
    }

    fn result(
        exit_code: i32,
        created: Option<i64>,
        affected: Vec<i64>,
        refreshed: Vec<serde_json::Value>,
        refresh_error: Option<&str>,
    ) -> PendingChangeMutationResult {
        serde_json::from_value(serde_json::json!({
            "operation": {"operationId": "fixture", "exitCode": exit_code, "events": [], "durationMs": 1},
            "createdChangeId": created,
            "affectedChanges": affected,
            "affectedPaths": [],
            "refreshedChanges": refreshed,
            "refreshError": refresh_error
        }))
        .unwrap()
    }

    fn create(description: &str) -> PendingChangeMutation {
        PendingChangeMutation::Create {
            description: description.into(),
            jobs: vec![],
        }
    }

    fn edit(change_id: i64, description: &str) -> PendingChangeMutation {
        PendingChangeMutation::Edit {
            change_id,
            description: description.into(),
            jobs: vec![],
        }
    }

    fn delete(change_id: i64) -> PendingChangeMutation {
        PendingChangeMutation::Delete { change_id }
    }

    #[test]
    fn create_requires_authoritative_id_and_matching_description() {
        let id = Some("11111111-1111-4111-8111-111111111111".to_owned());
        let both = result(0, Some(41), vec![41], vec![change(41, "new cl")], None);
        let ok = project(&create("new cl"), id.clone(), &both);
        assert_eq!(ok.outcome, WorkflowOutcome::Succeeded);
        assert_eq!(ok.created_change_id, Some(41));
        assert_eq!(ok.mapping.authoritative_change_id, Some(41));
        assert_eq!(ok.optimistic, "intentOnly");

        let missing = project(
            &create("new cl"),
            id.clone(),
            &result(0, None, vec![], vec![], None),
        );
        assert_eq!(missing.outcome, WorkflowOutcome::Unknown);
        assert_eq!(missing.created_change_id, None);

        let mismatch = project(
            &create("expected"),
            id.clone(),
            &result(0, Some(41), vec![41], vec![change(41, "other")], None),
        );
        assert_eq!(mismatch.outcome, WorkflowOutcome::Unknown);

        let refresh_failed = project(
            &create("new cl"),
            id,
            &result(
                0,
                Some(41),
                vec![41],
                vec![change(41, "new cl")],
                Some("query failed"),
            ),
        );
        assert_eq!(refresh_failed.outcome, WorkflowOutcome::Unknown);
    }

    #[test]
    fn edit_requires_post_write_description_match() {
        let id = Some("11111111-1111-4111-8111-111111111111".to_owned());
        let ok = project(
            &edit(7, "edited"),
            id.clone(),
            &result(0, None, vec![7], vec![change(7, "edited")], None),
        );
        assert_eq!(ok.outcome, WorkflowOutcome::Succeeded);
        let stale = project(
            &edit(7, "edited"),
            id.clone(),
            &result(0, None, vec![7], vec![change(7, "old")], None),
        );
        assert_eq!(stale.outcome, WorkflowOutcome::Unknown);
        let non_clean = project(
            &edit(7, "edited"),
            id,
            &result(1, None, vec![7], vec![change(7, "edited")], None),
        );
        assert_eq!(non_clean.outcome, WorkflowOutcome::Unknown);
    }

    #[test]
    fn delete_requires_absence_from_post_write_readback() {
        let id = Some("11111111-1111-4111-8111-111111111111".to_owned());
        let ok = project(
            &delete(7),
            id.clone(),
            &result(0, None, vec![7], vec![], None),
        );
        assert_eq!(ok.outcome, WorkflowOutcome::Succeeded);
        assert!(ok.changes.is_empty());
        let still_present = project(
            &delete(7),
            id.clone(),
            &result(0, None, vec![7], vec![change(7, "still")], None),
        );
        assert_eq!(still_present.outcome, WorkflowOutcome::Unknown);
        let not_affected = project(&delete(7), id, &result(0, None, vec![], vec![], None));
        assert_eq!(not_affected.outcome, WorkflowOutcome::Unknown);
    }

    #[test]
    fn legacy_call_keeps_old_result_without_receipt_semantics() {
        let legacy = project(
            &create("new cl"),
            None,
            &result(0, Some(41), vec![41], vec![change(41, "new cl")], None),
        );
        assert_eq!(legacy.state, "legacy");
        assert_eq!(legacy.outcome, WorkflowOutcome::Succeeded);
        assert!(legacy.changes.is_empty());
        assert_eq!(legacy.mapping.placeholder, "legacy");
    }

    #[test]
    fn failure_shape_is_unknown() {
        let failed = failed_result(
            &delete(7),
            "11111111-1111-4111-8111-111111111111",
            "timeout",
        );
        assert_eq!(failed.state, "unknown");
        assert_eq!(failed.outcome, WorkflowOutcome::Unknown);
        assert_eq!(failed.optimistic, "intentOnly");
    }
}
