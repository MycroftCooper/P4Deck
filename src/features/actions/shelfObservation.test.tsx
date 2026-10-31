// @vitest-environment jsdom
import { act, useState } from "react";
import { expect, it, vi } from "vitest";
import { dialogHarness, dialogButton } from "../../app/dialogs/testHarness";
import {
  MenuEnvironment,
  type MenuEnvironmentValue,
} from "../../app/context-menu/environment";
import { DeleteShelfDialog } from "../changelists/components/DeleteShelfDialog";
import {
  startDeleteShelf,
  shelfIdentity,
} from "../changelists/deleteShelfTask";
import {
  acceptShelfObservation,
  finishShelfObservation,
  projectShelfChanges,
  shelfObservation,
  useRemovalActions,
  invalidateShelfObservations,
} from "./shelfObservation";
import { writeSnapshot, readSnapshot } from "../../shared/cache/snapshots";
import {
  pendingSnapshotKey,
  type PendingSnapshot,
} from "../changelists/pendingCache";
import { removalLedger } from "./actionStore";
import { blockedMovePaths } from "../changelists/moveOptimism";
import { backend } from "../../infrastructure/backend";
import type {
  RuntimeInfo,
  PendingChange,
  ShelfPreflight,
  WorkflowResult,
} from "../../shared/contracts";
const h = dialogHarness();
let serial = 0;
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
function setup() {
  const scope = `shelf-${++serial}`;
  const runtime = {
    mode: "tauri",
    context: { server: "s", user: "u", client: scope, cwd: "C:/fixture" },
    contextGeneration: 1,
  } as RuntimeInfo;
  const changes = [
    {
      id: 11,
      description: "synthetic",
      user: "u",
      client: scope,
      status: "pending",
      jobs: [],
      files: [],
      shelvedFiles: [
        { depotPath: "//fixture/a", action: "edit" },
        { depotPath: "//fixture/b", action: "edit" },
      ],
    },
  ] as PendingChange[];
  const key = pendingSnapshotKey(runtime);
  const snapshot = { changes, partial: false, stats: {} } as PendingSnapshot;
  writeSnapshot(key, snapshot);
  const intent = {
    ...shelfIdentity(runtime),
    connectionKey: scope,
    changeId: 11,
    paths: ["//fixture/a"],
  };
  const preflight = {
    warnings: [],
    ttlMs: 60000,
    operationIds: [],
    scope: {
      openedPaths: [],
      existingShelvedPaths: ["//fixture/a"],
      createPaths: [],
      replacePaths: [],
      deletePaths: ["//fixture/a"],
      contentDigest: "fixture",
    },
    ready: true,
    token: "token",
    expiresAt: Date.now() + 60000,
    blockers: [],
    target: {
      kind: "shelf",
      server: "s",
      user: "u",
      client: scope,
      workspace: "C:/fixture",
      contextGeneration: 1,
      sourceChangeId: 11,
      depotPaths: ["//fixture/a"],
    },
  } as ShelfPreflight;
  const result = {
    outcome: "succeeded",
    files: [{ depotPath: "//fixture/a", state: "succeeded", message: "" }],
    operationIds: [],
    message: "",
    refresh: {
      pendingChanges: true,
      workspaceStatus: false,
      depotPaths: [],
      reason: "fixture",
    },
  } as WorkflowResult;
  const deps = {
    current: () => ({ connectionKey: scope, runtime }),
    report: vi.fn(),
    check: vi.fn(async () => preflight),
    execute: vi.fn(async () => result),
  };
  return {
    scope,
    runtime,
    changes,
    key,
    snapshot,
    intent,
    preflight,
    result,
    deps,
  };
}
it("real confirmation closes modal and immediately projects while execution is unresolved", async () => {
  const f = setup(),
    write = deferred<WorkflowResult>();
  f.deps.execute.mockReturnValue(write.promise);
  vi.spyOn(backend, "companySubmitConnectionSnapshot").mockResolvedValue({
    profileId: "p",
    generation: "18446744073709551615",
    server: "s",
    user: "u",
    client: f.scope,
  });
  const env = {
    runtime: f.runtime,
    getOperationContext: f.deps.current,
    reportOperationError: f.deps.report,
  } as unknown as MenuEnvironmentValue;
  function View() {
    const [open, setOpen] = useState(true);
    const records = useRemovalActions();
    const rows = projectShelfChanges(
      f.changes,
      f.scope,
      shelfObservation(f.runtime).version,
      records,
    );
    return (
      <MenuEnvironment.Provider value={env}>
        <div data-testid="files">
          {rows[0].shelvedFiles.map((file) => (
            <span key={file.depotPath}>{file.depotPath}</span>
          ))}
        </div>
        {open && (
          <DeleteShelfDialog
            request={{
              changeId: 11,
              paths: f.intent.paths,
              mode: "delete",
              hasShelf: true,
              source: null,
            }}
            connectionKey={f.scope}
            zh={false}
            onDismiss={() => setOpen(false)}
            check={f.deps.check}
            execute={f.deps.execute}
          />
        )}
      </MenuEnvironment.Provider>
    );
  }
  await h.render(<View />);
  await act(async () =>
    dialogButton("Delete selected shelf revisions").click(),
  );
  expect(document.querySelector("dialog")).toBeNull();
  expect(document.querySelector('[data-testid="files"]')!.textContent).toBe(
    "//fixture/b",
  );
  expect(f.deps.execute).toHaveBeenCalledOnce();
  expect(blockedMovePaths(f.scope).has("//fixture/a")).toBe(true);
  await act(async () => write.resolve(f.result));
  expect(
    readSnapshot<PendingSnapshot>(f.key)!.data.changes[0].shelvedFiles.map(
      (x) => x.depotPath,
    ),
  ).toEqual(["//fixture/b"]);
  expect(blockedMovePaths(f.scope).size).toBe(0);
});
it("new cache observation is visible and an old success cannot delete it", async () => {
  const f = setup(),
    write = deferred<WorkflowResult>();
  f.deps.execute.mockReturnValue(write.promise);
  startDeleteShelf(f.intent, f.deps);
  await act(async () => {});
  writeSnapshot(f.key, {
    ...f.snapshot,
    changes: f.changes.map((cl) => ({
      ...cl,
      shelvedFiles: cl.shelvedFiles.map((file) => ({ ...file })),
    })),
  });
  expect(
    projectShelfChanges(
      f.changes,
      f.scope,
      shelfObservation(f.runtime).version,
    )[0].shelvedFiles,
  ).toHaveLength(2);
  await act(async () => write.resolve(f.result));
  expect(
    readSnapshot<PendingSnapshot>(f.key)!.data.changes[0].shelvedFiles,
  ).toHaveLength(2);
});
it("overlapping subsets conflict while other paths remain usable", async () => {
  const f = setup();
  f.deps.check.mockReturnValue(new Promise(() => {}));
  expect(startDeleteShelf(f.intent, f.deps)).toBe(true);
  expect(
    startDeleteShelf(
      { ...f.intent, paths: ["//fixture/a", "//fixture/b"] },
      f.deps,
    ),
  ).toBe(false);
  expect(
    startDeleteShelf({ ...f.intent, paths: ["//fixture/b"] }, f.deps),
  ).toBe(true);
});
it("partial keeps verified removal and restores unknown without write replay", async () => {
  const f = setup();
  f.intent.paths.push("//fixture/b");
  f.preflight.target.depotPaths = [...f.intent.paths];
  f.result.outcome = "partial";
  f.result.files.push({
    depotPath: "//fixture/b",
    state: "unknown",
    message: "",
  });
  startDeleteShelf(f.intent, f.deps);
  await act(async () => {});
  expect(
    readSnapshot<PendingSnapshot>(f.key)!.data.changes[0].shelvedFiles.map(
      (x) => x.depotPath,
    ),
  ).toEqual(["//fixture/b"]);
  expect(blockedMovePaths(f.scope)).toEqual(new Set(["//fixture/b"]));
  expect(f.deps.execute).toHaveBeenCalledOnce();
});
it("new shelf action retires old visual coverage without releasing unknown resources", async () => {
  const f = setup();
  f.deps.check.mockReturnValue(new Promise(() => {}));
  startDeleteShelf(f.intent, f.deps);
  invalidateShelfObservations(f.scope, f.intent.paths);
  expect(
    projectShelfChanges(
      f.changes,
      f.scope,
      shelfObservation(f.runtime).version,
    )[0].shelvedFiles,
  ).toHaveLength(2);
  expect(blockedMovePaths(f.scope).has("//fixture/a")).toBe(true);
  expect(
    removalLedger.getSnapshot().filter((r) => r.scope === f.scope)[0].data
      .items[0].retired,
  ).toBe(true);
});

it("new shelf intent prevents late old success from merging into cache", async () => {
  const f = setup(),
    write = deferred<WorkflowResult>();
  f.deps.execute.mockReturnValue(write.promise);
  startDeleteShelf(f.intent, f.deps);
  await act(async () => {});
  invalidateShelfObservations(f.scope, f.intent.paths);
  await act(async () => write.resolve(f.result));
  expect(
    readSnapshot<PendingSnapshot>(f.key)!.data.changes[0].shelvedFiles,
  ).toHaveLength(2);
});

it("per-file facts win over the command-level fallback (never fake success)", () => {
  const f = setup();
  const operationId = crypto.randomUUID();
  expect(
    acceptShelfObservation(
      f.scope,
      operationId,
      11,
      ["//fixture/a"],
      f.runtime,
    ),
  ).toBe(true);
  finishShelfObservation(operationId, f.runtime, {
    ...f.result,
    outcome: "succeeded",
    execution: {
      kind: "shelf",
      operationId,
      state: "commandCompleted",
      outcome: "succeeded",
      files: [],
    },
    files: [{ depotPath: "//fixture/a", state: "failed", message: "" }],
  });
  const record = removalLedger
    .getSnapshot()
    .find((item) => item.operationId === operationId)!;
  expect(record.data.items[0].outcome).toBe("unknown");
  expect(record.data.execution?.admissionReleased).toBeUndefined();
  expect(blockedMovePaths(f.scope).has("//fixture/a")).toBe(true);
});

it("a deterministic host rejection never keeps the removal claim", () => {
  const f = setup();
  const operationId = crypto.randomUUID();
  expect(
    acceptShelfObservation(
      f.scope,
      operationId,
      11,
      ["//fixture/a"],
      f.runtime,
    ),
  ).toBe(true);
  finishShelfObservation(operationId, f.runtime, {
    ...f.result,
    outcome: "failed",
    failure: "preflightBlocked",
    execution: undefined,
    files: [],
  });
  const record = removalLedger
    .getSnapshot()
    .find((item) => item.operationId === operationId)!;
  expect(record.data.items.map((item) => item.outcome)).toEqual(["notApplied"]);
  expect(record.data.execution?.admissionReleased).toBe(true);
  expect(blockedMovePaths(f.scope).size).toBe(0);
});
