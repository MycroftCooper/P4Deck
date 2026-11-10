import { t, tFor } from "../../shared/i18n";
import {
  BookOpen,
  Download,
  ExternalLink,
  RefreshCw,
  ScrollText,
} from "lucide-react";
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
import { backend } from "../../infrastructure/backend";
import { PRODUCT_PAGE_URL, WIKI_URL } from "../../shared/productSite";
import { ChangelogDialog } from "./ChangelogDialog";
import "../../app/update/update.css";

/**
 * Manual update entry in Settings. It mirrors the titlebar state, so a check
 * started here and a download started from the titlebar stay coherent. The
 * changelog and the published product/wiki pages live here too instead of in a
 * separate About module.
 */
export function UpdateSettingsCard({
  zh,
  native,
}: {
  zh: boolean;
  native: boolean;
}) {
  const snapshot = useUpdateSnapshot();
  const [version, setVersion] = useState<string>();
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [linkFailed, setLinkFailed] = useState(false);
  const openLink = async (url: string) => {
    setLinkFailed(false);
    try {
      await backend.openExternalUrl(url);
    } catch {
      // A rejected open (host allowlist or missing shell) must stay visible.
      setLinkFailed(true);
    }
  };
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
    ? t("settings.automatic.are.available")
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
                        "update.installedPendingRestart",
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
                  : running
                    ? tFor(zh ? "zh-CN" : "en-US", "settings.current.version", {
                        p1: `v${running}`,
                      })
                    : tFor(
                        zh ? "zh-CN" : "en-US",
                        "settings.current.version.unknown",
                      );
  return (
    <>
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
          {/* The changelog is bundled data: no host call, so it also works in
              the browser demo where update checks are unavailable. */}
          <button className="secondary" onClick={() => setChangelogOpen(true)}>
            <ScrollText size={14} aria-hidden="true" />
            {t("settings.updates.view.changelog")}
          </button>
          <button
            className="secondary"
            onClick={() => void openLink(PRODUCT_PAGE_URL)}
          >
            <ExternalLink size={14} aria-hidden="true" />
            {t("settings.updates.open.product.page")}
          </button>
          <button className="secondary" onClick={() => void openLink(WIKI_URL)}>
            <BookOpen size={14} aria-hidden="true" />
            {t("settings.updates.open.wiki")}
          </button>
        </div>
        {linkFailed && (
          <div className="settings-notice" role="alert">
            {t("settings.updates.open.failed")}
          </div>
        )}
        <p>{t("settings.the.desktop.app.checks.at.startup")}</p>
      </section>
      {changelogOpen && (
        <ChangelogDialog zh={zh} onClose={() => setChangelogOpen(false)} />
      )}
    </>
  );
}
