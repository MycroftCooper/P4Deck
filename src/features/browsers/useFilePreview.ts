import { useEffect, useMemo, useState } from "react";
import { backend } from "../../infrastructure/backend";
import type { FilePreview, RuntimeInfo } from "../../shared/contracts/types";
import { appCache } from "../../shared/cache/appCache";

/** Previews can hold large images, so only the most recent few are kept. */
const PREVIEW_PREFIX = ["local", "preview"] as const;
const KEEP_PREVIEWS = 3;

function evictOldPreviews() {
  appCache
    .getQueryCache()
    .findAll({ queryKey: PREVIEW_PREFIX })
    .filter((query) => query.state.fetchStatus === "idle")
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
    .slice(KEEP_PREVIEWS)
    .forEach((query) =>
      appCache.removeQueries({ queryKey: query.queryKey, exact: true }),
    );
}

export function useFilePreview(target: string, runtime: RuntimeInfo) {
  const [result, setResult] = useState<{ key: string; data: FilePreview }>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const identity = JSON.stringify([runtime.mode, runtime.context, target]);
  const key = useMemo(() => [...PREVIEW_PREFIX, identity], [identity]);
  const data = result?.key === identity ? result.data : undefined;
  useEffect(() => {
    let live = true;
    setError("");
    if (!target || runtime.p4Version === "loading") {
      setLoading(false);
      return;
    }
    setLoading(true);
    // Local reads are cheap: show the last copy at once, then re-read it.
    const cached = appCache.getQueryData<FilePreview>(key);
    if (cached) setResult({ key: identity, data: cached });
    // Debounce selection changes; identical instances share one in-flight request.
    const timer = setTimeout(() => {
      void appCache
        .fetchQuery({
          queryKey: key,
          queryFn: () => backend.getFilePreview(target),
          staleTime: 3_000,
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
          evictOldPreviews();
        });
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [identity, key, target, runtime.p4Version, refresh]);
  const reload = () => {
    void appCache
      .invalidateQueries({ queryKey: key, exact: true })
      .then(() => setRefresh((n) => n + 1));
  };

  return { data, error, loading, reload };
}
