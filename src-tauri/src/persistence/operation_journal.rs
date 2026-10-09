use crate::domain::OperationSource;
use chrono::Utc;
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    path::Path,
};

const HARD_MAX_ENTRIES: usize = 2_000;
const MAX_PAGE_SIZE: usize = 100;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationCategory {
    Query,
    FileMutation,
    ChangelistMutation,
    Submit,
    Authentication,
    LocalFile,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JournalState {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Interrupted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationFailureKind {
    Offline,
    ServerUnreachable,
    AuthExpired,
    PermissionDenied,
    CommandFailure,
    Cancelled,
    Interrupted,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRecord {
    pub operation_id: String,
    pub connection_id: String,
    pub workspace: String,
    pub source: OperationSource,
    pub category: OperationCategory,
    pub state: JournalState,
    pub failure: Option<OperationFailureKind>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub log_reference: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationJournalQuery {
    pub connection_id: Option<String>,
    pub state: Option<JournalState>,
    pub category: Option<OperationCategory>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub keyword: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationJournalPage {
    pub records: Vec<OperationRecord>,
    pub next_cursor: Option<String>,
}

pub struct OperationJournal {
    connection: Mutex<Connection>,
}

impl OperationJournal {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let connection = Connection::open(path).map_err(|e| e.to_string())?;
        connection.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS operation_journal (
              operation_id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, workspace TEXT NOT NULL,
              source TEXT NOT NULL, category TEXT NOT NULL, state TEXT NOT NULL, failure TEXT,
              started_at TEXT NOT NULL, finished_at TEXT, log_reference TEXT
            );
            CREATE INDEX IF NOT EXISTS operation_journal_order ON operation_journal(started_at DESC, operation_id DESC);
            UPDATE operation_journal SET state='interrupted', failure='interrupted', finished_at=datetime('now') WHERE state IN ('queued','running');")
            .map_err(|e| e.to_string())?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn start(
        &self,
        operation_id: &str,
        connection_id: &str,
        workspace: &str,
        source: OperationSource,
        category: OperationCategory,
    ) -> Result<(), String> {
        let safe_workspace = sanitize(workspace, 128);
        self.connection.lock().execute(
            "INSERT OR REPLACE INTO operation_journal(operation_id,connection_id,workspace,source,category,state,started_at) VALUES(?1,?2,?3,?4,?5,'running',?6)",
            params![sanitize(operation_id, 128), sanitize(connection_id, 32), safe_workspace, source_name(source), category_name(category), Utc::now().to_rfc3339()]
        ).map_err(|e| e.to_string())?;
        self.prune();
        Ok(())
    }

    pub fn finish(
        &self,
        operation_id: &str,
        state: JournalState,
        failure: Option<OperationFailureKind>,
    ) -> Result<(), String> {
        self.connection.lock().execute(
            "UPDATE operation_journal SET state=?2,failure=?3,finished_at=?4,log_reference=?1 WHERE operation_id=?1",
            params![operation_id, state_name(state), failure.map(failure_name), Utc::now().to_rfc3339()]
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get(&self, operation_id: &str) -> Option<OperationRecord> {
        self.connection.lock().query_row(
            "SELECT operation_id,connection_id,workspace,source,category,state,failure,started_at,finished_at,log_reference FROM operation_journal WHERE operation_id=?1",
            [operation_id], row_record
        ).ok()
    }

    pub fn query(&self, query: &OperationJournalQuery) -> Result<OperationJournalPage, String> {
        let limit = query.limit.unwrap_or(50).clamp(1, MAX_PAGE_SIZE);
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT operation_id,connection_id,workspace,source,category,state,failure,started_at,finished_at,log_reference
             FROM operation_journal
             WHERE (?1 IS NULL OR connection_id=?1)
               AND (?2 IS NULL OR state=?2)
               AND (?3 IS NULL OR category=?3)
               AND (?4 IS NULL OR started_at>=?4)
               AND (?5 IS NULL OR started_at<=?5)
               AND (?6 IS NULL OR instr(lower(operation_id || ' ' || workspace || ' ' || category || ' ' || state || ' ' || coalesce(failure,'')), lower(?6)) > 0)
               AND (?7 IS NULL OR (started_at || '|' || operation_id) < ?7)
             ORDER BY started_at DESC, operation_id DESC LIMIT ?8"
        ).map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(
                params![
                    query.connection_id,
                    query.state.map(state_name),
                    query.category.map(category_name),
                    query.from,
                    query.to,
                    query
                        .keyword
                        .as_deref()
                        .map(str::trim)
                        .filter(|v| !v.is_empty()),
                    query.cursor,
                    limit + 1
                ],
                row_record,
            )
            .map_err(|e| e.to_string())?;
        let mut records = rows.filter_map(Result::ok).collect::<Vec<_>>();
        let has_more = records.len() > limit;
        records.truncate(limit);
        let next_cursor = has_more
            .then(|| {
                records
                    .last()
                    .map(|r| format!("{}|{}", r.started_at, r.operation_id))
            })
            .flatten();
        Ok(OperationJournalPage {
            records,
            next_cursor,
        })
    }

    fn prune(&self) {
        let _ = self.connection.lock().execute(
            "DELETE FROM operation_journal WHERE operation_id IN (SELECT operation_id FROM operation_journal ORDER BY started_at DESC, operation_id DESC LIMIT -1 OFFSET ?1)",
            [HARD_MAX_ENTRIES as i64],
        );
    }
}

pub fn connection_id(server: &str, user: &str, client: &str) -> String {
    let mut hasher = DefaultHasher::new();
    server.to_ascii_lowercase().hash(&mut hasher);
    user.hash(&mut hasher);
    client.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn sanitize(value: &str, max: usize) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect()
}
fn source_name(v: OperationSource) -> &'static str {
    match v {
        OperationSource::Gui => "gui",
        OperationSource::Terminal => "terminal",
    }
}
fn category_name(v: OperationCategory) -> &'static str {
    match v {
        OperationCategory::Query => "query",
        OperationCategory::FileMutation => "fileMutation",
        OperationCategory::ChangelistMutation => "changelistMutation",
        OperationCategory::Submit => "submit",
        OperationCategory::Authentication => "authentication",
        OperationCategory::LocalFile => "localFile",
    }
}
fn state_name(v: JournalState) -> &'static str {
    match v {
        JournalState::Queued => "queued",
        JournalState::Running => "running",
        JournalState::Succeeded => "succeeded",
        JournalState::Failed => "failed",
        JournalState::Cancelled => "cancelled",
        JournalState::Interrupted => "interrupted",
    }
}
fn failure_name(v: OperationFailureKind) -> &'static str {
    match v {
        OperationFailureKind::Offline => "offline",
        OperationFailureKind::ServerUnreachable => "serverUnreachable",
        OperationFailureKind::AuthExpired => "authExpired",
        OperationFailureKind::PermissionDenied => "permissionDenied",
        OperationFailureKind::CommandFailure => "commandFailure",
        OperationFailureKind::Cancelled => "cancelled",
        OperationFailureKind::Interrupted => "interrupted",
    }
}
fn row_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<OperationRecord> {
    Ok(OperationRecord {
        operation_id: row.get(0)?,
        connection_id: row.get(1)?,
        workspace: row.get(2)?,
        source: if row.get::<_, String>(3)? == "terminal" {
            OperationSource::Terminal
        } else {
            OperationSource::Gui
        },
        category: match row.get::<_, String>(4)?.as_str() {
            "fileMutation" => OperationCategory::FileMutation,
            "changelistMutation" => OperationCategory::ChangelistMutation,
            "submit" => OperationCategory::Submit,
            "authentication" => OperationCategory::Authentication,
            "localFile" => OperationCategory::LocalFile,
            _ => OperationCategory::Query,
        },
        state: match row.get::<_, String>(5)?.as_str() {
            "queued" => JournalState::Queued,
            "running" => JournalState::Running,
            "succeeded" => JournalState::Succeeded,
            "cancelled" => JournalState::Cancelled,
            "interrupted" => JournalState::Interrupted,
            _ => JournalState::Failed,
        },
        failure: row
            .get::<_, Option<String>>(6)?
            .as_deref()
            .map(|v| match v {
                "offline" => OperationFailureKind::Offline,
                "serverUnreachable" => OperationFailureKind::ServerUnreachable,
                "authExpired" => OperationFailureKind::AuthExpired,
                "permissionDenied" => OperationFailureKind::PermissionDenied,
                "cancelled" => OperationFailureKind::Cancelled,
                "interrupted" => OperationFailureKind::Interrupted,
                _ => OperationFailureKind::CommandFailure,
            }),
        started_at: row.get(7)?,
        finished_at: row.get(8)?,
        log_reference: row.get(9)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("p4deck-journal-{}.sqlite", uuid::Uuid::new_v4()))
    }
    #[test]
    fn recovers_interrupted_without_replay_payload_and_paginates() {
        let path = path();
        {
            let journal = OperationJournal::open(&path).unwrap();
            journal
                .start(
                    "op-secret",
                    "conn-a",
                    "workspace",
                    OperationSource::Gui,
                    OperationCategory::FileMutation,
                )
                .unwrap();
        }
        let journal = OperationJournal::open(&path).unwrap();
        let recovered = journal.get("op-secret").unwrap();
        assert_eq!(recovered.state, JournalState::Interrupted);
        assert_eq!(recovered.failure, Some(OperationFailureKind::Interrupted));
        let schema = std::fs::read(&path).unwrap();
        assert!(!String::from_utf8_lossy(&schema).contains("password-value"));
        for i in 0..5 {
            journal
                .start(
                    &format!("op-{i}"),
                    if i % 2 == 0 { "a" } else { "b" },
                    "ws",
                    OperationSource::Gui,
                    OperationCategory::Query,
                )
                .unwrap();
            journal
                .finish(&format!("op-{i}"), JournalState::Succeeded, None)
                .unwrap();
        }
        let first = journal
            .query(&OperationJournalQuery {
                connection_id: None,
                cursor: None,
                limit: Some(2),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(first.records.len(), 2);
        assert!(first.next_cursor.is_some());
        let second = journal
            .query(&OperationJournalQuery {
                connection_id: None,
                cursor: first.next_cursor,
                limit: Some(2),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(second.records.len(), 2);
        drop(journal);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn isolates_connections_and_never_stores_sensitive_inputs() {
        let path = path();
        let journal = OperationJournal::open(&path).unwrap();
        let id = connection_id("ssl:server", "user", "client");
        journal
            .start(
                "safe-id",
                &id,
                "client",
                OperationSource::Terminal,
                OperationCategory::Authentication,
            )
            .unwrap();
        journal
            .finish(
                "safe-id",
                JournalState::Failed,
                Some(OperationFailureKind::AuthExpired),
            )
            .unwrap();
        let page = journal
            .query(&OperationJournalQuery {
                connection_id: Some(id),
                cursor: None,
                limit: Some(500),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.records.len(), 1);
        assert_eq!(
            page.records[0].failure,
            Some(OperationFailureKind::AuthExpired)
        );
        assert_eq!(page.records[0].log_reference.as_deref(), Some("safe-id"));
        let filtered = journal
            .query(&OperationJournalQuery {
                state: Some(JournalState::Failed),
                category: Some(OperationCategory::Authentication),
                keyword: Some("SAFE-ID".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(filtered.records.len(), 1);
        assert!(journal
            .query(&OperationJournalQuery {
                state: Some(JournalState::Succeeded),
                ..Default::default()
            })
            .unwrap()
            .records
            .is_empty());
        assert!(journal
            .query(&OperationJournalQuery {
                from: Some("2999-01-01T00:00:00Z".into()),
                ..Default::default()
            })
            .unwrap()
            .records
            .is_empty());
        assert!(journal
            .query(&OperationJournalQuery {
                keyword: Some("%".into()),
                ..Default::default()
            })
            .unwrap()
            .records
            .is_empty());
        let bytes = std::fs::read(&path).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains("stdin"));
        assert!(!text.contains("ticket contents"));
        assert!(!text.contains("password"));
        drop(journal);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn enforces_capacity_and_structured_terminal_states() {
        let path = path();
        let journal = OperationJournal::open(&path).unwrap();
        for index in 0..(HARD_MAX_ENTRIES + 5) {
            let id = format!("capacity-{index:04}");
            journal
                .start(
                    &id,
                    "connection",
                    "workspace",
                    OperationSource::Gui,
                    OperationCategory::Query,
                )
                .unwrap();
            journal
                .finish(
                    &id,
                    JournalState::Cancelled,
                    Some(OperationFailureKind::Cancelled),
                )
                .unwrap();
        }
        let count: i64 = journal
            .connection
            .lock()
            .query_row("SELECT COUNT(*) FROM operation_journal", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, HARD_MAX_ENTRIES as i64);
        assert_eq!(
            journal.get("capacity-2004").unwrap().state,
            JournalState::Cancelled
        );
        drop(journal);
        std::fs::remove_file(path).unwrap();
    }
}
