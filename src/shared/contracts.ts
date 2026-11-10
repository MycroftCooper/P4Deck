export type Locale = "zh-CN" | "en-US";
export type ThemeMode = "system" | "light" | "dark";

export interface StreamSummary {
  stream: string;
  name: string;
  owner: string;
  parent: string;
  kind: string;
  description: string;
}

export interface StreamGraphQuery {
  operationId: string;
  requestGeneration: number;
  depotPrefix?: string;
  text?: string;
  includeDeleted: boolean;
  pageSize: number;
  cursor?: string;
  refresh?: boolean;
}

export interface StreamFlowOptions {
  toParent?: boolean;
  fromParent?: boolean;
  mergeMode?: string;
  locked?: boolean;
  allSubmit?: boolean;
}

export interface StreamGraphNode {
  stream: string;
  name?: string;
  owner?: string;
  parent?: string;
  kind?: string;
  description?: string;
  parentView?: string;
  flowOptions: StreamFlowOptions;
  deleted?: boolean;
}

export interface StreamGraphEdge {
  parent: string;
  child: string;
}

export interface StreamGraphScope {
  activeProfileId?: string;
  contextGeneration: number;
  server: string;
  user: string;
  client: string;
  depotPrefix?: string;
}

export interface StreamGraphResult {
  requestGeneration: number;
  scope: StreamGraphScope;
  nodes: StreamGraphNode[];
  edges: StreamGraphEdge[];
  roots: string[];
  orphans: string[];
  hasMore: boolean;
  nextCursor?: string;
  partial: boolean;
  truncated: boolean;
  stats: {
    scannedCount: number;
    matchedCount: number;
    returnedCount: number;
    duplicateCount: number;
    invalidRelationCount: number;
    safetyLimit: number;
  };
  operationIds: string[];
  cacheFreshness: "fresh" | "cached";
  /** True only for Browser Mock responses. */
  simulated: boolean;
}

export type StreamGraphRequestErrorCode =
  | "invalidQuery"
  | "invalidCursor"
  | "cursorExpired"
  | "connectionChanged"
  | "cancelled"
  | "queryFailed";

export interface StreamGraphRequestError {
  code: StreamGraphRequestErrorCode;
  message: string;
}

export interface BranchMappingQuery {
  operationId: string;
  requestGeneration: number;
  nameFilter?: string;
  owner?: string;
  pageSize: number;
  cursor?: string;
}

export interface BranchMappingSummary {
  name: string;
  owner?: string;
  update?: string;
  access?: string;
  description?: string;
  options?: string;
}

export interface BranchMappingScope {
  activeProfileId?: string;
  contextGeneration: number;
  server: string;
  user: string;
  client: string;
}

export interface BranchMappingPage {
  requestGeneration: number;
  scope: BranchMappingScope;
  items: BranchMappingSummary[];
  hasMore: boolean;
  nextCursor?: string;
  partial: boolean;
  truncated: boolean;
  stats: {
    scannedCount: number;
    matchedCount: number;
    returnedCount: number;
    invalidRecordCount: number;
    safetyLimit: number;
  };
  operationIds: string[];
  simulated: boolean;
}

export type BranchViewModifier = "map" | "exclude" | "overlay" | "unknown";

export interface BranchViewLine {
  modifier: BranchViewModifier;
  source?: string;
  target?: string;
  comment?: string;
  unknown?: string;
}

export interface BranchUnknownField {
  name: string;
  value: string;
}

export interface BranchMappingDetail {
  name: string;
  owner: string;
  update?: string;
  access?: string;
  description: string;
  locked: boolean;
  view: BranchViewLine[];
  unknownFields: BranchUnknownField[];
  editable: boolean;
  operationIds: string[];
  simulated: boolean;
}

export interface BranchMappingDetailQuery {
  expectedGeneration?: number;
  operationId: string;
  requestGeneration: number;
  name: string;
}

export interface BranchMappingDetailResult {
  requestGeneration: number;
  scope: BranchMappingScope;
  detail: BranchMappingDetail;
}

export type BranchImpactDirection = "forward" | "reverse";

export interface BranchImpactPreviewQuery {
  operationId: string;
  requestGeneration: number;
  name: string;
  direction: BranchImpactDirection;
  limit: number;
}

export interface BranchImpactItem {
  file?: string;
  source?: string;
  target?: string;
  action?: string;
}

export type BranchIssueCode =
  | "invalidInput"
  | "notFound"
  | "alreadyExists"
  | "ownerMismatch"
  | "permissionDenied"
  | "locked"
  | "destructiveDelete"
  | "unknownFields"
  | "workspaceUnmapped"
  | "previewUnavailable"
  | "contextChanged"
  | "cancelled";

export interface BranchIssue {
  code: BranchIssueCode;
  message: string;
}

export interface BranchImpactPreview {
  requestGeneration: number;
  name: string;
  direction: BranchImpactDirection;
  items: BranchImpactItem[];
  blockers: BranchIssue[];
  partial: boolean;
  truncated: boolean;
  scannedCount: number;
  safetyLimit: number;
  operationIds: string[];
  simulated: boolean;
}

export interface BranchMappingDraft {
  name: string;
  owner: string;
  description: string;
  locked: boolean;
  view: BranchViewLine[];
}

export type BranchMutationMode = "create" | "edit" | "delete";

export interface BranchMutationPreflightRequest {
  mode: BranchMutationMode;
  name: string;
  desired?: BranchMappingDraft;
  operationId?: string;
}

export interface BranchMutationTarget {
  activeProfileId?: string;
  contextGeneration: number;
  server: string;
  user: string;
  client: string;
  mode: BranchMutationMode;
  name: string;
  currentExists: boolean;
  currentDigest?: string;
  desired?: BranchMappingDraft;
  desiredDigest?: string;
}

export interface BranchMutationPreflight {
  ready: boolean;
  mode: BranchMutationMode;
  name: string;
  current?: BranchMappingDetail;
  desired?: BranchMappingDraft;
  blockers: BranchIssue[];
  warnings: BranchIssue[];
  target?: BranchMutationTarget;
  previewDigest: string;
  token?: string;
  expiresAt: number;
  ttlMs: number;
  operationIds: string[];
}

export interface BranchMutationConfirmation {
  token: string;
  target: BranchMutationTarget;
  previewDigest: string;
  acknowledgeDangerousDelete: boolean;
  operationId?: string;
}

export type BranchMutationOutcome =
  "succeeded" | "rejected" | "failed" | "cancelled" | "unknown";

export type BranchMutationFailureCode =
  | "tokenUnknown"
  | "tokenExpired"
  | "targetMismatch"
  | "dangerousConfirmationRequired"
  | "contextChanged"
  | "preflightChanged"
  | "permissionDenied"
  | "commandFailure"
  | "cancelled"
  | "uncertainOutcome"
  | "verificationFailed";

export interface BranchMutationResult {
  outcome: BranchMutationOutcome;
  failure?: BranchMutationFailureCode;
  message: string;
  observed?: BranchMappingDetail;
  operationIds: string[];
  refreshBranchMappings: boolean;
}

export type BranchMappingRequestErrorCode =
  | "invalidQuery"
  | "invalidCursor"
  | "cursorExpired"
  | "connectionChanged"
  | "cancelled"
  | "notFound"
  | "queryFailed";

export interface BranchMappingRequestError {
  code: BranchMappingRequestErrorCode;
  message: string;
}

export interface ClientWorkspace {
  name: string;
  owner: string;
  host: string;
  root: string;
  stream: string;
  description: string;
  updated: number | null;
  accessed: number | null;
}

export type WorkspaceSyncMode = "standard" | "virtual" | "unknown";

export interface ConnectionDirectoryRequest {
  context: P4Context;
  requestGeneration: number;
  operationId?: string;
  prefix?: string;
}

export interface ConnectionUserCandidate {
  name: string;
  fullName?: string;
  email?: string;
  accessed?: number;
}

export type ConnectionWorkspaceRootStatus =
  "usable" | "missing" | "notDirectory" | "otherHost" | "unsupported";

export interface ConnectionWorkspaceCandidate extends ClientWorkspace {
  /** Local-only hint. Activation always re-reads the server spec and verifies the effective Root. */
  rootStatus: ConnectionWorkspaceRootStatus;
  selectable: boolean;
  syncMode?: WorkspaceSyncMode;
}

export interface ConnectionDirectoryStats {
  scannedCount: number;
  matchedCount: number;
  safetyLimit: number;
}

export interface ConnectionUserDirectoryResult {
  requestGeneration: number;
  items: ConnectionUserCandidate[];
  partial: boolean;
  truncated: boolean;
  stats: ConnectionDirectoryStats;
  operationIds: string[];
  connection: ConnectionStatus;
  simulated: boolean;
}

export interface ConnectionWorkspaceDirectoryResult {
  requestGeneration: number;
  items: ConnectionWorkspaceCandidate[];
  partial: boolean;
  truncated: boolean;
  stats: ConnectionDirectoryStats;
  operationIds: string[];
  connection: ConnectionStatus;
  simulated: boolean;
}

export interface ConnectionUserCreatePlan {
  name: string;
  fullName: string;
  email: string;
}

export interface ConnectionClassicViewLine {
  depotPath: string;
  clientPath: string;
}

export type ConnectionWorkspaceMapping =
  | { kind: "stream"; stream: string }
  | { kind: "classic"; view: ConnectionClassicViewLine[] };

export interface ConnectionWorkspaceCreatePlan {
  name: string;
  root: string;
  description?: string;
  mapping: ConnectionWorkspaceMapping;
  syncMode: WorkspaceSyncMode;
}

export interface ConnectionUserCreatePreflightRequest {
  context: P4Context;
  requestGeneration: number;
  operationId?: string;
  plan: ConnectionUserCreatePlan;
}

export interface ConnectionWorkspaceCreatePreflightRequest {
  context: P4Context;
  requestGeneration: number;
  operationId?: string;
  plan: ConnectionWorkspaceCreatePlan;
}

export type ConnectionSpecIssueCode =
  | "invalidInput"
  | "authenticationRequired"
  | "permissionDenied"
  | "alreadyExists"
  | "connectionChanged"
  | "cancelled"
  | "verificationFailed";

export interface ConnectionSpecIssue {
  code: ConnectionSpecIssueCode;
  message: string;
}

export interface ConnectionSpecCreatePreflight {
  ready: boolean;
  kind: "userSelf" | "workspace";
  name: string;
  requestGeneration: number;
  stateDigest: string;
  token?: string;
  expiresAt: number;
  blockers: ConnectionSpecIssue[];
  warnings: ConnectionSpecIssue[];
  operationIds: string[];
  simulated: boolean;
}

export interface ConnectionSpecCreateConfirmation {
  token: string;
  /** FE-assigned UUID; reused by the same-id receipt lookup, never by a retry. */
  operationId?: string;
  context: P4Context;
  requestGeneration: number;
  stateDigest: string;
  confirmed: boolean;
}

export type ConnectionSpecCreateOutcome = "created" | "rejected" | "unknown";

export interface ConnectionSpecCreateResult {
  outcome: ConnectionSpecCreateOutcome;
  failure?: ConnectionSpecIssueCode;
  kind: "userSelf" | "workspace";
  name: string;
  message: string;
  operationIds: string[];
  /** Present only after a workspace create was read back and its local Root was verified. */
  workspace?: ConnectionWorkspaceCandidate;
  simulated: boolean;
}
export type FileState =
  | "loading"
  | "untracked"
  | "controlled"
  | "openedEdit"
  | "openedAdd"
  | "openedDelete"
  | "openedMoveAdd"
  | "openedMoveDelete"
  | "modified"
  | "outOfDate"
  | "notSynced"
  | "conflicted"
  | "missing"
  | "ignored"
  | "unknown";

export type WorkspaceOpenedAction =
  | "add"
  | "edit"
  | "delete"
  | "moveAdd"
  | "moveDelete"
  | "branch"
  | "integrate"
  | "import"
  | "purge"
  | "archive"
  | "unknown";
export type WorkspaceReconcileAction =
  "add" | "edit" | "delete" | "moveAdd" | "moveDelete";
export type WorkspaceSyncState =
  "current" | "outOfDate" | "notSynced" | "unknown";
/**
 * `resolved` means the file has an already-resolved (but not yet submitted)
 * integration record; it can be re-resolved with `p4 resolve -f`.
 */
export type WorkspaceResolveState =
  "none" | "unresolved" | "unknown" | "resolved";
export type WorkspaceLocalState =
  | "present"
  | "missing"
  | "modified"
  | "untracked"
  | "ignored"
  | "directory"
  | "symlink"
  | "unreadable"
  | "unknown";
export type WorkspaceStatusSource =
  | "filesystem"
  | "fstat"
  | "opened"
  | "reconcilePreview"
  | "resolvePreview"
  | "ignore"
  | "cache";
export type WorkspaceStatusCompleteness = "complete" | "partial" | "error";
export interface WorkspaceStatusEvidence {
  source: WorkspaceStatusSource;
  summary: string;
}
export interface WorkspaceIgnoreMatch {
  rule: string;
  source: string;
  line?: number;
  explanation: string;
}
export interface WorkspaceStatusError {
  source: WorkspaceStatusSource;
  message: string;
}
export interface WorkspaceFileStatus {
  primary: FileState;
  openedAction?: WorkspaceOpenedAction;
  reconcileAction?: WorkspaceReconcileAction;
  sync: WorkspaceSyncState;
  resolve: WorkspaceResolveState;
  local: WorkspaceLocalState;
  mapped?: boolean;
  movedFile?: string;
  ignore?: WorkspaceIgnoreMatch;
  fileType?: string;
  exclusiveOpen?: boolean;
  lockOwnership?: FileLockOwnership;
  lockOwner?: string;
  otherOpen?: string[];
  canLock?: boolean;
  canUnlock?: boolean;
  lockReason?: string;
  completeness: WorkspaceStatusCompleteness;
  evidence: WorkspaceStatusEvidence[];
  errors: WorkspaceStatusError[];
}
export type P4FileAction =
  | "refresh"
  | "getLatest"
  | "getRevision"
  | "removeFromWorkspace"
  | "deleteLocal"
  | "checkout"
  | "checkoutAndOpen"
  | "add"
  | "addRecursive"
  | "delete"
  | "markForDelete"
  | "revertUnchanged"
  | "revert"
  | "moveToChangelist"
  | "resolve"
  | "reconcile"
  | "shelve"
  | "changeFiletype"
  | "lock"
  | "unlock"
  | "integrate"
  | "copy"
  | "branch"
  | "undo"
  | "clean"
  | "tagWithLabel";
export type FileAction = P4FileAction | "diff" | "history" | "revisionGraph";
export type OperationSource = "gui" | "terminal";
export type LogLevel = "info" | "warning" | "error" | "cancelled";
export type ChangeStatus = "pending" | "submitted" | "shelved";
export type MergeClassification =
  "normal" | "reliableMerge" | "suspectedMerge" | "unknown";

export interface P4Context {
  executable?: string;
  customSubmitExecutablePath?: string;
  server: string;
  user: string;
  client: string;
  cwd?: string;
  charset?: string;
  trustPath?: string;
  ticketsPath?: string;
  swarmBaseUrl?: string;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  context: P4Context;
}

export interface ConnectionProfiles {
  schemaVersion: 3;
  revision: number;
  activeProfileId?: string;
  profiles: ConnectionProfile[];
}

export interface CreateConnectionProfileRequest {
  expectedRevision: number;
  name: string;
  context: P4Context;
  /** S4j1 durable operation id (optional additive field; FE assigns a UUID before dispatch). */
  operationId?: string;
}

export interface UpdateConnectionProfileRequest extends CreateConnectionProfileRequest {
  id: string;
}

export interface DeleteConnectionProfileRequest {
  expectedRevision: number;
  id: string;
  operationId?: string;
}

export interface SetActiveConnectionProfileRequest extends DeleteConnectionProfileRequest {}

export interface SwitchWorkspaceRequest {
  expectedGeneration: number;
  client: string;
}

export interface OpenSwarmLinkRequest {
  url: string;
  expectedProfileId?: string;
  expectedContextGeneration: number;
}

export type ConnectionProfileErrorCode =
  | "invalidInput"
  | "duplicateName"
  | "duplicateContext"
  | "notFound"
  | "revisionConflict"
  | "activeProfileDelete"
  | "lastProfileDelete"
  | "corruptStore"
  | "unsupportedSchema"
  | "persistenceFailed"
  | "connectionFailed"
  | "authenticationRequired"
  | "contextChanged";

export interface ConnectionProfileError {
  code: ConnectionProfileErrorCode;
  message: string;
}

export interface RuntimeInfo {
  mode: "mock" | "tauri";
  p4Version: string;
  activeProfileId?: string;
  contextGeneration: number;
  context: P4Context;
  connection: ConnectionStatus;
}

export interface P4VfsInspectRequest {
  expectedContextGeneration: number;
  operationId?: string;
}

export interface P4VfsStatus {
  contextGeneration: number;
  workspace: string;
  mode: WorkspaceSyncMode;
  ready: boolean;
  serverVersion?: string;
  serverSupported: boolean;
  clientVersion?: string;
  clientSupported: boolean;
  agentConfigured: boolean;
  reason?: string;
  operationIds: string[];
}

export type ConnectionState =
  | "cliMissing"
  | "notTested"
  | "disconnected"
  | "sslUntrusted"
  | "authRequired"
  | "connected"
  | "ticketExpired"
  | "networkError"
  | "permissionDenied"
  | "invalidConfig"
  | "externalAuthRequired"
  | "unsupported"
  | "unknown";

export type ConnectionErrorCode = Exclude<
  ConnectionState,
  "notTested" | "connected"
>;

export type RecoveryAction =
  | "none"
  | "configureCli"
  | "editConfig"
  | "trustServer"
  | "login"
  | "retry"
  | "contactAdmin"
  | "completeExternalAuth";

export interface ConnectionStatus {
  state: ConnectionState;
  errorCode?: ConnectionErrorCode;
  message: string;
  recovery: RecoveryAction;
  server: string;
  fingerprint?: string;
}

export interface CliDiscoveryRequest {
  executable?: string;
}

export interface CliDiscoveryResult {
  state: "cliMissing" | "notTested" | "invalidConfig";
  executable?: string;
  version?: string;
  errorCode?: "cliMissing" | "invalidConfig";
  message: string;
}

export interface TrustRequest {
  context: P4Context;
  fingerprint: string;
  confirmed: boolean;
  operationId?: string;
}

export interface LoginRequest {
  context: P4Context;
  password: string;
  confirmed: boolean;
  /** Optional durable id only; FE never persists/logs the password. */
  operationId?: string;
}

export interface AuthenticationRequest {
  context: P4Context;
  confirmed: boolean;
  operationId?: string;
}

export interface P4CommandRequest {
  operationId?: string;
  source: OperationSource;
  command: string;
  args: string[];
  context: P4Context;
  outputMode: "text" | "jsonLines";
  timeoutMs?: number;
}

export interface OperationEvent {
  operationId: string;
  type:
    | "queued"
    | "started"
    | "stdout"
    | "stderr"
    | "progress"
    | "warning"
    | "error"
    | "completed"
    | "cancelled";
  message?: string;
  progress?: number;
  /** Completed units when the command reports countable work (files, bytes…). */
  progressCurrent?: number;
  /** Total units for the same countable work; absent when the total is unknown. */
  progressTotal?: number;
  timestamp: string;
}
export interface DiskUsage {
  path: string;
  total: number;
  available: number;
}

export interface OperationResult {
  operationId: string;
  exitCode: number;
  events: OperationEvent[];
  durationMs: number;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  operationId: string;
  source: OperationSource;
  server: string;
  workspace: string;
  command: string;
  message: string;
  durationMs?: number;
  repeatCount: number;
}

export interface ClQuery {
  operationId: string;
  requestGeneration: number;
  keyword: string;
  users: string[];
  clients: string[];
  depotPath?: string;
  stream?: string;
  streams?: string[];
  from: string;
  to: string;
  jobs?: string[];
  hasJob?: boolean;
  mergeClassifications: MergeClassification[];
  hideReliableMerges: boolean;
  pageSize: number;
  cursor?: string;
}

export interface ChangelistSummary {
  id: number;
  description: string;
  user: string;
  client: string;
  status: ChangeStatus;
  time: string;
  fileCount: number;
  hasShelf: boolean;
  jobs: string[];
  stream?: string;
  mergeClassification: MergeClassification;
}

export interface SubmittedChangeDetailRequest {
  expectedGeneration?: number;
  refresh?: boolean;
  changeId: number;
  operationId: string;
}

export interface SubmittedChangeFile {
  depotPath: string;
  action: string;
  revision?: number;
  fileType?: string;
}

export interface SubmittedIntegrationEvidence {
  source: "describeAction" | "filelog";
  depotPath: string;
  relationship: string;
  relatedPath?: string;
}

export interface SubmittedChangeDetail {
  changeId: number;
  description: string;
  user: string;
  client: string;
  time: string;
  jobs: string[];
  files: SubmittedChangeFile[];
  integrationEvidence: SubmittedIntegrationEvidence[];
  mergeClassification: MergeClassification;
  inspectionStatus: "complete" | "partial" | "unavailable";
  message?: string;
  /**
   * Real changelist status reported by the server:
   * "submitted" | "pending" | "shelved" | "unknown" (unknown means the
   * inspection itself was unavailable). Optional only for older fixtures;
   * the Rust backend always returns it.
   */
  status?: string;
}

export interface ShelfDetailRequest {
  changeId: number;
  requestGeneration: number;
  pageSize: number;
  cursor?: string;
  refresh?: boolean;
  operationId?: string;
}
export type ShelfDetailRequestErrorCode =
  | "invalidQuery"
  | "invalidCursor"
  | "cursorExpired"
  | "snapshotChanged"
  | "connectionChanged"
  | "cancelled"
  | "queryFailed";
export interface ShelfDetailRequestError {
  code: ShelfDetailRequestErrorCode;
  message: string;
}
export interface ShelfDetailScope {
  server: string;
  user: string;
  client: string;
  workspace: string;
  activeProfileId?: string;
  contextGeneration: number;
  changeId: number;
}
export interface ShelfDetailFile {
  depotPath: string;
  action: string;
  revision?: number;
  fileType?: string;
  size?: number;
  digest?: string;
  binary: boolean;
  symlink: boolean;
  deleted: boolean;
}
export interface ShelfDetail {
  requestGeneration: number;
  scope: ShelfDetailScope;
  description: string;
  time: string;
  owner: string;
  user: string;
  client: string;
  jobs: string[];
  files: ShelfDetailFile[];
  totalFiles: number;
  hasMore: boolean;
  nextCursor?: string;
  truncated: boolean;
  inspectionStatus: "complete" | "partial";
  message?: string;
  operationIds: string[];
  cacheFreshness: "fresh" | "cached";
}

export interface ClQueryResult {
  requestGeneration: number;
  items: ChangelistSummary[];
  hasMore: boolean;
  nextCursor?: string;
  stats: {
    scannedCount: number;
    matchedCount: number;
    hiddenReliableMergeCount: number;
    truncatedBySafetyLimit: boolean;
  };
}

export type GlobalSearchKind =
  | "submittedChange"
  | "pendingChange"
  | "workspaceFile"
  | "depotFile"
  | "job"
  | "stream"
  | "shelf";

export interface GlobalSearchQuery {
  operationId: string;
  requestGeneration: number;
  text: string;
  /** Empty means all currently supported production kinds. */
  kinds: GlobalSearchKind[];
  pageSize: number;
  cursor?: string;
}

export type GlobalSearchTarget =
  | { type: "submittedChange"; changeId: number }
  | { type: "pendingChange"; changeId: number }
  | { type: "workspaceFile"; absolutePath: string }
  | { type: "depotFile"; depotPath: string }
  | { type: "job"; jobId: string }
  | { type: "stream"; streamPath: string }
  | { type: "shelf"; changeId: number };

export interface GlobalSearchItem {
  identity: string;
  kind: GlobalSearchKind;
  title: string;
  summary: string;
  target: GlobalSearchTarget;
  matchedFields: string[];
  /** UTF-16 offsets, matching JavaScript string indexing. */
  highlights: Array<{ field: string; start: number; end: number }>;
  rank: number;
}

export type GlobalSearchErrorCode =
  | "cancelled"
  | "timeout"
  | "permissionDenied"
  | "connectionChanged"
  | "queryFailed";

export interface GlobalSearchRequestError {
  code:
    | "invalidQuery"
    | "invalidCursor"
    | "cursorExpired"
    | "connectionChanged"
    | "cancelled";
  message: string;
}

export interface GlobalSearchResult {
  requestGeneration: number;
  normalizedQuery: string;
  groups: Array<{ kind: GlobalSearchKind; items: GlobalSearchItem[] }>;
  facets: Array<{
    kind: GlobalSearchKind;
    matchedCount: number;
    scannedCount: number;
    partial: boolean;
    partialReason?: string;
    error?: { code: GlobalSearchErrorCode; message: string };
  }>;
  hasMore: boolean;
  nextCursor?: string;
  partial: boolean;
  /** True only for MockBackend responses; Tauri/P4 responses are always false. */
  simulated: boolean;
  stats: {
    scannedCount: number;
    matchedCount: number;
    returnedCount: number;
    categoryFailureCount: number;
    safetyLimit: number;
  };
}

export type ClAction =
  | { type: "create"; description: string }
  | { type: "edit"; changeId: number; description: string; jobs: string[] }
  | { type: "delete"; changeId: number }
  | { type: "submitValidate"; changeId: number };

export interface ClActionResult {
  operation: OperationResult;
  affectedChanges: number[];
  warnings: string[];
}

export interface LogQuery {
  keyword?: string;
  levels?: LogLevel[];
  sources?: OperationSource[];
  server?: string;
  workspace?: string;
  command?: string;
  operationId?: string;
  cursor?: string;
  limit?: number;
}

export interface LogPage {
  entries: LogEntry[];
  nextCursor?: string;
}
export interface LogPolicy {
  autoExpandWarning: boolean;
  autoExpandError: boolean;
  retentionDays: number;
  maxMib: number;
}
export interface DiagnosticExportRequest {
  maxLogEntries?: number;
  maxOperationEntries?: number;
}
export interface DiagnosticExportResult {
  path: string;
  sizeBytes: number;
  truncated: boolean;
  format: "json";
  simulated?: boolean;
}

/**
 * S4j2 control-plane lifecycle envelope (backup create/restore, diagnostics
 * export, log policy set, log clear). Optimistic policy is always "intentOnly":
 * FE may only show intent/progress until `state` is authoritative readback.
 * `committed` requires a readback-proven artifact / readback-equal facts;
 * restore can only ever reach `pending` (staged, applies on next start).
 * `legacy` is the wrapped old payload for operationId-less calls (no receipt).
 */
export type ControlPlaneActionKind =
  | "backupCreate"
  | "backupRestore"
  | "diagnosticsExport"
  | "logPolicySet"
  | "logClear";
export type ControlPlaneActionState =
  "intent" | "committed" | "pending" | "unknown" | "rejected" | "legacy";
export interface ControlPlaneArtifact {
  path?: string;
  fileName?: string;
  exists: boolean;
  sizeBytes: number;
  sha256?: string;
}
export interface ControlPlaneActionResult {
  kind: ControlPlaneActionKind;
  operationId?: string;
  state: ControlPlaneActionState;
  outcome: WorkflowOutcome;
  artifact: ControlPlaneArtifact;
  /** Row-specific readback facts; never file content or credentials. */
  details: unknown;
  optimistic: "intentOnly";
  message: string;
  /** Old payload for `state:"legacy"` calls only. */
  legacy: unknown;
}
export interface BackupCreateActionRequest {
  request: ConfigBackupCreateRequest;
  operationId?: string;
}
export interface BackupRestoreActionRequest {
  request: ConfigBackupRestoreRequest;
  operationId?: string;
}
export interface DiagnosticsExportActionRequest {
  request: DiagnosticExportRequest;
  operationId?: string;
}
export interface SetLogPolicyActionRequest {
  policy: LogPolicy;
  operationId?: string;
}
export interface ClearLogsActionRequest {
  operationId?: string;
}

export interface DiagnosticAlert {
  operationId: string;
  level: "warning" | "error";
}

export interface ConfigBackupLocalStorageEntry {
  key: string;
  value: string;
}

export interface ConfigBackupSummary {
  fileName: string;
  createdAt: string;
  sizeBytes: number;
  kind: "manual" | "preRestore";
  includesConnection: boolean;
  includesWindowPlacement: boolean;
  localStorageKeys: string[];
}

export interface ConfigBackupRestoreStatus {
  state: "pending" | "succeeded" | "failed";
  sourceFileName: string;
  rollbackFileName?: string;
  completedAt?: string;
  message?: string;
}

export interface ConfigBackupPendingRestore {
  sourceFileName: string;
  rollbackFileName: string;
  stagedAt: string;
}

export interface ConfigBackupOverview {
  directory: string;
  backups: ConfigBackupSummary[];
  pendingRestore?: ConfigBackupPendingRestore;
  lastRestore?: ConfigBackupRestoreStatus;
}

export interface ConfigBackupCreateRequest {
  localStorage: ConfigBackupLocalStorageEntry[];
}

export interface ConfigBackupCreateResult {
  backup: ConfigBackupSummary;
  omittedLocalStorageKeys: string[];
}

export interface ConfigBackupRestoreRequest {
  fileName: string;
  /** Captures the current layout so the generated rollback backup is complete. */
  localStorage: ConfigBackupLocalStorageEntry[];
}

export interface ConfigBackupRestoreResult {
  sourceFileName: string;
  rollbackFileName: string;
  localStorage: ConfigBackupLocalStorageEntry[];
  restartRequired: boolean;
}

export interface CacheDiagnostics {
  hits: number;
  misses: number;
  coalesced: number;
  evicted: number;
  invalidated: number;
  staleFallbacks: number;
  superseded: number;
  loadCount: number;
  totalLoadMs: number;
  entries: number;
  estimatedBytes: number;
  invalidationReasons: Record<string, number>;
}
export type OperationCategory =
  | "query"
  | "fileMutation"
  | "changelistMutation"
  | "submit"
  | "authentication"
  | "localFile";
export type JournalState =
  "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export type OperationFailureKind =
  | "offline"
  | "serverUnreachable"
  | "authExpired"
  | "permissionDenied"
  | "commandFailure"
  | "cancelled"
  | "interrupted"
  | "unknown";
export interface OperationRecord {
  operationId: string;
  connectionId: string;
  workspace: string;
  source: OperationSource;
  category: OperationCategory;
  state: JournalState;
  failure?: OperationFailureKind;
  startedAt: string;
  finishedAt?: string;
  logReference?: string;
}
export interface OperationJournalQuery {
  connectionId?: string;
  state?: JournalState;
  category?: OperationCategory;
  from?: string;
  to?: string;
  keyword?: string;
  cursor?: string;
  limit?: number;
}
export interface OperationJournalPage {
  records: OperationRecord[];
  nextCursor?: string;
}

export interface WorkspaceNode {
  id: string;
  name: string;
  kind: "file" | "directory";
  absolutePath: string;
  relativePath: string;
  depotPath?: string;
  state: FileState;
  revision?: number;
  headRevision?: number;
  changelistId?: number;
  modifiedAt?: string;
  hasChildren?: boolean;
  /** Present for workspace queries; absent for Depot/Pending projection rows. */
  status?: WorkspaceFileStatus;
}

export interface WorkspaceListing {
  items: WorkspaceNode[];
  completeness: WorkspaceStatusCompleteness;
  errors: WorkspaceStatusError[];
  operationIds: string[];
  truncated: boolean;
  safetyLimit: number;
  cacheFreshness: "fresh" | "stale" | "offlineFallback" | "local";
}

export type OpenLocalPathMode = "reveal" | "open" | "openWith";
export interface LocalPathCapabilities {
  reveal: boolean;
  openWith: boolean;
}

export interface OpenLocalPathRequest {
  path: string;
  mode: OpenLocalPathMode;
}

export interface DepotNode {
  id: string;
  name: string;
  kind: "file" | "directory";
  depotPath: string;
  headRevision?: number;
  headAction?: string;
  hasChildren?: boolean;
}

export interface PathResolveRequest {
  input: string;
}
export interface PathResolveResult {
  found: boolean;
  inputKind: "relative" | "absolute" | "depot";
  absolutePath?: string;
  relativePath?: string;
  depotPath?: string;
  reason?: string;
}

export interface FileActionRequest {
  operationId?: string;
  action: P4FileAction;
  paths: string[];
  revision?: string;
  states?: FileState[];
  changelistId?: number;
  fileType?: string;
  targetPath?: string;
  resolveMethod?: "am" | "as" | "at" | "ay" | "af" | "n";
  label?: string;
  /** Explicitly revert the changelist named by changelistId as one P4 operation. */
  revertWholeChangelist?: boolean;
  /** Opt-in P4-native parallel transfer threads; currently restricted to 2–4. */
  parallelThreads?: number;
}

/** S4k cancel boundary: a cancel is a request signal, never a rollback or "nothing ran" proof. */
export type CancelOperationState = "cancelRequested" | "notFound" | "unknown";
export interface CancelOperationResult {
  operationId: string;
  state: CancelOperationState;
  matchedOperations: number;
  /** Always false: the host never claims a server-side rollback from cancel. */
  serverRollbackClaimed: false;
  message: string;
}

export interface FileActionResult {
  execution?: {
    operationId: string;
    outcome: "commandCompleted" | "unknown" | "notDispatched";
    perFileEvidence: "notCollected" | "localIoAcknowledgements";
    files?: {
      depotPath: string;
      state: "succeeded" | "blocked" | "unknown";
      message: string;
      operationId?: string;
    }[];
  };
  operation?: OperationResult;
  affectedPaths: string[];
  message: string;
}
/** S4a local-IO lifecycle envelope. `files[]` is the only per-item authority; old fields live in `legacy`. */
export type LocalIoActionKind = "renameMove" | "syncRevision" | "undoChange";
export type LocalIoLifecycleState =
  "committed" | "unknown" | "rejected" | "legacy";
export interface LocalIoFileResult {
  depotPath: string;
  state: "succeeded" | "retained" | "failed" | "cancelled" | "unknown";
  message: string;
  operationId?: string;
}
export interface LocalIoActionResult {
  kind: LocalIoActionKind;
  operationId?: string;
  /** Host receipt revision (Rust receipt_revision); optional additive field for reconciliation. */
  receiptRevision?: string;
  state: LocalIoLifecycleState;
  outcome:
    "succeeded" | "partial" | "rejected" | "failed" | "cancelled" | "unknown";
  files: LocalIoFileResult[];
  message: string;
  legacy?: RenameMoveResult | SyncResult | OperationResult;
}

export type FileLockOperation = "lock" | "unlock";
export type FileLockOwnership = "unlocked" | "ours" | "other" | "unknown";
export type FileLockPermission = "allowed" | "denied" | "unknown";
export interface FileLockPreflightRequest {
  operation: FileLockOperation;
  paths: string[];
  operationId?: string;
}
export interface FileLockFileSnapshot {
  inputPath: string;
  depotPath: string;
  clientPath: string;
  localPath?: string;
  openedAction: string;
  changelistId: number;
  fileType: string;
  exclusive: boolean;
  ownership: FileLockOwnership;
  lockOwner?: string;
  otherOpen: string[];
  permission: FileLockPermission;
  applicable: boolean;
  reason?: string;
}
export interface FileLockTargetSnapshot {
  server: string;
  user: string;
  client: string;
  workspace: string;
  activeProfileId?: string;
  contextGeneration: number;
  operation: FileLockOperation;
  files: FileLockFileSnapshot[];
}
export type FileLockIssueCode =
  | "invalidTarget"
  | "connectionUnavailable"
  | "authenticationRequired"
  | "outsideClientView"
  | "notOpened"
  | "unsupportedAction"
  | "alreadyLocked"
  | "notLocked"
  | "lockedByOther"
  | "permissionDenied"
  | "permissionUnknown"
  | "stateUnknown";
export interface FileLockIssue {
  code: FileLockIssueCode;
  certainty: "confirmed" | "unknown";
  message: string;
  paths: string[];
}
export interface FileLockCounts {
  requested: number;
  applicable: number;
  alreadySatisfied: number;
  blocked: number;
  exclusive: number;
}
export interface FileLockPreflight {
  ready: boolean;
  operation: FileLockOperation;
  files: FileLockFileSnapshot[];
  counts: FileLockCounts;
  blockers: FileLockIssue[];
  warnings: FileLockIssue[];
  targetSnapshot?: FileLockTargetSnapshot;
  stateDigest: string;
  token?: string;
  expiresAt: number;
  ttlMs: number;
  operationIds: string[];
  logReference?: string;
}
export interface FileLockConfirmation {
  token: string;
  target: FileLockTargetSnapshot;
  stateDigest: string;
  operationId?: string;
}
export type FileLockFileOutcome =
  "succeeded" | "alreadySatisfied" | "failed" | "cancelled" | "unknown";
export interface FileLockFileResult {
  depotPath: string;
  outcome: FileLockFileOutcome;
  message: string;
  ownership: FileLockOwnership;
  lockOwner?: string;
  operationId?: string;
}
export type FileLockOutcome =
  "succeeded" | "partial" | "rejected" | "failed" | "cancelled" | "unknown";
export type FileLockFailureCode =
  | "tokenUnknown"
  | "tokenExpired"
  | "targetMismatch"
  | "contextChanged"
  | "stateChanged"
  | "preflightBlocked"
  | "commandFailure"
  | "cancelled"
  | "uncertainOutcome";
export interface FileLockResult {
  execution?: {
    operationId: string;
    outcome: "commandCompleted" | "unknown";
    perFileEvidence: "notCollected";
    /** Additive host envelope field; lock operations normally omit it (no per-file facts here). */
    files?: {
      depotPath: string;
      state: string;
      message: string;
      operationId?: string;
    }[];
  };
  outcome: FileLockOutcome;
  failure?: FileLockFailureCode;
  message: string;
  files: FileLockFileResult[];
  operationId?: string;
  logReference?: string;
  refresh: {
    workspaceStatus: boolean;
    pendingChanges: boolean;
    search: boolean;
    review: boolean;
    depotPaths: string[];
    localPaths: string[];
    reason: string;
  };
}

export interface RenameMovePreflightRequest {
  sourcePath: string;
  targetPath: string;
  targetChangeId: number;
  operationId?: string;
}

export interface RenameMoveMapping {
  depotPath: string;
  clientPath: string;
  localPath: string;
}

export interface RenameMoveSourceState {
  action: string;
  changeId: number;
  fileType?: string;
  haveRevision?: number;
  headRevision?: number;
}

export interface RenameMoveTargetSnapshot {
  server: string;
  user: string;
  client: string;
  workspace: string;
  activeProfileId?: string;
  contextGeneration: number;
  source: RenameMoveMapping;
  target: RenameMoveMapping;
  sourceState: RenameMoveSourceState;
  targetChangeId: number;
}

export type RenameMoveIssueCode =
  | "invalidPath"
  | "sourceMissing"
  | "sourceUnmapped"
  | "targetUnmapped"
  | "crossWorkspace"
  | "targetExists"
  | "sourceNotOpened"
  | "invalidChangelist"
  | "caseOnlyRename"
  | "inspectionUnavailable";

export interface RenameMoveIssue {
  code: RenameMoveIssueCode;
  message: string;
}

export interface RenameMovePreflight {
  ready: boolean;
  source?: RenameMoveMapping;
  target?: RenameMoveMapping;
  sourceState?: RenameMoveSourceState;
  targetChangeId: number;
  targetChangeValid: boolean;
  targetExists: boolean;
  caseOnlyRisk: boolean;
  blockers: RenameMoveIssue[];
  warnings: RenameMoveIssue[];
  targetSnapshot?: RenameMoveTargetSnapshot;
  previewDigest: string;
  token?: string;
  expiresAt: number;
  ttlMs: number;
  operationIds: string[];
  logReference?: string;
}

export interface RenameMoveConfirmation {
  token: string;
  target: RenameMoveTargetSnapshot;
  previewDigest: string;
  operationId?: string;
}

export type RenameMoveFailureCode =
  | "tokenUnknown"
  | "tokenExpired"
  | "targetMismatch"
  | "contextChanged"
  | "sourceChanged"
  | "targetChanged"
  | "preflightBlocked"
  | "commandFailure"
  | "cancelled"
  | "uncertainOutcome";

export interface RenameMoveResult {
  outcome: "succeeded" | "rejected" | "failed" | "cancelled" | "unknown";
  failure?: RenameMoveFailureCode;
  message: string;
  operationId?: string;
  logReference?: string;
  refresh: {
    workspaceStatus: boolean;
    pendingChanges: boolean;
    depotPaths: string[];
    localPaths: string[];
    reason: string;
  };
}

export interface SyncRevisionSpec {
  kind: "head" | "revision" | "change" | "date" | "label";
  value?: string;
}

export interface SyncPreviewRequest {
  paths: string[];
  revision: SyncRevisionSpec;
  force?: boolean;
  parallelThreads?: number;
  /** Preview-reported file count, so a later sync can expose a real total. */
  expectedFiles?: number;
  operationId?: string;
}

export type SyncChangeKind =
  "added" | "updated" | "deleted" | "upToDate" | "warning" | "conflict";

export interface SyncPlanEntry {
  kind: SyncChangeKind;
  depotPath?: string;
  clientPath?: string;
  revision?: number;
  message: string;
}

export type SyncIssueCode =
  | "invalidTarget"
  | "notInClient"
  | "writableClobber"
  | "openedFile"
  | "unresolvedFile"
  | "permissionDenied"
  | "diskSpace"
  | "offline"
  | "serverUnreachable"
  | "authExpired"
  | "forceOverwrite"
  | "previewFailed"
  | "inspectionUnknown";

export interface SyncIssue {
  code: SyncIssueCode;
  message: string;
  paths?: string[];
}

export interface SyncTargetSnapshot {
  server: string;
  user: string;
  client: string;
  workspace: string;
  contextGeneration: number;
  paths: string[];
  revision: SyncRevisionSpec;
  force: boolean;
  parallelThreads?: number;
}

export interface SyncPlanCounts {
  added: number;
  updated: number;
  deleted: number;
  upToDate: number;
  warnings: number;
  conflicts: number;
}

export interface SyncPreviewPlan {
  ready: boolean;
  target: SyncTargetSnapshot;
  counts: SyncPlanCounts;
  entries: SyncPlanEntry[];
  totalEntries: number;
  truncated: boolean;
  partial: boolean;
  blockers: SyncIssue[];
  warnings: SyncIssue[];
  contentDigest: string;
  token?: string;
  expiresAt: number;
  ttlMs: number;
  operationIds: string[];
  logReference?: string;
}

export interface SyncConfirmRequest {
  token: string;
  target: SyncTargetSnapshot;
  acknowledgeForce: boolean;
  operationId?: string;
}

export type SyncFailureCode =
  | "tokenUnknown"
  | "tokenExpired"
  | "targetMismatch"
  | "contextChanged"
  | "previewChanged"
  | "preflightBlocked"
  | "forceAcknowledgementRequired"
  | "permissionDenied"
  | "diskSpace"
  | "offline"
  | "serverUnreachable"
  | "authExpired"
  | "commandFailure"
  | "cancelled"
  | "uncertainOutcome";

export interface SyncResult {
  outcome:
    "succeeded" | "partial" | "rejected" | "failed" | "cancelled" | "unknown";
  failure?: SyncFailureCode;
  message: string;
  operationId?: string;
  logReference?: string;
  affectedPaths: string[];
  counts: SyncPlanCounts;
  refreshWorkspace: boolean;
  refreshDepot: boolean;
}

export type StreamSwitchMode = "viewOnly" | "sync";
export interface StreamSwitchPreflightRequest {
  targetStream: string;
  mode: StreamSwitchMode;
  operationId?: string;
}
export interface StreamSwitchRiskSummary {
  openedFiles: number;
  unresolvedFiles: number;
  reconcileFiles: number;
  targetFileCount?: number;
  targetFileBytes?: number;
}
export interface StreamSwitchTargetSnapshot {
  server: string;
  user: string;
  client: string;
  workspace: string;
  activeProfileId?: string;
  contextGeneration: number;
  currentStream?: string;
  targetStream: string;
  targetType: string;
  targetParent?: string;
  mode: StreamSwitchMode;
  clientSpecDigest: string;
  streamSpecDigest: string;
  riskDigest: string;
}
export type StreamSwitchIssueCode =
  | "invalidTarget"
  | "missingWorkspaceRoot"
  | "classicWorkspace"
  | "sameStream"
  | "unsupportedStreamType"
  | "clientOwnerMismatch"
  | "lockedClient"
  | "openedFiles"
  | "unresolvedFiles"
  | "localChanges"
  | "authenticationRequired"
  | "permissionDenied"
  | "connectionUnavailable"
  | "inspectionUnavailable"
  | "syncChangesWorkspace"
  | "virtualStream";
export interface StreamSwitchIssue {
  code: StreamSwitchIssueCode;
  message: string;
  paths: string[];
}
export interface StreamSwitchPreflight {
  ready: boolean;
  currentStream?: string;
  targetStream: string;
  targetType?: string;
  targetParent?: string;
  mode: StreamSwitchMode;
  syncRequired: boolean;
  risks: StreamSwitchRiskSummary;
  blockers: StreamSwitchIssue[];
  warnings: StreamSwitchIssue[];
  targetSnapshot?: StreamSwitchTargetSnapshot;
  previewDigest: string;
  token?: string;
  expiresAt: number;
  ttlMs: number;
  operationIds: string[];
  logReference?: string;
}
export interface StreamSwitchConfirmation {
  token: string;
  target: StreamSwitchTargetSnapshot;
  previewDigest: string;
  acknowledgeWarnings: boolean;
  operationId?: string;
}
export type StreamSwitchFailureCode =
  | "tokenUnknown"
  | "tokenExpired"
  | "targetMismatch"
  | "warningAcknowledgementRequired"
  | "contextChanged"
  | "preflightChanged"
  | "preflightBlocked"
  | "switchFailed"
  | "verificationFailed"
  | "syncFailed"
  | "cancelled"
  | "uncertainOutcome";
export interface StreamSwitchResult {
  outcome: "succeeded" | "rejected" | "failed" | "cancelled" | "unknown";
  failure?: StreamSwitchFailureCode;
  message: string;
  streamChanged: boolean;
  syncPerformed: boolean;
  syncCompleted: boolean;
  verifiedStream?: string;
  operationId?: string;
  logReference?: string;
  runtime?: RuntimeInfo;
  refresh: {
    workspace: boolean;
    streams: boolean;
    pendingChanges: boolean;
    submittedChanges: boolean;
    search: boolean;
    depot: boolean;
    reason: string;
  };
}
export type RevisionReference =
  | { kind: "workspace" }
  | { kind: "have" }
  | { kind: "head" }
  | { kind: "revision"; revision: number }
  | { kind: "shelf"; changeId: number };
export interface FileReviewScope {
  server: string;
  user: string;
  client: string;
  workspace: string;
  activeProfileId?: string;
  contextGeneration: number;
  fileIdentity: string;
}
export interface DiffRequest {
  rightFileIdentity?: string;
  scope: FileReviewScope;
  left: RevisionReference;
  right: RevisionReference;
  refresh?: boolean;
  operationId?: string;
}
export interface DiffSide {
  reference: RevisionReference;
  label: string;
  depotPath: string;
  revision?: number;
  fileType?: string;
  size?: number;
  digest?: string;
  exists: boolean;
  binary: boolean;
}
export interface DiffResult {
  path: string;
  left: DiffSide;
  right: DiffSide;
  unified: string;
  /** Complete, bounded text already loaded for the comparison; absent for partial output. */
  leftText?: string;
  rightText?: string;
  stats: { additions: number; deletions: number; hunks: number };
  binary: boolean;
  unsupported: boolean;
  reason?: string;
  identical: boolean;
  truncated: boolean;
  partial: boolean;
  operationIds: string[];
}
export interface ShelfFilePreviewRequest {
  scope: FileReviewScope;
  changeId: number;
  refresh?: boolean;
  operationId?: string;
}
export interface ShelfFilePreview {
  side: DiffSide;
  content?: string;
  encoding: string;
  truncated: boolean;
  unsupported: boolean;
  reason?: string;
  operationIds: string[];
}
export interface FileIntegration {
  relationship: string;
  kind: string;
  direction: string;
  relatedPath: string;
  startRevision?: number;
  endRevision?: number;
}
export interface FileRevision {
  depotPath: string;
  revision: number;
  changelistId: number;
  user: string;
  action: string;
  fileType: string;
  time: string;
  description: string;
  digest?: string;
  fileSize?: number;
  integrations: FileIntegration[];
}
export interface FileHistoryRequest {
  scope: FileReviewScope;
  pageSize: number;
  cursor?: string;
  refresh?: boolean;
  operationId?: string;
}
export interface FileHistoryPage {
  items: FileRevision[];
  nextCursor?: string;
  hasMore: boolean;
  partial: boolean;
  truncated: boolean;
  operationIds: string[];
}
export interface RevisionGraphRequest {
  scope: FileReviewScope;
  revisionLimit: number;
  cursor?: string;
  refresh?: boolean;
  operationId?: string;
}
export interface RevisionGraphNode {
  id: string;
  depotPath: string;
  revision: number;
  changelistId: number;
  action: string;
  fileType: string;
  label: string;
  x: number;
  y: number;
  missing: boolean;
}
export interface RevisionGraphEdge {
  id: string;
  source: string;
  target: string;
  kind:
    | "revision"
    | "branch"
    | "merge"
    | "copy"
    | "move"
    | "add"
    | "delete"
    | "edit"
    | "integration";
  relationship: string;
  startRevision?: number;
  endRevision?: number;
}
export interface RevisionGraph {
  nodes: RevisionGraphNode[];
  edges: RevisionGraphEdge[];
  nextCursor?: string;
  hasMore: boolean;
  partial: boolean;
  truncated: boolean;
  operationIds: string[];
}

export interface PendingFile {
  depotPath: string;
  action: string;
  state?: FileState;
  clientPath?: string;
  revision?: number;
  /** Depot head revision from fstat; absent when unknown (never fabricated). */
  headRevision?: number;
  fileType?: string;
  lockOwnership?: FileLockOwnership;
  lockOwner?: string;
  otherOpen?: string[];
  exclusiveOpen?: boolean;
  /** Set only when P4 resolve preview lists this file; display-only evidence. */
  resolve?: "unresolved";
}
export interface PendingChange {
  id: number;
  description: string;
  user: string;
  client: string;
  status: "pending";
  updatedAt?: string;
  jobs: string[];
  files: PendingFile[];
  shelvedFiles: PendingFile[];
}

export type PendingChangeSort = "newest" | "oldest";

export interface PendingChangeQuery {
  operationId: string;
  requestGeneration: number;
  keyword: string;
  sort: PendingChangeSort;
  pageSize: number;
  cursor?: string;
}

export interface PendingChangeQueryStats {
  scannedCount: number;
  matchedCount: number;
  truncatedBySafetyLimit: boolean;
}

export interface PendingChangePage {
  requestGeneration: number;
  defaultChange?: PendingChange;
  items: PendingChange[];
  hasMore: boolean;
  nextCursor?: string;
  partial: boolean;
  stats: PendingChangeQueryStats;
}

export type PendingChangeMutationRequest = {
  operationId?: string;
} & (
  | { type: "create"; description: string; jobs?: string[] }
  | { type: "edit"; changeId: number; description: string; jobs: string[] }
  | { type: "delete"; changeId: number }
  | { type: "moveFiles"; targetChangeId: number; depotPaths: string[] }
);

export interface PendingChangeMutationResult {
  operation: OperationResult;
  createdChangeId?: number;
  affectedChanges: number[];
  affectedPaths: string[];
  refreshedChanges: PendingChange[];
  refreshError?: string;
}
/** S4f host lifecycle envelope (replaces the old result for opId calls; old payload stays in legacy). */
export type PendingClActionKind =
  "pendingClCreate" | "pendingClEdit" | "pendingClDelete";
export type PendingClLifecycleState =
  "intent" | "committed" | "unknown" | "legacy";
export interface PendingClChangeFact {
  changeId: number;
  description: string;
  fileCount?: number;
  jobs?: string[];
  present: boolean;
}
export interface PendingClMapping {
  placeholder: string;
  authoritativeChangeId?: number;
  source: string;
}
export interface PendingClActionResult {
  kind: PendingClActionKind;
  operationId?: string;
  state: PendingClLifecycleState;
  outcome: string;
  changes?: PendingClChangeFact[];
  createdChangeId?: number;
  mapping?: PendingClMapping;
  optimistic: "intentOnly";
  message: string;
  legacy?: PendingChangeMutationResult;
}

export interface SubmitPreflightRequest {
  changeId: number;
}

export type SubmitIssueCode =
  | "invalidTarget"
  | "changeNotFound"
  | "emptyDescription"
  | "emptyChange"
  | "unresolvedFiles"
  | "outOfDateFiles"
  | "lockedFiles"
  | "exclusiveOpenConflict"
  | "permissionDenied"
  | "shelvedFilesPresent"
  | "jobMissing"
  | "jobPolicyUnknown"
  | "fileStateUnknown"
  | "permissionUnknown"
  | "preflightUnavailable";

export interface SubmitIssue {
  code: SubmitIssueCode;
  certainty: "confirmed" | "unknown";
  message: string;
  paths?: string[];
}

export interface SubmitTargetSnapshot {
  server: string;
  user: string;
  client: string;
  workspace: string;
  changeId: number;
  contextGeneration: number;
}

export interface SubmitFileSummary {
  fileCount: number;
  depotPaths: string[];
  actionCounts: Record<string, number>;
  contentDigest: string;
}

export interface SubmitPreflight {
  ready: boolean;
  change?: PendingChange;
  blockers: SubmitIssue[];
  warnings: SubmitIssue[];
  target: SubmitTargetSnapshot;
  fileSummary: SubmitFileSummary;
  token?: string;
  expiresAt: number;
  ttlMs: number;
  operationIds: string[];
  logReference?: string;
  refreshRecommended: boolean;
}

export interface SubmitConfirmation {
  token: string;
  target: SubmitTargetSnapshot;
  operationId?: string;
}

export type SubmitFailureCode =
  | "tokenUnknown"
  | "tokenExpired"
  | "targetMismatch"
  | "contextChanged"
  | "changeChanged"
  | "preflightBlocked"
  | "offline"
  | "serverUnreachable"
  | "authExpired"
  | "permissionDenied"
  | "commandFailure"
  | "cancelled"
  | "uncertainOutcome";

export interface SubmitRefreshAdvice {
  pendingChanges: boolean;
  submittedChanges: boolean;
  workspaceStatus: boolean;
  depotPaths: string[];
  reason: string;
}

/**
 * Additive command-level lifecycle envelope for the migrated submit-native route
 * (S4g). It never carries per-file authority: `files` is intentionally empty.
 * Absent means a pre-dispatch rejection (nothing was submitted) or a legacy
 * payload. A submit is only presented as submitted when the authoritative
 * `outcome === "submitted"` and `submittedChangeId` come back with it.
 */
export interface SubmitExecution {
  kind: "submit";
  operationId: string;
  state: "commandCompleted" | "unknown";
  outcome: SubmitResult["outcome"];
  files: WorkflowFileResult[];
}

export interface SubmitResult {
  execution?: SubmitExecution;
  outcome: "submitted" | "rejected" | "failed" | "cancelled" | "unknown";
  changeId: number;
  submittedChangeId?: number;
  failure?: SubmitFailureCode;
  message: string;
  operationId?: string;
  logReference?: string;
  refresh: SubmitRefreshAdvice;
}

export type WorkflowIssueCertainty = "confirmed" | "unknown";
export type WorkflowIssueCode =
  | "invalidTarget"
  | "changeNotFound"
  | "fileNotInChange"
  | "fileNotShelved"
  | "existingShelfRequiresReplace"
  | "mappingFailed"
  | "localModification"
  | "alreadyOpened"
  | "lockedFile"
  | "permissionDenied"
  | "permissionUnknown"
  | "resolveLikely"
  | "resolveRequired"
  | "notResolvable"
  | "inspectionUnknown";

export interface WorkflowIssue {
  code: WorkflowIssueCode;
  certainty: WorkflowIssueCertainty;
  message: string;
  paths: string[];
}

export interface WorkflowTargetSnapshot {
  kind: "shelf" | "unshelve" | "resolve" | "move";
  server: string;
  user: string;
  client: string;
  workspace: string;
  contextGeneration: number;
  sourceChangeId?: number;
  targetChangeId?: number;
  depotPaths: string[];
}

export interface WorkflowRefreshAdvice {
  pendingChanges: boolean;
  workspaceStatus: boolean;
  depotPaths: string[];
  reason: string;
}

export interface ShelfPreflightRequest {
  changeId: number;
  depotPaths: string[];
  mode: "createOrUpdate" | "delete";
  replace?: boolean;
}

/** S4j direct shelved delete: host performs its internal preflight; FE sends one operationId. */
export interface ShelfDeleteDirectRequest {
  operationId?: string;
  changeId: number;
  depotPaths: string[];
}

/** Direct shelve: the host command performs its internal preflight; FE sends one operationId. */
export interface ShelveDirectRequest {
  operationId?: string;
  changeId: number;
  depotPaths: string[];
  replace?: boolean;
}

export interface ShelfScopeSummary {
  openedPaths: string[];
  existingShelvedPaths: string[];
  createPaths: string[];
  replacePaths: string[];
  deletePaths: string[];
  contentDigest: string;
}

export interface ShelfPreflight {
  ready: boolean;
  change?: PendingChange;
  blockers: WorkflowIssue[];
  warnings: WorkflowIssue[];
  target: WorkflowTargetSnapshot;
  scope: ShelfScopeSummary;
  token?: string;
  expiresAt: number;
  ttlMs: number;
  operationIds: string[];
  logReference?: string;
}

export interface MoveFilesPreflightRequest {
  targetChangeId: number;
  depotPaths: string[];
  operationId?: string;
}
export interface MoveFileCandidate {
  depotPath: string;
  sourceChangeId?: number;
  action: string;
  movable: boolean;
  message?: string;
}
export interface MoveFilesPreflight {
  ready: boolean;
  target: WorkflowTargetSnapshot;
  files: MoveFileCandidate[];
  blockers: WorkflowIssue[];
  warnings: WorkflowIssue[];
  contentDigest: string;
  token?: string;
  expiresAt: number;
  ttlMs: number;
  operationIds: string[];
  logReference?: string;
}
export interface MoveFilesResult {
  outcome: WorkflowOutcome;
  failure?: WorkflowFailureCode;
  message: string;
  operationIds: string[];
  logReference?: string;
  files: WorkflowFileResult[];
  affectedChanges: number[];
  refreshedChanges: PendingChange[];
  refreshError?: string;
  refresh: WorkflowRefreshAdvice;
}

export interface WorkflowConfirmation {
  token: string;
  target: WorkflowTargetSnapshot;
  operationId?: string;
}

export interface UnshelvePreflightRequest {
  sourceChangeId: number;
  depotPaths: string[];
  targetWorkspace: string;
  targetChangeId: number;
}

export interface UnshelveDirectRequest {
  operationId?: string;
  sourceChangeId: number;
  depotPaths: string[];
  // Defaults to the current client and the default changelist.
  targetWorkspace?: string;
  targetChangeId?: number;
}

export interface WriteFenceScope {
  server: string;
  user: string;
  client: string;
}

export interface WriteFence {
  active: boolean;
  fenceId: string;
  operationId: string;
  outcome: string;
  released: boolean;
  revision: string;
  scope: WriteFenceScope;
}

export interface AdmissionSnapshot {
  connection: unknown;
  fences: WriteFence[];
}

export interface FenceReleaseRequest {
  fenceId: string;
  revision: string;
  scope: WriteFenceScope;
  acknowledgeUnknown: boolean;
}
export interface UnshelveMapping {
  depotPath: string;
  targetPath?: string;
  mapped: boolean;
  locallyModified: boolean;
  openedChangeId?: number;
  locked: boolean;
  resolveRisk: "none" | "likely" | "unknown";
}

export interface UnshelvePreflight {
  ready: boolean;
  source?: PendingChange;
  targetChange?: PendingChange;
  mappings: UnshelveMapping[];
  blockers: WorkflowIssue[];
  warnings: WorkflowIssue[];
  target: WorkflowTargetSnapshot;
  contentDigest: string;
  token?: string;
  expiresAt: number;
  ttlMs: number;
  operationIds: string[];
  logReference?: string;
}

export type ResolveStrategy =
  "safe" | "acceptYours" | "acceptTheirs" | "mergePreview";

export interface ResolvePreflightRequest {
  depotPaths: string[];
  /** Re-resolve already resolved files with `p4 resolve -f` (target = last resolution). */
  force?: boolean;
  /** Runner prefix for the inspection; lets the dialog cancel an in-flight preflight. */
  operationId?: string;
}

export interface ResolveVersionSource {
  role: "base" | "yours" | "theirs" | "merge";
  depotPath?: string;
  revision?: number;
  description: string;
}

export interface ResolveConflictDetail {
  depotPath: string;
  clientPath?: string;
  conflictType: "content" | "filetype" | "branch" | "move" | "unknown";
  status: "unresolved" | "blocked" | "unknown";
  availableStrategies: ResolveStrategy[];
  sources: ResolveVersionSource[];
  preview: string[];
}

export interface ResolvePreflight {
  ready: boolean;
  conflicts: ResolveConflictDetail[];
  blockers: WorkflowIssue[];
  warnings: WorkflowIssue[];
  target: WorkflowTargetSnapshot;
  contentDigest: string;
  token?: string;
  expiresAt: number;
  ttlMs: number;
  operationIds: string[];
  logReference?: string;
}

export interface ResolveSelection {
  depotPath: string;
  strategy: Exclude<ResolveStrategy, "mergePreview">;
}

export interface ResolveConfirmation extends WorkflowConfirmation {
  resolutions: ResolveSelection[];
}

/** Additive readonly detail for the P4V Resolve version panes; absent fields stay placeholders. */
export interface ResolveStatsRequest {
  depotPath: string;
  baseDepotPath?: string;
  baseRevision?: number;
  sourceDepotPath?: string;
  sourceRevision?: number;
  targetPath?: string;
  /** Measure the `p4 resolve -f` (re-resolve) three-way state instead. */
  force?: boolean;
}

export interface ResolveVersionStats {
  depotPath?: string;
  revision?: number;
  change?: number;
  user?: string;
  time?: string;
  description?: string;
  diffBlocks?: number;
}

export interface ResolveTargetStats {
  path?: string;
  baseRevision?: number;
  diffBlocks?: number;
}

export interface ResolveStats {
  base: ResolveVersionStats;
  source: ResolveVersionStats;
  target: ResolveTargetStats;
  /** Conflict blocks reported by the host; undefined means the host did not count them. */
  conflicts?: number;
}

export interface ManualMergeOpenRequest {
  depotPath: string;
  operationId?: string;
}
export interface ManualMergeFileSnapshot {
  size: number;
  modifiedMs: number;
  contentDigest: string;
}
export interface ManualMergeSource {
  depotPath: string;
  revision: number;
}
export interface ManualMergeSession {
  sessionId: string;
  activeProfileId?: string;
  target: WorkflowTargetSnapshot;
  depotPath: string;
  localPath: string;
  baseSource: ManualMergeSource;
  theirsSource: ManualMergeSource;
  fileSnapshot: ManualMergeFileSnapshot;
  resolveDigest: string;
  base: string;
  theirs: string;
  yours: string;
  result: string;
  encoding: string;
  lineEnding: "LF" | "CRLF" | "mixed" | "none";
  hadBom: boolean;
  unresolvedBlocks: number;
  expiresAt: number;
  operationIds: string[];
}
export interface ManualMergeValidateRequest {
  sessionId: string;
  result: string;
  operationId?: string;
}
export interface ManualMergeValidation {
  valid: boolean;
  unresolvedBlocks: number;
  resultDigest: string;
  token?: string;
  expiresAt: number;
  message: string;
}
export interface ManualMergeSaveConfirmation {
  token: string;
  sessionId: string;
  resultDigest: string;
  operationId?: string;
}
export interface ManualMergeSaveResult {
  outcome: WorkflowOutcome;
  message: string;
  resultDigest: string;
  backupPath?: string;
  resolveToken?: string;
  resolveExpiresAt: number;
  operationId: string;
  refresh: WorkflowRefreshAdvice;
}
export interface ManualMergeResolveConfirmation {
  token: string;
  sessionId: string;
  resultDigest: string;
  acknowledge: boolean;
  operationId?: string;
}
/** Installed external merge tool (P4Merge) detection result. Never starts the GUI. */
export type ExternalMergeToolSource = "env" | "commonPath" | "path";
export interface ExternalMergeToolInfo {
  available: boolean;
  executable?: string;
  source?: ExternalMergeToolSource;
  reason?: string;
}
export interface ExternalMergeRequest {
  sessionId: string;
  result: string;
  operationId?: string;
}
export type ExternalMergeStatus =
  | "completed"
  | "unchanged"
  | "cancelled"
  | "failed"
  | "timeout"
  | "notInstalled";
/** Candidate result from P4Merge; it must still be reviewed, validated, and saved. */
export interface ExternalMergeResult {
  status: ExternalMergeStatus;
  result?: string;
  exitCode?: number;
  reason?: string;
  operationIds: string[];
}
/** S4c host lifecycle envelope. `optimistic` is always "intentOnly"; success needs committed facts/digest. */
export type MergeResolveKind =
  "resolve" | "manualMergeSession" | "manualMergeSave" | "manualMergeResolve";
export type MergeResolveLifecycleState =
  "intent" | "committed" | "unknown" | "rejected" | "legacy";
export interface MergeResolveFileResult {
  depotPath: string;
  state: string;
  message: string;
  operationId?: string;
}
export interface MergeResolveDetails {
  sessionId?: string;
  resultDigest?: string;
  backupPath?: string;
  valid?: boolean;
  unresolvedBlocks?: number;
  depotPath?: string;
}
export interface MergeResolveActionResult {
  kind: MergeResolveKind;
  operationId?: string;
  state: MergeResolveLifecycleState;
  outcome:
    "succeeded" | "partial" | "rejected" | "failed" | "cancelled" | "unknown";
  files?: MergeResolveFileResult[];
  message: string;
  optimistic: "intentOnly";
  details?: MergeResolveDetails;
  legacy?:
    | WorkflowResult
    | ManualMergeSession
    | ManualMergeValidation
    | ManualMergeSaveResult;
}

export interface WorkflowFileResult {
  depotPath: string;
  state:
    "succeeded" | "failed" | "cancelled" | "blocked" | "unknown" | "retained";
  message: string;
  operationId?: string;
}

export type WorkflowOutcome =
  "succeeded" | "partial" | "rejected" | "failed" | "cancelled" | "unknown";

export type WorkflowFailureCode =
  | "tokenUnknown"
  | "tokenExpired"
  | "targetMismatch"
  | "contextChanged"
  | "contentChanged"
  | "preflightBlocked"
  | "permissionDenied"
  | "commandFailure"
  | "cancelled"
  | "uncertainOutcome";

/**
 * Additive command-level lifecycle envelope (S4d SHELF/UNSHELVE). It never
 * carries per-file success: `files` is intentionally empty, and the top-level
 * result `files` stays empty too, because shelf membership and unshelve
 * completion have no authoritative per-file facts. An absent envelope means a
 * legacy payload (rejected/pre-migration) and keeps the old top-level fields.
 */
export interface WorkflowExecution {
  kind: "shelf" | "unshelve";
  operationId: string;
  state: "commandCompleted" | "unknown";
  outcome: WorkflowOutcome;
  files: WorkflowFileResult[];
}

export interface WorkflowResult {
  /** Absent for legacy payloads; present only for migrated command slices. */
  execution?: WorkflowExecution;
  outcome: WorkflowOutcome;
  failure?: WorkflowFailureCode;
  message: string;
  operationIds: string[];
  logReference?: string;
  files: WorkflowFileResult[];
  refresh: WorkflowRefreshAdvice;
}

export type FilePreviewKind = "text" | "image" | "table";

/** Why a bounded table preview page was clipped; null when nothing was clipped. */
export type FilePreviewTruncatedReason =
  "rowCap" | "colCap" | "cellCap" | "byteCap" | "budgetCap" | "timeout";

/**
 * Bounded first page of a CSV/XLSX preview. `rows` keeps the sheet's first row
 * as returned (the frontend decides whether to display it as a header), values
 * are already formatted by the backend, and `content` stays empty.
 */
export interface FilePreviewTable {
  format: "csv" | "xlsx";
  /** CSV: auto-detected delimiter. XLSX: null. */
  delimiter: "," | ";" | "\t" | "|" | null;
  sheetName: string | null;
  sheetIndex: number | null;
  /** XLSX: all worksheet names (bounded); CSV: null. */
  sheetNames: string[] | null;
  /** ≤500 rows × ≤64 columns, header row included, empty string = empty cell. */
  rows: string[][];
  /** Known total rows; CSV is always null, XLSX only when dimension is trusted. */
  rowCount: number | null;
  /** Provenance of `rowCount`; includes the header row and may include empty rows. */
  rowCountSource: "dimension" | null;
  hasMore: boolean;
  truncated: boolean;
  truncatedReason: FilePreviewTruncatedReason | null;
  /** Total worksheet columns when the backend knows it (column-cap wording). */
  totalColumns?: number | null;
}

export interface FilePreview {
  kind: FilePreviewKind;
  /** text: raw text; image: data URL; table: always "". */
  content: string;
  /** Real file bytes on disk (not the IPC payload size). */
  size: number;
  /** text/csv: encoding name; image: null. */
  encoding?: string | null;
  /** True when `encoding` is a guess rather than a BOM/declared value. */
  encodingGuess?: boolean;
  width?: number | null;
  height?: number | null;
  /** Present only for kind === "table". */
  table?: FilePreviewTable;
}

/** Optional preview request dimensions; v1 sends only `sheetIndex`. */
export interface FilePreviewRequestOptions {
  /** 0-based worksheet index (xlsx). Omitted means 0. */
  sheetIndex?: number;
  /** Reserved for paging; v1 never sends it. */
  offset?: number;
  /** Reserved for paging; v1 never sends it. */
  limit?: number;
}

export interface UndoTarget {
  depotPath: string;
  revision: number;
  changelistId: number;
}
export interface UndoPreview {
  target: UndoTarget;
  token: string;
  expiresAt: number;
  messages: string[];
}
export interface UndoConfirmation {
  target: UndoTarget;
  token: string;
}

export interface WorkspaceMutationRequest {
  expectedGeneration: number;
  workspace: string;
  action: "rename" | "delete";
  newName?: string;
}
export interface WorkspaceMutationPreview {
  token: string;
  request: WorkspaceMutationRequest;
  root: string;
  stream: string;
  expiresAt: number;
}
/**
 * Authoritative result for the workspace rename/delete lifecycle (S4i2). `verified`
 * comes from a post-write workspace-existence readback; `observedExists` is the
 * readback fact (delete => false; rename => old absent and new present). Exit code
 * alone is never success.
 */
export interface WorkspaceMutationResult {
  outcome: WorkflowOutcome;
  failure?: string;
  message: string;
  workspace: string;
  action: "rename" | "delete";
  verified: boolean;
  observedExists?: boolean;
}

export interface IntegrationTraceRequest {
  scope: FileReviewScope;
  paths: string[];
  refresh?: boolean;
  operationId?: string;
}
export interface IntegrationTraceRecord {
  sourcePath: string;
  targetPath: string;
  sourceStart: number;
  sourceEnd: number;
  targetStart: number;
  targetEnd: number;
  how: string;
  recordChange: number;
}
export interface IntegrationTraceBatch {
  records: IntegrationTraceRecord[];
  incomplete: boolean;
  warnings: string[];
  readAt: number;
}
