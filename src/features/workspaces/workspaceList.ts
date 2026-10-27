import { backend } from "../../infrastructure/backend";
import type {
  ClientWorkspace,
  RuntimeInfo,
} from "../../shared/contracts/types";
import { appCache } from "../../shared/cache/appCache";
import { serverScope, snapshotKey } from "../../shared/cache/policy";
import { writePersisted } from "../../shared/cache/persistentStore";
import {
  hydrateSnapshot,
  isFresh,
  persistId,
  readSnapshot,
} from "../../shared/cache/snapshots";
import { useSnapshotQuery } from "../../shared/cache/useSnapshotQuery";

/** One user's workspaces on one server, shared by the page and top switcher. */
export const workspaceListKey = (runtime: RuntimeInfo) =>
  snapshotKey("workspaces", serverScope(runtime));

export function isWorkspaceList(value: unknown): value is ClientWorkspace[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        !!item &&
        typeof item.name === "string" &&
        typeof item.root === "string" &&
        typeof item.host === "string" &&
        typeof item.stream === "string",
    )
  );
}

async function load(runtime: RuntimeInfo) {
  const data = await backend.listUserWorkspaces();
  writePersisted(persistId(workspaceListKey(runtime)), Date.now(), data);
  return data;
}

export function useWorkspaceList(runtime: RuntimeInfo, enabled: boolean) {
  return useSnapshotQuery({
    key: workspaceListKey(runtime),
    enabled,
    fetch: () => backend.listUserWorkspaces(),
    persist: isWorkspaceList,
  });
}

/** Returns cached rows at once and revalidates stale ones in the background. */
export async function cachedWorkspaceList(
  runtime: RuntimeInfo,
  allowRefresh = true,
) {
  const key = workspaceListKey(runtime);
  await hydrateSnapshot(key, isWorkspaceList);
  const cached = readSnapshot<ClientWorkspace[]>(key);
  const fetch = () =>
    appCache.fetchQuery({ queryKey: key, queryFn: () => load(runtime) });
  if (!cached) return allowRefresh ? fetch() : [];
  if (allowRefresh && !isFresh(key)) void fetch().catch(() => undefined);
  return cached.data;
}
