import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import {
  beginGenericFileProjection,
  clearGenericFileProjection,
  confirmGenericFileProjection,
  discardGenericFileProjectionsForTarget,
  genericFileProjectionsSnapshot,
  projectGenericPendingChanges,
  projectWorkspaceNodes,
  resetGenericFileProjectionsForTests,
  withdrawGenericFileProjection,
} from "./genericFileProjection";
import {
  startGenericFileAction,
  type GenericFilePort,
} from "./genericFileTask";
import type {
  FileActionRequest,
  FileActionResult,
  PendingChange,
  RuntimeInfo,
  WorkspaceNode,
} from "../../shared/contracts";

const flush = () => new Promise((r) => setTimeout(r, 0));
let serial = 0;
const row = (state: string): WorkspaceNode =>
  ({
    id: "a",
    name: "a",
    relativePath: "a",
    absolutePath: "C:/fixture/a",
    depotPath: "//fixture/a",
    kind: "file",
    state,
  }) as WorkspaceNode;
const pending = (
  files: { depotPath: string; action: string }[],
): PendingChange =>
  ({
    id: 0,
    description: "default",
    user: "u",
    client: "c",
    status: "pending",
    jobs: [],
    files,
    shelvedFiles: [],
  }) as unknown as PendingChange;

it("projects checkout/add/delete immediately and only from eligible base states", () => {
  resetGenericFileProjectionsForTests();
  const scope = `proj-${++serial}`;
  const req = (action: FileActionRequest["action"]): FileActionRequest => ({
    action,
    paths: ["C:/fixture/a"],
    states: ["controlled"],
  });
  expect(beginGenericFileProjection(scope, "op-1", req("checkout"))).toBe(true);
  expect(projectWorkspaceNodes([row("controlled")], scope)[0].state).toBe(
    "openedEdit",
  );
  expect(projectWorkspaceNodes([row("openedDelete")], scope)[0].state).toBe(
    "openedDelete",
  );
  expect(projectWorkspaceNodes([row("untracked")], scope)[0].state).toBe(
    "untracked",
  );
  expect(
    projectWorkspaceNodes([row("controlled")], "other-scope")[0].state,
  ).toBe("controlled");
  withdrawGenericFileProjection("op-1");
  expect(projectWorkspaceNodes([row("controlled")], scope)[0].state).toBe(
    "controlled",
  );

  expect(beginGenericFileProjection(scope, "op-2", req("add"))).toBe(true);
  expect(projectWorkspaceNodes([row("untracked")], scope)[0].state).toBe(
    "openedAdd",
  );
  expect(projectWorkspaceNodes([row("controlled")], scope)[0].state).toBe(
    "controlled",
  );
  withdrawGenericFileProjection("op-2");

  expect(beginGenericFileProjection(scope, "op-3", req("markForDelete"))).toBe(
    true,
  );
  expect(projectWorkspaceNodes([row("openedEdit")], scope)[0].state).toBe(
    "openedDelete",
  );
  expect(projectWorkspaceNodes([row("conflicted")], scope)[0].state).toBe(
    "conflicted",
  );
  withdrawGenericFileProjection("op-3");
});
it("never projects addRecursive or directory-expansion paths (negative)", () => {
  resetGenericFileProjectionsForTests();
  const scope = `proj-${++serial}`;
  expect(
    beginGenericFileProjection(scope, "op-r", {
      action: "addRecursive",
      paths: ["C:/fixture/dir"],
      states: ["untracked"],
    }),
  ).toBe(false);
  expect(
    beginGenericFileProjection(scope, "op-d", {
      action: "delete",
      paths: ["//fixture/dir/..."],
      states: ["controlled"],
    }),
  ).toBe(false);
  expect(genericFileProjectionsSnapshot()).toHaveLength(0);
});
it("pending overlay: delete flips an existing row, checkout/add insert into the target/default CL only", () => {
  resetGenericFileProjectionsForTests();
  const scope = `proj-${++serial}`;
  expect(
    beginGenericFileProjection(scope, "op-del", {
      action: "markForDelete",
      paths: ["//fixture/a"],
      changelistId: 7,
    }),
  ).toBe(true);
  const afterDelete = projectGenericPendingChanges(
    [
      {
        id: 7,
        description: "cl7",
        user: "u",
        client: "c",
        status: "pending",
        jobs: [],
        files: [{ depotPath: "//fixture/a", action: "edit" }],
        shelvedFiles: [],
      } as unknown as PendingChange,
    ],
    scope,
  );
  expect(afterDelete[0].files[0].action).toBe("delete");
  // Missing CL: the row is never invented in an unknown changelist.
  const untouched = projectGenericPendingChanges(
    [
      {
        id: 9,
        description: "cl9",
        user: "u",
        client: "c",
        status: "pending",
        jobs: [],
        files: [{ depotPath: "//fixture/b", action: "edit" }],
        shelvedFiles: [],
      } as unknown as PendingChange,
    ],
    scope,
  );
  expect(untouched[0].files).toHaveLength(1);
  withdrawGenericFileProjection("op-del");

  expect(
    beginGenericFileProjection(scope, "op-co", {
      action: "checkout",
      paths: ["//fixture/c"],
      changelistId: 0,
    }),
  ).toBe(true);
  const afterCheckout = projectGenericPendingChanges(
    [pending([{ depotPath: "//fixture/x", action: "edit" }])],
    scope,
  );
  expect(
    afterCheckout[0].files.some(
      (f) => f.depotPath === "//fixture/c" && f.action === "edit",
    ),
  ).toBe(true);
  withdrawGenericFileProjection("op-co");
  expect(
    projectGenericPendingChanges([pending([])], scope)[0].files,
  ).toHaveLength(0);
});
function fixture() {
  resetGenericFileProjectionsForTests();
  const scope = `flow-${++serial}`;
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
    execute: vi.fn(),
    lookup: vi.fn(async () => ({ kind: "notFound" as const })),
    report: vi.fn(),
    invalidate: vi.fn(async () => {}),
  };
  const request: FileActionRequest = {
    action: "checkout",
    paths: ["C:/fixture/a"],
    states: ["controlled"],
    operationId: crypto.randomUUID(),
  };
  return { scope, runtime, connection, port, request };
}
const completed = (operationId: string): FileActionResult =>
  ({
    message: "",
    affectedPaths: ["C:/fixture/a"],
    execution: {
      operationId,
      outcome: "commandCompleted",
      perFileEvidence: "notCollected",
    },
  }) as FileActionResult;

it("projection published in the same tick as admit; commandCompleted keeps it until refetch, then clears", async () => {
  const f = fixture();
  let finish!: (r: FileActionResult) => void;
  vi.mocked(f.port.execute).mockReturnValue(new Promise((r) => (finish = r)));
  let resolveInvalidate!: () => void;
  vi.mocked(f.port.invalidate).mockReturnValue(
    new Promise<void>((r) => (resolveInvalidate = r)),
  );
  expect(
    startGenericFileAction(
      f.scope,
      f.runtime,
      f.request,
      [],
      () => true,
      f.port,
    ),
  ).toBe(true);
  // Same tick: projection exists before the microtask dispatch/response.
  expect(genericFileProjectionsSnapshot()).toHaveLength(1);
  expect(genericFileProjectionsSnapshot()[0].phase).toBe("pending");
  await flush();
  expect(f.port.execute).toHaveBeenCalledOnce();
  finish(completed(f.request.operationId!));
  await flush();
  expect(genericFileProjectionsSnapshot()).toHaveLength(1);
  expect(genericFileProjectionsSnapshot()[0].phase).toBe("confirmed");
  expect(f.port.invalidate).toHaveBeenCalledOnce();
  resolveInvalidate();
  await flush();
  expect(genericFileProjectionsSnapshot()).toHaveLength(0);
});
it("unknown withdraws the projection immediately, runs one bounded refetch, never retries or claims success", async () => {
  const f = fixture();
  vi.mocked(f.port.execute).mockResolvedValue({
    message: "",
    affectedPaths: ["C:/fixture/a"],
  } as FileActionResult);
  startGenericFileAction(f.scope, f.runtime, f.request, [], () => true, f.port);
  expect(genericFileProjectionsSnapshot()).toHaveLength(1);
  await flush();
  expect(genericFileProjectionsSnapshot()).toHaveLength(0);
  expect(f.port.execute).toHaveBeenCalledOnce();
  expect(f.port.invalidate).toHaveBeenCalledOnce();
  expect(f.port.report).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: "unknown" }),
  );
});
it("settled receipt reuse keeps the projection (no replay) and refetch clears it", async () => {
  const f = fixture();
  let resolveInvalidate!: () => void;
  vi.mocked(f.port.invalidate).mockReturnValue(
    new Promise<void>((r) => (resolveInvalidate = r)),
  );
  vi.mocked(f.port.execute).mockRejectedValue(Error("lost"));
  vi.mocked(f.port.lookup).mockImplementation(async ({ operationId }) => ({
    kind: "found" as const,
    receipt: {
      operationId,
      kind: "fileAction" as const,
      connection: f.connection,
      payloadDigest: "ab".repeat(32),
      revision: "5",
      state: "settled" as const,
      result: completed(operationId),
    },
  }));
  startGenericFileAction(f.scope, f.runtime, f.request, [], () => true, f.port);
  await flush();
  expect(f.port.execute).toHaveBeenCalledOnce();
  expect(f.port.lookup).toHaveBeenCalledOnce();
  expect(genericFileProjectionsSnapshot()).toHaveLength(1);
  expect(f.port.invalidate).toHaveBeenCalledOnce();
  expect(genericFileProjectionsSnapshot()[0].phase).toBe("confirmed");
  resolveInvalidate();
  await flush();
  expect(genericFileProjectionsSnapshot()).toHaveLength(0);
});
it("context drift before dispatch publishes no projection and writes nothing", async () => {
  const f = fixture();
  let current = true;
  startGenericFileAction(
    f.scope,
    f.runtime,
    f.request,
    [],
    () => current,
    f.port,
  );
  current = false;
  await flush();
  expect(f.port.execute).not.toHaveBeenCalled();
  expect(genericFileProjectionsSnapshot()).toHaveLength(0);
});
it("does not project addRecursive through the real action entry (negative)", () => {
  const f = fixture();
  const recursive: FileActionRequest = {
    action: "addRecursive",
    paths: ["C:/fixture/dir"],
    states: ["untracked"],
  };
  expect(
    startGenericFileAction(
      f.scope,
      f.runtime,
      recursive,
      [],
      () => true,
      f.port,
    ),
  ).toBe(true);
  expect(genericFileProjectionsSnapshot()).toHaveLength(0);
});
it("affectedPaths-only result never projects a success row (negative)", async () => {
  const f = fixture();
  vi.mocked(f.port.execute).mockResolvedValue({
    message: "",
    affectedPaths: ["C:/fixture/a", "C:/fixture/other"],
    execution: {
      operationId: f.request.operationId!,
      outcome: "commandCompleted",
      perFileEvidence: "notCollected",
    },
  } as FileActionResult);
  startGenericFileAction(f.scope, f.runtime, f.request, [], () => true, f.port);
  const projected = projectWorkspaceNodes([row("controlled")], f.scope);
  expect(projected[0].state).toBe("openedEdit");
  await flush();
  // The projection only describes the requested path; affectedPaths never adds a row.
  clearGenericFileProjection(f.request.operationId!);
  expect(genericFileProjectionsSnapshot()).toHaveLength(0);
});
it("targetKey guard: mismatched target never applies, confirm/clear do not touch another target, target change discards", () => {
  resetGenericFileProjectionsForTests();
  const scope = `tk-${++serial}`;
  const checkout = (paths: string[]): FileActionRequest => ({
    action: "checkout",
    paths,
    states: ["controlled"],
  });
  expect(
    beginGenericFileProjection(
      scope,
      "op-A",
      checkout(["C:/fixture/a"]),
      "target-A",
    ),
  ).toBe(true);
  expect(
    projectWorkspaceNodes([row("controlled")], scope, "target-A")[0].state,
  ).toBe("openedEdit");
  expect(
    projectWorkspaceNodes([row("controlled")], scope, "target-B")[0].state,
  ).toBe("controlled");
  // A mismatched confirm/clear is a no-op and cannot retire another target's projection.
  confirmGenericFileProjection("op-A", "target-B");
  expect(genericFileProjectionsSnapshot()[0].phase).toBe("pending");
  confirmGenericFileProjection("op-A", "target-A");
  expect(genericFileProjectionsSnapshot()[0].phase).toBe("confirmed");
  discardGenericFileProjectionsForTarget(scope, "target-B");
  expect(genericFileProjectionsSnapshot()).toHaveLength(0);
  // Un-targeted projection is not applied when the view asks for a concrete targetKey.
  beginGenericFileProjection(scope, "op-C", checkout(["C:/fixture/a"]));
  expect(
    projectWorkspaceNodes([row("controlled")], scope, "target-A")[0].state,
  ).toBe("controlled");
  clearGenericFileProjection("op-C");
});
it("latest projection owns a path; an older operation settling later cannot resurrect it", () => {
  resetGenericFileProjectionsForTests();
  const scope = `lw-${++serial}`;
  expect(
    beginGenericFileProjection(scope, "op-old", {
      action: "checkout",
      paths: ["C:/fixture/a"],
      states: ["controlled"],
    }),
  ).toBe(true);
  expect(
    beginGenericFileProjection(scope, "op-new", {
      action: "markForDelete",
      paths: ["C:/fixture/a"],
      states: ["controlled"],
    }),
  ).toBe(true);
  expect(genericFileProjectionsSnapshot()).toHaveLength(1);
  expect(projectWorkspaceNodes([row("controlled")], scope)[0].state).toBe(
    "openedDelete",
  );
  clearGenericFileProjection("op-old");
  expect(projectWorkspaceNodes([row("controlled")], scope)[0].state).toBe(
    "openedDelete",
  );
  withdrawGenericFileProjection("op-new");
  expect(projectWorkspaceNodes([row("controlled")], scope)[0].state).toBe(
    "controlled",
  );
});
it("commandCompleted with a failed refetch keeps the overlay, reports refreshFailed and never retries", async () => {
  const f = fixture();
  let finish!: (r: FileActionResult) => void;
  vi.mocked(f.port.execute).mockReturnValue(new Promise((r) => (finish = r)));
  vi.mocked(f.port.invalidate).mockRejectedValue(Error("refresh failed"));
  startGenericFileAction(
    f.scope,
    f.runtime,
    f.request,
    [],
    () => true,
    f.port,
    "target-A",
  );
  expect(genericFileProjectionsSnapshot()).toHaveLength(1);
  await flush();
  finish({
    message: "",
    affectedPaths: ["C:/fixture/a"],
    execution: {
      operationId: f.request.operationId!,
      outcome: "commandCompleted",
      perFileEvidence: "notCollected",
    },
  } as FileActionResult);
  await flush();
  expect(f.port.execute).toHaveBeenCalledOnce();
  expect(f.port.invalidate).toHaveBeenCalledOnce();
  expect(f.port.report).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: "failed", code: "refreshFailed" }),
  );
  expect(genericFileProjectionsSnapshot()).toHaveLength(1);
  expect(genericFileProjectionsSnapshot()[0].phase).toBe("confirmed");
  expect(
    projectWorkspaceNodes([row("controlled")], f.scope, "target-A")[0].state,
  ).toBe("openedEdit");
});
