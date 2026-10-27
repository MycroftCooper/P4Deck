import { beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { tauriBackend } from "./tauriBackend";

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
});

it("uses fixed native log commands and subscribes to log deletion across windows", async () => {
  await tauriBackend.openLogsFolder();
  expect(invoke).toHaveBeenLastCalledWith("open_logs_folder");
  await tauriBackend.deleteAllLogs();
  expect(invoke).toHaveBeenLastCalledWith("delete_all_logs");
  const callback = vi.fn();
  await tauriBackend.subscribeLogsCleared(callback);
  expect(listen).toHaveBeenLastCalledWith("logs-cleared", callback);
});

it("routes cancel-all to the runner instead of a particular task", async () => {
  await tauriBackend.cancelAllOperations();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("cancel_all_operations");
});

it("routes configuration backup commands through narrow native commands", async () => {
  const create = {
    localStorage: [{ key: "p4deck.ui", value: '{"compact":true}' }],
  };
  invoke.mockResolvedValue({ backup: { fileName: "safe.json" } });
  await tauriBackend.createConfigBackup(create);
  expect(invoke).toHaveBeenLastCalledWith("create_config_backup", {
    request: create,
  });
  await tauriBackend.listConfigBackups();
  expect(invoke).toHaveBeenLastCalledWith("list_config_backups");
  const restore = { fileName: "safe.json", localStorage: create.localStorage };
  await tauriBackend.restoreConfigBackup(restore);
  expect(invoke).toHaveBeenLastCalledWith("restore_config_backup", {
    request: restore,
  });
  await tauriBackend.openConfigBackupsFolder();
  expect(invoke).toHaveBeenLastCalledWith("open_config_backups_folder");
});

it("passes profile activation and workspace switch requests unchanged", async () => {
  invoke.mockResolvedValue({ profiles: [] });
  await tauriBackend.listConnectionProfiles();
  expect(invoke).toHaveBeenLastCalledWith("list_connection_profiles");
  await tauriBackend.getActiveConnectionProfile();
  expect(invoke).toHaveBeenLastCalledWith("get_active_connection_profile");
  const create = {
    expectedRevision: 4,
    name: "Work",
    context: { server: "p4:1666", user: "alice", client: "main" },
  };
  await tauriBackend.createConnectionProfile(create);
  expect(invoke).toHaveBeenLastCalledWith("create_connection_profile", {
    request: create,
  });
  const update = { ...create, expectedRevision: 5, id: "profile-id" };
  await tauriBackend.updateConnectionProfile(update);
  expect(invoke).toHaveBeenLastCalledWith("update_connection_profile", {
    request: update,
  });
  const remove = { expectedRevision: 6, id: "old-profile" };
  await tauriBackend.deleteConnectionProfile(remove);
  expect(invoke).toHaveBeenLastCalledWith("delete_connection_profile", {
    request: remove,
  });
  const activate = { expectedRevision: 5, id: "profile-id" };
  await tauriBackend.setActiveConnectionProfile(activate);
  expect(invoke).toHaveBeenLastCalledWith("set_active_connection_profile", {
    request: activate,
  });
  const workspace = { expectedGeneration: 9, client: "other-client" };
  await tauriBackend.switchWorkspace(workspace);
  expect(invoke).toHaveBeenLastCalledWith("switch_workspace", {
    request: workspace,
  });
});

it("passes draft-scoped connection browse and guarded create requests unchanged", async () => {
  const context = {
    server: "ssl:p4.example:1666",
    user: "new-user",
    client: "",
    cwd: "C:/work",
  };
  const directory = {
    context,
    requestGeneration: 7,
    operationId: "directory-7",
    prefix: "new",
  };
  invoke.mockResolvedValue({ items: [] });
  await tauriBackend.browseConnectionUsers(directory);
  expect(invoke).toHaveBeenLastCalledWith("browse_connection_users", {
    request: directory,
  });
  await tauriBackend.browseConnectionWorkspaces(directory);
  expect(invoke).toHaveBeenLastCalledWith("browse_connection_workspaces", {
    request: directory,
  });

  const userRequest = {
    context,
    requestGeneration: 7,
    operationId: "user-preflight-7",
    plan: {
      name: "new-user",
      fullName: "New User",
      email: "new-user@example.invalid",
    },
  };
  await tauriBackend.preflightCreateConnectionUser(userRequest);
  expect(invoke).toHaveBeenLastCalledWith("preflight_create_connection_user", {
    request: userRequest,
  });
  const workspaceRequest = {
    context,
    requestGeneration: 7,
    operationId: "workspace-preflight-7",
    plan: {
      name: "new-workspace",
      root: "C:/work/new-workspace",
      mapping: { kind: "stream" as const, stream: "//depot/main" },
      syncMode: "standard" as const,
    },
  };
  await tauriBackend.preflightCreateConnectionWorkspace(workspaceRequest);
  expect(invoke).toHaveBeenLastCalledWith(
    "preflight_create_connection_workspace",
    { request: workspaceRequest },
  );

  const confirmation = {
    token: "one-use-token",
    context,
    requestGeneration: 7,
    stateDigest: "connection-state-7",
    confirmed: true,
  };
  await tauriBackend.confirmCreateConnectionUser(confirmation);
  expect(invoke).toHaveBeenLastCalledWith("confirm_create_connection_user", {
    confirmation,
  });
  await tauriBackend.confirmCreateConnectionWorkspace(confirmation);
  expect(invoke).toHaveBeenLastCalledWith(
    "confirm_create_connection_workspace",
    { confirmation },
  );
});

it("passes only the narrow submitted-detail request through the Tauri adapter", async () => {
  const request = { changeId: 42, operationId: "detail-42" };
  invoke.mockResolvedValue({ changeId: 42 });
  await tauriBackend.getSubmittedChangeDetail(request);
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    "get_submitted_change_detail",
    { request },
  );
  expect(JSON.stringify(invoke.mock.calls[0])).not.toContain('"files"');
});

it("passes a generation-bound Swarm request through the narrow opener command", async () => {
  const request = {
    url: "https://swarm.example/changes/42",
    expectedProfileId: "profile-a",
    expectedContextGeneration: 9,
  };
  invoke.mockResolvedValue(undefined);
  await tauriBackend.openSwarmLink(request);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("open_swarm_link", {
    request,
  });
});

it("passes typed sync preview and confirmation requests through narrow commands", async () => {
  const request = {
    paths: ["//depot/main/..."],
    revision: { kind: "change" as const, value: "42" },
    force: false,
    operationId: "sync-preview-42",
  };
  invoke.mockResolvedValue({ ready: true });
  await tauriBackend.previewSync(request);
  expect(invoke).toHaveBeenLastCalledWith("preview_sync", { request });
  const confirmation = {
    token: "one-use-token",
    target: {
      server: "server:1666",
      user: "alice",
      client: "main",
      workspace: "C:/work",
      contextGeneration: 7,
      paths: request.paths,
      revision: request.revision,
      force: false,
    },
    acknowledgeForce: false,
    operationId: "sync-42",
  };
  await tauriBackend.confirmSync(confirmation);
  expect(invoke).toHaveBeenLastCalledWith("confirm_sync", { confirmation });
});

it("passes a generation-bound P4VFS inspection request through its narrow command", async () => {
  const request = {
    expectedContextGeneration: 7,
    operationId: "vfs-inspect-7",
  };
  invoke.mockResolvedValue({ mode: "virtual", ready: true });
  await tauriBackend.inspectP4Vfs(request);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("inspect_p4vfs", {
    request,
  });
});

it("passes immutable stream-switch preflight and confirmation payloads unchanged", async () => {
  const request = {
    targetStream: "//depot/开发 stream",
    mode: "viewOnly" as const,
    operationId: "stream-preview-42",
  };
  invoke.mockResolvedValue({ ready: true });
  await tauriBackend.preflightStreamSwitch(request);
  expect(invoke).toHaveBeenLastCalledWith("preflight_stream_switch", {
    request,
  });
  const confirmation = {
    token: "one-use-stream-token",
    target: {
      server: "server:1666",
      user: "alice",
      client: "main",
      workspace: "C:/work",
      activeProfileId: "profile-1",
      contextGeneration: 7,
      currentStream: "//depot/main",
      targetStream: request.targetStream,
      targetType: "development",
      targetParent: "//depot/main",
      mode: request.mode,
      clientSpecDigest: "client-digest",
      streamSpecDigest: "stream-digest",
      riskDigest: "risk-digest",
    },
    previewDigest: "preview-digest",
    acknowledgeWarnings: true,
    operationId: "stream-switch-42",
  };
  await tauriBackend.confirmStreamSwitch(confirmation);
  expect(invoke).toHaveBeenLastCalledWith("confirm_stream_switch", {
    confirmation,
  });
});

it("passes the generation-bound Stream Graph query through unchanged", async () => {
  const query = {
    operationId: "stream-graph-42",
    requestGeneration: 5,
    depotPrefix: "//depot/项目",
    text: "release 流",
    includeDeleted: true,
    pageSize: 50,
    cursor: "opaque-one-use-stream-cursor",
    refresh: true,
  };
  invoke.mockResolvedValue({ nodes: [], edges: [], simulated: false });
  await tauriBackend.queryStreamGraph(query);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("query_stream_graph", {
    query,
  });
});

it("passes narrow Branch Mapping list, detail, preview, preflight and confirmation payloads unchanged", async () => {
  const query = {
    operationId: "branch-list-42",
    requestGeneration: 8,
    nameFilter: "release 映射",
    owner: "alice",
    pageSize: 25,
    cursor: "opaque-one-use-branch-cursor",
  };
  invoke.mockResolvedValue({ items: [], simulated: false });
  await tauriBackend.queryBranchMappings(query);
  expect(invoke).toHaveBeenLastCalledWith("query_branch_mappings", { query });

  const detail = {
    operationId: "branch-detail-42",
    requestGeneration: 8,
    name: "release-map",
  };
  await tauriBackend.getBranchMappingDetail(detail);
  expect(invoke).toHaveBeenLastCalledWith("get_branch_mapping_detail", {
    query: detail,
  });

  const preview = {
    ...detail,
    direction: "reverse" as const,
    limit: 100,
  };
  await tauriBackend.previewBranchMappingImpact(preview);
  expect(invoke).toHaveBeenLastCalledWith("preview_branch_mapping_impact", {
    query: preview,
  });

  const request = {
    mode: "delete" as const,
    name: "release-map",
    operationId: "branch-preflight-42",
  };
  await tauriBackend.preflightBranchMappingMutation(request);
  expect(invoke).toHaveBeenLastCalledWith("preflight_branch_mapping_mutation", {
    request,
  });

  const confirmation = {
    token: "one-use-token",
    target: {
      activeProfileId: "profile-1",
      contextGeneration: 8,
      server: "ssl:1666",
      user: "alice",
      client: "main",
      mode: "delete" as const,
      name: "release-map",
      currentExists: true,
      currentDigest: "current-digest",
    },
    previewDigest: "preview-digest",
    acknowledgeDangerousDelete: true,
    operationId: "branch-confirm-42",
  };
  await tauriBackend.confirmBranchMappingMutation(confirmation);
  expect(invoke).toHaveBeenLastCalledWith("confirm_branch_mapping_mutation", {
    confirmation,
  });
});

it("passes the typed submitted query and opaque cursor through unchanged", async () => {
  const query = {
    operationId: "submitted-query-42",
    requestGeneration: 9,
    keyword: "修复",
    users: ["alice"],
    clients: ["unicode-client"],
    depotPath: "//depot/项目/...",
    stream: "//depot/项目",
    from: "2026-10-01T00:00:00+08:00",
    to: "2026-10-09T23:59:59+08:00",
    jobs: ["JOB-42"],
    hasJob: true,
    mergeClassifications: ["unknown" as const, "suspectedMerge" as const],
    hideReliableMerges: true,
    pageSize: 50,
    cursor: "opaque-v1-cursor",
  };
  invoke.mockResolvedValue({ items: [], hasMore: false });
  await tauriBackend.queryChangelists(query);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("query_changelists", {
    query,
  });
});

it("passes the narrow global search query through unchanged", async () => {
  const query = {
    operationId: "global-search-42",
    requestGeneration: 12,
    text: "你好 [asset]",
    kinds: [
      "workspaceFile" as const,
      "job" as const,
      "stream" as const,
      "shelf" as const,
    ],
    pageSize: 25,
    cursor: "opaque-global-cursor",
  };
  invoke.mockResolvedValue({ groups: [], hasMore: false, simulated: false });
  await tauriBackend.globalSearch(query);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("global_search", { query });
});

it("passes diagnostic filters unchanged and listens to the narrow alert event", async () => {
  const query = {
    state: "failed" as const,
    category: "submit" as const,
    from: "2026-10-01T00:00:00Z",
    to: "2026-10-09T00:00:00Z",
    keyword: "op-safe",
    cursor: "opaque-journal-cursor",
    limit: 50,
  };
  invoke.mockResolvedValue({ records: [] });
  await tauriBackend.queryOperationJournal(query);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("query_operation_journal", {
    query,
  });
  const callback = vi.fn();
  listen.mockResolvedValue(() => undefined);
  await tauriBackend.subscribeDiagnosticAlerts(callback);
  expect(listen).toHaveBeenCalledWith("diagnostic-alert", expect.any(Function));
  const handler = listen.mock.calls[0][1];
  handler({ payload: { operationId: "op-safe", level: "error" } });
  expect(callback).toHaveBeenCalledWith({
    operationId: "op-safe",
    level: "error",
  });
});

it("routes single-revision Undo preview and confirmation through dedicated commands", async () => {
  const request = {
    depotPath: "//depot/f.txt",
    revision: 17,
    changelistId: 901,
  };
  invoke.mockResolvedValue({});
  await tauriBackend.previewUndo(request);
  expect(invoke).toHaveBeenLastCalledWith("preview_undo", { request });
  const confirmation = { target: request, token: "reviewed" };
  await tauriBackend.confirmUndo(confirmation);
  expect(invoke).toHaveBeenLastCalledWith("confirm_undo", { confirmation });
});
