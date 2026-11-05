//! CL07: create/move only. Existing submit UI must explicitly claim continuation.
use super::company_submit::ConnectionSnapshot;
#[path = "selected_submit_metadata.rs"]
mod metadata;
use crate::domain::*;
pub use metadata::{ExecutionMetadata, MoveLookupResult};
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectedFile {
    pub depot_path: String,
    pub source_change_id: i64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub operation_id: String,
    pub connection: ConnectionSnapshot,
    pub custom_submit_executable_path: String,
    pub description: String,
    pub files: Vec<SelectedFile>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lookup {
    pub operation_id: String,
    pub connection: ConnectionSnapshot,
    pub custom_submit_executable_path: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileState {
    Moved,
    AlreadyInTarget,
    NotMoved,
    Unknown,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileResult {
    pub depot_path: String,
    pub source_change_id: i64,
    pub state: FileState,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    InProgress,
    Stopped,
    ReadyForSubmit,
    HandedOff,
    MoveCompleted,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<ExecutionMetadata>,
    pub operation_id: String,
    pub new_change_id: Option<i64>,
    #[serde(default)]
    pub creation_dispatched: bool,
    pub stage: Stage,
    pub files: Vec<FileResult>,
    pub can_continue: bool,
    pub message: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Record {
    request: Request,
    #[serde(default)]
    move_target: Option<MoveTarget>,
    receipt: Receipt,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum MoveTarget {
    Existing {
        #[serde(rename = "changeId")]
        change_id: i64,
    },
    New {
        description: String,
    },
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveRequest {
    pub operation_id: String,
    pub connection: ConnectionSnapshot,
    pub files: Vec<SelectedFile>,
    pub target: MoveTarget,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveLookup {
    pub operation_id: String,
    pub connection: ConnectionSnapshot,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveReceipt {
    pub execution: Option<ExecutionMetadata>,
    pub operation_id: String,
    pub target_change_id: Option<i64>,
    pub target_creation_unknown: bool,
    pub stage: &'static str,
    pub files: Vec<FileResult>,
    pub message: String,
}
impl From<Receipt> for MoveReceipt {
    fn from(r: Receipt) -> Self {
        Self {
            execution: r.execution,
            operation_id: r.operation_id,
            target_change_id: r.new_change_id,
            target_creation_unknown: r.creation_dispatched && r.new_change_id.is_none(),
            stage: match r.stage {
                Stage::MoveCompleted => "completed",
                Stage::InProgress => "inProgress",
                _ => "stopped",
            },
            files: r.files,
            message: r.message,
        }
    }
}
pub struct Host {
    db: Mutex<Connection>,
    gate: tokio::sync::Mutex<()>,
    #[cfg(test)]
    fail_write: std::sync::atomic::AtomicUsize,
}
impl Host {
    pub fn open(path: &std::path::Path) -> Result<Self, String> {
        Self::from_db(Connection::open(path).map_err(|e| e.to_string())?)
    }
    fn from_db(db: Connection) -> Result<Self, String> {
        db.execute_batch("CREATE TABLE IF NOT EXISTS selected_submit (id TEXT PRIMARY KEY, record TEXT NOT NULL);").map_err(|e|e.to_string())?;
        let host = Self {
            db: Mutex::new(db),
            gate: tokio::sync::Mutex::new(()),
            #[cfg(test)]
            fail_write: std::sync::atomic::AtomicUsize::new(0),
        };
        host.recover_metadata()?;
        Ok(host)
    }
    fn load(&self, id: &str) -> Result<Option<Record>, String> {
        let text: Option<String> = self
            .db
            .lock()
            .query_row(
                "SELECT record FROM selected_submit WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        text.map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
            .transpose()
    }
    fn save(&self, r: &mut Record) -> Result<(), String> {
        self.persist(r, false)
    }
    pub fn move_lookup(&self, q: &MoveLookup) -> MoveLookupResult {
        match self.load(&q.operation_id) {
            Err(_) => MoveLookupResult::StorageUnavailable,
            Ok(None) => MoveLookupResult::NotFound,
            Ok(Some(r)) if r.move_target.is_none() || r.request.connection != q.connection => {
                MoveLookupResult::ScopeMismatch
            }
            Ok(Some(r)) => MoveLookupResult::Found {
                receipt: Box::new(r.receipt.into()),
            },
        }
    }
    pub fn status(&self, q: &Lookup) -> Result<Option<Receipt>, String> {
        let Some(r) = self.load(&q.operation_id)? else {
            return Ok(None);
        };
        if r.request.connection != q.connection {
            return Err("Connection identity mismatch".into());
        }
        Ok(Some(restart_truth(r.receipt)))
    }
    pub async fn move_files(
        &self,
        q: MoveRequest,
        configured_tool: String,
        b: &impl Backend,
    ) -> Result<MoveReceipt, String> {
        let description = match &q.target {
            MoveTarget::Existing { change_id } => {
                if !(0..=9_007_199_254_740_991).contains(change_id) {
                    return Err("Invalid target CL".into());
                }
                "Move selected opened files".into()
            }
            MoveTarget::New { description } => description.clone(),
        };
        let r = Request {
            operation_id: q.operation_id,
            connection: q.connection,
            custom_submit_executable_path: configured_tool,
            description,
            files: q.files,
        };
        self.prepare_kind(r, Some(q.target), b)
            .await
            .map(Into::into)
    }

    pub fn move_status(&self, q: &MoveLookup) -> Result<Option<MoveReceipt>, String> {
        let Some(r) = self.load(&q.operation_id)? else {
            return Ok(None);
        };
        if r.move_target.is_none() || r.request.connection != q.connection {
            return Err("Move operation/connection identity mismatch".into());
        }
        Ok(Some(r.receipt.into()))
    }

    /// Explicit user-requested reads only; never resumes a batch or creates a CL.
    pub async fn reconcile_move(
        &self,
        q: &MoveLookup,
        b: &impl Backend,
    ) -> Result<MoveReceipt, String> {
        let _gate = self.gate.lock().await;
        let mut r = self.load(&q.operation_id)?.ok_or("Unknown operation")?;
        if r.move_target.is_none() || r.request.connection != q.connection {
            return Err("Move operation/connection identity mismatch".into());
        }
        if r.receipt.stage == Stage::InProgress {
            return Err("Operation still active; lookup only".into());
        }
        let id = r
            .receipt
            .new_change_id
            .ok_or("Target identity unknown; cannot infer or recreate it")?;
        b.current(&r.request)?;
        let after = b.inspect(&r.request).await?;
        b.current(&r.request)?;
        owned_target(&r.request, &after.changes, id)?;
        reconcile(&mut r.receipt, &after.changes, id);
        r.receipt.stage = if r
            .receipt
            .files
            .iter()
            .all(|f| matches!(f.state, FileState::Moved | FileState::AlreadyInTarget))
        {
            Stage::MoveCompleted
        } else {
            Stage::Stopped
        };
        // Retain prior unknown operation history; this new revision is current membership evidence.
        if let Some(meta) = &mut r.receipt.execution {
            meta.execution_state = "settled".into();
        }
        r.receipt.message =
            "Explicit read-only membership reconciliation; no write was retried".into();
        self.save(&mut r)?;
        Ok(r.receipt.into())
    }
    pub async fn prepare(
        &self,
        request: Request,
        backend: &impl Backend,
    ) -> Result<Receipt, String> {
        self.prepare_kind(request, None, backend).await
    }
    async fn prepare_kind(
        &self,
        mut request: Request,
        move_target: Option<MoveTarget>,
        backend: &impl Backend,
    ) -> Result<Receipt, String> {
        normalize(&mut request)?;
        if let Some(r) = self.load(&request.operation_id)? {
            if r.request != request || r.move_target != move_target {
                return Err("Operation ID already belongs to another selection".into());
            }
            return Ok(restart_truth(r.receipt));
        }
        let _gate = self.gate.lock().await;
        if let Some(r) = self.load(&request.operation_id)? {
            if r.request != request || r.move_target != move_target {
                return Err("Operation ID already belongs to another selection".into());
            }
            // Persisted inProgress after restart is deliberately never resumed/recreated.
            return Ok(restart_truth(r.receipt));
        }
        let mut r=Record {receipt:Receipt{execution:None,operation_id:request.operation_id.clone(),new_change_id:None,creation_dispatched:false,stage:Stage::InProgress,
   files:request.files.iter().map(|f|FileResult{depot_path:f.depot_path.clone(),source_change_id:f.source_change_id,state:FileState::NotMoved}).collect(),can_continue:false,message:"Preparation in progress; never retry with a new operation ID after response loss".into()}, request, move_target};
        self.persist(&mut r, true)?; // Durable reservation before any side effect.
        backend.begin(&r.request);
        if let Err(e) = self.execute(&mut r, backend).await {
            r.receipt.stage = Stage::Stopped;
            r.receipt.can_continue = false;
            r.receipt.message = e;
        }
        if r.move_target.is_some() {
            backend.finish_move(&r.request);
        }
        self.save(&mut r)?;
        backend.settled(&r.receipt)?;
        Ok(r.receipt)
    }
    async fn execute(&self, r: &mut Record, b: &impl Backend) -> Result<(), String> {
        b.acquire(&r.request).await?;
        b.current(&r.request)?;
        let before = b.inspect(&r.request).await?;
        validate_sources(&r.request, &before)?;
        b.current(&r.request)?;
        r.receipt.message =
            "Target preparation in progress; missing response is not permission to replay".into();
        self.save(r)?;
        let existing = match &r.move_target {
            Some(MoveTarget::Existing { change_id }) => Some(*change_id),
            _ => None,
        };
        if let Some(id) = existing {
            owned_target(&r.request, &before.changes, id)?;
        }
        let id = if let Some(id) = existing {
            id
        } else {
            r.receipt.creation_dispatched = true;
            self.save(r)?;
            b.create(&r.request).await?
        };
        if !(0..=9_007_199_254_740_991).contains(&id) || (id == 0 && existing.is_none()) {
            return Err("Created CL identity is unknown".into());
        }
        r.receipt.new_change_id = Some(id);
        self.save(r)?;
        b.current(&r.request)?;
        let empty = if existing.is_some() {
            before
        } else {
            b.inspect(&r.request).await?
        };
        validate_sources(&r.request, &empty)?;
        let target = empty
            .changes
            .iter()
            .find(|c| c.id == id)
            .ok_or("New CL could not be verified")?;
        if (existing.is_none() && (!target.files.is_empty() || !target.shelved_files.is_empty()))
            || target.status != "pending"
            || target.user != r.request.connection.user
            || target.client != r.request.connection.client
        {
            return Err("New CL is not an empty owned pending CL".into());
        }
        if r.move_target.is_some() {
            let moving: Vec<_> = r
                .request
                .files
                .iter()
                .filter(|f| f.source_change_id != id)
                .cloned()
                .collect();
            for file in &mut r.receipt.files {
                if file.source_change_id == id {
                    file.state = FileState::AlreadyInTarget;
                }
            }
            for (index, chunk) in move_chunks(&moving).into_iter().enumerate() {
                b.current(&r.request)?;
                for file in &mut r.receipt.files {
                    if chunk
                        .iter()
                        .any(|selected| selected.depot_path == file.depot_path)
                    {
                        file.state = FileState::Unknown;
                    }
                }
                self.save(r)?;
                if let Err(error) = b.reopen_batch(&r.request, id, &chunk, index).await {
                    if b.current(&r.request).is_ok() {
                        if let Ok(after) = b.inspect(&r.request).await {
                            reconcile(&mut r.receipt, &after.changes, id);
                        }
                    }
                    return Err(format!("Batch stopped; retain target CL {id}. {error}"));
                }
            }
        } else {
            for i in 0..r.request.files.len() {
                if r.request.files[i].source_change_id == id {
                    r.receipt.files[i].state = FileState::AlreadyInTarget;
                    self.save(r)?;
                    continue;
                }
                b.current(&r.request)?;
                r.receipt.files[i].state = FileState::Unknown;
                self.save(r)?;
                if let Err(e) = b
                    .reopen(&r.request, id, &r.request.files[i].depot_path, i)
                    .await
                {
                    // Reconcile evidence if connection still matches, but NEVER continue after failed dispatch.
                    if b.current(&r.request).is_ok() {
                        if let Ok(after) = b.inspect(&r.request).await {
                            reconcile(&mut r.receipt, &after.changes, id);
                        }
                    }
                    return Err(format!("Move stopped; retain target CL {id}. {e}"));
                }
            }
        }
        b.current(&r.request)?;
        let after = b.inspect(&r.request).await?;
        reconcile(&mut r.receipt, &after.changes, id);
        if r.move_target.is_some() {
            owned_target(&r.request, &after.changes, id)?;
            if r.receipt
                .files
                .iter()
                .any(|f| !matches!(f.state, FileState::Moved | FileState::AlreadyInTarget))
            {
                return Err("Final selected file membership could not be verified".into());
            }
        } else {
            exact_target(&r.request, &after.changes, id)?;
        }
        b.current(&r.request)?;
        if r.move_target.is_some() {
            r.receipt.stage = Stage::MoveCompleted;
            r.receipt.can_continue = false;
            r.receipt.message = format!("Selected files verified in CL {id}; no submission ran. Other target files were retained.");
            return Ok(());
        }
        r.receipt.stage = Stage::ReadyForSubmit;
        r.receipt.can_continue = true;
        r.receipt.message=format!("New CL {id} contains exactly the selected files. Submission has NOT run; cancellation retains this CL.");
        Ok(())
    }
    pub async fn claim(&self, q: Lookup, b: &impl Backend) -> Result<Receipt, String> {
        let _gate = self.gate.lock().await;
        let mut r = self.load(&q.operation_id)?.ok_or("Unknown operation")?;
        if r.request.connection != q.connection
            || r.request.custom_submit_executable_path != q.custom_submit_executable_path
        {
            return Err("Connection or submit configuration changed; confirm again".into());
        }
        if r.move_target.is_some() || r.receipt.stage != Stage::ReadyForSubmit {
            r.receipt.can_continue = false;
            return Ok(restart_truth(r.receipt));
        }
        // One-shot handoff reserved BEFORE async validation; lost response never auto-submits.
        r.receipt.stage = Stage::HandedOff;
        r.receipt.can_continue = false;
        self.save(&mut r)?;
        let checked = async {
            b.current(&r.request)?;
            let after = b.inspect(&r.request).await?;
            exact_target(
                &r.request,
                &after.changes,
                r.receipt.new_change_id.ok_or("Missing new CL")?,
            )?;
            b.current(&r.request)
        }
        .await;
        if let Err(e) = checked {
            r.receipt.stage = Stage::Stopped;
            r.receipt.message = e;
            self.save(&mut r)?;
            return Ok(r.receipt);
        }
        let mut grant = r.receipt;
        grant.can_continue = true;
        grant.message =
            "One-shot handoff to existing explicit submit confirmation; no submit executed".into();
        Ok(grant)
    }
}
/// Restart truth delta: a durable in-progress preparation is never resumed and
/// must not be presented as still running after a process restart.
fn restart_truth(mut receipt: Receipt) -> Receipt {
    if receipt.stage == Stage::InProgress {
        receipt.stage = Stage::Stopped;
        receipt.can_continue = false;
        receipt.message = "Interrupted by a previous process; the batch is not resumed and must not be replayed. Inspect the durable receipt and start a new operation only if needed.".into();
    }
    receipt
}

fn normalize(r: &mut Request) -> Result<(), String> {
    if uuid::Uuid::parse_str(&r.operation_id).is_err() {
        return Err("operationId must be a UUID".into());
    }
    crate::p4::changelists::pending_mutation_invocation(
        &PendingChangeMutation::Create {
            description: r.description.clone(),
            jobs: vec![],
        },
        &[],
    )?;
    if r.files.is_empty() || r.files.len() > 1000 {
        return Err("Select between 1 and 1000 explicitly loaded files".into());
    }
    let mut unique = BTreeMap::new();
    for f in &r.files {
        crate::p4::workflows::command::validate_paths(std::slice::from_ref(&f.depot_path))?;
        if f.depot_path.contains(['@', '#', '*']) || f.depot_path.contains("...") {
            return Err("Only exact depot paths are accepted; no selectors or wildcards".into());
        }
        if !(0..=9_007_199_254_740_991).contains(&f.source_change_id) {
            return Err("Invalid source CL".into());
        }
        if let Some(old) = unique.insert(f.depot_path.clone(), f.source_change_id) {
            if old != f.source_change_id {
                return Err("Conflicting source CL for selected file".into());
            }
        }
    }
    r.files = unique
        .into_iter()
        .map(|(depot_path, source_change_id)| SelectedFile {
            depot_path,
            source_change_id,
        })
        .collect();
    Ok(())
}
fn move_chunks(files: &[SelectedFile]) -> Vec<Vec<SelectedFile>> {
    let mut chunks = Vec::new();
    let mut chunk = Vec::new();
    let mut bytes = 0;
    for file in files {
        let size = file.depot_path.len() + 1;
        if !chunk.is_empty() && (chunk.len() == 128 || bytes + size > 24 * 1024) {
            chunks.push(std::mem::take(&mut chunk));
            bytes = 0;
        }
        bytes += size;
        chunk.push(file.clone());
    }
    if !chunk.is_empty() {
        chunks.push(chunk);
    }
    chunks
}
pub trait Backend {
    fn settled(&self, _receipt: &Receipt) -> Result<(), String> {
        Ok(())
    }
    fn acquire(
        &self,
        _r: &Request,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send {
        async { Ok(()) }
    }
    fn begin(&self, _r: &Request) {}
    fn finish_move(&self, _r: &Request) {}
    fn reopen_batch(
        &self,
        r: &Request,
        id: i64,
        files: &[SelectedFile],
        index: usize,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;
    fn current(&self, r: &Request) -> Result<(), String>;
    fn inspect(
        &self,
        r: &Request,
    ) -> impl std::future::Future<Output = Result<crate::p4::workflows::MoveInspection, String>> + Send;
    fn create(&self, r: &Request) -> impl std::future::Future<Output = Result<i64, String>> + Send;
    fn reopen(
        &self,
        r: &Request,
        id: i64,
        path: &str,
        index: usize,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;
}
fn validate_sources(r: &Request, s: &crate::p4::workflows::MoveInspection) -> Result<(), String> {
    for f in &r.files {
        let sources: Vec<_> = s
            .changes
            .iter()
            .filter(|c| c.files.iter().any(|p| p.depot_path == f.depot_path))
            .collect();
        if sources.len() != 1 {
            return Err("Opened source membership is missing or ambiguous".into());
        }
        let c = sources[0];
        let file = c
            .files
            .iter()
            .find(|p| p.depot_path == f.depot_path)
            .unwrap();
        let facts: Vec<_> = s
            .facts
            .iter()
            .filter(|p| p.depot_path == f.depot_path)
            .collect();
        if c.id != f.source_change_id
            || c.user != r.connection.user
            || c.client != r.connection.client
            || c.status != "pending"
        {
            return Err("Selected source CL/owner/workspace changed".into());
        }
        if !matches!(
            file.action.as_str(),
            "add" | "edit" | "delete" | "branch" | "integrate"
        ) {
            return Err(
                "Unsupported opened action (move pairs require explicit separate handling)".into(),
            );
        }
        if facts.len() != 1
            || facts[0].action != file.action
            || facts[0].change_id != Some(c.id)
            || facts[0].our_lock > 0
            || facts[0].other_lock > 0
        {
            return Err("Opened state or locks could not be verified".into());
        }
    }
    Ok(())
}
fn reconcile(r: &mut Receipt, changes: &[PendingChange], id: i64) {
    for f in &mut r.files {
        let owners: Vec<_> = changes
            .iter()
            .filter(|c| c.files.iter().any(|p| p.depot_path == f.depot_path))
            .collect();
        f.state = match owners.as_slice() {
            [c] if c.id == id && f.source_change_id == id => FileState::AlreadyInTarget,
            [c] if c.id == id => FileState::Moved,
            [c] if c.id == f.source_change_id => FileState::NotMoved,
            _ => FileState::Unknown,
        };
    }
}
fn owned_target<'a>(
    r: &Request,
    changes: &'a [PendingChange],
    id: i64,
) -> Result<&'a PendingChange, String> {
    let targets: Vec<_> = changes.iter().filter(|c| c.id == id).collect();
    match targets.as_slice() {
        [c] if c.status == "pending"
            && c.user == r.connection.user
            && c.client == r.connection.client =>
        {
            Ok(c)
        }
        _ => Err("Target must be one owned pending CL in the same workspace".into()),
    }
}
fn exact_target(r: &Request, changes: &[PendingChange], id: i64) -> Result<(), String> {
    let targets: Vec<_> = changes.iter().filter(|c| c.id == id).collect();
    if targets.len() != 1 {
        return Err("Target CL unavailable/ambiguous".into());
    }
    let c = targets[0];
    let expected: BTreeSet<_> = r.files.iter().map(|f| &f.depot_path).collect();
    let actual: BTreeSet<_> = c.files.iter().map(|f| &f.depot_path).collect();
    if c.status != "pending"
        || c.user != r.connection.user
        || c.client != r.connection.client
        || actual != expected
        || c.files.len() != expected.len()
        || !c.shelved_files.is_empty()
    {
        return Err("Target CL members are not exactly the selected files".into());
    }
    for f in &r.files {
        if changes
            .iter()
            .filter(|c| c.files.iter().any(|p| p.depot_path == f.depot_path))
            .count()
            != 1
        {
            return Err("Final file membership is ambiguous".into());
        }
    }
    Ok(())
}

pub struct Live<'a> {
    pub state: &'a crate::AppState,
    pub context: P4Context,
    pub app: &'a tauri::AppHandle,
    pub group: Mutex<Option<crate::p4::runner::OperationGroup>>,
    pub transaction: Mutex<Option<std::sync::Arc<crate::p4::runner::MutationGuard>>>,
}
impl Backend for Live<'_> {
    fn settled(&self, receipt: &Receipt) -> Result<(), String> {
        if let Some(guard) = self.transaction.lock().as_ref() {
            guard.finish(
                receipt
                    .execution
                    .as_ref()
                    .is_some_and(|m| !m.recovery_required),
            )?;
        }
        Ok(())
    }
    async fn acquire(&self, r: &Request) -> Result<(), String> {
        let guard = self
            .state
            .runner
            .lock_write_transaction(&self.context, &r.operation_id)
            .await
            .map_err(|e| e.to_string())?;
        *self.transaction.lock() = Some(std::sync::Arc::new(guard));
        self.current(r)
    }
    fn finish_move(&self, r: &Request) {
        let paths: Vec<_> = r.files.iter().map(|f| f.depot_path.clone()).collect();
        self.state.status_cache.invalidate(
            &self.context.server,
            &self.context.user,
            &self.context.client,
            &paths,
            &[
                super::status_cache::StatusQueryKind::WorkspaceStatus,
                super::status_cache::StatusQueryKind::Opened,
                super::status_cache::StatusQueryKind::Reconcile,
            ],
            super::status_cache::InvalidationReason::ChangelistMutation,
        );
        self.state.changelists.invalidate_pending_pages();
    }
    async fn reopen_batch(
        &self,
        r: &Request,
        id: i64,
        files: &[SelectedFile],
        index: usize,
    ) -> Result<(), String> {
        let repo = crate::p4::workflows::WorkflowRepository::new(self.state.runner.clone());
        let guard = self
            .transaction
            .lock()
            .clone()
            .ok_or("Missing operation transaction guard")?;
        self.current(r)?;
        let mut scoped = r.clone();
        scoped.files = files.to_vec();
        let before = self.inspect(&scoped).await?;
        validate_sources(&scoped, &before)?;
        owned_target(r, &before.changes, id)?;
        self.current(r)?;
        let paths = files
            .iter()
            .map(|f| f.depot_path.clone())
            .collect::<Vec<_>>();
        let result = repo
            .execute_reopen_batch(
                &self.context,
                id,
                &paths,
                format!("{}:move-batch:{index}", r.operation_id),
                &guard,
                Some(self.app),
            )
            .await?;
        if !batch_succeeded(&result) {
            return Err("Batch response failed or uncertain; no automatic retry".into());
        }
        Ok(())
    }
    fn begin(&self, r: &Request) {
        *self.group.lock() = Some(
            self.state
                .runner
                .begin_operation_group(r.operation_id.clone()),
        );
    }
    fn current(&self, r: &Request) -> Result<(), String> {
        if let Some(group) = self.group.lock().as_ref() {
            group.ensure_active()?;
        }
        let (profile, generation, current) = self.state.connection.swarm_snapshot();
        let identity = super::company_submit::from_host_snapshot(profile, generation, &current)
            .map_err(|_| "Connection identity unavailable")?;
        if identity != r.connection
            || current != self.context
            || current.custom_submit_executable_path != r.custom_submit_executable_path
        {
            return Err("Connection/workspace/submit configuration changed; stopped".into());
        }
        Ok(())
    }
    async fn inspect(&self, r: &Request) -> Result<crate::p4::workflows::MoveInspection, String> {
        self.current(r)?;
        crate::p4::workflows::WorkflowRepository::new(self.state.runner.clone())
            .inspect_move(
                &self.context,
                &r.files
                    .iter()
                    .map(|f| f.depot_path.clone())
                    .collect::<Vec<_>>(),
                &format!("{}:inspect", r.operation_id),
                Some(self.app),
            )
            .await
    }
    async fn create(&self, r: &Request) -> Result<i64, String> {
        self.current(r)?;
        let prepared = crate::p4::changelists::pending_mutation_invocation(
            &PendingChangeMutation::Create {
                description: r.description.clone(),
                jobs: vec![],
            },
            &[],
        )?;
        let guard = self
            .transaction
            .lock()
            .clone()
            .ok_or("Missing operation transaction guard")?;
        let operation = self
            .state
            .runner
            .run_with_mutation_guard(
                P4CommandRequest {
                    // Submit/describe/resolve are mutations guarded by the lane.
                    bound: crate::p4::bounds::IoBound::Command,
                    operation_id: Some(format!("{}:create", r.operation_id)),
                    source: OperationSource::Gui,
                    command: prepared.invocation.command.into(),
                    args: prepared.invocation.args,
                    context: self.context.clone(),
                    output_mode: OutputMode::Text,
                    timeout_ms: None,
                    input: prepared.invocation.input,
                },
                Some(self.app),
                None,
                &guard,
            )
            .await
            .map_err(|e| e.to_string())?;
        self.state.changelists.invalidate_pending_pages();
        if !command_succeeded(&operation) {
            return Err("Create failed or outcome unknown; do not recreate automatically".into());
        }
        crate::p4::changelists::parser::parse_created_change_id(&operation)
            .filter(|id| *id > 0)
            .ok_or("Create acknowledgement missing; CL may exist; do not recreate".into())
    }
    async fn reopen(&self, r: &Request, id: i64, path: &str, index: usize) -> Result<(), String> {
        let repo = crate::p4::workflows::WorkflowRepository::new(self.state.runner.clone());
        let guard = self
            .transaction
            .lock()
            .clone()
            .ok_or("Missing operation transaction guard")?;
        self.current(r)?;
        // Recheck every remaining source under the existing server mutation gate.
        let mut one = r.clone();
        one.files = r
            .files
            .iter()
            .filter(|f| f.depot_path == path)
            .cloned()
            .collect();
        let before = self.inspect(&one).await?;
        validate_sources(&one, &before)?;
        owned_target(r, &before.changes, id)?;
        self.current(r)?;
        let result = repo
            .execute_reopen(
                &self.context,
                id,
                path,
                format!("{}:move:{}", r.operation_id, index),
                &guard,
                Some(self.app),
            )
            .await;
        self.state.status_cache.invalidate(
            &self.context.server,
            &self.context.user,
            &self.context.client,
            &[path.to_owned()],
            &[
                super::status_cache::StatusQueryKind::WorkspaceStatus,
                super::status_cache::StatusQueryKind::Opened,
                super::status_cache::StatusQueryKind::Reconcile,
            ],
            super::status_cache::InvalidationReason::ChangelistMutation,
        );
        self.state.changelists.invalidate_pending_pages();
        let result = result?;
        if !command_succeeded(&result) {
            return Err("Reopen failed or outcome unknown".into());
        }
        Ok(())
    }
}

fn batch_succeeded(result: &OperationResult) -> bool {
    command_succeeded(result)
        && !result.events.iter().any(|event| {
            matches!(event.kind, EventKind::Warning | EventKind::Stderr)
                || event
                    .message
                    .as_deref()
                    .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
                    .is_some_and(|value| {
                        value.get("code").and_then(|v| v.as_str()) == Some("error")
                            || value
                                .get("severity")
                                .and_then(|v| {
                                    v.as_i64()
                                        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                                })
                                .is_some_and(|severity| severity >= 2)
                    })
        })
}
fn command_succeeded(result: &OperationResult) -> bool {
    result.exit_code == 0
        && !result.events.iter().any(|e| {
            matches!(e.kind, EventKind::Error | EventKind::Cancelled)
                || e.message
                    .as_deref()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
                    .and_then(|v| v.get("severity").and_then(|s| s.as_i64()))
                    .is_some_and(|s| s >= 3)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Fake {
        changes: Mutex<Vec<PendingChange>>,
        creates: AtomicUsize,
        batches: AtomicUsize,
        inspections: AtomicUsize,
        finishes: AtomicUsize,
        moves: AtomicUsize,
        fail_move: usize,
        fail_create: bool,
        unknown_after: bool,
        drift_after: usize,
    }
    fn file(path: &str) -> PendingFile {
        serde_json::from_value(serde_json::json!({"depotPath":path,"action":"edit"})).unwrap()
    }
    fn change(id: i64, paths: &[&str]) -> PendingChange {
        PendingChange {
            id,
            description: "Synthetic".into(),
            user: "synthetic-user".into(),
            client: "synthetic-client".into(),
            status: "pending".into(),
            updated_at: None,
            jobs: vec![],
            files: paths.iter().map(|p| file(p)).collect(),
            shelved_files: vec![],
        }
    }
    fn move_request(target: MoveTarget) -> MoveRequest {
        let r = request();
        MoveRequest {
            operation_id: r.operation_id,
            connection: r.connection,
            files: r.files,
            target,
        }
    }

    #[tokio::test]
    async fn move_i01_existing_target_keeps_extras_skips_members_and_never_claims() {
        let h = host();
        let b = fake();
        let q = move_request(MoveTarget::Existing { change_id: 0 });
        let out = h.move_files(q.clone(), String::new(), &b).await.unwrap();
        assert_eq!(out.stage, "completed");
        assert_eq!(out.target_change_id, Some(0));
        assert_eq!(out.files[0].state, FileState::AlreadyInTarget);
        assert_eq!(b.creates.load(Ordering::SeqCst), 0);
        assert_eq!(b.moves.load(Ordering::SeqCst), 2);
        assert!(b.changes.lock()[0]
            .files
            .iter()
            .any(|f| f.depot_path == "//test/unselected"));
        assert!(!h.claim(lookup(&request()), &b).await.unwrap().can_continue);
        h.move_files(q, String::new(), &b).await.unwrap();
        assert_eq!(b.moves.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn move_i01_new_target_completed_and_status_do_not_grant_submit() {
        let h = host();
        let b = fake();
        let q = move_request(MoveTarget::New {
            description: "Synthetic move".into(),
        });
        let out = h.move_files(q.clone(), String::new(), &b).await.unwrap();
        assert_eq!(out.stage, "completed");
        assert_eq!(out.target_change_id, Some(99));
        assert_eq!(b.creates.load(Ordering::SeqCst), 1);
        let saved = h
            .move_status(&MoveLookup {
                operation_id: q.operation_id.clone(),
                connection: q.connection.clone(),
            })
            .unwrap()
            .unwrap();
        assert_eq!(saved.stage, "completed");
        h.move_files(q, String::new(), &b).await.unwrap();
        assert_eq!(b.creates.load(Ordering::SeqCst), 1);
        assert_eq!(b.moves.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn move_i01_partial_stops_and_reconciles_without_rollback_or_retry() {
        let h = host();
        let mut b = fake();
        b.fail_move = 1;
        let q = move_request(MoveTarget::New {
            description: "Synthetic".into(),
        });
        let out = h.move_files(q.clone(), String::new(), &b).await.unwrap();
        assert_eq!(out.stage, "stopped");
        assert_eq!(out.files[0].state, FileState::Moved);
        assert_eq!(out.files[1].state, FileState::NotMoved);
        assert_eq!(out.files[2].state, FileState::NotMoved);
        assert_eq!(b.moves.load(Ordering::SeqCst), 2);
        assert!(b.changes.lock().iter().any(|c| c.id == 99));
        h.move_files(q, String::new(), &b).await.unwrap();
        assert_eq!(b.moves.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn move_i01_missing_create_ack_is_not_recreated() {
        let h = host();
        let mut b = fake();
        b.fail_create = true;
        let q = move_request(MoveTarget::New {
            description: "Synthetic".into(),
        });
        assert_eq!(
            h.move_files(q.clone(), String::new(), &b)
                .await
                .unwrap()
                .stage,
            "stopped"
        );
        h.move_files(q, String::new(), &b).await.unwrap();
        assert_eq!(b.creates.load(Ordering::SeqCst), 1);
        assert_eq!(b.moves.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn move_i01_identity_drift_and_unknown_poststate_do_not_continue() {
        for uncertain in [false, true] {
            let h = host();
            let mut b = fake();
            if uncertain {
                b.unknown_after = true;
                b.fail_move = 1;
            } else {
                b.drift_after = 1;
            }
            let q = move_request(MoveTarget::New {
                description: "Synthetic".into(),
            });
            let out = h.move_files(q, String::new(), &b).await.unwrap();
            assert_eq!(out.stage, "stopped");
            assert_eq!(out.files[0].state, FileState::Unknown);
            assert!(b.moves.load(Ordering::SeqCst) <= 2);
        }
    }

    #[tokio::test]
    async fn move_i01_invalid_target_source_or_description_has_no_writes() {
        for mode in 0..5 {
            let h = host();
            let b = fake();
            let mut q = move_request(MoveTarget::Existing { change_id: 11 });
            match mode {
                0 => q.files[0].source_change_id = 55,
                1 => b.changes.lock()[1].user = "another-user".into(),
                2 => b.changes.lock()[1].status = "submitted".into(),
                3 => {
                    q.target = MoveTarget::New {
                        description: " ".into(),
                    }
                }
                _ => {
                    q.target = MoveTarget::Existing {
                        change_id: 9_007_199_254_740_992,
                    }
                }
            }
            let result = h.move_files(q, String::new(), &b).await;
            assert!(result.is_err() || result.unwrap().stage == "stopped");
            assert_eq!(b.creates.load(Ordering::SeqCst), 0);
            assert_eq!(b.moves.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn move_i01_changed_request_cannot_reuse_id_and_legacy_record_stays_readable() {
        let h = host();
        let b = fake();
        let mut q = move_request(MoveTarget::Existing { change_id: 0 });
        h.move_files(q.clone(), String::new(), &b).await.unwrap();
        q.target = MoveTarget::New {
            description: "Other".into(),
        };
        assert!(h.move_files(q, String::new(), &b).await.is_err());
        let h = host();
        let r = request();
        h.prepare(r.clone(), &fake()).await.unwrap();
        let mut json = serde_json::to_value(h.load(&r.operation_id).unwrap().unwrap()).unwrap();
        json.as_object_mut().unwrap().remove("move_target");
        let decoded: Record = serde_json::from_value(json).unwrap();
        assert!(decoded.move_target.is_none());
    }
    #[tokio::test]
    async fn move_p01_batches_are_bounded_and_reconcile_once() {
        for count in [1usize, 128, 129, 1000] {
            let h = host();
            let b = fake();
            let mut q = move_request(MoveTarget::Existing { change_id: 11 });
            q.files = (0..count)
                .map(|n| SelectedFile {
                    depot_path: format!("//test/item{n:04}"),
                    source_change_id: 0,
                })
                .collect();
            *b.changes.lock() = vec![change(0, &[]), change(11, &["//test/extra"])];
            b.changes.lock()[0].files = q.files.iter().map(|f| file(&f.depot_path)).collect();
            let out = h.move_files(q, String::new(), &b).await.unwrap();
            let batches = count.div_ceil(128);
            assert_eq!(out.stage, "completed");
            assert_eq!(b.batches.load(Ordering::SeqCst), batches);
            assert_eq!(b.inspections.load(Ordering::SeqCst), batches + 2);
            assert_eq!(b.finishes.load(Ordering::SeqCst), 1);
            assert_eq!(b.creates.load(Ordering::SeqCst), 0);
            assert_eq!(b.changes.lock()[1].files.len(), count + 1);
        }
    }

    #[test]
    fn restart_truth_downgrades_persisted_in_progress_without_replay() {
        let receipt = Receipt {
            execution: None,
            operation_id: "11111111-1111-4111-8111-111111111111".into(),
            new_change_id: None,
            creation_dispatched: true,
            stage: Stage::InProgress,
            files: Vec::new(),
            can_continue: true,
            message: "in progress".into(),
        };
        let stopped = restart_truth(receipt);
        assert_eq!(stopped.stage, Stage::Stopped);
        assert!(!stopped.can_continue);
        assert!(stopped.message.contains("Interrupted"));
        let mut ready = stopped;
        ready.stage = Stage::ReadyForSubmit;
        assert_eq!(restart_truth(ready).stage, Stage::ReadyForSubmit);
    }

    #[test]
    fn move_p01_byte_limit_preserves_exact_paths_without_cli_x_batching() {
        let files: Vec<_> = (0..30)
            .map(|i| SelectedFile {
                depot_path: format!("//test/{i}{}", "x".repeat(3000)),
                source_change_id: 0,
            })
            .collect();
        let chunks = move_chunks(&files);
        assert!(chunks.len() > 1);
        assert_eq!(chunks.iter().map(Vec::len).sum::<usize>(), files.len());
        for chunk in chunks {
            let paths = chunk.into_iter().map(|f| f.depot_path).collect::<Vec<_>>();
            let invocation = crate::p4::workflows::command::reopen_batch(0, &paths).unwrap();
            assert!(invocation.argument_input.is_none());
            assert_eq!(&invocation.args[0..2], ["-c", "default"]);
            assert!(paths.iter().map(|p| p.len() + 1).sum::<usize>() <= 24 * 1024);
        }
    }
    #[tokio::test]
    async fn move_p01_failure_stops_later_batches_and_creation_unknown_is_explicit() {
        let h = host();
        let mut b = fake();
        b.fail_move = 1;
        let mut q = move_request(MoveTarget::Existing { change_id: 11 });
        q.files = (0..260)
            .map(|n| SelectedFile {
                depot_path: format!("//test/item{n:04}"),
                source_change_id: 0,
            })
            .collect();
        *b.changes.lock() = vec![change(0, &[]), change(11, &[])];
        b.changes.lock()[0].files = q.files.iter().map(|f| file(&f.depot_path)).collect();
        let out = h.move_files(q, String::new(), &b).await.unwrap();
        assert_eq!(out.stage, "stopped");
        assert_eq!(b.batches.load(Ordering::SeqCst), 1);
        assert_eq!(b.finishes.load(Ordering::SeqCst), 1);
        assert_eq!(out.files[0].state, FileState::Moved);
        assert_eq!(out.files[259].state, FileState::NotMoved);
        assert!(!out.target_creation_unknown);
        let h = host();
        let mut b = fake();
        b.fail_create = true;
        let out = h
            .move_files(
                move_request(MoveTarget::New {
                    description: "Synthetic".into(),
                }),
                String::new(),
                &b,
            )
            .await
            .unwrap();
        assert!(out.target_creation_unknown);
        assert_eq!(out.target_change_id, None);
    }

    #[test]
    fn move_p01_warning_or_structured_error_stops_batch_even_with_zero_exit() {
        for message in [r#"{"severity":"2"}"#, r#"{"code":"error"}"#] {
            let result = OperationResult {
                operation_id: "mock".into(),
                exit_code: 0,
                duration_ms: 0,
                events: vec![OperationEvent {
                    operation_id: "mock".into(),
                    kind: EventKind::Stdout,
                    message: Some(message.into()),
                    progress: None,
                    timestamp: String::new(),
                }],
            };
            assert!(!batch_succeeded(&result));
        }
    }
    fn fake() -> Fake {
        Fake {
            changes: Mutex::new(vec![
                change(0, &["//test/a", "//test/unselected"]),
                change(11, &["//test/b"]),
                change(12, &["//test/c"]),
            ]),
            creates: AtomicUsize::new(0),
            batches: AtomicUsize::new(0),
            inspections: AtomicUsize::new(0),
            finishes: AtomicUsize::new(0),
            moves: AtomicUsize::new(0),
            fail_move: usize::MAX,
            fail_create: false,
            unknown_after: false,
            drift_after: usize::MAX,
        }
    }
    fn request() -> Request {
        Request {
            operation_id: "10000000-0000-4000-8000-000000000001".into(),
            connection: ConnectionSnapshot {
                profile_id: "profile".into(),
                generation: "9007199254740993".into(),
                server: "synthetic:1".into(),
                user: "synthetic-user".into(),
                client: "synthetic-client".into(),
            },
            custom_submit_executable_path: String::new(),
            description: "Selected synthetic files".into(),
            files: vec![
                SelectedFile {
                    depot_path: "//test/a".into(),
                    source_change_id: 0,
                },
                SelectedFile {
                    depot_path: "//test/b".into(),
                    source_change_id: 11,
                },
                SelectedFile {
                    depot_path: "//test/c".into(),
                    source_change_id: 12,
                },
            ],
        }
    }
    fn lookup(r: &Request) -> Lookup {
        Lookup {
            operation_id: r.operation_id.clone(),
            connection: r.connection.clone(),
            custom_submit_executable_path: r.custom_submit_executable_path.clone(),
        }
    }
    fn host() -> Host {
        Host::from_db(Connection::open_in_memory().unwrap()).unwrap()
    }
    impl Backend for Fake {
        fn finish_move(&self, _: &Request) {
            self.finishes.fetch_add(1, Ordering::SeqCst);
        }
        async fn reopen_batch(
            &self,
            r: &Request,
            id: i64,
            files: &[SelectedFile],
            _: usize,
        ) -> Result<(), String> {
            self.batches.fetch_add(1, Ordering::SeqCst);
            let mut scoped = r.clone();
            scoped.files = files.to_vec();
            let before = self.inspect(&scoped).await?;
            validate_sources(&scoped, &before)?;
            owned_target(r, &before.changes, id)?;
            for (index, file) in files.iter().enumerate() {
                self.current(r)?;
                self.reopen(r, id, &file.depot_path, index).await?;
            }
            Ok(())
        }
        fn current(&self, _: &Request) -> Result<(), String> {
            if self.moves.load(Ordering::SeqCst) >= self.drift_after {
                Err("connection changed".into())
            } else {
                Ok(())
            }
        }
        async fn inspect(
            &self,
            r: &Request,
        ) -> Result<crate::p4::workflows::MoveInspection, String> {
            self.inspections.fetch_add(1, Ordering::SeqCst);
            if self.unknown_after && self.moves.load(Ordering::SeqCst) > 0 {
                return Err("inspection unknown".into());
            }
            let changes = self.changes.lock().clone();
            let facts=changes.iter().flat_map(|c|c.files.iter().filter(|f|r.files.iter().any(|s|s.depot_path==f.depot_path)).map(move|f|serde_json::json!({"depotFile":f.depot_path,"action":f.action,"change":if c.id==0{"default".to_string()}else{c.id.to_string()}}))).map(|v|OperationEvent{operation_id:"mock".into(),kind:EventKind::Stdout,message:Some(v.to_string()),progress:None,timestamp:String::new()}).collect::<Vec<_>>();
            Ok(crate::p4::workflows::MoveInspection {
                changes,
                facts: crate::p4::workflows::parser::file_facts(&facts),
                operation_ids: vec![],
            })
        }
        async fn create(&self, _: &Request) -> Result<i64, String> {
            self.creates.fetch_add(1, Ordering::SeqCst);
            if self.fail_create {
                return Err("create outcome unknown".into());
            }
            self.changes.lock().push(change(99, &[]));
            Ok(99)
        }
        async fn reopen(&self, _: &Request, id: i64, path: &str, _: usize) -> Result<(), String> {
            let n = self.moves.fetch_add(1, Ordering::SeqCst);
            if n == self.fail_move {
                return Err("reopen failed".into());
            }
            let mut all = self.changes.lock();
            let mut found = None;
            for c in &mut *all {
                if let Some(i) = c.files.iter().position(|f| f.depot_path == path) {
                    found = Some(c.files.remove(i));
                    break;
                }
            }
            all.iter_mut()
                .find(|c| c.id == id)
                .unwrap()
                .files
                .push(found.unwrap());
            Ok(())
        }
    }
    #[tokio::test]
    async fn dedup_three_sources_exact_unselected_unchanged_and_one_shot() {
        let h = host();
        let b = fake();
        let mut r = request();
        r.files.push(r.files[0].clone());
        let out = h.prepare(r.clone(), &b).await.unwrap();
        assert_eq!(out.stage, Stage::ReadyForSubmit);
        assert_eq!(out.files.len(), 3);
        assert!(out.files.iter().all(|f| f.state == FileState::Moved));
        assert_eq!(b.changes.lock()[0].files[0].depot_path, "//test/unselected");
        let duplicate = h.prepare(r.clone(), &b).await.unwrap();
        assert_eq!(duplicate.new_change_id, Some(99));
        assert_eq!(b.creates.load(Ordering::SeqCst), 1);
        assert!(h.claim(lookup(&r), &b).await.unwrap().can_continue);
        assert!(!h.claim(lookup(&r), &b).await.unwrap().can_continue);
        assert_eq!(
            h.status(&lookup(&r)).unwrap().unwrap().stage,
            Stage::HandedOff
        );
    }
    #[tokio::test]
    async fn concurrent_confirmation_creates_once() {
        let h = host();
        let b = fake();
        let r = request();
        let (a, z) = tokio::join!(h.prepare(r.clone(), &b), h.prepare(r, &b));
        assert_eq!(a.unwrap().new_change_id, z.unwrap().new_change_id);
        assert_eq!(b.creates.load(Ordering::SeqCst), 1);
        assert_eq!(b.moves.load(Ordering::SeqCst), 3);
    }
    #[tokio::test]
    async fn selectors_and_conflicting_duplicates_are_rejected() {
        let h = host();
        let b = fake();
        let mut r = request();
        r.files[0].depot_path = "//test/...".into();
        assert!(h.prepare(r, &b).await.is_err());
        let mut r = request();
        r.files.push(SelectedFile {
            depot_path: r.files[0].depot_path.clone(),
            source_change_id: 9,
        });
        assert!(h.prepare(r, &b).await.is_err());
        assert_eq!(b.creates.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn zero_exit_with_error_is_not_success() {
        let r = OperationResult {
            operation_id: "mock".into(),
            exit_code: 0,
            duration_ms: 0,
            events: vec![OperationEvent {
                operation_id: "mock".into(),
                kind: EventKind::Stdout,
                message: Some("{\"severity\":3}".into()),
                progress: None,
                timestamp: String::new(),
            }],
        };
        assert!(!command_succeeded(&r));
    }
    #[tokio::test]
    async fn create_unknown_not_retried() {
        let h = host();
        let mut b = fake();
        b.fail_create = true;
        let r = request();
        let out = h.prepare(r.clone(), &b).await.unwrap();
        assert_eq!(out.stage, Stage::Stopped);
        assert_eq!(out.new_change_id, None);
        h.prepare(r, &b).await.unwrap();
        assert_eq!(b.creates.load(Ordering::SeqCst), 1);
        assert_eq!(b.moves.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn partial_move_stops_and_preserves_new_cl() {
        let h = host();
        let mut b = fake();
        b.fail_move = 1;
        let out = h.prepare(request(), &b).await.unwrap();
        assert_eq!(out.stage, Stage::Stopped);
        assert_eq!(out.new_change_id, Some(99));
        assert_eq!(b.moves.load(Ordering::SeqCst), 2);
        assert_eq!(out.files[0].state, FileState::Moved);
        assert_eq!(out.files[1].state, FileState::NotMoved);
        assert_eq!(out.files[2].state, FileState::NotMoved);
        assert!(!out.can_continue);
    }
    #[tokio::test]
    async fn final_inspection_unknown_never_success() {
        let h = host();
        let mut b = fake();
        b.unknown_after = true;
        let out = h.prepare(request(), &b).await.unwrap();
        assert_eq!(out.stage, Stage::Stopped);
        assert!(!out.can_continue);
        assert!(out.files.iter().all(|f| f.state == FileState::Unknown));
    }
    #[tokio::test]
    async fn context_switch_stops_next_file() {
        let h = host();
        let mut b = fake();
        b.drift_after = 1;
        let out = h.prepare(request(), &b).await.unwrap();
        assert_eq!(out.stage, Stage::Stopped);
        assert_eq!(b.moves.load(Ordering::SeqCst), 1);
        assert_eq!(out.files[0].state, FileState::Unknown);
    }
    #[tokio::test]
    async fn move_pairs_block_before_create() {
        let h = host();
        let b = fake();
        b.changes.lock()[0].files[0].action = "move/add".into();
        let out = h.prepare(request(), &b).await.unwrap();
        assert_eq!(out.stage, Stage::Stopped);
        assert_eq!(b.creates.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn source_drift_blocks_before_create() {
        let h = host();
        let b = fake();
        let mut r = request();
        r.files[0].source_change_id = 42;
        assert_eq!(h.prepare(r, &b).await.unwrap().stage, Stage::Stopped);
        assert_eq!(b.creates.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn empty_description_rejected_before_reservation() {
        let h = host();
        let b = fake();
        let mut r = request();
        r.description = " \n".into();
        assert!(h.prepare(r, &b).await.is_err());
        assert_eq!(b.creates.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn replay_with_changed_selection_rejected() {
        let h = host();
        let b = fake();
        let r = request();
        h.prepare(r.clone(), &b).await.unwrap();
        let mut changed = r;
        changed.files.pop();
        assert!(h.prepare(changed, &b).await.is_err());
        assert_eq!(b.creates.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn changed_config_does_not_claim_or_fallback() {
        let h = host();
        let b = fake();
        let mut r = request();
        r.custom_submit_executable_path = "C:\\Synthetic\\submit.exe".into();
        h.prepare(r.clone(), &b).await.unwrap();
        let mut q = lookup(&r);
        q.custom_submit_executable_path.clear();
        assert!(h.claim(q, &b).await.is_err());
        assert_eq!(
            h.status(&lookup(&r)).unwrap().unwrap().stage,
            Stage::ReadyForSubmit
        );
    }
    #[tokio::test]
    async fn unexpected_target_member_blocks_handoff() {
        let h = host();
        let b = fake();
        let r = request();
        h.prepare(r.clone(), &b).await.unwrap();
        b.changes
            .lock()
            .last_mut()
            .unwrap()
            .files
            .push(file("//test/extra"));
        let out = h.claim(lookup(&r), &b).await.unwrap();
        assert_eq!(out.stage, Stage::Stopped);
        assert!(!out.can_continue);
    }
    #[tokio::test]
    async fn interrupted_persisted_receipt_never_resumes() {
        let h = host();
        let b = fake();
        let r = request();
        let receipt = Receipt {
            execution: None,
            operation_id: r.operation_id.clone(),
            new_change_id: Some(99),
            creation_dispatched: true,
            stage: Stage::InProgress,
            files: vec![],
            can_continue: false,
            message: "interrupted".into(),
        };
        h.save(&mut Record {
            request: r.clone(),
            move_target: None,
            receipt,
        })
        .unwrap();
        let out = h.prepare(r, &b).await.unwrap();
        assert_eq!(out.new_change_id, Some(99));
        assert!(!out.can_continue);
        assert_eq!(b.creates.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn s1a_persistence_boundaries_never_replay_or_publish_uncommitted_revision() {
        for fail_at in 1..=6 {
            let h = host();
            let b = fake();
            h.fail_write.store(fail_at, Ordering::SeqCst);
            let q = move_request(MoveTarget::New {
                description: "synthetic target".into(),
            });
            let lookup = MoveLookup {
                operation_id: q.operation_id.clone(),
                connection: q.connection.clone(),
            };
            let result = h.move_files(q.clone(), String::new(), &b).await;
            let creates = b.creates.load(Ordering::SeqCst);
            let moves = b.moves.load(Ordering::SeqCst);
            if fail_at == 1 {
                assert!(result.is_err());
                assert!(matches!(h.move_lookup(&lookup), MoveLookupResult::NotFound));
                assert_eq!((creates, moves), (0, 0));
                continue;
            }
            if fail_at <= 3 {
                assert_eq!(creates, 0);
            }
            if fail_at <= 5 {
                assert_eq!(moves, 0);
            }
            let persisted = h.move_status(&lookup).unwrap().unwrap();
            if fail_at == 6 {
                assert!(result.is_err());
                assert_ne!(persisted.stage, "completed");
                assert_ne!(persisted.execution.as_ref().unwrap().outcome, "verified");
            }
            let revision = persisted.execution.as_ref().unwrap().revision.clone();
            let repeated = h.move_files(q, String::new(), &b).await.unwrap();
            assert_eq!(repeated.execution.unwrap().revision, revision);
            assert_eq!(
                (
                    b.creates.load(Ordering::SeqCst),
                    b.moves.load(Ordering::SeqCst)
                ),
                (creates, moves)
            );
        }
    }
    #[tokio::test]
    async fn s1a_lookup_variants_digest_normalization_and_conflict() {
        let h = host();
        let b = fake();
        let q = move_request(MoveTarget::Existing { change_id: 0 });
        let lookup = MoveLookup {
            operation_id: q.operation_id.clone(),
            connection: q.connection.clone(),
        };
        assert!(matches!(h.move_lookup(&lookup), MoveLookupResult::NotFound));
        let first = h.move_files(q.clone(), String::new(), &b).await.unwrap();
        let mut reordered = q.clone();
        reordered.files.reverse();
        reordered.files.push(reordered.files[0].clone());
        let repeated = h.move_files(reordered, String::new(), &b).await.unwrap();
        assert_eq!(
            first.execution.as_ref().unwrap().payload_digest,
            repeated.execution.as_ref().unwrap().payload_digest
        );
        assert_eq!(
            first.execution.as_ref().unwrap().revision,
            repeated.execution.as_ref().unwrap().revision
        );
        let calls = b.moves.load(Ordering::SeqCst);
        let mut conflict = q;
        conflict.target = MoveTarget::Existing { change_id: 123 };
        assert!(h.move_files(conflict, String::new(), &b).await.is_err());
        assert_eq!(b.moves.load(Ordering::SeqCst), calls);
        let wrong = MoveLookup {
            operation_id: lookup.operation_id.clone(),
            connection: ConnectionSnapshot {
                generation: "999".into(),
                ..lookup.connection.clone()
            },
        };
        assert!(matches!(
            h.move_lookup(&wrong),
            MoveLookupResult::ScopeMismatch
        ));
        assert!(matches!(
            h.move_lookup(&lookup),
            MoveLookupResult::Found { .. }
        ));
        h.db.lock()
            .execute("UPDATE selected_submit SET record='broken'", [])
            .unwrap();
        assert!(matches!(
            h.move_lookup(&lookup),
            MoveLookupResult::StorageUnavailable
        ));
    }
    #[tokio::test]
    async fn s1a_temp_sqlite_restart_marks_interrupted_without_backend_calls() {
        let dir = std::env::temp_dir().join(format!("p4deck-s1a-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("receipts.sqlite");
        let q = move_request(MoveTarget::New {
            description: "synthetic target".into(),
        });
        let lookup = MoveLookup {
            operation_id: q.operation_id.clone(),
            connection: q.connection.clone(),
        };
        let h = Host::open(&path).unwrap();
        let b = fake();
        h.fail_write.store(6, Ordering::SeqCst); // final commit fails, dispatch evidence persists
        assert!(h.move_files(q.clone(), String::new(), &b).await.is_err());
        let old = h.move_status(&lookup).unwrap().unwrap().execution.unwrap();
        drop(h);
        let h = Host::open(&path).unwrap();
        let recovered = h.move_status(&lookup).unwrap().unwrap();
        let metadata = recovered.execution.as_ref().unwrap();
        assert_eq!(metadata.execution_state, "interrupted");
        assert_eq!(metadata.outcome, "unknown");
        assert!(metadata.recovery_required);
        assert!(metadata.revision.parse::<u64>().unwrap() > old.revision.parse::<u64>().unwrap());
        let backend = fake();
        h.move_files(q, String::new(), &backend).await.unwrap();
        assert_eq!(backend.creates.load(Ordering::SeqCst), 0);
        assert_eq!(backend.moves.load(Ordering::SeqCst), 0);
        let revision = metadata.revision.clone();
        drop(h);
        let h = Host::open(&path).unwrap();
        assert_eq!(
            h.move_status(&lookup)
                .unwrap()
                .unwrap()
                .execution
                .unwrap()
                .revision,
            revision
        );
    }
    #[tokio::test]
    async fn s1a_legacy_record_migrates_without_losing_target_or_file_facts() {
        let h = host();
        let b = fake();
        let q = move_request(MoveTarget::New {
            description: "legacy fixture".into(),
        });
        let lookup = MoveLookup {
            operation_id: q.operation_id.clone(),
            connection: q.connection.clone(),
        };
        let receipt = h.move_files(q, String::new(), &b).await.unwrap();
        let mut old = h.load(&lookup.operation_id).unwrap().unwrap();
        old.receipt.execution = None;
        let raw = serde_json::to_string(&old).unwrap();
        h.db.lock()
            .execute(
                "UPDATE selected_submit SET record=?1 WHERE id=?2",
                rusqlite::params![raw, lookup.operation_id],
            )
            .unwrap();
        h.recover_metadata().unwrap();
        let recovered = h.move_status(&lookup).unwrap().unwrap();
        assert_eq!(recovered.target_change_id, receipt.target_change_id);
        assert_eq!(
            serde_json::to_value(&recovered.files).unwrap(),
            serde_json::to_value(&receipt.files).unwrap()
        );
        assert_eq!(recovered.execution.unwrap().outcome, "unknown");
    }
    #[tokio::test]
    async fn s1a_revision_is_exact_decimal_and_overflow_does_not_commit() {
        let h = host();
        let b = fake();
        let q = move_request(MoveTarget::New {
            description: "revision fixture".into(),
        });
        h.move_files(q.clone(), String::new(), &b).await.unwrap();
        let mut r = h.load(&q.operation_id).unwrap().unwrap();
        r.receipt.execution.as_mut().unwrap().revision = "9007199254740993".into();
        h.db.lock()
            .execute(
                "UPDATE selected_submit SET record=?1 WHERE id=?2",
                rusqlite::params![serde_json::to_string(&r).unwrap(), q.operation_id],
            )
            .unwrap();
        h.save(&mut r).unwrap();
        assert_eq!(
            r.receipt.execution.as_ref().unwrap().revision,
            "9007199254740994"
        );
        r.receipt.execution.as_mut().unwrap().revision = u64::MAX.to_string();
        h.db.lock()
            .execute(
                "UPDATE selected_submit SET record=?1 WHERE id=?2",
                rusqlite::params![serde_json::to_string(&r).unwrap(), q.operation_id],
            )
            .unwrap();
        assert!(h.save(&mut r).is_err());
        assert_eq!(
            h.load(&q.operation_id)
                .unwrap()
                .unwrap()
                .receipt
                .execution
                .unwrap()
                .revision,
            u64::MAX.to_string()
        );
    }
    #[tokio::test]
    async fn s1b_explicit_reconciliation_only_reads_and_never_replays() {
        let h = host();
        let b = fake();
        let q = move_request(MoveTarget::New {
            description: "read reconciliation".into(),
        });
        let lookup = MoveLookup {
            operation_id: q.operation_id.clone(),
            connection: q.connection.clone(),
        };
        h.fail_write.store(6, Ordering::SeqCst);
        assert!(h.move_files(q, String::new(), &b).await.is_err());
        h.recover_metadata().unwrap();
        let creates = b.creates.load(Ordering::SeqCst);
        let moves = b.moves.load(Ordering::SeqCst);
        let reads = b.inspections.load(Ordering::SeqCst);
        let out = h.reconcile_move(&lookup, &b).await.unwrap();
        assert_eq!(out.stage, "completed");
        assert_eq!(b.creates.load(Ordering::SeqCst), creates);
        assert_eq!(b.moves.load(Ordering::SeqCst), moves);
        assert_eq!(b.inspections.load(Ordering::SeqCst), reads + 1);
    }
}
