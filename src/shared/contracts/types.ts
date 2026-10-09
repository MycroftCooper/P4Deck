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
export type FileState =
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
export type WorkspaceResolveState = "none" | "unresolved" | "unknown";
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
export type LogLevel = "info" | "warning" | "error";
export type ChangeStatus = "pending" | "submitted" | "shelved";
export type MergeClassification =
  "normal" | "reliableMerge" | "suspectedMerge" | "unknown";

export interface P4Context {
  executable?: string;
  server: string;
  user: string;
  client: string;
  cwd?: string;
  charset?: string;
  trustPath?: string;
  ticketsPath?: string;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  context: P4Context;
}

export interface ConnectionProfiles {
  schemaVersion: 2;
  revision: number;
  activeProfileId?: string;
  profiles: ConnectionProfile[];
}

export interface CreateConnectionProfileRequest {
  expectedRevision: number;
  name: string;
  context: P4Context;
}

export interface UpdateConnectionProfileRequest extends CreateConnectionProfileRequest {
  id: string;
}

export interface DeleteConnectionProfileRequest {
  expectedRevision: number;
  id: string;
}

export interface SetActiveConnectionProfileRequest extends DeleteConnectionProfileRequest {}

export interface SwitchWorkspaceRequest {
  expectedGeneration: number;
  client: string;
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
}

export interface LoginRequest {
  context: P4Context;
  password: string;
  confirmed: boolean;
}

export interface AuthenticationRequest {
  context: P4Context;
  confirmed: boolean;
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
  from: string;
  to: string;
  jobs: string[];
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
  "submittedChange" | "pendingChange" | "workspaceFile" | "depotFile" | "job";

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
  | { type: "job"; jobId: string };

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

export interface DiagnosticAlert {
  operationId: string;
  level: "warning" | "error";
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
  | "interrupted";
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
  cacheFreshness: "fresh" | "stale" | "offlineFallback";
}

export type OpenLocalPathMode = "reveal" | "openWith";
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
  /** Opt-in P4-native parallel transfer threads; currently restricted to 2–4. */
  parallelThreads?: number;
}

export interface FileActionResult {
  operation?: OperationResult;
  affectedPaths: string[];
  message: string;
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
  fileType?: string;
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

export interface SubmitResult {
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

export interface WorkflowFileResult {
  depotPath: string;
  state: "succeeded" | "failed" | "cancelled" | "blocked" | "unknown";
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

export interface WorkflowResult {
  outcome: WorkflowOutcome;
  failure?: WorkflowFailureCode;
  message: string;
  operationIds: string[];
  logReference?: string;
  files: WorkflowFileResult[];
  refresh: WorkflowRefreshAdvice;
}

export interface FilePreview {
  kind: "text" | "image";
  content: string;
  size: number;
  encoding?: string | null;
  width?: number | null;
  height?: number | null;
}
