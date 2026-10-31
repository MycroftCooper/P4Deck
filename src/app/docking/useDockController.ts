import { useEffect, useRef, useState } from "react";
import type { DockviewApi, IDockviewPanel } from "dockview-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, emitTo } from "@tauri-apps/api/event";
import {
  normalizePanelTarget,
  panelKind,
  isPage,
  isMultiPage,
  reusablePanel,
  targetForPage,
  type PageId,
  type RevisionComparison,
} from "../panels";
import { storage } from "../../shared/lib/storage";
import { deferredTask } from "../../shared/lib/deferredTask";
import { detachedPage, type DockProps, type DockHandle } from "./types";
import { readFloatingPanels, type FloatingPanelRecord } from "./floatingPanels";

export function useDockController(props: DockProps) {
  const api = useRef<DockviewApi | undefined>(undefined);
  const latest = useRef(props);
  latest.current = props;
  const disposables = useRef<{ dispose(): void }[]>([]);
  const [error, setError] = useState("");
  const nativeWindows = useRef(new Set<string>());
  const persistFloating = (records?: FloatingPanelRecord[]) => {
    const panels =
      records ??
      [...nativeWindows.current].map((id) => ({
        id,
        binding: latest.current.runtimeBinding,
      }));
    storage.setItem(
      "p4deck.nativePanels",
      JSON.stringify({ version: 1, panels }),
    );
  };
  useEffect(() => {
    if (nativeWindows.current.size) persistFloating();
  }, [
    props.runtimeBinding.connectionKey,
    props.runtimeBinding.contextGeneration,
    props.runtimeBinding.profileId,
  ]);
  const title = (panel: IDockviewPanel) => {
    const kind = panelKind(panel.id);
    if (kind) {
      const next =
        latest.current.labels[kind] +
        (isMultiPage(kind) && panel.params?.target
          ? ` · ${String(panel.params.target).split(/[\\/]/).pop()}${panel.params.locked ? " 🔒" : ""}`
          : "");
      if (panel.title !== next) panel.api.setTitle(next);
    }
  };
  const restorePanel = (id: string) => {
    const kind = panelKind(id);
    if (!kind || !api.current) return;
    let params = normalizePanelTarget(null);
    try {
      params = normalizePanelTarget(
        JSON.parse(storage.getItem(`p4deck.panel.${id}`) ?? "{}"),
      );
    } catch {
      /* Invalid old state. */
    }
    if (!api.current.getPanel(id))
      api.current.addPanel({
        id,
        component: "page",
        title: latest.current.labels[kind],
        params,
      });
  };
  const open: DockHandle["open"] = (
    page,
    target,
    newInstance = false,
    comparison,
  ) => {
    const requestedComparison = comparison;
    comparison =
      page === "diff"
        ? normalizePanelTarget({ comparison, target }).comparison
        : undefined;
    if (requestedComparison && !comparison) return;
    if (comparison) newInstance = true;
    const dock = api.current;
    if (!dock) return;
    if (isTauri() && detachedPage) {
      void emitTo("main", "panel-open-request", {
        page,
        target,
        newInstance,
        comparison,
      }).catch((e) => setError(String(e)));
      return;
    }
    if (!isMultiPage(page) && nativeWindows.current.has(page)) {
      void invoke("open_panel_window", {
        page,
        binding: latest.current.runtimeBinding,
      }).catch((e) => setError(String(e)));
      return;
    }
    const path =
      target ??
      targetForPage(
        page,
        latest.current.selectedPath,
        latest.current.selectedLocalPath,
      );
    const panel =
      newInstance && isMultiPage(page)
        ? undefined
        : reusablePanel(dock.panels, page, path);
    if (panel) {
      if (isMultiPage(page) && !panel.params?.locked && path !== undefined)
        panel.api.updateParameters({ ...panel.params, target: path });
      panel.api.setActive();
    } else
      dock.addPanel({
        id: isMultiPage(page) ? `${page}--${crypto.randomUUID()}` : page,
        component: "page",
        title: latest.current.labels[page],
        params: {
          target: path ?? "",
          locked: newInstance && isMultiPage(page),
          ...(comparison ? { comparison } : {}),
        },
      });
  };
  useEffect(() => {
    if (!isTauri() || detachedPage) return;
    let off: (() => void) | undefined;
    let dead = false;
    void listen<{
      page: PageId;
      target?: string;
      newInstance?: boolean;
      comparison?: RevisionComparison;
    }>("panel-open-request", ({ payload }) => {
      if (isPage(payload.page))
        open(
          payload.page,
          payload.target,
          payload.newInstance,
          payload.comparison,
        );
    }).then((fn) => {
      if (dead) fn();
      else off = fn;
    });
    return () => {
      dead = true;
      off?.();
    };
  }, []);
  useEffect(() => {
    api.current?.panels.forEach(title);
  }, [props.labels]);
  const follow = (path: string, localPath?: string) =>
    api.current?.panels.forEach((panel) => {
      const kind = panelKind(panel.id),
        target = kind ? targetForPage(kind, path, localPath) : path;
      if (
        kind &&
        isMultiPage(kind) &&
        !panel.params?.locked &&
        panel.params?.target !== target
      )
        panel.api.updateParameters({ ...panel.params, target });
    });
  useEffect(() => {
    if (props.selectedPath !== undefined) {
      follow(props.selectedPath, props.selectedLocalPath);
      storage.setItem(
        "p4deck.fileSelection",
        JSON.stringify({
          path: props.selectedPath,
          localPath: props.selectedLocalPath,
          nonce: Date.now(),
        }),
      );
    }
  }, [props.selectedPath, props.selectedLocalPath]);
  useEffect(() => {
    const handler = (event: StorageEvent) => {
      if (event.key === "p4deck.fileSelection" && event.newValue) {
        try {
          const value = JSON.parse(event.newValue);
          if (typeof value.path === "string")
            follow(value.path, value.localPath);
        } catch {
          /* Ignore invalid state. */
        }
      }
    };
    addEventListener("storage", handler);
    return () => removeEventListener("storage", handler);
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    if (isTauri() && !detachedPage)
      void listen<string>("panel-returned", ({ payload }) => {
        if (panelKind(payload)) {
          nativeWindows.current.delete(payload);
          persistFloating();
          restorePanel(payload);
        }
      }).then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
      disposables.current.forEach((d) => d.dispose());
    };
  }, []);
  useEffect(() => {
    const syncAppearance = () => {
      const root = document.documentElement;
      api.current?.panels.forEach((panel) => {
        const other = panel.api.getWindow().document.documentElement;
        if (other === root) return;
        other.dataset.theme = root.dataset.theme;
        other.dataset.reducedMotion = root.dataset.reducedMotion;
        other.lang = root.lang;
        other.style.setProperty(
          "--list-font-size",
          root.style.getPropertyValue("--list-font-size"),
        );
      });
    };
    const observer = new MutationObserver(syncAppearance);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-reduced-motion", "lang", "style"],
    });
    return () => observer.disconnect();
  }, []);
  const popout = async (panel: IDockviewPanel) => {
    try {
      setError("");
      if (isTauri()) {
        storage.setItem(
          `p4deck.panel.${panel.id}`,
          JSON.stringify(panel.params ?? {}),
        );
        await invoke("open_panel_window", {
          page: panel.id,
          binding: latest.current.runtimeBinding,
        });
        nativeWindows.current.add(panel.id);
        persistFloating();
        api.current?.removePanel(panel);
      } else {
        const opened = await api.current?.addPopoutGroup(panel, {
          popoutUrl: new URL("popout.html", location.href).href,
          position: { left: 100, top: 100, width: 1100, height: 760 },
        });
        if (opened) {
          const root = panel.api.getWindow().document.documentElement;
          root.dataset.theme = document.documentElement.dataset.theme;
          root.lang = document.documentElement.lang;
        }
        if (!opened)
          setError("浏览器未能打开独立窗口，请允许本站弹出窗口后重试。");
      }
    } catch (cause) {
      setError(String(cause));
    }
  };

  const popoutPage: DockHandle["popoutPage"] = async (page) => {
    const dock = api.current;
    if (!dock) return;
    open(page);
    const panel = reusablePanel(dock.panels, page);
    if (panel) await popout(panel);
  };

  const ready = (dock: DockviewApi) => {
    api.current = dock;
    let restored = false;
    if (!detachedPage) {
      try {
        const raw = storage.getItem("p4deck.dockLayout");
        if (raw) {
          dock.fromJSON(JSON.parse(raw));
          restored = true;
        }
      } catch {
        dock.clear();
      }
    }
    if (!restored) {
      if (detachedPage && panelKind(detachedPage)) restorePanel(detachedPage);
      else props.pages.forEach((page) => open(page));
    }
    // Recover detached pages after an application restart rather than losing them.
    if (!detachedPage) {
      const saved = readFloatingPanels(storage.getItem("p4deck.nativePanels"));
      for (const record of saved.panels) {
        if (isTauri()) {
          nativeWindows.current.add(record.id);
          void invoke("open_panel_window", {
            page: record.id,
            binding: latest.current.runtimeBinding,
          }).catch(() => {
            nativeWindows.current.delete(record.id);
            persistFloating();
            restorePanel(record.id);
          });
          const panel = dock.getPanel(record.id);
          if (panel) dock.removePanel(panel);
        } else restorePanel(record.id);
      }
    }
    dock.panels.forEach((panel) =>
      panel.api.updateParameters(normalizePanelTarget(panel.params)),
    );
    if (props.active && !detachedPage) open(props.active);
    let publishedPages = "";
    const persist = deferredTask(() => {
      // Dockview may already be disposed during a parent unmount.
      try {
        dock.panels.forEach((panel) =>
          storage.setItem(
            `p4deck.panel.${panel.id}`,
            JSON.stringify(panel.params ?? {}),
          ),
        );
        if (!detachedPage)
          storage.setItem("p4deck.dockLayout", JSON.stringify(dock.toJSON()));
      } catch {
        /* Keep the last complete saved layout. */
      }
    });
    const flush = () => persist.flush();
    window.addEventListener("pagehide", flush);
    disposables.current.push({
      dispose() {
        flush();
        window.removeEventListener("pagehide", flush);
      },
    });
    const sync = () => {
      const pages = [
        ...new Set(
          [...dock.panels.map((panel) => panel.id), ...nativeWindows.current]
            .map((id) => panelKind(id))
            .filter((page): page is PageId => !!page),
        ),
      ];
      const signature = JSON.stringify(pages);
      if (signature !== publishedPages) {
        publishedPages = signature;
        latest.current.onPages(pages);
      }
      dock.panels.forEach(title);
      persist.schedule();
    };
    const observers = new Map<string, { dispose(): void }>();
    const observe = (panel: IDockviewPanel) => {
      observers.set(
        panel.id,
        panel.api.onDidParametersChange(() => {
          title(panel);
          sync();
          if (dock.activePanel === panel)
            latest.current.onTarget?.(
              panelKind(panel.id) ?? null,
              normalizePanelTarget(panel.params),
              "parameters",
            );
        }),
      );
    };
    disposables.current.push(
      { dispose: () => observers.forEach((d) => d.dispose()) },
      dock.onDidRemovePanel((panel) => {
        observers.get(panel.id)?.dispose();
        observers.delete(panel.id);
      }),
    );
    dock.panels.forEach(observe);
    disposables.current.push(
      dock.onDidAddPanel(observe),
      dock.onDidLayoutChange(sync),
      dock.onDidActivePanelChange(({ panel }) => {
        const kind = panel ? (panelKind(panel.id) ?? null) : null;
        latest.current.onActive(kind);
        latest.current.onTarget?.(kind, normalizePanelTarget(panel?.params));
      }),
    );
    // Dockview handles in-window drops. A drag ending outside the window becomes a popout.
    disposables.current.push(
      dock.onWillDragPanel((event) => {
        const end = (e: DragEvent) => {
          if (
            e.clientX < 0 ||
            e.clientY < 0 ||
            e.clientX > window.innerWidth ||
            e.clientY > window.innerHeight
          ) {
            const panel = dock.getPanel(event.panel.id);
            if (panel) void popout(panel);
          }
        };
        window.addEventListener("dragend", end, { once: true });
      }),
    );
    sync();
    latest.current.onTarget?.(
      dock.activePanel ? (panelKind(dock.activePanel.id) ?? null) : null,
      normalizePanelTarget(dock.activePanel?.params),
    );
  };
  const closeAll = () => {
    api.current?.clear();
    latest.current.onActive(null);
    latest.current.onTarget?.(null, normalizePanelTarget(null));
  };
  return {
    api,
    open,
    closeAll,
    popout,
    popoutPage,
    ready,
    error,
    setError,
  };
}
