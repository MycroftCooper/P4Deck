import { QueryClient, useQuery } from "@tanstack/react-query";
import { backend } from "../../infrastructure/backend";
import type { RuntimeInfo } from "../../shared/contracts/types";

export function canScanWorkspace(
  runtime: Pick<RuntimeInfo, "connection" | "context">,
) {
  return (
    runtime.connection.state === "connected" &&
    !!runtime.context.client.trim() &&
    !!runtime.context.cwd?.trim()
  );
}
// Shared observers deduplicate sidebar/list requests and receive the same refresh result.
export const workspaceCache = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 3_000,
      gcTime: 60_000,
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});
export const workspaceQuery = (
  connectionKey: string,
  path?: string,
  refresh = false,
) => ({
  queryKey: ["workspace-files", connectionKey, path ?? ""] as const,
  queryFn: async ({ signal }: { signal: AbortSignal }) => {
    const operationId = `workspace-status-${crypto.randomUUID()}`;
    const cancel = () => void backend.cancelOperation(operationId);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return await backend.listWorkspaceChildren(path, refresh, operationId);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  },
});
export function useWorkspaceFiles(
  connectionKey: string,
  enabled = true,
  path?: string,
) {
  return useQuery(
    { ...workspaceQuery(connectionKey, path), enabled },
    workspaceCache,
  );
}
export function useDepotFiles(
  connectionKey: string,
  enabled: boolean,
  path?: string,
) {
  return useQuery(
    {
      queryKey: ["depot-files", connectionKey, path ?? ""],
      queryFn: () => backend.listDepotChildren(path),
      enabled,
    },
    workspaceCache,
  );
}
