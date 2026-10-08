import type {
  PendingChange,
  WorkflowResult,
  WorkflowTargetSnapshot,
} from "../../shared/contracts/types";
import { workspaceCache } from "../files/workspaceQueries";

export interface WorkflowRefreshDetail {
  result: WorkflowResult;
  target: WorkflowTargetSnapshot;
  connectionKey: string;
}

const containsPath = (change: PendingChange, paths: Set<string>) =>
  [...change.files, ...change.shelvedFiles].some((file) =>
    paths.has(file.depotPath),
  );

/** Merge only CLs named by the workflow target or containing affected paths. */
export function mergeWorkflowPending(
  current: PendingChange[],
  latest: PendingChange[],
  target: WorkflowTargetSnapshot,
) {
  const paths = new Set(target.depotPaths);
  const ids = new Set(
    [target.sourceChangeId, target.targetChangeId].filter(
      (id): id is number => id !== undefined,
    ),
  );
  for (const change of [...current, ...latest])
    if (containsPath(change, paths)) ids.add(change.id);
  const replacements = new Map(
    latest
      .filter((change) => ids.has(change.id))
      .map((change) => [change.id, change]),
  );
  const next = current
    .filter((change) => !ids.has(change.id) || replacements.has(change.id))
    .map((change) => replacements.get(change.id) ?? change);
  for (const change of replacements.values())
    if (!next.some((item) => item.id === change.id)) next.push(change);
  return next.sort((left, right) =>
    left.id === 0 ? -1 : right.id === 0 ? 1 : right.id - left.id,
  );
}

export async function publishWorkflowResult(
  result: WorkflowResult,
  target: WorkflowTargetSnapshot,
  connectionKey: string,
) {
  if (result.refresh.pendingChanges)
    window.dispatchEvent(
      new CustomEvent<WorkflowRefreshDetail>("p4deck:workflow-result", {
        detail: { result, target, connectionKey },
      }),
    );
  if (result.refresh.workspaceStatus)
    await Promise.all([
      workspaceCache.invalidateQueries({
        queryKey: ["workspace-files", connectionKey],
      }),
      workspaceCache.invalidateQueries({
        queryKey: ["depot-files", connectionKey],
      }),
    ]);
}

/** IPC failure can hide a partial mutation, so refresh every related local view. */
export async function publishWorkflowFailure(connectionKey: string) {
  window.dispatchEvent(new Event("p4deck:pending-refresh"));
  await Promise.allSettled([
    workspaceCache.invalidateQueries({
      queryKey: ["workspace-files", connectionKey],
    }),
    workspaceCache.invalidateQueries({
      queryKey: ["depot-files", connectionKey],
    }),
  ]);
}
