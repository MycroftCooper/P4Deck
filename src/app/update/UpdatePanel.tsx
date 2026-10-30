import { Dialog, DialogNotice } from "../dialogs/Dialog";
import { formatBytes } from "./format";
import { isWindowsPlatform } from "./updaterClient";
import { closeUpdatePanel, useUpdatePanelOpen } from "./updatePanelStore";
import {
  checkForUpdates,
  downloadUpdate,
  installAndRestart,
  updateFailureText,
} from "./updateService";
import {
  updateProgress,
  useUpdateSnapshot,
  type UpdateSnapshot,
} from "./updateStore";
import "./update.css";

/**
 * One panel for the whole update flow: announce, download progress, the install
 * confirmation, and the failure reason. Mounted once by `App`; it only renders
 * while the titlebar entry (or a manual check) opened it. Installing only ever
 * happens after the user confirms in this panel.
 */
export function UpdatePanel({ zh }: { zh: boolean }) {
  const open = useUpdatePanelOpen();
  const snapshot = useUpdateSnapshot();
  if (!open) return null;
  return <UpdateDialog snapshot={snapshot} zh={zh} />;
}

function UpdateDialog({
  snapshot,
  zh,
}: {
  snapshot: UpdateSnapshot;
  zh: boolean;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const windows = isWindowsPlatform();
  const percent = updateProgress(snapshot);
  const totalSize = formatBytes(snapshot.totalBytes);
  const downloadedSize = formatBytes(snapshot.downloadedBytes);
  const busy =
    snapshot.phase === "installing" || snapshot.phase === "restarting";
  const retry = () => void checkForUpdates({ manual: true, zh });
  const download = () => void downloadUpdate();
  const install = () => void installAndRestart();
  const installLabel = windows
    ? tr("立即安装并重启", "Install and restart now")
    : tr("立即安装后重启", "Install, then restart");
  const title =
    snapshot.phase === "ready"
      ? tr("更新已下载", "Update downloaded")
      : snapshot.phase === "installing"
        ? tr("正在安装更新", "Installing update")
        : snapshot.phase === "restarting"
          ? tr("正在重启", "Restarting")
          : snapshot.phase === "error"
            ? tr("更新失败", "Update failed")
            : snapshot.version
              ? tr(
                  `发现新版本 v${snapshot.version}`,
                  `New version v${snapshot.version}`,
                )
              : tr("检查更新", "Check for updates");
  const description =
    snapshot.phase === "available"
      ? tr(
          "先下载更新；下载完成后确认安装并重启，失败会提示原因。",
          "Download the update first; once it finishes you confirm the install and restart. Failures show a reason.",
        )
      : snapshot.phase === "downloading"
        ? tr(
            "下载在后台继续，可以关闭此面板；安装前一定会再确认。",
            "The download continues in the background and you can close this panel; installing always asks again.",
          )
        : snapshot.phase === "ready"
          ? windows
            ? tr(
                "安装会关闭应用，安装器完成后会自动重启。也可以稍后从标题栏继续。",
                "Installing closes the app and the installer restarts it when done. You can also continue later from the titlebar.",
              )
            : tr(
                "安装完成后需要重启应用。也可以稍后从标题栏继续。",
                "The app must restart after installing. You can also continue later from the titlebar.",
              )
          : snapshot.phase === "installing"
            ? windows
              ? tr(
                  "正在安装；应用会关闭，由安装器完成安装并重启。",
                  "Installing; the app closes and the installer finishes and restarts it.",
                )
              : tr(
                  "正在安装更新，完成后应用将重启。",
                  "Installing the update; the app restarts when it finishes.",
                )
            : snapshot.phase === "restarting"
              ? tr("正在重启应用…", "Restarting the app…")
              : snapshot.phase === "error"
                ? snapshot.applied
                  ? tr(
                      "更新已安装，但重启没有完成；请手动重启应用。",
                      "The update is installed but the restart did not finish. Restart the app manually.",
                    )
                  : tr(
                      "更新没有完成，应用仍在当前版本上运行。",
                      "The update did not complete; the app still runs the current version.",
                    )
                : undefined;
  const footer = (() => {
    switch (snapshot.phase) {
      case "available":
        return (
          <>
            <button onClick={closeUpdatePanel}>{tr("稍后", "Later")}</button>
            <button
              className="primary"
              data-dialog-autofocus
              onClick={download}
            >
              {tr("下载更新", "Download update")}
            </button>
          </>
        );
      case "downloading":
        return (
          <>
            <button onClick={closeUpdatePanel}>
              {tr("后台下载", "Download in background")}
            </button>
            <button className="primary" disabled>
              {percent === undefined
                ? tr("正在下载…", "Downloading…")
                : tr(`正在下载 ${percent}%`, `Downloading ${percent}%`)}
            </button>
          </>
        );
      case "ready":
        return (
          <>
            <button data-dialog-autofocus onClick={closeUpdatePanel}>
              {tr("稍后", "Later")}
            </button>
            <button className="primary" onClick={install}>
              {installLabel}
            </button>
          </>
        );
      case "installing":
        return (
          <button className="primary" disabled>
            {tr("正在安装…", "Installing…")}
          </button>
        );
      case "restarting":
        return (
          <button className="primary" disabled>
            {tr("正在重启…", "Restarting…")}
          </button>
        );
      case "error":
        return snapshot.applied ? (
          <button data-dialog-autofocus onClick={closeUpdatePanel}>
            {tr("关闭", "Close")}
          </button>
        ) : (
          <>
            <button onClick={closeUpdatePanel}>{tr("关闭", "Close")}</button>
            <button className="primary" onClick={retry}>
              {tr("重新检查", "Check again")}
            </button>
          </>
        );
      case "checking":
        return (
          <>
            <button onClick={closeUpdatePanel}>{tr("关闭", "Close")}</button>
            <button className="primary" disabled>
              {tr("正在检查…", "Checking…")}
            </button>
          </>
        );
      default:
        return (
          <>
            <button data-dialog-autofocus onClick={closeUpdatePanel}>
              {tr("关闭", "Close")}
            </button>
            <button className="primary" onClick={retry}>
              {tr("检查更新", "Check for updates")}
            </button>
          </>
        );
    }
  })();
  const failureReason = updateFailureText(
    snapshot.error,
    snapshot.errorScope ?? "download",
    zh,
  );
  return (
    <Dialog
      title={title}
      description={description}
      zh={zh}
      busy={busy}
      onRequestClose={closeUpdatePanel}
      footer={footer}
    >
      <p className="update-versions">
        <span>
          {tr("当前版本", "Current")}{" "}
          <code>{snapshot.currentVersion || "—"}</code>
        </span>
        {snapshot.version && (
          <>
            <span aria-hidden="true">→</span>
            <span>
              {tr("新版本", "New")} <strong>v{snapshot.version}</strong>
            </span>
          </>
        )}
      </p>
      {snapshot.notes && (
        <section
          className="update-notes"
          aria-label={tr("更新说明", "Release notes")}
        >
          <h3>{tr("更新说明", "Release notes")}</h3>
          <p>{snapshot.notes}</p>
        </section>
      )}
      {snapshot.phase === "downloading" &&
        snapshot.totalBytes !== undefined && (
          <p className="update-size">
            {tr("已下载", "Downloaded")} {downloadedSize} / {totalSize}
          </p>
        )}
      {snapshot.phase !== "downloading" && totalSize && (
        <p className="update-size">
          {tr("安装包大小", "Installer size")} {totalSize}
        </p>
      )}
      {snapshot.phase === "downloading" && (
        <div className="update-progress-row">
          <div
            className="update-progress"
            role="progressbar"
            aria-label={tr("下载进度", "Download progress")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span style={{ width: `${percent ?? 0}%` }} />
          </div>
          <span className="update-percent">
            {percent === undefined
              ? tr("正在准备下载…", "Preparing download…")
              : `${percent}%`}
          </span>
        </div>
      )}
      {snapshot.phase === "ready" && (
        <DialogNotice>
          {tr(
            "更新已下载，但尚未安装；确认后才会安装。",
            "The update is downloaded but not installed yet; installing only happens after you confirm.",
          )}
        </DialogNotice>
      )}
      {snapshot.phase === "installing" && (
        <DialogNotice>
          {tr(
            "正在安装更新，应用即将关闭或重启。",
            "Installing the update; the app will close or restart.",
          )}
        </DialogNotice>
      )}
      {snapshot.phase === "restarting" && (
        <DialogNotice>
          {tr("正在重启应用…", "Restarting the app…")}
        </DialogNotice>
      )}
      {snapshot.phase === "checking" && (
        <p className="update-checking" role="status">
          {tr("正在检查更新…", "Checking for updates…")}
        </p>
      )}
      {snapshot.phase === "idle" && (
        <DialogNotice>
          {tr("当前已是最新版本。", "You are up to date.")}
        </DialogNotice>
      )}
      {snapshot.phase === "error" && (
        <DialogNotice error>
          <span>{failureReason}</span>
          {snapshot.error && (
            <code className="update-error-detail">{snapshot.error}</code>
          )}
        </DialogNotice>
      )}
    </Dialog>
  );
}
