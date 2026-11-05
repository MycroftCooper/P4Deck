import { t as translate, tFor } from "../../shared/i18n";
import { Download } from "lucide-react";
import { openUpdatePanel } from "./updatePanelStore";
import {
  updateNeedsAttention,
  updateProgress,
  useUpdateSnapshot,
  type UpdateSnapshot,
} from "./updateStore";
import "./update.css";

function entryCopy(
  snapshot: UpdateSnapshot,
  percent: number | undefined,
  zh: boolean,
): { text: string; label: string } {
  const version = snapshot.version ? `v${snapshot.version}` : "";
  switch (snapshot.phase) {
    case "available":
      return {
        text: tFor(zh ? "zh-CN" : "en-US", "update.status.available", {
          version,
        }),
        label: tFor(zh ? "zh-CN" : "en-US", "update.new.available.open", {
          p1: zh ? version : version,
        }),
      };
    case "downloading":
      return {
        text: translate("update.downloading.update"),
        label:
          percent === undefined
            ? tFor(zh ? "zh-CN" : "en-US", "update.status.downloading")
            : tFor(zh ? "zh-CN" : "en-US", "update.status.downloadingPercent", {
                percent,
              }),
      };
    case "installing":
      return {
        text: translate("update.installing.update"),
        label: translate("update.installing.update.open"),
      };
    case "ready":
      return {
        text: tFor(zh ? "zh-CN" : "en-US", "update.status.ready", {
          version,
        }),
        label: translate("update.the.update.is.downloaded.confirm"),
      };
    default:
      return snapshot.applied
        ? {
            text: translate("update.restart.pending"),
            label: translate("update.the.update.is.installed.restart"),
          }
        : {
            text: translate("update.update.failed"),
            label: translate("update.the.failed.open"),
          };
  }
}

/**
 * Titlebar entry between the workspace switcher and the window controls. It
 * only renders while an update needs the user, never during idle/checking.
 */
export function UpdateEntry({ zh }: { zh: boolean }) {
  const snapshot = useUpdateSnapshot();
  if (!updateNeedsAttention(snapshot.phase)) return null;
  const percent = updateProgress(snapshot);
  const { text, label } = entryCopy(snapshot, percent, zh);
  return (
    <button
      type="button"
      className={`update-entry is-${snapshot.phase}`}
      data-tauri-drag-region="false"
      data-update-entry
      aria-label={label}
      title={label}
      onClick={openUpdatePanel}
    >
      <Download size={14} aria-hidden="true" />
      <span className="update-entry-text">{text}</span>
      {snapshot.phase === "downloading" && (
        <span className="update-entry-percent">
          {percent === undefined ? "…" : `${percent}%`}
        </span>
      )}
    </button>
  );
}
