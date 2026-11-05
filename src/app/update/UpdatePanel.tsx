import { t, tFor } from "../../shared/i18n";
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
    ? t("update.install.and.restart.now")
    : t("update.install.then.restart");
  const title =
    snapshot.phase === "ready"
      ? t("update.update.downloaded")
      : snapshot.phase === "installing"
        ? t("update.installing.update.2")
        : snapshot.phase === "restarting"
          ? t("update.restarting")
          : snapshot.phase === "error"
            ? t("update.update.failed")
            : snapshot.version
              ? tFor(zh ? "zh-CN" : "en-US", "update.new.version.v", {
                  p1: snapshot.version,
                })
              : t("update.check.for.updates");
  const description =
    snapshot.phase === "available"
      ? t("update.download.the.update.first.once.it")
      : snapshot.phase === "downloading"
        ? t("update.the.download.continues.in.the.background")
        : snapshot.phase === "ready"
          ? windows
            ? t("update.installing.closes.the.app.and.the")
            : t("update.the.app.must.restart.after.installing")
          : snapshot.phase === "installing"
            ? windows
              ? t("update.installing.the.app.closes.and.the")
              : t("update.installing.the.update.the.app.restarts")
            : snapshot.phase === "restarting"
              ? t("update.restarting.the.app")
              : snapshot.phase === "error"
                ? snapshot.applied
                  ? t("update.the.update.is.installed.but.the")
                  : t("update.the.update.did.not.complete.the")
                : undefined;
  const footer = (() => {
    switch (snapshot.phase) {
      case "available":
        return (
          <>
            <button onClick={closeUpdatePanel}>{t("update.later")}</button>
            <button
              className="primary"
              data-dialog-autofocus
              onClick={download}
            >
              {t("update.download.update")}
            </button>
          </>
        );
      case "downloading":
        return (
          <>
            <button onClick={closeUpdatePanel}>
              {t("update.download.in.background")}
            </button>
            <button className="primary" disabled>
              {percent === undefined
                ? t("update.downloading")
                : tFor(zh ? "zh-CN" : "en-US", "update.downloading", {
                    p1: percent,
                  })}
            </button>
          </>
        );
      case "ready":
        return (
          <>
            <button data-dialog-autofocus onClick={closeUpdatePanel}>
              {t("update.later")}
            </button>
            <button className="primary" onClick={install}>
              {installLabel}
            </button>
          </>
        );
      case "installing":
        return (
          <button className="primary" disabled>
            {t("update.installing")}
          </button>
        );
      case "restarting":
        return (
          <button className="primary" disabled>
            {t("update.restarting.2")}
          </button>
        );
      case "error":
        return snapshot.applied ? (
          <button data-dialog-autofocus onClick={closeUpdatePanel}>
            {t("update.close")}
          </button>
        ) : (
          <>
            <button onClick={closeUpdatePanel}>{t("update.close")}</button>
            <button className="primary" onClick={retry}>
              {t("update.check.again")}
            </button>
          </>
        );
      case "checking":
        return (
          <>
            <button onClick={closeUpdatePanel}>{t("update.close")}</button>
            <button className="primary" disabled>
              {t("update.checking")}
            </button>
          </>
        );
      default:
        return (
          <>
            <button data-dialog-autofocus onClick={closeUpdatePanel}>
              {t("update.close")}
            </button>
            <button className="primary" onClick={retry}>
              {t("update.check.for.updates")}
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
          {t("update.current")} <code>{snapshot.currentVersion || "—"}</code>
        </span>
        {snapshot.version && (
          <>
            <span aria-hidden="true">→</span>
            <span>
              {t("update.new")} <strong>v{snapshot.version}</strong>
            </span>
          </>
        )}
      </p>
      {snapshot.notes && (
        <section
          className="update-notes"
          aria-label={t("update.release.notes")}
        >
          <h3>{t("update.release.notes")}</h3>
          <p>{snapshot.notes}</p>
        </section>
      )}
      {snapshot.phase === "downloading" &&
        snapshot.totalBytes !== undefined && (
          <p className="update-size">
            {t("update.downloaded")} {downloadedSize} / {totalSize}
          </p>
        )}
      {snapshot.phase !== "downloading" && totalSize && (
        <p className="update-size">
          {t("update.installer.size")} {totalSize}
        </p>
      )}
      {snapshot.phase === "downloading" && (
        <div className="update-progress-row">
          <div
            className="update-progress"
            role="progressbar"
            aria-label={t("update.download.progress")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span style={{ width: `${percent ?? 0}%` }} />
          </div>
          <span className="update-percent">
            {percent === undefined
              ? t("update.preparing.download")
              : `${percent}%`}
          </span>
        </div>
      )}
      {snapshot.phase === "ready" && (
        <DialogNotice>
          {t("update.the.update.is.downloaded.but.not")}
        </DialogNotice>
      )}
      {snapshot.phase === "installing" && (
        <DialogNotice>
          {t("update.installing.the.update.the.app.will")}
        </DialogNotice>
      )}
      {snapshot.phase === "restarting" && (
        <DialogNotice>{t("update.restarting.the.app")}</DialogNotice>
      )}
      {snapshot.phase === "checking" && (
        <p className="update-checking" role="status">
          {t("update.checking.for.updates")}
        </p>
      )}
      {snapshot.phase === "idle" && (
        <DialogNotice>{t("update.you.are.up.to.date")}</DialogNotice>
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
