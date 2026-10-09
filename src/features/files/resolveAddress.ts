import { backend } from "../../infrastructure/backend";
import type { WorkspaceNode } from "../../shared/contracts/types";
import { cleanAddress, parentPath, pathKey } from "./address";
import { workspaceCache, workspaceQuery } from "./workspaceQueries";

export async function resolveAddress(
  input: string,
  connection: string,
  root?: string,
): Promise<WorkspaceNode> {
  const path = cleanAddress(input);
  const same = (a: string, b: string) => pathKey(a) === pathKey(b);
  if (root && (same(path, root) || path === ".")) {
    return {
      id: root,
      name: root.split(/[\\/]/).pop() || root,
      kind: "directory",
      absolutePath: root,
      relativePath: "",
      state: "controlled",
    };
  }
  const resolved = await workspaceCache.fetchQuery({
    queryKey: ["resolved-address", connection, path],
    queryFn: () => backend.resolvePath({ input: path }),
    staleTime: 60_000,
  });
  if (resolved.found && resolved.absolutePath) {
    const directory = parentPath(resolved.absolutePath);
    const listing = await workspaceCache
      .fetchQuery(
        workspaceQuery(
          connection,
          root && same(directory, root) ? undefined : directory,
        ),
      )
      .catch((cause) => {
        if (path.startsWith("//"))
          return {
            items: [],
            completeness: "partial" as const,
            errors: [],
            operationIds: [],
            truncated: false,
            safetyLimit: 10_000,
            cacheFreshness: "fresh" as const,
          };
        throw cause;
      });
    const nodes = listing.items;
    const node = nodes.find((n) =>
      same(n.absolutePath, resolved.absolutePath!),
    );
    if (node) return node;
  }
  // A depot file may be mapped but not synced locally. Never invent a local copy.
  if (path.startsWith("//")) {
    const nodes = await workspaceCache.fetchQuery({
      queryKey: ["depot-files", connection, parentPath(path)],
      queryFn: () => backend.listDepotChildren(parentPath(path)),
    });
    const node = nodes.find((n) => same(n.depotPath, path));
    if (node)
      return {
        ...node,
        absolutePath: "",
        relativePath: node.depotPath,
        state: "missing",
      };
  }
  throw new Error(
    resolved.reason || "未找到文件或目录 / File or folder not found",
  );
}
