import { useCallback, useEffect, useRef, useState } from "react";
import { detachedPage, type DockHandle } from "../docking/types";
import { isPage, type PageId } from "../panels";
import { storage } from "../../shared/lib/storage";

/** Persisted tab session: which global pages were open and which one was active. */
const SESSION_KEY = "p4deck.pages";
const SESSION_VERSION = 1;
/** Hard cap so corrupted/abnormal sessions cannot bloat the dock or its queries. */
const MAX_SESSION_PAGES = 12;
const DEFAULT_PAGE: PageId = "pending";

export interface PageSession {
  version: 1;
  pages: PageId[];
  active: PageId | null;
}
export interface RestoredPageSession {
  pages: PageId[];
  active: PageId | null;
  source: "session" | "legacy" | "default";
}
export interface WindowPageSession extends RestoredPageSession {
  /** Detached/panel windows never participate in the main window's session. */
  persist: boolean;
}

/** Valid, de-duplicated, capped page list; unknown/removed PageIds are dropped. */
export function sanitizeSessionPages(value: unknown): PageId[] {
  if (!Array.isArray(value)) return [];
  const pages: PageId[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isPage(item) || pages.includes(item))
      continue;
    pages.push(item);
    if (pages.length === MAX_SESSION_PAGES) break;
  }
  return pages;
}
/** Default/empty/corrupt sessions fall back to Pending only (UI-11). */
function defaultSession(
  source: RestoredPageSession["source"],
): RestoredPageSession {
  return { pages: [DEFAULT_PAGE], active: DEFAULT_PAGE, source };
}
/** Parse the persisted session; accepts the legacy plain-array format. */
export function readPageSession(raw: string | null): RestoredPageSession {
  if (!raw) return defaultSession("default");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const pages = sanitizeSessionPages(parsed);
      return pages.length
        ? { pages, active: pages[0], source: "legacy" }
        : defaultSession("legacy");
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { version?: unknown }).version === SESSION_VERSION
    ) {
      const pages = sanitizeSessionPages((parsed as { pages?: unknown }).pages);
      if (!pages.length) return defaultSession("session");
      const requested = (parsed as { active?: unknown }).active;
      const active =
        typeof requested === "string" &&
        isPage(requested) &&
        pages.includes(requested)
          ? requested
          : pages[0];
      return { pages, active, source: "session" };
    }
  } catch {
    /* Corrupted JSON falls back to the default layout below. */
  }
  return defaultSession("default");
}
/** Serialize a clamped session; active always points at an open page (or null). */
export function pageSessionPayload(
  pages: readonly PageId[],
  active: PageId | null,
): string {
  const clean = sanitizeSessionPages(pages);
  const clamped =
    active && clean.includes(active) ? active : (clean[0] ?? null);
  const session: PageSession = {
    version: SESSION_VERSION,
    pages: clean,
    active: clamped,
  };
  return JSON.stringify(session);
}
/** Window-specific restore: detached windows get only their own page and never persist. */
export function sessionForWindow(
  raw: string | null,
  detached: string | null,
): WindowPageSession {
  if (detached) {
    const page = isPage(detached) ? detached : DEFAULT_PAGE;
    return { pages: [page], active: page, source: "default", persist: false };
  }
  return { ...readPageSession(raw), persist: true };
}
const readRoute = (): PageId | null => {
  const value = location.hash.replace("#/", "");
  return isPage(value) ? value : null;
};
export function usePageNavigation() {
  const dockRef = useRef<DockHandle>(null);
  const initial = useRef(
    sessionForWindow(storage.getItem(SESSION_KEY), detachedPage),
  );
  const [pages, setPages] = useState<PageId[]>(initial.current.pages);
  const [route, setRoute] = useState<PageId | null>(() => {
    if (!initial.current.persist) return initial.current.active;
    // A deep link wins over the restored active tab, but only if it is a real page.
    if (location.hash) return readRoute() ?? initial.current.active;
    return initial.current.active ?? initial.current.pages[0] ?? null;
  });
  const initialPages = useRef(pages);
  const activePage = useRef<PageId | null>(null);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const lastPersisted = useRef<string | null>(null);
  const persistSession = useCallback(
    (nextPages: readonly PageId[], nextActive: PageId | null) => {
      if (!initial.current.persist) return;
      const payload = pageSessionPayload(nextPages, nextActive);
      // Idempotent: repeated starts/renders with the same session do not write.
      if (payload === lastPersisted.current) return;
      lastPersisted.current = payload;
      storage.setItem(SESSION_KEY, payload);
    },
    [],
  );
  const onActive = useCallback(
    (page: PageId | null) => {
      setRoute(page);
      history.replaceState(null, "", "#/" + (page ?? "empty"));
      if (page !== activePage.current) {
        activePage.current = page;
        // Views revalidate stale snapshots in the background when shown again.
        window.dispatchEvent(
          new CustomEvent("p4deck:view-activated", {
            detail: { activePage: page },
          }),
        );
      }
      persistSession(pagesRef.current, page);
    },
    [persistSession],
  );
  const openPage = useCallback((page: PageId) => {
    // Keep navigation intent while the lazy DockWorkspace is still loading.
    setRoute(page);
    dockRef.current?.open(page);
  }, []);
  useEffect(() => {
    // Closing/opening tabs publishes the new set; keep the active tab only if it
    // is still open (otherwise the session clamps to the first open page).
    persistSession(pages, activePage.current ?? initial.current.active);
  }, [pages, persistSession]);
  useEffect(() => {
    if (detachedPage) return;
    const handler = () => {
      const next = readRoute();
      setRoute(next);
      if (next) dockRef.current?.open(next);
    };
    addEventListener("hashchange", handler);
    if (!location.hash)
      // Keep the restored active tab honoured; fall back to the first open page.
      location.hash =
        "#/" + (initial.current.active ?? initialPages.current[0] ?? "empty");
    handler();
    return () => removeEventListener("hashchange", handler);
  }, []);
  return { dockRef, route, pages, setPages, onActive, openPage };
}
