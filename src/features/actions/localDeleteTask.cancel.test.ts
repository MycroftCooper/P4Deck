import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import {
  cancelLocalDelete,
  localDeleteBlockedPaths,
  localDeleteHiddenPathsForTests,
  localDeleteRecord,
  localDeleteSnapshot,
  resetLocalDeleteForTests,
  startLocalDelete,
  type LocalDeletePort,
} from "./localDeleteTask";
import type { FileActionResult, RuntimeInfo } from "../../shared/contracts";

const flush = () => new Promise((r) => setTimeout(r, 0));
let serial = 0;
const PATHS = ["C:/fixture/a", "C:/fixture/b", "C:/fixture/c"];
function fixture() {
  resetLocalDeleteForTests();
  const scope = `local-cancel-${++serial}`;
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
  const port: LocalDeletePort = {
    connection: vi.fn(async () => connection),
    execute: vi.fn(),
    cancel: vi.fn(async () => {}),
  };
  return { scope, runtime, connection, port };
}
const notDispatched = (operationId: string): FileActionResult =>
  ({
    operation: null,
    affectedPaths: [...PATHS],
    message: "Local batch was not dispatched",
    execution: {
      operationId,
      outcome: "notDispatched",
      perFileEvidence: "localIoAcknowledgements",
      files: PATHS.map((path) => ({
        depotPath: path,
        state: "blocked",
        message: "",
      })),
    },
  }) as unknown as FileActionResult;
const succeeded = (operationId: string): FileActionResult =>
  ({
    operation: null,
    affectedPaths: [...PATHS],
    message: "Local batch finished; inspect per-file acknowledgements",
    execution: {
      operationId,
      outcome: "commandCompleted",
      perFileEvidence: "localIoAcknowledgements",
      files: PATHS.map((path) => ({
        depotPath: path,
        state: "succeeded",
        message: "",
      })),
    },
  }) as unknown as FileActionResult;

it("cancel calls the existing cancel_operation exactly once with the same operationId and zero extra I/O", async () => {
  const f = fixture();
  let finish!: (r: FileActionResult) => void;
  vi.mocked(f.port.execute).mockReturnValue(new Promise((r) => (finish = r)));
  expect(startLocalDelete(f.scope, f.runtime, PATHS, () => true, f.port)).toBe(
    true,
  );
  await flush();
  const id = localDeleteSnapshot()[0].operationId;
  expect(f.port.cancel).not.toHaveBeenCalled();
  expect(f.port.execute).toHaveBeenCalledOnce();
  expect(cancelLocalDelete(id, f.port)).toBe(true);
  expect(localDeleteSnapshot()[0].cancelRequested).toBe(true);
  // A second cancel (e.g. repeated click) must not issue a second cancel_operation.
  expect(cancelLocalDelete(id, f.port)).toBe(false);
  expect(f.port.cancel).toHaveBeenCalledExactlyOnceWith(id);
  expect(f.port.execute).toHaveBeenCalledOnce();
  const executeCalls = vi.mocked(f.port.execute).mock.calls.length;
  finish(notDispatched(id));
  await flush();
  expect(f.port.cancel).toHaveBeenCalledExactlyOnceWith(id);
  expect(vi.mocked(f.port.execute).mock.calls.length).toBe(executeCalls);
  expect(localDeleteSnapshot()[0].rows.map((r) => r.state)).toEqual([
    "blocked",
    "blocked",
    "blocked",
  ]);
  expect(localDeleteSnapshot()[0].outcome).toBe("notDispatched");
  expect(localDeleteHiddenPathsForTests(f.scope).size).toBe(0);
  expect(localDeleteBlockedPaths(f.scope).size).toBe(0);
  expect(localDeleteRecord(id)?.busy).toBe(false);
});
it("settled operations cannot be cancelled and never issue an extra cancel_operation", async () => {
  const f = fixture();
  vi.mocked(f.port.execute).mockImplementation(async (request) =>
    succeeded(request.operationId),
  );
  startLocalDelete(f.scope, f.runtime, PATHS, () => true, f.port);
  await flush();
  const id = localDeleteSnapshot()[0].operationId;
  expect(localDeleteRecord(id)?.busy).toBe(false);
  expect(cancelLocalDelete(id, f.port)).toBe(false);
  expect(cancelLocalDelete("unknown-operation", f.port)).toBe(false);
  expect(f.port.cancel).not.toHaveBeenCalled();
  expect(localDeleteSnapshot()[0].rows.map((r) => r.state)).toEqual([
    "succeeded",
    "succeeded",
    "succeeded",
  ]);
});
it("cancel before dispatch settles withdraws every claim with zero execute calls", async () => {
  const f = fixture();
  vi.mocked(f.port.execute).mockReturnValue(new Promise(() => {}));
  startLocalDelete(f.scope, f.runtime, PATHS, () => true, f.port);
  await flush();
  const id = localDeleteSnapshot()[0].operationId;
  expect(cancelLocalDelete(id, f.port)).toBe(true);
  expect(f.port.cancel).toHaveBeenCalledExactlyOnceWith(id);
  expect(localDeleteHiddenPathsForTests(f.scope).size).toBe(3);
  // The in-flight batch, once the host answers with notDispatched, releases every claim.
  expect(localDeleteBlockedPaths(f.scope).size).toBe(3);
});
