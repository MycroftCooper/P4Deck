// @vitest-environment jsdom
// Regression test for the reported bug: after "还原全部" (Revert all) on the
// Default CL, P4 really reverts the files but the Pending list kept showing them
// until the user clicked Refresh.
//
// Root cause: the removal ledger can only reconcile rows it admitted optimistically,
// and admission requires a local path whose status proves the file unmodified.
// "还原全部" starts from depot-only rows (absolutePath === ""), so nothing is
// admitted; on success `finishRemovalObservation` had no record to settle and no
// cache was invalidated. `revert`/`revertUnchanged` declare `fileState`
// (`pending`, `workspaceStatus`, `depot`) effects in the action catalog, so the
// dispatched write must revalidate those domains unconditionally.
import { expect, it, vi } from "vitest";
import { startRevert, type RevertPort } from "./revertTask";
import { readSnapshot, writeSnapshot } from "../../shared/cache/snapshots";
import {
  pendingSnapshotKey,
  type PendingSnapshot,
} from "../changelists/pendingCache";
import { projectRemovalChanges, shelfObservation } from "./shelfObservation";
import { removalLedger } from "./actionStore";
import { blockedMovePaths } from "../changelists/moveOptimism";
import type {
  RuntimeInfo,
  WorkspaceNode,
  WorkflowResult,
} from "../../shared/contracts";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

it("whole-CL 'Revert all' with depot-only rows invalidates the Pending cache on success", async () => {
  const scope = "revert-refresh-repro";
  const runtime = {
    mode: "mock",
    contextGeneration: 1,
    context: { server: "s", user: "u", client: scope },
  } as RuntimeInfo;
  // Exactly what PendingPage.tsx feeds startRevert for "还原全部"
  // (Revert all): every node has absolutePath "" (only depotPath is known),
  // changelistId is the CL id (0 = Default) and wholeChangelistId is that id.
  const depotPaths = ["//depot/repro/a.txt", "//depot/repro/b.txt"];
  const nodes: WorkspaceNode[] = depotPaths.map((depotPath) => ({
    id: depotPath,
    name: depotPath.split("/").pop()!,
    kind: "file",
    state: "openedEdit",
    depotPath,
    absolutePath: "",
    relativePath: depotPath.split("/").pop()!,
    changelistId: 0,
  }));
  const snapshot = {
    changes: [
      {
        id: 0,
        description: "Default",
        user: "u",
        client: scope,
        status: "pending",
        jobs: [],
        files: depotPaths.map((depotPath) => ({ depotPath, action: "edit" })),
        shelvedFiles: [],
      },
    ],
    partial: false,
    stats: { scannedCount: 2, matchedCount: 2, truncatedBySafetyLimit: false },
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
    files: depotPaths.map((depotPath) => ({
      depotPath,
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
    workspaceChildren: vi.fn(async () =>
      nodes.map((node) => ({
        ...node,
        absolutePath: `C:/ws/${node.name}`,
        status: { local: "present" } as WorkspaceNode["status"],
      })),
    ),
  };
  // Data-free observation of what invalidateData(["pending"]) would dispatch.
  const refreshRequests: string[] = [];
  const onPendingRefresh = () => refreshRequests.push("p4deck:pending-refresh");
  const onWorkflowResult = () => refreshRequests.push("p4deck:workflow-result");
  window.addEventListener("p4deck:pending-refresh", onPendingRefresh);
  window.addEventListener("p4deck:workflow-result", onWorkflowResult);
  try {
    expect(
      startRevert(scope, runtime, nodes, "revert", () => true, 0, port),
    ).toBe(true);
    // Let the queued microtask task run: local-status probe, dispatch, result,
    // finishRemovalObservation, then the post-write invalidation.
    await flush();

    // The P4 write itself is correct: one whole-Default-CL revert of both paths.
    expect(port.execute).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: "revert",
        paths: [...depotPaths],
        changelistId: 0,
        revertWholeChangelist: true,
      }),
      connection,
    );

    // Depot-only rows still admit no optimistic removal (no local path facts are
    // consulted), so no ledger record exists; that part is unchanged.
    expect(port.workspaceChildren).not.toHaveBeenCalled();
    expect(
      projectRemovalChanges(
        "revert",
        snapshot.changes,
        scope,
        shelfObservation(runtime).version,
      )[0].files.map((file) => file.depotPath),
    ).toEqual(depotPaths);
    expect(blockedMovePaths(scope).size).toBe(0);
    expect(
      removalLedger.getSnapshot().filter((record) => record.scope === scope),
    ).toHaveLength(0);

    // The snapshot is not mutated directly (no mounted view is here to refetch);
    // reconciliation is driven by the refresh signal asserted below.
    expect(
      readSnapshot<PendingSnapshot>(key)!.data.changes[0].files.map(
        (file) => file.depotPath,
      ),
    ).toEqual(depotPaths);

    // The fix: a succeeded revert revalidates `pending` so the mounted Pending
    // view refetches and drops the reverted rows without a manual Refresh.
    expect(refreshRequests).toContain("p4deck:pending-refresh");

    // The write happened once; the stale UI does not come from a retry or lookup.
    expect(port.lookup).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("p4deck:pending-refresh", onPendingRefresh);
    window.removeEventListener("p4deck:workflow-result", onWorkflowResult);
  }
});
