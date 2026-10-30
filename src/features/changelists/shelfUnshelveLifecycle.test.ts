import { expect, it, vi } from "vitest";
import type {
  WorkflowConfirmation,
  WorkflowResult,
  WorkflowTargetSnapshot,
} from "../../shared/contracts";
import type { ConnectionSnapshot } from "../companySubmit/model";
const invalidateData = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../shared/cache/dataEffects", () => ({ invalidateData }));
import {
  boundedRefresh,
  confirmedFilePaths,
  runShelfUnshelve,
  shelfUnshelveLifecycle,
  workflowConnectionMatchesTarget,
} from "./shelfUnshelveLifecycle";

const target: WorkflowTargetSnapshot = {
  kind: "shelf",
  server: "server:1666",
  user: "tester",
  client: "workspace",
  workspace: "C:/work",
  contextGeneration: 4,
  sourceChangeId: 10,
  depotPaths: ["//depot/a"],
};
const connection: ConnectionSnapshot = {
  profileId: "fixture",
  generation: "4",
  server: "server:1666",
  user: "tester",
  client: "workspace",
};
const operationId = "0f6e3a1c-8f0a-4b1f-9c1e-2c4a8b6d1f23";
const envelope = (
  state: "commandCompleted" | "unknown",
  overrides: Partial<WorkflowResult["execution"]> = {},
): WorkflowResult => ({
  outcome: state === "commandCompleted" ? "succeeded" : "unknown",
  failure: state === "commandCompleted" ? undefined : "uncertainOutcome",
  message: "wire message",
  operationIds: [operationId],
  logReference: operationId,
  files: [],
  refresh: {
    pendingChanges: true,
    workspaceStatus: true,
    depotPaths: ["//depot/a"],
    reason: "refresh",
  },
  execution: {
    kind: "shelf",
    operationId,
    state,
    outcome: state === "commandCompleted" ? "succeeded" : "unknown",
    files: [],
    ...overrides,
  },
});
const confirmation = {
  token: "token",
  target,
  operationId,
} satisfies Required<WorkflowConfirmation>;

it("treats an absent envelope as legacy and a mismatched envelope as unknown", () => {
  const legacy = shelfUnshelveLifecycle(
    { ...envelope("commandCompleted"), execution: undefined, files: [] },
    "shelf",
    operationId,
  );
  expect(legacy.state).toBe("legacy");
  expect(legacy.commandCompleted).toBe(false);
  expect(confirmedFilePaths(legacy).size).toBe(0);

  const mismatch = shelfUnshelveLifecycle(
    envelope("commandCompleted", { operationId: "another-id" }),
    "shelf",
    operationId,
  );
  expect(mismatch.state).toBe("unknown");
  expect(mismatch.commandCompleted).toBe(false);
  expect(confirmedFilePaths(mismatch).size).toBe(0);
});

it("only wire files can ever confirm rows; commandCompleted alone confirms none", () => {
  const completed = shelfUnshelveLifecycle(
    envelope("commandCompleted"),
    "shelf",
    operationId,
  );
  expect(completed.commandCompleted).toBe(true);
  expect(completed.files).toEqual([]);
  expect(confirmedFilePaths(completed).size).toBe(0);

  const withFacts = shelfUnshelveLifecycle(
    envelope("commandCompleted", {
      files: [
        { depotPath: "//depot/a", state: "succeeded", message: "wire" },
        { depotPath: "//depot/b", state: "unknown", message: "wire" },
      ],
    }),
    "shelf",
    operationId,
  );
  expect([...confirmedFilePaths(withFacts)]).toEqual(["//depot/a"]);
});

it("matches the exact dispatching connection (target client only for shelf)", () => {
  expect(workflowConnectionMatchesTarget(target, connection, "shelf")).toBe(
    true,
  );
  expect(
    workflowConnectionMatchesTarget(
      { ...target, client: "target-workspace" },
      connection,
      "unshelve",
    ),
  ).toBe(true);
  expect(
    workflowConnectionMatchesTarget(
      { ...target, client: "other" },
      connection,
      "shelf",
    ),
  ).toBe(false);
  expect(
    workflowConnectionMatchesTarget(
      { ...target, contextGeneration: 5 },
      connection,
      "shelf",
    ),
  ).toBe(false);
});

it("unknown recovery uses the same operationId once and never re-dispatches", async () => {
  const execute = vi.fn().mockResolvedValue(envelope("unknown"));
  const refresh = vi.fn().mockResolvedValue(undefined);
  const lookup = vi.fn().mockResolvedValue({
    kind: "found" as const,
    receipt: {
      operationId,
      kind: "shelf" as const,
      connection,
      payloadDigest: "b".repeat(64),
      revision: "3",
      state: "settled" as const,
      result: envelope("commandCompleted"),
    },
  });
  const run = await runShelfUnshelve(confirmation, "shelf", {
    connection,
    connectionKey: "connection-a",
    execute,
    lookup,
    refresh,
  });
  expect(execute).toHaveBeenCalledOnce();
  expect(lookup).toHaveBeenCalledExactlyOnceWith({ operationId, connection });
  expect(run.recovered).toBe(true);
  expect(run.lifecycle.state).toBe("commandCompleted");
  expect(refresh).toHaveBeenCalledOnce();
});

it("a transport failure is unknown, looks up by identity and keeps explicit uncertainty", async () => {
  const execute = vi.fn().mockRejectedValue(new Error("lost"));
  const refresh = vi.fn().mockResolvedValue(undefined);
  const lookup = vi.fn().mockResolvedValue({ kind: "notFound" as const });
  const run = await runShelfUnshelve(confirmation, "unshelve", {
    connection,
    connectionKey: "connection-a",
    execute,
    lookup,
    refresh,
  });
  expect(execute).toHaveBeenCalledOnce();
  expect(lookup).toHaveBeenCalledExactlyOnceWith({ operationId, connection });
  expect(run.lifecycle.state).toBe("unknown");
  expect(run.recovered).toBe(false);
  expect(refresh).toHaveBeenCalledOnce();
});

it("boundedRefresh uses the wire advice and bounded affected paths", async () => {
  invalidateData.mockClear();
  await boundedRefresh("connection-a", target, envelope("commandCompleted"));
  expect(invalidateData).toHaveBeenCalledExactlyOnceWith(
    ["pending", "workspaceStatus", "depot"],
    {
      connectionKey: "connection-a",
      refetchType: "active",
      affectedPaths: ["//depot/a"],
    },
  );
});
