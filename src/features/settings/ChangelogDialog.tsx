import { t } from "../../shared/i18n";
import { releasesNewestFirst } from "../../app/update/changelog";
import { Dialog } from "../../app/dialogs/Dialog";
import "./changelog.css";

/**
 * Local release history for Settings -> Updates. It reads the bundled data and
 * never touches the update service, so it works in the browser demo too.
 */
export function ChangelogDialog({
  zh,
  onClose,
}: {
  zh: boolean;
  onClose(): void;
}) {
  const releases = releasesNewestFirst();
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
              {release.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
