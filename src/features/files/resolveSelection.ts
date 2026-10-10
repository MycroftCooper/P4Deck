import type { WorkspaceNode } from "../../shared/contracts/types";
import { backend } from "../../infrastructure/backend";
import { parentPath, pathKey } from "./address";
import { workspaceCache, workspaceQuery } from "./workspaceQueries";
import { nodeKey } from "./selection";

/** Hydrate by directory, never one P4 request per selected row. Bound concurrent directories to four. */
export async function resolveSelection(
  nodes: WorkspaceNode[],
  connection: string,
  root?: string,
  refresh = false,
) {
  const groups = new Map<string, WorkspaceNode[]>();
  for (const node of nodes) {
    if (!node.absolutePath && !node.depotPath) continue;
    if (
      (!refresh && node.absolutePath) ||
      (root && pathKey(node.absolutePath) === pathKey(root))
    )
      continue;
    const parent = parentPath(node.absolutePath || node.depotPath || "");
    const group = groups.get(parent) ?? [];
    group.push(node);
    groups.set(parent, group);
  }
  const pending = [...groups.entries()];
  const replacements = new Map<string, WorkspaceNode>();
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const [parent, group] = pending[cursor++];
      try {
        let directory = parent;
        if (parent.startsWith("//")) {
          const mapped = await workspaceCache.fetchQuery({
            queryKey: ["resolved-address", connection, parent],
            queryFn: () => backend.resolvePath({ input: parent }),
            staleTime: 60_000,
          });
          if (!mapped.found || !mapped.absolutePath) continue;
          directory = mapped.absolutePath;
        }
        const listing = await workspaceCache.fetchQuery(
          workspaceQuery(
            connection,
            root && pathKey(directory) === pathKey(root)
              ? undefined
              : directory,
            refresh,
          ),
        );
        const children = listing.items;
        const byName = new Map(children.map((n) => [n.name, n]));
        for (const old of group) {
          const found = byName.get(old.name);
          if (found)
            replacements.set(nodeKey(old), {
              ...found,
              depotPath: found.depotPath || old.depotPath,
            });
          else if (refresh && old.kind === "file")
            replacements.set(nodeKey(old), {
              ...old,
              state: "missing",
              absolutePath: "",
            });
        }
      } catch {
        /* Unmapped/offline/unsynced targets remain depot-only. Never invent local files. */
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(4, pending.length) }, worker),
  );
  return nodes.map((node) => replacements.get(nodeKey(node)) ?? node);
}
