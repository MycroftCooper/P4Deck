import { useQuery } from "@tanstack/react-query";
import { backend } from "../../infrastructure/backend";
import { workspaceCache } from "../../features/files/workspaceQueries";
import type { CommandTarget } from "./commandPolicy";

export function useLocalPathCapabilities(
  target: CommandTarget,
  native: boolean,
  connectionKey: string,
) {
  const path =
    target.type === "file" && (target.nodes?.length ?? 1) === 1
      ? target.node.absolutePath
      : "";
  const query = useQuery(
    {
      queryKey: ["local-path-capabilities", connectionKey, path],
      queryFn: () => backend.localPathCapabilities(path),
      enabled: native && !!path,
      // Short-lived local-only cache; switching targets never inherits the previous result.
      staleTime: 1_000,
      refetchOnWindowFocus: true,
    },
    workspaceCache,
  );
  return !native || !path || query.isError
    ? { reveal: false, openWith: false }
    : (query.data ?? null);
}
