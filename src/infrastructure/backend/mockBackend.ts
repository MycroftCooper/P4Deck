import { journalMappingForLogLevel } from "../../features/tools/logLevels";
import type {
  ChangelistSummary,
  ConfigBackupSummary,
  FilePreview,
  FilePreviewRequestOptions,
  FileState,
  GlobalSearchItem,
  GlobalSearchKind,
  DiagnosticAlert,
  LogEntry,
  OperationRecord,
  OperationEvent,
  PendingChange,
  SubmitPreflight,
  SubmitTargetSnapshot,
  RenameMoveTargetSnapshot,
  WorkflowTargetSnapshot,
  WorkspaceOpenedAction,
  WorkspaceNode,
} from "../../shared/contracts";
import type { Backend } from "./contract";
import { inspectTerminalCommand } from "../../features/tools/terminalSecurity";
import { isBackupLocalStorageKey } from "../../features/settings/backupState";

let mockContext: import("../../shared/contracts").P4Context = {
  server: "ssl:p4.company.dev:1666",
  user: "fmeng",
  client: "atlas-main-fm",
  cwd: "/workspace/atlas",
  charset: "utf8",
};
let mockContextGeneration = 1;
let mockProfileRevision = 1;
let mockActiveProfileId: string | undefined = "mock-primary-profile";
let mockProfiles: import("../../shared/contracts").ConnectionProfile[] = [
  { id: mockActiveProfileId, name: "Primary", context: { ...mockContext } },
];
let mockAuthentication: "connected" | "authRequired" = "connected";
let mockCurrentStream = "//atlas/main";
const mockConfigBackups: ConfigBackupSummary[] = [];
const mockConfigBackupStorage = new Map<
  string,
  import("../../shared/contracts").ConfigBackupLocalStorageEntry[]
>();
const mockConnectionUsers = new Map([
  [
    "fmeng",
    { name: "fmeng", fullName: "Feng Meng", email: "fmeng@example.invalid" },
  ],
  ["buildbot", { name: "buildbot", fullName: "Build Bot", email: "" }],
  ["reviewer", { name: "reviewer", fullName: "Code Reviewer", email: "" }],
]);
const mockConnectionWorkspaces = new Map<
  string,
  import("../../shared/contracts").ConnectionWorkspaceCandidate
>();
const mockConnectionSpecTokens = new Map<
  string,
  {
    kind: "userSelf" | "workspace";
    name: string;
    context: import("../../shared/contracts").P4Context;
    requestGeneration: number;
    stateDigest: string;
    plan:
      | import("../../shared/contracts").ConnectionUserCreatePlan
      | import("../../shared/contracts").ConnectionWorkspaceCreatePlan;
    expiresAt: number;
  }
>();
const mockStreamSwitchTokens = new Map<
  string,
  {
    target: import("../../shared/contracts").StreamSwitchTargetSnapshot;
    digest: string;
    expiresAt: number;
    hasWarnings: boolean;
  }
>();
const mockBranchDetails = new Map<
  string,
  import("../../shared/contracts").BranchMappingDetail
>([
  [
    "atlas-release",
    {
      name: "atlas-release",
      owner: "fmeng",
      update: "1700000000",
      access: "1700000100",
      description: "Browser Mock simulated release mapping",
      locked: false,
      view: [
        {
          modifier: "map",
          source: "//atlas/main/...",
          target: "//atlas/release/...",
        },
        {
          modifier: "exclude",
          source: "//atlas/main/private/...",
          target: "//atlas/release/private/...",
        },
      ],
      unknownFields: [],
      editable: true,
      operationIds: ["browser-mock-seed"],
      simulated: true,
    },
  ],
]);
const mockBranchCursors = new Map<
  string,
  {
    items: import("../../shared/contracts").BranchMappingSummary[];
    offset: number;
    queryKey: string;
    expiresAt: number;
  }
>();
const mockBranchTokens = new Map<
  string,
  {
    target: import("../../shared/contracts").BranchMutationTarget;
    digest: string;
    expiresAt: number;
  }
>();
const mockSubmitTokens = new Map<
  string,
  { target: SubmitTargetSnapshot; digest: string; expiresAt: number }
>();
const mockWorkflowTokens = new Map<
  string,
  {
    target: WorkflowTargetSnapshot;
    digest: string;
    expiresAt: number;
    request: unknown;
  }
>();
const mockSyncTokens = new Map<
  string,
  {
    target: import("../../shared/contracts").SyncTargetSnapshot;
    digest: string;
    expiresAt: number;
    counts: import("../../shared/contracts").SyncPlanCounts;
  }
>();
const mockRenameTokens = new Map<
  string,
  {
    target: RenameMoveTargetSnapshot;
    digest: string;
    expiresAt: number;
  }
>();
const mockLockTokens = new Map<
  string,
  {
    target: import("../../shared/contracts").FileLockTargetSnapshot;
    digest: string;
    expiresAt: number;
  }
>();
const mockGlobalSearchSnapshots = new Map<
  string,
  {
    signature: string;
    items: GlobalSearchItem[];
    facets: Array<{
      kind: GlobalSearchKind;
      matchedCount: number;
      scannedCount: number;
      partial: boolean;
      partialReason?: string;
    }>;
    nextOffset: number;
    createdAt: number;
  }
>();
const mockCancelledOperations = new Set<string>();
type MockShelfFile = import("../../shared/contracts").ShelfDetailFile;
const mockShelfSnapshots = new Map<
  string,
  {
    signature: string;
    files: MockShelfFile[];
    issued: Map<string, number>;
    createdAt: number;
  }
>();

function mockShelfError(
  code: import("../../shared/contracts").ShelfDetailRequestErrorCode,
  message: string,
) {
  return { code, message };
}

function encodeMockShelfCursor(
  snapshotId: string,
  cursorId: string,
  offset: number,
  signature: string,
) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      snapshotId,
      cursorId,
      offset,
      signature,
      generation: mockContextGeneration,
      profile: mockActiveProfileId,
    }),
  );
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeMockShelfCursor(cursor: string, signature: string) {
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const value = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
          (character) => character.charCodeAt(0),
        ),
      ),
    );
    if (
      value.version !== 1 ||
      value.signature !== signature ||
      value.generation !== mockContextGeneration ||
      value.profile !== mockActiveProfileId ||
      typeof value.snapshotId !== "string" ||
      typeof value.cursorId !== "string" ||
      !Number.isSafeInteger(value.offset) ||
      value.offset <= 0
    )
      throw new Error();
    return value as { snapshotId: string; cursorId: string; offset: number };
  } catch {
    throw mockShelfError(
      "invalidCursor",
      "The shelf cursor is invalid or belongs to another query.",
    );
  }
}
try {
  const saved = JSON.parse(
    localStorage.getItem("p4deck.mockConnection") ?? "null",
  );
  if (saved?.server && saved?.user && saved?.client) mockContext = saved;
} catch {
  /* Defaults. */
}
const now = Date.now();
const mockLogs: LogEntry[] = [];
const logsClearedSubscribers = new Set<() => void>();
const operationSubscribers = new Set<(event: OperationEvent) => void>();
const mockActiveOperations = new Set<string>();
const diagnosticSubscribers = new Set<(event: DiagnosticAlert) => void>();
let mockPendingChanges: PendingChange[] | undefined;
function emitOperation(event: OperationEvent) {
  if (event.type === "queued" || event.type === "started")
    mockActiveOperations.add(event.operationId);
  if (event.type === "completed" || event.type === "cancelled")
    mockActiveOperations.delete(event.operationId);
  operationSubscribers.forEach((subscriber) => subscriber(event));
}
const mockChanges: ChangelistSummary[] = Array.from(
  { length: 2500 },
  (_, index) => {
    const id = 31842 - index;
    const mergeClassification =
      index % 17 === 0
        ? "reliableMerge"
        : index % 29 === 0
          ? "suspectedMerge"
          : index % 37 === 0
            ? "unknown"
            : "normal";
    const status =
      index % 13 === 0 ? "shelved" : index % 7 === 0 ? "pending" : "submitted";
    return {
      id,
      status,
      mergeClassification,
      description:
        mergeClassification === "reliableMerge"
          ? `Merge //atlas/dev to //atlas/main (${id})`
          : mergeClassification === "suspectedMerge"
            ? `Merge-looking description without reliable evidence (${id})`
            : mergeClassification === "unknown"
              ? `Inspection unavailable for submitted change (${id})`
              : index % 9 === 0
                ? `Fix render pipeline cache invalidation #${id}`
                : `Update Atlas assets and source #${id}`,
      user: ["fmeng", "alice", "bruno", "buildbot"][index % 4],
      client: [
        "atlas-main-fm",
        "atlas-dev-alice",
        "atlas-build",
        "atlas-main-bruno",
      ][index % 4],
      time: new Date(now - index * 18 * 60_000).toISOString(),
      fileCount: 1 + ((index * 7) % 84),
      hasShelf: status === "shelved",
      jobs: index % 11 === 0 ? [`ATLAS-${1000 + index}`] : [],
      stream: index % 5 === 0 ? "//atlas/dev" : "//atlas/main",
    } as ChangelistSummary;
  },
);

function allMockPendingChanges(): PendingChange[] {
  mockPendingChanges ??= [
    {
      id: 0,
      description: "",
      user: mockContext.user,
      client: mockContext.client,
      status: "pending",
      jobs: [],
      files: mockWorkspace
        .filter((node) => node.state === "openedEdit")
        .slice(0, 5)
        .map((node) => ({
          depotPath: node.depotPath!,
          action: "edit",
          state: node.state,
        })),
      shelvedFiles: [],
    },
    {
      id: 31821,
      description: "Render pipeline cache improvements",
      user: mockContext.user,
      client: mockContext.client,
      status: "pending",
      updatedAt: new Date(now - 3_600_000).toISOString(),
      jobs: ["ATLAS-1042"],
      files: mockWorkspace
        .filter((node) => node.state === "openedAdd")
        .slice(0, 4)
        .map((node) => ({
          depotPath: node.depotPath!,
          action: "add",
          state: node.state,
        })),
      shelvedFiles: mockWorkspace.slice(20, 23).map((node) => ({
        depotPath: node.depotPath!,
        action: "edit",
        revision: node.revision,
        fileType: "text",
      })),
    },
    {
      id: 31798,
      description: "Atlas material cleanup",
      user: mockContext.user,
      client: mockContext.client,
      status: "pending",
      updatedAt: new Date(now - 7_200_000).toISOString(),
      jobs: [],
      files: mockWorkspace.slice(30, 33).map((node) => ({
        depotPath: node.depotPath!,
        action: "edit",
        state: "openedEdit" as const,
      })),
      shelvedFiles: [],
    },
  ];
  return mockPendingChanges;
}
const mockNames = [
  "Assets",
  "Config",
  "Source",
  "render.ts",
  "viewport.cpp",
  "atlas.json",
  "README.md",
  "Materials",
  "Audio",
  "main.scene",
];

function submittedQuerySignature(
  query: import("../../shared/contracts").ClQuery,
) {
  return JSON.stringify({
    keyword: query.keyword.trim(),
    users: [...query.users].sort(),
    clients: [...query.clients].sort(),
    depotPath: query.depotPath?.trim(),
    stream: query.stream?.trim(),
    streams: [...new Set(query.streams ?? [])].sort(),
    from: query.from,
    to: query.to,
    jobs: [...(query.jobs ?? [])].sort(),
    hasJob: query.hasJob,
    mergeClassifications: [...query.mergeClassifications].sort(),
    hideReliableMerges: query.hideReliableMerges,
    pageSize: query.pageSize,
  });
}

function encodeSubmittedCursor(upperChangeId: number, signature: string) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      upperChangeId,
      signature,
      connectionGeneration: mockContextGeneration,
      connection: `${mockContext.server}\0${mockContext.user}\0${mockContext.client}`,
    }),
  );
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeSubmittedCursor(cursor: string, signature: string) {
  try {
    if (!cursor || cursor.length > 2048) throw new Error();
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const payload = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)),
      ),
    );
    if (
      payload.version !== 1 ||
      !Number.isSafeInteger(payload.upperChangeId) ||
      payload.upperChangeId <= 0 ||
      payload.signature !== signature ||
      payload.connectionGeneration !== mockContextGeneration ||
      payload.connection !==
        `${mockContext.server}\0${mockContext.user}\0${mockContext.client}`
    )
      throw new Error();
    return payload.upperChangeId as number;
  } catch {
    throw new Error(
      "Submitted query cursor does not match this query or connection.",
    );
  }
}

function globalSearchSignature(
  text: string,
  kinds: GlobalSearchKind[],
  pageSize: number,
) {
  return JSON.stringify({
    text,
    kinds,
    pageSize,
    profile: mockActiveProfileId,
    connection: mockContext,
    connectionGeneration: mockContextGeneration,
  });
}

function encodeGlobalSearchCursor(
  snapshotId: string,
  offset: number,
  signature: string,
) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ version: 1, snapshotId, offset, signature }),
  );
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeGlobalSearchCursor(cursor: string, signature: string) {
  try {
    if (!cursor || cursor.length > 2048) throw new Error();
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const payload = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
          (character) => character.charCodeAt(0),
        ),
      ),
    );
    if (
      payload.version !== 1 ||
      typeof payload.snapshotId !== "string" ||
      !Number.isSafeInteger(payload.offset) ||
      payload.offset <= 0 ||
      payload.signature !== signature
    )
      throw new Error();
    return payload as { snapshotId: string; offset: number };
  } catch {
    throw new Error(
      "Global search cursor does not match this query or connection.",
    );
  }
}

function mockSearchItem(
  kind: GlobalSearchKind,
  identity: string,
  title: string,
  summary: string,
  target: GlobalSearchItem["target"],
  text: string,
): GlobalSearchItem | undefined {
  const titleIndex = title
    .toLocaleLowerCase()
    .indexOf(text.toLocaleLowerCase());
  const summaryIndex = summary
    .toLocaleLowerCase()
    .indexOf(text.toLocaleLowerCase());
  if (titleIndex < 0 && summaryIndex < 0) return undefined;
  const field = titleIndex >= 0 ? "title" : "summary";
  const start = titleIndex >= 0 ? titleIndex : summaryIndex;
  return {
    identity,
    kind,
    title,
    summary,
    target,
    matchedFields: [field],
    highlights: [{ field, start, end: start + text.length }],
    rank: start === 0 ? 1 : 2,
  };
}
const mockWorkspace: WorkspaceNode[] = Array.from(
  { length: 160 },
  (_, index) => {
    const name =
      index < 7
        ? mockNames[index]
        : `asset_${String(index).padStart(3, "0")}.${index % 5 === 0 ? "json" : "uasset"}`;
    const kind = index < 3 ? "directory" : "file";
    const state: FileState = (
      [
        "controlled",
        "openedEdit",
        "untracked",
        "openedAdd",
        "outOfDate",
        "controlled",
      ] as FileState[]
    )[index % 6];
    return {
      id: `workspace-${index}`,
      name,
      kind,
      absolutePath: `/workspace/atlas/${name}`,
      relativePath: name,
      depotPath: `//atlas/main/${name}`,
      state,
      revision: 3 + (index % 18),
      headRevision: 4 + (index % 18),
      changelistId: state.startsWith("opened") ? 31821 : undefined,
      modifiedAt: new Date(now - index * 900_000).toISOString(),
      hasChildren: kind === "directory",
    };
  },
);

function emitMockLog(
  level: LogEntry["level"],
  source: LogEntry["source"],
  command: string,
  message: string,
  operationId: string,
  durationMs?: number,
) {
  const previous = mockLogs[0];
  if (
    previous &&
    previous.level === level &&
    previous.message === message &&
    Date.now() - Date.parse(previous.timestamp) < 10_000
  ) {
    previous.repeatCount += 1;
    previous.timestamp = new Date().toISOString();
    return;
  }
  mockLogs.unshift({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    level,
    operationId,
    source,
    server: mockContext.server,
    workspace: mockContext.client,
    command,
    message,
    durationMs,
    repeatCount: 1,
  });
  if (mockLogs.length > 10_000) mockLogs.length = 10_000;
  if (level === "warning" || level === "error") {
    diagnosticSubscribers.forEach((subscriber) =>
      subscriber({ operationId, level }),
    );
  }
}

function assertMockRevision(expected: number) {
  if (expected !== mockProfileRevision)
    throw new Error(
      `revisionConflict: Expected ${expected}, current ${mockProfileRevision}.`,
    );
}

function assertMockProfile(
  name: string,
  context: import("../../shared/contracts").P4Context,
  exceptId?: string,
) {
  if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/u.test(name))
    throw new Error("invalidInput: Profile name is invalid.");
  if (!context.server.trim() || !context.user.trim() || !context.client.trim())
    throw new Error("invalidInput: Server, user and workspace are required.");
  for (const profile of mockProfiles) {
    if (profile.id === exceptId) continue;
    if (
      profile.name.localeCompare(name, undefined, { sensitivity: "accent" }) ===
      0
    )
      throw new Error("duplicateName: Profile names must be unique.");
    if (JSON.stringify(profile.context) === JSON.stringify(context))
      throw new Error("duplicateContext: An identical context already exists.");
  }
}

const workspaceMutationTokens = new Map<
  string,
  import("../../shared/contracts").WorkspaceMutationPreview
>();
const workspaceOverrides = new Map<
  string,
  Map<string, import("../../shared/contracts").ClientWorkspace | null>
>();
const workspaceScope = () =>
  JSON.stringify([mockActiveProfileId, mockContext.server, mockContext.user]);

/** Browser-demo table payloads for the CSV/XLSX preview (no files are read). */
const MOCK_XLSX_SHEETS = ["Summary", "明细", "空表"];

function mockTableMatrix(columns: number, rowCount: number): string[][] {
  return Array.from({ length: rowCount }, (_, row) =>
    Array.from({ length: columns }, (_, column) =>
      row === 0 ? `Col ${column + 1}` : `r${row + 1}c${column + 1}`,
    ),
  );
}

function mockCsvRows(): string[][] {
  const longCell = "长单元格示例 ".repeat(40).trim();
  return [
    ["名称", "类型", "数量", "价格", "备注", "空列"],
    ["示例 A", "csv", "12", "0.125", "含,逗号", ""],
    ["示例 B", "tsv", "0", "1999.00", '含"引号"', ""],
    ["示例 C", "xlsx", "3", "1.5", "含\n换行", ""],
    [longCell, "data", "4", "2.25", "", ""],
    ...Array.from({ length: 20 }, (_, index) => [
      `行 ${index + 6}`,
      "data",
      String(index),
      "3.5",
      "",
      "",
    ]),
  ];
}

function mockCsvPreview(path: string): FilePreview {
  const name = path.toLowerCase();
  const truncated = name.includes("truncated") || name.includes("timeout");
  const rows = name.includes("empty")
    ? []
    : name.includes("wide")
      ? mockTableMatrix(64, 30)
      : truncated
        ? mockTableMatrix(64, 20)
        : mockCsvRows();
  return {
    kind: "table",
    content: "",
    size: name.includes("truncated")
      ? 110_179_268
      : name.includes("wide")
        ? 65_536
        : 2_048,
    encoding: "UTF-8",
    encodingGuess: false,
    table: {
      format: "csv",
      delimiter: name.endsWith(".tsv") ? "\t" : ",",
      sheetName: null,
      sheetIndex: null,
      sheetNames: null,
      rows,
      rowCount: null,
      rowCountSource: null,
      hasMore: truncated,
      truncated,
      truncatedReason: name.includes("timeout")
        ? "timeout"
        : truncated
          ? "rowCap"
          : null,
      totalColumns: null,
    },
  };
}

function mockXlsxPreview(options?: FilePreviewRequestOptions): FilePreview {
  const requested = options?.sheetIndex ?? 0;
  if (
    !Number.isInteger(requested) ||
    requested < 0 ||
    requested >= MOCK_XLSX_SHEETS.length
  )
    throw new Error(
      `Unknown worksheet index (demo): ${requested} of ${MOCK_XLSX_SHEETS.length}`,
    );
  const rows =
    requested === 0
      ? mockCsvRows()
      : requested === 1
        ? [
            ["编号", "名称", "状态", "备注"],
            ["1", "条目一", "启用", "中文示例"],
            ...Array.from({ length: 10 }, (_, index) => [
              String(index + 2),
              `条目 ${index + 2}`,
              "停用",
              "",
            ]),
          ]
        : [];
  const truncated = requested !== 2;
  return {
    kind: "table",
    content: "",
    size: 3_311_864,
    encoding: null,
    table: {
      format: "xlsx",
      delimiter: null,
      sheetName: MOCK_XLSX_SHEETS[requested],
      sheetIndex: requested,
      sheetNames: MOCK_XLSX_SHEETS,
      rows,
      rowCount: 150_000,
      rowCountSource: "dimension",
      hasMore: truncated,
      truncated,
      truncatedReason: truncated ? "rowCap" : null,
      totalColumns: null,
    },
  };
}

export const mockBackend: Backend = {
  async selectedMoveLookup() {
    return { kind: "notFound" as const };
  },
  async selectedMoveExecute(request) {
    return {
      operationId: request.operationId,
      targetCreationUnknown: false,
      targetChangeId: null,
      stage: "stopped",
      files: request.files.map((f) => ({ ...f, state: "notMoved" as const })),
      message: "Browser preview: no changelist created and no files moved.",
    };
  },
  async selectedMoveStatus() {
    return null;
  },
  async selectedSubmitPrepare(request) {
    return {
      operationId: request.operationId,
      newChangeId: null,
      stage: "stopped",
      files: request.files.map((file) => ({
        ...file,
        state: "notMoved" as const,
      })),
      canContinue: false,
      message: "Browser preview: no files were created or moved.",
    };
  },
  async selectedSubmitStatus() {
    return null;
  },
  async selectedSubmitClaim() {
    throw new Error("Browser preview cannot authorize submission");
  },
  async customSubmitStart(request) {
    // Browser Mock never starts a process or claims a simulated submit succeeded.
    return {
      requestId: request.requestId,
      changeId: request.changeId,
      state: "notStarted",
      executablePath: mockContext.customSubmitExecutablePath ?? "",
      exitCode: null,
      reason: "browserMockNoProcess",
    };
  },
  async customSubmitStatus() {
    return null;
  },
  async companySubmitConnectionSnapshot() {
    if (!mockActiveProfileId) throw new Error("invalidConnection");
    // Synthetic owner counter only; production obtains the string directly from Rust.
    return {
      profileId: mockActiveProfileId,
      generation: mockContextGeneration.toString(),
      server: mockContext.server,
      user: mockContext.user,
      client: mockContext.client,
    };
  },
  async createConfigBackup(payload) {
    // S4j2: new shape { request, operationId? }; old flat shape stays legacy/no receipt.
    const wrapped =
      payload && typeof payload === "object" && "request" in payload;
    const request = wrapped ? payload.request : payload;
    const operationId = wrapped ? payload.operationId : undefined;
    const createdAt = new Date().toISOString();
    const fileName = `p4deck-config-manual-${Date.now()}.json`;
    const allowedKeys = request.localStorage
      .map((entry) => entry.key)
      .filter(isBackupLocalStorageKey)
      .sort();
    const retainedEntries = request.localStorage
      .filter((entry) => isBackupLocalStorageKey(entry.key))
      .sort((left, right) => left.key.localeCompare(right.key));
    const backup: ConfigBackupSummary = {
      fileName,
      createdAt,
      sizeBytes: 2048,
      kind: "manual",
      includesConnection: true,
      includesWindowPlacement: true,
      localStorageKeys: allowedKeys,
    };
    mockConfigBackups.unshift(backup);
    mockConfigBackupStorage.set(fileName, retainedEntries);
    const legacy: import("../../shared/contracts").ConfigBackupCreateResult = {
      backup,
      omittedLocalStorageKeys: request.localStorage
        .map((entry) => entry.key)
        .filter((key) => !allowedKeys.includes(key))
        .sort(),
    };
    if (!wrapped || !operationId)
      return {
        kind: "backupCreate",
        state: "legacy",
        outcome: "succeeded",
        artifact: { exists: false, sizeBytes: 0 },
        details: null,
        optimistic: "intentOnly",
        message: "Browser Mock legacy backup result.",
        legacy,
      };
    return {
      kind: "backupCreate",
      operationId,
      state: "committed",
      outcome: "succeeded",
      artifact: {
        path: `browser-mock://backups/${fileName}`,
        fileName,
        exists: true,
        sizeBytes: legacy.backup.sizeBytes,
        sha256: "A".repeat(64),
      },
      details: backup,
      optimistic: "intentOnly",
      message:
        "Browser Mock only: backup artifact verified by simulated post-write readback.",
      legacy,
    };
  },
  async listConfigBackups() {
    return {
      directory: "browser-mock://backups",
      backups: [...mockConfigBackups],
    };
  },
  async restoreConfigBackup(payload) {
    const wrapped =
      payload && typeof payload === "object" && "request" in payload;
    const request = wrapped ? payload.request : payload;
    const operationId = wrapped ? payload.operationId : undefined;
    const source = mockConfigBackups.find(
      (backup) => backup.fileName === request.fileName,
    );
    if (!source) {
      if (!wrapped) throw new Error("backupNotFound");
      return {
        kind: "backupRestore",
        operationId,
        state: "rejected",
        outcome: "rejected",
        artifact: { exists: false, sizeBytes: 0 },
        details: undefined,
        optimistic: "intentOnly",
        message: "backupNotFound",
        legacy: null,
      };
    }
    const rollbackFileName = `p4deck-config-pre-restore-${Date.now()}.json`;
    const legacy: import("../../shared/contracts").ConfigBackupRestoreResult = {
      sourceFileName: source.fileName,
      rollbackFileName,
      localStorage: mockConfigBackupStorage.get(source.fileName) ?? [],
      restartRequired: true,
    };
    if (!wrapped || !operationId)
      return {
        kind: "backupRestore",
        state: "legacy",
        outcome: "unknown",
        artifact: { exists: false, sizeBytes: 0 },
        details: null,
        optimistic: "intentOnly",
        message: "Browser Mock legacy restore result.",
        legacy,
      };
    return {
      kind: "backupRestore",
      operationId,
      // Staged only: applies on the next start, never committed in this call.
      state: "pending",
      outcome: "unknown",
      artifact: {
        path: `browser-mock://backups/${rollbackFileName}`,
        fileName: rollbackFileName,
        exists: true,
        sizeBytes: 1024,
        sha256: "D".repeat(64),
      },
      details: {
        sourceFileName: legacy.sourceFileName,
        rollbackFileName,
        restartRequired: true,
        pendingStaged: true,
      },
      optimistic: "intentOnly",
      message:
        "Browser Mock only: restore is staged (rollback bundle + pending manifest); it applies on the next start.",
      legacy,
    };
  },
  async openConfigBackupsFolder() {
    throw new Error("Opening the backup folder requires the desktop app.");
  },
  async statusCacheDiagnostics() {
    return {
      hits: 0,
      misses: 0,
      coalesced: 0,
      evicted: 0,
      invalidated: 0,
      staleFallbacks: 0,
      superseded: 0,
      loadCount: 0,
      totalLoadMs: 0,
      entries: 0,
      estimatedBytes: 0,
      invalidationReasons: {},
    };
  },
  async queryOperationJournal(query) {
    const keyword = query.keyword?.trim().toLowerCase();
    const records: OperationRecord[] = mockLogs.map((entry) => ({
      operationId: entry.operationId,
      connectionId: "mock-connection",
      workspace: entry.workspace,
      source: entry.source,
      category: entry.source === "terminal" ? "query" : "fileMutation",
      ...journalMappingForLogLevel(entry.level),
      startedAt: entry.timestamp,
      finishedAt: new Date(
        Date.parse(entry.timestamp) + (entry.durationMs ?? 0),
      ).toISOString(),
      logReference: entry.operationId,
    }));
    const filtered = records.filter(
      (record) =>
        (!query.state || record.state === query.state) &&
        (!query.category || record.category === query.category) &&
        (!query.from || record.startedAt >= query.from) &&
        (!query.to || record.startedAt <= query.to) &&
        (!keyword ||
          `${record.operationId} ${record.workspace} ${record.category} ${record.state} ${record.failure ?? ""}`
            .toLowerCase()
            .includes(keyword)),
    );
    const offset = query.cursor
      ? Number(query.cursor.replace("mock-journal:", ""))
      : 0;
    const limit = Math.max(1, Math.min(100, query.limit ?? 50));
    const page = filtered.slice(offset, offset + limit);
    const next = offset + page.length;
    return {
      records: page,
      nextCursor: next < filtered.length ? `mock-journal:${next}` : undefined,
    };
  },
  async getOperationRecord() {
    return null;
  },
  async queryLogPage(query) {
    const entries = await this.queryLogs({ ...query, limit: 10_000 });
    const offset = query.cursor
      ? Number(query.cursor.replace("mock-log:", ""))
      : 0;
    const limit = Math.max(1, Math.min(500, query.limit ?? 100));
    const page = entries.slice(offset, offset + limit);
    const next = offset + page.length;
    return {
      entries: page,
      nextCursor: next < entries.length ? `mock-log:${next}` : undefined,
    };
  },
  async getLogPolicy() {
    return {
      autoExpandWarning: true,
      autoExpandError: true,
      retentionDays: 14,
      maxMib: 50,
    };
  },
  async openLogsFolder() {
    throw new Error("Opening the log folder requires the desktop app.");
  },
  async deleteAllLogs(payload) {
    const wrapped =
      payload && typeof payload === "object" && "operationId" in payload;
    const operationId = wrapped
      ? (payload as { operationId?: string }).operationId
      : undefined;
    mockLogs.length = 0;
    logsClearedSubscribers.forEach((callback) => callback());
    if (!operationId)
      return {
        kind: "logClear",
        state: "legacy",
        outcome: "succeeded",
        artifact: { exists: false, sizeBytes: 0 },
        details: null,
        optimistic: "intentOnly",
        message: "Browser Mock legacy log clear.",
        legacy: "ok",
      };
    return {
      kind: "logClear",
      operationId,
      state: "committed",
      outcome: "succeeded",
      artifact: { exists: false, sizeBytes: 0 },
      details: { remainingEntries: 0 },
      optimistic: "intentOnly",
      message:
        "Browser Mock only: log clear verified by simulated empty readback.",
      legacy: "ok",
    };
  },
  async subscribeLogsCleared(callback) {
    logsClearedSubscribers.add(callback);
    return () => logsClearedSubscribers.delete(callback);
  },
  async setLogPolicy(payload) {
    const wrapped =
      payload &&
      typeof payload === "object" &&
      "policy" in payload &&
      typeof (payload as { policy?: unknown }).policy === "object";
    const policy = wrapped
      ? (payload as { policy: import("../../shared/contracts").LogPolicy })
          .policy
      : (payload as unknown as import("../../shared/contracts").LogPolicy);
    const operationId = wrapped
      ? (payload as { operationId?: string }).operationId
      : undefined;
    const saved = {
      ...policy,
      retentionDays: Math.max(1, Math.min(30, policy.retentionDays)),
      maxMib: Math.max(5, Math.min(50, policy.maxMib)),
    };
    if (!wrapped || !operationId)
      return {
        kind: "logPolicySet",
        state: "legacy",
        outcome: "succeeded",
        artifact: { exists: false, sizeBytes: 0 },
        details: null,
        optimistic: "intentOnly",
        message: "Browser Mock legacy log policy.",
        legacy: saved,
      };
    return {
      kind: "logPolicySet",
      operationId,
      state: "committed",
      outcome: "succeeded",
      artifact: {
        path: "browser-mock://logs/policy.json",
        fileName: "policy.json",
        exists: true,
        sizeBytes: 128,
        sha256: "C".repeat(64),
      },
      details: saved,
      optimistic: "intentOnly",
      message:
        "Browser Mock only: log policy verified by simulated readback and persisted policy.json.",
      legacy: saved,
    };
  },
  async exportDiagnostics(payload) {
    const wrapped =
      payload && typeof payload === "object" && "request" in payload;
    const operationId = wrapped
      ? (payload as { operationId?: string }).operationId
      : undefined;
    const legacy: import("../../shared/contracts").DiagnosticExportResult = {
      path: "Mock simulation — no diagnostic file was written",
      sizeBytes: 0,
      truncated: false,
      format: "json",
      simulated: true,
    };
    if (!wrapped || !operationId)
      return {
        kind: "diagnosticsExport",
        state: "legacy",
        outcome: "succeeded",
        artifact: { exists: false, sizeBytes: 0 },
        details: null,
        optimistic: "intentOnly",
        message: "Browser Mock legacy diagnostics export.",
        legacy,
      };
    return {
      kind: "diagnosticsExport",
      operationId,
      state: "committed",
      outcome: "succeeded",
      artifact: {
        path: "browser-mock://diagnostics/export.json",
        fileName: "export.json",
        exists: true,
        sizeBytes: 4096,
        sha256: "B".repeat(64),
      },
      details: {
        format: "json",
        truncated: false,
        sizeBytes: 4096,
        redaction:
          "existing DiagnosticService redaction (passwords/tickets/stdin/raw args omitted; paths redacted)",
      },
      optimistic: "intentOnly",
      message:
        "Browser Mock only: diagnostics export verified by simulated post-write readback; no content is read.",
      legacy,
    };
  },
  async subscribeDiagnosticAlerts(callback) {
    diagnosticSubscribers.add(callback);
    return () => diagnosticSubscribers.delete(callback);
  },
  workspaceDiskUsage: async () => {
    throw new Error("Disk information requires the desktop app");
  },
  async discoverP4Cli() {
    return {
      state: "notTested",
      executable: "p4-mock",
      version: "Rev. P4/MOCK/2026.1",
      message:
        "Browser Mock only; no local executable or network was accessed.",
    };
  },
  async testConnection(context) {
    return {
      state: "connected",
      message: "Browser Mock only; no real network connection was made.",
      recovery: "none",
      server: context.server,
    };
  },
  async queryLoginStatus(context) {
    return {
      state: mockAuthentication,
      errorCode:
        mockAuthentication === "authRequired" ? "authRequired" : undefined,
      message:
        mockAuthentication === "connected"
          ? "Browser Mock authentication is simulated; no ticket was read."
          : "Browser Mock authentication is required; no ticket was read.",
      recovery: mockAuthentication === "connected" ? "none" : "login",
      server: context.server,
    };
  },
  async trustServer(request) {
    return {
      state: request.confirmed ? "notTested" : "invalidConfig",
      errorCode: request.confirmed ? undefined : "invalidConfig",
      message: request.confirmed
        ? "Browser Mock trust was simulated; no trust file was written."
        : "Explicit confirmation is required.",
      recovery: request.confirmed ? "retry" : "editConfig",
      server: request.context.server,
    };
  },
  async login(request) {
    const accepted = request.confirmed && !!request.password;
    if (accepted) mockAuthentication = "connected";
    return {
      state: accepted ? "connected" : "invalidConfig",
      errorCode: accepted ? undefined : "invalidConfig",
      message:
        "Browser Mock login was simulated; no password or ticket was sent to a server.",
      recovery: accepted ? "none" : "editConfig",
      server: request.context.server,
    };
  },
  async logout(request) {
    if (request.confirmed) mockAuthentication = "authRequired";
    return {
      state: request.confirmed ? "authRequired" : "invalidConfig",
      errorCode: request.confirmed ? "authRequired" : "invalidConfig",
      message:
        "Browser Mock logout was simulated; no real server was accessed.",
      recovery: request.confirmed ? "login" : "editConfig",
      server: request.context.server,
    };
  },
  async listStreams() {
    return [
      {
        stream: "//atlas/main",
        name: "Atlas Main",
        owner: "fmeng",
        parent: "none",
        kind: "mainline",
        description: "稳定主线",
      },
      {
        stream: "//atlas/dev",
        name: "Development",
        owner: "fmeng",
        parent: "//atlas/main",
        kind: "development",
        description: "日常开发",
      },
      {
        stream: "//atlas/release",
        name: "Release",
        owner: "alice",
        parent: "//atlas/main",
        kind: "release",
        description: "发布维护",
      },
    ];
  },
  async queryStreamGraph(query) {
    const allNodes: import("../../shared/contracts").StreamGraphNode[] = [
      {
        stream: "//atlas/main",
        name: "Atlas Main",
        owner: "fmeng",
        kind: "mainline",
        description: "Browser Mock simulated stable mainline",
        parentView: "inherit",
        flowOptions: {
          toParent: false,
          fromParent: false,
          mergeMode: "mergeDown",
          locked: false,
          allSubmit: true,
        },
      },
      {
        stream: "//atlas/dev",
        name: "Development",
        owner: "fmeng",
        parent: "//atlas/main",
        kind: "development",
        description: "Browser Mock simulated development stream",
        parentView: "inherit",
        flowOptions: {
          toParent: true,
          fromParent: true,
          mergeMode: "mergeDown",
          locked: false,
          allSubmit: true,
        },
      },
      {
        stream: "//atlas/release",
        name: "Release",
        owner: "alice",
        parent: "//atlas/main",
        kind: "release",
        description: "Browser Mock simulated release stream",
        parentView: "noinherit",
        flowOptions: {
          toParent: false,
          fromParent: true,
          mergeMode: "mergeDown",
          locked: false,
          allSubmit: false,
        },
      },
      {
        stream: "//atlas/task-孤立",
        name: "Simulated filtered orphan",
        owner: "fmeng",
        parent: "//hidden/main",
        kind: "task",
        description:
          "Browser Mock only: the parent is deliberately unavailable.",
        parentView: "inherit",
        flowOptions: {
          toParent: true,
          fromParent: true,
          mergeMode: "mergeDown",
          locked: false,
          allSubmit: true,
        },
      },
    ];
    const prefix = query.depotPrefix?.replace(/\/+$/, "");
    const needle = query.text?.trim().toLocaleLowerCase();
    const matched = allNodes.filter((node) => {
      const inScope =
        !prefix ||
        node.stream === prefix ||
        node.stream.startsWith(`${prefix}/`);
      const text = [
        node.stream,
        node.name,
        node.owner,
        node.parent,
        node.kind,
        node.description,
      ]
        .filter(Boolean)
        .join("\n")
        .toLocaleLowerCase();
      return inScope && (!needle || text.includes(needle));
    });
    const offset = query.cursor
      ? Number(/^mock-stream-graph:(\d+)$/.exec(query.cursor)?.[1] ?? NaN)
      : 0;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (query.cursor !== undefined && offset >= matched.length)
    ) {
      throw {
        code: "invalidCursor",
        message: "Browser Mock Stream Graph cursor is invalid.",
      };
    }
    const end = Math.min(offset + query.pageSize, matched.length);
    const nodes = matched.slice(offset, end);
    const known = new Set(matched.map((node) => node.stream));
    const pagePaths = new Set(nodes.map((node) => node.stream));
    const roots = nodes
      .filter((node) => !node.parent)
      .map((node) => node.stream);
    const orphans = nodes
      .filter((node) => node.parent && !known.has(node.parent))
      .map((node) => node.stream);
    return {
      requestGeneration: query.requestGeneration,
      scope: {
        activeProfileId: mockActiveProfileId,
        contextGeneration: mockContextGeneration,
        server: mockContext.server,
        user: mockContext.user,
        client: mockContext.client,
        depotPrefix: prefix,
      },
      nodes,
      edges: matched
        .filter(
          (node) =>
            node.parent && known.has(node.parent) && pagePaths.has(node.stream),
        )
        .map((node) => ({ parent: node.parent!, child: node.stream })),
      roots,
      orphans,
      hasMore: end < matched.length,
      nextCursor: end < matched.length ? `mock-stream-graph:${end}` : undefined,
      partial: orphans.length > 0,
      truncated: false,
      stats: {
        scannedCount: allNodes.length,
        matchedCount: matched.length,
        returnedCount: nodes.length,
        duplicateCount: 0,
        invalidRelationCount: orphans.length,
        safetyLimit: 5000,
      },
      operationIds: [`${query.operationId}-browser-mock`],
      cacheFreshness: "fresh",
      simulated: true,
    };
  },
  async queryBranchMappings(query) {
    const queryKey = JSON.stringify({
      generation: query.requestGeneration,
      filter: query.nameFilter?.trim().toLocaleLowerCase() ?? "",
      owner: query.owner?.toLocaleLowerCase() ?? "",
      pageSize: query.pageSize,
      profile: mockActiveProfileId,
      context: mockContext,
    });
    let items: import("../../shared/contracts").BranchMappingSummary[];
    let offset = 0;
    if (query.cursor) {
      const snapshot = mockBranchCursors.get(query.cursor);
      mockBranchCursors.delete(query.cursor);
      if (
        !snapshot ||
        snapshot.expiresAt <= Date.now() ||
        snapshot.queryKey !== queryKey
      ) {
        throw {
          code: "invalidCursor",
          message: "Browser Mock Branch Mapping cursor is invalid or expired.",
        };
      }
      items = snapshot.items;
      offset = snapshot.offset;
    } else {
      const filter = query.nameFilter?.trim().toLocaleLowerCase();
      items = [...mockBranchDetails.values()]
        .filter(
          (detail) =>
            (!filter || detail.name.toLocaleLowerCase().includes(filter)) &&
            (!query.owner ||
              detail.owner.toLocaleLowerCase() ===
                query.owner.toLocaleLowerCase()),
        )
        .map((detail) => ({
          name: detail.name,
          owner: detail.owner,
          update: detail.update,
          access: detail.access,
          description: detail.description,
          options: detail.locked ? "locked" : "unlocked",
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
    }
    const end = Math.min(offset + query.pageSize, items.length);
    const nextCursor =
      end < items.length ? `mock-branch:${crypto.randomUUID()}` : undefined;
    if (nextCursor) {
      mockBranchCursors.set(nextCursor, {
        items,
        offset: end,
        queryKey,
        expiresAt: Date.now() + 120_000,
      });
    }
    return {
      requestGeneration: query.requestGeneration,
      scope: {
        activeProfileId: mockActiveProfileId,
        contextGeneration: mockContextGeneration,
        server: mockContext.server,
        user: mockContext.user,
        client: mockContext.client,
      },
      items: items.slice(offset, end),
      hasMore: end < items.length,
      nextCursor,
      partial: false,
      truncated: false,
      stats: {
        scannedCount: items.length,
        matchedCount: items.length,
        returnedCount: end - offset,
        invalidRecordCount: 0,
        safetyLimit: 5000,
      },
      operationIds: [`${query.operationId}-browser-mock`],
      simulated: true,
    };
  },
  async getBranchMappingDetail(query) {
    const detail = mockBranchDetails.get(query.name);
    if (!detail) {
      throw {
        code: "notFound",
        message: "Browser Mock Branch Mapping does not exist.",
      };
    }
    return {
      requestGeneration: query.requestGeneration,
      scope: {
        activeProfileId: mockActiveProfileId,
        contextGeneration: mockContextGeneration,
        server: mockContext.server,
        user: mockContext.user,
        client: mockContext.client,
      },
      detail: {
        ...structuredClone(detail),
        operationIds: [`${query.operationId}-browser-mock`],
      },
    };
  },
  async previewBranchMappingImpact(query) {
    const detail = mockBranchDetails.get(query.name);
    if (!detail) {
      throw {
        code: "notFound",
        message: "Browser Mock Branch Mapping does not exist.",
      };
    }
    const mappings = detail.view.filter(
      (line) => line.modifier !== "exclude" && line.source && line.target,
    );
    const items = mappings.slice(0, query.limit).map((line) => ({
      file:
        query.direction === "forward"
          ? line.target!.replace("...", "README.md")
          : line.source!.replace("...", "README.md"),
      source: query.direction === "forward" ? line.source : line.target,
      target: query.direction === "forward" ? line.target : line.source,
      action: "integrate",
    }));
    return {
      requestGeneration: query.requestGeneration,
      name: query.name,
      direction: query.direction,
      items,
      blockers: [],
      partial: mappings.length > query.limit,
      truncated: mappings.length > query.limit,
      scannedCount: mappings.length,
      safetyLimit: query.limit,
      operationIds: [`${query.operationId}-browser-mock-preview-only`],
      simulated: true,
    };
  },
  async preflightBranchMappingMutation(request) {
    const current = mockBranchDetails.get(request.name);
    const blockers: import("../../shared/contracts").BranchIssue[] = [];
    if (request.mode === "create" && current) {
      blockers.push({
        code: "alreadyExists",
        message: "Browser Mock mapping already exists.",
      });
    }
    if (request.mode !== "create" && !current) {
      blockers.push({
        code: "notFound",
        message: "Browser Mock mapping does not exist.",
      });
    }
    if (
      current &&
      request.mode !== "create" &&
      current.owner !== mockContext.user
    ) {
      blockers.push({
        code: "ownerMismatch",
        message: "Browser Mock enforces owner-only mutation.",
      });
    }
    if (request.mode !== "delete" && !request.desired) {
      blockers.push({
        code: "invalidInput",
        message: "A desired mapping is required.",
      });
    }
    if (
      request.desired &&
      (request.desired.name !== request.name ||
        request.desired.owner !== mockContext.user)
    ) {
      blockers.push({
        code: "ownerMismatch",
        message: "Browser Mock does not transfer ownership.",
      });
    }
    const warnings =
      request.mode === "delete"
        ? [
            {
              code: "destructiveDelete" as const,
              message: "Browser Mock delete requires explicit confirmation.",
            },
          ]
        : [];
    const target = blockers.length
      ? undefined
      : {
          activeProfileId: mockActiveProfileId,
          contextGeneration: mockContextGeneration,
          server: mockContext.server,
          user: mockContext.user,
          client: mockContext.client,
          mode: request.mode,
          name: request.name,
          currentExists: !!current,
          currentDigest: current ? JSON.stringify(current) : undefined,
          desired: request.desired
            ? structuredClone(request.desired)
            : undefined,
          desiredDigest: request.desired
            ? JSON.stringify(request.desired)
            : undefined,
        };
    const previewDigest = JSON.stringify({ target, blockers, warnings });
    const expiresAt = Date.now() + 120_000;
    const token = target ? crypto.randomUUID() : undefined;
    if (token && target) {
      mockBranchTokens.set(token, { target, digest: previewDigest, expiresAt });
    }
    return {
      ready: !!target,
      mode: request.mode,
      name: request.name,
      current: current ? structuredClone(current) : undefined,
      desired: request.desired ? structuredClone(request.desired) : undefined,
      blockers,
      warnings,
      target,
      previewDigest,
      token,
      expiresAt,
      ttlMs: 120_000,
      operationIds: [
        `${request.operationId ?? "branch-preflight"}-browser-mock`,
      ],
    };
  },
  async confirmBranchMappingMutation(confirmation) {
    const record = mockBranchTokens.get(confirmation.token);
    mockBranchTokens.delete(confirmation.token);
    const reject = (
      failure: import("../../shared/contracts").BranchMutationFailureCode,
      message: string,
    ) => ({
      outcome: "rejected" as const,
      failure,
      message,
      operationIds: [
        confirmation.operationId ?? "branch-mutation-browser-mock",
      ],
      refreshBranchMappings: false,
    });
    if (!record) {
      return reject(
        "tokenUnknown",
        "Browser Mock token is unknown or already used.",
      );
    }
    if (record.expiresAt <= Date.now()) {
      return reject("tokenExpired", "Browser Mock token expired.");
    }
    if (
      record.digest !== confirmation.previewDigest ||
      JSON.stringify(record.target) !== JSON.stringify(confirmation.target)
    ) {
      return reject(
        "targetMismatch",
        "Browser Mock confirmation target changed.",
      );
    }
    if (
      record.target.contextGeneration !== mockContextGeneration ||
      record.target.server !== mockContext.server ||
      record.target.user !== mockContext.user ||
      record.target.client !== mockContext.client
    ) {
      return reject(
        "contextChanged",
        "Browser Mock connection changed after preflight.",
      );
    }
    if (
      record.target.mode === "delete" &&
      !confirmation.acknowledgeDangerousDelete
    ) {
      return reject(
        "dangerousConfirmationRequired",
        "Browser Mock delete requires explicit acknowledgement.",
      );
    }
    if (record.target.mode === "delete") {
      mockBranchDetails.delete(record.target.name);
    } else {
      const desired = record.target.desired!;
      mockBranchDetails.set(desired.name, {
        ...structuredClone(desired),
        update: String(Math.floor(Date.now() / 1000)),
        unknownFields: [],
        editable: true,
        operationIds: [
          confirmation.operationId ?? "branch-mutation-browser-mock",
        ],
        simulated: true,
      });
    }
    mockBranchCursors.clear();
    const observed = mockBranchDetails.get(record.target.name);
    return {
      outcome: "succeeded" as const,
      message:
        "Browser Mock simulated the Branch Mapping mutation; no real server was accessed.",
      observed: observed ? structuredClone(observed) : undefined,
      operationIds: [
        confirmation.operationId ?? "branch-mutation-browser-mock",
      ],
      refreshBranchMappings: true,
    };
  },
  async preflightStreamSwitch(request) {
    const stream = (await this.listStreams()).find(
      (item) => item.stream === request.targetStream,
    );
    const operationId = request.operationId ?? crypto.randomUUID();
    const same = mockCurrentStream === request.targetStream;
    const blockers = !stream
      ? [
          {
            code: "invalidTarget" as const,
            message: "Browser Mock: target stream does not exist.",
            paths: [],
          },
        ]
      : same && request.mode === "viewOnly"
        ? [
            {
              code: "sameStream" as const,
              message: "Browser Mock: workspace already uses this stream.",
              paths: [],
            },
          ]
        : [];
    const warnings =
      request.mode === "sync"
        ? [
            {
              code: "syncChangesWorkspace" as const,
              message:
                "Browser Mock: a real sync would change workspace files; this simulation does not touch disk.",
              paths: [],
            },
          ]
        : [];
    const target = stream
      ? {
          server: mockContext.server,
          user: mockContext.user,
          client: mockContext.client,
          workspace: mockContext.cwd ?? "",
          activeProfileId: mockActiveProfileId,
          contextGeneration: mockContextGeneration,
          currentStream: mockCurrentStream || undefined,
          targetStream: stream.stream,
          targetType: stream.kind,
          targetParent: stream.parent === "none" ? undefined : stream.parent,
          mode: request.mode,
          clientSpecDigest: "mock-client-spec",
          streamSpecDigest: `mock-${stream.stream}`,
          riskDigest: "mock-clean-workspace",
        }
      : undefined;
    const previewDigest = target
      ? JSON.stringify({ target, blockers, warnings })
      : "";
    const expiresAt = Date.now() + 120_000;
    const token = !blockers.length && target ? crypto.randomUUID() : undefined;
    if (token && target)
      mockStreamSwitchTokens.set(token, {
        target,
        digest: previewDigest,
        expiresAt,
        hasWarnings: !!warnings.length,
      });
    return {
      ready: !blockers.length,
      currentStream: mockCurrentStream || undefined,
      targetStream: request.targetStream,
      targetType: stream?.kind,
      targetParent: stream?.parent === "none" ? undefined : stream?.parent,
      mode: request.mode,
      syncRequired: !same,
      risks: {
        openedFiles: 0,
        unresolvedFiles: 0,
        reconcileFiles: 0,
        targetFileCount: request.mode === "sync" ? 3 : undefined,
        targetFileBytes: request.mode === "sync" ? 4096 : undefined,
      },
      blockers,
      warnings,
      targetSnapshot: target,
      previewDigest,
      token,
      expiresAt,
      ttlMs: 120_000,
      operationIds: [operationId],
      logReference: operationId,
    };
  },
  async confirmStreamSwitch(confirmation) {
    const record = mockStreamSwitchTokens.get(confirmation.token);
    mockStreamSwitchTokens.delete(confirmation.token);
    const reject = (
      failure: import("../../shared/contracts").StreamSwitchFailureCode,
      message: string,
    ) => ({
      outcome: "rejected" as const,
      failure,
      message,
      streamChanged: false,
      syncPerformed: false,
      syncCompleted: false,
      refresh: {
        workspace: true,
        streams: true,
        pendingChanges: true,
        submittedChanges: true,
        search: true,
        depot: true,
        reason: "Browser Mock: run a new preflight.",
      },
    });
    if (!record)
      return reject("tokenUnknown", "Browser Mock: token was already used.");
    if (record.expiresAt <= Date.now())
      return reject("tokenExpired", "Browser Mock: preflight expired.");
    if (
      JSON.stringify(record.target) !== JSON.stringify(confirmation.target) ||
      record.digest !== confirmation.previewDigest
    )
      return reject("targetMismatch", "Browser Mock: target binding changed.");
    if (record.hasWarnings && !confirmation.acknowledgeWarnings)
      return reject(
        "warningAcknowledgementRequired",
        "Browser Mock: warnings require acknowledgement.",
      );
    if (
      record.target.contextGeneration !== mockContextGeneration ||
      record.target.activeProfileId !== mockActiveProfileId ||
      record.target.client !== mockContext.client
    )
      return reject("contextChanged", "Browser Mock: runtime context changed.");
    const streamChanged = mockCurrentStream !== record.target.targetStream;
    mockCurrentStream = record.target.targetStream;
    if (streamChanged) {
      mockContextGeneration += 1;
      mockGlobalSearchSnapshots.clear();
    }
    const runtime = await this.runtimeInfo();
    return {
      outcome: "succeeded" as const,
      message:
        record.target.mode === "sync"
          ? "Browser Mock only: stream switch and sync were simulated; no files changed."
          : "Browser Mock only: stream view switch was simulated; no files changed.",
      streamChanged,
      syncPerformed: record.target.mode === "sync",
      syncCompleted: record.target.mode === "sync",
      verifiedStream: mockCurrentStream,
      operationId: confirmation.operationId ?? crypto.randomUUID(),
      runtime: streamChanged ? runtime : undefined,
      refresh: {
        workspace: true,
        streams: true,
        pendingChanges: true,
        submittedChanges: true,
        search: true,
        depot: true,
        reason: "Browser Mock: refresh simulated workspace-dependent views.",
      },
    };
  },
  async listUserWorkspaces() {
    const seeded = [
      {
        name: mockContext.client,
        host: "fm-mac",
        root: "/workspace/atlas",
        stream: mockCurrentStream,
        description: "Atlas 主线开发工作区",
      },
      {
        name: "atlas-dev-fm",
        host: "fm-mac",
        root: "/workspace/atlas-dev",
        stream: "//atlas/dev",
        description: "功能开发与集成验证",
      },
      {
        name: "atlas-release-win",
        host: "FM-WIN",
        root: "D:\\Projects\\Atlas Release",
        stream: "//atlas/release",
        description: "Windows 发布版本验证",
      },
      {
        name: "tools-fm",
        host: "",
        root: "/workspace/tools",
        stream: "",
        description: "工具项目 · Classic Workspace",
      },
    ].map((item, index) => ({
      ...item,
      owner: mockContext.user,
      updated: Math.floor(now / 1000) - index * 86400,
      accessed: Math.floor(now / 1000) - index * 3600,
    }));
    const rows = new Map<
      string,
      import("../../shared/contracts").ClientWorkspace
    >(
      [...seeded, ...mockConnectionWorkspaces.values()].map((item) => [
        item.name,
        item,
      ]),
    );
    workspaceOverrides.get(workspaceScope())?.forEach((item, name) => {
      if (item) rows.set(name, item);
      else rows.delete(name);
    });
    return [...rows.values()];
  },
  async browseConnectionUsers(request) {
    if (request.operationId && mockCancelledOperations.has(request.operationId))
      throw new Error("cancelled: Browser Mock directory query was cancelled.");
    if (!request.context.server.trim() || !request.context.user.trim())
      throw new Error(
        "invalidInput: Server and explicit query user are required.",
      );
    const prefix = request.prefix?.trim().toLocaleLowerCase() ?? "";
    const all = [...mockConnectionUsers.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const matches = all.filter((item) =>
      item.name.toLocaleLowerCase().startsWith(prefix),
    );
    return {
      requestGeneration: request.requestGeneration,
      items: matches.slice(0, 500),
      partial: matches.length > 500,
      truncated: matches.length > 500,
      stats: {
        scannedCount: all.length,
        matchedCount: matches.length,
        safetyLimit: 500,
      },
      operationIds: [request.operationId ?? crypto.randomUUID()],
      connection: {
        state: "connected",
        message: "Browser Mock simulated directory query.",
        recovery: "none",
        server: request.context.server,
      },
      simulated: true,
    };
  },
  async browseConnectionWorkspaces(request) {
    if (request.operationId && mockCancelledOperations.has(request.operationId))
      throw new Error("cancelled: Browser Mock directory query was cancelled.");
    if (!request.context.server.trim() || !request.context.user.trim())
      throw new Error("invalidInput: Server and draft user are required.");
    const seeded = (await this.listUserWorkspaces()).map((item) => ({
      ...item,
      owner: request.context.user,
      rootStatus: "usable" as const,
      selectable: true,
    }));
    const all = [...seeded, ...mockConnectionWorkspaces.values()]
      .filter(
        (item, index, values) =>
          values.findIndex((candidate) => candidate.name === item.name) ===
          index,
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    const prefix = request.prefix?.trim().toLocaleLowerCase() ?? "";
    const matches = all.filter((item) =>
      item.name.toLocaleLowerCase().startsWith(prefix),
    );
    return {
      requestGeneration: request.requestGeneration,
      items: matches.slice(0, 500),
      partial: matches.length > 500,
      truncated: matches.length > 500,
      stats: {
        scannedCount: all.length,
        matchedCount: matches.length,
        safetyLimit: 500,
      },
      operationIds: [request.operationId ?? crypto.randomUUID()],
      connection: {
        state: "connected",
        message: "Browser Mock simulated directory query.",
        recovery: "none",
        server: request.context.server,
      },
      simulated: true,
    };
  },
  async preflightCreateConnectionUser(request) {
    const name = request.plan.name.trim();
    const blockers: import("../../shared/contracts").ConnectionSpecIssue[] = [];
    if (
      !request.context.server.trim() ||
      !name ||
      request.context.user !== name
    )
      blockers.push({
        code: "invalidInput",
        message:
          "Browser Mock requires Server and self-service User ID to match the draft user.",
      });
    if (!request.plan.fullName.trim() || !request.plan.email.includes("@"))
      blockers.push({
        code: "invalidInput",
        message: "Browser Mock requires Full name and a valid Email.",
      });
    if (mockConnectionUsers.has(name))
      blockers.push({
        code: "alreadyExists",
        message: "Browser Mock user already exists.",
      });
    const token = blockers.length ? undefined : crypto.randomUUID();
    const stateDigest = `mock-user-${request.requestGeneration}-${name}`;
    const expiresAt = Date.now() + 60_000;
    if (token)
      mockConnectionSpecTokens.set(token, {
        kind: "userSelf",
        name,
        context: structuredClone(request.context),
        requestGeneration: request.requestGeneration,
        stateDigest,
        plan: structuredClone(request.plan),
        expiresAt,
      });
    return {
      ready: blockers.length === 0,
      kind: "userSelf",
      name,
      requestGeneration: request.requestGeneration,
      stateDigest,
      token,
      expiresAt,
      blockers,
      warnings: [],
      operationIds: [request.operationId ?? crypto.randomUUID()],
      simulated: true,
    };
  },
  async preflightCreateConnectionWorkspace(request) {
    const name = request.plan.name.trim();
    const blockers: import("../../shared/contracts").ConnectionSpecIssue[] = [];
    if (!request.context.server.trim() || !request.context.user.trim())
      blockers.push({
        code: "invalidInput",
        message: "Browser Mock requires Server and User.",
      });
    if (!name || !request.plan.root.trim())
      blockers.push({
        code: "invalidInput",
        message: "Browser Mock requires Workspace name and Root.",
      });
    if (
      (request.plan.mapping.kind === "stream" &&
        !request.plan.mapping.stream.trim()) ||
      (request.plan.mapping.kind === "classic" &&
        request.plan.mapping.view.length === 0)
    )
      blockers.push({
        code: "invalidInput",
        message: "Browser Mock requires an explicit Stream or Classic View.",
      });
    if (
      mockConnectionWorkspaces.has(name) ||
      (await this.listUserWorkspaces()).some((item) => item.name === name)
    )
      blockers.push({
        code: "alreadyExists",
        message: "Browser Mock workspace already exists.",
      });
    const token = blockers.length ? undefined : crypto.randomUUID();
    const stateDigest = `mock-workspace-${request.requestGeneration}-${name}`;
    const expiresAt = Date.now() + 60_000;
    if (token)
      mockConnectionSpecTokens.set(token, {
        kind: "workspace",
        name,
        context: structuredClone(request.context),
        requestGeneration: request.requestGeneration,
        stateDigest,
        plan: structuredClone(request.plan),
        expiresAt,
      });
    return {
      ready: blockers.length === 0,
      kind: "workspace",
      name,
      requestGeneration: request.requestGeneration,
      stateDigest,
      token,
      expiresAt,
      blockers,
      warnings: [],
      operationIds: [request.operationId ?? crypto.randomUUID()],
      simulated: true,
    };
  },
  async confirmCreateConnectionUser(confirmation) {
    const record = mockConnectionSpecTokens.get(confirmation.token);
    mockConnectionSpecTokens.delete(confirmation.token);
    if (
      !record ||
      record.kind !== "userSelf" ||
      !confirmation.confirmed ||
      record.expiresAt <= Date.now() ||
      record.requestGeneration !== confirmation.requestGeneration ||
      record.stateDigest !== confirmation.stateDigest ||
      JSON.stringify(record.context) !== JSON.stringify(confirmation.context)
    )
      return {
        outcome: "rejected",
        failure: "connectionChanged",
        kind: "userSelf",
        name: record?.name ?? "",
        message:
          "Browser Mock rejected an expired, replayed, or changed confirmation.",
        operationIds: [],
        simulated: true,
      };
    const plan =
      record.plan as import("../../shared/contracts").ConnectionUserCreatePlan;
    mockConnectionUsers.set(record.name, {
      name: record.name,
      fullName: plan.fullName,
      email: plan.email,
    });
    return {
      outcome: "created",
      kind: "userSelf",
      name: record.name,
      message:
        "Browser Mock simulated user creation; no real server was changed.",
      operationIds: [crypto.randomUUID()],
      simulated: true,
    };
  },
  async confirmCreateConnectionWorkspace(confirmation) {
    const record = mockConnectionSpecTokens.get(confirmation.token);
    mockConnectionSpecTokens.delete(confirmation.token);
    if (
      !record ||
      record.kind !== "workspace" ||
      !confirmation.confirmed ||
      record.expiresAt <= Date.now() ||
      record.requestGeneration !== confirmation.requestGeneration ||
      record.stateDigest !== confirmation.stateDigest ||
      JSON.stringify(record.context) !== JSON.stringify(confirmation.context)
    )
      return {
        outcome: "rejected",
        failure: "connectionChanged",
        kind: "workspace",
        name: record?.name ?? "",
        message:
          "Browser Mock rejected an expired, replayed, or changed confirmation.",
        operationIds: [],
        simulated: true,
      };
    const plan =
      record.plan as import("../../shared/contracts").ConnectionWorkspaceCreatePlan;
    mockConnectionWorkspaces.set(record.name, {
      name: record.name,
      owner: record.context.user,
      host: "",
      root: plan.root,
      stream: plan.mapping.kind === "stream" ? plan.mapping.stream : "",
      description: plan.description ?? "",
      updated: Math.floor(Date.now() / 1000),
      accessed: Math.floor(Date.now() / 1000),
      rootStatus: "usable",
      selectable: true,
      syncMode: plan.syncMode,
    });
    const workspace = mockConnectionWorkspaces.get(record.name)!;
    return {
      outcome: "created",
      kind: "workspace",
      name: record.name,
      message:
        "Browser Mock simulated workspace creation; no real server was changed.",
      operationIds: [crypto.randomUUID()],
      workspace: structuredClone(workspace),
      simulated: true,
    };
  },
  async listConnectionProfiles() {
    return {
      schemaVersion: 3,
      revision: mockProfileRevision,
      activeProfileId: mockActiveProfileId,
      profiles: structuredClone(mockProfiles),
    };
  },
  async getActiveConnectionProfile() {
    return (
      structuredClone(
        mockProfiles.find((profile) => profile.id === mockActiveProfileId),
      ) ?? null
    );
  },
  async createConnectionProfile(request) {
    assertMockRevision(request.expectedRevision);
    const name = request.name.trim();
    assertMockProfile(name, request.context);
    const profile = {
      id: crypto.randomUUID(),
      name,
      context: { ...request.context },
    };
    mockProfiles = [...mockProfiles, profile];
    mockProfileRevision += 1;
    if (!mockActiveProfileId) {
      mockActiveProfileId = profile.id;
      mockContext = { ...request.context };
      mockContextGeneration += 1;
      mockCurrentStream = "//atlas/main";
    }
    return this.listConnectionProfiles();
  },
  async updateConnectionProfile(request) {
    assertMockRevision(request.expectedRevision);
    const existing = mockProfiles.find((profile) => profile.id === request.id);
    if (!existing)
      throw new Error("notFound: Connection profile was not found.");
    const name = request.name.trim();
    assertMockProfile(name, request.context, request.id);
    mockProfiles = mockProfiles.map((profile) =>
      profile.id === request.id
        ? { id: profile.id, name, context: { ...request.context } }
        : profile,
    );
    mockProfileRevision += 1;
    if (request.id === mockActiveProfileId) {
      mockContext = { ...request.context };
      mockContextGeneration += 1;
      mockCurrentStream = "//atlas/main";
      mockStreamSwitchTokens.clear();
      mockGlobalSearchSnapshots.clear();
      mockShelfSnapshots.clear();
      mockSyncTokens.clear();
      mockRenameTokens.clear();
      mockLockTokens.clear();
    }
    return this.listConnectionProfiles();
  },
  async deleteConnectionProfile(request) {
    assertMockRevision(request.expectedRevision);
    if (!mockProfiles.some((profile) => profile.id === request.id))
      throw new Error("notFound: Connection profile was not found.");
    mockProfiles = mockProfiles.filter((profile) => profile.id !== request.id);
    mockProfileRevision += 1;
    if (request.id === mockActiveProfileId) {
      mockActiveProfileId = undefined;
      mockContext = { server: "", user: "", client: "" };
      mockContextGeneration += 1;
      mockCurrentStream = "";
      mockStreamSwitchTokens.clear();
      mockGlobalSearchSnapshots.clear();
      mockShelfSnapshots.clear();
      mockSyncTokens.clear();
      mockRenameTokens.clear();
      mockLockTokens.clear();
    }
    return this.listConnectionProfiles();
  },
  async setActiveConnectionProfile(request) {
    assertMockRevision(request.expectedRevision);
    const profile = mockProfiles.find((item) => item.id === request.id);
    if (!profile)
      throw new Error("notFound: Connection profile was not found.");
    if (profile.context.server.includes("fail"))
      throw new Error("connectionFailed: Mock connection verification failed.");
    if (mockAuthentication !== "connected")
      throw new Error("authenticationRequired: Mock login is required.");
    mockActiveProfileId = profile.id;
    mockContext = { ...profile.context };
    mockProfileRevision += 1;
    mockContextGeneration += 1;
    mockStreamSwitchTokens.clear();
    mockCurrentStream = "//atlas/main";
    mockGlobalSearchSnapshots.clear();
    mockShelfSnapshots.clear();
    mockSyncTokens.clear();
    mockRenameTokens.clear();
    mockLockTokens.clear();
    return this.runtimeInfo();
  },
  async preflightWorkspaceMutation(request) {
    if (
      request.expectedGeneration !== mockContextGeneration ||
      mockAuthentication !== "connected"
    )
      throw new Error("Connection changed or unavailable.");
    if (request.workspace.toLowerCase() === mockContext.client.toLowerCase())
      throw new Error("Switch to another workspace first.");
    const rows = await this.listUserWorkspaces();
    const row = rows.find((item) => item.name === request.workspace);
    if (!row || row.owner !== mockContext.user)
      throw new Error("Workspace unavailable.");
    if (
      request.action === "rename" &&
      (!request.newName ||
        !/^[^\s*%@#"\x00-\x1f-][^\s*%@#"\x00-\x1f]*$/.test(request.newName) ||
        rows.some(
          (item) => item.name.toLowerCase() === request.newName!.toLowerCase(),
        ))
    )
      throw new Error("Invalid or existing workspace name.");
    const preview = {
      token: crypto.randomUUID(),
      request: { ...request },
      root: row.root,
      stream: row.stream,
      expiresAt: Date.now() + 120000,
    };
    workspaceMutationTokens.set(preview.token, preview);
    return structuredClone(preview);
  },
  async confirmWorkspaceMutation(token, _operationId) {
    const record = workspaceMutationTokens.get(token);
    workspaceMutationTokens.delete(token);
    const reject = (
      message: string,
    ): import("../../shared/contracts").WorkspaceMutationResult => ({
      outcome: "rejected",
      failure: message,
      message,
      workspace: record?.request.workspace ?? "",
      action: record?.request.action ?? "delete",
      verified: false,
    });
    if (
      !record ||
      record.expiresAt <= Date.now() ||
      record.request.expectedGeneration !== mockContextGeneration
    )
      return reject("Confirmation expired or connection changed.");
    const rows = await this.listUserWorkspaces();
    const row = rows.find((item) => item.name === record.request.workspace);
    if (
      !row ||
      row.name === mockContext.client ||
      row.root !== record.root ||
      row.stream !== record.stream
    )
      return reject("Workspace changed.");
    const overrides = workspaceOverrides.get(workspaceScope()) ?? new Map();
    if (record.request.action === "rename") {
      if (
        rows.some(
          (item) =>
            item.name.toLowerCase() === record.request.newName!.toLowerCase(),
        )
      )
        return reject("Name already exists.");
      overrides.set(record.request.newName!, {
        ...row,
        name: record.request.newName!,
      });
    }
    overrides.set(row.name, null);
    workspaceOverrides.set(workspaceScope(), overrides);
    // Post-write existence readback is the only authority (never the request).
    const after = await this.listUserWorkspaces();
    const newName = record.request.newName;
    const observedExists =
      record.request.action === "rename"
        ? after.some((item) => item.name === newName)
        : after.some((item) => item.name === record.request.workspace);
    const verified =
      record.request.action === "rename"
        ? observedExists &&
          !after.some((item) => item.name === record.request.workspace)
        : !observedExists;
    return {
      outcome: verified ? "succeeded" : "unknown",
      failure: verified
        ? undefined
        : "The workspace existence readback did not confirm the requested end state.",
      message: verified
        ? "Browser Mock only: the workspace definition change was confirmed by a simulated existence readback."
        : "Browser Mock only: the workspace change may have applied but the readback did not confirm it; refresh before retrying.",
      workspace: record.request.workspace,
      action: record.request.action,
      verified,
      observedExists,
    };
  },
  async switchWorkspace(request) {
    if (request.expectedGeneration !== mockContextGeneration)
      throw new Error("contextChanged: The active connection changed.");
    const workspace = (await this.listUserWorkspaces()).find(
      (item) => item.name === request.client,
    );
    if (!workspace) throw new Error("notFound: Workspace was not found.");
    if (mockAuthentication !== "connected")
      throw new Error("authenticationRequired: Mock login is required.");
    mockContext = {
      ...mockContext,
      client: workspace.name,
      cwd: workspace.root,
    };
    mockProfiles = mockProfiles.map((profile) =>
      profile.id === mockActiveProfileId
        ? { ...profile, context: { ...mockContext } }
        : profile,
    );
    mockProfileRevision += 1;
    mockContextGeneration += 1;
    mockCurrentStream = workspace.stream || "";
    mockStreamSwitchTokens.clear();
    mockGlobalSearchSnapshots.clear();
    mockShelfSnapshots.clear();
    mockSyncTokens.clear();
    mockRenameTokens.clear();
    mockLockTokens.clear();
    return this.runtimeInfo();
  },
  async saveConnection(context) {
    try {
      localStorage.setItem("p4deck.mockConnection", JSON.stringify(context));
    } catch {
      /* Node contract tests have no browser storage. */
    }
    mockContext = { ...context };
    mockProfiles = mockProfiles.map((profile) =>
      profile.id === mockActiveProfileId
        ? { ...profile, context: { ...context } }
        : profile,
    );
    mockProfileRevision += 1;
    mockContextGeneration += 1;
    mockCurrentStream = "//atlas/main";
    mockStreamSwitchTokens.clear();
    mockGlobalSearchSnapshots.clear();
    mockShelfSnapshots.clear();
    mockSyncTokens.clear();
    mockRenameTokens.clear();
    mockLockTokens.clear();
    return { ...context };
  },
  async runtimeInfo() {
    return {
      mode: "mock",
      p4Version: "P4/MOCK/2026.1",
      activeProfileId: mockActiveProfileId,
      contextGeneration: mockContextGeneration,
      context: { ...mockContext },
      connection: {
        state: mockContext.server ? "notTested" : "disconnected",
        message: mockContext.server
          ? "Browser mock does not contact a server."
          : "No active connection. Create or select a saved connection in Settings.",
        recovery: mockContext.server ? "retry" : "editConfig",
        server: mockContext.server,
      },
    };
  },
  async inspectP4Vfs(request) {
    if (request.expectedContextGeneration !== mockContextGeneration)
      throw new Error(
        "contextChanged: The active connection changed before VFS inspection.",
      );
    const workspace = mockConnectionWorkspaces.get(mockContext.client);
    const mode = workspace?.syncMode ?? "standard";
    return {
      contextGeneration: mockContextGeneration,
      workspace: mockContext.cwd ?? "",
      mode,
      ready:
        mode === "virtual" && mockContext.server.startsWith("ssl:p4.company"),
      serverVersion: "P4D/NTX64/2026.1/MOCK",
      serverSupported: true,
      clientVersion: "Rev. P4/NTX64/2026.1/MOCK",
      clientSupported: true,
      agentConfigured: true,
      reason:
        mode === "virtual"
          ? undefined
          : "This workspace uses standard sync. Create a new virtual workspace to use P4VFS.",
      operationIds: [request.operationId ?? "mock-vfs-inspect"],
    };
  },
  async runP4(request) {
    if (["lock", "unlock"].includes(request.command.toLowerCase()))
      throw new Error(
        "Lock and unlock are blocked in generic runP4; use the dedicated lock workflow.",
      );
    const terminalDecision = inspectTerminalCommand(
      [request.command, ...request.args].join(" "),
      [request.command, ...request.args],
    );
    if (terminalDecision.blocked) {
      throw new Error(
        "Credential-sensitive P4 commands are blocked in Terminal; use Settings > Connection authentication.",
      );
    }
    if (
      request.source === "gui" &&
      [
        "submit",
        "shelve",
        "unshelve",
        "resolve",
        "move",
        "client",
        "stream",
        "switch",
      ].includes(request.command.toLowerCase())
    )
      throw new Error(
        "GUI mutations require a dedicated preflight and confirmation workflow",
      );
    const operationId = request.operationId ?? crypto.randomUUID();
    const started = new Date().toISOString();
    const args =
      request.command === "p4"
        ? request.args
        : [request.command, ...request.args];
    const command = `p4 ${args.join(" ")}`;
    emitOperation({
      operationId,
      type: "started",
      message: command,
      timestamp: started,
    });
    await new Promise((resolve) => setTimeout(resolve, 180));
    if (mockCancelledOperations.delete(operationId)) {
      const cancelled: OperationEvent = {
        operationId,
        type: "cancelled",
        timestamp: new Date().toISOString(),
      };
      emitOperation(cancelled);
      return {
        operationId,
        exitCode: -1,
        durationMs: 180,
        events: [cancelled],
      };
    }
    const joined = args.join(" ").toLowerCase();
    const isError =
      joined.includes("fail") ||
      joined.includes("-p") ||
      joined.includes("-p4passwd");
    const message = isError
      ? "Command rejected by the controlled P4 runner."
      : joined.startsWith("opened")
        ? "//depot/atlas/main/src/render/viewport.cpp#4 - edit default change (text)"
        : `Mock completed: ${command}`;
    emitMockLog(
      isError ? "error" : "info",
      request.source,
      command,
      message,
      operationId,
      180,
    );
    emitOperation({
      operationId,
      type: "completed",
      message: String(isError ? 1 : 0),
      timestamp: new Date().toISOString(),
    });
    return {
      operationId,
      exitCode: isError ? 1 : 0,
      durationMs: 180,
      events: [
        { operationId, type: "started", timestamp: started },
        {
          operationId,
          type: isError ? "error" : "stdout",
          message,
          timestamp: new Date().toISOString(),
        },
        {
          operationId,
          type: "completed",
          message: String(isError ? 1 : 0),
          timestamp: new Date().toISOString(),
        },
      ],
    };
  },
  async cancelOperation(operationId) {
    mockCancelledOperations.add(operationId);
  },
  async cancelAllOperations() {
    mockActiveOperations.forEach((id) => mockCancelledOperations.add(id));
  },
  async globalSearch(query) {
    if (
      !query.operationId.trim() ||
      [...query.operationId].length > 128 ||
      [...query.operationId].some((character) => /\p{Cc}/u.test(character))
    )
      throw new Error("A valid global search operation ID is required.");
    if (
      !Number.isInteger(query.pageSize) ||
      query.pageSize < 1 ||
      query.pageSize > 100
    )
      throw new Error("Global search page size must be between 1 and 100.");
    if ([...query.text].some((character) => /\p{Cc}/u.test(character)))
      throw new Error("Global search text cannot contain control characters.");
    const text = query.text.trim().replace(/\s+/gu, " ");
    if (!text || [...text].length > 128)
      throw new Error(
        "Global search text must contain 1 to 128 Unicode characters.",
      );
    if (mockCancelledOperations.delete(query.operationId))
      throw new Error("Global search was cancelled.");
    const kindOrder: GlobalSearchKind[] = [
      "submittedChange",
      "pendingChange",
      "workspaceFile",
      "depotFile",
      "job",
      "stream",
      "shelf",
    ];
    const kinds = [
      ...new Set(query.kinds.length ? query.kinds : kindOrder),
    ].sort(
      (left, right) => kindOrder.indexOf(left) - kindOrder.indexOf(right),
    ) as GlobalSearchKind[];
    const signature = globalSearchSignature(text, kinds, query.pageSize);
    let snapshotId = "";
    let offset = 0;
    let deduplicated: GlobalSearchItem[];
    let facets: Array<{
      kind: GlobalSearchKind;
      matchedCount: number;
      scannedCount: number;
      partial: boolean;
      partialReason?: string;
    }>;
    if (query.cursor) {
      const cursor = decodeGlobalSearchCursor(query.cursor, signature);
      snapshotId = cursor.snapshotId;
      offset = cursor.offset;
      const snapshot = mockGlobalSearchSnapshots.get(snapshotId);
      if (
        !snapshot ||
        snapshot.signature !== signature ||
        snapshot.nextOffset !== offset ||
        Date.now() - snapshot.createdAt > 120_000
      )
        throw new Error("Global search cursor expired or was replayed.");
      deduplicated = snapshot.items;
      facets = snapshot.facets;
    } else {
      const all: GlobalSearchItem[] = [];
      for (const kind of kinds) {
        if (kind === "submittedChange" || kind === "pendingChange") {
          for (const change of mockChanges.filter((item) =>
            kind === "submittedChange"
              ? item.status === "submitted"
              : item.status === "pending",
          )) {
            const item = mockSearchItem(
              kind,
              `${kind}:${change.id}`,
              `CL ${change.id}`,
              `${change.description} · ${change.user} · ${change.client}`,
              kind === "submittedChange"
                ? { type: "submittedChange", changeId: change.id }
                : { type: "pendingChange", changeId: change.id },
              text,
            );
            if (item) all.push(item);
          }
        } else if (kind === "workspaceFile" || kind === "depotFile") {
          for (const file of mockWorkspace.filter(
            (item) => item.kind === "file",
          )) {
            const depotPath =
              file.depotPath ?? `//atlas/main/${file.relativePath}`;
            const item = mockSearchItem(
              kind,
              `${kind}:${depotPath}`,
              file.name,
              kind === "workspaceFile" ? file.absolutePath : depotPath,
              kind === "workspaceFile"
                ? { type: "workspaceFile", absolutePath: file.absolutePath }
                : { type: "depotFile", depotPath },
              text,
            );
            if (item) all.push(item);
          }
        } else if (kind === "job") {
          for (const jobId of ["ATLAS-1000", "ATLAS-1187", "UNICODE-你好"]) {
            const item = mockSearchItem(
              kind,
              `job:${jobId}`,
              jobId,
              `open · Simulated MockBackend job ${jobId}`,
              { type: "job", jobId },
              text,
            );
            if (item) all.push(item);
          }
        } else if (kind === "stream") {
          for (const stream of [
            {
              path: "//atlas/main",
              name: "Atlas Mainline",
              detail: "mainline · fmeng · simulated production stream",
            },
            {
              path: "//atlas/dev",
              name: "Atlas Development",
              detail: "development · alice · parent //atlas/main",
            },
            {
              path: "//atlas/task-render",
              name: "Render Task",
              detail: "task · bruno · parent //atlas/dev",
            },
          ]) {
            const item = mockSearchItem(
              kind,
              `stream:${stream.path}`,
              stream.name,
              `${stream.path} · ${stream.detail} · Browser Mock simulated`,
              { type: "stream", streamPath: stream.path },
              text,
            );
            if (item) all.push(item);
          }
        } else {
          const detailedShelf = allMockPendingChanges().find(
            (change) => change.id === 31821,
          );
          const searchableShelves = [
            ...(detailedShelf
              ? [
                  {
                    ...detailedShelf,
                    status: "shelved",
                    time:
                      detailedShelf.updatedAt ?? new Date(now).toISOString(),
                  },
                ]
              : []),
            ...mockChanges.filter((change) => change.status === "shelved"),
          ].slice(0, 140);
          for (const shelf of searchableShelves) {
            const fileSummary = `//atlas/shelves/${shelf.id}/deep/search-${shelf.id}.uasset`;
            const item = mockSearchItem(
              kind,
              `shelf:${shelf.id}`,
              `Shelf ${shelf.id}`,
              `${shelf.description} · ${shelf.user} · ${shelf.client} · ${shelf.status} · ${shelf.time} · 1 matching file: ${fileSummary} · Browser Mock simulated`,
              { type: "shelf", changeId: shelf.id },
              text,
            );
            if (item) all.push(item);
          }
        }
      }
      all.sort((left, right) =>
        `${left.kind}:${left.rank}:${left.title}:${left.identity}`.localeCompare(
          `${right.kind}:${right.rank}:${right.title}:${right.identity}`,
        ),
      );
      deduplicated = all.filter(
        (item, index) =>
          all.findIndex((candidate) => candidate.identity === item.identity) ===
          index,
      );
      facets = kinds.map((kind) => ({
        kind,
        matchedCount: deduplicated.filter((item) => item.kind === kind).length,
        scannedCount:
          kind === "job"
            ? 3
            : kind === "stream"
              ? 3
              : kind === "shelf"
                ? 140
                : kind.includes("Change")
                  ? mockChanges.length
                  : mockWorkspace.length,
        partial: kind === "shelf",
        partialReason:
          kind === "shelf"
            ? "Browser Mock simulated shelf detail candidate limit reached"
            : undefined,
      }));
      snapshotId = `mock-global-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    if (offset >= deduplicated.length && offset !== 0)
      throw new Error(
        "Global search cursor points beyond the simulated snapshot.",
      );
    const page = deduplicated.slice(offset, offset + query.pageSize);
    const end = offset + page.length;
    const hasMore = end < deduplicated.length;
    if (hasMore) {
      mockGlobalSearchSnapshots.set(snapshotId, {
        signature,
        items: deduplicated,
        facets,
        nextOffset: end,
        createdAt: Date.now(),
      });
    } else if (snapshotId) {
      mockGlobalSearchSnapshots.delete(snapshotId);
    }
    return {
      requestGeneration: query.requestGeneration,
      normalizedQuery: text,
      groups: kinds
        .map((kind) => ({
          kind,
          items: page.filter((item) => item.kind === kind),
        }))
        .filter((group) => group.items.length),
      facets,
      hasMore,
      nextCursor: hasMore
        ? encodeGlobalSearchCursor(snapshotId, end, signature)
        : undefined,
      partial: facets.some((facet) => facet.partial),
      simulated: true,
      stats: {
        scannedCount: kinds.length,
        matchedCount: deduplicated.length,
        returnedCount: page.length,
        categoryFailureCount: 0,
        safetyLimit: 1000,
      },
    };
  },
  async queryChangelists(query) {
    if (!query.operationId.trim() || query.operationId.length > 128)
      throw new Error("A valid submitted query operation ID is required.");
    if (
      !Number.isInteger(query.pageSize) ||
      query.pageSize < 1 ||
      query.pageSize > 500
    )
      throw new Error("Submitted query page size must be between 1 and 500.");
    if (
      query.users.length > 16 ||
      query.clients.length > 16 ||
      (query.jobs ?? []).length > 16
    )
      throw new Error("Too many submitted query filters.");
    const from = Date.parse(query.from);
    const to = Date.parse(query.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to)
      throw new Error("Submitted query time range is invalid.");
    if ((query.jobs ?? []).length && query.hasJob === false)
      throw new Error("A Job filter cannot be combined with hasJob=false.");
    const signature = submittedQuerySignature(query);
    const upperChangeId = query.cursor
      ? decodeSubmittedCursor(query.cursor, signature)
      : Number.MAX_SAFE_INTEGER;
    const keyword = query.keyword.trim().toLowerCase();
    let scannedCount = 0;
    let filtered = mockChanges.filter((change) => {
      if (change.status !== "submitted" || change.id > upperChangeId)
        return false;
      scannedCount++;
      if (query.users.length && !query.users.includes(change.user))
        return false;
      if (query.clients.length && !query.clients.includes(change.client))
        return false;
      const selectedStreams = [
        ...new Set([
          ...(query.streams ?? []),
          ...(query.stream ? [query.stream] : []),
        ]),
      ];
      if (
        selectedStreams.length &&
        !selectedStreams.includes(change.stream ?? "")
      )
        return false;
      const depotPath = `//atlas/${change.stream?.split("/").pop() ?? "main"}/mock/${change.id}.txt`;
      if (
        query.depotPath &&
        !depotPath.startsWith(query.depotPath.replace(/\.\.\.$/, ""))
      )
        return false;
      if (Date.parse(change.time) < from || Date.parse(change.time) > to)
        return false;
      if (query.hasJob != null && Boolean(change.jobs.length) !== query.hasJob)
        return false;
      if (
        (query.jobs ?? []).length &&
        !(query.jobs ?? []).some((job) => change.jobs.includes(job))
      )
        return false;
      if (
        query.mergeClassifications.length &&
        !query.mergeClassifications.includes(change.mergeClassification)
      )
        return false;
      if (
        keyword &&
        !`${change.id} ${change.description} ${change.user} ${change.client} ${change.jobs.join(" ")}`
          .toLowerCase()
          .includes(keyword)
      )
        return false;
      return true;
    });
    const hiddenReliableMergeCount = query.hideReliableMerges
      ? filtered.filter(
          (change) => change.mergeClassification === "reliableMerge",
        ).length
      : 0;
    if (query.hideReliableMerges)
      filtered = filtered.filter(
        (change) => change.mergeClassification !== "reliableMerge",
      );
    await new Promise((resolve) => setTimeout(resolve, 80));
    const hasMore = filtered.length > query.pageSize;
    const nextItem = filtered[query.pageSize];
    const items = filtered.slice(0, query.pageSize);
    return {
      requestGeneration: query.requestGeneration,
      items,
      hasMore,
      nextCursor:
        hasMore && nextItem
          ? encodeSubmittedCursor(nextItem.id, signature)
          : undefined,
      stats: {
        scannedCount,
        matchedCount: items.length,
        hiddenReliableMergeCount,
        truncatedBySafetyLimit: false,
      },
    };
  },
  async getSubmittedChangeDetail(request) {
    const change = mockChanges.find(
      (candidate) =>
        candidate.id === request.changeId && candidate.status === "submitted",
    );
    if (!change) {
      return {
        changeId: request.changeId,
        description: "",
        user: "",
        client: "",
        time: "",
        jobs: [],
        files: [],
        integrationEvidence: [],
        mergeClassification: "unknown",
        inspectionStatus: "unavailable",
        message: "Submitted changelist inspection failed.",
      };
    }
    const reliable = change.mergeClassification === "reliableMerge";
    const unavailable = change.mergeClassification === "unknown";
    const suspected = change.mergeClassification === "suspectedMerge";
    return {
      changeId: change.id,
      description: change.description,
      user: change.user,
      client: change.client,
      time: change.time,
      jobs: [...change.jobs],
      files: [
        {
          depotPath: `//atlas/main/mock/${change.id}.txt`,
          action: reliable ? "integrate" : "edit",
          revision: 3,
          fileType: "text",
        },
      ],
      integrationEvidence: reliable
        ? [
            {
              source: "describeAction" as const,
              depotPath: `//atlas/main/mock/${change.id}.txt`,
              relationship: "integrate",
            },
          ]
        : [],
      mergeClassification: change.mergeClassification,
      inspectionStatus: unavailable
        ? "unavailable"
        : suspected
          ? "partial"
          : "complete",
      message: unavailable
        ? "Mock inspection unavailable; no real P4 Server was accessed."
        : suspected
          ? "Mock inspection is partial; text alone is not reliable integration evidence."
          : undefined,
    };
  },
  async performClAction(action) {
    const operationId = crypto.randomUUID();
    const id = "changeId" in action ? action.changeId : 0;
    const command = `p4 ${action.type} ${id || ""}`.trim();
    emitMockLog(
      "info",
      "gui",
      command,
      "Operation completed in browser mock.",
      operationId,
      120,
    );
    return {
      operation: {
        operationId,
        exitCode: 0,
        durationMs: 120,
        events: [
          {
            operationId,
            type: "completed",
            message: "0",
            timestamp: new Date().toISOString(),
          },
        ],
      },
      affectedChanges: id ? [id] : [],
      warnings: [],
    };
  },
  async queryLogs(query) {
    const keyword = query.keyword?.toLowerCase();
    return mockLogs
      .filter(
        (entry) =>
          (!query.levels?.length || query.levels.includes(entry.level)) &&
          (!query.sources?.length || query.sources.includes(entry.source)) &&
          (!query.server || query.server === entry.server) &&
          (!query.workspace || query.workspace === entry.workspace) &&
          (!query.command || entry.command.includes(query.command)) &&
          (!query.operationId || query.operationId === entry.operationId) &&
          (!keyword ||
            `${entry.command} ${entry.message}`
              .toLowerCase()
              .includes(keyword)),
      )
      .slice(0, query.limit ?? 10_000);
  },
  async subscribeOperationEvents(callback) {
    operationSubscribers.add(callback);
    return () => operationSubscribers.delete(callback);
  },
  async listWorkspaceChildren(path, _refresh, _operationId, localOnly) {
    return {
      items: mockWorkspace
        .map((node) =>
          path
            ? {
                ...node,
                id: `${path}-${node.id}`,
                relativePath:
                  `${path.replace(/^\/workspace\/atlas\/?/, "")}/${node.name}`.replace(
                    /^\//,
                    "",
                  ),
                absolutePath: `${path.startsWith("/") ? path : `/workspace/atlas/${path}`}/${node.name}`,
              }
            : node,
        )
        .map((node) =>
          localOnly
            ? {
                ...node,
                state: "loading" as const,
                depotPath: undefined,
                revision: undefined,
                headRevision: undefined,
                status: undefined,
              }
            : node,
        ),
      completeness: "complete",
      errors: [],
      operationIds: [],
      truncated: false,
      safetyLimit: 10_000,
      cacheFreshness: localOnly ? "local" : "fresh",
    };
  },
  async listDepotChildren(path = "//atlas/main") {
    return mockWorkspace.slice(0, 80).map((node) => ({
      id: `depot-${node.id}`,
      name: node.name,
      kind: node.kind,
      depotPath: `${path.replace(/\/$/, "")}/${node.name}`,
      headRevision: node.headRevision,
      headAction: node.state === "openedDelete" ? "delete" : "edit",
      hasChildren: node.hasChildren,
    }));
  },
  async resolvePath(request) {
    const raw = request.input.trim();
    const depot = raw.startsWith("//");
    const absolute = raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw);
    const relativePath = depot
      ? raw.replace(/^\/\/atlas\/main\/?/, "")
      : absolute
        ? raw.replace(/^\/workspace\/atlas\/?/, "")
        : raw;
    return {
      found:
        Boolean(relativePath) ||
        raw === "//atlas/main" ||
        raw === "/workspace/atlas",
      inputKind: depot ? "depot" : absolute ? "absolute" : "relative",
      relativePath,
      absolutePath: `/workspace/atlas/${relativePath}`,
      depotPath: `//atlas/main/${relativePath}`,
    };
  },
  async openLocalPath() {
    throw new Error("系统打开功能仅在桌面应用中可用 / Use the desktop app");
  },
  async openSwarmLink() {
    throw new Error("Native Swarm opening is unavailable in the browser demo.");
  },
  async localPathCapabilities() {
    return { reveal: false, openWith: false };
  },
  async performFileAction(request) {
    if ((request.action as string) === "renameMove")
      throw new Error(
        "Rename/move must use preflightRenameMove and confirmRenameMove",
      );
    if (request.action === "undo")
      throw new Error("Undo must use previewUndo and confirmUndo");
    if ((request.action as string) === "submit")
      throw new Error("Submit must use preflightSubmit and confirmSubmit");
    if (["shelve", "resolve", "lock", "unlock"].includes(request.action))
      throw new Error(
        "Shelf, resolve, lock and unlock must use dedicated preflight and confirmation APIs",
      );
    if (
      ["getLatest", "getRevision", "removeFromWorkspace"].includes(
        request.action,
      )
    )
      throw new Error("Sync must use previewSync and confirmSync");
    const operationId = request.operationId ?? crypto.randomUUID();
    const event = (
      type: OperationEvent["type"],
      progress: number,
    ): OperationEvent => ({
      operationId,
      type,
      progress,
      message:
        type === "queued" || type === "started"
          ? `p4 ${request.action}`
          : undefined,
      timestamp: new Date().toISOString(),
    });
    const checkCancellation = () => {
      if (!mockCancelledOperations.delete(operationId)) return;
      emitOperation({
        operationId,
        type: "cancelled",
        timestamp: new Date().toISOString(),
      });
      throw new Error("Mock P4 operation was cancelled.");
    };
    emitOperation(event("queued", 0));
    await new Promise((resolve) => setTimeout(resolve, 30));
    checkCancellation();
    emitOperation(event("started", 2));
    await new Promise((resolve) => setTimeout(resolve, 45));
    checkCancellation();
    emitOperation(event("progress", 55));
    await new Promise((resolve) => setTimeout(resolve, 45));
    checkCancellation();
    emitOperation(event("completed", 100));
    emitMockLog(
      "info",
      "gui",
      `p4 ${request.action}`,
      `${request.paths.length} path(s) updated.`,
      operationId,
      90,
    );
    return {
      operation: {
        operationId,
        exitCode: 0,
        durationMs: 120,
        events: [event("completed", 100)],
      },
      affectedPaths: request.paths,
      message: `${request.action} completed in Mock Backend.`,
    };
  },
  async preflightFileLock(request) {
    const paths = [...new Set(request.paths)].sort();
    const files = paths.map((inputPath) => {
      const node = mockWorkspace.find(
        (item) =>
          item.absolutePath === inputPath || item.depotPath === inputPath,
      );
      const ownership = node?.status?.lockOwnership ?? "unlocked";
      const opened =
        node?.status?.openedAction ??
        (node?.state?.startsWith("opened") ? "edit" : undefined);
      const alreadySatisfied =
        (request.operation === "lock" && ownership === "ours") ||
        (request.operation === "unlock" && ownership === "unlocked");
      const applicable = Boolean(opened) && !alreadySatisfied;
      return {
        inputPath,
        depotPath: node?.depotPath ?? inputPath,
        clientPath: `//${mockContext.client}/${node?.relativePath ?? ""}`,
        localPath: node?.absolutePath,
        openedAction: opened ?? "",
        changelistId: node?.changelistId ?? 0,
        fileType: node?.status?.fileType ?? "text",
        exclusive: node?.status?.exclusiveOpen ?? false,
        ownership,
        lockOwner: node?.status?.lockOwner,
        otherOpen: node?.status?.otherOpen ?? [],
        permission: "allowed" as const,
        applicable,
        reason: !opened
          ? "Mock target is not opened in the current workspace."
          : alreadySatisfied
            ? "Requested state is already satisfied."
            : undefined,
      };
    });
    const target = {
      server: mockContext.server,
      user: mockContext.user,
      client: mockContext.client,
      workspace: mockContext.cwd ?? "",
      activeProfileId: mockActiveProfileId,
      contextGeneration: mockContextGeneration,
      operation: request.operation,
      files,
    };
    const stateDigest = JSON.stringify(target);
    const blockers: import("../../shared/contracts").FileLockIssue[] = files
      .filter((file) => !file.openedAction)
      .map((file) => ({
        code: "notOpened" as const,
        certainty: "confirmed" as const,
        message: file.reason!,
        paths: [file.depotPath],
      }));
    const applicable = files.filter((file) => file.applicable).length;
    if (!blockers.length && applicable === 0)
      blockers.push({
        code: request.operation === "lock" ? "alreadyLocked" : "notLocked",
        certainty: "confirmed",
        message: "No selected file requires a lock state change.",
        paths: files.map((file) => file.depotPath),
      });
    const ready = blockers.length === 0 && applicable > 0;
    const token = ready ? crypto.randomUUID() : undefined;
    const expiresAt = Date.now() + 120_000;
    if (token)
      mockLockTokens.set(token, { target, digest: stateDigest, expiresAt });
    return {
      ready,
      operation: request.operation,
      files,
      counts: {
        requested: paths.length,
        applicable,
        alreadySatisfied: files.filter(
          (file) => !file.applicable && !!file.openedAction,
        ).length,
        blocked: files.filter((file) => !file.applicable && !file.openedAction)
          .length,
        exclusive: files.filter((file) => file.exclusive).length,
      },
      blockers,
      warnings: [],
      targetSnapshot: target,
      stateDigest,
      token,
      expiresAt,
      ttlMs: 120_000,
      operationIds: [request.operationId ?? crypto.randomUUID()],
      logReference: request.operationId,
    };
  },
  async confirmFileLock(confirmation) {
    const record = mockLockTokens.get(confirmation.token);
    mockLockTokens.delete(confirmation.token);
    const refresh = {
      workspaceStatus: true,
      pendingChanges: true,
      search: true,
      review: true,
      depotPaths: confirmation.target.files.map((file) => file.depotPath),
      localPaths: confirmation.target.files.flatMap((file) =>
        file.localPath ? [file.localPath] : [],
      ),
      reason: "Mock lock state changed; refresh simulated data.",
    };
    if (!record)
      return {
        outcome: "rejected",
        failure: "tokenUnknown",
        message: "Mock lock confirmation token is unknown or already used.",
        files: [],
        refresh,
      };
    if (record.expiresAt <= Date.now())
      return {
        outcome: "rejected",
        failure: "tokenExpired",
        message: "Mock lock confirmation expired.",
        files: [],
        refresh,
      };
    if (
      record.digest !== confirmation.stateDigest ||
      JSON.stringify(record.target) !== JSON.stringify(confirmation.target)
    )
      return {
        outcome: "rejected",
        failure: "targetMismatch",
        message: "Mock lock confirmation does not match the reviewed target.",
        files: [],
        refresh,
      };
    const ownership =
      confirmation.target.operation === "lock" ? "ours" : "unlocked";
    for (const file of confirmation.target.files.filter(
      (file) => file.applicable,
    )) {
      const node = mockWorkspace.find(
        (item) => item.depotPath === file.depotPath,
      );
      if (node) {
        node.status ??= {
          primary: node.state,
          openedAction: file.openedAction as WorkspaceOpenedAction,
          sync: "unknown",
          resolve: "unknown",
          local: "unknown",
          fileType: file.fileType,
          exclusiveOpen: file.exclusive,
          completeness: "complete",
          evidence: [
            {
              source: "fstat",
              summary: "Simulated lock state from Mock Backend.",
            },
          ],
          errors: [],
        };
        node.status.lockOwnership = ownership;
        node.status.lockOwner =
          ownership === "ours"
            ? `${mockContext.user}@${mockContext.client}`
            : undefined;
        node.status.canLock = ownership === "unlocked";
        node.status.canUnlock = ownership === "ours";
        node.status.lockReason =
          ownership === "ours"
            ? "Mock: locked by this workspace."
            : "Mock: unlocked.";
      }
    }
    return {
      outcome: "succeeded",
      message: "Mock lock workflow completed without contacting a P4 Server.",
      files: confirmation.target.files.map((file) => ({
        depotPath: file.depotPath,
        outcome: file.applicable ? "succeeded" : "alreadySatisfied",
        message: "Simulated and verified in Mock Backend.",
        ownership,
        operationId: confirmation.operationId,
      })),
      operationId: confirmation.operationId,
      logReference: confirmation.operationId,
      refresh,
    };
  },
  async preflightRenameMove(request) {
    const root = (mockContext.cwd ?? "")
      .replaceAll("\\", "/")
      .replace(/\/$/, "");
    const sourceLocal = request.sourcePath.replaceAll("\\", "/");
    const targetLocal = request.targetPath.replaceAll("\\", "/");
    const relativeSource = sourceLocal.startsWith(`${root}/`)
      ? sourceLocal.slice(root.length + 1)
      : "";
    const relativeTarget = targetLocal.startsWith(`${root}/`)
      ? targetLocal.slice(root.length + 1)
      : "";
    const sourceNode = mockWorkspace.find(
      (node) => node.absolutePath.replaceAll("\\", "/") === sourceLocal,
    );
    const targetNode = mockWorkspace.find(
      (node) => node.absolutePath.replaceAll("\\", "/") === targetLocal,
    );
    const source = relativeSource
      ? {
          depotPath: sourceNode?.depotPath ?? `//atlas/main/${relativeSource}`,
          clientPath: `//${mockContext.client}/${relativeSource}`,
          localPath: request.sourcePath,
        }
      : undefined;
    const target = relativeTarget
      ? {
          depotPath: `//atlas/main/${relativeTarget}`,
          clientPath: `//${mockContext.client}/${relativeTarget}`,
          localPath: request.targetPath,
        }
      : undefined;
    const sourceState = sourceNode
      ? {
          action:
            sourceNode.state === "openedAdd"
              ? "add"
              : sourceNode.state === "openedEdit"
                ? "edit"
                : "",
          changeId: sourceNode.changelistId ?? 0,
          haveRevision: sourceNode.revision,
          headRevision: sourceNode.headRevision,
        }
      : undefined;
    const changes = allMockPendingChanges();
    const targetChangeValid =
      request.targetChangeId === 0 ||
      changes.some((change) => change.id === request.targetChangeId);
    const caseOnlyRisk =
      sourceLocal !== targetLocal &&
      sourceLocal.toLocaleLowerCase() === targetLocal.toLocaleLowerCase();
    const blockers: import("../../shared/contracts").RenameMoveIssue[] = [];
    if (!sourceNode || sourceNode.kind !== "file")
      blockers.push({
        code: "sourceMissing",
        message: "Browser Mock: source is not an existing controlled file.",
      });
    if (!source)
      blockers.push({
        code: "sourceUnmapped",
        message: "Browser Mock: source is outside the workspace mapping.",
      });
    if (!target)
      blockers.push({
        code: "targetUnmapped",
        message: "Browser Mock: target is outside the workspace mapping.",
      });
    if (targetNode)
      blockers.push({
        code: "targetExists",
        message: "Browser Mock: target already exists.",
      });
    if (!sourceState || !["edit", "add"].includes(sourceState.action))
      blockers.push({
        code: "sourceNotOpened",
        message: "Browser Mock: source must be opened for edit or add.",
      });
    if (!targetChangeValid)
      blockers.push({
        code: "invalidChangelist",
        message: "Browser Mock: target changelist does not exist.",
      });
    if (caseOnlyRisk)
      blockers.push({
        code: "caseOnlyRename",
        message: "Case-only rename is blocked on Windows.",
      });
    const targetSnapshot =
      !blockers.length && source && target && sourceState
        ? {
            server: mockContext.server,
            user: mockContext.user,
            client: mockContext.client,
            workspace: mockContext.cwd ?? "",
            activeProfileId: mockActiveProfileId,
            contextGeneration: mockContextGeneration,
            source,
            target,
            sourceState,
            targetChangeId: request.targetChangeId,
          }
        : undefined;
    const previewDigest = mockDigest(
      JSON.stringify({ targetSnapshot, blockers, warnings: [] }),
    );
    const token = targetSnapshot ? crypto.randomUUID() : undefined;
    const expiresAt = Date.now() + 120_000;
    if (token)
      mockRenameTokens.set(token, {
        target: targetSnapshot!,
        digest: previewDigest,
        expiresAt,
      });
    return {
      ready: Boolean(targetSnapshot),
      source,
      target,
      sourceState,
      targetChangeId: request.targetChangeId,
      targetChangeValid,
      targetExists: Boolean(targetNode),
      caseOnlyRisk,
      blockers,
      warnings: [],
      targetSnapshot,
      previewDigest,
      token,
      expiresAt,
      ttlMs: 120_000,
      operationIds: [],
    };
  },
  async confirmRenameMove(confirmation) {
    const record = mockRenameTokens.get(confirmation.token);
    mockRenameTokens.delete(confirmation.token);
    const refresh = {
      workspaceStatus: true,
      pendingChanges: true,
      depotPaths: [
        confirmation.target.source.depotPath,
        confirmation.target.target.depotPath,
      ],
      localPaths: [
        confirmation.target.source.localPath,
        confirmation.target.target.localPath,
      ],
      reason: "Browser Mock: refresh the simulated workspace snapshot.",
    };
    if (!record)
      return {
        outcome: "rejected",
        failure: "tokenUnknown",
        message: "Browser Mock: token is unknown or already used.",
        refresh,
      };
    if (record.expiresAt <= Date.now())
      return {
        outcome: "rejected",
        failure: "tokenExpired",
        message: "Browser Mock: preview expired.",
        refresh,
      };
    if (
      JSON.stringify(record.target) !== JSON.stringify(confirmation.target) ||
      record.digest !== confirmation.previewDigest
    )
      return {
        outcome: "rejected",
        failure: "targetMismatch",
        message: "Browser Mock: confirmation does not match preview.",
        refresh,
      };
    if (
      record.target.contextGeneration !== mockContextGeneration ||
      record.target.activeProfileId !== mockActiveProfileId
    )
      return {
        outcome: "rejected",
        failure: "contextChanged",
        message: "Browser Mock: runtime context changed.",
        refresh,
      };
    const operationId = confirmation.operationId ?? crypto.randomUUID();
    emitMockLog(
      "info",
      "gui",
      "p4 move",
      "Browser Mock only: simulated confirmed rename/move.",
      operationId,
      10,
    );
    return {
      outcome: "succeeded",
      message: "Browser Mock only: rename/move was simulated.",
      operationId,
      logReference: operationId,
      refresh,
    };
  },
  async previewUndo() {
    throw new Error(
      "Demo backend cannot preview real revision Undo. Use a verified local fixture for integration testing.",
    );
  },
  async confirmUndo() {
    throw new Error("Demo backend cannot execute revision Undo.");
  },
  async previewSync(request) {
    const operationId = request.operationId ?? crypto.randomUUID();
    const target: import("../../shared/contracts").SyncTargetSnapshot = {
      server: mockContext.server,
      user: mockContext.user,
      client: mockContext.client,
      workspace: mockContext.cwd ?? "",
      contextGeneration: mockContextGeneration,
      paths: [...new Set(request.paths)].sort(),
      revision: request.revision,
      force: request.force ?? false,
      parallelThreads: request.parallelThreads,
    };
    const entries = target.paths.map((path, index) => ({
      kind: index % 3 === 2 ? ("added" as const) : ("updated" as const),
      depotPath: path.startsWith("//") ? path : undefined,
      clientPath: path.startsWith("//") ? undefined : path,
      revision: 2,
      message:
        "Browser Mock only: simulated sync preview; no real P4 server was accessed.",
    }));
    const counts = {
      added: entries.filter((entry) => entry.kind === "added").length,
      updated: entries.filter((entry) => entry.kind === "updated").length,
      deleted: 0,
      upToDate: 0,
      warnings: target.force ? 1 : 0,
      conflicts: 0,
    };
    const warnings: import("../../shared/contracts").SyncIssue[] = target.force
      ? [
          {
            code: "forceOverwrite",
            message:
              "Browser Mock only: force risk is simulated and requires explicit acknowledgement.",
            paths: target.paths,
          },
        ]
      : [];
    const digest = mockDigest(JSON.stringify({ target, entries, warnings }));
    const token = crypto.randomUUID();
    const expiresAt = Date.now() + 120_000;
    mockSyncTokens.set(token, { target, digest, expiresAt, counts });
    emitMockLog(
      "info",
      "gui",
      "p4 sync -n (simulated)",
      `${entries.length} simulated path(s).`,
      operationId,
      1,
    );
    return {
      ready: true,
      target,
      counts,
      entries,
      totalEntries: entries.length,
      truncated: false,
      partial: false,
      blockers: [],
      warnings,
      contentDigest: digest,
      token,
      expiresAt,
      ttlMs: 120_000,
      operationIds: [operationId],
      logReference: operationId,
    };
  },
  async confirmSync(confirmation) {
    const record = mockSyncTokens.get(confirmation.token);
    mockSyncTokens.delete(confirmation.token);
    const reject = (
      failure: import("../../shared/contracts").SyncFailureCode,
      message: string,
    ): import("../../shared/contracts").SyncResult => ({
      outcome: "rejected",
      failure,
      message,
      affectedPaths: confirmation.target.paths,
      counts: record?.counts ?? {
        added: 0,
        updated: 0,
        deleted: 0,
        upToDate: 0,
        warnings: 0,
        conflicts: 0,
      },
      refreshWorkspace: true,
      refreshDepot: true,
    });
    if (!record) return reject("tokenUnknown", "Unknown or consumed token.");
    if (record.expiresAt <= Date.now())
      return reject("tokenExpired", "The simulated preview expired.");
    if (JSON.stringify(record.target) !== JSON.stringify(confirmation.target))
      return reject("targetMismatch", "The sync target or options changed.");
    if (
      record.target.contextGeneration !== mockContextGeneration ||
      record.target.server !== mockContext.server ||
      record.target.user !== mockContext.user ||
      record.target.client !== mockContext.client
    )
      return reject("contextChanged", "The connection changed.");
    if (record.target.force && !confirmation.acknowledgeForce)
      return reject(
        "forceAcknowledgementRequired",
        "Forced sync requires explicit acknowledgement.",
      );
    const operationId = confirmation.operationId ?? crypto.randomUUID();
    return {
      outcome: "succeeded",
      message:
        "Browser Mock only: sync was simulated. No real files or P4 server were changed.",
      operationId,
      logReference: operationId,
      affectedPaths: record.target.paths,
      counts: record.counts,
      refreshWorkspace: true,
      refreshDepot: true,
    };
  },
  async syncLatest(request) {
    const operationId = request.operationId ?? crypto.randomUUID();
    const paths = [...new Set(request.paths)].sort();
    const counts = {
      added: 0,
      updated: paths.length,
      deleted: 0,
      upToDate: 0,
      warnings: 0,
      conflicts: 0,
    };
    emitMockLog(
      "info",
      "gui",
      "p4 sync //... (simulated)",
      `${paths.length} simulated path(s).`,
      operationId,
      1,
    );
    return {
      outcome: "succeeded",
      message:
        "Browser Mock only: Get Latest was simulated. No real files or P4 server were changed.",
      operationId,
      logReference: operationId,
      affectedPaths: paths,
      counts,
      refreshWorkspace: true,
      refreshDepot: true,
    };
  },
  async getFilePreview(path, options) {
    if (/\.(png|jpe?g|gif|webp)$/i.test(path))
      return {
        kind: "image",
        content:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAAC0CAIAAABqhmJGAAADCElEQVR4nO3TMW0DABTFwMArm6Ao0w5dwiEY8hbnSycdAC9+/L3+gaMeeQEwMzAcZmA4zMBwmIHhMAPDYQaGwwwMhxkYDjMwHGZgOMzAcJiB4TADw2EGhsMMDIcZGA4zMBxmYDjMwHCYgeEwA8NhBobDDAyHGRgOMzAcZmA4zMBwmIHhMAPDYQaGwwwMhxkYDjMwHGZgOMzAcJiB4TADw2FfNPDP7xOuyH8xMOzyXwwMu/wXA8Mu/8XAsMt/MTDs8l8MDLv8FwPDLv/FwLDLfzEw7PJfDAy7/BcDwy7/xcCwy38xMOzyXwwMu/wXA8Mu/8XAsMt/MTDs8l8MDLv8FwPDLv/FwLDLfzEw7PJfDAy7/BcDwy7/xcCwy38xMOzyXwwMu/wXA8Mu/8XAsMt/MTDs8l8MDLv8FwPDLv/FwLDLfzEw7PJfDAy7/BcDwy7/xcCwy38xMOzyXwwMu/wXA8Mu/8XAsMt/MTDs8l8MDLv8FwPDLv/FwLDLfzEw7PJfDAy7/BcDwy7/xcCwy38xMOzyXwwMu/wXA8Mu/8XAsMt/MTDs8l8MDLv8FwPDLv/FwLDLfzEw7PJfDAy7/BcDwy7/xcCwy38xMOzyXwwMu/wXA8Mu/8XAsMt/MTDs8l8MDLv8FwPDLv/FwLDLfzEw7PJfDAy7/BcDwy7/xcCwy38xMOzyXwwMu/wXA8Mu/8XAsMt/MTDs8l8MDLv8FwPDLv/FwLDLfzEw7PJfDAy7/BcDwy7/xcCwy38xMOzyXwwMu/wXA8Mu/8XAsMt/MTDs8l8MDLv8FwPDLv/FwLDLfzEw7PJfDAy7/BcDwy7/xcCwy38xMOzyXwwMu/wXA8Mu/8XAsMt/MTDs8l8MDLv8l68bGPiUgeEwA8NhBobDDAyHGRgOMzAcZmA4zMBwmIHhMAPDYQaGwwwMhxkYDjMwHGZgOMzAcJiB4TADw2EGhsMMDIcZGA4zMBxmYDjMwHCYgeEwA8NhBobDDAyHGRgOMzAcZmA4zMBwmIHhMAPDYQaGwwwMhxkYDnsDW/2Uv/rJ1BkAAAAASUVORK5CYII=",
        size: 833,
        width: 320,
        height: 180,
      };
    if (/\.(csv|tsv)$/i.test(path)) return mockCsvPreview(path);
    if (/\.(xlsx|xlsm)$/i.test(path)) return mockXlsxPreview(options);
    if (
      !/\.(txt|md|ts|tsx|js|jsx|json|cpp|h|rs|py|css|html|xml|yaml|yml|ini|log|svg)$/i.test(
        path,
      )
    )
      throw new Error("Unsupported preview format (demo)");
    const content =
      "# Browser demo / 浏览器演示\n# " +
      path +
      "\n\nThis is simulated file content, not a real local file.\n这是模拟内容，不会读取你电脑上的文件。\n\nexport const quality = 'high';\nconst virtualized = true;\n";
    return {
      kind: "text",
      content,
      size: new TextEncoder().encode(content).length,
      encoding: "UTF-8",
    };
  },
  async getIntegrationTrace(request) {
    if (
      Object.keys(request).some(
        (key) => !["scope", "paths", "refresh", "operationId"].includes(key),
      )
    ) {
      throw new Error("Unknown integration trace request field");
    }
    if (
      !request.paths.length ||
      request.paths.length > 20 ||
      new TextEncoder().encode(request.paths.join("")).length > 16000 ||
      request.paths.some(
        (path) =>
          !path.startsWith("//") ||
          path.length < 5 ||
          path.endsWith("/") ||
          !path.slice(2).includes("/") ||
          /[#@*\u0000-\u001f\u007f-\u009f]/.test(path) ||
          path.includes("..."),
      )
    ) {
      throw new Error(
        "Trace requires 1–20 exact P4-escaped depot paths from CL detail (maximum 16 KB)",
      );
    }
    return {
      records: [],
      incomplete: true,
      warnings: [
        "Simulated mock: no integration evidence configured; destinations unknown",
      ],
      readAt: Date.now(),
    };
  },
  async getDiff(request) {
    const path = request.scope.fileIdentity;
    const label = (reference: typeof request.left) =>
      reference.kind === "revision"
        ? `Revision #${reference.revision}`
        : reference.kind === "shelf"
          ? `Shelf @=${reference.changeId}`
          : reference.kind === "workspace"
            ? "Workspace"
            : reference.kind === "head"
              ? "Head #12"
              : "Have #11";
    return {
      path,
      left: {
        reference: request.left,
        label: label(request.left),
        depotPath: path,
        revision:
          request.left.kind === "workspace" || request.left.kind === "shelf"
            ? undefined
            : request.left.kind === "revision"
              ? request.left.revision
              : 11,
        fileType: "text",
        size: 54,
        digest: "mock-left",
        exists: true,
        binary: false,
      },
      right: {
        reference: request.right,
        label: label(request.right),
        depotPath: request.rightFileIdentity ?? path,
        revision:
          request.right.kind === "workspace" || request.right.kind === "shelf"
            ? undefined
            : request.right.kind === "revision"
              ? request.right.revision
              : 12,
        fileType: "text",
        size: 78,
        digest: "mock-right",
        exists: true,
        binary: false,
      },
      binary: false,
      unsupported: false,
      identical: false,
      truncated: false,
      partial: false,
      stats: { additions: 2, deletions: 1, hunks: 1 },
      operationIds: [request.operationId ?? "mock-diff"],
      leftText: "export const quality = 'high';\nconst cache = false;\n",
      rightText:
        "export const quality = 'high';\nconst cache = true;\nconst virtualized = true;\n",
      unified:
        "@@ -1,2 +1,3 @@\n export const quality = 'high';\n-const cache = false;\n+const cache = true;\n+const virtualized = true;\n",
    };
  },
  async getFileHistory(request) {
    const path = request.scope.fileIdentity;
    return {
      items: Array.from({ length: 12 }, (_, index) => ({
        depotPath: path,
        revision: 12 - index,
        changelistId: 31842 - index * 7,
        user: ["fmeng", "alice", "buildbot"][index % 3],
        action: index === 11 ? "add" : "edit",
        fileType: "text",
        time: new Date(now - index * 86_400_000).toISOString(),
        description: `Update ${path} revision ${12 - index}`,
        digest: `mock-${12 - index}`,
        fileSize: 128 + index,
        integrations:
          index === 3
            ? [
                {
                  relationship: "merge from",
                  kind: "merge",
                  direction: "from",
                  relatedPath: "//depot/dev/demo.txt",
                  startRevision: 1,
                  endRevision: 4,
                },
              ]
            : [],
      })),
      hasMore: false,
      partial: false,
      truncated: false,
      operationIds: [request.operationId ?? "mock-history"],
    };
  },
  async getRevisionGraph(request) {
    const allowed = new Set([
      "scope",
      "revisionLimit",
      "cursor",
      "refresh",
      "operationId",
    ]);
    if (Object.keys(request).some((key) => !allowed.has(key)))
      throw new Error("Invalid revision graph request: unknown field");
    const path = request.scope.fileIdentity;
    const nodes = Array.from({ length: 8 }, (_, index) => ({
      id: `r${index + 1}`,
      depotPath: path,
      revision: index + 1,
      changelistId: 31000 + index * 31,
      action: index === 0 ? "add" : "edit",
      fileType: "text",
      label: `#${index + 1}`,
      x: 90 + index * 120,
      y: index === 4 ? 140 : 70,
      missing: false,
    }));
    return {
      nodes,
      edges: nodes.slice(1).map((node, index) => ({
        id: `e${index}`,
        source: nodes[index].id,
        target: node.id,
        kind: index === 3 ? ("merge" as const) : ("revision" as const),
        relationship: index === 3 ? "merge from" : "revision",
      })),
      hasMore: false,
      partial: false,
      truncated: false,
      operationIds: [request.operationId ?? "mock-graph"],
    };
  },
  async queryPendingChanges(query) {
    const all = structuredClone(allMockPendingChanges());
    const defaultChange = all.find((change) => change.id === 0);
    const keyword = query.keyword.trim().toLocaleLowerCase();
    const fingerprint = encodeURIComponent(
      JSON.stringify([keyword, query.sort, query.pageSize]),
    );
    let offset = 0;
    if (query.cursor) {
      const prefix = `${fingerprint}:`;
      if (!query.cursor.startsWith(prefix))
        throw new Error("pending changelist cursor does not match this query");
      offset = Number(query.cursor.slice(prefix.length));
      if (!Number.isSafeInteger(offset) || offset <= 0)
        throw new Error("invalid pending changelist cursor");
    }
    const items = all
      .filter((change) => change.id > 0)
      .filter(
        (change) =>
          !keyword ||
          String(change.id).includes(keyword) ||
          change.description.toLocaleLowerCase().includes(keyword) ||
          change.jobs.some((job) =>
            job.toLocaleLowerCase().includes(keyword),
          ) ||
          [...change.files, ...change.shelvedFiles].some((file) =>
            file.depotPath.toLocaleLowerCase().includes(keyword),
          ),
      )
      .sort((left, right) =>
        query.sort === "newest" ? right.id - left.id : left.id - right.id,
      );
    const end = Math.min(offset + query.pageSize, items.length);
    return {
      requestGeneration: query.requestGeneration,
      defaultChange: offset === 0 ? defaultChange : undefined,
      items: items.slice(offset, end),
      hasMore: end < items.length,
      nextCursor: end < items.length ? `${fingerprint}:${end}` : undefined,
      partial: false,
      stats: {
        scannedCount: all.length - (defaultChange ? 1 : 0),
        matchedCount: items.length,
        truncatedBySafetyLimit: false,
      },
    };
  },
  async mutatePendingChange(request) {
    const changes = allMockPendingChanges();
    mockPendingChanges ??= changes;
    const operationId = request.operationId ?? crypto.randomUUID();
    const affectedChanges = new Set<number>();
    const affectedPaths: string[] = [];
    let createdChangeId: number | undefined;
    if (request.type === "create" || request.type === "edit") {
      if (!request.description.trim())
        throw new Error("changelist description is required");
      for (const job of request.jobs ?? [])
        if (!job || /\s/.test(job))
          throw new Error("job IDs must be non-empty single-line tokens");
    }
    if (request.type === "create") {
      createdChangeId = Math.max(...changes.map((change) => change.id)) + 1;
      changes.splice(1, 0, {
        id: createdChangeId,
        description: request.description
          .replace(/\r\n?/g, "\n")
          .replace(/\n+$/, ""),
        user: mockContext.user,
        client: mockContext.client,
        status: "pending",
        updatedAt: new Date().toISOString(),
        jobs: [...new Set(request.jobs ?? [])],
        files: [],
        shelvedFiles: [],
      });
      affectedChanges.add(createdChangeId);
    } else if (request.type === "edit") {
      const change = changes.find((item) => item.id === request.changeId);
      if (!change || change.id === 0)
        throw new Error("a numbered pending changelist is required");
      change.description = request.description
        .replace(/\r\n?/g, "\n")
        .replace(/\n+$/, "");
      change.jobs = [...new Set(request.jobs ?? [])];
      change.updatedAt = new Date().toISOString();
      affectedChanges.add(change.id);
    } else if (request.type === "delete") {
      const index = changes.findIndex((item) => item.id === request.changeId);
      if (index < 0 || request.changeId === 0)
        throw new Error("a numbered pending changelist is required");
      if (
        changes[index].files.length ||
        changes[index].shelvedFiles.length ||
        changes[index].jobs.length
      )
        throw new Error(
          "Browser Mock: changelist is not empty; clear Jobs, opened files, and shelves first. No real P4 server was accessed.",
        );
      changes.splice(index, 1);
      affectedChanges.add(request.changeId);
    } else {
      const target = changes.find((item) => item.id === request.targetChangeId);
      if (!target)
        throw new Error("target changelist is outside the current scope");
      for (const path of [...new Set(request.depotPaths)]) {
        const source = changes.find((item) =>
          item.files.some((file) => file.depotPath === path),
        );
        if (!source)
          throw new Error(
            `${path} is not opened by the current user and client`,
          );
        const index = source.files.findIndex((file) => file.depotPath === path);
        const [file] = source.files.splice(index, 1);
        target.files.push(file);
        affectedChanges.add(source.id);
        affectedChanges.add(target.id);
        affectedPaths.push(path);
      }
    }
    const operation = {
      operationId,
      exitCode: 0,
      durationMs: 1,
      events: [
        {
          operationId,
          type: "completed" as const,
          message: "0",
          timestamp: new Date().toISOString(),
        },
      ],
    };
    return {
      operation,
      createdChangeId,
      affectedChanges: [...affectedChanges].sort((a, b) => a - b),
      affectedPaths,
      refreshedChanges: structuredClone(
        changes.filter((change) => affectedChanges.has(change.id)),
      ),
    };
  },
  async preflightSubmit(request) {
    const changes = allMockPendingChanges();
    const change = changes.find((item) => item.id === request.changeId);
    const target: SubmitTargetSnapshot = {
      server: mockContext.server,
      user: mockContext.user,
      client: mockContext.client,
      workspace: mockContext.cwd ?? "",
      changeId: request.changeId,
      contextGeneration: mockContextGeneration,
    };
    const blockers: SubmitPreflight["blockers"] = [];
    const warnings: SubmitPreflight["warnings"] = [];
    if (request.changeId <= 0)
      blockers.push({
        code: "invalidTarget",
        certainty: "confirmed",
        message: "Submit requires a numbered pending changelist.",
      });
    if (!change)
      blockers.push({
        code: "changeNotFound",
        certainty: "confirmed",
        message: "The changelist was not found in the current scope.",
      });
    if (change && !change.description.trim())
      blockers.push({
        code: "emptyDescription",
        certainty: "confirmed",
        message: "The changelist description is empty.",
      });
    if (change && !change.files.length)
      blockers.push({
        code: "emptyChange",
        certainty: "confirmed",
        message: "The changelist contains no opened files.",
      });
    if (change?.shelvedFiles.length)
      warnings.push({
        code: "shelvedFilesPresent",
        certainty: "confirmed",
        message: "The changelist also has shelved files.",
        paths: change.shelvedFiles.map((file) => file.depotPath),
      });
    warnings.push({
      code: "jobPolicyUnknown",
      certainty: "unknown",
      message:
        "Server-side job and trigger policy cannot be predicted in Mock.",
    });
    const depotPaths = change?.files.map((file) => file.depotPath).sort() ?? [];
    const actionCounts = Object.fromEntries(
      [...new Set(change?.files.map((file) => file.action) ?? [])].map(
        (action) => [
          action,
          change?.files.filter((file) => file.action === action).length ?? 0,
        ],
      ),
    );
    const digest = mockDigest(JSON.stringify({ change, target }));
    const ready = blockers.length === 0;
    const token = ready ? crypto.randomUUID() : undefined;
    const expiresAt = Date.now() + 120_000;
    if (token) mockSubmitTokens.set(token, { target, digest, expiresAt });
    return {
      ready,
      change: change ? structuredClone(change) : undefined,
      blockers,
      warnings,
      target,
      fileSummary: {
        fileCount: depotPaths.length,
        depotPaths,
        actionCounts,
        contentDigest: digest,
      },
      token,
      expiresAt,
      ttlMs: 120_000,
      operationIds: [],
      refreshRecommended: !ready,
    };
  },
  async confirmSubmit(confirmation) {
    const record = mockSubmitTokens.get(confirmation.token);
    mockSubmitTokens.delete(confirmation.token);
    const reject = (
      failure: import("../../shared/contracts").SubmitFailureCode,
      message: string,
    ): import("../../shared/contracts").SubmitResult => ({
      outcome: "rejected",
      changeId: confirmation.target.changeId,
      failure,
      message,
      refresh: {
        pendingChanges: true,
        submittedChanges: false,
        workspaceStatus: true,
        depotPaths: [],
        reason: "Run preflight again.",
      },
    });
    if (!record) return reject("tokenUnknown", "Unknown or consumed token.");
    if (record.expiresAt <= Date.now())
      return reject("tokenExpired", "The preflight expired.");
    if (JSON.stringify(record.target) !== JSON.stringify(confirmation.target))
      return reject("targetMismatch", "The confirmation target changed.");
    const currentTarget = {
      server: mockContext.server,
      user: mockContext.user,
      client: mockContext.client,
      workspace: mockContext.cwd ?? "",
      changeId: confirmation.target.changeId,
      contextGeneration: mockContextGeneration,
    };
    if (JSON.stringify(currentTarget) !== JSON.stringify(record.target))
      return reject("contextChanged", "The connection changed.");
    const changes = allMockPendingChanges();
    const index = changes.findIndex(
      (change) => change.id === confirmation.target.changeId,
    );
    const change = changes[index];
    if (
      !change ||
      mockDigest(JSON.stringify({ change, target: record.target })) !==
        record.digest
    )
      return reject("changeChanged", "The changelist changed after preflight.");
    changes.splice(index, 1);
    const operationId = confirmation.operationId ?? crypto.randomUUID();
    const legacyResult: import("../../shared/contracts").SubmitResult = {
      outcome: "submitted",
      changeId: confirmation.target.changeId,
      submittedChangeId: confirmation.target.changeId,
      message: `Browser Mock only: changelist ${confirmation.target.changeId} was simulated as submitted. No real P4 server was accessed.`,
      operationId,
      logReference: operationId,
      refresh: {
        pendingChanges: true,
        submittedChanges: true,
        workspaceStatus: true,
        depotPaths: change.files.map((file) => file.depotPath),
        reason: "Refresh submit-related views.",
      },
    };
    // S4g wire: a dispatched confirmation gets the additive command-level
    // envelope; the authoritative submit facts stay outcome + submittedChangeId.
    if (!confirmation.operationId) return legacyResult;
    return {
      ...legacyResult,
      execution: {
        kind: "submit",
        operationId,
        state: "commandCompleted",
        outcome: "submitted",
        files: [],
      },
    };
  },
  async preflightShelf(request) {
    const change = allMockPendingChanges().find(
      (item) => item.id === request.changeId,
    );
    const paths = [...new Set(request.depotPaths)].sort();
    const opened = new Set(change?.files.map((file) => file.depotPath));
    const shelved = new Set(change?.shelvedFiles.map((file) => file.depotPath));
    const blockers: import("../../shared/contracts").WorkflowIssue[] = [];
    if (!change || request.changeId <= 0)
      blockers.push({
        code: "changeNotFound",
        certainty: "confirmed",
        message: "Numbered changelist not found.",
        paths,
      });
    const missing = paths.filter((path) =>
      request.mode === "delete" ? !shelved.has(path) : !opened.has(path),
    );
    if (missing.length)
      blockers.push({
        code: request.mode === "delete" ? "fileNotShelved" : "fileNotInChange",
        certainty: "confirmed",
        message: "Files are outside the requested shelf scope.",
        paths: missing,
      });
    const replacements = paths.filter((path) => shelved.has(path));
    if (
      request.mode === "createOrUpdate" &&
      replacements.length &&
      !request.replace
    )
      blockers.push({
        code: "existingShelfRequiresReplace",
        certainty: "confirmed",
        message: "Replacing existing shelf revisions requires explicit opt-in.",
        paths: replacements,
      });
    const target: WorkflowTargetSnapshot = {
      kind: "shelf",
      server: mockContext.server,
      user: mockContext.user,
      client: mockContext.client,
      workspace: mockContext.cwd ?? "",
      contextGeneration: mockContextGeneration,
      sourceChangeId: request.changeId,
      depotPaths: paths,
    };
    const digest = mockDigest(JSON.stringify({ change, target, request }));
    const token = blockers.length ? undefined : crypto.randomUUID();
    const expiresAt = Date.now() + 120_000;
    if (token)
      mockWorkflowTokens.set(token, { target, digest, expiresAt, request });
    return {
      ready: !blockers.length,
      change,
      blockers,
      warnings: [],
      target,
      scope: {
        openedPaths: [...opened].sort(),
        existingShelvedPaths: [...shelved].sort(),
        createPaths:
          request.mode === "createOrUpdate"
            ? paths.filter((path) => !shelved.has(path))
            : [],
        replacePaths: request.mode === "createOrUpdate" ? replacements : [],
        deletePaths: request.mode === "delete" ? paths : [],
        contentDigest: digest,
      },
      token,
      expiresAt,
      ttlMs: 120_000,
      operationIds: [],
    };
  },
  async confirmShelf(confirmation) {
    return confirmMockWorkflow(
      confirmation,
      "Browser Mock only: shelf operation was simulated. No real P4 server was accessed.",
      "shelf",
    );
  },
  async deleteShelvedRevisions(request) {
    // Browser Mock simulates the host's direct delete (internal preflight included).
    await new Promise((resolve) => setTimeout(resolve, 5));
    return {
      outcome: "succeeded",
      message:
        "Browser Mock only: shelved revisions were deleted (simulated). No real P4 server was accessed.",
      operationIds: [request.operationId ?? crypto.randomUUID()],
      files: request.depotPaths.map((depotPath: string) => ({
        depotPath,
        state: "succeeded" as const,
        message: "simulated",
      })),
      refresh: {
        pendingChanges: true,
        workspaceStatus: true,
        depotPaths: [...request.depotPaths],
        reason: "mock direct shelf delete",
      },
    };
  },
  async shelveFiles(request) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return {
      outcome: "succeeded",
      message:
        "Browser Mock only: files were shelved (simulated). No real P4 server was accessed.",
      operationIds: [request.operationId ?? crypto.randomUUID()],
      files: request.depotPaths.map((depotPath: string) => ({
        depotPath,
        state: "succeeded" as const,
        message: "simulated",
      })),
      refresh: {
        pendingChanges: true,
        workspaceStatus: true,
        depotPaths: [...request.depotPaths],
        reason: "mock direct shelve",
      },
    };
  },
  async getShelfDetail(request) {
    if (request.changeId <= 0)
      throw mockShelfError(
        "invalidQuery",
        "A numbered shelved changelist is required; Default cannot own a shelf.",
      );
    if (request.pageSize < 1 || request.pageSize > 500)
      throw mockShelfError(
        "invalidQuery",
        "Shelf detail pageSize must be between 1 and 500.",
      );
    const change = allMockPendingChanges().find(
      (item) => item.id === request.changeId,
    );
    if (!change?.shelvedFiles.length) throw new Error("Shelf not found.");
    const all = [...change.shelvedFiles]
      .sort((a, b) => a.depotPath.localeCompare(b.depotPath))
      .map((file) => ({
        depotPath: file.depotPath,
        action: file.action,
        revision: file.revision,
        fileType: file.fileType ?? "text",
        size: file.action === "delete" ? undefined : 128,
        digest:
          file.action === "delete" ? undefined : mockDigest(file.depotPath),
        binary: (file.fileType ?? "").includes("binary"),
        symlink: (file.fileType ?? "").startsWith("symlink"),
        deleted: file.action === "delete",
      }));
    const signature = JSON.stringify({
      changeId: request.changeId,
      pageSize: request.pageSize,
      server: mockContext.server,
      user: mockContext.user,
      client: mockContext.client,
      profile: mockActiveProfileId,
      generation: mockContextGeneration,
    });
    if (request.refresh) mockShelfSnapshots.clear();
    let snapshotId: string;
    let offset = 0;
    let snapshot:
      | {
          signature: string;
          files: MockShelfFile[];
          issued: Map<string, number>;
          createdAt: number;
        }
      | undefined;
    if (request.cursor) {
      const decoded = decodeMockShelfCursor(request.cursor, signature);
      snapshotId = decoded.snapshotId;
      offset = decoded.offset;
      snapshot = mockShelfSnapshots.get(snapshotId);
      if (!snapshot || Date.now() - snapshot.createdAt > 120_000)
        throw mockShelfError(
          "cursorExpired",
          "The shelf cursor expired; refresh from the first page.",
        );
      if (snapshot.issued.get(decoded.cursorId) !== offset)
        throw mockShelfError(
          "invalidCursor",
          "The shelf cursor was not issued by this server, was altered, or has already been used.",
        );
      snapshot.issued.delete(decoded.cursorId);
    } else {
      snapshotId = crypto.randomUUID();
      snapshot = {
        signature,
        files: all,
        issued: new Map(),
        createdAt: Date.now(),
      };
      mockShelfSnapshots.set(snapshotId, snapshot);
    }
    const end = Math.min(offset + request.pageSize, snapshot.files.length);
    const hasMore = end < snapshot.files.length;
    let nextCursor: string | undefined;
    if (hasMore) {
      const cursorId = crypto.randomUUID();
      snapshot.issued.set(cursorId, end);
      nextCursor = encodeMockShelfCursor(snapshotId, cursorId, end, signature);
    }
    return {
      requestGeneration: request.requestGeneration,
      scope: {
        server: mockContext.server,
        user: mockContext.user,
        client: mockContext.client,
        workspace: mockContext.cwd ?? "",
        activeProfileId: mockActiveProfileId,
        contextGeneration: mockContextGeneration,
        changeId: request.changeId,
      },
      description: change.description,
      time: change.updatedAt ?? new Date().toISOString(),
      owner: change.user,
      user: change.user,
      client: change.client,
      jobs: change.jobs,
      files: snapshot.files.slice(offset, end),
      totalFiles: snapshot.files.length,
      hasMore,
      nextCursor,
      truncated: false,
      inspectionStatus: "complete" as const,
      operationIds: [`mock-shelf-detail-${request.changeId}`],
      cacheFreshness: request.refresh
        ? ("fresh" as const)
        : ("cached" as const),
    };
  },
  async getShelfFilePreview(request) {
    const detail = await this.getShelfDetail({
      changeId: request.changeId,
      requestGeneration: 0,
      pageSize: 500,
      refresh: request.refresh,
    });
    const file = detail.files.find(
      (item) => item.depotPath === request.scope.fileIdentity,
    );
    if (!file) throw new Error("Shelved file not found.");
    const unsupported = file.binary || file.symlink || file.deleted;
    return {
      side: {
        reference: { kind: "shelf" as const, changeId: request.changeId },
        label: `Shelf @=${request.changeId}`,
        depotPath: file.depotPath,
        revision: file.revision,
        fileType: file.fileType,
        size: file.size,
        digest: file.digest,
        exists: !file.deleted,
        binary: file.binary,
      },
      content: unsupported
        ? undefined
        : `Browser Mock shelved content for ${file.depotPath}\n`,
      encoding: "UTF-8",
      truncated: false,
      unsupported,
      reason: file.deleted
        ? "Shelved delete has no content."
        : file.binary
          ? "Binary content is metadata-only."
          : file.symlink
            ? "Symlink content is metadata-only."
            : undefined,
      operationIds: [request.operationId ?? "mock-shelf-preview"],
    };
  },
  async preflightMoveFiles(request) {
    const paths = [...new Set(request.depotPaths)].sort();
    const changes = allMockPendingChanges();
    const targetChange = changes.find(
      (change) => change.id === request.targetChangeId,
    );
    const blockers: import("../../shared/contracts").WorkflowIssue[] = [];
    if (!targetChange || request.targetChangeId < 0)
      blockers.push({
        code: "changeNotFound",
        certainty: "confirmed",
        message: "Target changelist was not found.",
        paths,
      });
    const files = paths.map((depotPath) => {
      const source = changes.find((change) =>
        change.files.some((file) => file.depotPath === depotPath),
      );
      const opened = source?.files.find((file) => file.depotPath === depotPath);
      const movable =
        !!opened && source?.id !== request.targetChangeId && !!targetChange;
      if (!movable)
        blockers.push({
          code: "fileNotInChange",
          certainty: "confirmed",
          message: opened
            ? "File is already in the target changelist."
            : "File is not opened in this workspace.",
          paths: [depotPath],
        });
      return {
        depotPath,
        sourceChangeId: source?.id,
        action: opened?.action ?? "",
        movable,
        message: movable ? undefined : blockers.at(-1)?.message,
      };
    });
    const target: WorkflowTargetSnapshot = {
      kind: "move",
      server: mockContext.server,
      user: mockContext.user,
      client: mockContext.client,
      workspace: mockContext.cwd ?? "",
      contextGeneration: mockContextGeneration,
      targetChangeId: request.targetChangeId,
      depotPaths: paths,
    };
    const digest = mockDigest(JSON.stringify({ files, target, targetChange }));
    const token =
      !blockers.length && files.length ? crypto.randomUUID() : undefined;
    const expiresAt = Date.now() + 120_000;
    if (token)
      mockWorkflowTokens.set(token, { target, digest, expiresAt, request });
    return {
      ready: !!token,
      target,
      files,
      blockers,
      warnings: [],
      contentDigest: digest,
      token,
      expiresAt,
      ttlMs: 120_000,
      operationIds: [],
    };
  },
  async confirmMoveFiles(confirmation) {
    const record = mockWorkflowTokens.get(confirmation.token);
    mockWorkflowTokens.delete(confirmation.token);
    const refresh = {
      pendingChanges: true,
      workspaceStatus: true,
      depotPaths: confirmation.target.depotPaths,
      reason: "Refresh affected source and target changelists.",
    };
    if (!record || record.target.kind !== "move")
      return {
        outcome: "rejected" as const,
        failure: "tokenUnknown" as const,
        message: "Unknown or consumed move token.",
        operationIds: [],
        files: [],
        affectedChanges: [],
        refreshedChanges: [],
        refresh,
      };
    if (
      record.expiresAt <= Date.now() ||
      JSON.stringify(record.target) !== JSON.stringify(confirmation.target) ||
      record.target.contextGeneration !== mockContextGeneration
    )
      return {
        outcome: "rejected" as const,
        failure: "contextChanged" as const,
        message: "The move preview expired or its context changed.",
        operationIds: [],
        files: [],
        affectedChanges: [],
        refreshedChanges: [],
        refresh,
      };
    const request =
      record.request as import("../../shared/contracts").MoveFilesPreflightRequest;
    const changes = allMockPendingChanges();
    mockPendingChanges ??= changes;
    const affected = new Set<number>([request.targetChangeId]);
    const target = changes.find(
      (change) => change.id === request.targetChangeId,
    )!;
    const results = request.depotPaths.map((depotPath, index) => {
      const source = changes.find((change) =>
        change.files.some((file) => file.depotPath === depotPath),
      )!;
      const itemIndex = source.files.findIndex(
        (file) => file.depotPath === depotPath,
      );
      const [file] = source.files.splice(itemIndex, 1);
      target.files.push(file);
      affected.add(source.id);
      return {
        depotPath,
        state: "succeeded" as const,
        message: "Browser Mock move completed.",
        operationId: `${confirmation.operationId ?? "mock-move"}:${index + 1}`,
      };
    });
    return {
      outcome: "succeeded" as const,
      message: `Moved ${results.length} file(s).`,
      operationIds: results.map((item) => item.operationId),
      logReference: results[0]?.operationId,
      files: results,
      affectedChanges: [...affected].sort((a, b) => a - b),
      refreshedChanges: changes.filter((change) => affected.has(change.id)),
      refresh,
    };
  },
  async preflightUnshelve(request) {
    const source = allMockPendingChanges().find(
      (item) => item.id === request.sourceChangeId,
    );
    const paths = [...new Set(request.depotPaths)].sort();
    const sourcePaths = new Set(
      source?.shelvedFiles.map((file) => file.depotPath),
    );
    const blockers: import("../../shared/contracts").WorkflowIssue[] = [];
    const missing = paths.filter((path) => !sourcePaths.has(path));
    if (!source || missing.length)
      blockers.push({
        code: "fileNotShelved",
        certainty: "confirmed",
        message: "Source shelf does not contain every selected file.",
        paths: missing.length ? missing : paths,
      });
    const target: WorkflowTargetSnapshot = {
      kind: "unshelve",
      server: mockContext.server,
      user: mockContext.user,
      client: request.targetWorkspace,
      workspace: mockContext.cwd ?? "",
      contextGeneration: mockContextGeneration,
      sourceChangeId: request.sourceChangeId,
      targetChangeId: request.targetChangeId,
      depotPaths: paths,
    };
    const mappings = paths.map((depotPath) => ({
      depotPath,
      targetPath: `${mockContext.cwd ?? "/workspace/atlas"}/${depotPath.split("/").at(-1)}`,
      mapped: true,
      locallyModified: false,
      locked: false,
      resolveRisk: "unknown" as const,
    }));
    const digest = mockDigest(JSON.stringify({ source, target, mappings }));
    const token = blockers.length ? undefined : crypto.randomUUID();
    const expiresAt = Date.now() + 120_000;
    if (token)
      mockWorkflowTokens.set(token, { target, digest, expiresAt, request });
    return {
      ready: !blockers.length,
      source,
      targetChange:
        request.targetChangeId === 0 ? allMockPendingChanges()[0] : undefined,
      mappings,
      blockers,
      warnings: [
        {
          code: "inspectionUnknown",
          certainty: "unknown",
          message: "Browser Mock cannot verify server-side resolve behavior.",
          paths,
        },
      ],
      target,
      contentDigest: digest,
      token,
      expiresAt,
      ttlMs: 120_000,
      operationIds: [],
    };
  },
  async confirmUnshelve(confirmation) {
    return confirmMockWorkflow(
      confirmation,
      "Browser Mock only: unshelve was simulated. No real P4 server was accessed.",
      "unshelve",
    );
  },
  async actionWriteFences() {
    return { connection: null, fences: [] };
  },
  async actionReleaseUnknown() {
    return "released";
  },
  async unshelveFiles(request) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      outcome: "succeeded",
      message: "Browser Mock only: unshelve was simulated.",
      operationIds: [request.operationId ?? "mock-unshelve"],
      files: request.depotPaths.map((depotPath: string) => ({
        depotPath,
        state: "succeeded",
        message: "simulated",
      })),
      refresh: {
        pendingChanges: true,
        workspaceStatus: true,
        depotPaths: request.depotPaths,
        reason: "mock",
      },
    };
  },
  async preflightResolve(request) {
    const paths = [...new Set(request.depotPaths)].sort();
    const target: WorkflowTargetSnapshot = {
      kind: "resolve",
      server: mockContext.server,
      user: mockContext.user,
      client: mockContext.client,
      workspace: mockContext.cwd ?? "",
      contextGeneration: mockContextGeneration,
      depotPaths: paths,
    };
    const conflicts = paths.map((depotPath) => ({
      depotPath,
      conflictType: "unknown" as const,
      status: "unknown" as const,
      availableStrategies: ["mergePreview" as const],
      sources: [],
      preview: ["Browser Mock cannot inspect a real integration record."],
    }));
    return {
      ready: false,
      conflicts,
      blockers: [
        {
          code: "inspectionUnknown",
          certainty: "unknown",
          message: "Resolve remains blocked when conflict facts are unknown.",
          paths,
        },
      ],
      warnings: [],
      target,
      contentDigest: mockDigest(JSON.stringify({ target, conflicts })),
      expiresAt: Date.now() + 120_000,
      ttlMs: 120_000,
      operationIds: [],
    };
  },
  async confirmResolve(confirmation) {
    return confirmMockWorkflow(
      confirmation,
      "Browser Mock only: resolve was simulated. No real P4 server was accessed.",
      "resolve",
    );
  },
  async resolveStats() {
    // Browser Mock has no P4 metadata: the dialog keeps its "not returned" placeholders.
    return { base: {}, source: {}, target: {} };
  },
  async openManualMerge() {
    throw new Error(
      "Browser Mock cannot open a manual merge session because it has no authoritative Perforce resolve record.",
    );
  },
  async validateManualMerge() {
    throw new Error("Browser Mock does not persist manual merge content.");
  },
  async confirmManualMergeSave() {
    throw new Error("Browser Mock does not write workspace files.");
  },
  async confirmManualMergeResolve() {
    throw new Error("Browser Mock does not resolve Perforce records.");
  },
  async detectExternalMergeTool() {
    return {
      available: false,
      reason:
        "Browser Mock has no native process adapter, so it cannot detect or launch P4Merge.",
    };
  },
  async runExternalMerge() {
    throw new Error(
      "Browser Mock cannot launch P4Merge; no external process was started and no result was simulated.",
    );
  },
};

async function confirmMockWorkflow(
  confirmation: import("../../shared/contracts").WorkflowConfirmation,
  message: string,
  kind: "shelf" | "unshelve" | "resolve",
): Promise<import("../../shared/contracts").WorkflowResult> {
  const record = mockWorkflowTokens.get(confirmation.token);
  mockWorkflowTokens.delete(confirmation.token);
  const reject = (
    failure: import("../../shared/contracts").WorkflowFailureCode,
    reason: string,
  ): import("../../shared/contracts").WorkflowResult => ({
    outcome: "rejected",
    failure,
    message: reason,
    operationIds: [],
    files: [],
    refresh: {
      pendingChanges: true,
      workspaceStatus: true,
      depotPaths: confirmation.target.depotPaths,
      reason: "Run preflight again.",
    },
  });
  if (!record) return reject("tokenUnknown", "Unknown or consumed token.");
  if (record.expiresAt <= Date.now())
    return reject("tokenExpired", "The preflight expired.");
  if (JSON.stringify(record.target) !== JSON.stringify(confirmation.target))
    return reject("targetMismatch", "The confirmation target changed.");
  if (
    record.target.server !== mockContext.server ||
    record.target.user !== mockContext.user ||
    record.target.contextGeneration !== mockContextGeneration ||
    (kind !== "unshelve" && record.target.client !== mockContext.client)
  )
    return reject("contextChanged", "The connection or workspace changed.");
  const changes = allMockPendingChanges();
  mockPendingChanges ??= changes;
  if (kind === "shelf") {
    const request =
      record.request as import("../../shared/contracts").ShelfPreflightRequest;
    const change = changes.find((item) => item.id === request.changeId);
    const currentDigest = mockDigest(
      JSON.stringify({ change, target: record.target, request }),
    );
    if (!change || currentDigest !== record.digest)
      return reject(
        "contentChanged",
        "The changelist or shelf changed after preflight.",
      );
    if (request.mode === "delete") {
      const selected = new Set(request.depotPaths);
      change.shelvedFiles = change.shelvedFiles.filter(
        (file) => !selected.has(file.depotPath),
      );
    } else {
      for (const depotPath of request.depotPaths) {
        const opened = change.files.find(
          (file) => file.depotPath === depotPath,
        )!;
        const next = { ...opened, revision: opened.revision ?? 1 };
        const index = change.shelvedFiles.findIndex(
          (file) => file.depotPath === depotPath,
        );
        if (index >= 0) change.shelvedFiles[index] = next;
        else change.shelvedFiles.push(next);
      }
    }
  } else if (kind === "unshelve") {
    const request =
      record.request as import("../../shared/contracts").UnshelvePreflightRequest;
    const source = changes.find((item) => item.id === request.sourceChangeId);
    const mappings = request.depotPaths.map((depotPath) => ({
      depotPath,
      targetPath: `${mockContext.cwd ?? "/workspace/atlas"}/${depotPath.split("/").at(-1)}`,
      mapped: true,
      locallyModified: false,
      locked: false,
      resolveRisk: "unknown" as const,
    }));
    const currentDigest = mockDigest(
      JSON.stringify({ source, target: record.target, mappings }),
    );
    if (!source || currentDigest !== record.digest)
      return reject(
        "contentChanged",
        "The source shelf or target changed after preflight.",
      );
    const target = changes.find((item) => item.id === request.targetChangeId);
    if (!target)
      return reject(
        "contentChanged",
        "The target changelist changed after preflight.",
      );
    for (const depotPath of request.depotPaths)
      if (!target.files.some((file) => file.depotPath === depotPath))
        target.files.push({ depotPath, action: "edit", state: "openedEdit" });
  }
  const operationId = confirmation.operationId ?? crypto.randomUUID();
  const legacyResult: import("../../shared/contracts").WorkflowResult = {
    outcome: "succeeded",
    message,
    operationIds: [operationId],
    logReference: operationId,
    files: confirmation.target.depotPaths.map((depotPath) => ({
      depotPath,
      state: "succeeded",
      message,
      operationId,
    })),
    refresh: {
      pendingChanges: true,
      workspaceStatus: true,
      depotPaths: confirmation.target.depotPaths,
      reason: "Refresh affected views.",
    },
  };
  // S4d wire: a dispatched confirmation carries one operationId and gets the
  // additive command-level envelope. SHELF/UNSHELVE claim no per-file success,
  // so the top-level files stay empty and the UI may only show intent/progress.
  if (kind === "resolve" || !confirmation.operationId) return legacyResult;
  return {
    ...legacyResult,
    execution: {
      kind,
      operationId,
      state: "commandCompleted",
      outcome: legacyResult.outcome,
      files: [],
    },
    files: [],
  };
}

function mockDigest(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `mock-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
