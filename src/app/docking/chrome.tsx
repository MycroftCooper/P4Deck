import { createContext, useContext } from "react";
import {
  themeLight,
  type IDockviewPanelProps,
  type IDockviewHeaderActionsProps,
  type IDockviewPanel,
} from "dockview-react";
import {
  Columns2,
  Rows2,
  ExternalLink,
  Lock,
  Unlock,
  CopyPlus,
} from "lucide-react";
import {
  normalizePanelTarget,
  panelKind,
  isMultiPage,
  type PanelTarget,
} from "../panels";
import { detachedPage, type DockHandle, type DockProps } from "./types";
export const RenderContext = createContext<DockProps["render"]>(() => null);
export const PopoutContext = createContext<(panel: IDockviewPanel) => void>(
  () => undefined,
);
export const LanguageContext = createContext(true);
export const OpenContext = createContext<DockHandle["open"]>(() => undefined);
function Page(props: IDockviewPanelProps<PanelTarget>) {
  const zh = useContext(LanguageContext);
  const render = useContext(RenderContext),
    open = useContext(OpenContext),
    kind = panelKind(props.api.id);
  const params = normalizePanelTarget(props.params);
  return (
    <div className="dock-page">
      {kind && isMultiPage(kind) && (
        <div className="target-controls">
          <button
            title="锁定后不跟随文件选择 / Lock target"
            aria-pressed={params.locked}
            onClick={() =>
              props.api.updateParameters({ ...params, locked: !params.locked })
            }
          >
            {params.locked ? <Lock size={14} /> : <Unlock size={14} />}
            {params.locked
              ? zh
                ? "目标已锁定"
                : "Target locked"
              : zh
                ? "跟随文件选择"
                : "Follow selection"}
          </button>
          <span title={params.target}>
            {params.target || (zh ? "尚未选择文件" : "No file selected")}
          </span>
          <button
            title="新建同类页签 / New instance"
            onClick={() => open(kind, params.target, true)}
          >
            <CopyPlus size={14} />
            {zh ? "新页签" : "New tab"}
          </button>
        </div>
      )}
      {kind
        ? render(kind, params, (target) => {
            if (!params.locked)
              props.api.updateParameters({ ...params, target });
          })
        : null}
    </div>
  );
}
export const components = { page: Page };
export const dockTheme = {
  ...themeLight,
  name: "p4deck",
  className: "dockview-theme-light dockview-theme-p4deck",
};
export function Actions({ activePanel, group }: IDockviewHeaderActionsProps) {
  const popout = useContext(PopoutContext);
  return (
    <div
      className="dock-actions"
      tabIndex={0}
      aria-label="页签组操作 / Tab group actions"
    >
      <button
        title="左右分屏 / Split right"
        aria-label="左右分屏"
        disabled={!activePanel || group.panels.length < 2}
        onClick={() => activePanel?.api.moveTo({ group, position: "right" })}
      >
        <Columns2 size={14} />
      </button>
      <button
        title="上下分屏 / Split below"
        aria-label="上下分屏"
        disabled={!activePanel || group.panels.length < 2}
        onClick={() => activePanel?.api.moveTo({ group, position: "bottom" })}
      >
        <Rows2 size={14} />
      </button>
      <button
        title="弹出独立窗口 / Pop out"
        aria-label="弹出独立窗口"
        disabled={!activePanel || !!detachedPage}
        onClick={() => activePanel && popout(activePanel)}
      >
        <ExternalLink size={14} />
      </button>
    </div>
  );
}
export function Empty() {
  return (
    <div className="closed-pages" tabIndex={0}>
      <h2>没有打开的页签</h2>
      <p>点击左侧活动栏图标打开页面。拖动页签到边缘可分屏。</p>
    </div>
  );
}
