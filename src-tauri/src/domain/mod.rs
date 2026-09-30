use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct P4Context {
    pub executable: Option<String>,
    pub server: String,
    pub user: String,
    pub client: String,
    pub cwd: Option<String>,
    pub charset: Option<String>,
    pub trust_path: Option<String>,
    pub tickets_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P4CommandRequest {
    pub operation_id: Option<String>,
    pub source: OperationSource,
    pub command: String,
    pub args: Vec<String>,
    pub context: P4Context,
    pub output_mode: OutputMode,
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub input: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationSource {
    Gui,
    Terminal,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OutputMode {
    Text,
    JsonLines,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationEvent {
    pub operation_id: String,
    #[serde(rename = "type")]
    pub kind: EventKind,
    pub message: Option<String>,
    pub progress: Option<f32>,
    pub timestamp: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EventKind {
    Queued,
    Started,
    Stdout,
    Stderr,
    Progress,
    Warning,
    Error,
    Completed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub operation_id: String,
    pub exit_code: i32,
    pub events: Vec<OperationEvent>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub mode: String,
    pub p4_version: String,
    pub context: P4Context,
    pub connection: ConnectionStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionState {
    CliMissing,
    NotTested,
    Disconnected,
    SslUntrusted,
    AuthRequired,
    Connected,
    TicketExpired,
    NetworkError,
    PermissionDenied,
    InvalidConfig,
    ExternalAuthRequired,
    Unsupported,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionErrorCode {
    CliMissing,
    Disconnected,
    SslUntrusted,
    AuthRequired,
    TicketExpired,
    NetworkError,
    PermissionDenied,
    InvalidConfig,
    ExternalAuthRequired,
    Unsupported,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryAction {
    None,
    ConfigureCli,
    EditConfig,
    TrustServer,
    Login,
    Retry,
    ContactAdmin,
    CompleteExternalAuth,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub state: ConnectionState,
    pub error_code: Option<ConnectionErrorCode>,
    pub message: String,
    pub recovery: RecoveryAction,
    pub server: String,
    pub fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CliDiscoveryRequest {
    pub executable: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliDiscoveryResult {
    pub state: ConnectionState,
    pub executable: Option<String>,
    pub version: Option<String>,
    pub error_code: Option<ConnectionErrorCode>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustRequest {
    pub context: P4Context,
    pub fingerprint: String,
    pub confirmed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub context: P4Context,
    pub password: String,
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticationRequest {
    pub context: P4Context,
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum LogLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: String,
    pub timestamp: String,
    pub level: LogLevel,
    pub operation_id: String,
    pub source: OperationSource,
    pub server: String,
    pub workspace: String,
    pub command: String,
    pub message: String,
    pub duration_ms: Option<u64>,
    pub repeat_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LogQuery {
    pub keyword: Option<String>,
    pub levels: Option<Vec<LogLevel>>,
    pub server: Option<String>,
    pub workspace: Option<String>,
    pub command: Option<String>,
    pub operation_id: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub entries: Vec<LogEntry>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPolicy {
    pub auto_expand_warning: bool,
    pub auto_expand_error: bool,
    pub retention_days: u32,
    pub max_mib: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticExportRequest {
    pub max_log_entries: Option<usize>,
    pub max_operation_entries: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticExportResult {
    pub path: String,
    pub size_bytes: u64,
    pub truncated: bool,
    pub format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClQuery {
    pub request_generation: u64,
    pub keyword: String,
    pub statuses: Vec<String>,
    pub users: Vec<String>,
    pub clients: Vec<String>,
    pub path: Option<String>,
    pub stream: Option<String>,
    pub from: String,
    pub to: String,
    pub has_shelf: Option<bool>,
    pub has_job: Option<bool>,
    pub hide_reliable_merges: bool,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum MergeClassification {
    Normal,
    ReliableMerge,
    SuspectedMerge,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangelistSummary {
    pub id: i64,
    pub description: String,
    pub user: String,
    pub client: String,
    pub status: String,
    pub time: String,
    pub file_count: usize,
    pub has_shelf: bool,
    pub jobs: Vec<String>,
    pub stream: Option<String>,
    pub merge_classification: MergeClassification,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClQueryResult {
    pub request_generation: u64,
    pub changes: Vec<ChangelistSummary>,
    pub hidden_merge_count: usize,
    pub has_more: bool,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClAction {
    Create {
        description: String,
    },
    Edit {
        change_id: i64,
        description: String,
        jobs: Vec<String>,
    },
    Delete {
        change_id: i64,
    },
    MoveFiles {
        change_id: i64,
        depot_paths: Vec<String>,
    },
    Shelve {
        change_id: i64,
        depot_paths: Option<Vec<String>>,
        replace: Option<bool>,
    },
    DeleteShelf {
        change_id: i64,
        depot_paths: Option<Vec<String>>,
    },
    UnshelvePreview {
        source_change_id: i64,
        target_change_id: i64,
    },
    Unshelve {
        source_change_id: i64,
        target_change_id: i64,
    },
    SubmitValidate {
        change_id: i64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClActionResult {
    pub operation: OperationResult,
    pub affected_changes: Vec<i64>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceNode {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub absolute_path: String,
    pub relative_path: String,
    pub depot_path: Option<String>,
    pub state: String,
    pub revision: Option<i64>,
    pub head_revision: Option<i64>,
    pub changelist_id: Option<i64>,
    pub modified_at: Option<String>,
    pub has_children: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepotNode {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub depot_path: String,
    pub head_revision: Option<i64>,
    pub head_action: Option<String>,
    pub has_children: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathResolveRequest {
    pub input: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathResolveResult {
    pub found: bool,
    pub input_kind: String,
    pub absolute_path: Option<String>,
    pub relative_path: Option<String>,
    pub depot_path: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileAction {
    Refresh,
    GetLatest,
    GetRevision,
    RemoveFromWorkspace,
    DeleteLocal,
    Checkout,
    CheckoutAndOpen,
    Add,
    AddRecursive,
    /// Kept for the existing UI: untracked files are deleted locally, other files are opened for delete.
    Delete,
    MarkForDelete,
    Submit,
    RevertUnchanged,
    Revert,
    MoveToChangelist,
    Resolve,
    Reconcile,
    Shelve,
    ChangeFiletype,
    Lock,
    Unlock,
    Integrate,
    Copy,
    Branch,
    RenameMove,
    Undo,
    Clean,
    TagWithLabel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileActionRequest {
    #[serde(default)]
    pub operation_id: Option<String>,
    pub action: FileAction,
    pub paths: Vec<String>,
    pub revision: Option<String>,
    pub states: Option<Vec<String>>,
    #[serde(default)]
    pub changelist_id: Option<i64>,
    #[serde(default)]
    pub file_type: Option<String>,
    #[serde(default)]
    pub target_path: Option<String>,
    #[serde(default)]
    pub resolve_method: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    /// Opt-in P4-native transfer parallelism. Kept small by the command planner.
    #[serde(default)]
    pub parallel_threads: Option<u8>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileActionResult {
    pub operation: Option<OperationResult>,
    pub affected_paths: Vec<String>,
    pub message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub path: String,
    pub left_label: String,
    pub right_label: String,
    pub unified: String,
    pub binary: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRevision {
    pub revision: i64,
    pub changelist_id: i64,
    pub user: String,
    pub action: String,
    pub time: String,
    pub description: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionGraphNode {
    pub id: String,
    pub depot_path: String,
    pub revision: i64,
    pub changelist_id: i64,
    pub label: String,
    pub x: i64,
    pub y: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionGraphEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub kind: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionGraph {
    pub nodes: Vec<RevisionGraphNode>,
    pub edges: Vec<RevisionGraphEdge>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingFile {
    pub depot_path: String,
    pub action: String,
    pub state: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingChange {
    pub id: i64,
    pub description: String,
    pub files: Vec<PendingFile>,
    pub shelved_files: Vec<PendingFile>,
}
