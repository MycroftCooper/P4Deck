import { appCache } from "./appCache";
import { stableConnectionKey } from "./connectionKey";
import { SNAPSHOT_DOMAINS, type SnapshotDomain } from "./policy";

/** Every kind of cached data an action can make out of date. */
export type DataDomain =
  SnapshotDomain | "workspaceStatus" | "depot" | "localCapabilities";

export const ALL_DATA_DOMAINS: readonly DataDomain[] = [
  ...SNAPSHOT_DOMAINS,
  "workspaceStatus",
  "depot",
  "localCapabilities",
];

export interface InvalidateDataOptions {
  connectionKey?: string;
  /**
   * P4-confirmed paths. When present, only directory snapshots that can contain
   * one of these paths are invalidated. An empty or omitted list means the
   * operation result was incomplete, so the safe fallback is broad refresh.
   */
  affectedPaths?: readonly string[];
}

function comparablePath(value: string) {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(value);
  const normalized = value
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "")
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
  return windows ? normalized.toLowerCase() : normalized;
}

/**
 * Directory caches contain descendants, so invalidate both ancestors (for the
 * row that changed) and descendants (for a renamed or removed folder).
 */
function directoryIsAffected(
  directory: unknown,
  affectedPaths: readonly string[],
) {
  if (typeof directory !== "string" || !directory) return true;
  const current = comparablePath(directory);
  return affectedPaths.some((path) => {
    const affected = comparablePath(path);
    return (
      !!affected &&
      (current === affected ||
        current.startsWith(`${affected}/`) ||
        affected.startsWith(`${current}/`))
    );
  });
}

function invalidateDirectoryQueries(
  prefixes: readonly string[],
  stableKey: string,
  affectedPaths: readonly string[] | undefined,
) {
  const scoped = affectedPaths && affectedPaths.length > 0;
  return prefixes.map((prefix) =>
    appCache.invalidateQueries({
      predicate: (query) =>
        query.queryKey[0] === prefix &&
        query.queryKey[1] === stableKey &&
        (!scoped ||
          directoryIsAffected(query.queryKey[2], affectedPaths)),
    }),
  );
}

/**
 * The only post-action refresh entry point. Mounted views revalidate in the
 * background; closed views keep their snapshot but revalidate when reopened.
 */
export function invalidateData(
  domains: readonly DataDomain[],
  options: InvalidateDataOptions = {},
): Promise<void> {
  const affected = new Set(domains);
  const work: Promise<unknown>[] = [];
  // Pending and Submitted merge results and manage cursors behind these events.
  if (affected.has("pending"))
    window.dispatchEvent(new Event("p4deck:pending-refresh"));
  if (affected.has("submitted"))
    window.dispatchEvent(new Event("p4deck:submitted-refresh"));
  const key = options.connectionKey;
  if (key) {
    const stableKey = stableConnectionKey(key);
    if (affected.has("workspaceStatus"))
      work.push(
        ...invalidateDirectoryQueries(
          ["workspace-files", "workspace-directory"],
          stableKey,
          options.affectedPaths,
        ),
      );
    if (affected.has("depot"))
      work.push(
        ...invalidateDirectoryQueries(
          ["depot-files"],
          stableKey,
          options.affectedPaths,
        ),
      );
    if (affected.has("localCapabilities"))
      work.push(
        appCache.invalidateQueries({
          queryKey: ["local-path-capabilities", key],
        }),
      );
  }
  for (const domain of SNAPSHOT_DOMAINS)
    if (domain !== "pending" && affected.has(domain))
      work.push(appCache.invalidateQueries({ queryKey: ["snapshot", domain] }));
  return Promise.all(work).then(() => undefined);
}

/** Periodic refresh: everything becomes stale, nothing inactive is fetched. */
export function markSnapshotsStale() {
  return appCache.invalidateQueries({
    queryKey: ["snapshot"],
    refetchType: "none",
  });
}
