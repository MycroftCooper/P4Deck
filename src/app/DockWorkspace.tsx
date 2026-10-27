import { forwardRef, useImperativeHandle } from "react";
import { DockviewReact } from "dockview-react";
import {
  Actions,
  CloseAllContext,
  Empty,
  LanguageContext,
  OpenContext,
  RenderContext,
  PopoutContext,
  components,
  dockTheme,
} from "./docking/chrome";
import { useContextMenu } from "./context-menu/ContextMenu";
import { action } from "./context-menu/bindings";
import { panelKind } from "./panels";
import { TabMenu } from "./docking/TabMenu";
import { useDockController } from "./docking/useDockController";
import type { DockHandle, DockProps } from "./docking/types";
import "dockview-react/dist/styles/dockview.css";
export { detachedPage, type DockHandle } from "./docking/types";

export const DockWorkspace = forwardRef<DockHandle, DockProps>(
  function DockWorkspace(props, ref) {
    const controller = useDockController(props);
    const menu = useContextMenu();
    const tabbarMenu = (source: Element) =>
      menu("T03", () => {
        const dock = controller.api.current;
        const group = dock?.groups.find((candidate) =>
          candidate.element.contains(source),
        );
        const panels = [...(group?.panels ?? [])];
        const bindings: import("./context-menu/model").MenuBindings = {};
        for (const [name, page] of Object.entries({
          文件: "files",
          搜索: "search",
          Pending: "pending",
          Submitted: "submitted",
          Workspaces: "workspaces",
          Streams: "streams",
          "Stream Graph": "streamgraph",
          "Branch Mappings": "branchmappings",
          Terminal: "terminal",
          "P4 Log": "p4log",
          设置: "settings",
        } as const)) {
          bindings["打开全局页签 › " + name] = {
            ...action(() => controller.open(page)),
            hidden:
              props.pages.includes(page) ||
              dock?.panels.some((p) => panelKind(p.id) === page),
          };
        }
        bindings["关闭本组页签"] = action(
          () => panels.forEach((p) => p.api.close()),
          panels.length ? undefined : "没有页签",
        );
        bindings["关闭所有页签"] = action(
          controller.closeAll,
          dock?.panels.length ? undefined : "没有页签",
        );
        return bindings;
      });
    useImperativeHandle(ref, () => ({
      open: controller.open,
      closeAll: controller.closeAll,
      popoutPage: controller.popoutPage,
    }));
    return (
      <CloseAllContext.Provider
        value={{ run: controller.closeAll, enabled: props.pages.length > 0 }}
      >
        <LanguageContext.Provider value={props.zh}>
          <OpenContext.Provider value={controller.open}>
            <RenderContext.Provider value={props.render}>
              <PopoutContext.Provider
                value={(panel) => void controller.popout(panel)}
              >
                <div
                  className="dock-host"
                  onContextMenu={(event) => {
                    if (
                      (event.target as Element).closest(
                        ".dv-tabs-and-actions-container, .closed-pages",
                      )
                    )
                      tabbarMenu(event.target as Element).onContextMenu(event);
                  }}
                  onKeyDown={(event) => {
                    if (
                      (event.target as Element).closest(
                        ".dock-actions, .closed-pages",
                      )
                    )
                      tabbarMenu(event.target as Element).onKeyDown(event);
                  }}
                >
                  {controller.error && (
                    <div className="dock-error" role="alert">
                      {controller.error}
                      <button onClick={() => controller.setError("")}>×</button>
                    </div>
                  )}
                  <DockviewReact
                    theme={dockTheme}
                    className="dockview-theme-p4deck"
                    components={components}
                    defaultTabComponent={TabMenu}
                    rightHeaderActionsComponent={Actions}
                    watermarkComponent={Empty}
                    disableFloatingGroups
                    onReady={({ api }) => controller.ready(api)}
                  />
                </div>
              </PopoutContext.Provider>
            </RenderContext.Provider>
          </OpenContext.Provider>
        </LanguageContext.Provider>
      </CloseAllContext.Provider>
    );
  },
);
