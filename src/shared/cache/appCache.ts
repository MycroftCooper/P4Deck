import { QueryClient } from "@tanstack/react-query";
import { CACHE_POLICY } from "./policy";

/**
 * The single process-wide data cache. Views must share it so one refresh or
 * invalidation reaches every page that shows the same P4 data.
 */
export const appCache = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: CACHE_POLICY.snapshot.staleTime,
      gcTime: 300_000,
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

// Server snapshots stay available after their page closes, like P4V views.
appCache.setQueryDefaults(["snapshot"], {
  staleTime: CACHE_POLICY.snapshot.staleTime,
  gcTime: CACHE_POLICY.snapshot.gcTime,
});
appCache.setQueryDefaults(["target"], {
  staleTime: CACHE_POLICY.target.staleTime,
  gcTime: CACHE_POLICY.target.gcTime,
});
appCache.setQueryDefaults(["local"], {
  staleTime: CACHE_POLICY.local.staleTime,
  gcTime: CACHE_POLICY.local.gcTime,
});
