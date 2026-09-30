import { useEffect, useMemo, useState } from "react";
import { QueryClient } from "@tanstack/react-query";
import { backend } from "../../infrastructure/backend";
import type { FilePreview, RuntimeInfo } from "../../shared/contracts/types";
const cache = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 3_000, gcTime: 60_000, retry: false },
  },
});

export function useFilePreview(target: string, runtime: RuntimeInfo) {
  const [result, setResult] = useState<{ key: string; data: FilePreview }>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const identity = JSON.stringify([runtime.mode, runtime.context, target]);
  const key = useMemo(() => ["file-preview", identity], [identity]);
  const data = result?.key === identity ? result.data : undefined;
  useEffect(() => {
    let live = true;
    setError("");
    if (!target || runtime.p4Version === "loading") {
      setLoading(false);
      return;
    }
    setLoading(true);
    // Debounce selection changes; identical instances share one in-flight request.
    const timer = setTimeout(() => {
      void cache
        .fetchQuery({
          queryKey: key,
          queryFn: () => backend.getFilePreview(target),
        })
        .then((value) => {
          if (live) setResult({ key: identity, data: value });
        })
        .catch((e) => {
          if (live) {
            setResult(undefined);
            setError(String(e));
          }
        })
        .finally(() => {
          if (live) setLoading(false);
          const entries = cache
            .getQueryCache()
            .getAll()
            .filter((q) => q.state.fetchStatus === "idle")
            .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
          entries
            .slice(3)
            .forEach((q) =>
              cache.removeQueries({ queryKey: q.queryKey, exact: true }),
            );
        });
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [identity, key, target, runtime.p4Version, refresh]);
  const reload = () => {
    void cache
      .invalidateQueries({ queryKey: key, exact: true })
      .then(() => setRefresh((n) => n + 1));
  };

  return { data, error, loading, reload };
}
