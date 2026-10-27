import { useEffect, useState } from "react";
import { useQuery, type QueryKey } from "@tanstack/react-query";
import { appCache } from "./appCache";
import { CACHE_POLICY } from "./policy";
import { persistenceAvailable, writePersisted } from "./persistentStore";
import { hydrateSnapshot, persistId } from "./snapshots";

export interface SnapshotQueryOptions<T> {
  key: QueryKey;
  /** False keeps cached data visible but never asks P4. */
  enabled: boolean;
  fetch(signal: AbortSignal): Promise<T>;
  /** Validates disk data before use; omit for memory-only snapshots. */
  persist?: (value: unknown) => value is T;
  staleTime?: number;
  /** Show hydrated data immediately, then revalidate it even if its timestamp is recent. */
  revalidateOnHydrate?: boolean;
}

/**
 * Cache-first read: render the snapshot immediately, revalidate stale data in
 * the background, and keep the old rows when a refresh fails.
 */
export function useSnapshotQuery<T>({
  key,
  enabled,
  fetch,
  persist,
  staleTime = CACHE_POLICY.snapshot.staleTime,
  revalidateOnHydrate = false,
}: SnapshotQueryOptions<T>) {
  const id = persistId(key);
  const [hydrated, setHydrated] = useState(() =>
    !persist ||
    !persistenceAvailable() ||
    appCache.getQueryData(key) !== undefined
      ? id
      : "",
  );
  const ready =
    !persist ||
    !persistenceAvailable() ||
    hydrated === id ||
    appCache.getQueryData(key) !== undefined;
  useEffect(() => {
    if (!persist || ready) return;
    let live = true;
    void hydrateSnapshot(key, persist, {
      revalidate: revalidateOnHydrate,
    }).then(() => {
      if (live) setHydrated(id);
    });
    return () => {
      live = false;
    };
  }, [id, revalidateOnHydrate]);
  const query = useQuery(
    {
      queryKey: key,
      queryFn: async ({ signal }) => {
        const data = await fetch(signal);
        if (persist) writePersisted(id, Date.now(), data);
        return data;
      },
      enabled: enabled && ready,
      staleTime,
      refetchOnMount: true,
      refetchOnWindowFocus: false,
      retry: false,
    },
    appCache,
  );
  const hasData = query.data !== undefined;
  return {
    data: query.data,
    updatedAt: query.dataUpdatedAt,
    error: query.error ? String(query.error) : "",
    /** Only true when there is nothing cached to show yet. */
    initialLoading: !hasData && (query.isFetching || (enabled && !ready)),
    /** A background revalidation; the UI keeps showing the cached rows. */
    refreshing: hasData && query.isFetching,
    refresh: () => query.refetch({ cancelRefetch: false }),
  };
}
