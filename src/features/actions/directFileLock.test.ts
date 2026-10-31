import { beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  preflightFileLock: vi.fn(),
  confirmFileLock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
vi.mock("../../infrastructure/backend", () => ({ backend: api }));
const notice = vi.hoisted(() => ({ notifyUser: vi.fn() }));
vi.mock("../../shared/notice", () => ({
  notifyUser: notice.notifyUser,
  writeFailureText: (
    message: string | undefined,
    fallback: { zh: string; en: string },
  ) => {
    void message;
    return fallback.en;
  },
}));
import { startFileLockDirect } from "./directFileLock";
import {
  fileLockProjectionsSnapshot,
  resetFileLockProjectionsForTests,
} from "./fileLockProjection";
import type {
  FileLockPreflight,
  FileLockResult,
  WorkspaceNode,
} from "../../shared/contracts";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const node = (path: string): WorkspaceNode =>
  ({
    id: path,
    name: path.split("/").pop(),
    kind: "file",
    depotPath: path,
    absolutePath: "",
    relativePath: path,
    state: "openedEdit",
    changelistId: 0,
  }) as WorkspaceNode;
const preflight = {
  ready: true,
  token: "t",
  stateDigest: "d",
  targetSnapshot: { files: [] },
  expiresAt: Date.now() + 60_000,
  blockers: [],
} as unknown as FileLockPreflight;
const result = (value: Partial<FileLockResult>): FileLockResult =>
  ({
    outcome: "succeeded",
    message: "",
    files: [],
    execution: {
      operationId: "op",
      outcome: "commandCompleted",
      perFileEvidence: "notCollected",
    },
    refresh: { depotPaths: [], localPaths: [] },
    ...value,
  }) as unknown as FileLockResult;
beforeEach(() => {
  resetFileLockProjectionsForTests();
  notice.notifyUser.mockClear();
  api.preflightFileLock.mockReset().mockResolvedValue(preflight);
  api.confirmFileLock.mockReset();
});

it("reports a partial lock that left some files failed instead of staying silent", async () => {
  api.confirmFileLock.mockResolvedValue(
    result({
      outcome: "partial",
      message: "Locked 1 file(s); 1 file(s) were not confirmed locked.",
      files: [
        {
          depotPath: "//fixture/a",
          outcome: "succeeded",
          message: "",
          ownership: "ours",
        },
        {
          depotPath: "//fixture/b",
          outcome: "failed",
          message: "locked by another user",
          ownership: "other",
        },
      ],
    }),
  );
  startFileLockDirect(
    [node("//fixture/a"), node("//fixture/b")],
    "lock",
    "scope",
    { onRefresh: () => undefined },
  );
  await flush();
  await flush();
  expect(notice.notifyUser).toHaveBeenCalledOnce();
  expect(notice.notifyUser.mock.calls[0][0]).toMatch(/part/i);
  // The overlay keeps only the acknowledged rows; the refresh then replaces them.
  expect(fileLockProjectionsSnapshot()).toHaveLength(0);
});

it("reports an unknown per-file result once and withdraws the projection", async () => {
  api.confirmFileLock.mockResolvedValue(
    result({
      outcome: "unknown",
      execution: {
        operationId: "op",
        outcome: "unknown",
        perFileEvidence: "notCollected",
      },
      files: [
        {
          depotPath: "//fixture/a",
          outcome: "unknown",
          message: "state unknown",
          ownership: "ours",
        },
      ],
    }),
  );
  startFileLockDirect([node("//fixture/a")], "lock", "scope", {
    onRefresh: () => undefined,
  });
  await flush();
  await flush();
  expect(notice.notifyUser).toHaveBeenCalledOnce();
});

it("a fully succeeded result is silent", async () => {
  api.confirmFileLock.mockResolvedValue(
    result({
      files: [
        {
          depotPath: "//fixture/a",
          outcome: "succeeded",
          message: "",
          ownership: "ours",
        },
      ],
    }),
  );
  startFileLockDirect([node("//fixture/a")], "lock", "scope", {
    onRefresh: () => undefined,
  });
  await flush();
  await flush();
  expect(notice.notifyUser).not.toHaveBeenCalled();
});
