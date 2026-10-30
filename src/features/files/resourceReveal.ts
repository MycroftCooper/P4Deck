import { pathKey } from "./address";
import { resourceNodePath, type ResourceFolder } from "./resourceTree";
export interface ResourceReveal {
  id: number;
  connectionKey: string;
  path: string;
}
/** Follow only actual cached ancestors; never invent depot-to-local mappings. */
export function nextRevealStep(
  path: string,
  folders: ReadonlyMap<string, ResourceFolder>,
  expanded: ReadonlySet<string>,
):
  | { kind: "wait" }
  | { kind: "error"; message: string }
  | { kind: "expand" | "found"; path: string } {
  const target = pathKey(path);
  let parent = "";
  const visited = new Set<string>();
  while (!visited.has(parent)) {
    visited.add(parent);
    const folder = folders.get(parent);
    if (folder?.error) return { kind: "error", message: folder.error };
    if (!folder?.loaded || folder.loading) return { kind: "wait" };
    const exact = folder.items.find(
      (node) => pathKey(resourceNodePath(node, "workspace")) === target,
    );
    if (exact)
      return { kind: "found", path: resourceNodePath(exact, "workspace") };
    const ancestor = folder.items
      .filter(
        (node) =>
          node.kind === "directory" &&
          target.startsWith(pathKey(resourceNodePath(node, "workspace")) + "/"),
      )
      .sort((a, b) => b.absolutePath.length - a.absolutePath.length)[0];
    if (!ancestor)
      return {
        kind: "error",
        message:
          folder.warning ||
          "目标不在已加载的工作区目录中 / Target is not in the workspace listing",
      };
    parent = resourceNodePath(ancestor, "workspace");
    if (!expanded.has(parent)) return { kind: "expand", path: parent };
  }
  return {
    kind: "error",
    message: "目录路径循环，无法定位 / Directory path cycle",
  };
}
