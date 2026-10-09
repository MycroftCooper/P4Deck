import {
  Files,
  Search,
  ListTodo,
  ListChecks,
  Monitor,
  Network,
  Settings,
  X,
  TerminalSquare,
  ScrollText,
} from "lucide-react";
import { activityPageIds, type PageId } from "../panels";
import { useContextMenu } from "../context-menu/ContextMenu";
import { useMenuEnvironment } from "../context-menu/environment";
import { action } from "../context-menu/bindings";
const icons = {
  search: Search,
  files: Files,
  pending: ListTodo,
  submitted: ListChecks,
  workspaces: Monitor,
  streams: Network,
  terminal: TerminalSquare,
  p4log: ScrollText,
  settings: Settings,
};
interface Props {
  zh: boolean;
  labels: Record<PageId, string>;
  pages: PageId[];
  active: PageId | null;
  onOpenPage(page: PageId): void;
  onCloseAll(): void;
}
export function ActivityBar({
  zh,
  labels,
  pages,
  active,
  onOpenPage,
  onCloseAll,
}: Props) {
  const menu = useContextMenu();
  const { preferences } = useMenuEnvironment();
  return (
    <nav
      {...menu("T04", () => ({
        "显示/隐藏活动栏文字": {
          ...action(() =>
            preferences.setUi((v) => ({
              ...v,
              activityBarText: !v.activityBarText,
            })),
          ),
          checked: preferences.ui.activityBarText,
        },
        打开设置: action(() => onOpenPage("settings")),
      }))}
      className="activity-bar"
      aria-label={zh ? "活动栏" : "Activity bar"}
    >
      <div className="activity-scroll">
        <div
          className="activity-group"
          role="group"
          aria-label={zh ? "页面" : "Pages"}
        >
          {activityPageIds.map((page) => {
            const Icon = icons[page];
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
                <Icon size={20} />
                <span className="activity-text">{labels[page]}</span>
                {pages.includes(page) && (
                  <span className="activity-open-mark" aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>
        <div className="activity-group">
          <button
            title={zh ? "关闭所有页签" : "Close all tabs"}
            aria-label={zh ? "关闭所有页签" : "Close all tabs"}
            disabled={!pages.length}
            onClick={onCloseAll}
          >
            <X size={20} />
            <span className="activity-text">
              {zh ? "关闭所有页签" : "Close all tabs"}
            </span>
          </button>
        </div>
      </div>
      <div className="activity-bottom">
        <button
          title={labels.settings}
          aria-label={labels.settings}
          aria-current={active === "settings" ? "page" : undefined}
          onClick={() => onOpenPage("settings")}
        >
          <Settings size={20} />
          <span className="activity-text">{labels.settings}</span>
        </button>
      </div>
    </nav>
  );
}
