import { useEffect, useMemo } from "react";
import type { QueryKey } from "@tanstack/react-query";
import { backend } from "../../infrastructure/backend";
import type {
  PendingChange,
  PendingChangeMutationResult,
  PendingChangeQueryStats,
  RuntimeInfo,
} from "../../shared/contracts";
import { appCache } from "../../shared/cache/appCache";
import { snapshotKey, workspaceScope } from "../../shared/cache/policy";
import {
  hydrateSnapshot,
  isFresh,
  readSnapshot,
  writeSnapshot,
} from "../../shared/cache/snapshots";
import { useSnapshotQuery } from "../../shared/cache/useSnapshotQuery";
import { mergePendingMutation, pendingQuery } from "./pendingQueries";
import type { WorkflowRefreshDetail } from "./workflowRefresh";

export interface PendingSnapshot {
  changes: PendingChange[];
  partial: boolean;
  stats: PendingChangeQueryStats;
}
const empty: PendingChange[] = [];
/** Refreshes requested by timers or focus never interrupt a running read. */
const AUTOMATIC = new Set(["interval", "focus", "visible", "online"]);

export function pendingSnapshotKey(runtime: RuntimeInfo) {
  return snapshotKey("pending", workspaceScope(runtime));
}

function pendingValidator(runtime: RuntimeInfo) {
  return (value: unknown): value is PendingSnapshot => {
    const snapshot = value as PendingSnapshot | undefined;
    return (
      !!snapshot &&
      Array.isArray(snapshot.changes) &&
      !!snapshot.stats &&
      snapshot.changes.every(
        (change) =>
          change.status === "pending" &&
          change.user === runtime.context.user &&
          change.client === runtime.context.client &&
          Array.isArray(change.files) &&
          Array.isArray(change.shelvedFiles) &&
          Array.isArray(change.jobs),
      )
    );
  };
}

const pendingAvailable = (runtime: RuntimeInfo) =>
  runtime.p4Version !== "loading" &&
  !!runtime.context.server.trim() &&
  !!runtime.context.user.trim() &&
  !!runtime.context.client.trim();

/** Reads every cursor page of one server snapshot. */
async function fetchSnapshot(
  signal: AbortSignal,
  current: () => boolean = () => true,
): Promise<PendingSnapshot> {
  const operationId = crypto.randomUUID();
  const cancel = () =>
    void backend.cancelOperation(operationId).catch(() => undefined);
  signal.addEventListener("abort", cancel, { once: true });
  const changes: PendingChange[] = [];
  const ids = new Set<number>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  try {
    while (true) {
      signal.throwIfAborted();
      if (!current()) throw new Error("Pending refresh connection changed");
      const page = await backend.queryPendingChanges(
        pendingQuery(0, operationId, "", cursor),
      );
      signal.throwIfAborted();
      if (!current()) throw new Error("Pending refresh connection changed");
      for (const change of [
        ...(page.defaultChange ? [page.defaultChange] : []),
        ...page.items,
      ]) {
        if (ids.has(change.id)) continue;
        ids.add(change.id);
        changes.push(change);
      }
      const invalidCursor =
        page.hasMore && (!page.nextCursor || cursors.has(page.nextCursor));
      if (
        !page.hasMore ||
        page.partial ||
        invalidCursor ||
        page.stats.truncatedBySafetyLimit
      )
        return {
          changes,
          partial: page.partial || invalidCursor,
          stats: page.stats,
        };
      cursor = page.nextCursor!;
      cursors.add(cursor);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/**
 * Applies a local change synchronously and cancels an older in-flight read so
 * it cannot overwrite the newer result. Callers may opt out of restarting it.
 */
function updatePendingChanges(
  key: QueryKey,
  update: (changes: PendingChange[]) => PendingChange[],
  { revalidate = true }: { revalidate?: boolean } = {},
) {
  const apply = () => {
    const current = readSnapshot<PendingSnapshot>(key);
    if (current)
      writeSnapshot(
        key,
        { ...current.data, changes: update(current.data.changes) },
        { persist: true, updatedAt: current.updatedAt },
      );
  };
  const fetching = appCache.getQueryState(key)?.fetchStatus === "fetching";
  apply();
  if (!fetching) return;
  void appCache.cancelQueries({ queryKey: key }, { revert: false }).then(() => {
    if (revalidate) void appCache.invalidateQueries({ queryKey: key });
  });
}

/** Cached Pending changelists for pickers that must not wait for P4. */
export async function cachedPendingChanges(runtime: RuntimeInfo) {
  const key = pendingSnapshotKey(runtime);
  await hydrateSnapshot(key, pendingValidator(runtime));
  return readSnapshot<PendingSnapshot>(key)?.data.changes;
}

/**
 * App-level owner of the Pending snapshot: hydrates it from disk and applies
 * operation results and refresh requests even while the Pending tab is closed.
 * Mount it exactly once; views read the snapshot through usePendingCache.
 */
export function usePendingCacheSync(
  runtime: RuntimeInfo,
  connectionKey: string,
) {
  const key = pendingSnapshotKey(runtime);
  const scope = key[2];
  const available = pendingAvailable(runtime);
  const validate = useMemo(() => pendingValidator(runtime), [scope]);
  useEffect(() => {
    if (!available) return;
    void hydrateSnapshot(key, validate);
    const refresh = (event: Event) => {
      const reason = (event as CustomEvent<{ reason?: string }>).detail?.reason;
      const automatic = !!reason && AUTOMATIC.has(reason);
      if (automatic && appCache.getQueryState(key)?.fetchStatus === "fetching")
        return;
      // Only a mounted Pending view refetches; a closed one revalidates on open.
      void hydrateSnapshot(key, validate).then(() =>
        appCache.invalidateQueries(
          { queryKey: key },
          { cancelRefetch: !automatic },
        ),
      );
    };
    const activated = (event: Event) => {
      const page = (event as CustomEvent<{ activePage?: string }>).detail
        ?.activePage;
      if (page === "pending" && !isFresh(key))
        void appCache.refetchQueries(
          { queryKey: key, type: "active" },
          { cancelRefetch: false },
        );
    };
    const mutation = (event: Event) => {
      const result = (event as CustomEvent<PendingChangeMutationResult>).detail;
      if (
        !result ||
        result.refreshedChanges.some(
          (change) =>
            change.user !== runtime.context.user ||
            change.client !== runtime.context.client,
        )
      )
        return;
      if (result.refreshError) return refresh(event);
      void hydrateSnapshot(key, validate).then(() =>
        updatePendingChanges(key, (changes) =>
          mergePendingMutation(changes, result),
        ),
      );
    };
    const workflow = (event: Event) => {
      if (
        (event as CustomEvent<WorkflowRefreshDetail>).detail?.connectionKey ===
        connectionKey
      )
        refresh(event);
    };
    window.addEventListener("p4deck:pending-refresh", refresh);
    window.addEventListener("p4deck:view-activated", activated);
    window.addEventListener("p4deck:pending-mutation", mutation);
    window.addEventListener("p4deck:workflow-result", workflow);
    return () => {
      window.removeEventListener("p4deck:pending-refresh", refresh);
      window.removeEventListener("p4deck:view-activated", activated);
      window.removeEventListener("p4deck:pending-mutation", mutation);
      window.removeEventListener("p4deck:workflow-result", workflow);
    };
  }, [scope, available, connectionKey, validate]);
}

/** Cache-first Pending snapshot for a view; P4 is asked only when stale. */
export function usePendingCache(runtime: RuntimeInfo, enabled: boolean) {
  const key = pendingSnapshotKey(runtime);
  const scope = key[2];
  const validate = useMemo(() => pendingValidator(runtime), [scope]);
  const query = useSnapshotQuery({
    key,
    enabled:
      pendingAvailable(runtime) &&
      enabled &&
      runtime.connection.state === "connected",
    fetch: fetchSnapshot,
    persist: validate,
  });
  const updateChanges = useMemo(
    () =>
      (
        update: (changes: PendingChange[]) => PendingChange[],
        options?: { revalidate?: boolean },
      ) =>
        updatePendingChanges(key, update, options),
    [scope],
  );
  return {
    ...query,
    changes: query.data?.changes ?? empty,
    updateChanges,
  };
}

export class PendingExitRefreshPartial extends Error {}

/** One main-window refresh after a confirmed tool-parent exit; no submit inference. */
export async function refreshPendingAfterToolExit(
  runtime: RuntimeInfo,
  current: () => boolean,
) {
  const key = pendingSnapshotKey(runtime);
  await appCache.cancelQueries({ queryKey: key, exact: true });
  if (!current()) return;
  const snapshot = await appCache.fetchQuery({
    queryKey: key,
    staleTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      const value = await fetchSnapshot(signal, current);
      signal.throwIfAborted();
      if (!current()) throw Error("Pending refresh connection changed");
      return value;
    },
  });
  if (snapshot.partial || snapshot.stats.truncatedBySafetyLimit)
    throw new PendingExitRefreshPartial("Pending refresh incomplete");
}
