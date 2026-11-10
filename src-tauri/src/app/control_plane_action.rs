//! S4J2: unified durable lifecycle for backup / diagnostics / log control-plane rows.
//!
//! Optimistic policy: these are local-file/config control-plane operations, so FE
//! optimistic projection may only show **intent/progress**. It must not render
//! "backup created" / "diagnostics exported" / "logs cleared" / "policy saved"
//! before the authoritative host result. Authoritative facts are post-write readback:
//! - backup create: backup file exists, size > 0 and equals the reported size, sha256 recorded;
//! - backup restore: rollback bundle exists + pending-restore manifest matches; restore is
//!   **staged only** (applies on next start) -> state `pending`, never committed here;
//! - diagnostics export: exported file exists, size > 0 and equals the reported size, sha256 recorded;
//! - log policy: readback policy equals the written policy and policy.json exists;
//! - log clear: readback log page is empty.
//!
//! Exit code/String return alone never proves success.
//!
//! Redaction boundary (unchanged, not widened): diagnostics export still comes from the
//! existing `DiagnosticService`, whose manifest omits passwords/tickets/stdin/raw args and
//! redacts paths. This module only records path/size/sha256 — never file content or secrets.
use crate::domain::LogPolicy;
use crate::persistence::backup::{
    ConfigBackupCreateResult, ConfigBackupRestoreResult, ConfigBackupRestoreStatus, RestoreState,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

pub const KIND_BACKUP_CREATE: &str = "backupCreate";
pub const KIND_BACKUP_RESTORE: &str = "backupRestore";
pub const KIND_DIAGNOSTICS_EXPORT: &str = "diagnosticsExport";
pub const KIND_LOG_POLICY_SET: &str = "logPolicySet";
pub const KIND_LOG_CLEAR: &str = "logClear";
pub const OPTIMISTIC_POLICY: &str = "intentOnly";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ControlPlaneArtifact {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    pub exists: bool,
    pub size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

impl ControlPlaneArtifact {
    pub fn missing() -> Self {
        Self {
            path: None,
            file_name: None,
            exists: false,
            size_bytes: 0,
            sha256: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlPlaneActionResult {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    /// intent | committed | pending | unknown | rejected | legacy
    pub state: String,
    pub outcome: crate::domain::WorkflowOutcome,
    pub artifact: ControlPlaneArtifact,
    pub details: serde_json::Value,
    pub optimistic: String,
    pub message: String,
    pub legacy: serde_json::Value,
}

pub fn file_facts(path: &Path) -> ControlPlaneArtifact {
    let Ok(metadata) = std::fs::metadata(path) else {
        return ControlPlaneArtifact::missing();
    };
    if !metadata.is_file() {
        return ControlPlaneArtifact::missing();
    }
    let Ok(bytes) = std::fs::read(path) else {
        return ControlPlaneArtifact {
            path: Some(crate::local_path::plain_path(path)),
            file_name: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned()),
            exists: true,
            size_bytes: metadata.len(),
            sha256: None,
        };
    };
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    ControlPlaneArtifact {
        path: Some(path.to_string_lossy().into_owned()),
        file_name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned()),
        exists: true,
        size_bytes: metadata.len(),
        sha256: Some(hex(&hasher.finalize())),
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02X}"));
    }
    out
}

fn value_of<T: Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or(serde_json::Value::Null)
}

fn state_outcome(state: &str, committed: bool) -> (String, crate::domain::WorkflowOutcome) {
    if committed {
        (
            "committed".into(),
            crate::domain::WorkflowOutcome::Succeeded,
        )
    } else {
        (state.into(), crate::domain::WorkflowOutcome::Unknown)
    }
}

pub fn project_backup_create(
    operation_id: Option<String>,
    legacy: &Result<ConfigBackupCreateResult, String>,
    artifact: ControlPlaneArtifact,
) -> ControlPlaneActionResult {
    match legacy {
        Ok(created) if operation_id.is_some() => {
            let expected_size = created.backup.size_bytes;
            let committed =
                artifact.exists && artifact.size_bytes > 0 && artifact.size_bytes == expected_size;
            let (state, outcome) =
                state_outcome(if committed { "committed" } else { "unknown" }, committed);
            ControlPlaneActionResult {
                kind: KIND_BACKUP_CREATE.into(),
                operation_id: operation_id.clone(),
                state,
                outcome,
                artifact,
                details: value_of(&created.backup),
                optimistic: OPTIMISTIC_POLICY.into(),
                message: if committed {
                    "Backup file verified by post-write readback (exists, size matches, sha256 recorded).".into()
                } else {
                    "Backup creation is unconfirmed; keep unknown, do not retry with a new id."
                        .into()
                },
                legacy: value_of(created),
            }
        }
        Ok(created) => legacy_result(KIND_BACKUP_CREATE, value_of(created)),
        Err(error) => failed(
            KIND_BACKUP_CREATE,
            operation_id,
            error,
            ControlPlaneArtifact::missing(),
        ),
    }
}

pub fn project_backup_restore(
    operation_id: Option<String>,
    legacy: &Result<ConfigBackupRestoreResult, String>,
    rollback: ControlPlaneArtifact,
    pending: Option<&ConfigBackupRestoreStatus>,
) -> ControlPlaneActionResult {
    match legacy {
        Ok(restored) if operation_id.is_some() => {
            let pending_matches = pending.is_some_and(|status| {
                status.state == RestoreState::Pending
                    && status.source_file_name == restored.source_file_name
                    && status.rollback_file_name.as_deref()
                        == Some(restored.rollback_file_name.as_str())
            });
            let staged = restored.restart_required
                && rollback.exists
                && rollback.size_bytes > 0
                && pending_matches;
            let (state, outcome) = state_outcome(if staged { "pending" } else { "unknown" }, false);
            ControlPlaneActionResult {
                kind: KIND_BACKUP_RESTORE.into(),
                operation_id: operation_id.clone(),
                state,
                outcome,
                artifact: rollback,
                details: serde_json::json!({
                    "sourceFileName": restored.source_file_name,
                    "rollbackFileName": restored.rollback_file_name,
                    "restartRequired": restored.restart_required,
                    "pendingStaged": staged,
                }),
                optimistic: OPTIMISTIC_POLICY.into(),
                message: if staged {
                    "Restore is staged and verified (rollback bundle + pending manifest); it applies only on the next start — not completed yet.".into()
                } else {
                    "Restore staging is unconfirmed; keep unknown and inspect pending/rollback state, never retry with a new id.".into()
                },
                legacy: value_of(restored),
            }
        }
        Ok(restored) => legacy_result(KIND_BACKUP_RESTORE, value_of(restored)),
        Err(error) => failed(KIND_BACKUP_RESTORE, operation_id, error, rollback),
    }
}

pub fn project_diagnostics_export(
    operation_id: Option<String>,
    legacy: &Result<crate::domain::DiagnosticExportResult, String>,
    artifact: ControlPlaneArtifact,
) -> ControlPlaneActionResult {
    match legacy {
        Ok(exported) if operation_id.is_some() => {
            let committed = artifact.exists
                && artifact.size_bytes > 0
                && artifact.size_bytes == exported.size_bytes;
            let (state, outcome) =
                state_outcome(if committed { "committed" } else { "unknown" }, committed);
            ControlPlaneActionResult {
                kind: KIND_DIAGNOSTICS_EXPORT.into(),
                operation_id: operation_id.clone(),
                state,
                outcome,
                artifact,
                details: serde_json::json!({
                    "format": exported.format,
                    "truncated": exported.truncated,
                    "sizeBytes": exported.size_bytes,
                    "redaction": "existing DiagnosticService redaction (passwords/tickets/stdin/raw args omitted; paths redacted)",
                }),
                optimistic: OPTIMISTIC_POLICY.into(),
                message: if committed {
                    "Diagnostics export verified by post-write readback (exists, size matches, sha256 recorded); redaction boundary unchanged.".into()
                } else {
                    "Diagnostics export is unconfirmed; keep unknown and never retry with a new id."
                        .into()
                },
                legacy: value_of(exported),
            }
        }
        Ok(exported) => legacy_result(KIND_DIAGNOSTICS_EXPORT, value_of(exported)),
        Err(error) => failed(KIND_DIAGNOSTICS_EXPORT, operation_id, error, artifact),
    }
}

pub fn project_log_policy_set(
    operation_id: Option<String>,
    legacy: &Result<LogPolicy, String>,
    readback: &LogPolicy,
    policy_file: ControlPlaneArtifact,
) -> ControlPlaneActionResult {
    match legacy {
        Ok(written) if operation_id.is_some() => {
            let committed = readback.auto_expand_warning == written.auto_expand_warning
                && readback.auto_expand_error == written.auto_expand_error
                && readback.retention_days == written.retention_days
                && readback.max_mib == written.max_mib
                && policy_file.exists
                && policy_file.size_bytes > 0;
            let (state, outcome) =
                state_outcome(if committed { "committed" } else { "unknown" }, committed);
            ControlPlaneActionResult {
                kind: KIND_LOG_POLICY_SET.into(),
                operation_id: operation_id.clone(),
                state,
                outcome,
                artifact: policy_file,
                details: value_of(written),
                optimistic: OPTIMISTIC_POLICY.into(),
                message: if committed {
                    "Log policy verified by readback and persisted policy.json.".into()
                } else {
                    "Log policy write is unconfirmed; keep unknown, do not retry with a new id."
                        .into()
                },
                legacy: value_of(written),
            }
        }
        Ok(written) => legacy_result(KIND_LOG_POLICY_SET, value_of(written)),
        Err(error) => failed(KIND_LOG_POLICY_SET, operation_id, error, policy_file),
    }
}

pub fn project_log_clear(
    operation_id: Option<String>,
    legacy: &Result<(), String>,
    remaining_entries: usize,
) -> ControlPlaneActionResult {
    match legacy {
        Ok(()) if operation_id.is_some() => {
            let committed = remaining_entries == 0;
            let (state, outcome) =
                state_outcome(if committed { "committed" } else { "unknown" }, committed);
            ControlPlaneActionResult {
                kind: KIND_LOG_CLEAR.into(),
                operation_id: operation_id.clone(),
                state,
                outcome,
                artifact: ControlPlaneArtifact::missing(),
                details: serde_json::json!({ "remainingEntries": remaining_entries }),
                optimistic: OPTIMISTIC_POLICY.into(),
                message: if committed {
                    "Log clear verified by post-write readback (no remaining entries).".into()
                } else {
                    "Log clear is unconfirmed; entries remain or readback failed — keep unknown, never retry with a new id.".into()
                },
                legacy: serde_json::json!("ok"),
            }
        }
        Ok(()) => legacy_result(KIND_LOG_CLEAR, serde_json::json!("ok")),
        Err(error) => failed(
            KIND_LOG_CLEAR,
            operation_id,
            error,
            ControlPlaneArtifact::missing(),
        ),
    }
}

fn legacy_result(kind: &str, legacy: serde_json::Value) -> ControlPlaneActionResult {
    ControlPlaneActionResult {
        kind: kind.into(),
        operation_id: None,
        state: "legacy".into(),
        outcome: crate::domain::WorkflowOutcome::Unknown,
        artifact: ControlPlaneArtifact::missing(),
        details: serde_json::Value::Null,
        optimistic: OPTIMISTIC_POLICY.into(),
        message:
            "Legacy call (no operationId): old path result preserved, no receipt/facts projection."
                .into(),
        legacy,
    }
}

pub fn failed(
    kind: &str,
    operation_id: Option<String>,
    error: &str,
    artifact: ControlPlaneArtifact,
) -> ControlPlaneActionResult {
    ControlPlaneActionResult {
        kind: kind.into(),
        operation_id,
        state: "unknown".into(),
        outcome: crate::domain::WorkflowOutcome::Unknown,
        artifact,
        details: serde_json::json!({ "error": error }),
        optimistic: OPTIMISTIC_POLICY.into(),
        message: format!("Control-plane operation failed before authoritative readback: {error}"),
        legacy: serde_json::Value::Null,
    }
}

// ---- request wrappers (operationId additive; legacy calls omit it) ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupCreateActionRequest {
    #[serde(flatten)]
    pub request: crate::persistence::backup::ConfigBackupCreateRequest,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRestoreActionRequest {
    #[serde(flatten)]
    pub request: crate::persistence::backup::ConfigBackupRestoreRequest,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsExportActionRequest {
    #[serde(flatten)]
    pub request: crate::domain::DiagnosticExportRequest,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetLogPolicyActionRequest {
    pub policy: LogPolicy,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearLogsActionRequest {
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::WorkflowOutcome;
    use crate::persistence::backup::{
        BackupKind, ConfigBackupRestoreResult, ConfigBackupRestoreStatus, ConfigBackupSummary,
    };

    fn artifact(exists: bool, size: u64) -> ControlPlaneArtifact {
        ControlPlaneArtifact {
            path: Some("C:/fixture/out".into()),
            file_name: Some("out".into()),
            exists,
            size_bytes: size,
            sha256: Some("ABCD".into()),
        }
    }

    fn created(size: u64) -> ConfigBackupCreateResult {
        ConfigBackupCreateResult {
            backup: ConfigBackupSummary {
                file_name: "p4deck-config-manual-fixture.json".into(),
                created_at: "now".into(),
                size_bytes: size,
                kind: BackupKind::Manual,
                includes_connection: false,
                includes_window_placement: false,
                local_storage_keys: vec![],
            },
            omitted_local_storage_keys: vec![],
        }
    }

    fn restored() -> ConfigBackupRestoreResult {
        ConfigBackupRestoreResult {
            source_file_name: "src.json".into(),
            rollback_file_name: "rollback.json".into(),
            local_storage: vec![],
            restart_required: true,
        }
    }

    #[test]
    fn backup_create_requires_existing_matching_file() {
        let id = Some("11111111-1111-4111-8111-111111111111".to_owned());
        let ok = project_backup_create(id.clone(), &Ok(created(128)), artifact(true, 128));
        assert_eq!(ok.state, "committed");
        assert_eq!(ok.outcome, WorkflowOutcome::Succeeded);
        assert_eq!(ok.optimistic, "intentOnly");
        assert!(ok.artifact.sha256.is_some());

        let missing = project_backup_create(id.clone(), &Ok(created(128)), artifact(false, 0));
        assert_eq!(missing.state, "unknown");
        let mismatch = project_backup_create(id, &Ok(created(128)), artifact(true, 64));
        assert_eq!(mismatch.state, "unknown");
    }

    #[test]
    fn backup_restore_is_staged_pending_not_committed() {
        let id = Some("11111111-1111-4111-8111-111111111111".to_owned());
        let pending = ConfigBackupRestoreStatus {
            state: RestoreState::Pending,
            source_file_name: "src.json".into(),
            rollback_file_name: Some("rollback.json".into()),
            completed_at: None,
            message: None,
        };
        let staged = project_backup_restore(
            id.clone(),
            &Ok(restored()),
            artifact(true, 32),
            Some(&pending),
        );
        assert_eq!(staged.state, "pending");
        assert_eq!(staged.outcome, WorkflowOutcome::Unknown);
        let missing_rollback =
            project_backup_restore(id, &Ok(restored()), artifact(false, 0), Some(&pending));
        assert_eq!(missing_rollback.state, "unknown");
    }

    #[test]
    fn diagnostics_export_requires_matching_file_size() {
        let id = Some("11111111-1111-4111-8111-111111111111".to_owned());
        let result = crate::domain::DiagnosticExportResult {
            path: "C:/fixture/diag.json".into(),
            size_bytes: 1024,
            truncated: false,
            format: "json".into(),
        };
        let ok = project_diagnostics_export(id.clone(), &Ok(result.clone()), artifact(true, 1024));
        assert_eq!(ok.state, "committed");
        assert!(ok.details["redaction"]
            .as_str()
            .unwrap()
            .contains("DiagnosticService"));
        let bad = project_diagnostics_export(id, &Ok(result), artifact(true, 512));
        assert_eq!(bad.state, "unknown");
    }

    #[test]
    fn log_policy_requires_readback_and_file() {
        let id = Some("11111111-1111-4111-8111-111111111111".to_owned());
        let policy = LogPolicy {
            auto_expand_warning: true,
            auto_expand_error: true,
            retention_days: 7,
            max_mib: 8,
        };
        let ok =
            project_log_policy_set(id.clone(), &Ok(policy.clone()), &policy, artifact(true, 64));
        assert_eq!(ok.state, "committed");
        let mut other = policy.clone();
        other.retention_days = 30;
        let mismatch = project_log_policy_set(id, &Ok(policy), &other, artifact(true, 64));
        assert_eq!(mismatch.state, "unknown");
    }

    #[test]
    fn log_clear_requires_empty_readback_and_legacy_keeps_state() {
        let id = Some("11111111-1111-4111-8111-111111111111".to_owned());
        let ok = project_log_clear(id.clone(), &Ok(()), 0);
        assert_eq!(ok.state, "committed");
        let remaining = project_log_clear(id, &Ok(()), 3);
        assert_eq!(remaining.state, "unknown");
        let legacy = project_log_clear(None, &Ok(()), 0);
        assert_eq!(legacy.state, "legacy");
    }
}
