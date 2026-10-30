import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import {
  localDeleteBlockedPaths,
  localDeleteHiddenPathsForTests,
  localDeleteSnapshot,
  resetLocalDeleteForTests,
  startLocalDelete,
  type LocalDeletePort,
} from "./localDeleteTask";
import type { FileActionResult, RuntimeInfo } from "../../shared/contracts";

const flush = () => new Promise((r) => setTimeout(r, 0));
let serial = 0;
function fixture(result?: FileActionResult, opts?: { reject?: boolean }) {
  resetLocalDeleteForTests();
  const scope = `local-${++serial}`;
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
  const files = (["C:/fixture/a", "C:/fixture/b", "C:/fixture/c"] as const).map(
    (path) => ({ path }),
  );
  const port: LocalDeletePort = {
    connection: vi.fn(async () => connection),
    execute: opts?.reject
      ? vi.fn(async () => {
          throw Error("lost");
        })
      : vi.fn(async () => result!),
    cancel: vi.fn(async () => {}),
  };
  const build = (
    outcome: "commandCompleted" | "unknown" | "notDispatched",
    rows: { path: string; state: "succeeded" | "blocked" | "unknown" }[],
    operationId: string,
  ) =>
    ({
      operation: null,
      affectedPaths: files.map((f) => f.path),
      message: "Local batch finished; inspect per-file acknowledgements",
      execution: {
        operationId,
        outcome,
        perFileEvidence: "localIoAcknowledgements",
        files: rows.map((row) => ({
          depotPath: row.path,
          state: row.state,
          message: "",
        })),
      },
    }) as unknown as FileActionResult;
  return { scope, runtime, connection, files, port, build };
}
it("succeeded rows only: hide retired, claims released, one dispatch, affectedPaths not evidence", async () => {
  const f = fixture();
  let finish!: (r: FileActionResult) => void;
  vi.mocked(f.port.execute).mockReturnValue(new Promise((r) => (finish = r)));
  expect(
    startLocalDelete(
      f.scope,
      f.runtime,
      f.files.map((x) => x.path),
      () => true,
      f.port,
    ),
  ).toBe(true);
  expect(localDeleteHiddenPathsForTests(f.scope)).toEqual(
    new Set(["C:/fixture/a", "C:/fixture/b", "C:/fixture/c"]),
  );
  expect(localDeleteBlockedPaths(f.scope).size).toBe(3);
  await flush();
  const operationId = localDeleteSnapshot()[0].operationId;
  expect(f.port.execute).toHaveBeenCalledExactlyOnceWith(
    {
      action: "deleteLocal",
      paths: ["C:/fixture/a", "C:/fixture/b", "C:/fixture/c"],
      operationId,
    },
    f.connection,
  );
  expect(operationId).toMatch(/^[0-9a-f-]{36}$/);
  finish(
    f.build(
      "commandCompleted",
      [
        { path: "C:/fixture/a", state: "succeeded" },
        { path: "C:/fixture/b", state: "succeeded" },
        { path: "C:/fixture/c", state: "succeeded" },
      ],
      operationId,
    ),
  );
  await flush();
  expect(localDeleteHiddenPathsForTests(f.scope).size).toBe(0);
  expect(localDeleteBlockedPaths(f.scope).size).toBe(0);
  expect(localDeleteSnapshot()[0].outcome).toBe("commandCompleted");
  expect(f.port.execute).toHaveBeenCalledOnce();
});
it("unknown row stays visible and claimed; prior succeeded acknowledged; blocked release claim", async () => {
  const f = fixture();
  vi.mocked(f.port.execute).mockResolvedValue({
    operation: null,
    affectedPaths: f.files.map((x) => x.path),
    message: "uncertain",
    execution: {
      operationId: "pending",
      outcome: "unknown",
      perFileEvidence: "localIoAcknowledgements",
      files: [
        { depotPath: "C:/fixture/a", state: "succeeded", message: "" },
        { depotPath: "C:/fixture/b", state: "unknown", message: "os error" },
        { depotPath: "C:/fixture/c", state: "blocked", message: "" },
      ],
    },
  } as unknown as FileActionResult);
  startLocalDelete(
    f.scope,
    f.runtime,
    f.files.map((x) => x.path),
    () => true,
    f.port,
  );
  await flush();
  // execution.operationId must match the dispatch id; a mismatched id is never trusted.
  expect(localDeleteSnapshot()[0].rows.map((r) => r.state)).toEqual([
    "unknown",
    "unknown",
    "unknown",
  ]);
  expect(localDeleteHiddenPathsForTests(f.scope).size).toBe(0);
  expect(localDeleteBlockedPaths(f.scope).size).toBe(3);
});
it("real unknown execution maps per-file truth: unknown visible+claimed, blocked visible", async () => {
  const f = fixture();
  let finish!: (r: FileActionResult) => void;
  vi.mocked(f.port.execute).mockReturnValue(new Promise((r) => (finish = r)));
  startLocalDelete(
    f.scope,
    f.runtime,
    f.files.map((x) => x.path),
    () => true,
    f.port,
  );
  await flush();
  const id = localDeleteSnapshot()[0].operationId;
  finish({
    operation: null,
    affectedPaths: f.files.map((x) => x.path),
    message: "uncertain",
    execution: {
      operationId: id,
      outcome: "unknown",
      perFileEvidence: "localIoAcknowledgements",
      files: [
        { depotPath: "C:/fixture/a", state: "succeeded", message: "" },
        { depotPath: "C:/fixture/b", state: "unknown", message: "os error" },
        { depotPath: "C:/fixture/c", state: "blocked", message: "" },
      ],
    },
  } as unknown as FileActionResult);
  await flush();
  expect(localDeleteSnapshot()[0].rows.map((r) => r.state)).toEqual([
    "succeeded",
    "unknown",
    "blocked",
  ]);
  expect(localDeleteHiddenPathsForTests(f.scope).size).toBe(0);
  expect(localDeleteBlockedPaths(f.scope)).toEqual(new Set(["C:/fixture/b"]));
});
it("notDispatched releases every claim, hides nothing and maps blocked (not failed)", async () => {
  const f = fixture();
  vi.mocked(f.port.execute).mockImplementation(
    async (request) =>
      ({
        operation: null,
        affectedPaths: [...request.paths],
        message: "Local batch was not dispatched",
        execution: {
          operationId: request.operationId,
          outcome: "notDispatched",
          perFileEvidence: "localIoAcknowledgements",
          files: request.paths.map((path) => ({
            depotPath: path,
            state: "blocked",
            message: "",
          })),
        },
      }) as unknown as FileActionResult,
  );
  startLocalDelete(
    f.scope,
    f.runtime,
    f.files.map((x) => x.path),
    () => true,
    f.port,
  );
  await flush();
  expect(localDeleteSnapshot()[0].rows.map((r) => r.state)).toEqual([
    "blocked",
    "blocked",
    "blocked",
  ]);
  expect(localDeleteHiddenPathsForTests(f.scope).size).toBe(0);
  expect(localDeleteBlockedPaths(f.scope).size).toBe(0);
});
it("commandCompleted with blocked tail keeps earlier acks and blocks the rest", async () => {
  const f = fixture();
  vi.mocked(f.port.execute).mockImplementation(
    async (request) =>
      ({
        operation: null,
        affectedPaths: [...request.paths],
        message: "",
        execution: {
          operationId: request.operationId,
          outcome: "commandCompleted",
          perFileEvidence: "localIoAcknowledgements",
          files: [
            { depotPath: "C:/fixture/a", state: "succeeded", message: "" },
            { depotPath: "C:/fixture/b", state: "blocked", message: "" },
            { depotPath: "C:/fixture/c", state: "blocked", message: "" },
          ],
        },
      }) as unknown as FileActionResult,
  );
  startLocalDelete(
    f.scope,
    f.runtime,
    f.files.map((x) => x.path),
    () => true,
    f.port,
  );
  await flush();
  expect(localDeleteSnapshot()[0].rows.map((r) => r.state)).toEqual([
    "succeeded",
    "blocked",
    "blocked",
  ]);
  expect(localDeleteHiddenPathsForTests(f.scope).size).toBe(0);
  expect(localDeleteBlockedPaths(f.scope).size).toBe(0);
});
it("missing execution (old payload / P4 route) is not treated as deletion success", async () => {
  const f = fixture();
  vi.mocked(f.port.execute).mockResolvedValue({
    operation: null,
    affectedPaths: f.files.map((x) => x.path),
    message: "legacy",
  } as unknown as FileActionResult);
  startLocalDelete(
    f.scope,
    f.runtime,
    f.files.map((x) => x.path),
    () => true,
    f.port,
  );
  await flush();
  expect(localDeleteSnapshot()[0].rows.map((r) => r.state)).toEqual([
    "unknown",
    "unknown",
    "unknown",
  ]);
  expect(localDeleteHiddenPathsForTests(f.scope).size).toBe(0);
  expect(localDeleteBlockedPaths(f.scope).size).toBe(3);
});
it("transport loss stays unknown, keeps claim and never retries or re-dispatches", async () => {
  const f = fixture(undefined, { reject: true });
  startLocalDelete(
    f.scope,
    f.runtime,
    f.files.map((x) => x.path),
    () => true,
    f.port,
  );
  await flush();
  expect(f.port.execute).toHaveBeenCalledOnce();
  expect(localDeleteSnapshot()[0].rows.map((r) => r.state)).toEqual([
    "unknown",
    "unknown",
    "unknown",
  ]);
  expect(localDeleteBlockedPaths(f.scope).size).toBe(3);
  await flush();
  expect(f.port.execute).toHaveBeenCalledOnce();
});
it("context drift before dispatch writes nothing and withdraws every intent", async () => {
  const f = fixture();
  let current = true;
  startLocalDelete(
    f.scope,
    f.runtime,
    f.files.map((x) => x.path),
    () => current,
    f.port,
  );
  current = false;
  await flush();
  expect(f.port.execute).not.toHaveBeenCalled();
  expect(localDeleteSnapshot()[0].rows.map((r) => r.state)).toEqual([
    "blocked",
    "blocked",
    "blocked",
  ]);
  expect(localDeleteSnapshot()[0].outcome).toBe("notDispatched");
  expect(localDeleteBlockedPaths(f.scope).size).toBe(0);
  expect(localDeleteHiddenPathsForTests(f.scope).size).toBe(0);
});
