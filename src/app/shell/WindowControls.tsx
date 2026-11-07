import { tFor } from "../../shared/i18n";
import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, Copy, X } from "lucide-react";
import { requestGuardedClose } from "../closeGuard";
import "./windowChrome.css";

export function WindowControls({ zh }: { zh: boolean }) {
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState(false);
  const native = isTauri();
  useEffect(() => {
    if (!native) return;
    const window = getCurrentWindow();
    if (window.label !== "main") return;
    let disposed = false;
    let unresize: (() => void) | undefined;
    const refresh = () =>
      void window
        .isMaximized()
        .then((value) => {
          if (!disposed) setMaximized(value);
        })
        .catch(() => {});
    refresh();
    void window
      .onResized(refresh)
      .then((stop) => {
        if (disposed) stop();
        else unresize = stop;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unresize?.();
    };
  }, [native]);
  if (!native || getCurrentWindow().label !== "main") return null;
  const run = (action: () => Promise<unknown>) => {
    setError(false);
    void action().catch(() => setError(true));
  };
  return (
    <div
      className="window-controls"
      data-tauri-drag-region="false"
      data-window-chrome-controls="ready"
      data-window-chrome-ready="true"
    >
      <button
        type="button"
        data-window-chrome-action="minimize"
        aria-label={tFor(zh ? "zh-CN" : "en-US", "shell.minimize")}
        onClick={() => run(() => getCurrentWindow().minimize())}
      >
        <Minus size={14} />
      </button>
      <button
        type="button"
        data-window-chrome-action="maximize"
        aria-label={
          maximized
            ? tFor(zh ? "zh-CN" : "en-US", "shell.restore.window")
            : tFor(zh ? "zh-CN" : "en-US", "shell.maximize")
        }
        onClick={() =>
          run(async () => {
            const w = getCurrentWindow();
            await w.toggleMaximize();
            setMaximized(await w.isMaximized());
          })
        }
      >
        {maximized ? <Copy size={13} /> : <Square size={13} />}
      </button>
      <button
        type="button"
        className="window-close"
        data-window-chrome-action="close"
        aria-label={tFor(zh ? "zh-CN" : "en-US", "shell.close.window")}
        onClick={() => run(() => requestGuardedClose("window"))}
      >
        <X size={15} />
      </button>
      {error && (
        <span role="alert" className="window-control-error">
          {tFor(zh ? "zh-CN" : "en-US", "shell.window.action.failed")}
        </span>
      )}
    </div>
  );
}
