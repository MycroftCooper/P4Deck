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
  ConnectionProfiles,
  ConnectionProfile,
  CreateConnectionProfileRequest,
  UpdateConnectionProfileRequest,
  DeleteConnectionProfileRequest,
  SetActiveConnectionProfileRequest,
  SwitchWorkspaceRequest,
  DiagnosticExportRequest,
  DiagnosticExportResult,
  DiagnosticAlert,
  DepotNode,
  DiffResult,
  DiffRequest,
  FileActionRequest,
  FileActionResult,
  FileLockPreflightRequest,
  FileLockPreflight,
  FileLockConfirmation,
  FileLockResult,
  ForceUnlockPreflightRequest,
  ForceUnlockPreflight,
  ForceUnlockConfirmation,
  ForceUnlockResult,
  RenameMovePreflightRequest,
  RenameMovePreflight,
  RenameMoveConfirmation,
  RenameMoveResult,
  SyncPreviewRequest,
  SyncPreviewPlan,
  SyncConfirmRequest,
  SyncResult,
  StreamSwitchPreflightRequest,
  StreamSwitchPreflight,
  StreamSwitchConfirmation,
  StreamSwitchResult,
  StreamGraphQuery,
  StreamGraphResult,
  BranchMappingQuery,
  BranchMappingPage,
  BranchMappingDetailQuery,
  BranchMappingDetailResult,
  BranchImpactPreviewQuery,
  BranchImpactPreview,
  BranchMutationPreflightRequest,
  BranchMutationPreflight,
  BranchMutationConfirmation,
  BranchMutationResult,
  FileHistoryPage,
  FileHistoryRequest,
  GlobalSearchQuery,
  GlobalSearchResult,
  LogEntry,
  LogPage,
  LogPolicy,
  LogQuery,
  LoginRequest,
  OperationEvent,
  OperationResult,
  OpenLocalPathRequest,
  OpenSwarmLinkRequest,
  OperationJournalPage,
  OperationJournalQuery,
  OperationRecord,
  P4CommandRequest,
  PathResolveRequest,
  PathResolveResult,
  PendingChangePage,
  PendingChangeQuery,
  PendingChangeMutationRequest,
  PendingChangeMutationResult,
  SubmitConfirmation,
  SubmitPreflight,
  SubmitPreflightRequest,
  SubmitResult,
  ShelfPreflight,
  ShelfPreflightRequest,
  ShelfDetail,
  ShelfDetailRequest,
  ShelfFilePreview,
  ShelfFilePreviewRequest,
  MoveFilesPreflight,
  MoveFilesPreflightRequest,
  MoveFilesResult,
  UnshelvePreflight,
  UnshelvePreflightRequest,
  ResolvePreflight,
  ResolvePreflightRequest,
  ResolveConfirmation,
  ManualMergeOpenRequest,
  ManualMergeSession,
  ManualMergeValidateRequest,
  ManualMergeValidation,
  ManualMergeSaveConfirmation,
  ManualMergeSaveResult,
  ManualMergeResolveConfirmation,
  WorkflowConfirmation,
  WorkflowResult,
  RevisionGraph,
  RevisionGraphRequest,
  RuntimeInfo,
  TrustRequest,
  WorkspaceListing,
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
  subscribeDiagnosticAlerts(
    callback: (alert: DiagnosticAlert) => void,
  ): Promise<() => void>;
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
  openSwarmLink(request: OpenSwarmLinkRequest): Promise<void>;
  localPathCapabilities(
    path: string,
  ): Promise<import("../../shared/contracts/types").LocalPathCapabilities>;
  listStreams(): Promise<
    import("../../shared/contracts/types").StreamSummary[]
  >;
  queryStreamGraph(query: StreamGraphQuery): Promise<StreamGraphResult>;
  queryBranchMappings(query: BranchMappingQuery): Promise<BranchMappingPage>;
  getBranchMappingDetail(
    query: BranchMappingDetailQuery,
  ): Promise<BranchMappingDetailResult>;
  previewBranchMappingImpact(
    query: BranchImpactPreviewQuery,
  ): Promise<BranchImpactPreview>;
  preflightBranchMappingMutation(
    request: BranchMutationPreflightRequest,
  ): Promise<BranchMutationPreflight>;
  confirmBranchMappingMutation(
    confirmation: BranchMutationConfirmation,
  ): Promise<BranchMutationResult>;
  preflightStreamSwitch(
    request: StreamSwitchPreflightRequest,
  ): Promise<StreamSwitchPreflight>;
  confirmStreamSwitch(
    confirmation: StreamSwitchConfirmation,
  ): Promise<StreamSwitchResult>;
  listUserWorkspaces(): Promise<
    import("../../shared/contracts/types").ClientWorkspace[]
  >;
  listConnectionProfiles(): Promise<ConnectionProfiles>;
  getActiveConnectionProfile(): Promise<ConnectionProfile | null>;
  createConnectionProfile(
    request: CreateConnectionProfileRequest,
  ): Promise<ConnectionProfiles>;
  updateConnectionProfile(
    request: UpdateConnectionProfileRequest,
  ): Promise<ConnectionProfiles>;
  deleteConnectionProfile(
    request: DeleteConnectionProfileRequest,
  ): Promise<ConnectionProfiles>;
  setActiveConnectionProfile(
    request: SetActiveConnectionProfileRequest,
  ): Promise<RuntimeInfo>;
  switchWorkspace(request: SwitchWorkspaceRequest): Promise<RuntimeInfo>;
  saveConnection(
    context: import("../../shared/contracts/types").P4Context,
  ): Promise<import("../../shared/contracts/types").P4Context>;
  runtimeInfo(): Promise<RuntimeInfo>;
  runP4(request: P4CommandRequest): Promise<OperationResult>;
  cancelOperation(operationId: string): Promise<void>;
  globalSearch(query: GlobalSearchQuery): Promise<GlobalSearchResult>;
  queryChangelists(query: ClQuery): Promise<ClQueryResult>;
  getSubmittedChangeDetail(
    request: SubmittedChangeDetailRequest,
  ): Promise<SubmittedChangeDetail>;
  performClAction(action: ClAction): Promise<ClActionResult>;
  queryLogs(query: LogQuery): Promise<LogEntry[]>;
  subscribeOperationEvents(
    callback: (event: OperationEvent) => void,
  ): Promise<() => void>;
  listWorkspaceChildren(
    path?: string,
    refresh?: boolean,
    operationId?: string,
  ): Promise<WorkspaceListing>;
  listDepotChildren(path?: string): Promise<DepotNode[]>;
  resolvePath(request: PathResolveRequest): Promise<PathResolveResult>;
  performFileAction(request: FileActionRequest): Promise<FileActionResult>;
  preflightFileLock(
    request: FileLockPreflightRequest,
  ): Promise<FileLockPreflight>;
  confirmFileLock(confirmation: FileLockConfirmation): Promise<FileLockResult>;
  preflightForceUnlock(
    request: ForceUnlockPreflightRequest,
  ): Promise<ForceUnlockPreflight>;
  confirmForceUnlock(
    confirmation: ForceUnlockConfirmation,
  ): Promise<ForceUnlockResult>;
  preflightRenameMove(
    request: RenameMovePreflightRequest,
  ): Promise<RenameMovePreflight>;
  confirmRenameMove(
    confirmation: RenameMoveConfirmation,
  ): Promise<RenameMoveResult>;
  previewSync(request: SyncPreviewRequest): Promise<SyncPreviewPlan>;
  confirmSync(confirmation: SyncConfirmRequest): Promise<SyncResult>;
  getFilePreview(
    path: string,
  ): Promise<import("../../shared/contracts/types").FilePreview>;
  getDiff(request: DiffRequest): Promise<DiffResult>;
  getFileHistory(request: FileHistoryRequest): Promise<FileHistoryPage>;
  getRevisionGraph(request: RevisionGraphRequest): Promise<RevisionGraph>;
  queryPendingChanges(query: PendingChangeQuery): Promise<PendingChangePage>;
  mutatePendingChange(
    request: PendingChangeMutationRequest,
  ): Promise<PendingChangeMutationResult>;
  preflightSubmit(request: SubmitPreflightRequest): Promise<SubmitPreflight>;
  confirmSubmit(confirmation: SubmitConfirmation): Promise<SubmitResult>;
  preflightShelf(request: ShelfPreflightRequest): Promise<ShelfPreflight>;
  confirmShelf(confirmation: WorkflowConfirmation): Promise<WorkflowResult>;
  getShelfDetail(request: ShelfDetailRequest): Promise<ShelfDetail>;
  getShelfFilePreview(
    request: ShelfFilePreviewRequest,
  ): Promise<ShelfFilePreview>;
  preflightMoveFiles(
    request: MoveFilesPreflightRequest,
  ): Promise<MoveFilesPreflight>;
  confirmMoveFiles(
    confirmation: WorkflowConfirmation,
  ): Promise<MoveFilesResult>;
  preflightUnshelve(
    request: UnshelvePreflightRequest,
  ): Promise<UnshelvePreflight>;
  confirmUnshelve(confirmation: WorkflowConfirmation): Promise<WorkflowResult>;
  preflightResolve(request: ResolvePreflightRequest): Promise<ResolvePreflight>;
  confirmResolve(confirmation: ResolveConfirmation): Promise<WorkflowResult>;
  openManualMerge(request: ManualMergeOpenRequest): Promise<ManualMergeSession>;
  validateManualMerge(
    request: ManualMergeValidateRequest,
  ): Promise<ManualMergeValidation>;
  confirmManualMergeSave(
    confirmation: ManualMergeSaveConfirmation,
  ): Promise<ManualMergeSaveResult>;
  confirmManualMergeResolve(
    confirmation: ManualMergeResolveConfirmation,
  ): Promise<WorkflowResult>;
}
