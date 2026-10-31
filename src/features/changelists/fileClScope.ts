import type { PendingChange, WorkspaceNode } from "../../shared/contracts";
export function fileClScope(nodes: WorkspaceNode[], changes: PendingChange[]) {
  const membership = new Map<string, number[]>();
  for (const change of changes)
    for (const file of change.files)
      membership.set(file.depotPath, [
        ...(membership.get(file.depotPath) ?? []),
        change.id,
      ]);
  const paths = [
    ...new Set(nodes.map((node) => node.depotPath || node.absolutePath)),
  ];
  const unknown = paths.filter((path) => membership.get(path)?.length !== 1);
  const origins = Object.fromEntries(
    paths
      .filter((path) => membership.get(path)?.length === 1)
      .map((path) => [path, membership.get(path)![0]]),
  );
  return { paths, unknown, origins, ids: [...new Set(Object.values(origins))] };
}
