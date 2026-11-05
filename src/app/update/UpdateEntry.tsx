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
        text: zh ? `有新版本 ${version}` : `New version ${version}`,
        label: tFor(
          zh ? "zh-CN" : "en-US",
          "update.new.version.is.available.open.the",
          { p1: zh ? version : version },
        ),
      };
    case "downloading":
      return {
        text: translate("update.downloading.update"),
        label: zh
          ? percent === undefined
            ? "正在下载更新，点击查看进度"
            : `正在下载更新 ${percent}%，点击查看进度`
          : percent === undefined
            ? "Downloading the update. Open the update panel for progress."
            : `Downloading the update (${percent}%). Open the update panel for progress.`,
      };
    case "installing":
      return {
        text: translate("update.installing.update"),
        label: translate("update.installing.the.update.open.the"),
      };
    case "ready":
      return {
        text: zh ? `待重启 ${version}` : `Restart to update ${version}`,
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
            label: translate("update.the.update.failed.open.the"),
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
