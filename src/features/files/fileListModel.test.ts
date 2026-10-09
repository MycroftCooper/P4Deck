import { expect, it } from "vitest";
import type { WorkspaceNode } from "../../shared/contracts/types";
import {
  depotNodeAsWorkspaceNode,
  filterWorkspaceNodes,
  searchWorkspaceNodes,
} from "./fileListModel";

const nodes: WorkspaceNode[] = [
  {
    id: "one",
    name: "Résumé-世界.txt",
    kind: "file",
    absolutePath: "C:\\workspace\\Résumé-世界.txt",
    relativePath: "Résumé-世界.txt",
    depotPath: "//depot/main/Résumé-世界.txt",
    state: "openedEdit",
  },
  {
    id: "two",
    name: "incoming.bin",
    kind: "file",
    absolutePath: "C:\\workspace\\incoming.bin",
    relativePath: "incoming.bin",
    state: "outOfDate",
  },
  {
    id: "three",
    name: "local.txt",
    kind: "file",
    absolutePath: "C:\\workspace\\local.txt",
    relativePath: "local.txt",
    state: "modified",
  },
  {
    id: "four",
    name: "not-synced.txt",
    kind: "file",
    absolutePath: "C:\\workspace\\not-synced.txt",
    relativePath: "not-synced.txt",
    state: "notSynced",
  },
];

it("filters file rows with the production status semantics", () => {
  expect(filterWorkspaceNodes(nodes, "changed").map((node) => node.id)).toEqual(
    ["one", "three"],
  );
  expect(
    filterWorkspaceNodes(nodes, "incoming").map((node) => node.id),
  ).toEqual(["two", "four"]);
  expect(filterWorkspaceNodes(nodes, "all")).not.toBe(nodes);
});

it("searches resource names case-insensitively without mutating input", () => {
  expect(searchWorkspaceNodes(nodes, "RÉSUMÉ").map((node) => node.id)).toEqual([
    "one",
  ]);
  expect(searchWorkspaceNodes(nodes, "世界").map((node) => node.id)).toEqual([
    "one",
  ]);
  expect(nodes).toHaveLength(4);
});

it("adapts depot nodes through the shared production mapper", () => {
  expect(
    depotNodeAsWorkspaceNode({
      id: "//depot/main/file.txt",
      name: "file.txt",
      kind: "file",
      depotPath: "//depot/main/file.txt",
    }),
  ).toMatchObject({
    absolutePath: "",
    relativePath: "//depot/main/file.txt",
    state: "missing",
  });
});
