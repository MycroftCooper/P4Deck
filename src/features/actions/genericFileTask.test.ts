import { expect, it, vi } from "vitest";
import {
  startGenericFileAction,
  genericP4Actions,
  isGenericP4Write,
  type GenericFilePort,
} from "./genericFileTask";
import { fileActionLedger } from "./actionStore";
import { blockedMovePaths } from "../changelists/moveOptimism";
import { resourcesOverlap } from "./resourceOverlap";
import type {
  RuntimeInfo,
  FileActionRequest,
  FileActionResult,
} from "../../shared/contracts";
let serial = 0;
const flush = () => new Promise((r) => setTimeout(r, 0));
function fixture() {
  const scope = `generic-${++serial}`;
  const runtime = {
    mode: "mock",
    contextGeneration: 1,
    context: { server: "s", user: "u", client: scope },
  } as RuntimeInfo;
  const connection = {
    profileId: "p",
    generation: "18446744073709551615",
    server: "s",
    user: "u",
    client: scope,
  };
  const port: GenericFilePort = {
    connection: vi.fn(async () => connection),
    execute: vi.fn(
      async (request: FileActionRequest): Promise<FileActionResult> => ({
        message: "",
        affectedPaths: [...request.paths],
        execution: {
          operationId: request.operationId!,
          outcome: "commandCompleted",
          perFileEvidence: "notCollected",
        },
      }),
    ),
    lookup: vi.fn(async () => ({ kind: "notFound" as const })),
    report: vi.fn(),
    invalidate: vi.fn(async () => {}),
  };
  return { scope, runtime, connection, port };
}
it.each(genericP4Actions)(
  "%s uses the shared execution lifecycle without per-file success",
  async (action) => {
    const f = fixture(),
      operationId = crypto.randomUUID();
    const request: FileActionRequest = {
      action,
      paths: ["//fixture/a"],
      states: ["controlled"],
      operationId,
    };
    expect(
      startGenericFileAction(
        f.scope,
        f.runtime,
        request,
        [],
        () => true,
        f.port,
      ),
    ).toBe(true);
    expect(fileActionLedger.get(operationId)?.data).toMatchObject({
      busy: true,
      outcome: "pending",
    });
    await flush();
    expect(f.port.execute).toHaveBeenCalledExactlyOnceWith(
      request,
      f.connection,
    );
    expect(fileActionLedger.get(operationId)?.data.outcome).toBe(
      "commandCompleted",
    );
    expect(fileActionLedger.get(operationId)?.data).not.toHaveProperty("files");
    expect(f.port.invalidate).toHaveBeenCalledOnce();
    expect(f.port.report).not.toHaveBeenCalled();
  },
);
it("resolved unknown and legacy receipts are not successful completion", async () => {
  const f = fixture();
  vi.mocked(f.port.execute).mockResolvedValue({
    affectedPaths: ["//fixture/a"],
    message: "ok",
  });
  startGenericFileAction(
    f.scope,
    f.runtime,
    { action: "add", paths: ["//fixture/a"] },
    [],
    () => true,
    f.port,
  );
  await flush();
  expect(blockedMovePaths(f.scope).has("//fixture/a")).toBe(true);
  expect(f.port.report).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ outcome: "unknown" }),
  );
  expect(f.port.execute).toHaveBeenCalledOnce();
});
it("deferred recursive action blocks overlapping resources but not siblings", async () => {
  const f = fixture();
  vi.mocked(f.port.execute).mockReturnValue(
    new Promise<FileActionResult>(() => {}),
  );
  startGenericFileAction(
    f.scope,
    f.runtime,
    { action: "addRecursive", paths: ["C:/fixture/dir/..."] },
    [],
    () => true,
    f.port,
  );
  expect(
    startGenericFileAction(
      f.scope,
      f.runtime,
      { action: "add", paths: ["c:/fixture/dir/a"] },
      [],
      () => true,
      f.port,
    ),
  ).toBe(false);
  expect(
    startGenericFileAction(
      f.scope,
      f.runtime,
      { action: "add", paths: ["C:/fixture/other"] },
      [],
      () => true,
      f.port,
    ),
  ).toBe(true);
  expect(resourcesOverlap("//depot/dir/...", "//depot/directory/a")).toBe(
    false,
  );
});
it("transport loss queries exact identity once, no business replay", async () => {
  const f = fixture();
  vi.mocked(f.port.execute).mockRejectedValue(Error("lost"));
  startGenericFileAction(
    f.scope,
    f.runtime,
    { action: "checkout", paths: ["//fixture/a"] },
    [],
    () => true,
    f.port,
  );
  await flush();
  expect(f.port.lookup).toHaveBeenCalledExactlyOnceWith({
    operationId: vi.mocked(f.port.execute).mock.calls[0][0].operationId,
    connection: f.connection,
  });
  expect(f.port.execute).toHaveBeenCalledOnce();
});
it("late connection invalidates only old scoped cache without active fetch", async () => {
  const f = fixture();
  let current = true,
    finish!: (r: FileActionResult) => void;
  vi.mocked(f.port.execute).mockReturnValue(new Promise((r) => (finish = r)));
  startGenericFileAction(
    f.scope,
    f.runtime,
    { action: "checkout", paths: ["//fixture/a"] },
    [],
    () => current,
    f.port,
  );
  await flush();
  current = false;
  const operationId = vi.mocked(f.port.execute).mock.calls[0][0].operationId!;
  finish({
    message: "",
    affectedPaths: [],
    execution: {
      operationId,
      outcome: "commandCompleted",
      perFileEvidence: "notCollected",
    },
  });
  await flush();
  expect(f.port.invalidate).toHaveBeenCalledExactlyOnceWith(
    f.scope,
    f.runtime,
    ["//fixture/a"],
    false,
  );
});
it("untracked or unproven Delete is not rerouted from local trash into P4 lifecycle", () => {
  expect(
    isGenericP4Write({ action: "delete", paths: ["a"], states: ["untracked"] }),
  ).toBe(false);
  expect(isGenericP4Write({ action: "delete", paths: ["a"] })).toBe(false);
  expect(isGenericP4Write({ action: "deleteLocal", paths: ["a"] })).toBe(false);
});

it("destination is included in conflicts before copy execution completes", () => {
  const f = fixture();
  vi.mocked(f.port.execute).mockReturnValue(new Promise(() => {}));
  startGenericFileAction(
    f.scope,
    f.runtime,
    {
      action: "copy",
      paths: ["//fixture/source"],
      targetPath: "//fixture/destination",
    },
    [],
    () => true,
    f.port,
  );
  expect(blockedMovePaths(f.scope).has("//fixture/destination")).toBe(true);
  expect(
    startGenericFileAction(
      f.scope,
      f.runtime,
      { action: "checkout", paths: ["//fixture/destination"] },
      [],
      () => true,
      f.port,
    ),
  ).toBe(false);
});

it("host pre-dispatch rejection with no receipt becomes notDispatched and releases the claim", async () => {
  const f = fixture();
  const operationId = crypto.randomUUID();
  // The host reserves the receipt BEFORE any write; notFound proves the write
  // path was never reached, so this is a known no-op rather than unknown.
  vi.mocked(f.port.execute).mockRejectedValue(Error("invalidConnection"));
  expect(
    startGenericFileAction(
      f.scope,
      f.runtime,
      { action: "checkout", paths: ["//fixture/a"], operationId },
      [],
      () => true,
      f.port,
    ),
  ).toBe(true);
  await flush();
  expect(f.port.execute).toHaveBeenCalledOnce();
  expect(f.port.lookup).toHaveBeenCalledExactlyOnceWith({
    operationId,
    connection: f.connection,
  });
  expect(fileActionLedger.get(operationId)?.data.outcome).toBe("notDispatched");
  expect(fileActionLedger.get(operationId)?.data.admissionReleased).toBe(true);
  expect(blockedMovePaths(f.scope).size).toBe(0);
  expect(f.port.invalidate).not.toHaveBeenCalled();
  expect(f.port.report).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ outcome: "failed", code: "preflightBlocked" }),
  );
});

it("unrecognized transport failure without a receipt stays unknown and keeps the claim", async () => {
  const f = fixture();
  const operationId = crypto.randomUUID();
  vi.mocked(f.port.execute).mockRejectedValue(Error("lost"));
  startGenericFileAction(
    f.scope,
    f.runtime,
    { action: "checkout", paths: ["//fixture/a"], operationId },
    [],
    () => true,
    f.port,
  );
  await flush();
  expect(fileActionLedger.get(operationId)?.data.outcome).toBe("unknown");
  expect(fileActionLedger.get(operationId)?.data.admissionReleased).toBeFalsy();
  expect(blockedMovePaths(f.scope).has("//fixture/a")).toBe(true);
  expect(f.port.invalidate).toHaveBeenCalledOnce();
  expect(f.port.report).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ outcome: "unknown", code: "uncertainOutcome" }),
  );
});

it("settled receipt wins over a pre-dispatch-looking failure", async () => {
  const f = fixture();
  const operationId = crypto.randomUUID();
  vi.mocked(f.port.execute).mockRejectedValue(
    Error("contextChanged: The active connection changed."),
  );
  vi.mocked(f.port.lookup).mockImplementation(async () => ({
    kind: "found" as const,
    receipt: {
      operationId,
      kind: "fileAction" as const,
      connection: f.connection,
      payloadDigest: "ab".repeat(32),
      revision: "5",
      state: "settled" as const,
      result: {
        message: "",
        affectedPaths: ["//fixture/a"],
        execution: {
          operationId,
          outcome: "commandCompleted" as const,
          perFileEvidence: "notCollected" as const,
        },
      },
    },
  }));
  startGenericFileAction(
    f.scope,
    f.runtime,
    { action: "checkout", paths: ["//fixture/a"], operationId },
    [],
    () => true,
    f.port,
  );
  await flush();
  expect(fileActionLedger.get(operationId)?.data.outcome).toBe(
    "commandCompleted",
  );
  expect(blockedMovePaths(f.scope).size).toBe(0);
  expect(f.port.invalidate).toHaveBeenCalledOnce();
  expect(f.port.report).not.toHaveBeenCalled();
});
