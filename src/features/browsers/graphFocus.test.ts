import { describe, expect, it } from "vitest";
import type {
  RevisionGraph,
  RevisionGraphNode,
  RevisionGraphEdge,
} from "../../shared/contracts";
import {
  edgeIncludesSource,
  focusEvidence,
  projectGraph,
  validGraphPath,
} from "./graphFocus";
const node = (path: string, revision: number): RevisionGraphNode => ({
  id: path + "#" + revision,
  depotPath: path,
  revision,
  changelistId: revision * 100,
  action: "edit",
  fileType: "text",
  label: "#" + revision,
  x: 0,
  y: 0,
  missing: false,
});
const a = node("//d/main/f", 7),
  aEnd = node("//d/main/f", 9),
  b = node("//d/dev/f", 3),
  c = node("//d/release/f", 4),
  other = node("//d/unrelated/f", 1);
const edge = (
  source: RevisionGraphNode,
  target: RevisionGraphNode,
  start = 0,
): RevisionGraphEdge => ({
  id: source.id + target.id,
  source: source.id,
  target: target.id,
  kind: "merge",
  relationship: "merge from",
  startRevision: start,
  endRevision: source.revision,
});
const graph: RevisionGraph = {
  nodes: [a, aEnd, b, c, other],
  edges: [edge(aEnd, b, 6), edge(b, c)],
  hasMore: false,
  partial: false,
  truncated: false,
  operationIds: [],
};
describe("bounded integration evidence (never a content verdict)", () => {
  it("matches source ranges and includes only target and necessary intermediate lanes", () => {
    const result = focusEvidence(graph, a.id, c.depotPath, "target");
    expect(result.paths[0]).toHaveLength(2);
    expect([...result.relevantPaths]).toEqual(
      expect.arrayContaining([a.depotPath, b.depotPath, c.depotPath]),
    );
    expect(result.relevantPaths.has(other.depotPath)).toBe(false);
    expect(
      focusEvidence(graph, a.id, "//missing/f", "target").edges,
    ).toHaveLength(0);
  });
  it("does not interpret an into target range as source history", () => {
    const index = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(
      edgeIncludesSource(
        { ...edge(aEnd, b, 6), relationship: "merge into" },
        a,
        index,
      ),
    ).toBe(false);
    expect(edgeIncludesSource(edge(aEnd, b, 7), a, index)).toBe(false);
  });
  it("shows ignored evidence but does not propagate it to a positive downstream path", () => {
    const ignored = {
      ...graph,
      edges: [
        { ...graph.edges[0], relationship: "ignored from" },
        graph.edges[1],
      ],
    };
    expect(focusEvidence(ignored, a.id, b.depotPath, "target").caution).toBe(
      true,
    );
    expect(
      focusEvidence(ignored, a.id, c.depotPath, "target").edges,
    ).toHaveLength(0);
    expect(
      focusEvidence({ ...graph, partial: true }, a.id, c.depotPath, "target")
        .incomplete,
    ).toBe(true);
  });
  it("traces origins and restores original data after hide/solo without fetching", () => {
    expect(focusEvidence(graph, c.id, "", "sources").edges).toHaveLength(2);
    const solo = projectGraph(graph, new Set([b.depotPath]));
    expect(solo.nodes).toHaveLength(1);
    expect(solo.edges).toHaveLength(0);
    const restored = projectGraph(
      graph,
      new Set(graph.nodes.map((n) => n.depotPath)),
    );
    expect(restored.nodes).toHaveLength(graph.nodes.length);
    expect(new Set(restored.nodes.map((n) => `${n.x},${n.y}`)).size).toBe(
      graph.nodes.length,
    );
    expect(graph.nodes.every((n) => n.x === 0)).toBe(true);
  });
  it("terminates cycles and rejects broad/ambiguous query paths", () => {
    expect(
      focusEvidence(
        { ...graph, edges: [...graph.edges, edge(c, a)] },
        a.id,
        c.depotPath,
        "target",
      ).edges.length,
    ).toBeLessThan(10);
    for (const path of ["//d/...", "//d/*", "//d/", "//d/f#7", "//d/f@42"])
      expect(validGraphPath(path)).toBe(false);
    expect(validGraphPath("//d/main/f")).toBe(true);
  });
});

it("marks bounded long traces incomplete instead of asserting no merge", () => {
  const nodes = Array.from({ length: 12 }, (_, i) =>
    node(`//d/branch${i}/f`, i + 1),
  );
  const edges = nodes.slice(1).map((n, i) => edge(nodes[i], n));
  const result = focusEvidence(
    { ...graph, nodes, edges },
    nodes[0].id,
    nodes[11].depotPath,
    "target",
  );
  expect(result.limited).toBe(true);
  expect(result.incomplete).toBe(true);
  expect(result.edges).toHaveLength(0);
});
