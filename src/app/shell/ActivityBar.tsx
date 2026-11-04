import { t } from "../../shared/i18n";
import { activityPageIds, type PageId } from "../panels";
import { pageIcons } from "../pageIcons";
import { useContextMenu } from "../context-menu/ContextMenu";
import { action } from "../context-menu/bindings";
interface Props {
  zh: boolean;
  labels: Record<PageId, string>;
  pages: PageId[];
  active: PageId | null;
  onOpenPage(page: PageId): void;
}
export function ActivityBar({ zh, labels, pages, active, onOpenPage }: Props) {
  const menu = useContextMenu();
  return (
    <nav
      {...menu("T04", () => ({
        打开设置: action(() => onOpenPage("settings")),
      }))}
      className="activity-bar toolbar-navigation"
      aria-label={t("shell.page.navigation")}
    >
      <div className="activity-scroll">
        <div
          className="activity-group"
          role="group"
          aria-label={t("shell.pages")}
        >
          {activityPageIds.map((page) => {
            const Icon = pageIcons[page];
            const label =
              labels[page] +
              " · " +
              (pages.includes(page)
                ? zh
                  ? "切换到页签"
                  : "Show tab"
                : zh
                  ? "打开页签"
                  : "Open tab");
            return (
              <button
                key={page}
                title={label}
                aria-label={label}
                aria-current={active === page ? "page" : undefined}
                onClick={() => onOpenPage(page)}
              >
                <Icon size={17} />
                <span className="activity-text">{labels[page]}</span>
                {pages.includes(page) && (
                  <span className="activity-open-mark" aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
