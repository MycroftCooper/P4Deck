import { beforeEach, expect, it, vi } from "vitest";
import {
  startDeleteShelfDirect,
  type DeleteShelfIntent,
} from "./deleteShelfTask";
import { removalLedger } from "../actions/actionStore";
import { blockedPathDetails } from "./moveOptimism";
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
        // Host `delete_shelved_revisions` reserves the receipt as `shelfDelete`.
        kind: "shelfDelete",
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

it("commandCompleted direct delete confirms items and releases admission", async () => {
  const f = fixture();
  const execute = vi
    .fn<(request: ShelfDeleteDirectRequest) => Promise<WorkflowResult>>()
    .mockImplementation(async (request) => ({
      ...success(["//synthetic/a"]),
      files: [],
      execution: {
        kind: "shelf",
        operationId: request.operationId!,
        state: "commandCompleted",
        outcome: "succeeded",
        files: [],
      },
    }));
  expect(startDeleteShelfDirect(f.intent, { ...f.deps, execute })).toBe(true);
  await flush();
  expect(invalidateData).toHaveBeenCalledOnce();
  const record = removalLedger
    .getSnapshot()
    .find((item) => item.scope === f.intent.connectionKey)!;
  expect(record.data.items.map((item) => item.outcome)).toEqual(["confirmed"]);
  expect(record.data.execution?.admissionReleased).toBe(true);
  expect(blockedPathDetails(f.intent.connectionKey).size).toBe(0);
});

const rejection = (
  outcome: "failed" | "rejected",
  failure: "preflightBlocked" | "contentChanged",
): WorkflowResult => ({
  outcome,
  failure,
  message: "nothing was deleted",
  operationIds: [],
  files: [],
  refresh: {
    pendingChanges: true,
    workspaceStatus: true,
    depotPaths: [],
    reason: "rejected before dispatch; nothing deleted",
  },
});

it.each([
  ["failed", "preflightBlocked"],
  ["rejected", "contentChanged"],
] as const)(
  "host %s deterministic rejection is a known not-applied: released and never blocking",
  async (outcome, failure) => {
    const f = fixture();
    const execute = vi
      .fn<(request: ShelfDeleteDirectRequest) => Promise<WorkflowResult>>()
      .mockResolvedValue(rejection(outcome, failure));
    expect(startDeleteShelfDirect(f.intent, { ...f.deps, execute })).toBe(true);
    await flush();
    expect(execute).toHaveBeenCalledOnce();
    expect(f.report).toHaveBeenCalledOnce();
    expect(invalidateData).not.toHaveBeenCalled();
    // A deterministic rejection is not "unknown": no same-id recovery lookup runs.
    expect(f.lookup).not.toHaveBeenCalled();
    const record = removalLedger
      .getSnapshot()
      .find((item) => item.scope === f.intent.connectionKey)!;
    expect(
      record.data.items.map((item) => [item.outcome, item.ioComplete]),
    ).toEqual([["notApplied", true]]);
    expect(record.data.execution?.admissionReleased).toBe(true);
    expect(record.phase).toBe("settled");
    expect(blockedPathDetails(f.intent.connectionKey).size).toBe(0);
  },
);

it("genuinely unknown delete keeps the claim and blocks submission", async () => {
  const f = fixture();
  const execute = vi
    .fn<(request: ShelfDeleteDirectRequest) => Promise<WorkflowResult>>()
    .mockResolvedValue({
      outcome: "unknown",
      message: "outcome unknown",
      operationIds: [],
      files: [],
      refresh: {
        pendingChanges: true,
        workspaceStatus: true,
        depotPaths: [],
        reason: "unknown",
      },
    });
  expect(startDeleteShelfDirect(f.intent, { ...f.deps, execute })).toBe(true);
  await flush();
  const record = removalLedger
    .getSnapshot()
    .find((item) => item.scope === f.intent.connectionKey)!;
  expect(record.data.items.map((item) => item.outcome)).toEqual(["unknown"]);
  expect(record.data.execution?.admissionReleased).toBeUndefined();
  expect(blockedPathDetails(f.intent.connectionKey).size).toBe(1);
});

it("a command envelope from another operation is never accepted as success", async () => {
  const f = fixture();
  const execute = vi
    .fn<(request: ShelfDeleteDirectRequest) => Promise<WorkflowResult>>()
    .mockImplementation(async (request) => ({
      ...success(["//synthetic/a"]),
      files: [],
      execution: {
        kind: "shelf",
        operationId: `${request.operationId}-stale`,
        state: "commandCompleted",
        outcome: "succeeded",
        files: [],
      },
    }));
  expect(startDeleteShelfDirect(f.intent, { ...f.deps, execute })).toBe(true);
  await flush();
  expect(invalidateData).not.toHaveBeenCalled();
  expect(f.report).toHaveBeenCalledOnce();
  const record = removalLedger
    .getSnapshot()
    .find((item) => item.scope === f.intent.connectionKey)!;
  expect(record.data.items.map((item) => item.outcome)).not.toContain(
    "confirmed",
  );
  expect(record.data.execution?.admissionReleased).toBeUndefined();
});
