//! Durable workflow result adapter; the existing WorkflowResult remains the
//! only per-file evidence. Reservation is not a promise of a successful write.
use super::*;
use crate::app::company_submit::ConnectionSnapshot;
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionReceipt {
    pub operation_id: String,
    pub kind: String,
    pub connection: ConnectionSnapshot,
    pub payload_digest: String,
    pub revision: String,
    pub state: String,
    pub result: Option<serde_json::Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionLookup {
    pub operation_id: String,
    pub connection: ConnectionSnapshot,
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LookupResult {
    Found { receipt: Box<ActionReceipt> },
    NotFound,
    ScopeMismatch,
    StorageUnavailable,
}
pub enum Reservation {
    New,
    Existing(Box<ActionReceipt>),
}
impl OperationJournal {
    pub(super) fn init_action_receipts(&self) -> Result<(), String> {
        self.connection.lock().execute_batch("CREATE TABLE IF NOT EXISTS action_receipts(id TEXT PRIMARY KEY,kind TEXT NOT NULL,scope TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,result TEXT);
        UPDATE action_receipts SET state='interrupted',revision=revision+1 WHERE state='running';").map_err(|e|e.to_string())
    }
    pub fn reserve_action(
        &self,
        kind: &str,
        id: &str,
        scope: &ConnectionSnapshot,
        payload: &serde_json::Value,
    ) -> Result<Reservation, String> {
        uuid::Uuid::parse_str(id).map_err(|_| "operationId must be a UUID")?;
        let payload = serde_json::to_string(payload).map_err(|e| e.to_string())?;
        if payload.len() > 4 * 1024 * 1024 {
            return Err("actionPayloadTooLarge".into());
        }
        let scope = serde_json::to_string(scope).map_err(|e| e.to_string())?;
        let digest = format!("{:x}", Sha256::digest(payload.as_bytes()));
        let db = self.connection.lock();
        let prior: Option<(String, String, String)> = db
            .query_row(
                "SELECT kind,scope,payload FROM action_receipts WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(old) = prior {
            if old != (kind.to_owned(), scope, payload) {
                return Err("operationIdPayloadConflict".into());
            }
            drop(db);
            return self
                .load_action(id)?
                .map(|receipt| Reservation::Existing(Box::new(receipt)))
                .ok_or("receiptUnavailable".into());
        }
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM action_receipts", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if count >= 100000 {
            return Err("actionReceiptCapacityReached".into());
        }
        db.execute("INSERT INTO action_receipts(id,kind,scope,payload,digest,revision,state) VALUES(?1,?2,?3,?4,?5,1,'running')",params![id,kind,scope,payload,digest]).map_err(|e|e.to_string())?;
        Ok(Reservation::New)
    }
    pub fn finish_action(&self, id: &str, result: &serde_json::Value) -> Result<(), String> {
        let result = serde_json::to_string(result).map_err(|e| e.to_string())?;
        if result.len() > 4 * 1024 * 1024 {
            return Err("actionResultTooLarge".into());
        }
        let changed=self.connection.lock().execute("UPDATE action_receipts SET result=?1,state='settled',revision=revision+1 WHERE id=?2 AND state='running'",params![result,id]).map_err(|e|e.to_string())?;
        if changed != 1 {
            return Err("actionReceiptNotRunning".into());
        }
        Ok(())
    }
    fn load_action(&self, id: &str) -> Result<Option<ActionReceipt>, String> {
        let raw: Option<(String, String, String, i64, String, Option<String>)> = self
            .connection
            .lock()
            .query_row(
                "SELECT kind,scope,digest,revision,state,result FROM action_receipts WHERE id=?1",
                [id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        raw.map(|(kind, scope, payload_digest, revision, state, result)| {
            Ok(ActionReceipt {
                operation_id: id.into(),
                kind,
                connection: serde_json::from_str(&scope).map_err(|e| e.to_string())?,
                payload_digest,
                revision: revision.to_string(),
                state,
                result: result
                    .map(|v| serde_json::from_str(&v))
                    .transpose()
                    .map_err(|e| e.to_string())?,
            })
        })
        .transpose()
    }
    pub fn action_lookup(&self, q: &ActionLookup) -> LookupResult {
        match self.load_action(&q.operation_id) {
            Err(_) => LookupResult::StorageUnavailable,
            Ok(None) => LookupResult::NotFound,
            Ok(Some(r)) if r.connection != q.connection => LookupResult::ScopeMismatch,
            Ok(Some(receipt)) => LookupResult::Found {
                receipt: Box::new(receipt),
            },
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn host() -> OperationJournal {
        let h = OperationJournal {
            connection: Mutex::new(Connection::open_in_memory().unwrap()),
            fence_active: Mutex::new(Default::default()),
            fence_events: Mutex::new(None),
        };
        h.init_action_receipts().unwrap();
        h
    }
    fn scope() -> ConnectionSnapshot {
        ConnectionSnapshot {
            profile_id: "fixture".into(),
            generation: "9007199254740993".into(),
            server: "fixture".into(),
            user: "u".into(),
            client: "c".into(),
        }
    }
    const ID: &str = "11111111-1111-4111-8111-111111111111";
    #[test]
    fn exact_duplicate_reuses_result_conflict_never_replaces() {
        let h = host();
        let p = serde_json::json!({"token":"synthetic","paths":["//fixture/a"]});
        assert!(matches!(
            h.reserve_action("shelf", ID, &scope(), &p).unwrap(),
            Reservation::New
        ));
        h.finish_action(ID, &serde_json::json!({"outcome":"unknown"}))
            .unwrap();
        let Reservation::Existing(r) = h.reserve_action("shelf", ID, &scope(), &p).unwrap() else {
            panic!("replayed")
        };
        assert_eq!(r.result.unwrap()["outcome"], "unknown");
        assert_eq!(r.revision, "2");
        assert!(h
            .reserve_action("shelf", ID, &scope(), &serde_json::json!({}))
            .is_err());
    }
    #[test]
    fn restart_and_storage_failure_never_authorize_reexecution() {
        let h = host();
        let p = serde_json::json!({});
        h.reserve_action("shelf", ID, &scope(), &p).unwrap();
        h.connection
            .lock()
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        assert!(h.finish_action(ID, &p).is_err());
        h.connection
            .lock()
            .execute_batch("PRAGMA query_only=OFF")
            .unwrap();
        h.init_action_receipts().unwrap();
        let Reservation::Existing(r) = h.reserve_action("shelf", ID, &scope(), &p).unwrap() else {
            panic!("replayed")
        };
        assert_eq!(r.state, "interrupted");
        assert!(r.result.is_none());
    }
    #[test]
    fn lookup_is_exact_scope_and_missing_is_not_storage_failure() {
        let h = host();
        let q = ActionLookup {
            operation_id: ID.into(),
            connection: scope(),
        };
        assert!(matches!(h.action_lookup(&q), LookupResult::NotFound));
        h.reserve_action("shelf", ID, &scope(), &serde_json::json!({}))
            .unwrap();
        let mut wrong = q;
        wrong.connection.generation = "2".into();
        assert!(matches!(
            h.action_lookup(&wrong),
            LookupResult::ScopeMismatch
        ));
        h.connection
            .lock()
            .execute_batch("DROP TABLE action_receipts")
            .unwrap();
        assert!(matches!(
            h.action_lookup(&wrong),
            LookupResult::StorageUnavailable
        ));
    }
    #[test]
    fn result_storage_failure_keeps_unknown_admission_and_never_replays() {
        let h = std::sync::Arc::new(host());
        h.init_fences().unwrap();
        let p = serde_json::json!({"target":"fixture"});
        h.reserve_action("shelf", ID, &scope(), &p).unwrap();
        let lease = h
            .begin_write(
                super::super::admission::FenceScope {
                    server: "fixture".into(),
                    user: "u".into(),
                    client: "c".into(),
                },
                ID,
            )
            .unwrap();
        h.connection
            .lock()
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        assert!(h
            .finish_action(ID, &serde_json::json!({"outcome":"succeeded"}))
            .is_err());
        h.connection
            .lock()
            .execute_batch("PRAGMA query_only=OFF")
            .unwrap();
        drop(lease);
        let fences = h.fences("fixture").unwrap();
        assert_eq!(fences.len(), 1);
        assert_eq!(fences[0].outcome, "unknown");
        assert!(!fences[0].active);
        assert!(matches!(
            h.reserve_action("shelf", ID, &scope(), &p).unwrap(),
            Reservation::Existing(_)
        ));
        // Unknown admission stays recorded for traceability but never blocks another write.
        assert!(h
            .begin_write(
                super::super::admission::FenceScope {
                    server: "fixture".into(),
                    user: "u".into(),
                    client: "c".into()
                },
                "another"
            )
            .is_ok());
    }
}
