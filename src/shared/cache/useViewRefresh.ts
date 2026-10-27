import { useEffect, useRef } from "react";
import type { QueryKey } from "@tanstack/react-query";
import { isFresh, persistId } from "./snapshots";

/**
 * Revalidates a view in the background when the user activates its tab with
 * stale data, or when the auto-refresh coordinator selects it.
 * Views that already receive a domain refresh event (Submitted) pass
 * `automatic: false` so one timer tick does not start two reads.
 */
export function useViewRefresh(
  page: string,
  key: QueryKey,
  refresh: () => unknown,
  staleTime?: number,
  { automatic = true }: { automatic?: boolean } = {},
) {
  const latest = useRef(refresh);
  latest.current = refresh;
  const id = persistId(key);
  useEffect(() => {
    const selected = (event: Event) =>
      (event as CustomEvent<{ activePage?: string }>).detail?.activePage ===
      page;
    const onAutomatic = (event: Event) => {
      if (selected(event)) latest.current();
    };
    const onActivated = (event: Event) => {
      if (selected(event) && !isFresh(key, staleTime)) latest.current();
    };
    if (automatic) window.addEventListener("p4deck:auto-refresh", onAutomatic);
    window.addEventListener("p4deck:view-activated", onActivated);
    return () => {
      window.removeEventListener("p4deck:auto-refresh", onAutomatic);
      window.removeEventListener("p4deck:view-activated", onActivated);
    };
  }, [page, id, staleTime, automatic]);
}
