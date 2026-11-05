import { t } from "../../shared/i18n";
import { useContext, useEffect, useRef } from "react";
import {
  DockviewDefaultTab,
  type IDockviewPanelHeaderProps,
} from "dockview-react";
import { useContextMenu } from "../context-menu/ContextMenu";
import { action, copy } from "../context-menu/bindings";
import { isMultiPage, panelKind } from "../panels";
import { pageIcons } from "../pageIcons";
import { OpenContext, PopoutContext } from "./chrome";
import { detachedPage } from "./types";

export function TabMenu(props: IDockviewPanelHeaderProps) {
  const menu = useContextMenu();
  const open = useContext(OpenContext),
    popout = useContext(PopoutContext);
  const panel = props.containerApi.getPanel(props.api.id);
  const kind = panelKind(props.api.id);
  const Icon = kind ? pageIcons[kind] : undefined;
  const root = useRef<HTMLDivElement>(null);
  const binding =
    panel && kind
      ? menu(
          isMultiPage(kind) ? "T02" : "T01",
          () => {
            const group = panel.group;
            const others = group.panels.filter((p) => p.id !== panel.id);
            const right = group.panels.slice(group.panels.indexOf(panel) + 1);
            const close = (panels: typeof others) => () =>
              panels.forEach((p) => p.api.close());
            return {
              关闭: action(() => panel.api.close()),
              关闭其他页签: action(
                close(others),
                others.length ? undefined : t("shell.tab.noOtherTabs"),
              ),
              关闭右侧页签: action(
                close(right),
                right.length ? undefined : t("shell.tab.noTabsToTheRight"),
              ),
              关闭本组页签: action(close([...group.panels])),
              关闭所有页签: action(close([...props.containerApi.panels])),
              移到右侧分屏: action(
                () => panel.api.moveTo({ group, position: "right" }),
                others.length ? undefined : t("shell.tab.needsTwoTabs"),
              ),
              移到下方分屏: action(
                () => panel.api.moveTo({ group, position: "bottom" }),
                others.length ? undefined : t("shell.tab.needsTwoTabs"),
              ),
              "移到其他组 › 目标组": {
                children: props.containerApi.groups
                  .filter((g) => g.id !== group.id)
                  .map((g) => ({
                    id: `group:${g.id}`,
                    label:
                      g.activePanel?.title ??
                      t("shell.tab.groupFallback", { id: g.id }),
                    run: () => panel.api.moveTo({ group: g }),
                  })),
                reason:
                  props.containerApi.groups.length > 1
                    ? undefined
                    : t("shell.tab.noOtherGroups"),
              },
              弹出独立窗口: action(
                () => popout(panel),
                detachedPage ? t("shell.tab.alreadyDetached") : undefined,
              ),
              "锁定/解锁目标": {
                ...action(() =>
                  panel.api.updateParameters({
                    ...panel.params,
                    locked: !panel.params?.locked,
                  }),
                ),
                checked: !!panel.params?.locked,
              },
              在新页签打开同一目标: action(() =>
                open(kind, panel.params?.target, true),
              ),
              复制目标路径: copy(panel.params?.target),
            };
          },
          { title: panel.title ?? kind },
        )
      : undefined;
  useEffect(() => {
    const tab = root.current?.closest<HTMLElement>('[role="tab"]');
    if (!tab || !binding) return;
    const onKey = (event: KeyboardEvent) =>
      binding.onKeyDown({
        target: event.target,
        currentTarget: tab,
        key: event.key,
        shiftKey: event.shiftKey,
        preventDefault: () => event.preventDefault(),
        stopPropagation: () => event.stopPropagation(),
      });
    tab.addEventListener("keydown", onKey);
    return () => tab.removeEventListener("keydown", onKey);
  });
  return (
    <div ref={root} className="tab-context-target">
      {Icon && <Icon className="dock-tab-icon" size={14} aria-hidden="true" />}
      <DockviewDefaultTab {...props} onContextMenu={binding?.onContextMenu} />
    </div>
  );
}
