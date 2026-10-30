import { expect, it, vi } from "vitest";
import { startRevert, revertTargets, type RevertPort } from "./revertTask";
import { writeSnapshot, readSnapshot } from "../../shared/cache/snapshots";
import {
  pendingSnapshotKey,
  type PendingSnapshot,
} from "../changelists/pendingCache";
import { projectRemovalChanges, shelfObservation } from "./shelfObservation";
import { blockedMovePaths } from "../changelists/moveOptimism";
import type {
  RuntimeInfo,
  WorkspaceNode,
  WorkflowResult,
} from "../../shared/contracts";
let serial = 0;
const flush = () => new Promise((r) => setTimeout(r, 0));
function fixture() {
  const scope = `revert-${++serial}`;
  const runtime = {
    mode: "mock",
    contextGeneration: 1,
    context: { server: "s", user: "u", client: scope },
  } as RuntimeInfo;
  const nodes = ["a", "b"].map((name) => ({
    id: name,
    name,
    kind: "file",
    state: "openedEdit",
    depotPath: `//fixture/${name}`,
    absolutePath: `C:/fixture/${name}`,
    relativePath: name,
    changelistId: 11,
  })) as WorkspaceNode[];
  const snapshot = {
    changes: [
      {
        id: 11,
        description: "fixture",
        user: "u",
        client: scope,
        status: "pending",
        jobs: [],
        files: nodes.map((n) => ({ depotPath: n.depotPath!, action: "edit" })),
        shelvedFiles: [],
      },
    ],
    partial: false,
    stats: { scannedCount: 1, matchedCount: 1, truncatedBySafetyLimit: false },
  } as PendingSnapshot;
  const key = pendingSnapshotKey(runtime);
  writeSnapshot(key, snapshot);
  const connection = {
    profileId: "p",
    generation: "18446744073709551615",
    server: "s",
    user: "u",
    client: scope,
  };
  const result = {
    outcome: "succeeded",
    files: nodes.map((n) => ({
      depotPath: n.depotPath!,
      state: "succeeded",
      message: "",
    })),
    refresh: {
      pendingChanges: false,
      workspaceStatus: false,
      depotPaths: [],
      reason: "",
    },
    message: "",
    operationIds: [],
  } as WorkflowResult;
  const port: RevertPort = {
    connection: vi.fn(async () => connection),
    execute: vi.fn(async () => result),
    lookup: vi.fn(async () => ({ kind: "notFound" as const })),
    report: vi.fn(),
  };
  return { scope, runtime, nodes, snapshot, key, connection, result, port };
}
it("projects immediately, retains I/O conflict, then merges precise success without refresh", async () => {
  const f = fixture();
  let finish!: (r: WorkflowResult) => void;
  vi.mocked(f.port.execute).mockReturnValue(new Promise((r) => (finish = r)));
  expect(
    startRevert(f.scope, f.runtime, f.nodes, "revert", () => true, 11, f.port),
  ).toBe(true);
  expect(
    projectRemovalChanges(
      "revert",
      f.snapshot.changes,
      f.scope,
      shelfObservation(f.runtime).version,
    )[0].files,
  ).toHaveLength(0);
  expect(blockedMovePaths(f.scope).size).toBe(2);
  await flush();
  expect(f.port.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      paths: ["//fixture/a", "//fixture/b"],
      revertWholeChangelist: true,
    }),
    f.connection,
  );
  finish(f.result);
  await flush();
  expect(
    readSnapshot<PendingSnapshot>(f.key)!.data.changes[0].files,
  ).toHaveLength(0);
  expect(blockedMovePaths(f.scope).size).toBe(0);
});
it("unknown mixed facts restore unknown and keep its conflict without replay", async () => {
  const f = fixture();
  f.result.outcome = "partial";
  f.result.files[1].state = "unknown";
  startRevert(
    f.scope,
    f.runtime,
    f.nodes,
    "revert",
    () => true,
    undefined,
    f.port,
  );
  await flush();
  expect(
    readSnapshot<PendingSnapshot>(f.key)!.data.changes[0].files.map(
      (x) => x.depotPath,
    ),
  ).toEqual(["//fixture/b"]);
  expect(blockedMovePaths(f.scope)).toEqual(new Set(["//fixture/b"]));
  expect(f.port.execute).toHaveBeenCalledOnce();
});
it("connection drift before dispatch releases only local admission with zero writes", async () => {
  const f = fixture();
  let current = true;
  startRevert(
    f.scope,
    f.runtime,
    f.nodes,
    "revert",
    () => current,
    undefined,
    f.port,
  );
  current = false;
  await flush();
  expect(f.port.execute).not.toHaveBeenCalled();
  expect(blockedMovePaths(f.scope).size).toBe(0);
  expect(
    readSnapshot<PendingSnapshot>(f.key)!.data.changes[0].files,
  ).toHaveLength(2);
});
it("lost response looks up once with exact original ID and does not retry", async () => {
  const f = fixture();
  vi.mocked(f.port.execute).mockRejectedValue(Error("lost"));
  startRevert(
    f.scope,
    f.runtime,
    f.nodes,
    "revert",
    () => true,
    undefined,
    f.port,
  );
  await flush();
  expect(f.port.lookup).toHaveBeenCalledExactlyOnceWith({
    operationId: vi.mocked(f.port.execute).mock.calls[0][0].operationId,
    connection: f.connection,
  });
  expect(f.port.execute).toHaveBeenCalledOnce();
  expect(blockedMovePaths(f.scope).size).toBe(2);
});
it("late success cannot remove newer cache observation", async () => {
  const f = fixture();
  let finish!: (r: WorkflowResult) => void;
  vi.mocked(f.port.execute).mockReturnValue(new Promise((r) => (finish = r)));
  startRevert(
    f.scope,
    f.runtime,
    f.nodes,
    "revert",
    () => true,
    undefined,
    f.port,
  );
  await flush();
  writeSnapshot(f.key, { ...f.snapshot });
  finish(f.result);
  await flush();
  expect(
    readSnapshot<PendingSnapshot>(f.key)!.data.changes[0].files,
  ).toHaveLength(2);
});
it("directory range freezes only observed exact paths and rejects incomplete mapping", () => {
  const f = fixture();
  const folder = {
    ...f.nodes[0],
    kind: "directory" as const,
    depotPath: "//fixture",
  };
  expect(revertTargets([folder], f.snapshot).map((n) => n.depotPath)).toEqual([
    "//fixture/a",
    "//fixture/b",
  ]);
  expect(() =>
    revertTargets([folder], { ...f.snapshot, partial: true }),
  ).toThrow();
  expect(() =>
    revertTargets([{ ...f.nodes[0], depotPath: "//fixture/..." }], f.snapshot),
  ).toThrow();
});
it("retained revertUnchanged keeps the file row and releases only its own claim without restored success", async () => {
  const f = fixture();
  let finish!: (r: WorkflowResult) => void;
  vi.mocked(f.port.execute).mockReturnValue(new Promise((r) => (finish = r)));
  expect(
    startRevert(
      f.scope,
      f.runtime,
      f.nodes,
      "revertUnchanged",
      () => true,
      11,
      f.port,
    ),
  ).toBe(true);
  await flush();
  expect(f.port.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "revertUnchanged",
      paths: ["//fixture/a", "//fixture/b"],
    }),
    f.connection,
  );
  // In flight: both rows are optimistically hidden and claimed.
  expect(
    projectRemovalChanges(
      "revert",
      f.snapshot.changes,
      f.scope,
      shelfObservation(f.runtime).version,
    )[0].files,
  ).toHaveLength(0);
  expect(blockedMovePaths(f.scope).size).toBe(2);
  f.result.files[0].state = "retained";
  finish(f.result);
  await flush();
  // Retained row comes back as still-open; the reverted row is merged away; no lock remains.
  expect(
    readSnapshot<PendingSnapshot>(f.key)!.data.changes[0].files.map(
      (x) => x.depotPath,
    ),
  ).toEqual(["//fixture/a"]);
  expect(blockedMovePaths(f.scope).size).toBe(0);
  expect(f.port.report).not.toHaveBeenCalled();
  expect(f.port.execute).toHaveBeenCalledOnce();
});
it("all-retained revertUnchanged is a known no-op, never a restored success or retry", async () => {
  const f = fixture();
  f.result.files.forEach((file) => (file.state = "retained"));
  startRevert(
    f.scope,
    f.runtime,
    f.nodes,
    "revertUnchanged",
    () => true,
    11,
    f.port,
  );
  await flush();
  expect(
    readSnapshot<PendingSnapshot>(f.key)!.data.changes[0].files,
  ).toHaveLength(2);
  expect(blockedMovePaths(f.scope).size).toBe(0);
  expect(f.port.report).not.toHaveBeenCalled();
  expect(f.port.execute).toHaveBeenCalledOnce();
});
it("retained outside revertUnchanged is not trusted and stays unknown and occupied", async () => {
  const f = fixture();
  f.result.outcome = "partial";
  f.result.files[0].state = "retained";
  startRevert(
    f.scope,
    f.runtime,
    f.nodes,
    "revert",
    () => true,
    undefined,
    f.port,
  );
  await flush();
  expect(
    readSnapshot<PendingSnapshot>(f.key)!.data.changes[0].files.map(
      (x) => x.depotPath,
    ),
  ).toEqual(["//fixture/a"]);
  expect(blockedMovePaths(f.scope)).toEqual(new Set(["//fixture/a"]));
  expect(f.port.report).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: "partial" }),
  );
});
it("settled receipt with retained facts is reused after transport loss without reexecution", async () => {
  const f = fixture();
  vi.mocked(f.port.execute).mockRejectedValue(Error("lost"));
  f.result.files[0].state = "retained";
  vi.mocked(f.port.lookup).mockImplementation(async ({ operationId }) => ({
    kind: "found" as const,
    receipt: {
      operationId,
      kind: "revert" as const,
      connection: f.connection,
      payloadDigest: "ab".repeat(32),
      revision: "7",
      state: "settled" as const,
      result: f.result,
    },
  }));
  startRevert(
    f.scope,
    f.runtime,
    f.nodes,
    "revertUnchanged",
    () => true,
    11,
    f.port,
  );
  await flush();
  expect(f.port.lookup).toHaveBeenCalledOnce();
  expect(f.port.execute).toHaveBeenCalledOnce();
  expect(
    readSnapshot<PendingSnapshot>(f.key)!.data.changes[0].files.map(
      (x) => x.depotPath,
    ),
  ).toEqual(["//fixture/a"]);
  expect(blockedMovePaths(f.scope).size).toBe(0);
});
it("retained no-op never clears older unrelated unknown claims", async () => {
  const f = fixture();
  const unknownResult = {
    ...f.result,
    outcome: "unknown",
    files: [{ depotPath: "//fixture/a", state: "unknown", message: "" }],
  } as WorkflowResult;
  const retainedResult = {
    ...f.result,
    outcome: "succeeded",
    files: [{ depotPath: "//fixture/b", state: "retained", message: "" }],
  } as WorkflowResult;
  vi.mocked(f.port.execute)
    .mockResolvedValueOnce(unknownResult)
    .mockResolvedValueOnce(retainedResult);
  startRevert(
    f.scope,
    f.runtime,
    [f.nodes[0]],
    "revert",
    () => true,
    undefined,
    f.port,
  );
  await flush();
  expect(blockedMovePaths(f.scope)).toEqual(new Set(["//fixture/a"]));
  startRevert(
    f.scope,
    f.runtime,
    [f.nodes[1]],
    "revertUnchanged",
    () => true,
    undefined,
    f.port,
  );
  await flush();
  expect(blockedMovePaths(f.scope)).toEqual(new Set(["//fixture/a"]));
  expect(
    readSnapshot<PendingSnapshot>(f.key)!.data.changes[0].files.map(
      (x) => x.depotPath,
    ),
  ).toEqual(["//fixture/a", "//fixture/b"]);
});
