import { t, tFor } from "../../shared/i18n";
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
    ? t("settings.automatic.updates.are.available.in.the")
    : snapshot.phase === "checking"
      ? t("settings.checking.for.updates")
      : snapshot.phase === "available"
        ? tFor(
            zh ? "zh-CN" : "en-US",
            "update.version.v.is.available.current.v",
            { p1: snapshot.version ?? "", p2: snapshot.currentVersion ?? "" },
          )
        : snapshot.phase === "downloading"
          ? percent === undefined
            ? t("settings.downloading.the.update")
            : tFor(zh ? "zh-CN" : "en-US", "update.downloading.the.update", {
                p1: percent ?? "",
              })
          : snapshot.phase === "installing"
            ? t("settings.installing.the.update")
            : snapshot.phase === "ready"
              ? snapshot.applied
                ? tFor(
                    zh ? "zh-CN" : "en-US",
                    "update.version.v.is.installed.and.waiting",
                    { p1: snapshot.version ?? "" },
                  )
                : tFor(
                    zh ? "zh-CN" : "en-US",
                    "update.version.v.is.downloaded.confirm.install",
                    { p1: snapshot.version ?? "" },
                  )
              : snapshot.phase === "restarting"
                ? t("settings.restarting")
                : snapshot.phase === "error"
                  ? snapshot.applied
                    ? tFor(
                        zh ? "zh-CN" : "en-US",
                        "update.the.update.is.installed.but.the",
                        {
                          p1: updateFailureText(
                            snapshot.error,
                            snapshot.errorScope ?? "restart",
                            zh,
                          ),
                        },
                      )
                    : tFor(
                        zh ? "zh-CN" : "en-US",
                        "update.the.last.update.failed",
                        {
                          p1: updateFailureText(
                            snapshot.error,
                            snapshot.errorScope ?? "check",
                            zh,
                          ),
                        },
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
      <p>{t("settings.the.desktop.app.checks.at.startup")}</p>
    </section>
  );
}
