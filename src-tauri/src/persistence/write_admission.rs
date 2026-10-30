//! Durable unknown admission facts in the existing journal database, separate
//! from prunable diagnostic rows. Never replays an operation.
use super::*;
use rusqlite::OptionalExtension;
#[cfg(test)]
use std::collections::HashSet;
use std::sync::Arc;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FenceScope {
    pub server: String,
    pub user: String,
    pub client: String,
}
impl From<&crate::domain::P4Context> for FenceScope {
    fn from(c: &crate::domain::P4Context) -> Self {
        Self {
            server: c.server.clone(),
            user: c.user.clone(),
            client: c.client.clone(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fence {
    pub fence_id: String,
    pub operation_id: String,
    pub scope: FenceScope,
    pub revision: String,
    pub active: bool,
    pub outcome: String,
    pub released: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseRequest {
    pub fence_id: String,
    pub revision: String,
    pub scope: FenceScope,
    pub acknowledge_unknown: bool,
}
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReleaseResult {
    Released,
    NotFound,
    Stale,
    Active,
    ScopeMismatch,
    AcknowledgementRequired,
    StorageUnavailable,
}

pub struct WriteLease {
    journal: Arc<OperationJournal>,
    id: String,
    runtime_active: std::sync::atomic::AtomicBool,
}
impl WriteLease {
    /// Test-only helper: keeps the lease observable as a running process so a dropped
    /// lease stays active instead of being treated as a completed observation.
    #[cfg(test)]
    pub fn runtime_started(&self) {
        self.runtime_active
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
    pub fn finish(&self, verified: bool) -> Result<(), String> {
        self.journal.connection.lock().execute(
            "UPDATE action_fences SET outcome=?1,revision=revision+1 WHERE id=?2 AND outcome='running'",
            params![if verified {"verified"} else {"unknown"}, self.id]).map_err(|e|e.to_string())?;
        self.journal.notify_fence(&self.id);
        Ok(())
    }
}
impl Drop for WriteLease {
    fn drop(&mut self) {
        // If completion persistence fails the durable running row still blocks.
        let _ = self.finish(false);
        if !self
            .runtime_active
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            self.journal.fence_active.lock().remove(&self.id);
            let _ = self.journal.connection.lock().execute(
                "UPDATE action_fences SET revision=revision+1 WHERE id=?1",
                [&self.id],
            );
            self.journal.notify_fence(&self.id);
        }
    }
}
impl OperationJournal {
    pub fn attach_events(&self, app: tauri::AppHandle) {
        *self.fence_events.lock() = Some(app);
    }
    fn notify_fence(&self, id: &str) {
        let revision: Result<i64, _> = self.connection.lock().query_row(
            "SELECT revision FROM action_fences WHERE id=?1",
            [id],
            |r| r.get(0),
        );
        if let (Ok(revision), Some(app)) = (revision, self.fence_events.lock().as_ref()) {
            use tauri::Emitter;
            let _ = app.emit(
                "action-admission-changed",
                serde_json::json!({"fenceId":id,"revision":revision.to_string()}),
            );
        }
    }
    pub(super) fn init_fences(&self) -> Result<(), String> {
        self.connection.lock().execute_batch("CREATE TABLE IF NOT EXISTS action_fences(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,server TEXT NOT NULL,user_name TEXT NOT NULL,client TEXT NOT NULL,revision INTEGER NOT NULL,outcome TEXT NOT NULL,released_at TEXT);
            UPDATE action_fences SET outcome='unknown',revision=revision+1 WHERE outcome='running';")
            .map_err(|e|e.to_string())
    }
    pub fn begin_write(
        self: &Arc<Self>,
        scope: FenceScope,
        operation_id: &str,
    ) -> Result<WriteLease, String> {
        let db = self.connection.lock();
        db.execute("DELETE FROM action_fences WHERE outcome='verified' AND rowid NOT IN (SELECT rowid FROM action_fences ORDER BY rowid DESC LIMIT 2000)", []).map_err(|e|e.to_string())?;
        let retained: i64 = db
            .query_row("SELECT COUNT(*) FROM action_fences", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if retained >= 10000 {
            return Err("admissionEvidenceCapacityReached".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        db.execute("INSERT INTO action_fences(id,operation_id,server,user_name,client,revision,outcome) VALUES(?1,?2,?3,?4,?5,1,'running')",params![id,operation_id,scope.server,scope.user,scope.client]).map_err(|e|e.to_string())?;
        self.fence_active.lock().insert(id.clone());
        drop(db);
        self.notify_fence(&id);
        Ok(WriteLease {
            journal: self.clone(),
            id,
            runtime_active: std::sync::atomic::AtomicBool::new(false),
        })
    }
    pub fn fences(&self, server: &str) -> Result<Vec<Fence>, String> {
        let db = self.connection.lock();
        let active = self.fence_active.lock();
        let mut statement=db.prepare("SELECT id,operation_id,server,user_name,client,revision,outcome,released_at IS NOT NULL FROM action_fences WHERE server=?1 AND outcome IN ('running','unknown') AND released_at IS NULL ORDER BY rowid LIMIT 1001").map_err(|e|e.to_string())?;
        let rows = statement
            .query_map([server], |r| {
                let id: String = r.get(0)?;
                Ok(Fence {
                    active: active.contains(&id),
                    fence_id: id,
                    operation_id: r.get(1)?,
                    scope: FenceScope {
                        server: r.get(2)?,
                        user: r.get(3)?,
                        client: r.get(4)?,
                    },
                    revision: r.get::<_, i64>(5)?.to_string(),
                    outcome: r.get(6)?,
                    released: r.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let result = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        if result.len() > 1000 {
            return Err("admissionSummaryLimitExceeded".into());
        }
        Ok(result)
    }
    pub fn release_fence(&self, q: &ReleaseRequest) -> ReleaseResult {
        if !q.acknowledge_unknown {
            return ReleaseResult::AcknowledgementRequired;
        }
        self.release_inner(q)
            .unwrap_or(ReleaseResult::StorageUnavailable)
    }
    fn release_inner(&self, q: &ReleaseRequest) -> Result<ReleaseResult, String> {
        let db = self.connection.lock();
        let row:Option<(String,String,String,i64,String,bool)>=db.query_row("SELECT server,user_name,client,revision,outcome,released_at IS NOT NULL FROM action_fences WHERE id=?1",[&q.fence_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(|e|e.to_string())?;
        let Some((server, user, client, rev, outcome, released)) = row else {
            return Ok(ReleaseResult::NotFound);
        };
        if (server, user, client)
            != (
                q.scope.server.clone(),
                q.scope.user.clone(),
                q.scope.client.clone(),
            )
        {
            return Ok(ReleaseResult::ScopeMismatch);
        }
        if self.fence_active.lock().contains(&q.fence_id) {
            return Ok(ReleaseResult::Active);
        }
        if released || rev.to_string() != q.revision || outcome != "unknown" {
            return Ok(ReleaseResult::Stale);
        }
        db.execute(
            "UPDATE action_fences SET released_at=?1,revision=revision+1 WHERE id=?2",
            params![Utc::now().to_rfc3339(), q.fence_id],
        )
        .map_err(|e| e.to_string())?;
        drop(db);
        self.notify_fence(&q.fence_id);
        // Unknown outcome retained. This grants no success, rollback or replay.
        Ok(ReleaseResult::Released)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn host() -> Arc<OperationJournal> {
        let h = OperationJournal {
            connection: Mutex::new(Connection::open_in_memory().unwrap()),
            fence_active: Mutex::new(HashSet::new()),
            fence_events: Mutex::new(None),
        };
        h.init_fences().unwrap();
        Arc::new(h)
    }
    fn scope() -> FenceScope {
        FenceScope {
            server: "fixture:1666".into(),
            user: "user".into(),
            client: "client".into(),
        }
    }
    #[test]
    fn fences_are_recorded_but_never_block_new_writes() {
        let h = host();
        let lease = h.begin_write(scope(), "a").unwrap();
        let f = h.fences(&scope().server).unwrap().remove(0);
        let mut q = ReleaseRequest {
            fence_id: f.fence_id,
            revision: f.revision,
            scope: scope(),
            acknowledge_unknown: true,
        };
        assert_eq!(h.release_fence(&q), ReleaseResult::Active);
        assert!(h.begin_write(scope(), "b").is_ok());
        drop(lease);
        assert_eq!(h.release_fence(&q), ReleaseResult::Stale);
        q.revision = h.fences(&scope().server).unwrap()[0].revision.clone();
        assert_eq!(h.release_fence(&q), ReleaseResult::Released);
        let next = h.begin_write(scope(), "b").unwrap();
        assert_eq!(h.release_fence(&q), ReleaseResult::Stale);
        assert!(h.begin_write(scope(), "c").is_ok());
        drop(next);
    }
    #[test]
    fn unknown_survives_restart_and_requires_exact_scope() {
        let h = host();
        let lease = h.begin_write(scope(), "a").unwrap();
        drop(lease);
        h.init_fences().unwrap();
        let f = h.fences(&scope().server).unwrap().remove(0);
        assert_eq!(f.outcome, "unknown");
        let q = ReleaseRequest {
            fence_id: f.fence_id,
            revision: f.revision,
            scope: FenceScope {
                client: "other".into(),
                ..scope()
            },
            acknowledge_unknown: true,
        };
        assert_eq!(h.release_fence(&q), ReleaseResult::ScopeMismatch);
        assert!(h.begin_write(scope(), "b").is_ok());
    }
    #[test]
    fn verified_completion_unblocks_but_unknown_history_is_preserved() {
        let h = host();
        let lease = h.begin_write(scope(), "a").unwrap();
        lease.finish(true).unwrap();
        drop(lease);
        assert!(h.fences(&scope().server).unwrap().is_empty());
        let lease = h.begin_write(scope(), "b").unwrap();
        drop(lease);
        let f = h.fences(&scope().server).unwrap().remove(0);
        let q = ReleaseRequest {
            fence_id: f.fence_id.clone(),
            revision: f.revision,
            scope: scope(),
            acknowledge_unknown: true,
        };
        assert_eq!(h.release_fence(&q), ReleaseResult::Released);
        let outcome: String = h
            .connection
            .lock()
            .query_row(
                "SELECT outcome FROM action_fences WHERE id=?1",
                [f.fence_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(outcome, "unknown");
    }
    #[test]
    fn dropped_unobserved_process_stays_active_and_cannot_be_released() {
        let h = host();
        let lease = h.begin_write(scope(), "process").unwrap();
        lease.runtime_started();
        drop(lease);
        let f = h.fences(&scope().server).unwrap().remove(0);
        assert!(f.active);
        assert_eq!(
            h.release_fence(&ReleaseRequest {
                fence_id: f.fence_id,
                revision: f.revision,
                scope: scope(),
                acknowledge_unknown: true
            }),
            ReleaseResult::Active
        );
    }
    #[test]
    fn storage_failure_cannot_report_release_or_clear_unknown() {
        let h = host();
        drop(h.begin_write(scope(), "op").unwrap());
        let f = h.fences(&scope().server).unwrap().remove(0);
        h.connection
            .lock()
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        assert_eq!(
            h.release_fence(&ReleaseRequest {
                fence_id: f.fence_id,
                revision: f.revision,
                scope: scope(),
                acknowledge_unknown: true
            }),
            ReleaseResult::StorageUnavailable
        );
        assert_eq!(h.fences(&scope().server).unwrap().len(), 1);
    }
}
