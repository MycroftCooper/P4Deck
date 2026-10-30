import type {
  RevisionGraph,
  RevisionGraphEdge,
  RevisionGraphNode,
} from "../../shared/contracts";

export type GraphFocusMode = "target" | "sources";
export const GRAPH_BUDGET = 20;
export const GRAPH_DEPTH = 8;
const MAX_STEPS = 4000;

/** filelog ranges refer to the related file: source for from, target for into. */
export function edgeIncludesSource(
  edge: RevisionGraphEdge,
  node: RevisionGraphNode,
  index: Map<string, RevisionGraphNode>,
) {
  if (edge.kind === "revision") return false;
  const source = index.get(edge.source);
  if (!source || source.depotPath !== node.depotPath) return false;
  if (/\bfrom\b/i.test(edge.relationship)) {
    // Raw filelog start is exclusive (srev), end is inclusive (erev).
    return edge.startRevision !== undefined && edge.endRevision !== undefined
      ? node.revision > edge.startRevision && node.revision <= edge.endRevision
      : source.id === node.id;
  }
  return source.id === node.id;
}

export function focusEvidence(
  graph: RevisionGraph,
  sourceId: string,
  targetPath: string,
  mode: GraphFocusMode,
) {
  const index = new Map(graph.nodes.map((n) => [n.id, n]));
  const source = index.get(sourceId);
  const evidence = new Map<string, RevisionGraphEdge>();
  const paths: RevisionGraphEdge[][] = [];
  const queue: { node: RevisionGraphNode; chain: RevisionGraphEdge[] }[] =
    source ? [{ node: source, chain: [] }] : [];
  const seen = new Set<string>();
  let steps = 0,
    limited = false;
  while (queue.length) {
    const item = queue.shift()!;
    if (seen.has(item.node.id)) continue;
    seen.add(item.node.id);
    if (item.chain.length >= GRAPH_DEPTH) {
      limited = true;
      continue;
    }
    for (const edge of graph.edges) {
      if (++steps > MAX_STEPS) {
        limited = true;
        break;
      }
      if (edge.kind === "revision") {
        if (mode === "sources" && edge.target === item.node.id) {
          const previous = index.get(edge.source);
          if (previous)
            queue.push({ node: previous, chain: [...item.chain, edge] });
        }
        continue;
      }
      const relevant =
        mode === "target"
          ? edgeIncludesSource(edge, item.node, index)
          : edge.target === item.node.id;
      if (!relevant) continue;
      const next = index.get(mode === "target" ? edge.target : edge.source);
      if (!next) continue;
      const chain = [...item.chain, edge];
      // Ignored / undo relations are still evidence to show, never a positive merge claim.
      if (mode === "sources" || next.depotPath === targetPath) {
        paths.push(chain);
        chain.forEach((e) => evidence.set(e.id, e));
      }
      if (
        !/ignor|undid|undo|delete/i.test(edge.relationship + " " + next.action)
      )
        queue.push({ node: next, chain });
    }
    if (steps > MAX_STEPS) break;
  }
  const edges = [...evidence.values()];
  const relevantPaths = new Set(
    [source?.depotPath, mode === "target" ? targetPath : ""].filter(
      Boolean,
    ) as string[],
  );
  edges.forEach((e) => {
    for (const id of [e.source, e.target]) {
      const n = index.get(id);
      if (n) relevantPaths.add(n.depotPath);
    }
  });
  return {
    edges,
    paths,
    relevantPaths,
    limited,
    incomplete: graph.partial || graph.hasMore || graph.truncated || limited,
    caution:
      edges.some((e) => /ignor|undid|undo|delete/i.test(e.relationship)) ||
      graph.nodes.some(
        (n) =>
          relevantPaths.has(n.depotPath) && /delete|purge|undo/i.test(n.action),
      ),
  };
}

/** Re-layout only visible lanes; never mutate server coordinates or fabricate edges. */
export function projectGraph(graph: RevisionGraph, paths: Set<string>) {
  const lanes = [...paths]
    .filter((p) => graph.nodes.some((n) => n.depotPath === p))
    .sort();
  const nodes = graph.nodes
    .filter((n) => paths.has(n.depotPath))
    .sort(
      (a, b) =>
        a.changelistId - b.changelistId ||
        a.revision - b.revision ||
        a.id.localeCompare(b.id),
    );
  const projected = nodes.map((node, i) => ({
    ...node,
    x: 100 + i * 110,
    y: 80 + lanes.indexOf(node.depotPath) * 130,
  }));
  const ids = new Set(projected.map((n) => n.id));
  return {
    ...graph,
    nodes: projected,
    edges: graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
    lanes,
  };
}

export function validGraphPath(path: string) {
  return (
    /^\/\/[^/]+\/.+/.test(path) &&
    !/[\r\n\0@#*]/.test(path) &&
    !path.includes("...") &&
    !path.endsWith("/")
  );
}
