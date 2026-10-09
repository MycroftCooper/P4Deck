import { backend } from "../../infrastructure/backend";
import type {
  PendingChange,
  PendingChangePage,
  PendingChangeQuery,
} from "../../shared/contracts/types";

export const PENDING_PAGE_SIZE = 100;

export function filterPendingChanges(
  changes: readonly PendingChange[],
  keyword: string,
): PendingChange[] {
  const needle = keyword.trim().toLocaleLowerCase();
  if (!needle) return [...changes];
  return changes.filter(
    (change) =>
      String(change.id).includes(needle) ||
      change.description.toLocaleLowerCase().includes(needle) ||
      change.jobs.some((job) => job.toLocaleLowerCase().includes(needle)) ||
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
  while (page.hasMore && page.nextCursor) {
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
