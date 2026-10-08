import type {
  ClAction,
  ClActionResult,
  ClQuery,
  ClQueryResult,
  SubmittedChangeDetail,
  SubmittedChangeDetailRequest,
  AuthenticationRequest,
  CacheDiagnostics,
  CliDiscoveryRequest,
  CliDiscoveryResult,
  ConnectionStatus,
  DiagnosticExportRequest,
  DiagnosticExportResult,
  DepotNode,
  DiffResult,
  FileActionRequest,
  FileActionResult,
  FileRevision,
  LogEntry,
  LogPage,
  LogPolicy,
  LogQuery,
  LoginRequest,
  OperationEvent,
  OperationResult,
  OpenLocalPathRequest,
  OperationJournalPage,
  OperationJournalQuery,
  OperationRecord,
  P4CommandRequest,
  PathResolveRequest,
  PathResolveResult,
  PendingChange,
  PendingChangeMutationRequest,
  PendingChangeMutationResult,
  SubmitConfirmation,
  SubmitPreflight,
  SubmitPreflightRequest,
  SubmitResult,
  ShelfPreflight,
  ShelfPreflightRequest,
  UnshelvePreflight,
  UnshelvePreflightRequest,
  ResolvePreflight,
  ResolvePreflightRequest,
  ResolveConfirmation,
  WorkflowConfirmation,
  WorkflowResult,
  RevisionGraph,
  RuntimeInfo,
  TrustRequest,
  WorkspaceNode,
} from "../../shared/contracts/types";

export interface Backend {
  statusCacheDiagnostics(): Promise<CacheDiagnostics>;
  queryOperationJournal(
    query: OperationJournalQuery,
  ): Promise<OperationJournalPage>;
  getOperationRecord(operationId: string): Promise<OperationRecord | null>;
  queryLogPage(query: LogQuery): Promise<LogPage>;
  getLogPolicy(): Promise<LogPolicy>;
  setLogPolicy(policy: LogPolicy): Promise<LogPolicy>;
  exportDiagnostics(
    request: DiagnosticExportRequest,
  ): Promise<DiagnosticExportResult>;
  workspaceDiskUsage(): Promise<
    import("../../shared/contracts/types").DiskUsage
  >;
  discoverP4Cli(request: CliDiscoveryRequest): Promise<CliDiscoveryResult>;
  testConnection(
    context: import("../../shared/contracts/types").P4Context,
  ): Promise<ConnectionStatus>;
  queryLoginStatus(
    context: import("../../shared/contracts/types").P4Context,
  ): Promise<ConnectionStatus>;
  trustServer(request: TrustRequest): Promise<ConnectionStatus>;
  login(request: LoginRequest): Promise<ConnectionStatus>;
  logout(request: AuthenticationRequest): Promise<ConnectionStatus>;
  openLocalPath(request: OpenLocalPathRequest): Promise<void>;
  localPathCapabilities(
    path: string,
  ): Promise<import("../../shared/contracts/types").LocalPathCapabilities>;
  listStreams(): Promise<
    import("../../shared/contracts/types").StreamSummary[]
  >;
  listUserWorkspaces(): Promise<
    import("../../shared/contracts/types").ClientWorkspace[]
  >;
  saveConnection(
    context: import("../../shared/contracts/types").P4Context,
  ): Promise<import("../../shared/contracts/types").P4Context>;
  runtimeInfo(): Promise<RuntimeInfo>;
  runP4(request: P4CommandRequest): Promise<OperationResult>;
  cancelOperation(operationId: string): Promise<void>;
  queryChangelists(query: ClQuery): Promise<ClQueryResult>;
  getSubmittedChangeDetail(
    request: SubmittedChangeDetailRequest,
  ): Promise<SubmittedChangeDetail>;
  performClAction(action: ClAction): Promise<ClActionResult>;
  queryLogs(query: LogQuery): Promise<LogEntry[]>;
  subscribeOperationEvents(
    callback: (event: OperationEvent) => void,
  ): Promise<() => void>;
  listWorkspaceChildren(path?: string): Promise<WorkspaceNode[]>;
  listDepotChildren(path?: string): Promise<DepotNode[]>;
  resolvePath(request: PathResolveRequest): Promise<PathResolveResult>;
  performFileAction(request: FileActionRequest): Promise<FileActionResult>;
  getFilePreview(
    path: string,
  ): Promise<import("../../shared/contracts/types").FilePreview>;
  getDiff(path: string): Promise<DiffResult>;
  getFileHistory(path: string): Promise<FileRevision[]>;
  getRevisionGraph(path: string): Promise<RevisionGraph>;
  queryPendingChanges(): Promise<PendingChange[]>;
  mutatePendingChange(
    request: PendingChangeMutationRequest,
  ): Promise<PendingChangeMutationResult>;
  preflightSubmit(request: SubmitPreflightRequest): Promise<SubmitPreflight>;
  confirmSubmit(confirmation: SubmitConfirmation): Promise<SubmitResult>;
  preflightShelf(request: ShelfPreflightRequest): Promise<ShelfPreflight>;
  confirmShelf(confirmation: WorkflowConfirmation): Promise<WorkflowResult>;
  preflightUnshelve(
    request: UnshelvePreflightRequest,
  ): Promise<UnshelvePreflight>;
  confirmUnshelve(confirmation: WorkflowConfirmation): Promise<WorkflowResult>;
  preflightResolve(request: ResolvePreflightRequest): Promise<ResolvePreflight>;
  confirmResolve(confirmation: ResolveConfirmation): Promise<WorkflowResult>;
}
