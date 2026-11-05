use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct P4Context {
    pub executable: Option<String>,
    #[serde(default)]
    pub custom_submit_executable_path: String,
    pub server: String,
    pub user: String,
    pub client: String,
    pub cwd: Option<String>,
    pub charset: Option<String>,
    pub trust_path: Option<String>,
    pub tickets_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swarm_base_url: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConnectionProfileRequest {
    pub expected_revision: u64,
    pub id: String,
    pub name: String,
    pub context: P4Context,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteConnectionProfileRequest {
    pub expected_revision: u64,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetActiveConnectionProfileRequest {
    pub expected_revision: u64,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchWorkspaceRequest {
    pub expected_generation: u64,
    pub client: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSwarmLinkRequest {
    pub url: String,
    pub expected_profile_id: Option<String>,
    pub expected_context_generation: u64,
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
    /// R9: family of this command; decides the enforced time limit. Callers fill
    /// it from `p4::bounds::IoBound`, the one place the limits are defined.
    #[serde(default)]
    pub bound: crate::p4::bounds::IoBound,
    /// Optional narrowing of [`Self::bound`]; a request can only shorten its
    /// family limit, never extend it.
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

/// Result of a cancel request. Cancel is an intent signal only: it never claims
/// a server-side rollback and never proves an operation did not previously run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelOperationResult {
    pub operation_id: String,
    /// "cancelRequested" | "notFound" | "unknown"
    pub state: String,
    pub matched_operations: usize,
    /// Always false: cancellation is not a rollback and never undoes a submit/write.
    pub server_rollback_claimed: bool,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P4VfsInspectRequest {
    pub expected_context_generation: u64,
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct P4VfsStatus {
    pub context_generation: u64,
    pub workspace: String,
    pub mode: WorkspaceSyncMode,
    pub ready: bool,
    pub server_version: Option<String>,
    pub server_supported: bool,
    pub client_version: Option<String>,
    pub client_supported: bool,
    pub agent_configured: bool,
    pub reason: Option<String>,
    pub operation_ids: Vec<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionDirectoryRequest {
    pub context: P4Context,
    pub request_generation: u64,
    pub operation_id: Option<String>,
    pub prefix: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionUserCandidate {
    pub name: String,
    pub full_name: Option<String>,
    pub email: Option<String>,
    pub accessed: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionWorkspaceRootStatus {
    Usable,
    Missing,
    NotDirectory,
    OtherHost,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionWorkspaceCandidate {
    pub name: String,
    pub owner: String,
    pub host: String,
    pub root: String,
    pub stream: String,
    pub description: String,
    pub updated: Option<i64>,
    pub accessed: Option<i64>,
    pub root_status: ConnectionWorkspaceRootStatus,
    pub selectable: bool,
    #[serde(default)]
    pub sync_mode: WorkspaceSyncMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionDirectoryStats {
    pub scanned_count: usize,
    pub matched_count: usize,
    pub safety_limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionUserDirectoryResult {
    pub request_generation: u64,
    pub items: Vec<ConnectionUserCandidate>,
    pub partial: bool,
    pub truncated: bool,
    pub stats: ConnectionDirectoryStats,
    pub operation_ids: Vec<String>,
    pub connection: ConnectionStatus,
    pub simulated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionWorkspaceDirectoryResult {
    pub request_generation: u64,
    pub items: Vec<ConnectionWorkspaceCandidate>,
    pub partial: bool,
    pub truncated: bool,
    pub stats: ConnectionDirectoryStats,
    pub operation_ids: Vec<String>,
    pub connection: ConnectionStatus,
    pub simulated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionUserCreatePlan {
    pub name: String,
    pub full_name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionClassicViewLine {
    pub depot_path: String,
    pub client_path: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceSyncMode {
    #[default]
    Standard,
    Virtual,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConnectionWorkspaceMapping {
    Stream {
        stream: String,
    },
    Classic {
        view: Vec<ConnectionClassicViewLine>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionWorkspaceCreatePlan {
    pub name: String,
    pub root: String,
    pub description: Option<String>,
    pub mapping: ConnectionWorkspaceMapping,
    #[serde(default)]
    pub sync_mode: WorkspaceSyncMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionUserCreatePreflightRequest {
    pub context: P4Context,
    pub request_generation: u64,
    pub operation_id: Option<String>,
    pub plan: ConnectionUserCreatePlan,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionWorkspaceCreatePreflightRequest {
    pub context: P4Context,
    pub request_generation: u64,
    pub operation_id: Option<String>,
    pub plan: ConnectionWorkspaceCreatePlan,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionSpecIssueCode {
    InvalidInput,
    AuthenticationRequired,
    PermissionDenied,
    AlreadyExists,
    ConnectionChanged,
    Cancelled,
    VerificationFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSpecIssue {
    pub code: ConnectionSpecIssueCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionSpecKind {
    UserSelf,
    Workspace,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSpecCreatePreflight {
    pub ready: bool,
    pub kind: ConnectionSpecKind,
    pub name: String,
    pub request_generation: u64,
    pub state_digest: String,
    pub token: Option<String>,
    pub expires_at: i64,
    pub blockers: Vec<ConnectionSpecIssue>,
    pub warnings: Vec<ConnectionSpecIssue>,
    pub operation_ids: Vec<String>,
    pub simulated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSpecCreateConfirmation {
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    pub context: P4Context,
    pub request_generation: u64,
    pub state_digest: String,
    pub confirmed: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionSpecCreateOutcome {
    Created,
    Rejected,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSpecCreateResult {
    pub outcome: ConnectionSpecCreateOutcome,
    pub failure: Option<ConnectionSpecIssueCode>,
    pub kind: ConnectionSpecKind,
    pub name: String,
    pub message: String,
    pub operation_ids: Vec<String>,
    pub workspace: Option<ConnectionWorkspaceCandidate>,
    pub simulated: bool,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub context: P4Context,
    pub password: String,
    pub confirmed: bool,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticationRequest {
    pub context: P4Context,
    pub confirmed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum LogLevel {
    Info,
    Warning,
    Error,
    /// A P4 command cancelled by the user (or by a context switch) before it finished.
    /// Its exit code is usually non-zero, but cancellation is not a failure: the journal
    /// records it as `cancelled`, so the log must not classify it as an error either.
    Cancelled,
}

impl<'de> Deserialize<'de> for LogLevel {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "info" => Self::Info,
            "warning" => Self::Warning,
            "error" => Self::Error,
            "cancelled" => Self::Cancelled,
            // Forward compatibility: a level written by a newer build must not make the whole
            // entry (or query filter) unreadable; unknown values fall back to `info`.
            _ => Self::Info,
        })
    }
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
    #[serde(default)]
    pub streams: Vec<String>,
    pub from: String,
    pub to: String,
    #[serde(default)]
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
    #[serde(default)]
    pub expected_generation: Option<u64>,
    #[serde(default)]
    pub refresh: bool,
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
    /// `"submitted"`, `"pending"`, `"shelved"`, or `"unknown"` (inspection unavailable).
    pub status: String,
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
    Stream,
    Shelf,
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
    Stream { stream_path: String },
    Shelf { change_id: i64 },
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partial_reason: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamGraphQuery {
    pub operation_id: String,
    pub request_generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depot_prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default)]
    pub include_deleted: bool,
    pub page_size: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct StreamFlowOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_parent: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_parent: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merge_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub all_submit: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamGraphNode {
    pub stream: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_view: Option<String>,
    pub flow_options: StreamFlowOptions,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamGraphEdge {
    pub parent: String,
    pub child: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamGraphScope {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_profile_id: Option<String>,
    pub context_generation: u64,
    pub server: String,
    pub user: String,
    pub client: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depot_prefix: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamGraphStats {
    pub scanned_count: usize,
    pub matched_count: usize,
    pub returned_count: usize,
    pub duplicate_count: usize,
    pub invalid_relation_count: usize,
    pub safety_limit: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StreamGraphCacheFreshness {
    Fresh,
    Cached,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamGraphResult {
    pub request_generation: u64,
    pub scope: StreamGraphScope,
    pub nodes: Vec<StreamGraphNode>,
    pub edges: Vec<StreamGraphEdge>,
    pub roots: Vec<String>,
    pub orphans: Vec<String>,
    pub has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub partial: bool,
    pub truncated: bool,
    pub stats: StreamGraphStats,
    pub operation_ids: Vec<String>,
    pub cache_freshness: StreamGraphCacheFreshness,
    pub simulated: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StreamGraphRequestErrorCode {
    InvalidQuery,
    InvalidCursor,
    CursorExpired,
    ConnectionChanged,
    Cancelled,
    QueryFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct StreamGraphRequestError {
    pub code: StreamGraphRequestErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchMappingQuery {
    pub operation_id: String,
    pub request_generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_filter: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    pub page_size: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchMappingSummary {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchMappingScope {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_profile_id: Option<String>,
    pub context_generation: u64,
    pub server: String,
    pub user: String,
    pub client: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchMappingStats {
    pub scanned_count: usize,
    pub matched_count: usize,
    pub returned_count: usize,
    pub invalid_record_count: usize,
    pub safety_limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchMappingPage {
    pub request_generation: u64,
    pub scope: BranchMappingScope,
    pub items: Vec<BranchMappingSummary>,
    pub has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub partial: bool,
    pub truncated: bool,
    pub stats: BranchMappingStats,
    pub operation_ids: Vec<String>,
    pub simulated: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BranchViewModifier {
    Map,
    Exclude,
    Overlay,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchViewLine {
    pub modifier: BranchViewModifier,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unknown: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchUnknownField {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchMappingDetail {
    pub name: String,
    pub owner: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access: Option<String>,
    pub description: String,
    pub locked: bool,
    pub view: Vec<BranchViewLine>,
    pub unknown_fields: Vec<BranchUnknownField>,
    pub editable: bool,
    pub operation_ids: Vec<String>,
    pub simulated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchMappingDetailQuery {
    #[serde(default)]
    pub expected_generation: Option<u64>,
    pub operation_id: String,
    pub request_generation: u64,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchMappingDetailResult {
    pub request_generation: u64,
    pub scope: BranchMappingScope,
    pub detail: BranchMappingDetail,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BranchImpactDirection {
    Forward,
    Reverse,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchImpactPreviewQuery {
    pub operation_id: String,
    pub request_generation: u64,
    pub name: String,
    pub direction: BranchImpactDirection,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchImpactItem {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BranchIssueCode {
    InvalidInput,
    NotFound,
    AlreadyExists,
    OwnerMismatch,
    PermissionDenied,
    Locked,
    DestructiveDelete,
    UnknownFields,
    WorkspaceUnmapped,
    PreviewUnavailable,
    ContextChanged,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchIssue {
    pub code: BranchIssueCode,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchImpactPreview {
    pub request_generation: u64,
    pub name: String,
    pub direction: BranchImpactDirection,
    pub items: Vec<BranchImpactItem>,
    pub blockers: Vec<BranchIssue>,
    pub partial: bool,
    pub truncated: bool,
    pub scanned_count: usize,
    pub safety_limit: usize,
    pub operation_ids: Vec<String>,
    pub simulated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchMappingDraft {
    pub name: String,
    pub owner: String,
    pub description: String,
    pub locked: bool,
    pub view: Vec<BranchViewLine>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BranchMutationMode {
    Create,
    Edit,
    Delete,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchMutationPreflightRequest {
    pub mode: BranchMutationMode,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desired: Option<BranchMappingDraft>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchMutationTarget {
    pub active_profile_id: Option<String>,
    pub context_generation: u64,
    pub server: String,
    pub user: String,
    pub client: String,
    pub mode: BranchMutationMode,
    pub name: String,
    pub current_exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desired: Option<BranchMappingDraft>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desired_digest: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchMutationPreflight {
    pub ready: bool,
    pub mode: BranchMutationMode,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<BranchMappingDetail>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desired: Option<BranchMappingDraft>,
    pub blockers: Vec<BranchIssue>,
    pub warnings: Vec<BranchIssue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<BranchMutationTarget>,
    pub preview_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    pub expires_at: i64,
    pub ttl_ms: u64,
    pub operation_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchMutationConfirmation {
    pub token: String,
    pub target: BranchMutationTarget,
    pub preview_digest: String,
    #[serde(default)]
    pub acknowledge_dangerous_delete: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BranchMutationOutcome {
    Succeeded,
    Rejected,
    Failed,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BranchMutationFailureCode {
    TokenUnknown,
    TokenExpired,
    TargetMismatch,
    DangerousConfirmationRequired,
    ContextChanged,
    PreflightChanged,
    PermissionDenied,
    CommandFailure,
    Cancelled,
    UncertainOutcome,
    VerificationFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchMutationResult {
    pub outcome: BranchMutationOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<BranchMutationFailureCode>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed: Option<BranchMappingDetail>,
    pub operation_ids: Vec<String>,
    pub refresh_branch_mappings: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BranchMappingRequestErrorCode {
    InvalidQuery,
    InvalidCursor,
    CursorExpired,
    ConnectionChanged,
    Cancelled,
    NotFound,
    QueryFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct BranchMappingRequestError {
    pub code: BranchMappingRequestErrorCode,
    pub message: String,
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
    /// Integration/resolve records exist but every one is already resolved (not yet submitted).
    Resolved,
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
    pub file_type: Option<String>,
    pub exclusive_open: Option<bool>,
    pub lock_ownership: Option<FileLockOwnership>,
    pub lock_owner: Option<String>,
    pub other_open: Vec<String>,
    pub can_lock: Option<bool>,
    pub can_unlock: Option<bool>,
    pub lock_reason: Option<String>,
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
    #[serde(default)]
    pub revert_whole_changelist: bool,
    /// Opt-in P4-native transfer parallelism. Kept small by the command planner.
    #[serde(default)]
    pub parallel_threads: Option<u8>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileActionResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<FileActionExecution>,
    pub operation: Option<OperationResult>,
    pub affected_paths: Vec<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileActionExecution {
    pub operation_id: String,
    /// `commandCompleted` | `unknown` for migrated P4 writes; local I/O may also
    /// return `notDispatched`.
    pub outcome: String,
    /// `notCollected` for migrated P4 writes; `localIoAcknowledgements` for
    /// sequential local I/O.
    pub per_file_evidence: String,
    /// One row per requested target, in request order. Filled by local I/O
    /// only; migrated P4 writes leave it absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<WorkflowFileResult>>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileLockOperation {
    Lock,
    Unlock,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileLockOwnership {
    Unlocked,
    Ours,
    Other,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileLockPermission {
    Allowed,
    Denied,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileLockPreflightRequest {
    pub operation: FileLockOperation,
    pub paths: Vec<String>,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileLockFileSnapshot {
    pub input_path: String,
    pub depot_path: String,
    pub client_path: String,
    pub local_path: Option<String>,
    pub opened_action: String,
    pub changelist_id: i64,
    pub file_type: String,
    pub exclusive: bool,
    pub ownership: FileLockOwnership,
    pub lock_owner: Option<String>,
    pub other_open: Vec<String>,
    pub permission: FileLockPermission,
    pub applicable: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileLockTargetSnapshot {
    pub server: String,
    pub user: String,
    pub client: String,
    pub workspace: String,
    pub active_profile_id: Option<String>,
    pub context_generation: u64,
    pub operation: FileLockOperation,
    pub files: Vec<FileLockFileSnapshot>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileLockIssueCode {
    InvalidTarget,
    ConnectionUnavailable,
    AuthenticationRequired,
    OutsideClientView,
    NotOpened,
    UnsupportedAction,
    AlreadyLocked,
    NotLocked,
    LockedByOther,
    PermissionDenied,
    PermissionUnknown,
    StateUnknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileLockIssueCertainty {
    Confirmed,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileLockIssue {
    pub code: FileLockIssueCode,
    pub certainty: FileLockIssueCertainty,
    pub message: String,
    #[serde(default)]
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileLockCounts {
    pub requested: usize,
    pub applicable: usize,
    pub already_satisfied: usize,
    pub blocked: usize,
    pub exclusive: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLockPreflight {
    pub ready: bool,
    pub operation: FileLockOperation,
    pub files: Vec<FileLockFileSnapshot>,
    pub counts: FileLockCounts,
    pub blockers: Vec<FileLockIssue>,
    pub warnings: Vec<FileLockIssue>,
    pub target_snapshot: Option<FileLockTargetSnapshot>,
    pub state_digest: String,
    pub token: Option<String>,
    pub expires_at: i64,
    pub ttl_ms: u64,
    pub operation_ids: Vec<String>,
    pub log_reference: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileLockConfirmation {
    pub token: String,
    pub target: FileLockTargetSnapshot,
    pub state_digest: String,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileLockFileOutcome {
    Succeeded,
    AlreadySatisfied,
    Failed,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileLockFileResult {
    pub depot_path: String,
    pub outcome: FileLockFileOutcome,
    pub message: String,
    pub ownership: FileLockOwnership,
    pub lock_owner: Option<String>,
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileLockOutcome {
    Succeeded,
    Partial,
    Rejected,
    Failed,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileLockFailureCode {
    TokenUnknown,
    TokenExpired,
    TargetMismatch,
    ContextChanged,
    StateChanged,
    PreflightBlocked,
    CommandFailure,
    Cancelled,
    UncertainOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileLockRefreshAdvice {
    pub workspace_status: bool,
    pub pending_changes: bool,
    pub search: bool,
    pub review: bool,
    pub depot_paths: Vec<String>,
    pub local_paths: Vec<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLockResult {
    /// S3a-style additive envelope. `commandCompleted` means a dispatched lock
    /// lifecycle produced known per-file facts; `unknown` means at least one
    /// per-file effect is unconfirmed. Pre-dispatch rejections leave it absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<FileActionExecution>,
    pub outcome: FileLockOutcome,
    pub failure: Option<FileLockFailureCode>,
    pub message: String,
    pub files: Vec<FileLockFileResult>,
    pub operation_id: Option<String>,
    pub log_reference: Option<String>,
    pub refresh: FileLockRefreshAdvice,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right_file_identity: Option<String>,
    pub scope: FileReviewScope,
    pub left: RevisionReference,
    pub right: RevisionReference,
    #[serde(default)]
    pub refresh: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

impl DiffRequest {
    pub fn validate_explicit_pair(&self) -> Result<(), String> {
        if let Some(right) = &self.right_file_identity {
            let valid = |path: &str| {
                path.starts_with("//")
                    && path.len() > 2
                    && !path.contains(['#', '@', '*', '\r', '\n', '\0'])
                    && !path.contains("...")
            };
            if !valid(&self.scope.file_identity)
                || !valid(right)
                || !matches!(self.left, RevisionReference::Revision { revision } if revision > 0)
                || !matches!(self.right, RevisionReference::Revision { revision } if revision > 0)
            {
                return Err("Explicit file comparison requires two exact depot paths and positive revisions".into());
            }
        }
        Ok(())
    }
}
#[cfg(test)]
mod explicit_diff_pair_tests {
    use super::*;
    #[test]
    fn exact_paths_and_revisions_survive_wire_roundtrip() {
        let request: DiffRequest = serde_json::from_value(serde_json::json!({
            "scope": {"server":"fixture", "user":"test", "client":"test", "workspace":"", "contextGeneration":1,"fileIdentity":"//depot/a/file.txt"},
            "left":{"kind":"revision","revision":17}, "right":{"kind":"revision","revision":3}, "rightFileIdentity":"//depot/b/file.txt"
        })).unwrap();
        assert!(request.validate_explicit_pair().is_ok());
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["rightFileIdentity"], "//depot/b/file.txt");
        assert_eq!(value["left"]["revision"], 17);
        assert_eq!(value["right"]["revision"], 3);
        let mut bad = request.clone();
        bad.right = RevisionReference::Have;
        assert!(bad.validate_explicit_pair().is_err());
        bad = request;
        bad.right_file_identity = Some("//depot/...".into());
        assert!(bad.validate_explicit_pair().is_err());
    }
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right_text: Option<String>,
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
    /// Depot head revision from fstat; absent when unknown (never fabricated).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock_ownership: Option<FileLockOwnership>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock_owner: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub other_open: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exclusive_open: Option<bool>,
    /// P4 resolve preview only: present when the opened file needs resolve.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolve: Option<String>,
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
    /// Lifecycle envelope for the migrated submit-native route. Absent for
    /// pre-dispatch rejections (nothing was submitted) and legacy payloads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<SubmitExecution>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitExecution {
    /// "submit"
    pub kind: String,
    pub operation_id: String,
    /// "commandCompleted" | "unknown". Absent envelope == not dispatched.
    pub state: String,
    pub outcome: SubmitOutcome,
    /// Intentionally empty: a submit transaction has no per-file authority;
    /// the authoritative facts are outcome + submittedChangeId.
    pub files: Vec<WorkflowFileResult>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelveDirectRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    pub change_id: i64,
    pub depot_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace: Option<bool>,
}

/// One-step unshelve: the host validates internally (no FE preflight dialog).
/// `target_workspace`/`target_change_id` default to the current client and the default CL.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnshelveDirectRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    pub source_change_id: i64,
    pub depot_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_workspace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_change_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfDeleteDirectRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    pub change_id: i64,
    pub depot_paths: Vec<String>,
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
    /// `p4 resolve -f`: allow re-resolving files that are already resolved but not
    /// yet submitted (the target content is the previous resolution, not the
    /// original workspace content).
    #[serde(default)]
    pub force: bool,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveStatsRequest {
    pub depot_path: String,
    /// `true` when the dialog is re-resolving an already resolved file (`p4 resolve -f`).
    #[serde(default)]
    pub force: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_depot_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_depot_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_revision: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_path: Option<String>,
}

/// Read-only stats for one side of a resolve. Every field is optional because
/// missing/unreadable content is reported as unknown, never fabricated.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResolveVersionStats {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depot_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    /// RFC 3339 when P4 provided a parseable epoch timestamp.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff_blocks: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResolveTargetStats {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff_blocks: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResolveStats {
    pub base: ResolveVersionStats,
    pub source: ResolveVersionStats,
    pub target: ResolveTargetStats,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflicts: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualMergeOpenRequest {
    pub depot_path: String,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManualMergeFileSnapshot {
    pub size: u64,
    pub modified_ms: i64,
    pub content_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManualMergeSource {
    pub depot_path: String,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualMergeSession {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_profile_id: Option<String>,
    pub target: WorkflowTargetSnapshot,
    pub depot_path: String,
    pub local_path: String,
    pub base_source: ManualMergeSource,
    pub theirs_source: ManualMergeSource,
    pub file_snapshot: ManualMergeFileSnapshot,
    pub resolve_digest: String,
    pub base: String,
    pub theirs: String,
    pub yours: String,
    pub result: String,
    pub encoding: String,
    pub line_ending: String,
    pub had_bom: bool,
    pub unresolved_blocks: usize,
    pub expires_at: i64,
    pub operation_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualMergeValidateRequest {
    pub session_id: String,
    pub result: String,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualMergeValidation {
    pub valid: bool,
    pub unresolved_blocks: usize,
    pub result_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    pub expires_at: i64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualMergeSaveConfirmation {
    pub token: String,
    pub session_id: String,
    pub result_digest: String,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualMergeSaveResult {
    pub outcome: WorkflowOutcome,
    pub message: String,
    pub result_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolve_token: Option<String>,
    pub resolve_expires_at: i64,
    pub operation_id: String,
    pub refresh: WorkflowRefreshAdvice,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualMergeResolveConfirmation {
    pub token: String,
    pub session_id: String,
    pub result_digest: String,
    pub acknowledge: bool,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExternalMergeToolSource {
    Env,
    CommonPath,
    Path,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMergeToolInfo {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<ExternalMergeToolSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMergeRunRequest {
    pub session_id: String,
    pub result: String,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExternalMergeStatus {
    Completed,
    Unchanged,
    Cancelled,
    Failed,
    Timeout,
    NotInstalled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMergeRunResult {
    pub status: ExternalMergeStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default)]
    pub operation_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowFileState {
    Retained,
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
    /// Lifecycle envelope used by migrated command slices (S4d SHELF/UNSHELVE).
    /// Absent for legacy payloads and for workflows that only expose the
    /// legacy top-level fields below.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<WorkflowExecution>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowExecution {
    /// "shelf" | "unshelve"
    pub kind: String,
    pub operation_id: String,
    /// "commandCompleted" | "unknown". An absent envelope means the legacy
    /// payload shape.
    pub state: String,
    pub outcome: WorkflowOutcome,
    /// Intentionally empty for SHELF create/replace/update and UNSHELVE: no
    /// per-file authority is claimed; FE must refresh before relying on rows.
    pub files: Vec<WorkflowFileResult>,
}

#[cfg(test)]
mod submitted_filter_contract_tests {
    #[test]
    fn query_without_job_filters_deserializes() {
        let query: super::ClQuery = serde_json::from_value(serde_json::json!({
            "operationId":"offline-test", "requestGeneration":1, "keyword":"", "users":["alice"],
            "clients":[], "from":"2026-10-01T00:00:00Z", "to":"2026-10-26T00:00:00Z",
            "mergeClassifications":[], "hideReliableMerges":false, "pageSize":100
        }))
        .unwrap();
        assert!(query.jobs.is_empty());
        assert_eq!(query.has_job, None);
        assert_eq!(query.users, vec!["alice"]);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceMutationAction {
    Rename,
    Delete,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMutationRequest {
    pub expected_generation: u64,
    pub workspace: String,
    pub action: WorkspaceMutationAction,
    pub new_name: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMutationPreview {
    pub token: String,
    pub request: WorkspaceMutationRequest,
    pub root: String,
    pub stream: String,
    pub expires_at: i64,
}

/// Authoritative result for a workspace rename/delete lifecycle. `verified` is
/// derived from a post-write workspace existence readback; exitCode alone is not
/// success and `observedExists` is the readback fact.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMutationResult {
    pub outcome: WorkflowOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
    pub message: String,
    pub workspace: String,
    pub action: WorkspaceMutationAction,
    pub verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_exists: Option<bool>,
}

#[cfg(test)]
mod revision_graph_wire_tests {
    use super::RevisionGraphRequest;
    fn payload() -> serde_json::Value {
        serde_json::json!({"scope":{"server":"mock","user":"u","client":"c","workspace":"","contextGeneration":1,"fileIdentity":"//mock/main/file"},"revisionLimit":100,"cursor":"page-2","refresh":true,"operationId":"graph-test"})
    }
    #[test]
    fn exact_wire_request_round_trips() {
        let expected = payload();
        let request: RevisionGraphRequest = serde_json::from_value(expected.clone()).unwrap();
        assert_eq!(serde_json::to_value(request).unwrap(), expected);
    }
    #[test]
    fn internal_dispatch_kind_remains_rejected() {
        let mut value = payload();
        value["kind"] = serde_json::json!("graph");
        assert!(serde_json::from_value::<RevisionGraphRequest>(value)
            .unwrap_err()
            .to_string()
            .contains("unknown field `kind`"));
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationTraceRequest {
    pub scope: FileReviewScope,
    /// Exact P4-escaped depot paths, as returned by submitted CL detail.
    /// No revision suffix or wildcard syntax. A literal # is encoded as %23.
    pub paths: Vec<String>,
    #[serde(default)]
    pub refresh: bool,
    pub operation_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationTraceRecord {
    /// Canonical P4-escaped paths; ranges are (start, end], with #none = 0.
    pub source_path: String,
    pub target_path: String,
    pub source_start: i64,
    pub source_end: i64,
    pub target_start: i64,
    pub target_end: i64,
    /// Raw documented action, including ignored/undo/edit (not positive coverage).
    pub how: String,
    /// Integration record change, not a verified destination CL or timestamp.
    pub record_change: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationTraceBatch {
    pub records: Vec<IntegrationTraceRecord>,
    /// Detected query defects/caps only; false does not establish content inclusion.
    pub incomplete: bool,
    pub warnings: Vec<String>,
    pub read_at: u64,
}

#[cfg(test)]
mod log_level_tests {
    use super::*;

    #[test]
    fn cancelled_serializes_as_cancelled_on_the_wire() {
        assert_eq!(
            serde_json::to_string(&LogLevel::Cancelled).unwrap(),
            "\"cancelled\""
        );
        assert_eq!(
            serde_json::from_str::<LogLevel>("\"cancelled\"").unwrap(),
            LogLevel::Cancelled
        );
    }

    #[test]
    fn existing_levels_keep_their_wire_names() {
        for (level, wire) in [
            (LogLevel::Info, "\"info\""),
            (LogLevel::Warning, "\"warning\""),
            (LogLevel::Error, "\"error\""),
        ] {
            assert_eq!(serde_json::to_string(&level).unwrap(), wire);
            assert_eq!(serde_json::from_str::<LogLevel>(wire).unwrap(), level);
        }
    }

    #[test]
    fn unknown_level_from_a_newer_build_falls_back_to_info() {
        assert_eq!(
            serde_json::from_str::<LogLevel>("\"verbose\"").unwrap(),
            LogLevel::Info,
            "an unknown level must not make persisted log entries unreadable"
        );
        let entry: LogEntry = serde_json::from_value(serde_json::json!({
            "id": "1",
            "timestamp": "2026-10-30T00:00:00Z",
            "level": "verbose",
            "operationId": "op",
            "source": "gui",
            "server": "s",
            "workspace": "w",
            "command": "p4 info",
            "message": "m",
            "durationMs": 1,
            "repeatCount": 1
        }))
        .unwrap();
        assert_eq!(entry.level, LogLevel::Info);
    }

    #[test]
    fn log_queries_accept_the_cancelled_level() {
        let query: LogQuery = serde_json::from_value(serde_json::json!({
            "levels": ["cancelled"]
        }))
        .unwrap();
        assert_eq!(query.levels, Some(vec![LogLevel::Cancelled]));
    }
}
