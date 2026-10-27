import type {
  FileReviewScope,
  FileRevision,
  RevisionGraph,
  RevisionGraphEdge,
  RevisionGraphNode,
  RevisionReference,
  RuntimeInfo,
} from "../../shared/contracts/types";

export function makeReviewScope(
  runtime: RuntimeInfo,
  fileIdentity: string,
): FileReviewScope {
  return {
    server: runtime.context.server,
    user: runtime.context.user,
    client: runtime.context.client,
    workspace: runtime.context.cwd ?? "",
    activeProfileId: runtime.activeProfileId,
    contextGeneration: runtime.contextGeneration,
    fileIdentity,
  };
}

function graphEdgeIdentity(edge: RevisionGraphEdge): string {
  return [
    edge.source,
    edge.target,
    edge.kind,
    edge.relationship,
    edge.startRevision ?? "",
    edge.endRevision ?? "",
  ].join("\0");
}

export function mergeRevisionGraphs(
  current: RevisionGraph,
  incoming: RevisionGraph,
): RevisionGraph {
  const nodes = new Map(current.nodes.map((node) => [node.id, node]));
  for (const node of incoming.nodes) {
    const existing = nodes.get(node.id);
    if (!existing || (existing.missing && !node.missing))
      nodes.set(node.id, node);
  }
  const edges = new Map<string, RevisionGraphEdge>();
  for (const edge of [...current.edges, ...incoming.edges]) {
    const identity = graphEdgeIdentity(edge);
    if (!edges.has(identity)) edges.set(identity, { ...edge, id: identity });
  }
  const mergedNodes = [...nodes.values()];
  return {
    nodes: mergedNodes,
    edges: [...edges.values()],
    nextCursor: incoming.nextCursor,
    hasMore: incoming.hasMore,
    partial: mergedNodes.some((node) => node.missing),
    truncated: current.truncated || incoming.truncated,
    operationIds: [
      ...new Set([...current.operationIds, ...incoming.operationIds]),
    ],
  };
}

export function mergeHistoryRows(
  current: FileRevision[],
  incoming: FileRevision[],
): FileRevision[] {
  const seen = new Set(
    current.map((revision) => `${revision.depotPath}\0${revision.revision}`),
  );
  return [
    ...current,
    ...incoming.filter((revision) =>
      seen.has(`${revision.depotPath}\0${revision.revision}`)
        ? false
        : (seen.add(`${revision.depotPath}\0${revision.revision}`), true),
    ),
  ];
}

export function graphNodeDiffPair(
  node: RevisionGraphNode,
): { left: RevisionReference; right: RevisionReference } | undefined {
  if (node.missing || node.revision < 2) return undefined;
  return {
    left: { kind: "revision", revision: node.revision - 1 },
    right: { kind: "revision", revision: node.revision },
  };
}

export function historyDiffPair(
  revisions: FileRevision[],
): { left: RevisionReference; right: RevisionReference } | undefined {
  if (
    revisions.length !== 2 ||
    !revisions[0].depotPath ||
    revisions.some(
      (item) => !Number.isSafeInteger(item.revision) || item.revision < 1,
    ) ||
    revisions[0].revision === revisions[1].revision ||
    revisions[0].depotPath !== revisions[1].depotPath
  )
    return undefined;
  const [left, right] = [...revisions].sort((a, b) => a.revision - b.revision);
  return {
    left: { kind: "revision", revision: left.revision },
    right: { kind: "revision", revision: right.revision },
  };
}

/** Right-clicking a selected revision keeps FIFO order; a new target is appended. */
export function historyMenuQueue(
  selected: FileRevision[],
  clicked: FileRevision,
) {
  return selected.some(
    (item) =>
      item.depotPath === clicked.depotPath &&
      item.revision === clicked.revision,
  )
    ? selected
    : [...selected, clicked].slice(-2);
}
