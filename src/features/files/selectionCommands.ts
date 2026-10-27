import type {
  FileActionRequest,
  WorkspaceNode,
} from "../../shared/contracts/types";
import { pathKey } from "./address";
import { nodeKey } from "./selection";

/**
 * P4 usually reports depot paths, while Workspace cache keys use local paths.
 * Add the selected nodes' local aliases so scoped invalidation reaches both.
 */
export function affectedPathAliases(
  affectedPaths: readonly string[] | undefined,
  nodes: readonly WorkspaceNode[],
) {
  if (!affectedPaths?.length) return affectedPaths;
  const paths = new Set(affectedPaths);
  for (const node of nodes) {
    if (node.depotPath) paths.add(node.depotPath);
    if (node.absolutePath) paths.add(node.absolutePath);
  }
  return [...paths];
}

/** Collapse child targets covered by an explicitly selected ancestor, using both path namespaces. */
export function compactTargets(nodes: WorkspaceNode[]) {
  const unique = [...new Map(nodes.map((n) => [nodeKey(n), n])).values()];
  const localFolders = new Set(
    unique
      .filter((n) => n.kind === "directory" && n.absolutePath)
      .map((n) => pathKey(n.absolutePath)),
  );
  const depotFolders = new Set(
    unique
      .filter((n) => n.kind === "directory" && n.depotPath)
      .map((n) => n.depotPath!.replace(/\/$/, "")),
  );
  const hasAncestor = (path: string, folders: Set<string>) => {
    for (
      let i = path.lastIndexOf("/");
      i >= 0;
      i = path.lastIndexOf("/", i - 1)
    ) {
      if (folders.has(path.slice(0, i))) return true;
      if (i === 0) break;
    }
    return false;
  };
  return unique.filter(
    (node) =>
      !(
        node.absolutePath &&
        hasAncestor(pathKey(node.absolutePath), localFolders)
      ) && !(node.depotPath && hasAncestor(node.depotPath, depotFolders)),
  );
}
function filespec(node: WorkspaceNode, localOnly = false) {
  // Depot paths already contain P4 escaping; local OS paths do not.
  const local = node.absolutePath;
  const base =
    !localOnly && node.depotPath
      ? node.depotPath
      : local
          .replaceAll("%", "%25")
          .replaceAll("#", "%23")
          .replaceAll("@", "%40")
          .replaceAll("*", "%2A");
  if (!base) throw new Error("Target has no usable path");
  if (node.kind === "directory") {
    if (base.includes("..."))
      throw new Error("目录路径含有不明确的 P4 通配符 / Ambiguous folder path");
    return base.replace(/[\\/]$/, "") + "/...";
  }
  return base;
}
export function selectionRequest(
  action:
    | "getLatest"
    | "getRevision"
    | "checkout"
    | "add"
    | "delete"
    | "revert"
    | "revertUnchanged",
  nodes: WorkspaceNode[],
  operationId?: string,
  wholeChangelistId?: number,
): FileActionRequest {
  const targets = compactTargets(nodes);
  if (!targets.length) throw new Error("No selected targets");
  const recursiveAdd =
    action === "add" && targets.some((n) => n.kind === "directory");
  return {
    operationId,
    action: recursiveAdd
      ? "addRecursive"
      : action === "delete"
        ? "markForDelete"
        : action,
    paths: targets.map((n) =>
      action === "add" && !recursiveAdd
        ? n.absolutePath
        : filespec(n, recursiveAdd),
    ),
    states: targets.map((n) => n.state),
    ...(action === "revert" && wholeChangelistId !== undefined
      ? {
          changelistId: wholeChangelistId,
          revertWholeChangelist: true,
        }
      : action === "revertUnchanged" &&
          targets[0].changelistId !== undefined &&
          targets.every((n) => n.changelistId === targets[0].changelistId)
        ? { changelistId: targets[0].changelistId }
        : {}),
  };
}
