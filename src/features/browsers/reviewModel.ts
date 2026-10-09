import type {
  FileReviewScope,
  FileRevision,
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
    revisions[0].depotPath !== revisions[1].depotPath
  )
    return undefined;
  const [left, right] = [...revisions].sort((a, b) => a.revision - b.revision);
  return {
    left: { kind: "revision", revision: left.revision },
    right: { kind: "revision", revision: right.revision },
  };
}
