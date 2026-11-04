import { t, tFor } from "../../shared/i18n";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
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
  Info,
  X,
} from "lucide-react";
import {
  normalizePanelTarget,
  panelKind,
  isMultiPage,
  pageLabels,
  type PanelTarget,
} from "../panels";
import { pageIcons } from "../pageIcons";
import { detachedPage, type DockHandle, type DockProps } from "./types";
import { DiffPathInput } from "./DiffPathInput";
export const RenderContext = createContext<DockProps["render"]>(() => null);
export const PopoutContext = createContext<(panel: IDockviewPanel) => void>(
  () => undefined,
);
export const CloseAllContext = createContext({ run: () => {}, enabled: false });
export const LanguageContext = createContext(true);
export const OpenContext = createContext<DockHandle["open"]>(() => undefined);
export const PageHeaderActionsContext = createContext<HTMLElement | null>(null);
/** Slot in the file-page target bar where pages can render a refresh action. */
export const PageActiveContext = createContext(true);
export const PageRefreshSlotContext = createContext<HTMLElement | null>(null);
/** Reuse the fixed page title bar without moving page-specific state or handlers. */
export function FixedPageHeader({
  description,
  children,
}: {
  description?: string;
  children?: ReactNode;
}) {
  const target = useContext(PageHeaderActionsContext);
  const content = (
    <>
      {description && (
        <details className="fixed-page-help">
          <summary aria-label={description} title={description}>
            <Info size={15} aria-hidden="true" />
          </summary>
          <p>{description}</p>
        </details>
      )}
      {children}
    </>
  );
  return target ? (
    createPortal(content, target)
  ) : (
    <div className="target-controls fixed-page-fallback">{content}</div>
  );
}
function Page(props: IDockviewPanelProps<PanelTarget>) {
  const [visited, setVisited] = useState(false);
  const [active, setActive] = useState(!!props.api.isActive);
  useEffect(() => {
    const subscription = props.api.onDidActiveChange?.(() =>
      setActive(!!props.api.isActive),
    );
    return () => subscription?.dispose();
  }, [props.api]);
  const [headerActions, setHeaderActions] = useState<HTMLElement | null>(null);
  const [refreshSlot, setRefreshSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let frame = 0;
    const reveal = () => {
      cancelAnimationFrame(frame);
      // Layout restoration briefly activates intermediate panels. Wait until
      // Dockview has selected the actual visible panel before mounting content.
      frame = requestAnimationFrame(() => {
        if (props.api.isVisible) setVisited(true);
      });
    };
    reveal();
    const subscription = props.api.onDidVisibilityChange(reveal);
    return () => {
      cancelAnimationFrame(frame);
      subscription.dispose();
    };
  }, [props.api]);
  const zh = useContext(LanguageContext);
  const render = useContext(RenderContext),
    open = useContext(OpenContext),
    kind = panelKind(props.api.id);
  const params = normalizePanelTarget(props.params);
  const PageIcon = kind ? pageIcons[kind] : undefined;
  const lockLabel = params.locked
    ? zh
      ? "目标已锁定；点击恢复跟随文件选择"
      : "Target locked; click to follow file selection"
    : zh
      ? "正在跟随文件选择；点击锁定当前目标"
      : "Following file selection; click to lock current target";
  const newTabLabel = tFor(zh ? "zh-CN" : "en-US", "docking.new.tab");
  // Global pages with a compact title bar; their actions portal into it.
  const titled = !!kind && !isMultiPage(kind);
  return (
    <div className={`dock-page${titled ? " fixed-page" : ""}`}>
      {kind && (isMultiPage(kind) || titled) && (
        <div
          ref={titled ? setHeaderActions : undefined}
          className={`target-controls${titled ? " page-title-controls" : ""}`}
        >
          <div className="target-page-title">
            {PageIcon && <PageIcon size={18} aria-hidden="true" />}
            {titled ? (
              <h1>{pageLabels(zh)[kind]}</h1>
            ) : (
              <span>{pageLabels(zh)[kind]}</span>
            )}
          </div>
          {isMultiPage(kind) && (
            <>
              <button
                type="button"
                className="target-icon-button"
                title={lockLabel}
                aria-label={lockLabel}
                aria-pressed={params.locked}
                onClick={() =>
                  props.api.updateParameters({
                    ...params,
                    locked: !params.locked,
                  })
                }
              >
                {params.locked ? (
                  <Lock size={14} aria-hidden="true" />
                ) : (
                  <Unlock size={14} aria-hidden="true" />
                )}
              </button>
              {kind !== "shelf" ? (
                <DiffPathInput
                  key={params.target}
                  label={
                    kind === "diff"
                      ? zh
                        ? "差异文件路径"
                        : "Diff file path"
                      : kind === "revgraph"
                        ? zh
                          ? "修订图文件路径"
                          : "Revision graph file path"
                        : kind === "history"
                          ? zh
                            ? "Depot 路径"
                            : "Depot path"
                          : zh
                            ? "预览文件路径"
                            : "Preview file path"
                  }
                  raw={kind === "history" || kind === "preview"}
                  target={params.target}
                  locked={params.locked}
                  zh={zh}
                  onChange={(target) =>
                    props.api.updateParameters({ ...params, target })
                  }
                >
                  <span ref={setRefreshSlot} className="target-refresh-slot" />
                </DiffPathInput>
              ) : (
                <span className="target-control-value" title={params.target}>
                  <span className="target-control-text">
                    {params.target ||
                      (tFor(zh ? "zh-CN" : "en-US", "docking.no.file.selected"))}
                  </span>
                  <span ref={setRefreshSlot} className="target-refresh-slot" />
                </span>
              )}
              <button
                type="button"
                className="target-icon-button"
                title={newTabLabel}
                aria-label={newTabLabel}
                onClick={() =>
                  params.comparison
                    ? open(kind, params.target, true, params.comparison)
                    : open(kind, params.target, true)
                }
              >
                <CopyPlus size={14} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      )}
      <PageActiveContext.Provider value={active}>
        <PageHeaderActionsContext.Provider value={headerActions}>
          <PageRefreshSlotContext.Provider value={refreshSlot}>
            {kind && visited
              ? render(kind, params, (target) => {
                  if (!params.locked)
                    props.api.updateParameters({ ...params, target });
                })
              : null}
          </PageRefreshSlotContext.Provider>
        </PageHeaderActionsContext.Provider>
      </PageActiveContext.Provider>
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
  const closeAll = useContext(CloseAllContext);
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
      <button
        type="button"
        title={t("docking.close.all.tabs")}
        aria-label={t("docking.close.all.tabs")}
        disabled={!closeAll.enabled}
        onClick={closeAll.run}
      >
        <X size={16} aria-hidden="true" />
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
