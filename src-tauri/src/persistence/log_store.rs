use crate::domain::{LogEntry, LogLevel, LogPage, LogPolicy, LogQuery, OperationSource};
use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use std::{collections::VecDeque, path::Path};

const HARD_MAX_ENTRIES: usize = 10_000;
const HARD_MAX_RETENTION_DAYS: u32 = 30;
const HARD_MAX_MIB: u32 = 50;
const MAX_PAGE_SIZE: usize = 500;

pub struct LogStore {
    connection: Mutex<Connection>,
    memory: Mutex<VecDeque<LogEntry>>,
    policy: Mutex<LogPolicy>,
}

impl LogStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let connection = Connection::open(path).map_err(|e| e.to_string())?;
        connection.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY,timestamp TEXT NOT NULL,level TEXT NOT NULL,operation_id TEXT NOT NULL,source TEXT NOT NULL,server TEXT NOT NULL DEFAULT '',workspace TEXT NOT NULL,command TEXT NOT NULL,message TEXT NOT NULL,duration_ms INTEGER,repeat_count INTEGER NOT NULL DEFAULT 1); CREATE INDEX IF NOT EXISTS logs_time ON logs(timestamp DESC,id DESC); CREATE TABLE IF NOT EXISTS log_policy(id INTEGER PRIMARY KEY CHECK(id=1),auto_warning INTEGER NOT NULL,auto_error INTEGER NOT NULL,retention_days INTEGER NOT NULL,max_mib INTEGER NOT NULL);").map_err(|e|e.to_string())?;
        let _ = connection.execute(
            "ALTER TABLE logs ADD COLUMN server TEXT NOT NULL DEFAULT ''",
            [],
        );
        let policy = connection
            .query_row(
                "SELECT auto_warning,auto_error,retention_days,max_mib FROM log_policy WHERE id=1",
                [],
                |r| {
                    Ok(LogPolicy {
                        auto_expand_warning: r.get::<_, i64>(0)? != 0,
                        auto_expand_error: r.get::<_, i64>(1)? != 0,
                        retention_days: r.get(2)?,
                        max_mib: r.get(3)?,
                    })
                },
            )
            .unwrap_or_else(|_| default_policy());
        let memory = {
            let mut statement=connection.prepare("SELECT id,timestamp,level,operation_id,source,server,workspace,command,message,duration_ms,repeat_count FROM logs ORDER BY timestamp DESC,id DESC LIMIT 10000").map_err(|e|e.to_string())?;
            let rows = statement
                .query_map([], row_entry)
                .map_err(|e| e.to_string())?;
            rows.filter_map(Result::ok).collect()
        };
        Ok(Self {
            connection: Mutex::new(connection),
            memory: Mutex::new(memory),
            policy: Mutex::new(policy),
        })
    }

    pub fn push(&self, mut entry: LogEntry) -> Result<(), String> {
        entry.command = sanitize(&entry.command, 512);
        entry.message = sanitize(&entry.message, 4096);
        entry.server = sanitize(&entry.server, 256);
        entry.workspace = sanitize(&entry.workspace, 128);
        let mut memory = self.memory.lock();
        if let Some(previous) = memory.front_mut() {
            if previous.level == entry.level
                && previous.message == entry.message
                && previous.command == entry.command
                && previous.server == entry.server
                && previous.workspace == entry.workspace
                && within_dedupe_window(&previous.timestamp, &entry.timestamp)
            {
                previous.repeat_count += 1;
                previous.timestamp = entry.timestamp.clone();
                entry = previous.clone();
            } else {
                memory.push_front(entry.clone());
            }
        } else {
            memory.push_front(entry.clone());
        }
        memory.truncate(HARD_MAX_ENTRIES);
        drop(memory);
        self.connection.lock().execute("INSERT INTO logs(id,timestamp,level,operation_id,source,server,workspace,command,message,duration_ms,repeat_count) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(id) DO UPDATE SET timestamp=excluded.timestamp,repeat_count=excluded.repeat_count",params![entry.id,entry.timestamp,level_name(&entry.level),entry.operation_id,source_name(&entry.source),entry.server,entry.workspace,entry.command,entry.message,entry.duration_ms,entry.repeat_count]).map_err(|e|e.to_string())?;
        self.prune();
        Ok(())
    }

    pub fn query(&self, query: &LogQuery) -> Vec<LogEntry> {
        self.query_page(query).entries
    }

    pub fn query_page(&self, query: &LogQuery) -> LogPage {
        let keyword = query.keyword.as_deref().unwrap_or("").to_lowercase();
        let limit = query.limit.unwrap_or(100).clamp(1, MAX_PAGE_SIZE);
        let mut entries = self
            .memory
            .lock()
            .iter()
            .filter(|entry| {
                query
                    .levels
                    .as_ref()
                    .map(|v| v.contains(&entry.level))
                    .unwrap_or(true)
                    && query
                        .server
                        .as_ref()
                        .map(|v| v == &entry.server)
                        .unwrap_or(true)
                    && query
                        .workspace
                        .as_ref()
                        .map(|v| v == &entry.workspace)
                        .unwrap_or(true)
                    && query
                        .command
                        .as_ref()
                        .map(|v| entry.command.contains(v))
                        .unwrap_or(true)
                    && query
                        .operation_id
                        .as_ref()
                        .map(|v| v == &entry.operation_id)
                        .unwrap_or(true)
                    && query
                        .cursor
                        .as_ref()
                        .map(|v| format!("{}|{}", entry.timestamp, entry.id) < *v)
                        .unwrap_or(true)
                    && (keyword.is_empty()
                        || format!("{} {}", entry.command, entry.message)
                            .to_lowercase()
                            .contains(&keyword))
            })
            .take(limit + 1)
            .cloned()
            .collect::<Vec<_>>();
        let more = entries.len() > limit;
        entries.truncate(limit);
        let next_cursor = more
            .then(|| entries.last().map(|e| format!("{}|{}", e.timestamp, e.id)))
            .flatten();
        LogPage {
            entries,
            next_cursor,
        }
    }

    pub fn policy(&self) -> LogPolicy {
        self.policy.lock().clone()
    }
    pub fn set_policy(&self, mut policy: LogPolicy) -> Result<LogPolicy, String> {
        policy.retention_days = policy.retention_days.clamp(1, HARD_MAX_RETENTION_DAYS);
        policy.max_mib = policy.max_mib.clamp(5, HARD_MAX_MIB);
        self.connection.lock().execute("INSERT OR REPLACE INTO log_policy(id,auto_warning,auto_error,retention_days,max_mib) VALUES(1,?1,?2,?3,?4)",params![policy.auto_expand_warning as i64,policy.auto_expand_error as i64,policy.retention_days,policy.max_mib]).map_err(|e|e.to_string())?;
        *self.policy.lock() = policy.clone();
        self.prune();
        Ok(policy)
    }

    fn prune(&self) {
        let policy = self.policy();
        let cutoff = Utc::now() - chrono::Duration::days(policy.retention_days as i64);
        self.memory.lock().retain(|entry| {
            DateTime::parse_from_rfc3339(&entry.timestamp)
                .map(|timestamp| timestamp.with_timezone(&Utc) >= cutoff)
                .unwrap_or(false)
        });
        let connection = self.connection.lock();
        let modifier = format!("-{} days", policy.retention_days);
        let _ = connection.execute(
            "DELETE FROM logs WHERE datetime(timestamp) < datetime('now',?1)",
            [modifier],
        );
        let _=connection.execute("DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY timestamp DESC,id DESC LIMIT -1 OFFSET ?1)",[HARD_MAX_ENTRIES as i64]);
        let page_count: i64 = connection
            .query_row("PRAGMA page_count", [], |r| r.get(0))
            .unwrap_or(0);
        let page_size: i64 = connection
            .query_row("PRAGMA page_size", [], |r| r.get(0))
            .unwrap_or(4096);
        if page_count * page_size > (policy.max_mib as i64) * 1024 * 1024 {
            let _=connection.execute("DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY timestamp ASC LIMIT 1000)",[]);
        }
    }
}

fn default_policy() -> LogPolicy {
    LogPolicy {
        auto_expand_warning: true,
        auto_expand_error: true,
        retention_days: 14,
        max_mib: 50,
    }
}
fn sanitize(value: &str, max: usize) -> String {
    value
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(max)
        .collect()
}
fn level_name(v: &LogLevel) -> &'static str {
    match v {
        LogLevel::Info => "info",
        LogLevel::Warning => "warning",
        LogLevel::Error => "error",
    }
}
fn source_name(v: &OperationSource) -> &'static str {
    match v {
        OperationSource::Gui => "gui",
        OperationSource::Terminal => "terminal",
    }
}
fn parse_level(v: &str) -> LogLevel {
    match v {
        "error" => LogLevel::Error,
        "warning" => LogLevel::Warning,
        _ => LogLevel::Info,
    }
}
fn parse_source(v: &str) -> OperationSource {
    if v == "terminal" {
        OperationSource::Terminal
    } else {
        OperationSource::Gui
    }
}
fn row_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<LogEntry> {
    Ok(LogEntry {
        id: row.get(0)?,
        timestamp: row.get(1)?,
        level: parse_level(&row.get::<_, String>(2)?),
        operation_id: row.get(3)?,
        source: parse_source(&row.get::<_, String>(4)?),
        server: row.get(5)?,
        workspace: row.get(6)?,
        command: row.get(7)?,
        message: row.get(8)?,
        duration_ms: row.get(9)?,
        repeat_count: row.get(10)?,
    })
}
fn within_dedupe_window(previous: &str, next: &str) -> bool {
    let Ok(previous) = DateTime::parse_from_rfc3339(previous) else {
        return false;
    };
    let Ok(next) = DateTime::parse_from_rfc3339(next) else {
        return false;
    };
    (next.with_timezone(&Utc) - previous.with_timezone(&Utc))
        .num_seconds()
        .abs()
        <= 10
}

#[cfg(test)]
mod tests {
    use super::*;
    fn path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("p4deck-logs-{}.sqlite", uuid::Uuid::new_v4()))
    }
    fn entry(id: &str, level: LogLevel, server: &str) -> LogEntry {
        LogEntry {
            id: id.into(),
            timestamp: Utc::now().to_rfc3339(),
            level,
            operation_id: id.into(),
            source: OperationSource::Gui,
            server: server.into(),
            workspace: "ws".into(),
            command: "p4 info".into(),
            message: "safe message".into(),
            duration_ms: Some(1),
            repeat_count: 1,
        }
    }
    #[test]
    fn pages_filters_deduplicates_and_clamps_policy() {
        let path = path();
        let store = LogStore::open(&path).unwrap();
        store.push(entry("1", LogLevel::Warning, "a")).unwrap();
        let mut duplicate = entry("2", LogLevel::Warning, "a");
        duplicate.message = "safe message".into();
        store.push(duplicate).unwrap();
        let mut third = entry("3", LogLevel::Error, "b");
        third.message = "different".into();
        store.push(third).unwrap();
        assert_eq!(
            store
                .query_page(&LogQuery {
                    server: Some("a".into()),
                    limit: Some(1),
                    ..Default::default()
                })
                .entries[0]
                .repeat_count,
            2
        );
        let first = store.query_page(&LogQuery {
            limit: Some(1),
            ..Default::default()
        });
        assert!(first.next_cursor.is_some());
        assert_eq!(
            store
                .query_page(&LogQuery {
                    cursor: first.next_cursor,
                    limit: Some(1),
                    ..Default::default()
                })
                .entries
                .len(),
            1
        );
        let mut old = entry("old", LogLevel::Info, "a");
        old.message = "old".into();
        old.timestamp = (Utc::now() - chrono::Duration::days(5)).to_rfc3339();
        store.push(old).unwrap();
        let applied = store
            .set_policy(LogPolicy {
                auto_expand_warning: false,
                auto_expand_error: true,
                retention_days: 1,
                max_mib: 999,
            })
            .unwrap();
        assert_eq!(applied.retention_days, 1);
        assert_eq!(applied.max_mib, HARD_MAX_MIB);
        assert!(!store
            .query(&LogQuery::default())
            .iter()
            .any(|entry| entry.id == "old"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn enforces_the_persistent_entry_hard_limit() {
        let path = path();
        let store = LogStore::open(&path).unwrap();
        {
            let mut connection = store.connection.lock();
            let transaction = connection.transaction().unwrap();
            for index in 0..(HARD_MAX_ENTRIES + 5) {
                transaction.execute("INSERT INTO logs(id,timestamp,level,operation_id,source,server,workspace,command,message,repeat_count) VALUES(?1,?2,'info',?1,'gui','server','workspace','p4 info','safe',1)",params![format!("bulk-{index:05}"),Utc::now().to_rfc3339()]).unwrap();
            }
            transaction.commit().unwrap();
        }
        store.prune();
        let count: i64 = store
            .connection
            .lock()
            .query_row("SELECT COUNT(*) FROM logs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, HARD_MAX_ENTRIES as i64);
        std::fs::remove_file(path).unwrap();
    }
}
