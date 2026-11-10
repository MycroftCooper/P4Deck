import { t } from "../../shared/i18n";
import { notesFor, releasesNewestFirst } from "../../app/update/changelog";
import { Dialog } from "../../app/dialogs/Dialog";
import "./changelog.css";

/**
 * Local release history for Settings -> Updates. It reads the bundled data and
 * never touches the update service, so it works in the browser demo too. The
 * bullets follow the application locale; a release that is still missing a
 * translation falls back to the other language instead of rendering nothing.
 */
export function ChangelogDialog({
  zh,
  onClose,
}: {
  zh: boolean;
  onClose(): void;
}) {
  const releases = releasesNewestFirst();
  const locale = zh ? "zh-CN" : "en-US";
  return (
    <Dialog
      title={t("update.changelog.title")}
      zh={zh}
      onRequestClose={onClose}
      footer={
        <button data-dialog-autofocus onClick={onClose}>
          {t("update.changelog.close")}
        </button>
      }
    >
      <div className="changelog-releases">
        {releases.map((release) => (
          <section className="changelog-release" key={release.version}>
            <h3>
              v{release.version}
              {release.date && (
                <time dateTime={release.date}>{release.date}</time>
              )}
            </h3>
            <ul>
              {notesFor(release, locale).map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
