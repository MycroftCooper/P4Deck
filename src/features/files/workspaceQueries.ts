import { QueryClient, useQuery } from "@tanstack/react-query";
import { backend } from "../../infrastructure/backend";
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
export const workspaceQuery = (connectionKey: string, path?: string) => ({
  queryKey: ["workspace-files", connectionKey, path ?? ""] as const,
  queryFn: () => backend.listWorkspaceChildren(path),
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
