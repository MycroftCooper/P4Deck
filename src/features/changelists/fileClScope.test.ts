import { expect, it } from "vitest";
import { fileClScope } from "./fileClScope";
import type { PendingChange, WorkspaceNode } from "../../shared/contracts";
const nodes: WorkspaceNode[] = ["a", "b"].map((name) => ({
  id: name,
  name,
  kind: "file",
  state: "openedEdit",
  absolutePath: `/work/${name}`,
  relativePath: name,
  depotPath: `//depot/${name}`,
}));
const changes: PendingChange[] = [0, 10].map((id, index) => ({
  id,
  description: "CL",
  user: "tester",
  client: "workspace",
  status: "pending",
  jobs: [],
  files: [
    { depotPath: nodes[index].depotPath!, action: "edit", state: "openedEdit" },
  ],
  shelvedFiles: [],
}));
it("resolves explicit file membership across multiple CLs without widening scope", () => {
  const scope = fileClScope([nodes[1], nodes[0], nodes[1]], changes);
  expect(scope.paths).toEqual(["//depot/b", "//depot/a"]);
  expect(scope.origins).toEqual({ "//depot/a": 0, "//depot/b": 10 });
  expect(scope.unknown).toEqual([]);
});
it("does not trust stale node changelist IDs or ambiguous/missing membership", () => {
  const scope = fileClScope(
    [{ ...nodes[0], changelistId: 999 }, nodes[1]],
    [changes[0], { ...changes[0], id: 20 }],
  );
  expect(scope.unknown).toEqual(["//depot/a", "//depot/b"]);
  expect(scope.ids).toEqual([]);
});
