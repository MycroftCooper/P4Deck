import { expect, it } from "vitest";
import {
  beginFileLockProjection,
  fileLockProjectionsSnapshot,
  projectFileLockNodes,
  resetFileLockProjectionsForTests,
  settleFileLockProjection,
  withdrawFileLockProjection,
} from "./fileLockProjection";
import type { FileLockResult, WorkspaceNode } from "../../shared/contracts";

const node = (
  path: string,
  ownership: "unlocked" | "ours" | "other" | "unknown",
): WorkspaceNode =>
  ({
    id: path,
    name: "a",
    kind: "file",
    absolutePath: path,
    depotPath: path,
    relativePath: "",
    state: "controlled",
    status: {
      lockOwnership: ownership,
      lockOwner: ownership === "other" ? "other-user" : undefined,
    },
  }) as unknown as WorkspaceNode;
const result = (
  outcome: FileLockResult["outcome"],
  files: FileLockResult["files"],
  execution: FileLockResult["execution"] = {
    operationId: "op",
    outcome: "commandCompleted",
    perFileEvidence: "notCollected",
  },
): FileLockResult =>
  ({
    outcome,
    files,
    message: "",
    execution,
    refresh: {
      workspaceStatus: true,
      pendingChanges: false,
      search: false,
      review: false,
      depotPaths: [],
      localPaths: [],
      reason: "",
    },
  }) as unknown as FileLockResult;
const fact = (
  depotPath: string,
  outcome: FileLockResult["files"][number]["outcome"],
): FileLockResult["files"][number] => ({
  depotPath,
  outcome,
  message: "",
  ownership: outcome === "succeeded" ? "ours" : "unlocked",
});

it("lock projects ours immediately; already-other rows are not projected", () => {
  resetFileLockProjectionsForTests();
  beginFileLockProjection("op-lock", "lock", ["//d/a", "//d/other"], "scope-1");
  const rows = projectFileLockNodes(
    [node("//d/a", "unlocked"), node("//d/other", "other")],
    "scope-1",
  );
  expect(rows[0].status?.lockOwnership).toBe("ours");
  expect(rows[1].status?.lockOwnership).toBe("other");
  expect(
    projectFileLockNodes([node("//d/a", "unlocked")], "scope-2")[0].status
      ?.lockOwnership,
  ).toBe("unlocked");
  withdrawFileLockProjection("op-lock");
});
it("unlock projects unlocked immediately (owner cleared)", () => {
  resetFileLockProjectionsForTests();
  beginFileLockProjection("op-unlock", "unlock", ["//d/a"]);
  const rows = projectFileLockNodes([node("//d/a", "ours")]);
  expect(rows[0].status?.lockOwnership).toBe("unlocked");
  expect(rows[0].status?.lockOwner).toBeUndefined();
});
it("unknown withdraws at once; pre-dispatch rejection (no execution) withdraws and projects nothing", () => {
  resetFileLockProjectionsForTests();
  beginFileLockProjection("op-u", "lock", ["//d/a"]);
  expect(
    projectFileLockNodes([node("//d/a", "unlocked")])[0].status?.lockOwnership,
  ).toBe("ours");
  settleFileLockProjection(
    "op-u",
    result("unknown", [fact("//d/a", "unknown")]),
    false,
  );
  expect(fileLockProjectionsSnapshot()).toHaveLength(0);
  expect(
    projectFileLockNodes([node("//d/a", "unlocked")])[0].status?.lockOwnership,
  ).toBe("unlocked");
  beginFileLockProjection("op-r", "lock", ["//d/a"]);
  settleFileLockProjection(
    "op-r",
    {
      ...result("rejected", []),
      execution: undefined,
    } as unknown as FileLockResult,
    false,
  );
  expect(fileLockProjectionsSnapshot()).toHaveLength(0);
});
it("commandCompleted keeps projection until the bounded refetch succeeds", () => {
  resetFileLockProjectionsForTests();
  beginFileLockProjection("op-c", "lock", ["//d/a"]);
  settleFileLockProjection(
    "op-c",
    result("succeeded", [fact("//d/a", "succeeded")]),
    false,
  );
  expect(fileLockProjectionsSnapshot()[0].phase).toBe("confirmed");
  expect(
    projectFileLockNodes([node("//d/a", "unlocked")])[0].status?.lockOwnership,
  ).toBe("ours");
  settleFileLockProjection(
    "op-c",
    result("succeeded", [fact("//d/a", "succeeded")]),
    true,
  );
  expect(fileLockProjectionsSnapshot()).toHaveLength(0);
});
it("alreadySatisfied is authoritative and partial keeps only known-good rows", () => {
  resetFileLockProjectionsForTests();
  beginFileLockProjection("op-s", "lock", [
    "//d/ok",
    "//d/already",
    "//d/bad",
    "//d/unknown",
  ]);
  settleFileLockProjection(
    "op-s",
    result("partial", [
      fact("//d/ok", "succeeded"),
      fact("//d/already", "alreadySatisfied"),
      fact("//d/bad", "failed"),
      fact("//d/unknown", "unknown"),
    ]),
    false,
  );
  // any unknown row means the batch is uncertain -> withdraw (conservative, no fake success)
  expect(fileLockProjectionsSnapshot()).toHaveLength(0);
  beginFileLockProjection("op-p", "lock", ["//d/ok", "//d/bad"]);
  settleFileLockProjection(
    "op-p",
    result("partial", [fact("//d/ok", "succeeded"), fact("//d/bad", "failed")]),
    false,
  );
  expect(fileLockProjectionsSnapshot()[0].paths).toEqual(["//d/ok"]);
  expect(
    projectFileLockNodes([node("//d/bad", "unlocked")])[0].status
      ?.lockOwnership,
  ).toBe("unlocked");
});
