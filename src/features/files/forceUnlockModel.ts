import type {
  ForceUnlockOrigin,
  ForceUnlockOriginMode,
  WorkspaceNode,
} from "../../shared/contracts/types";

export const FORCE_UNLOCK_PATH_LIMIT = 128;

export function exactForceUnlockPaths(nodes: WorkspaceNode[]) {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const path = node.kind === "file" ? node.depotPath : undefined;
    if (!path || !isExactDepotFile(path))
      return {
        paths: [],
        reason:
          "Force unlock requires exact depot files; directories, local paths, wildcards, and revision syntax are not accepted.",
      };
    if (!seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  if (!paths.length || paths.length > FORCE_UNLOCK_PATH_LIMIT)
    return {
      paths: [],
      reason: `Force unlock requires 1–${FORCE_UNLOCK_PATH_LIMIT} exact depot files.`,
    };
  return { paths, reason: undefined };
}

export function forceUnlockOrigin(
  mode: ForceUnlockOriginMode,
  rawChange: string,
): ForceUnlockOrigin {
  if (mode === "orphanDistributed") return { mode };
  const trimmed = rawChange.trim();
  return {
    mode,
    changeId:
      trimmed.toLocaleLowerCase() === "default" ? 0 : Number(trimmed || 0),
  };
}

export function forceUnlockOriginInputReason(
  mode: ForceUnlockOriginMode,
  rawChange: string,
) {
  if (mode === "orphanDistributed") return undefined;
  const trimmed = rawChange.trim();
  if (trimmed.toLocaleLowerCase() === "default") return undefined;
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed)))
    return "Enter a numbered changelist or the word default.";
  return undefined;
}

export function isVerifiedForceUnlockSuccess(
  outcome: string | undefined,
  files: { outcome: string }[] | undefined,
) {
  return (
    outcome === "succeeded" &&
    Boolean(files?.length) &&
    files!.every((file) => file.outcome === "unlocked")
  );
}

function isExactDepotFile(path: string) {
  return (
    path.startsWith("//") &&
    !path.startsWith("///") &&
    path.trim() === path &&
    path.length <= 1024 &&
    !path.includes("...") &&
    !/[\\\u0000-\u001f\u007f-\u009f*@#%]/.test(path) &&
    !path.split("/").some((segment) => segment === "." || segment === "..")
  );
}
