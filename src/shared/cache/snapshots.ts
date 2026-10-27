import type { QueryKey } from "@tanstack/react-query";
import { appCache } from "./appCache";
import { CACHE_POLICY } from "./policy";
import { readPersisted, writePersisted } from "./persistentStore";

export interface Snapshot<T> {
  data: T;
  updatedAt: number;
}

export const persistId = (key: QueryKey) => JSON.stringify(key);

export function readSnapshot<T>(key: QueryKey): Snapshot<T> | undefined {
  const state = appCache.getQueryState<T>(key);
  return state?.data === undefined
    ? undefined
    : { data: state.data, updatedAt: state.dataUpdatedAt };
}

/** Fresh data is shown without asking P4; stale data is shown and revalidated. */
export function isFresh(
  key: QueryKey,
  staleTime: number = CACHE_POLICY.snapshot.staleTime,
) {
  const state = appCache.getQueryState(key);
  return (
    state?.data !== undefined &&
    !state.isInvalidated &&
    Date.now() - state.dataUpdatedAt < staleTime
  );
}

export function writeSnapshot<T>(
  key: QueryKey,
  data: T,
  options: { persist?: boolean; updatedAt?: number } = {},
) {
  const updatedAt = options.updatedAt ?? Date.now();
  appCache.setQueryData(key, data, { updatedAt });
  // setQueryData does not restart the GC timer of a query without observers;
  // views that keep their own state would otherwise lose recent writes.
  const query = appCache.getQueryCache().find({ queryKey: key, exact: true });
  (query as unknown as { scheduleGc?(): void } | undefined)?.scheduleGc?.();
  if (options.persist) writePersisted(persistId(key), updatedAt, data);
}

/** Keep live cursors in memory; disk snapshots contain display data only. */
export function writePagedSnapshot<
  T extends { hasMore: boolean; nextCursor?: string },
>(key: QueryKey, data: T) {
  const updatedAt = Date.now();
  writeSnapshot(key, data, { updatedAt });
  const { nextCursor: _cursor, ...display } = data;
  writePersisted(persistId(key), updatedAt, { ...display, hasMore: false });
}

const hydrations = new Map<string, Promise<void>>();

/** Loads a disk snapshot into memory once; corrupt or foreign data is ignored. */
export function hydrateSnapshot<T>(
  key: QueryKey,
  validate: (value: unknown) => value is T,
  { revalidate = false }: { revalidate?: boolean } = {},
): Promise<void> {
  if (appCache.getQueryData(key) !== undefined) return Promise.resolve();
  const id = persistId(key);
  const existing = hydrations.get(id);
  if (existing) return existing;
  const read = readPersisted(id)
    .then(async (entry) => {
      if (
        entry &&
        validate(entry.data) &&
        appCache.getQueryData(key) === undefined
      ) {
        appCache.setQueryData(key, entry.data, { updatedAt: entry.updatedAt });
        // Paged disk snapshots cannot resume a server session. Show their rows
        // immediately, then quietly obtain page one and a live cursor.
        if (revalidate)
          await appCache.invalidateQueries({
            queryKey: key,
            exact: true,
            refetchType: "none",
          });
      }
    })
    .catch(() => undefined)
    .finally(() => hydrations.delete(id));
  hydrations.set(id, read);
  return read;
}
