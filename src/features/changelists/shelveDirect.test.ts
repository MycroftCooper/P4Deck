import { beforeEach, expect, it, vi } from "vitest";
import { startShelveDirect, type ShelveDirectIntent } from "./shelveDirectTask";
import type {
  RuntimeInfo,
  ShelveDirectRequest,
  WorkflowResult,
} from "../../shared/contracts";
const invalidateData = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../shared/cache/dataEffects", () => ({ invalidateData }));
beforeEach(() => invalidateData.mockClear());
let serial = 0;
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
function fixture() {
  const intent: ShelveDirectIntent = {
    connectionKey: `shelve${++serial}`,
    changeId: 10,
    paths: ["//synthetic/b", "//synthetic/a"],
    server: "s",
    user: "u",
    client: "c",
    workspace: "C:/fixture",
    generation: 2,
  };
  const runtime = {
    context: { server: "s", user: "u", client: "c", cwd: "C:/fixture" },
    contextGeneration: 2,
  } as RuntimeInfo;
  const report = vi.fn();
  const lookup = vi.fn();
  return {
    intent,
    report,
    lookup,
    deps: {
      current: () => ({ connectionKey: intent.connectionKey, runtime }),
      connection: async () => ({
        profileId: "p",
        generation: "2",
        server: "s",
        user: "u",
        client: "c",
      }),
      lookup,
      report,
    },
  };
}
const success = (paths: string[]): WorkflowResult => ({
  outcome: "succeeded",
  message: "Shelved",
  operationIds: ["op"],
  files: paths.map((depotPath) => ({
    depotPath,
    state: "succeeded" as const,
    message: "",
  })),
  refresh: {
    pendingChanges: true,
    workspaceStatus: true,
    depotPaths: paths,
    reason: "ok",
  },
});
it("calls shelveFiles exactly once with one operationId and does one active invalidation", async () => {
  const f = fixture();
  const execute = vi.fn((_request: ShelveDirectRequest) =>
    Promise.resolve(success(f.intent.paths)),
  );
  expect(startShelveDirect(f.intent, { ...f.deps, execute })).toBe(true);
  await flush();
  expect(execute).toHaveBeenCalledOnce();
  const request = execute.mock.calls[0][0];
  expect(request.changeId).toBe(10);
  expect(request.depotPaths).toEqual(["//synthetic/a", "//synthetic/b"]);
  expect(request.replace).toBe(false);
  expect(request.operationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(invalidateData).toHaveBeenCalledOnce();
  expect(f.report).not.toHaveBeenCalled();
});
it("failure reports once, never invalidates and never fakes shelf success", async () => {
  const f = fixture();
  const execute = vi
    .fn<(request: ShelveDirectRequest) => Promise<WorkflowResult>>()
    .mockResolvedValue({
      ...success(f.intent.paths),
      outcome: "rejected",
      files: [],
    });
  expect(startShelveDirect(f.intent, { ...f.deps, execute })).toBe(true);
  await flush();
  expect(execute).toHaveBeenCalledOnce();
  expect(f.report).toHaveBeenCalledOnce();
  expect(invalidateData).not.toHaveBeenCalled();
});
it("unknown result uses one same-operationId lookup and never re-dispatches", async () => {
  const f = fixture();
  const execute = vi
    .fn<(request: ShelveDirectRequest) => Promise<WorkflowResult>>()
    .mockResolvedValue({
      ...success(f.intent.paths),
      outcome: "unknown",
      files: [],
      execution: {
        kind: "shelf",
        operationId: "any",
        state: "unknown",
        outcome: "unknown",
        files: [],
      },
    });
  f.lookup.mockImplementation(
    async (request: { operationId: string; connection: unknown }) => ({
      kind: "found",
      receipt: {
        operationId: request.operationId,
        // Host `shelve_files` reserves the receipt as `shelve` (not `shelf`).
        kind: "shelve",
        connection: request.connection,
        state: "settled",
        result: success(f.intent.paths),
        revision: "1",
        payloadDigest: "a".repeat(64),
      },
    }),
  );
  expect(startShelveDirect(f.intent, { ...f.deps, execute })).toBe(true);
  await flush();
  expect(execute).toHaveBeenCalledOnce();
  expect(f.lookup).toHaveBeenCalledOnce();
  expect(f.lookup.mock.calls[0][0].operationId).toBe(
    execute.mock.calls[0][0].operationId,
  );
  expect(invalidateData).toHaveBeenCalledOnce();
});
