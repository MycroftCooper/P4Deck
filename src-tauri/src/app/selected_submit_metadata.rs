//! Compatible metadata in the existing durable selected-operation record.
use super::*;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionMetadata {
    pub schema_version: u32,
    pub payload_digest: String,
    pub revision: String,
    pub execution_state: String,
    pub outcome: String,
    pub dispatch_state: String,
    pub recovery_required: bool,
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MoveLookupResult {
    Found { receipt: Box<MoveReceipt> },
    NotFound,
    StorageUnavailable,
    ScopeMismatch,
}
fn digest(r: &Record) -> Result<String, String> {
    // Normalize before reservation; full object equality remains the collision guard.
    let payload = (
        &r.request.connection,
        &r.request.custom_submit_executable_path,
        &r.request.description,
        &r.request.files,
        &r.move_target,
    );
    let bytes = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
fn next_metadata(
    r: &Record,
    previous: Option<&ExecutionMetadata>,
) -> Result<ExecutionMetadata, String> {
    let revision = previous
        .map(|m| m.revision.parse::<u64>())
        .transpose()
        .map_err(|_| "Invalid persisted receipt revision")?
        .unwrap_or(0)
        .checked_add(1)
        .ok_or("Receipt revision exhausted")?;
    let interrupted = r
        .receipt
        .execution
        .as_ref()
        .is_some_and(|m| m.execution_state == "interrupted");
    let possible = r.receipt.creation_dispatched
        || r.receipt
            .files
            .iter()
            .any(|f| matches!(f.state, FileState::Unknown | FileState::Moved))
        || previous.is_some_and(|m| m.dispatch_state == "possible");
    let unknown = r
        .receipt
        .files
        .iter()
        .any(|f| f.state == FileState::Unknown)
        || (r.receipt.creation_dispatched && r.receipt.new_change_id.is_none());
    let verified = matches!(
        r.receipt.stage,
        Stage::MoveCompleted | Stage::ReadyForSubmit | Stage::HandedOff
    );
    let partial = r
        .receipt
        .files
        .iter()
        .any(|f| matches!(f.state, FileState::Moved | FileState::AlreadyInTarget))
        && r.receipt
            .files
            .iter()
            .any(|f| matches!(f.state, FileState::NotMoved | FileState::Unknown));
    Ok(ExecutionMetadata {
        schema_version: 1,
        payload_digest: digest(r)?,
        revision: revision.to_string(),
        execution_state: if interrupted {
            "interrupted"
        } else if r.receipt.stage == Stage::InProgress {
            "running"
        } else {
            "settled"
        }
        .into(),
        outcome: if interrupted {
            "unknown"
        } else if verified {
            "verified"
        } else if partial {
            "partial"
        } else if unknown || possible {
            "unknown"
        } else {
            "notDispatched"
        }
        .into(),
        dispatch_state: if possible || interrupted {
            "possible"
        } else {
            "none"
        }
        .into(),
        recovery_required: interrupted || unknown || (!verified && possible),
    })
}
impl Host {
    pub(super) fn persist(&self, r: &mut Record, insert: bool) -> Result<(), String> {
        #[cfg(test)]
        {
            use std::sync::atomic::Ordering;
            let remaining = self.fail_write.load(Ordering::SeqCst);
            if remaining > 0 && self.fail_write.fetch_sub(1, Ordering::SeqCst) == 1 {
                return Err("Injected receipt storage failure".into());
            }
        }
        let db = self.db.lock();
        let old: Option<String> = db
            .query_row(
                "SELECT record FROM selected_submit WHERE id=?1",
                [&r.request.operation_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let old = old
            .map(|text| serde_json::from_str::<Record>(&text))
            .transpose()
            .map_err(|e| e.to_string())?;
        if let Some(old) = &old {
            if old.request != r.request || old.move_target != r.move_target {
                return Err("Operation ID payload conflict".into());
            }
        }
        let mut committed = r.clone();
        committed.receipt.execution = Some(next_metadata(
            r,
            old.as_ref().and_then(|r| r.receipt.execution.as_ref()),
        )?);
        let json = serde_json::to_string(&committed).map_err(|e| e.to_string())?;
        let sql = if insert {
            "INSERT INTO selected_submit(id,record) VALUES(?1,?2)"
        } else {
            "INSERT INTO selected_submit(id,record) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET record=excluded.record"
        };
        db.execute(sql, rusqlite::params![r.request.operation_id, json])
            .map_err(|e| e.to_string())?;
        // No new revision becomes observable in a response until SQLite commits.
        *r = committed;
        Ok(())
    }
    pub(super) fn recover_metadata(&self) -> Result<(), String> {
        let records: Vec<String> = {
            let db = self.db.lock();
            let mut statement = db
                .prepare("SELECT record FROM selected_submit")
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        for text in records {
            let mut r: Record = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            if r.receipt.stage != Stage::InProgress && r.receipt.execution.is_some() {
                continue;
            }
            let legacy = r.receipt.execution.is_none();
            if r.receipt.stage == Stage::InProgress || legacy {
                let mut metadata = next_metadata(&r, r.receipt.execution.as_ref())?;
                // Legacy terminal records keep existing stage/files but cannot invent dispatch evidence.
                metadata.execution_state = "interrupted".into();
                metadata.outcome = "unknown".into();
                metadata.dispatch_state = "possible".into();
                metadata.recovery_required = true;
                r.receipt.execution = Some(metadata);
                if r.receipt.stage == Stage::InProgress {
                    r.receipt.stage = Stage::Stopped;
                    r.receipt.can_continue = false;
                    r.receipt.message =
                        "Interrupted host operation; inspect receipt, never replay writes".into();
                }
            }
            self.save(&mut r)?;
        }
        Ok(())
    }
}
