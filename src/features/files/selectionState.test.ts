import { expect, it } from "vitest";
import type { WorkspaceNode } from "../../shared/contracts";
import { reconcileSelection } from "./selectionState";
const file: WorkspaceNode = {
  id: "remote",
  name: "a",
  kind: "file",
  state: "missing",
  absolutePath: "",
  relativePath: "a",
  depotPath: "//depot/a",
};
it("enriches selection by path rather than list-specific IDs", () => {
  const updated = {
    ...file,
    id: "local",
    absolutePath: "/work/a",
    state: "controlled" as const,
  };
  expect(
    reconcileSelection({ nodes: [file], primary: file }, [updated], updated),
  ).toEqual({ nodes: [updated], primary: updated });
});
it("rejects a late result after selection changed or cleared", () => {
  const empty = { nodes: [] };
  expect(reconcileSelection(empty, [file], file)).toBe(empty);
  const other = { ...file, depotPath: "//depot/b" };
  const current = { nodes: [other], primary: other };
  expect(reconcileSelection(current, [file], file)).toBe(current);
});
it("preserves identity for unchanged updates and does not collapse multi-selection", () => {
  const current = { nodes: [file], primary: file };
  expect(reconcileSelection(current, [file], file)).toBe(current);
  const multi = {
    nodes: [file, { ...file, depotPath: "//depot/b" }],
    primary: file,
  };
  expect(reconcileSelection(multi, [file], file)).toBe(multi);
});
