import { t } from "../../shared/i18n";
import { Download, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { currentAppVersion } from "../../app/update/updaterClient";
import {
  checkForUpdates,
  updateFailureText,
} from "../../app/update/updateService";
import {
  updateProgress,
  useUpdateSnapshot,
} from "../../app/update/updateStore";
import "../../app/update/update.css";

/**
 * Manual update entry in Settings. It mirrors the titlebar state, so a check
 * started here and a download started from the titlebar stay coherent.
 */
export function UpdateSettingsCard({
  zh,
  native,
}: {
  zh: boolean;
  native: boolean;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const snapshot = useUpdateSnapshot();
  const [version, setVersion] = useState<string>();
  useEffect(() => {
    if (!native) return;
    let active = true;
    void currentAppVersion().then((value) => {
      if (active) setVersion(value);
    });
    return () => {
      active = false;
    };
  }, [native]);
  const busy = ["checking", "downloading", "installing", "restarting"].includes(
    snapshot.phase,
  );
  const percent = updateProgress(snapshot);
  const running = version ?? snapshot.currentVersion;
  const status = !native
    ? tr(
        "仅桌面版支持自动更新。",
        "Automatic updates are available in the desktop app only.",
      )
    : snapshot.phase === "checking"
      ? t("settings.checking.for.updates")
      : snapshot.phase === "available"
        ? tr(
            `有新版本 v${snapshot.version}（当前 v${snapshot.currentVersion}）。`,
            `Version v${snapshot.version} is available (current: v${snapshot.currentVersion}).`,
          )
        : snapshot.phase === "downloading"
          ? percent === undefined
            ? t("settings.downloading.the.update")
            : tr(
                `正在下载更新 ${percent}%。`,
                `Downloading the update (${percent}%).`,
              )
          : snapshot.phase === "installing"
            ? t("settings.installing.the.update")
            : snapshot.phase === "ready"
              ? snapshot.applied
                ? tr(
                    `更新 v${snapshot.version} 已安装，正在等待重启。`,
                    `Version v${snapshot.version} is installed and waiting for a restart.`,
                  )
                : tr(
                    `更新 v${snapshot.version} 已下载，确认安装并重启后生效。`,
                    `Version v${snapshot.version} is downloaded. Confirm install and restart to apply it.`,
                  )
              : snapshot.phase === "restarting"
                ? t("settings.restarting")
                : snapshot.phase === "error"
                  ? snapshot.applied
                    ? tr(
                        `更新已安装，但重启失败：${updateFailureText(snapshot.error, snapshot.errorScope ?? "restart", zh)}`,
                        `The update is installed but the restart failed: ${updateFailureText(snapshot.error, snapshot.errorScope ?? "restart", zh)}`,
                      )
                    : tr(
                        `上次更新失败：${updateFailureText(snapshot.error, snapshot.errorScope ?? "check", zh)}`,
                        `The last update failed: ${updateFailureText(snapshot.error, snapshot.errorScope ?? "check", zh)}`,
                      )
                  : tr(
                      `当前版本 ${running ? `v${running}` : "未知"}。`,
                      `Current version ${running ? `v${running}` : "unknown"}.`,
                    );
  return (
    <section className="settings-card">
      <h2>
        <Download size={18} />
        {t("settings.updates")}
      </h2>
      <p
        className={`update-settings-status ${snapshot.phase === "error" ? "is-error" : ""}`}
      >
        {status}
      </p>
      <div className="settings-actions">
        <button
          className="secondary"
          disabled={
            !native || busy || snapshot.phase === "ready" || snapshot.applied
          }
          onClick={() => void checkForUpdates({ manual: true, zh })}
        >
          <RefreshCw size={14} aria-hidden="true" />
          {snapshot.phase === "checking"
            ? t("settings.checking.3")
            : t("settings.check.for.updates")}
        </button>
      </div>
      <p>
        {tr(
          "桌面版启动时及每 6 小时自动检查，有新版本时标题栏会提示。首个包含自动更新的版本需要手动安装一次，之后的版本才能自动升级。",
          "The desktop app checks at startup and every six hours; the titlebar announces new versions. The first build that includes automatic updates must be installed manually once; later versions update themselves.",
        )}
      </p>
    </section>
  );
}
