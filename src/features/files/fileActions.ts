import {
  Clock3,
  Code2,
  FilePlus2,
  FileX2,
  GitBranch,
  RefreshCw,
  RotateCcw,
  SquarePen,
  CloudDownload,
} from "lucide-react";
import type { FileAction, WorkspaceNode } from "../../shared/contracts";
import type { messages } from "../../shared/i18n";
type T = (typeof messages)[keyof typeof messages];
export const fileActions: {
  id: FileAction;
  icon: typeof RefreshCw;
  key: keyof T;
}[] = [
  { id: "refresh", icon: RefreshCw, key: "refresh" },
  { id: "getLatest", icon: CloudDownload, key: "getLatest" },
  { id: "getRevision", icon: Clock3, key: "getRevision" },
  { id: "checkout", icon: SquarePen, key: "checkout" },
  { id: "add", icon: FilePlus2, key: "add" },
  { id: "delete", icon: FileX2, key: "delete" },
  { id: "revert", icon: RotateCcw, key: "revert" },
  { id: "diff", icon: Code2, key: "diff" },
  { id: "history", icon: Clock3, key: "history" },
  { id: "revisionGraph", icon: GitBranch, key: "revGraph" },
];

export function isFileActionAllowed(
  action: FileAction,
  state?: WorkspaceNode["state"],
) {
  if (action === "refresh") return true;
  if (!state) return false;
  if (state === "unknown") return false;
  if (state === "untracked") return ["add", "delete"].includes(action);
  if (state === "ignored") return action === "deleteLocal";
  if (state === "modified")
    return [
      "checkout",
      "reconcile",
      "diff",
      "history",
      "revisionGraph",
    ].includes(action);
  if (state === "notSynced")
    return ["getLatest", "getRevision", "history", "revisionGraph"].includes(
      action,
    );
  if (state === "openedAdd")
    return ["revert", "diff", "delete"].includes(action);
  if (state === "openedDelete")
    return ["revert", "history", "revisionGraph"].includes(action);
  if (state === "openedMoveAdd" || state === "openedMoveDelete")
    return ["revert", "diff", "history", "revisionGraph"].includes(action);
  if (state === "conflicted")
    return ["diff", "history", "revisionGraph", "revert"].includes(action);
  if (state === "openedEdit")
    return [
      "getLatest",
      "delete",
      "revert",
      "diff",
      "history",
      "revisionGraph",
    ].includes(action);
  return action !== "add" && action !== "revert";
}

/**
 * The primary state intentionally keeps an opened action above sync state, so
 * "opened for edit" can still be behind depot. Get Latest must not be gated
 * only by the primary state: an opened file with have < head is syncable.
 */
export function nodeNeedsSync(
  node: Pick<WorkspaceNode, "status" | "revision" | "headRevision">,
) {
  const sync = node.status?.sync;
  if (sync === "outOfDate" || sync === "notSynced") return true;
  const have = node.revision;
  const head = node.headRevision;
  return have !== undefined && head !== undefined && head > 0 && have < head;
}
