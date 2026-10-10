import type {
  StreamGraphEdge,
  StreamGraphNode,
  StreamGraphResult,
} from "../../shared/contracts/types";

export type StreamGraphRelation =
  "root" | "child" | "orphan" | "unloadedParent";

export interface StreamGraphRow {
  node: StreamGraphNode;
  depth: number;
  relation: StreamGraphRelation;
  parentIndex?: number;
  childIndices: number[];
  siblingIndex: number;
  siblingCount: number;
}

const comparePath = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

export function mergeStreamGraphResults(
  current: StreamGraphResult,
  page: StreamGraphResult,
): StreamGraphResult {
  const nodes = new Map(current.nodes.map((node) => [node.stream, node]));
  for (const node of page.nodes)
    if (!nodes.has(node.stream)) nodes.set(node.stream, node);
  const edges = new Map(
    current.edges.map((edge) => [`${edge.parent}\n${edge.child}`, edge]),
  );
  for (const edge of page.edges)
    edges.set(`${edge.parent}\n${edge.child}`, edge);
  return {
    ...page,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    roots: [...new Set([...current.roots, ...page.roots])],
    orphans: [...new Set([...current.orphans, ...page.orphans])],
    stats: { ...page.stats, returnedCount: nodes.size },
    operationIds: [...new Set([...current.operationIds, ...page.operationIds])],
    partial: current.partial || page.partial,
    truncated: current.truncated || page.truncated,
    simulated: current.simulated || page.simulated,
  };
}

export function layoutStreamGraph(
  nodes: StreamGraphNode[],
  edges: StreamGraphEdge[],
  roots: string[],
  orphans: string[],
): StreamGraphRow[] {
  const byPath = new Map(nodes.map((node) => [node.stream, node]));
  const explicitRoots = new Set(roots);
  const explicitOrphans = new Set(orphans);
  const parentByChild = new Map<string, string>();
  const childrenByParent = new Map<string, string[]>();
  for (const edge of [...edges].sort((left, right) => {
    const child = comparePath(left.child, right.child);
    return child || comparePath(left.parent, right.parent);
  })) {
    if (!byPath.has(edge.child) || !byPath.has(edge.parent)) continue;
    if (parentByChild.has(edge.child)) continue;
    parentByChild.set(edge.child, edge.parent);
    const children = childrenByParent.get(edge.parent) ?? [];
    children.push(edge.child);
    childrenByParent.set(edge.parent, children);
  }
  for (const children of childrenByParent.values()) children.sort(comparePath);

  const startPaths = nodes
    .filter(
      (node) =>
        explicitRoots.has(node.stream) ||
        explicitOrphans.has(node.stream) ||
        !parentByChild.has(node.stream),
    )
    .map((node) => node.stream)
    .sort(comparePath);
  const ordered: Array<{
    path: string;
    depth: number;
    relation: StreamGraphRelation;
  }> = [];
  const seen = new Set<string>();
  const visit = (
    path: string,
    depth: number,
    relation: StreamGraphRelation,
  ) => {
    if (seen.has(path) || !byPath.has(path)) return;
    seen.add(path);
    ordered.push({ path, depth, relation });
    for (const child of childrenByParent.get(path) ?? [])
      visit(child, depth + 1, "child");
  };
  for (const path of startPaths) {
    const node = byPath.get(path)!;
    visit(
      path,
      0,
      explicitOrphans.has(path)
        ? "orphan"
        : node.parent && !byPath.has(node.parent)
          ? "unloadedParent"
          : "root",
    );
  }
  for (const path of [...byPath.keys()].sort(comparePath))
    visit(path, 0, explicitOrphans.has(path) ? "orphan" : "unloadedParent");

  const indexByPath = new Map(
    ordered.map(({ path }, index) => [path, index] as const),
  );
  return ordered.map(({ path, depth, relation }) => {
    const node = byPath.get(path)!;
    const parent = parentByChild.get(path);
    const siblings = parent ? (childrenByParent.get(parent) ?? []) : startPaths;
    return {
      node,
      depth,
      relation,
      parentIndex: parent ? indexByPath.get(parent) : undefined,
      childIndices: (childrenByParent.get(path) ?? []).flatMap((child) => {
        const index = indexByPath.get(child);
        return index === undefined ? [] : [index];
      }),
      siblingIndex: Math.max(0, siblings.indexOf(path)),
      siblingCount: Math.max(1, siblings.length),
    };
  });
}

export function streamGraphError(cause: unknown): {
  code?: string;
  message: string;
} {
  if (cause && typeof cause === "object") {
    const value = cause as { code?: unknown; message?: unknown };
    return {
      code: typeof value.code === "string" ? value.code : undefined,
      message:
        typeof value.message === "string" ? value.message : String(cause),
    };
  }
  return { message: String(cause) };
}
