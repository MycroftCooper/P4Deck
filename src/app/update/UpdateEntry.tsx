import { t } from "../../shared/i18n";
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
        label: zh
          ? `有新版本 ${version}，点击查看更新`
          : `New version ${version} is available. Open the update panel.`,
      };
    case "downloading":
      return {
        text: t("update.downloading.update"),
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
        text: t("update.installing.update"),
        label: zh
          ? "正在安装更新，点击查看进度"
          : "Installing the update. Open the update panel for progress.",
      };
    case "ready":
      return {
        text: zh ? `待重启 ${version}` : `Restart to update ${version}`,
        label: zh
          ? "更新已下载，确认安装并重启后生效；点击查看"
          : "The update is downloaded. Confirm install and restart to apply it.",
      };
    default:
      return snapshot.applied
        ? {
            text: t("update.restart.pending"),
            label: zh
              ? "更新已安装，请手动重启应用完成更新"
              : "The update is installed; restart the app manually to finish.",
          }
        : {
            text: t("update.update.failed"),
            label: zh
              ? "更新失败，点击查看原因"
              : "The update failed. Open the panel for details.",
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
