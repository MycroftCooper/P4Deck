import { backend } from "../../infrastructure/backend";
import type {
  DepotNode,
  RuntimeInfo,
  WorkspaceListing,
  WorkspaceNode,
} from "../../shared/contracts";
import { appCache } from "../../shared/cache/appCache";
import { stableConnectionKey } from "../../shared/cache/connectionKey";
import { writePersisted } from "../../shared/cache/persistentStore";
import { persistId } from "../../shared/cache/snapshots";
import { useSnapshotQuery } from "../../shared/cache/useSnapshotQuery";

export function canScanWorkspace(
  runtime: Pick<RuntimeInfo, "connection" | "context">,
) {
  return (
    runtime.connection.state === "connected" &&
    !!runtime.context.client.trim() &&
    !!runtime.context.cwd?.trim()
  );
}
export function canListWorkspace(runtime: Pick<RuntimeInfo, "context">) {
  return !!runtime.context.client.trim() && !!runtime.context.cwd?.trim();
}
// Legacy name for the shared app cache used by file and depot views.
export const workspaceCache = appCache;
const workspaceStatusKey = (connectionKey: string, path?: string) =>
  ["workspace-files", stableConnectionKey(connectionKey), path ?? ""] as const;
const workspaceDirectoryKey = (connectionKey: string, path?: string) =>
  [
    "workspace-directory",
    stableConnectionKey(connectionKey),
    path ?? "",
  ] as const;
const depotKey = (connectionKey: string, path?: string) =>
  ["depot-files", stableConnectionKey(connectionKey), path ?? ""] as const;
const LOCAL_DIRECTORY_STALE_TIME = 30_000;

function workspacePathKey(node: WorkspaceNode) {
  const path = node.absolutePath || node.depotPath;
  if (!path) return node.id;
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(path);
  const normalized = path
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "")
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
  return windows ? normalized.toLowerCase() : normalized;
}

/**
 * A local directory read owns the visible path set. P4 status is overlaid only
 * onto those rows, so a slow or failed status query cannot resurrect deleted
 * local entries or hide newly created files.
 */
export function mergeWorkspaceListings(
  local: WorkspaceListing | undefined,
  status: WorkspaceListing | undefined,
): WorkspaceListing | undefined {
  if (!local) return status;
  if (!status) return local;
  const statusByPath = new Map(
    status.items.map((item) => [workspacePathKey(item), item]),
  );
  const items = local.items.map((item) => {
    const remote = statusByPath.get(workspacePathKey(item));
    if (!remote) return item;
    return {
      ...item,
      ...remote,
      id: item.id,
      name: item.name,
      kind: item.kind,
      absolutePath: item.absolutePath,
      relativePath: item.relativePath,
      modifiedAt: item.modifiedAt ?? remote.modifiedAt,
    };
  });
  const completeness =
    local.completeness === "error" || status.completeness === "error"
      ? "error"
      : local.completeness === "partial" || status.completeness === "partial"
        ? "partial"
        : "complete";
  const errors = [...local.errors];
  for (const error of status.errors)
    if (
      !errors.some(
        (existing) =>
          existing.message === error.message &&
          existing.source === error.source,
      )
    )
      errors.push(error);
  return {
    items,
    completeness,
    errors,
    operationIds: [...new Set([...local.operationIds, ...status.operationIds])],
    truncated: local.truncated || status.truncated,
    safetyLimit: Math.min(local.safetyLimit, status.safetyLimit),
    cacheFreshness: status.cacheFreshness,
  };
}

export function isWorkspaceListing(value: unknown): value is WorkspaceListing {
  if (!value || typeof value !== "object") return false;
  const listing = value as Partial<WorkspaceListing>;
  return (
    Array.isArray(listing.items) &&
    listing.items.every(
      (item) =>
        !!item &&
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        (item.kind === "file" || item.kind === "directory") &&
        typeof item.absolutePath === "string" &&
        typeof item.relativePath === "string" &&
        typeof item.state === "string" &&
        !!item.status &&
        typeof item.status === "object",
    ) &&
    (listing.completeness === "complete" ||
      listing.completeness === "partial" ||
      listing.completeness === "error") &&
    Array.isArray(listing.errors) &&
    Array.isArray(listing.operationIds) &&
    typeof listing.truncated === "boolean" &&
    typeof listing.safetyLimit === "number" &&
    typeof listing.cacheFreshness === "string"
  );
}

export function isDepotNodeList(value: unknown): value is DepotNode[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        !!item &&
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        (item.kind === "file" || item.kind === "directory") &&
        typeof item.depotPath === "string",
    )
  );
}

export const workspaceQuery = (
  connectionKey: string,
  path?: string,
  refresh = false,
) => {
  const queryKey = workspaceStatusKey(connectionKey, path);
  return {
    queryKey,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const operationId = `workspace-status-${crypto.randomUUID()}`;
      const cancel = () => void backend.cancelOperation(operationId);
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const result = await backend.listWorkspaceChildren(
          path,
          refresh,
          operationId,
        );
        writePersisted(persistId(queryKey), Date.now(), result);
        if (
          !path &&
          !performance.getEntriesByName("p4deck:workspace-status-ready").length
        )
          performance.mark("p4deck:workspace-status-ready");
        return result;
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
  };
};
export const localWorkspaceQuery = (connectionKey: string, path?: string) => {
  const queryKey = workspaceDirectoryKey(connectionKey, path);
  return {
    queryKey,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const operationId = `workspace-directory-${crypto.randomUUID()}`;
      const cancel = () => void backend.cancelOperation(operationId);
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const result = await backend.listWorkspaceChildren(
          path,
          false,
          operationId,
          true,
        );
        writePersisted(persistId(queryKey), Date.now(), result);
        return result;
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
    staleTime: LOCAL_DIRECTORY_STALE_TIME,
  };
};
export function useWorkspaceFiles(
  connectionKey: string,
  enabled = true,
  path?: string,
  statusReady = enabled,
) {
  const localDefinition = localWorkspaceQuery(connectionKey, path);
  const statusDefinition = workspaceQuery(connectionKey, path);
  const local = useSnapshotQuery({
    key: localDefinition.queryKey,
    enabled,
    fetch: (signal) => localDefinition.queryFn({ signal }),
    persist: isWorkspaceListing,
    staleTime: LOCAL_DIRECTORY_STALE_TIME,
    revalidateOnHydrate: true,
  });
  const status = useSnapshotQuery({
    key: statusDefinition.queryKey,
    enabled: enabled && statusReady,
    fetch: (signal) => statusDefinition.queryFn({ signal }),
    persist: isWorkspaceListing,
    revalidateOnHydrate: true,
  });
  const data = mergeWorkspaceListings(local.data, status.data);
  const initialLoading =
    data === undefined && (local.initialLoading || status.initialLoading);
  return {
    ...status,
    data,
    error: status.error ?? local.error,
    isFetching: initialLoading,
    initialLoading,
    refreshing:
      data !== undefined &&
      (local.refreshing || status.initialLoading || status.refreshing),
  };
}

/**
 * Start the local filesystem and P4 status reads at the same time. The local
 * result remains authoritative when the status read fails.
 */
export async function refreshWorkspaceDirectory(
  connectionKey: string,
  path: string | undefined,
  statusReady: boolean,
) {
  const local = workspaceCache.fetchQuery({
    ...localWorkspaceQuery(connectionKey, path),
    staleTime: 0,
  });
  const status = statusReady
    ? workspaceCache.fetchQuery({
        ...workspaceQuery(connectionKey, path, true),
        staleTime: 0,
      })
    : undefined;
  const [localResult, statusResult] = await Promise.allSettled([
    local,
    ...(status ? [status] : []),
  ]);
  if (localResult.status === "rejected") throw localResult.reason;
  return {
    local: localResult.value,
    status:
      statusResult?.status === "fulfilled" ? statusResult.value : undefined,
  };
}

export const depotQuery = (connectionKey: string, path?: string) => {
  const queryKey = depotKey(connectionKey, path);
  return {
    queryKey,
    queryFn: async () => {
      const result = await backend.listDepotChildren(path);
      writePersisted(persistId(queryKey), Date.now(), result);
      return result;
    },
  };
};
export function useDepotFiles(
  connectionKey: string,
  enabled: boolean,
  path?: string,
) {
  const definition = depotQuery(connectionKey, path);
  const query = useSnapshotQuery({
    key: definition.queryKey,
    enabled,
    fetch: () => definition.queryFn(),
    persist: isDepotNodeList,
    revalidateOnHydrate: true,
  });
  return {
    ...query,
    isFetching: query.initialLoading,
    refetch: query.refresh,
  };
}
