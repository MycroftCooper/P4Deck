import { useCallback, useEffect, useRef, useState } from "react";
import { detachedPage, type DockHandle } from "../DockWorkspace";
import { isPage, readPages, type PageId } from "../panels";
import { storage } from "../../shared/lib/storage";
const readRoute = (): PageId | null => {
  const value = location.hash.replace("#/", "");
  return isPage(value) ? value : null;
};
export function usePageNavigation() {
  const dockRef = useRef<DockHandle>(null);
  const [route, setRoute] = useState(readRoute);
  const [pages, setPages] = useState(() =>
    readPages(storage.getItem("p4deck.pages")),
  );
  const initialPages = useRef(pages);
  const onActive = useCallback((page: PageId | null) => {
    setRoute(page);
    history.replaceState(null, "", "#/" + (page ?? "empty"));
  }, []);
  const openPage = useCallback((page: PageId) => {
    dockRef.current?.open(page);
  }, []);
  useEffect(() => {
    if (!detachedPage) storage.setItem("p4deck.pages", JSON.stringify(pages));
  }, [pages]);
  useEffect(() => {
    if (detachedPage) return;
    const handler = () => {
      const next = readRoute();
      setRoute(next);
      if (next) dockRef.current?.open(next);
    };
    addEventListener("hashchange", handler);
    if (!location.hash)
      location.hash = "#/" + (initialPages.current[0] ?? "empty");
    handler();
    return () => removeEventListener("hashchange", handler);
  }, []);
  return { dockRef, route, pages, setPages, onActive, openPage };
}
