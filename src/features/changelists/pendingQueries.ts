import { t } from "../../shared/i18n";
import { backend } from "../../infrastructure/backend";
import type {
  PendingChange,
  PendingChangePage,
  PendingChangeQuery,
  PendingChangeMutationResult,
} from "../../shared/contracts";

export const PENDING_PAGE_SIZE = 100;

export function mergePendingMutation(
  current: PendingChange[],
  result: PendingChangeMutationResult,
) {
  if (result.refreshError) return current;
  const affected = new Set(result.affectedChanges);
  const refreshed = new Map(
    result.refreshedChanges.map((change) => [change.id, change]),
  );
  const next = current
    .filter((change) => !affected.has(change.id) || refreshed.has(change.id))
    .map((change) => refreshed.get(change.id) ?? change);
  for (const change of refreshed.values())
    if (!next.some((item) => item.id === change.id)) next.push(change);
  return next.sort((left, right) =>
    left.id === 0 ? -1 : right.id === 0 ? 1 : right.id - left.id,
  );
}

export function filterPendingChanges(
  changes: readonly PendingChange[],
  keyword: string,
): PendingChange[] {
  const pending = changes.filter((change) => change.status === "pending");
  const needle = keyword.trim().toLocaleLowerCase();
  if (!needle) return pending;
  return pending.filter(
    (change) =>
      (change.id === 0 ? "default" : String(change.id)).includes(needle) ||
      change.description.toLocaleLowerCase().includes(needle) ||
      [...change.files, ...change.shelvedFiles].some((file) =>
        file.depotPath.toLocaleLowerCase().includes(needle),
      ),
  );
}

export function pendingQuery(
  requestGeneration: number,
  operationId: string,
  keyword = "",
  cursor?: string,
): PendingChangeQuery {
  return {
    operationId,
    requestGeneration,
    keyword,
    sort: "newest",
    pageSize: PENDING_PAGE_SIZE,
    cursor,
  };
}

/** Mirrors the backend cursor identity: connection + normalized query + page. */
export function pendingQueryKey(
  connectionKey: string,
  query: Pick<PendingChangeQuery, "keyword" | "sort" | "pageSize" | "cursor">,
) {
  return [
    "pending-changes",
    connectionKey,
    query.keyword.trim(),
    query.sort,
    query.pageSize,
    query.cursor ?? "",
  ] as const;
}

/** Bounded compatibility helper for dialogs that need the current target set. */
export async function queryAllPendingChanges(
  operationId: string = crypto.randomUUID(),
): Promise<PendingChange[]> {
  let page: PendingChangePage = await backend.queryPendingChanges(
    pendingQuery(0, operationId),
  );
  const changes = page.defaultChange ? [page.defaultChange] : [];
  changes.push(...page.items);
  const seen = new Set(changes.map((change) => change.id));
  const cursors = new Set<string>();
  while (true) {
    if (
      page.partial ||
      page.stats.truncatedBySafetyLimit ||
      (page.hasMore && (!page.nextCursor || cursors.has(page.nextCursor)))
    )
      throw new Error(
        t("pending.pending.changelists.are.incomplete.refresh.and"),
      );
    if (!page.hasMore || !page.nextCursor) break;
    cursors.add(page.nextCursor);
    page = await backend.queryPendingChanges(
      pendingQuery(0, operationId, "", page.nextCursor),
    );
    for (const change of page.items) {
      if (seen.has(change.id)) continue;
      seen.add(change.id);
      changes.push(change);
    }
  }
  return changes;
}
