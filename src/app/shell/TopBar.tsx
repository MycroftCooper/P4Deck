import { WindowControls } from "./WindowControls";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import { useLayoutEffect, useRef } from "react";
import type { RuntimeInfo } from "../../shared/contracts";
import { WorkspaceSwitcher } from "../../features/workspaces/WorkspaceSwitcher";
import { UpdateEntry } from "../update/UpdateEntry";
import { useAppVersion } from "./useAppVersion";

/** The main window uses a permanent custom titlebar; Tauri owns native dragging. */
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
  // Only the main window owns the update entry; detached panels share the store.
  const nativeMain = isTauri() && getCurrentWindow().label === "main";
  const appVersion = useAppVersion();
  const dragRegion = nativeMain ? "deep" : undefined;
  const header = useRef<HTMLElement>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    header.current?.querySelector<HTMLButtonElement>(".connection")?.focus();
  }, [runtime]);
  return (
    <header className="topbar" ref={header} data-tauri-drag-region={dragRegion}>
      <div className="brand" data-tauri-drag-region={dragRegion}>
        <span className="brand-mark" data-tauri-drag-region={dragRegion}>
          P4
        </span>
        <strong data-tauri-drag-region={dragRegion}>P4Deck</strong>
        {appVersion && (
          <span
            className="titlebar-version"
            data-tauri-drag-region={dragRegion}
            title={`P4Deck v${appVersion}`}
          >
            v{appVersion}
          </span>
        )}
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
      {nativeMain && <UpdateEntry zh={zh} />}
      <WindowControls zh={zh} />
    </header>
  );
}
