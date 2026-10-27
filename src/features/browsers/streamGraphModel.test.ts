import { describe, expect, it } from "vitest";
import type {
  StreamGraphNode,
  StreamGraphResult,
} from "../../shared/contracts/types";
import {
  isStreamGraphSnapshot,
  layoutStreamGraph,
  mergeStreamGraphResults,
} from "./streamGraphModel";

const node = (
  stream: string,
  parent?: string,
  values: Partial<StreamGraphNode> = {},
): StreamGraphNode => ({
  stream,
  parent,
  flowOptions: {},
  ...values,
});

const page = (
  nodes: StreamGraphNode[],
  cursor?: string,
): StreamGraphResult => ({
  requestGeneration: 1,
  scope: {
    contextGeneration: 1,
    server: "ssl:1666",
    user: "alice",
    client: "atlas-dev",
  },
  nodes,
  edges: nodes.flatMap((item) =>
    item.parent ? [{ parent: item.parent, child: item.stream }] : [],
  ),
  roots: nodes.filter((item) => !item.parent).map((item) => item.stream),
  orphans: [],
  hasMore: !!cursor,
  nextCursor: cursor,
  partial: false,
  truncated: false,
  stats: {
    scannedCount: nodes.length,
    matchedCount: nodes.length,
    returnedCount: nodes.length,
    duplicateCount: 0,
    invalidRelationCount: 0,
    safetyLimit: 5000,
  },
  operationIds: [],
  cacheFreshness: "fresh",
  simulated: false,
});

describe("stream graph view projection", () => {
  it("rejects malformed disk snapshots before graph layout reads them", () => {
    const valid = page([node("//streams/main")]);
    expect(isStreamGraphSnapshot(valid)).toBe(true);
    for (const value of [
      null,
      {},
      { ...valid, nodes: [null] },
      { ...valid, nodes: [{ stream: "//streams/main" }] },
      { ...valid, edges: [null] },
      { ...valid, roots: [null] },
      { ...valid, stats: {} },
      { ...valid, scope: { server: "other" } },
    ])
      expect(isStreamGraphSnapshot(value)).toBe(false);
  });

  it("lays out roots, children and explicit or unloaded orphans deterministically", () => {
    const nodes = [
      node("//depot/release", "//depot/main", { kind: "release" }),
      node("//depot/orphan", "//missing/main", { kind: "unknown" }),
      node("//depot/main", undefined, { kind: "mainline" }),
      node("//depot/dev", "//depot/main", { deleted: true }),
      node("//depot/paged", "//depot/later"),
    ];
    const rows = layoutStreamGraph(
      nodes,
      [
        { parent: "//depot/release", child: "//depot/dev" },
        { parent: "//depot/main", child: "//depot/release" },
        { parent: "//depot/main", child: "//depot/dev" },
        { parent: "//depot/later", child: "//depot/paged" },
      ],
      ["//depot/main"],
      ["//depot/orphan"],
    );
    expect(
      rows.map(({ node: value, depth, relation }) => [
        value.stream,
        depth,
        relation,
      ]),
    ).toEqual([
      ["//depot/main", 0, "root"],
      ["//depot/dev", 1, "child"],
      ["//depot/release", 1, "child"],
      ["//depot/orphan", 0, "orphan"],
      ["//depot/paged", 0, "unloadedParent"],
    ]);
    expect(rows[0].childIndices).toEqual([1, 2]);
    expect(rows[1].parentIndex).toBe(0);
    expect(rows[1].node.deleted).toBe(true);
    expect(rows[3].node.kind).toBe("unknown");
  });

  it("merges stable pages without duplicating nodes, edges or operations", () => {
    const first = {
      ...page([node("//depot/main")], "opaque-1"),
      operationIds: ["one"],
    };
    const second = {
      ...page([node("//depot/main"), node("//depot/dev", "//depot/main")]),
      roots: [],
      operationIds: ["one", "two"],
      cacheFreshness: "cached" as const,
    };
    const merged = mergeStreamGraphResults(first, second);
    expect(merged.nodes.map((item) => item.stream)).toEqual([
      "//depot/main",
      "//depot/dev",
    ]);
    expect(merged.edges).toEqual([
      { parent: "//depot/main", child: "//depot/dev" },
    ]);
    expect(merged.operationIds).toEqual(["one", "two"]);
    expect(merged.stats.returnedCount).toBe(2);
  });
});
