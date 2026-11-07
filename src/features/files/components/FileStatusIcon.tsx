import { t } from "../../../shared/i18n";
import { memo } from "react";
import { File, LockKeyhole, Link2, Archive, GitBranch } from "lucide-react";
import {
  fileBadges,
  fileBadgeGlyph,
  fileBadgeLabel,
  fileBadgeTone,
  type FileDecorationFacts,
} from "../fileDecorations";
import "./fileStatusIcon.css";

/** No subscriptions or requests per row; pure decoration of the supplied snapshot. */
export const FileStatusIcon = memo(function FileStatusIcon({
  facts,
  zh = true,
}: {
  facts: FileDecorationFacts;
  zh?: boolean;
}) {
  const badges = fileBadges(facts);
  const label = badges.length
    ? badges.map((b) => fileBadgeLabel(b, zh)).join("\n")
    : t("files.file.no.additional.status.supplied");
  const overflow = badges.length > 3;
  const visible = badges.slice(0, overflow ? 2 : 3);
  return (
    <span
      className="file-status-icon"
      role="img"
      aria-label={label}
      title={label}
    >
      <File size={18} aria-hidden="true" />
      {visible.map((badge, index) => (
        <span
          key={`${badge.id}:${badge.owner}:${badge.detail}`}
          aria-hidden="true"
          className={`file-badge slot-${index} badge-${badge.id.replace("/", "-")} owner-${badge.owner ?? "none"}`}
          data-badge={badge.id}
          data-tone={fileBadgeTone(badge.id)}
        >
          {["locked", "globalLock", "exclusive"].includes(badge.id) ? (
            <LockKeyhole size={9} strokeWidth={3} />
          ) : badge.id === "symlink" ? (
            <Link2 size={9} strokeWidth={3} />
          ) : badge.id === "shelf" ? (
            <Archive size={9} strokeWidth={3} />
          ) : badge.id === "branch" ? (
            <GitBranch size={9} strokeWidth={3} />
          ) : (
            fileBadgeGlyph(badge.id)
          )}
        </span>
      ))}
      {overflow && (
        <span className="file-badge slot-2 badge-overflow" aria-hidden="true">
          +{badges.length - 2}
        </span>
      )}
    </span>
  );
});
