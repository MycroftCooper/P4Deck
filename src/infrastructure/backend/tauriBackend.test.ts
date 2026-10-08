import { beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { tauriBackend } from "./tauriBackend";

beforeEach(() => invoke.mockReset());

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
    kinds: ["workspaceFile" as const, "job" as const],
    pageSize: 25,
    cursor: "opaque-global-cursor",
  };
  invoke.mockResolvedValue({ groups: [], hasMore: false, simulated: false });
  await tauriBackend.globalSearch(query);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("global_search", { query });
});
