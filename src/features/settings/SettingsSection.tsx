import { tFor } from "../../shared/i18n";
import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export interface SettingsSectionProps {
  /** Stable id used by the settings navigation and the collapse persistence. */
  id: string;
  title: string;
  icon?: ReactNode;
  expanded: boolean;
  onToggle(): void;
  zh: boolean;
  /** Complex sections (connections/appearance) span the full content width. */
  wide?: boolean;
  children: ReactNode;
}

/** One collapsible settings module with an accessible expand/collapse control. */
export function SettingsSection({
  id,
  title,
  icon,
  expanded,
  onToggle,
  zh,
  wide,
  children,
}: SettingsSectionProps) {
  const bodyId = `settings-section-${id}-body`;
  return (
    <section
      id={`settings-section-${id}`}
      className={`settings-section${wide ? " settings-section--wide" : ""}`}
      data-settings-section={id}
      data-expanded={expanded ? "true" : "false"}
      aria-labelledby={`settings-section-${id}-title`}
    >
      <div className="settings-section-head">
        <h2 id={`settings-section-${id}-title`}>
          {icon}
          <span>{title}</span>
        </h2>
        <button
          type="button"
          className="settings-section-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={
            expanded
              ? tFor(zh ? "zh-CN" : "en-US", "settings.collapse", {
                  p1: zh ? title : title,
                })
              : tFor(zh ? "zh-CN" : "en-US", "settings.expand", {
                  p1: zh ? title : title,
                })
          }
          onClick={onToggle}
        >
          <ChevronDown
            size={18}
            aria-hidden="true"
            className={expanded ? "is-expanded" : "is-collapsed"}
          />
        </button>
      </div>
      <div id={bodyId} className="settings-section-body" hidden={!expanded}>
        {children}
      </div>
    </section>
  );
}
