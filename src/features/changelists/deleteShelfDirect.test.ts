import { beforeEach, expect, it, vi } from "vitest";
import {
  startDeleteShelfDirect,
  type DeleteShelfIntent,
} from "./deleteShelfTask";
import { removalLedger } from "../actions/actionStore";
import type {
  RuntimeInfo,
  ShelfDeleteDirectRequest,
  WorkflowResult,
} from "../../shared/contracts";
const invalidateData = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../shared/cache/dataEffects", () => ({ invalidateData }));
beforeEach(() => invalidateData.mockClear());
let serial = 0;
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
function fixture() {
  const intent: DeleteShelfIntent = {
    connectionKey: `direct${++serial}`,
    changeId: 10,
    paths: ["//synthetic/a"],
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
  const deps = {
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
  };
  return { intent, report, lookup, deps };
}
const success = (paths: string[]): WorkflowResult => ({
  outcome: "succeeded",
  message: "Deleted",
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
it("removes the rows optimistically before dispatch and calls the host exactly once", async () => {
  const f = fixture();
  let resolve!: (result: WorkflowResult) => void;
  const execute = vi.fn(
    (_request: ShelfDeleteDirectRequest) =>
      new Promise<WorkflowResult>((done) => (resolve = done)),
  );
  expect(startDeleteShelfDirect(f.intent, { ...f.deps, execute })).toBe(true);
  // Optimistic hide exists before any host round trip.
  expect(
    removalLedger
      .getSnapshot()
      .some(
        (record) =>
          record.scope === f.intent.connectionKey &&
          record.data.items.some(
            (item) =>
              item.path === "//synthetic/a" && item.outcome === "pending",
          ),
      ),
  ).toBe(true);
  expect(execute).not.toHaveBeenCalled();
  await flush();
  expect(execute).toHaveBeenCalledOnce();
  const request = execute.mock.calls[0][0] as {
    operationId: string;
    changeId: number;
    depotPaths: string[];
  };
  expect(request.changeId).toBe(10);
  expect(request.depotPaths).toEqual(["//synthetic/a"]);
  expect(request.operationId).toMatch(/^[0-9a-f-]{36}$/);
  resolve(success(["//synthetic/a"]));
  await flush();
  expect(invalidateData).toHaveBeenCalledOnce();
  expect(f.report).not.toHaveBeenCalled();
});
it("failure restores the row (unknown outcome visible), reports once and never invalidates", async () => {
  const f = fixture();
  const execute = vi
    .fn<(request: ShelfDeleteDirectRequest) => Promise<WorkflowResult>>()
    .mockRejectedValue(Error("host unavailable"));
  expect(startDeleteShelfDirect(f.intent, { ...f.deps, execute })).toBe(true);
  await flush();
  expect(execute).toHaveBeenCalledOnce();
  expect(f.report).toHaveBeenCalled();
  expect(invalidateData).not.toHaveBeenCalled();
  const record = removalLedger
    .getSnapshot()
    .find((item) => item.scope === f.intent.connectionKey);
  expect(record?.data.items[0]?.outcome).not.toBe("pending");
  expect(record?.data.items[0]?.outcome).not.toBe("confirmed");
});
it("unknown result uses one same-operationId lookup and never re-dispatches", async () => {
  const f = fixture();
  const execute = vi
    .fn<(request: ShelfDeleteDirectRequest) => Promise<WorkflowResult>>()
    .mockResolvedValue({
      ...success(["//synthetic/a"]),
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
        kind: "shelf",
        connection: request.connection,
        state: "settled",
        result: success(["//synthetic/a"]),
        revision: "1",
        payloadDigest: "a".repeat(64),
      },
    }),
  );
  expect(startDeleteShelfDirect(f.intent, { ...f.deps, execute })).toBe(true);
  await flush();
  expect(execute).toHaveBeenCalledOnce();
  expect(f.lookup).toHaveBeenCalledOnce();
  expect(f.lookup.mock.calls[0][0].operationId).toBe(
    execute.mock.calls[0][0].operationId,
  );
  expect(invalidateData).toHaveBeenCalledOnce();
});
