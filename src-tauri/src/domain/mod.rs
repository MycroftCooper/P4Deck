use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub context: P4Context,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfiles {
    pub schema_version: u32,
    pub revision: u64,
    pub active_profile_id: Option<String>,
    pub profiles: Vec<ConnectionProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateConnectionProfileRequest {
    pub expected_revision: u64,
    pub name: String,
    pub context: P4Context,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConnectionProfileRequest {
    pub expected_revision: u64,
    pub id: String,
    pub name: String,
    pub context: P4Context,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteConnectionProfileRequest {
    pub expected_revision: u64,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetActiveConnectionProfileRequest {
    pub expected_revision: u64,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchWorkspaceRequest {
    pub expected_generation: u64,
    pub client: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionProfileErrorCode {
    InvalidInput,
    DuplicateName,
    DuplicateContext,
    NotFound,
    RevisionConflict,
    ActiveProfileDelete,
    LastProfileDelete,
    CorruptStore,
    UnsupportedSchema,
    PersistenceFailed,
    ConnectionFailed,
    AuthenticationRequired,
    ContextChanged,
}

#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct ConnectionProfileError {
    pub code: ConnectionProfileErrorCode,
    pub message: String,
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

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
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
    pub active_profile_id: Option<String>,
    pub context_generation: u64,
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
    pub sources: Option<Vec<OperationSource>>,
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
    pub operation_id: String,
    pub request_generation: u64,
    pub keyword: String,
    pub users: Vec<String>,
    pub clients: Vec<String>,
    pub depot_path: Option<String>,
    pub stream: Option<String>,
    pub from: String,
    pub to: String,
    pub jobs: Vec<String>,
    pub has_job: Option<bool>,
    pub merge_classifications: Vec<MergeClassification>,
    pub hide_reliable_merges: bool,
    pub page_size: usize,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubmittedChangeDetailRequest {
    pub change_id: i64,
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubmittedChangeFile {
    pub depot_path: String,
    pub action: String,
    pub revision: Option<i64>,
    pub file_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SubmittedIntegrationEvidenceSource {
    DescribeAction,
    Filelog,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubmittedIntegrationEvidence {
    pub source: SubmittedIntegrationEvidenceSource,
    pub depot_path: String,
    pub relationship: String,
    pub related_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SubmittedInspectionStatus {
    Complete,
    Partial,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubmittedChangeDetail {
    pub change_id: i64,
    pub description: String,
    pub user: String,
    pub client: String,
    pub time: String,
    pub jobs: Vec<String>,
    pub files: Vec<SubmittedChangeFile>,
    pub integration_evidence: Vec<SubmittedIntegrationEvidence>,
    pub merge_classification: MergeClassification,
    pub inspection_status: SubmittedInspectionStatus,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShelfDetailRequest {
    pub change_id: i64,
    pub request_generation: u64,
    pub page_size: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default)]
    pub refresh: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ShelfDetailRequestErrorCode {
    InvalidQuery,
    InvalidCursor,
    CursorExpired,
    SnapshotChanged,
    ConnectionChanged,
    Cancelled,
    QueryFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShelfDetailRequestError {
    pub code: ShelfDetailRequestErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShelfDetailScope {
    pub server: String,
    pub user: String,
    pub client: String,
    pub workspace: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_profile_id: Option<String>,
    pub context_generation: u64,
    pub change_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShelfDetailFile {
    pub depot_path: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    pub binary: bool,
    pub symlink: bool,
    pub deleted: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ShelfInspectionStatus {
    Complete,
    Partial,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShelfDetail {
    pub request_generation: u64,
    pub scope: ShelfDetailScope,
    pub description: String,
    pub time: String,
    pub owner: String,
    pub user: String,
    pub client: String,
    pub jobs: Vec<String>,
    pub files: Vec<ShelfDetailFile>,
    pub total_files: usize,
    pub has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub truncated: bool,
    pub inspection_status: ShelfInspectionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub operation_ids: Vec<String>,
    pub cache_freshness: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClQueryResult {
    pub request_generation: u64,
    pub items: Vec<ChangelistSummary>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
    pub stats: ClQueryStats,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClQueryStats {
    pub scanned_count: usize,
    pub matched_count: usize,
    pub hidden_reliable_merge_count: usize,
    pub truncated_by_safety_limit: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum GlobalSearchKind {
    SubmittedChange,
    PendingChange,
    WorkspaceFile,
    DepotFile,
    Job,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSearchQuery {
    pub operation_id: String,
    pub request_generation: u64,
    pub text: String,
    #[serde(default)]
    pub kinds: Vec<GlobalSearchKind>,
    pub page_size: usize,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GlobalSearchTarget {
    SubmittedChange { change_id: i64 },
    PendingChange { change_id: i64 },
    WorkspaceFile { absolute_path: String },
    DepotFile { depot_path: String },
    Job { job_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSearchHighlight {
    pub field: String,
    /// UTF-16 offsets so browser consumers can apply the range directly.
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSearchItem {
    pub identity: String,
    pub kind: GlobalSearchKind,
    pub title: String,
    pub summary: String,
    pub target: GlobalSearchTarget,
    pub matched_fields: Vec<String>,
    pub highlights: Vec<GlobalSearchHighlight>,
    /// Internal deterministic relevance rank. Serialized for an explicit contract.
    pub rank: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSearchGroup {
    pub kind: GlobalSearchKind,
    pub items: Vec<GlobalSearchItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSearchFacet {
    pub kind: GlobalSearchKind,
    pub matched_count: usize,
    pub scanned_count: usize,
    pub partial: bool,
    pub error: Option<GlobalSearchCategoryError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSearchCategoryError {
    pub code: GlobalSearchErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GlobalSearchErrorCode {
    Cancelled,
    Timeout,
    PermissionDenied,
    ConnectionChanged,
    QueryFailed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GlobalSearchRequestErrorCode {
    InvalidQuery,
    InvalidCursor,
    CursorExpired,
    ConnectionChanged,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSearchRequestError {
    pub code: GlobalSearchRequestErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSearchStats {
    pub scanned_count: usize,
    pub matched_count: usize,
    pub returned_count: usize,
    pub category_failure_count: usize,
    pub safety_limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSearchResult {
    pub request_generation: u64,
    pub normalized_query: String,
    pub groups: Vec<GlobalSearchGroup>,
    pub facets: Vec<GlobalSearchFacet>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
    pub partial: bool,
    pub simulated: bool,
    pub stats: GlobalSearchStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkspacePrimaryState {
    Controlled,
    OpenedEdit,
    OpenedAdd,
    OpenedDelete,
    OpenedMoveAdd,
    OpenedMoveDelete,
    Modified,
    Missing,
    Untracked,
    Ignored,
    OutOfDate,
    NotSynced,
    Conflicted,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceOpenedAction {
    Add,
    Edit,
    Delete,
    MoveAdd,
    MoveDelete,
    Branch,
    Integrate,
    Import,
    Purge,
    Archive,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceReconcileAction {
    Add,
    Edit,
    Delete,
    MoveAdd,
    MoveDelete,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceSyncState {
    Current,
    OutOfDate,
    NotSynced,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceResolveState {
    None,
    Unresolved,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceLocalState {
    Present,
    Missing,
    Modified,
    Untracked,
    Ignored,
    Directory,
    Symlink,
    Unreadable,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceStatusSource {
    Filesystem,
    Fstat,
    Opened,
    ReconcilePreview,
    ResolvePreview,
    Ignore,
    Cache,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceStatusCompleteness {
    Complete,
    Partial,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatusEvidence {
    pub source: WorkspaceStatusSource,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIgnoreMatch {
    pub rule: String,
    pub source: String,
    pub line: Option<u32>,
    pub explanation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatusError {
    pub source: WorkspaceStatusSource,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileStatus {
    pub primary: WorkspacePrimaryState,
    pub opened_action: Option<WorkspaceOpenedAction>,
    pub reconcile_action: Option<WorkspaceReconcileAction>,
    pub sync: WorkspaceSyncState,
    pub resolve: WorkspaceResolveState,
    pub local: WorkspaceLocalState,
    pub mapped: Option<bool>,
    pub moved_file: Option<String>,
    pub ignore: Option<WorkspaceIgnoreMatch>,
    pub completeness: WorkspaceStatusCompleteness,
    pub evidence: Vec<WorkspaceStatusEvidence>,
    pub errors: Vec<WorkspaceStatusError>,
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
    pub status: WorkspaceFileStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceListing {
    pub items: Vec<WorkspaceNode>,
    pub completeness: WorkspaceStatusCompleteness,
    pub errors: Vec<WorkspaceStatusError>,
    pub operation_ids: Vec<String>,
    pub truncated: bool,
    pub safety_limit: usize,
    pub cache_freshness: String,
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
pub struct RenameMovePreflightRequest {
    pub source_path: String,
    pub target_path: String,
    pub target_change_id: i64,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenameMoveMapping {
    pub depot_path: String,
    pub client_path: String,
    pub local_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenameMoveSourceState {
    pub action: String,
    pub change_id: i64,
    pub file_type: Option<String>,
    pub have_revision: Option<i64>,
    pub head_revision: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenameMoveTargetSnapshot {
    pub server: String,
    pub user: String,
    pub client: String,
    pub workspace: String,
    pub active_profile_id: Option<String>,
    pub context_generation: u64,
    pub source: RenameMoveMapping,
    pub target: RenameMoveMapping,
    pub source_state: RenameMoveSourceState,
    pub target_change_id: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RenameMoveIssueCode {
    InvalidPath,
    SourceMissing,
    SourceUnmapped,
    TargetUnmapped,
    CrossWorkspace,
    TargetExists,
    SourceNotOpened,
    InvalidChangelist,
    CaseOnlyRename,
    InspectionUnavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenameMoveIssue {
    pub code: RenameMoveIssueCode,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameMovePreflight {
    pub ready: bool,
    pub source: Option<RenameMoveMapping>,
    pub target: Option<RenameMoveMapping>,
    pub source_state: Option<RenameMoveSourceState>,
    pub target_change_id: i64,
    pub target_change_valid: bool,
    pub target_exists: bool,
    pub case_only_risk: bool,
    pub blockers: Vec<RenameMoveIssue>,
    pub warnings: Vec<RenameMoveIssue>,
    pub target_snapshot: Option<RenameMoveTargetSnapshot>,
    pub preview_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    pub expires_at: i64,
    pub ttl_ms: u64,
    pub operation_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_reference: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameMoveConfirmation {
    pub token: String,
    pub target: RenameMoveTargetSnapshot,
    pub preview_digest: String,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RenameMoveOutcome {
    Succeeded,
    Rejected,
    Failed,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RenameMoveFailureCode {
    TokenUnknown,
    TokenExpired,
    TargetMismatch,
    ContextChanged,
    SourceChanged,
    TargetChanged,
    PreflightBlocked,
    CommandFailure,
    Cancelled,
    UncertainOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenameMoveRefreshAdvice {
    pub workspace_status: bool,
    pub pending_changes: bool,
    pub depot_paths: Vec<String>,
    pub local_paths: Vec<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameMoveResult {
    pub outcome: RenameMoveOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<RenameMoveFailureCode>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_reference: Option<String>,
    pub refresh: RenameMoveRefreshAdvice,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SyncRevisionKind {
    Head,
    Revision,
    Change,
    Date,
    Label,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncRevisionSpec {
    pub kind: SyncRevisionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPreviewRequest {
    pub paths: Vec<String>,
    pub revision: SyncRevisionSpec,
    #[serde(default)]
    pub force: bool,
    #[serde(default)]
    pub parallel_threads: Option<u8>,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum SyncChangeKind {
    Added,
    Updated,
    Deleted,
    UpToDate,
    Warning,
    Conflict,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncPlanEntry {
    pub kind: SyncChangeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depot_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum SyncIssueCode {
    InvalidTarget,
    NotInClient,
    WritableClobber,
    OpenedFile,
    UnresolvedFile,
    PermissionDenied,
    DiskSpace,
    Offline,
    ServerUnreachable,
    AuthExpired,
    ForceOverwrite,
    PreviewFailed,
    InspectionUnknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncIssue {
    pub code: SyncIssueCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncTargetSnapshot {
    pub server: String,
    pub user: String,
    pub client: String,
    pub workspace: String,
    pub context_generation: u64,
    pub paths: Vec<String>,
    pub revision: SyncRevisionSpec,
    pub force: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parallel_threads: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncPlanCounts {
    pub added: usize,
    pub updated: usize,
    pub deleted: usize,
    pub up_to_date: usize,
    pub warnings: usize,
    pub conflicts: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPreviewPlan {
    pub ready: bool,
    pub target: SyncTargetSnapshot,
    pub counts: SyncPlanCounts,
    pub entries: Vec<SyncPlanEntry>,
    pub total_entries: usize,
    pub truncated: bool,
    pub partial: bool,
    pub blockers: Vec<SyncIssue>,
    pub warnings: Vec<SyncIssue>,
    pub content_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    pub expires_at: i64,
    pub ttl_ms: u64,
    pub operation_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_reference: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfirmRequest {
    pub token: String,
    pub target: SyncTargetSnapshot,
    #[serde(default)]
    pub acknowledge_force: bool,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SyncOutcome {
    Succeeded,
    Partial,
    Rejected,
    Failed,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SyncFailureCode {
    TokenUnknown,
    TokenExpired,
    TargetMismatch,
    ContextChanged,
    PreviewChanged,
    PreflightBlocked,
    ForceAcknowledgementRequired,
    PermissionDenied,
    DiskSpace,
    Offline,
    ServerUnreachable,
    AuthExpired,
    CommandFailure,
    Cancelled,
    UncertainOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub outcome: SyncOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<SyncFailureCode>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_reference: Option<String>,
    pub affected_paths: Vec<String>,
    pub counts: SyncPlanCounts,
    pub refresh_workspace: bool,
    pub refresh_depot: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StreamSwitchMode {
    ViewOnly,
    Sync,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamSwitchPreflightRequest {
    pub target_stream: String,
    pub mode: StreamSwitchMode,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamSwitchRiskSummary {
    pub opened_files: usize,
    pub unresolved_files: usize,
    pub reconcile_files: usize,
    pub target_file_count: Option<u64>,
    pub target_file_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamSwitchTargetSnapshot {
    pub server: String,
    pub user: String,
    pub client: String,
    pub workspace: String,
    pub active_profile_id: Option<String>,
    pub context_generation: u64,
    pub current_stream: Option<String>,
    pub target_stream: String,
    pub target_type: String,
    pub target_parent: Option<String>,
    pub mode: StreamSwitchMode,
    pub client_spec_digest: String,
    pub stream_spec_digest: String,
    pub risk_digest: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum StreamSwitchIssueCode {
    InvalidTarget,
    MissingWorkspaceRoot,
    ClassicWorkspace,
    SameStream,
    UnsupportedStreamType,
    ClientOwnerMismatch,
    LockedClient,
    OpenedFiles,
    UnresolvedFiles,
    LocalChanges,
    AuthenticationRequired,
    PermissionDenied,
    ConnectionUnavailable,
    InspectionUnavailable,
    SyncChangesWorkspace,
    VirtualStream,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamSwitchIssue {
    pub code: StreamSwitchIssueCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamSwitchPreflight {
    pub ready: bool,
    pub current_stream: Option<String>,
    pub target_stream: String,
    pub target_type: Option<String>,
    pub target_parent: Option<String>,
    pub mode: StreamSwitchMode,
    pub sync_required: bool,
    pub risks: StreamSwitchRiskSummary,
    pub blockers: Vec<StreamSwitchIssue>,
    pub warnings: Vec<StreamSwitchIssue>,
    pub target_snapshot: Option<StreamSwitchTargetSnapshot>,
    pub preview_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    pub expires_at: i64,
    pub ttl_ms: u64,
    pub operation_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_reference: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamSwitchConfirmation {
    pub token: String,
    pub target: StreamSwitchTargetSnapshot,
    pub preview_digest: String,
    pub acknowledge_warnings: bool,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StreamSwitchOutcome {
    Succeeded,
    Rejected,
    Failed,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StreamSwitchFailureCode {
    TokenUnknown,
    TokenExpired,
    TargetMismatch,
    WarningAcknowledgementRequired,
    ContextChanged,
    PreflightChanged,
    PreflightBlocked,
    SwitchFailed,
    VerificationFailed,
    SyncFailed,
    Cancelled,
    UncertainOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamSwitchRefreshAdvice {
    pub workspace: bool,
    pub streams: bool,
    pub pending_changes: bool,
    pub submitted_changes: bool,
    pub search: bool,
    pub depot: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamSwitchResult {
    pub outcome: StreamSwitchOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<StreamSwitchFailureCode>,
    pub message: String,
    pub stream_changed: bool,
    pub sync_performed: bool,
    pub sync_completed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified_stream: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_reference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<RuntimeInfo>,
    pub refresh: StreamSwitchRefreshAdvice,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RevisionReference {
    Workspace,
    Have,
    Head,
    Revision { revision: i64 },
    Shelf { change_id: i64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileReviewScope {
    pub server: String,
    pub user: String,
    pub client: String,
    pub workspace: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_profile_id: Option<String>,
    pub context_generation: u64,
    pub file_identity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiffRequest {
    pub scope: FileReviewScope,
    pub left: RevisionReference,
    pub right: RevisionReference,
    #[serde(default)]
    pub refresh: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSide {
    pub reference: RevisionReference,
    pub label: String,
    pub depot_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    pub exists: bool,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiffStats {
    pub additions: usize,
    pub deletions: usize,
    pub hunks: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub path: String,
    pub left: DiffSide,
    pub right: DiffSide,
    pub unified: String,
    pub stats: DiffStats,
    pub binary: bool,
    pub unsupported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub identical: bool,
    pub truncated: bool,
    pub partial: bool,
    pub operation_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShelfFilePreviewRequest {
    pub scope: FileReviewScope,
    pub change_id: i64,
    #[serde(default)]
    pub refresh: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfFilePreview {
    pub side: DiffSide,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    pub encoding: String,
    pub truncated: bool,
    pub unsupported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub operation_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileIntegration {
    pub relationship: String,
    pub kind: String,
    pub direction: String,
    pub related_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_revision: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRevision {
    pub depot_path: String,
    pub revision: i64,
    pub changelist_id: i64,
    pub user: String,
    pub action: String,
    pub file_type: String,
    pub time: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_size: Option<u64>,
    pub integrations: Vec<FileIntegration>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileHistoryRequest {
    pub scope: FileReviewScope,
    pub page_size: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default)]
    pub refresh: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryPage {
    pub items: Vec<FileRevision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub has_more: bool,
    pub partial: bool,
    pub truncated: bool,
    pub operation_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevisionGraphRequest {
    pub scope: FileReviewScope,
    pub revision_limit: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default)]
    pub refresh: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionGraphNode {
    pub id: String,
    pub depot_path: String,
    pub revision: i64,
    pub changelist_id: i64,
    pub action: String,
    pub file_type: String,
    pub label: String,
    pub x: i64,
    pub y: i64,
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionGraphEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub kind: String,
    pub relationship: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_revision: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionGraph {
    pub nodes: Vec<RevisionGraphNode>,
    pub edges: Vec<RevisionGraphEdge>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub has_more: bool,
    pub partial: bool,
    pub truncated: bool,
    pub operation_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingFile {
    pub depot_path: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_type: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingChange {
    pub id: i64,
    pub description: String,
    pub user: String,
    pub client: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    pub jobs: Vec<String>,
    pub files: Vec<PendingFile>,
    pub shelved_files: Vec<PendingFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PendingChangeSort {
    Newest,
    Oldest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingChangeQuery {
    pub operation_id: String,
    pub request_generation: u64,
    pub keyword: String,
    pub sort: PendingChangeSort,
    pub page_size: usize,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PendingChangeQueryStats {
    pub scanned_count: usize,
    pub matched_count: usize,
    pub truncated_by_safety_limit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingChangePage {
    pub request_generation: u64,
    pub default_change: Option<PendingChange>,
    pub items: Vec<PendingChange>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
    pub partial: bool,
    pub stats: PendingChangeQueryStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PendingChangeMutation {
    Create {
        description: String,
        #[serde(default)]
        jobs: Vec<String>,
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
        target_change_id: i64,
        depot_paths: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingChangeMutationRequest {
    #[serde(default)]
    pub operation_id: Option<String>,
    #[serde(flatten)]
    pub mutation: PendingChangeMutation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingChangeMutationResult {
    pub operation: OperationResult,
    pub created_change_id: Option<i64>,
    pub affected_changes: Vec<i64>,
    pub affected_paths: Vec<String>,
    pub refreshed_changes: Vec<PendingChange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitPreflightRequest {
    pub change_id: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SubmitIssueCode {
    InvalidTarget,
    ChangeNotFound,
    EmptyDescription,
    EmptyChange,
    UnresolvedFiles,
    OutOfDateFiles,
    LockedFiles,
    ExclusiveOpenConflict,
    PermissionDenied,
    ShelvedFilesPresent,
    JobMissing,
    JobPolicyUnknown,
    FileStateUnknown,
    PermissionUnknown,
    PreflightUnavailable,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SubmitIssueCertainty {
    Confirmed,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubmitIssue {
    pub code: SubmitIssueCode,
    pub certainty: SubmitIssueCertainty,
    pub message: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubmitTargetSnapshot {
    pub server: String,
    pub user: String,
    pub client: String,
    pub workspace: String,
    pub change_id: i64,
    pub context_generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubmitFileSummary {
    pub file_count: usize,
    pub depot_paths: Vec<String>,
    pub action_counts: std::collections::BTreeMap<String, usize>,
    pub content_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitPreflight {
    pub ready: bool,
    pub change: Option<PendingChange>,
    pub blockers: Vec<SubmitIssue>,
    pub warnings: Vec<SubmitIssue>,
    pub target: SubmitTargetSnapshot,
    pub file_summary: SubmitFileSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    pub expires_at: i64,
    pub ttl_ms: u64,
    pub operation_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_reference: Option<String>,
    pub refresh_recommended: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitConfirmation {
    pub token: String,
    pub target: SubmitTargetSnapshot,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SubmitOutcome {
    Submitted,
    Rejected,
    Failed,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SubmitFailureCode {
    TokenUnknown,
    TokenExpired,
    TargetMismatch,
    ContextChanged,
    ChangeChanged,
    PreflightBlocked,
    Offline,
    ServerUnreachable,
    AuthExpired,
    PermissionDenied,
    CommandFailure,
    Cancelled,
    UncertainOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubmitRefreshAdvice {
    pub pending_changes: bool,
    pub submitted_changes: bool,
    pub workspace_status: bool,
    pub depot_paths: Vec<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitResult {
    pub outcome: SubmitOutcome,
    pub change_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submitted_change_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<SubmitFailureCode>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_reference: Option<String>,
    pub refresh: SubmitRefreshAdvice,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowIssueCertainty {
    Confirmed,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowIssueCode {
    InvalidTarget,
    ChangeNotFound,
    FileNotInChange,
    FileNotShelved,
    ExistingShelfRequiresReplace,
    MappingFailed,
    LocalModification,
    AlreadyOpened,
    LockedFile,
    PermissionDenied,
    PermissionUnknown,
    ResolveLikely,
    ResolveRequired,
    NotResolvable,
    InspectionUnknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowIssue {
    pub code: WorkflowIssueCode,
    pub certainty: WorkflowIssueCertainty,
    pub message: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowTargetSnapshot {
    pub kind: String,
    pub server: String,
    pub user: String,
    pub client: String,
    pub workspace: String,
    pub context_generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_change_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_change_id: Option<i64>,
    pub depot_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRefreshAdvice {
    pub pending_changes: bool,
    pub workspace_status: bool,
    pub depot_paths: Vec<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfPreflightRequest {
    pub change_id: i64,
    pub depot_paths: Vec<String>,
    pub mode: ShelfMode,
    #[serde(default)]
    pub replace: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ShelfMode {
    CreateOrUpdate,
    Delete,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShelfScopeSummary {
    pub opened_paths: Vec<String>,
    pub existing_shelved_paths: Vec<String>,
    pub create_paths: Vec<String>,
    pub replace_paths: Vec<String>,
    pub delete_paths: Vec<String>,
    pub content_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfPreflight {
    pub ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change: Option<PendingChange>,
    pub blockers: Vec<WorkflowIssue>,
    pub warnings: Vec<WorkflowIssue>,
    pub target: WorkflowTargetSnapshot,
    pub scope: ShelfScopeSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    pub expires_at: i64,
    pub ttl_ms: u64,
    pub operation_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_reference: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveFilesPreflightRequest {
    pub target_change_id: i64,
    pub depot_paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MoveFileCandidate {
    pub depot_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_change_id: Option<i64>,
    pub action: String,
    pub movable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveFilesPreflight {
    pub ready: bool,
    pub target: WorkflowTargetSnapshot,
    pub files: Vec<MoveFileCandidate>,
    pub blockers: Vec<WorkflowIssue>,
    pub warnings: Vec<WorkflowIssue>,
    pub content_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    pub expires_at: i64,
    pub ttl_ms: u64,
    pub operation_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_reference: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveFilesResult {
    pub outcome: WorkflowOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<WorkflowFailureCode>,
    pub message: String,
    pub operation_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_reference: Option<String>,
    pub files: Vec<WorkflowFileResult>,
    pub affected_changes: Vec<i64>,
    pub refreshed_changes: Vec<PendingChange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_error: Option<String>,
    pub refresh: WorkflowRefreshAdvice,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowConfirmation {
    pub token: String,
    pub target: WorkflowTargetSnapshot,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnshelvePreflightRequest {
    pub source_change_id: i64,
    pub depot_paths: Vec<String>,
    pub target_workspace: String,
    pub target_change_id: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResolveRisk {
    None,
    Likely,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnshelveMapping {
    pub depot_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_path: Option<String>,
    pub mapped: bool,
    pub locally_modified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opened_change_id: Option<i64>,
    pub locked: bool,
    pub resolve_risk: ResolveRisk,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnshelvePreflight {
    pub ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<PendingChange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_change: Option<PendingChange>,
    pub mappings: Vec<UnshelveMapping>,
    pub blockers: Vec<WorkflowIssue>,
    pub warnings: Vec<WorkflowIssue>,
    pub target: WorkflowTargetSnapshot,
    pub content_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    pub expires_at: i64,
    pub ttl_ms: u64,
    pub operation_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_reference: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResolveStrategy {
    Safe,
    AcceptYours,
    AcceptTheirs,
    MergePreview,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvePreflightRequest {
    pub depot_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolveVersionSource {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depot_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolveConflictDetail {
    pub depot_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_path: Option<String>,
    pub conflict_type: String,
    pub status: String,
    pub available_strategies: Vec<ResolveStrategy>,
    pub sources: Vec<ResolveVersionSource>,
    pub preview: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvePreflight {
    pub ready: bool,
    pub conflicts: Vec<ResolveConflictDetail>,
    pub blockers: Vec<WorkflowIssue>,
    pub warnings: Vec<WorkflowIssue>,
    pub target: WorkflowTargetSnapshot,
    pub content_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    pub expires_at: i64,
    pub ttl_ms: u64,
    pub operation_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_reference: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolveSelection {
    pub depot_path: String,
    pub strategy: ResolveStrategy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveConfirmation {
    pub token: String,
    pub target: WorkflowTargetSnapshot,
    #[serde(default)]
    pub operation_id: Option<String>,
    pub resolutions: Vec<ResolveSelection>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowFileState {
    Succeeded,
    Failed,
    Cancelled,
    Blocked,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowFileResult {
    pub depot_path: String,
    pub state: WorkflowFileState,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowOutcome {
    Succeeded,
    Partial,
    Rejected,
    Failed,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowFailureCode {
    TokenUnknown,
    TokenExpired,
    TargetMismatch,
    ContextChanged,
    ContentChanged,
    PreflightBlocked,
    PermissionDenied,
    CommandFailure,
    Cancelled,
    UncertainOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowResult {
    pub outcome: WorkflowOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<WorkflowFailureCode>,
    pub message: String,
    pub operation_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_reference: Option<String>,
    pub files: Vec<WorkflowFileResult>,
    pub refresh: WorkflowRefreshAdvice,
}
