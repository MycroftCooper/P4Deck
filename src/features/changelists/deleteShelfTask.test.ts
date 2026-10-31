import { beforeEach, expect, it, vi } from "vitest";
import { startDeleteShelf, type DeleteShelfIntent } from "./deleteShelfTask";
import { removalLedger } from "../actions/actionStore";
import { blockedMovePaths, blockedPathDetails } from "./moveOptimism";
import type {
  RuntimeInfo,
  ShelfPreflight,
  WorkflowResult,
} from "../../shared/contracts";
const invalidateData = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../shared/cache/dataEffects", () => ({ invalidateData }));
beforeEach(() => invalidateData.mockClear());
vi.mock("./workflowRefresh", () => ({
  publishWorkflowResult: vi.fn().mockResolvedValue(undefined),
  publishWorkflowFailure: vi.fn().mockResolvedValue(undefined),
}));
let serial = 0;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture() {
  const intent: DeleteShelfIntent = {
    connectionKey: `scope${++serial}`,
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
  const preflight = {
    ready: true,
    token: "t",
    expiresAt: Date.now() + 60000,
    ttlMs: 60000,
    operationIds: [],
    warnings: [],
    scope: {
      openedPaths: [],
      existingShelvedPaths: ["//synthetic/a"],
      createPaths: [],
      replacePaths: [],
      deletePaths: ["//synthetic/a"],
      contentDigest: "synthetic",
    },
    blockers: [],
    target: {
      kind: "shelf",
      server: "s",
      user: "u",
      client: "c",
      workspace: "C:/fixture",
      contextGeneration: 2,
      sourceChangeId: 10,
      depotPaths: ["//synthetic/a"],
    },
  } as ShelfPreflight;
  const result = {
    outcome: "succeeded",
    message: "done",
    files: [{ depotPath: "//synthetic/a", state: "succeeded" }],
    operationIds: ["actual-id"],
    logReference: "log",
    refresh: { pendingChanges: true },
  } as WorkflowResult;
  const deps = {
    current: () => ({ connectionKey: intent.connectionKey, runtime }),
    report: vi.fn(),
    check: vi.fn().mockResolvedValue(preflight),
    execute: vi.fn().mockResolvedValue(result),
  };
  return { intent, preflight, result, deps, runtime };
}
it("registers once while preflight is deferred and preserves immutable file scope", async () => {
  const f = fixture();
  let finish!: (p: ShelfPreflight) => void;
  f.deps.check.mockImplementation(
    () => new Promise((resolve) => (finish = resolve)),
  );
  expect(startDeleteShelf(f.intent, f.deps)).toBe(true);
  expect(startDeleteShelf(f.intent, f.deps)).toBe(false);
  f.intent.paths.push("//synthetic/not-selected");
  await flush();
  expect(f.deps.execute).not.toHaveBeenCalled();
  finish(f.preflight);
  await flush();
  expect(f.deps.execute).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      token: "t",
      target: f.preflight.target,
      operationId: expect.any(String),
    }),
  );
});
it.each(["scope", "identity", "expired", "blocked"])(
  "%s mismatch stops before mutation",
  async (kind) => {
    const f = fixture();
    if (kind === "scope") f.preflight.target.depotPaths = ["//synthetic/other"];
    if (kind === "identity") f.preflight.target.contextGeneration = 3;
    if (kind === "expired") f.preflight.expiresAt = 0;
    if (kind === "blocked") f.preflight.ready = false;
    startDeleteShelf(f.intent, f.deps);
    await flush();
    expect(f.deps.execute).not.toHaveBeenCalled();
    expect(f.deps.report).toHaveBeenCalledOnce();
  },
);
it("connection drift during preflight cannot execute on the new connection", async () => {
  const f = fixture();
  let finish!: (p: ShelfPreflight) => void;
  f.deps.check.mockImplementation(
    () => new Promise((resolve) => (finish = resolve)),
  );
  startDeleteShelf(f.intent, f.deps);
  await flush();
  f.runtime.contextGeneration = 3;
  finish(f.preflight);
  await flush();
  expect(f.deps.execute).not.toHaveBeenCalled();
  expect(f.deps.report).toHaveBeenCalledOnce();
});
it("transport unknown keeps registration and reports without write retry", async () => {
  const f = fixture();
  f.deps.execute.mockRejectedValue(Error("lost receipt"));
  startDeleteShelf(f.intent, f.deps);
  await flush();
  expect(f.deps.execute).toHaveBeenCalledOnce();
  expect(f.deps.report).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: "unknown", phase: "execute" }),
  );
  expect(startDeleteShelf(f.intent, f.deps)).toBe(false);
});
it("partial unknown reports exact returned state and operation identity", async () => {
  const f = fixture();
  f.result.outcome = "failed";
  f.result.files[0].state = "unknown";
  startDeleteShelf(f.intent, f.deps);
  await flush();
  expect(f.deps.report).toHaveBeenCalledWith(
    expect.objectContaining({
      operationId: expect.any(String),
      action: "shelfDelete",
    }),
  );
  expect(f.deps.report).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: "unknown" }),
  );
  expect(startDeleteShelf(f.intent, f.deps)).toBe(false);
});

it("lost response performs one durable lookup with original identity and never reexecutes", async () => {
  const f = fixture();
  const connection = {
    profileId: "p",
    generation: "18446744073709551615",
    server: "s",
    user: "u",
    client: "c",
  };
  f.deps.execute.mockRejectedValue(Error("lost"));
  const lookup = vi.fn(
    async (request: {
      operationId: string;
      connection: typeof connection;
    }) => ({
      kind: "found" as const,
      receipt: {
        ...request,
        // Host `delete_shelved_revisions` reserves the receipt as `shelfDelete`.
        kind: "shelfDelete" as const,
        payloadDigest: "a".repeat(64),
        revision: "2",
        state: "settled" as const,
        result: f.result,
      },
    }),
  );
  startDeleteShelf(f.intent, {
    ...f.deps,
    connection: async () => connection,
    lookup,
  });
  await flush();
  expect(f.deps.execute).toHaveBeenCalledOnce();
  expect(lookup).toHaveBeenCalledExactlyOnceWith({
    operationId: f.deps.execute.mock.calls[0][0].operationId,
    connection,
  });
});

it("commandCompleted delete stays command-level, refreshes once and releases admission", async () => {
  const f = fixture();
  f.deps.execute.mockImplementation(
    async (request: { operationId: string }) => ({
      ...f.result,
      outcome: "succeeded",
      files: [],
      execution: {
        kind: "shelf" as const,
        operationId: request.operationId,
        state: "commandCompleted" as const,
        outcome: "succeeded" as const,
        files: [],
      },
    }),
  );
  startDeleteShelf(f.intent, f.deps);
  await flush();
  await flush();
  const operationId = f.deps.execute.mock.calls[0][0].operationId as string;
  expect(f.deps.report).not.toHaveBeenCalled();
  expect(invalidateData).toHaveBeenCalledOnce();
  expect(invalidateData.mock.calls[0][1]).toMatchObject({
    connectionKey: f.intent.connectionKey,
    refetchType: "active",
    affectedPaths: ["//synthetic/a"],
  });
  const record = removalLedger
    .getSnapshot()
    .find((item) => item.operationId === operationId)!;
  expect(record.data.execution?.admissionReleased).toBe(true);
  // A command-level success is authoritative: no per-file fact is needed.
  expect(record.data.items.every((item) => item.outcome === "confirmed")).toBe(
    true,
  );
  expect(blockedMovePaths(f.intent.connectionKey).size).toBe(0);
  expect(blockedPathDetails(f.intent.connectionKey).size).toBe(0);
});

it("dialog delete host rejection settles as known not-applied and never blocks", async () => {
  const f = fixture();
  f.deps.execute.mockResolvedValue({
    outcome: "failed",
    failure: "preflightBlocked",
    message: "Shelved delete preflight is not ready; nothing was deleted.",
    operationIds: [],
    files: [],
    refresh: { pendingChanges: true },
  } as unknown as WorkflowResult);
  startDeleteShelf(f.intent, f.deps);
  await flush();
  await flush();
  const operationId = f.deps.execute.mock.calls[0][0].operationId as string;
  expect(f.deps.report).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: "failed", code: "operationFailed" }),
  );
  const record = removalLedger
    .getSnapshot()
    .find((item) => item.operationId === operationId)!;
  expect(
    record.data.items.map((item) => [item.outcome, item.ioComplete]),
  ).toEqual([["notApplied", true]]);
  expect(record.data.execution?.admissionReleased).toBe(true);
  expect(blockedPathDetails(f.intent.connectionKey).size).toBe(0);
});

it("dialog delete never trusts a command envelope from another operation", async () => {
  const f = fixture();
  f.deps.execute.mockResolvedValue({
    ...f.result,
    outcome: "succeeded",
    files: [],
    execution: {
      kind: "shelf",
      operationId: "another-operation",
      state: "commandCompleted",
      outcome: "succeeded",
      files: [],
    },
  });
  startDeleteShelf(f.intent, f.deps);
  await flush();
  await flush();
  // The dialog path always refreshes once; the envelope mismatch only means the
  // result is never accepted as command-level success.
  expect(f.deps.report).toHaveBeenCalledOnce();
  const operationId = f.deps.execute.mock.calls[0][0].operationId as string;
  const record = removalLedger
    .getSnapshot()
    .find((item) => item.operationId === operationId)!;
  expect(record.data.items.every((item) => item.outcome !== "confirmed")).toBe(
    true,
  );
  expect(record.data.execution?.admissionReleased).toBeUndefined();
});
