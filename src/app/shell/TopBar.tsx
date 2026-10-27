import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Minus, Square, Copy, X } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { subscribeSafely } from "../../shared/lib/subscription";
import type { RuntimeInfo } from "../../shared/contracts/types";
import { WorkspaceSwitcher } from "../../features/workspaces/WorkspaceSwitcher";
export function TopBar({
  runtime,
  zh,
  onRuntime,
  onSettings,
}: {
  runtime: RuntimeInfo;
  zh: boolean;
  onRuntime(runtime: RuntimeInfo): void;
  onSettings(): void;
}) {
  const header = useRef<HTMLElement>(null);
  const restoreFocus = useRef(false);
  const native = isTauri() && getCurrentWindow().label === "main";
  // Wry enables WebView2 non-client regions. Let Windows handle caption drags
  // directly instead of routing mouse-down through Tauri's JavaScript IPC.
  const systemDrag = native && /Windows/.test(navigator.userAgent);
  const dragRegion = native && !systemDrag ? "" : undefined;
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!native) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const appWindow = getCurrentWindow();
    const update = async () => {
      const next = await appWindow.isMaximized();
      if (live) setMaximized(next);
    };
    void update().catch(console.error);
    const unsubscribe = subscribeSafely(() =>
      appWindow.onResized(() => {
        clearTimeout(timer);
        timer = setTimeout(() => void update().catch(console.error), 100);
      }),
    );
    return () => {
      live = false;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [native]);
  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    header.current?.querySelector<HTMLButtonElement>(".connection")?.focus();
  }, [runtime]);
  return (
    <header
      className={`topbar${native ? " custom-titlebar" : ""}${systemDrag ? " system-drag" : ""}`}
      ref={header}
      data-tauri-drag-region={dragRegion}
    >
      <div className="brand" data-tauri-drag-region={dragRegion}>
        <span className="brand-mark" data-tauri-drag-region={dragRegion}>
          P4
        </span>
        <strong data-tauri-drag-region={dragRegion}>P4Deck</strong>
      </div>
      <WorkspaceSwitcher
        key={JSON.stringify([
          runtime.activeProfileId,
          runtime.contextGeneration,
          runtime.context,
        ])}
        runtime={runtime}
        zh={zh}
        onRuntime={(next) => {
          restoreFocus.current = true;
          onRuntime(next);
        }}
        onSettings={onSettings}
      />
      {native ? (
        <div
          className="window-controls"
          role="group"
          aria-label={zh ? "窗口控制" : "Window controls"}
        >
          <button
            type="button"
            aria-label={zh ? "最小化" : "Minimize"}
            title={zh ? "最小化" : "Minimize"}
            onClick={() =>
              void getCurrentWindow().minimize().catch(console.error)
            }
          >
            <Minus size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={
              maximized
                ? zh
                  ? "还原窗口"
                  : "Restore window"
                : zh
                  ? "最大化"
                  : "Maximize"
            }
            title={
              maximized
                ? zh
                  ? "还原窗口"
                  : "Restore window"
                : zh
                  ? "最大化"
                  : "Maximize"
            }
            onClick={() =>
              void getCurrentWindow().toggleMaximize().catch(console.error)
            }
          >
            {maximized ? (
              <Copy size={13} aria-hidden="true" />
            ) : (
              <Square size={13} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className="window-close"
            aria-label={zh ? "关闭窗口" : "Close window"}
            title={zh ? "关闭窗口" : "Close window"}
            onClick={() => void getCurrentWindow().close().catch(console.error)}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </div>
      ) : (
        <div className="titlebar-reserved" aria-hidden="true" />
      )}
    </header>
  );
}
