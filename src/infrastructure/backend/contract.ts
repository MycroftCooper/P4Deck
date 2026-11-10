import type {
  IntegrationTraceRequest,
  IntegrationTraceBatch,
} from "../../shared/contracts";
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
  ConfigBackupOverview,
  ConnectionStatus,
  ConnectionProfiles,
  ConnectionProfile,
  CreateConnectionProfileRequest,
  UpdateConnectionProfileRequest,
  DeleteConnectionProfileRequest,
  SetActiveConnectionProfileRequest,
  SwitchWorkspaceRequest,
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
  P4VfsInspectRequest,
  P4VfsStatus,
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
  UnshelveDirectRequest,
  UnshelvePreflight,
  UnshelvePreflightRequest,
  ResolvePreflight,
  ResolvePreflightRequest,
  ResolveConfirmation,
  ResolveStats,
  ResolveStatsRequest,
  ManualMergeOpenRequest,
  ManualMergeSession,
  ManualMergeValidateRequest,
  ManualMergeValidation,
  ManualMergeSaveConfirmation,
  ManualMergeSaveResult,
  ManualMergeResolveConfirmation,
  ExternalMergeToolInfo,
  ExternalMergeRequest,
  ExternalMergeResult,
  WorkflowConfirmation,
  WorkflowResult,
  RevisionGraph,
  RevisionGraphRequest,
  RuntimeInfo,
  TrustRequest,
  WorkspaceListing,
  ConnectionDirectoryRequest,
  ConnectionUserDirectoryResult,
  ConnectionWorkspaceDirectoryResult,
  ConnectionUserCreatePreflightRequest,
  ConnectionWorkspaceCreatePreflightRequest,
  ConnectionSpecCreatePreflight,
  ConnectionSpecCreateConfirmation,
  ConnectionSpecCreateResult,
} from "../../shared/contracts";

export interface Backend {
  selectedMoveLookup(
    request: import("../../features/changelists/selectedMove").SelectedMoveLookup,
  ): Promise<
    import("../../features/changelists/selectedMove").SelectedMoveLookupResult
  >;
  selectedMoveExecute(
    request: import("../../features/changelists/selectedMove").SelectedMoveRequest,
  ): Promise<
    import("../../features/changelists/selectedMove").SelectedMoveReceipt
  >;
  selectedMoveStatus(
    request: import("../../features/changelists/selectedMove").SelectedMoveLookup,
  ): Promise<
    import("../../features/changelists/selectedMove").SelectedMoveReceipt | null
  >;
  selectedSubmitPrepare(
    request: import("../../features/changelists/selectedSubmit").SelectedSubmitRequest,
  ): Promise<
    import("../../features/changelists/selectedSubmit").SelectedSubmitReceipt
  >;
  selectedSubmitStatus(
    request: import("../../features/changelists/selectedSubmit").SelectedSubmitLookup,
  ): Promise<
    | import("../../features/changelists/selectedSubmit").SelectedSubmitReceipt
    | null
  >;
  selectedSubmitClaim(
    request: import("../../features/changelists/selectedSubmit").SelectedSubmitLookup,
  ): Promise<
    import("../../features/changelists/selectedSubmit").SelectedSubmitReceipt
  >;
  customSubmitStart(
    request: import("../../features/companySubmit/customSubmit").CustomSubmitStartRequest,
  ): Promise<
    | import("../../features/companySubmit/customSubmit").CustomSubmitSession
    | import("../../features/companySubmit/customSubmitLifecycle").CustomSubmitActionResult
  >;
  customSubmitStatus(): Promise<
    | import("../../features/companySubmit/customSubmit").CustomSubmitSession
    | import("../../features/companySubmit/customSubmitLifecycle").CustomSubmitActionResult
    | null
  >;
  companySubmitConnectionSnapshot(): Promise<
    import("../../features/companySubmit/model").ConnectionSnapshot
  >;
  createConfigBackup(
    request: import("../../shared/contracts").BackupCreateActionRequest,
  ): Promise<import("../../shared/contracts").ControlPlaneActionResult>;
  listConfigBackups(): Promise<ConfigBackupOverview>;
  restoreConfigBackup(
    request: import("../../shared/contracts").BackupRestoreActionRequest,
  ): Promise<import("../../shared/contracts").ControlPlaneActionResult>;
  openConfigBackupsFolder(): Promise<void>;
  statusCacheDiagnostics(): Promise<CacheDiagnostics>;
  queryOperationJournal(
    query: OperationJournalQuery,
  ): Promise<OperationJournalPage>;
  getOperationRecord(operationId: string): Promise<OperationRecord | null>;
  queryLogPage(query: LogQuery): Promise<LogPage>;
  getLogPolicy(): Promise<LogPolicy>;
  setLogPolicy(
    request: import("../../shared/contracts").SetLogPolicyActionRequest,
  ): Promise<import("../../shared/contracts").ControlPlaneActionResult>;
  openLogsFolder(): Promise<void>;
  deleteAllLogs(
    request?: import("../../shared/contracts").ClearLogsActionRequest,
  ): Promise<import("../../shared/contracts").ControlPlaneActionResult>;
  subscribeLogsCleared(callback: () => void): Promise<() => void>;
  exportDiagnostics(
    request: import("../../shared/contracts").DiagnosticsExportActionRequest,
  ): Promise<import("../../shared/contracts").ControlPlaneActionResult>;
  subscribeDiagnosticAlerts(
    callback: (alert: DiagnosticAlert) => void,
  ): Promise<() => void>;
  workspaceDiskUsage(): Promise<import("../../shared/contracts").DiskUsage>;
  discoverP4Cli(request: CliDiscoveryRequest): Promise<CliDiscoveryResult>;
  testConnection(
    context: import("../../shared/contracts").P4Context,
  ): Promise<ConnectionStatus>;
  queryLoginStatus(
    context: import("../../shared/contracts").P4Context,
  ): Promise<ConnectionStatus>;
  trustServer(request: TrustRequest): Promise<ConnectionStatus>;
  login(request: LoginRequest): Promise<ConnectionStatus>;
  logout(request: AuthenticationRequest): Promise<ConnectionStatus>;
  openLocalPath(request: OpenLocalPathRequest): Promise<void>;
  openSwarmLink(request: OpenSwarmLinkRequest): Promise<void>;
  /** Open an allowlisted product-site page (About card links). */
  openExternalUrl(url: string): Promise<void>;
  localPathCapabilities(
    path: string,
  ): Promise<import("../../shared/contracts").LocalPathCapabilities>;
  listStreams(): Promise<import("../../shared/contracts").StreamSummary[]>;
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
    import("../../shared/contracts").ClientWorkspace[]
  >;
  browseConnectionUsers(
    request: ConnectionDirectoryRequest,
  ): Promise<ConnectionUserDirectoryResult>;
  browseConnectionWorkspaces(
    request: ConnectionDirectoryRequest,
  ): Promise<ConnectionWorkspaceDirectoryResult>;
  preflightCreateConnectionUser(
    request: ConnectionUserCreatePreflightRequest,
  ): Promise<ConnectionSpecCreatePreflight>;
  preflightCreateConnectionWorkspace(
    request: ConnectionWorkspaceCreatePreflightRequest,
  ): Promise<ConnectionSpecCreatePreflight>;
  confirmCreateConnectionUser(
    confirmation: ConnectionSpecCreateConfirmation,
  ): Promise<ConnectionSpecCreateResult>;
  confirmCreateConnectionWorkspace(
    confirmation: ConnectionSpecCreateConfirmation,
  ): Promise<ConnectionSpecCreateResult>;
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
  preflightWorkspaceMutation(
    request: import("../../shared/contracts").WorkspaceMutationRequest,
  ): Promise<import("../../shared/contracts").WorkspaceMutationPreview>;
  confirmWorkspaceMutation(
    token: string,
    operationId?: string,
  ): Promise<import("../../shared/contracts").WorkspaceMutationResult>;
  switchWorkspace(request: SwitchWorkspaceRequest): Promise<RuntimeInfo>;
  saveConnection(
    context: import("../../shared/contracts").P4Context,
  ): Promise<import("../../shared/contracts").P4Context>;
  runtimeInfo(): Promise<RuntimeInfo>;
  inspectP4Vfs(request: P4VfsInspectRequest): Promise<P4VfsStatus>;
  runP4(request: P4CommandRequest): Promise<OperationResult>;
  cancelOperation(
    operationId: string,
  ): Promise<import("../../shared/contracts").CancelOperationResult | void>;
  cancelAllOperations(): Promise<
    import("../../shared/contracts").CancelOperationResult | void
  >;
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
    localOnly?: boolean,
  ): Promise<WorkspaceListing>;
  listDepotChildren(path?: string): Promise<DepotNode[]>;
  resolvePath(request: PathResolveRequest): Promise<PathResolveResult>;
  performFileAction(
    request: FileActionRequest,
    connection?: import("../../features/companySubmit/model").ConnectionSnapshot,
  ): Promise<FileActionResult>;
  preflightFileLock(
    request: FileLockPreflightRequest,
  ): Promise<FileLockPreflight>;
  confirmFileLock(confirmation: FileLockConfirmation): Promise<FileLockResult>;
  preflightRenameMove(
    request: RenameMovePreflightRequest,
  ): Promise<RenameMovePreflight>;
  confirmRenameMove(
    confirmation: RenameMoveConfirmation,
  ): Promise<
    RenameMoveResult | import("../../shared/contracts").LocalIoActionResult
  >;
  previewUndo(
    request: import("../../shared/contracts").UndoTarget,
  ): Promise<import("../../shared/contracts").UndoPreview>;
  confirmUndo(
    confirmation: import("../../shared/contracts").UndoConfirmation,
  ): Promise<
    OperationResult | import("../../shared/contracts").LocalIoActionResult
  >;
  previewSync(request: SyncPreviewRequest): Promise<SyncPreviewPlan>;
  confirmSync(
    confirmation: SyncConfirmRequest,
  ): Promise<SyncResult | import("../../shared/contracts").LocalIoActionResult>;
  /** One-click Get Latest: no preview/confirmation; P4 resolves conflicts as usual. */
  syncLatest(request: SyncPreviewRequest): Promise<SyncResult>;
  getFilePreview(
    path: string,
    options?: import("../../shared/contracts").FilePreviewRequestOptions,
  ): Promise<import("../../shared/contracts").FilePreview>;
  getDiff(request: DiffRequest): Promise<DiffResult>;
  getFileHistory(request: FileHistoryRequest): Promise<FileHistoryPage>;
  getIntegrationTrace(
    request: IntegrationTraceRequest,
  ): Promise<IntegrationTraceBatch>;
  getRevisionGraph(request: RevisionGraphRequest): Promise<RevisionGraph>;
  queryPendingChanges(query: PendingChangeQuery): Promise<PendingChangePage>;
  mutatePendingChange(
    request: PendingChangeMutationRequest,
  ): Promise<
    | PendingChangeMutationResult
    | import("../../shared/contracts").PendingClActionResult
  >;
  preflightSubmit(request: SubmitPreflightRequest): Promise<SubmitPreflight>;
  confirmSubmit(confirmation: SubmitConfirmation): Promise<SubmitResult>;
  preflightShelf(request: ShelfPreflightRequest): Promise<ShelfPreflight>;
  confirmShelf(confirmation: WorkflowConfirmation): Promise<WorkflowResult>;
  deleteShelvedRevisions(
    request: import("../../shared/contracts").ShelfDeleteDirectRequest,
  ): Promise<WorkflowResult>;
  shelveFiles(
    request: import("../../shared/contracts").ShelveDirectRequest,
  ): Promise<WorkflowResult>;
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
  /** Fences that block new write operations on the active server. */
  actionWriteFences(): Promise<
    import("../../shared/contracts").AdmissionSnapshot
  >;
  /** Explicit user acknowledgement releases one unknown/running fence (never a success claim). */
  actionReleaseUnknown(
    request: import("../../shared/contracts").FenceReleaseRequest,
  ): Promise<string>;
  preflightUnshelve(
    request: UnshelvePreflightRequest,
  ): Promise<UnshelvePreflight>;
  confirmUnshelve(confirmation: WorkflowConfirmation): Promise<WorkflowResult>;
  /** One-step unshelve: the host validates internally; no FE preflight dialog. */
  unshelveFiles(request: UnshelveDirectRequest): Promise<WorkflowResult>;
  preflightResolve(request: ResolvePreflightRequest): Promise<ResolvePreflight>;
  confirmResolve(
    confirmation: ResolveConfirmation,
  ): Promise<
    WorkflowResult | import("../../shared/contracts").MergeResolveActionResult
  >;
  /** Read-only P4V Resolve detail; missing host fields stay placeholders in the UI. */
  resolveStats(request: ResolveStatsRequest): Promise<ResolveStats>;
  openManualMerge(
    request: ManualMergeOpenRequest,
  ): Promise<
    | ManualMergeSession
    | import("../../shared/contracts").MergeResolveActionResult
  >;
  validateManualMerge(
    request: ManualMergeValidateRequest,
  ): Promise<
    | ManualMergeValidation
    | import("../../shared/contracts").MergeResolveActionResult
  >;
  confirmManualMergeSave(
    confirmation: ManualMergeSaveConfirmation,
  ): Promise<
    | ManualMergeSaveResult
    | import("../../shared/contracts").MergeResolveActionResult
  >;
  confirmManualMergeResolve(
    confirmation: ManualMergeResolveConfirmation,
  ): Promise<
    WorkflowResult | import("../../shared/contracts").MergeResolveActionResult
  >;
  detectExternalMergeTool(): Promise<ExternalMergeToolInfo>;
  runExternalMerge(request: ExternalMergeRequest): Promise<ExternalMergeResult>;
}
