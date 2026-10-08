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
  | "outOfDate"
  | "conflicted"
  | "missing"
  | "ignored";
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
  | "renameMove"
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

export interface RuntimeInfo {
  mode: "mock" | "tauri";
  p4Version: string;
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
  requestGeneration: number;
  keyword: string;
  statuses: ChangeStatus[];
  users: string[];
  clients: string[];
  path?: string;
  stream?: string;
  from: string;
  to: string;
  hasShelf?: boolean;
  hasJob?: boolean;
  hideReliableMerges: boolean;
  limit: number;
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

export interface ClQueryResult {
  requestGeneration: number;
  changes: ChangelistSummary[];
  hiddenMergeCount: number;
  hasMore: boolean;
  nextCursor?: string;
}

export type ClAction =
  | { type: "create"; description: string }
  | { type: "edit"; changeId: number; description: string; jobs: string[] }
  | { type: "delete"; changeId: number }
  | { type: "moveFiles"; changeId: number; depotPaths: string[] }
  | {
      type: "shelve";
      changeId: number;
      depotPaths?: string[];
      replace?: boolean;
    }
  | { type: "deleteShelf"; changeId: number; depotPaths?: string[] }
  | { type: "unshelvePreview"; sourceChangeId: number; targetChangeId: number }
  | { type: "unshelve"; sourceChangeId: number; targetChangeId: number }
  | { type: "submitValidate"; changeId: number };

export interface ClActionResult {
  operation: OperationResult;
  affectedChanges: number[];
  warnings: string[];
}

export interface LogQuery {
  keyword?: string;
  levels?: LogLevel[];
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
export interface DiffResult {
  path: string;
  leftLabel: string;
  rightLabel: string;
  unified: string;
  binary: boolean;
}
export interface FileRevision {
  revision: number;
  changelistId: number;
  user: string;
  action: string;
  time: string;
  description: string;
}
export interface RevisionGraphNode {
  id: string;
  depotPath: string;
  revision: number;
  changelistId: number;
  label: string;
  x: number;
  y: number;
}
export interface RevisionGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: "revision" | "branch" | "merge" | "copy";
}
export interface RevisionGraph {
  nodes: RevisionGraphNode[];
  edges: RevisionGraphEdge[];
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

export interface FilePreview {
  kind: "text" | "image";
  content: string;
  size: number;
  encoding?: string | null;
  width?: number | null;
  height?: number | null;
}
