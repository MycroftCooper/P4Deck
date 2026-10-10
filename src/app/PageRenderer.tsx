import { lazy, Suspense } from "react";
import { FileWorkbench } from "../features/files/components/FileWorkbench";
import { canScanWorkspace } from "../features/files/workspaceQueries";
import type {
  GlobalSearchTarget,
  RuntimeInfo,
  WorkspaceNode,
  P4Context,
} from "../shared/contracts/types";
import type { Preferences } from "./hooks/usePreferences";
import type { FilePageId, PageId, PanelTarget } from "./panels";
import { PanelErrorBoundary } from "./docking/PanelErrorBoundary";
const SearchPage = lazy(() =>
  import("../features/search/SearchPage").then((m) => ({
    default: m.SearchPage,
  })),
);
const PendingPage = lazy(() =>
  import("../features/changelists/components/PendingPage").then((m) => ({
    default: m.PendingPage,
  })),
);
const SubmittedPage = lazy(() =>
  import("../features/changelists/components/SubmittedPage").then((m) => ({
    default: m.SubmittedPage,
  })),
);
const ShelfDetailPage = lazy(() =>
  import("../features/changelists/components/ShelfDetailPage").then((m) => ({
    default: m.ShelfDetailPage,
  })),
);
const WorkspacePage = lazy(() =>
  import("../features/workspaces/WorkspacePage").then((m) => ({
    default: m.WorkspacePage,
  })),
);
const FileReviewPage = lazy(() =>
  import("../features/browsers/FileReviewPage").then((m) => ({
    default: m.FileReviewPage,
  })),
);
const FilePreviewPage = lazy(() =>
  import("../features/browsers/FilePreviewPage").then((m) => ({
    default: m.FilePreviewPage,
  })),
);
const ReadOnlyPage = lazy(() =>
  import("../features/browsers/ReadOnlyPages").then((m) => ({
    default: m.ReadOnlyPage,
  })),
);
const StreamGraphPage = lazy(() =>
  import("../features/browsers/StreamGraphPage").then((m) => ({
    default: m.StreamGraphPage,
  })),
);
const BranchMappingsPage = lazy(() =>
  import("../features/browsers/BranchMappingsPage").then((m) => ({
    default: m.BranchMappingsPage,
  })),
);
const SettingsPage = lazy(() =>
  import("../features/settings/SettingsPage").then((m) => ({
    default: m.SettingsPage,
  })),
);
const ToolPanel = lazy(() =>
  import("../features/tools/ToolPanel").then((m) => ({
    default: m.ToolPanel,
  })),
);
export interface PageEnvironment {
  preferences: Preferences;
  runtime: RuntimeInfo;
  connectionKey: string;
  selectedFile?: WorkspaceNode;
  directory?: string;
  onNavigate(node: WorkspaceNode): void;
  onReview(kind: FilePageId, node: WorkspaceNode): void;
  onConnection(context: P4Context): void;
  onRuntime(runtime: RuntimeInfo): void;
  onOpenPage(page: PageId): void;
  streamNavigation?: { stream: string; nonce: number };
  onLocateStream(stream: string): void;
  onOperation(warnings: string[]): Promise<void>;
  searchNavigation?: {
    target: GlobalSearchTarget;
    nonce: number;
  };
  onSearchNavigate(target: GlobalSearchTarget): Promise<void>;
}
interface Props extends PageEnvironment {
  page: PageId;
  target: PanelTarget;
  changeTarget(path: string): void;
}
function Content({
  page,
  target,
  changeTarget,
  preferences,
  runtime,
  connectionKey,
  selectedFile,
  directory,
  onNavigate,
  onReview,
  onConnection,
  onRuntime,
  onOpenPage,
  streamNavigation,
  onLocateStream,
  onOperation,
  searchNavigation,
  onSearchNavigate,
}: Props) {
  const { t, zh, ui, theme, setTheme, locale, setLocale, setUi } = preferences;
  switch (page) {
    case "search":
      return (
        <SearchPage
          zh={zh}
          runtimeMode={runtime.mode}
          onNavigate={onSearchNavigate}
          key={connectionKey}
        />
      );
    case "files":
      return (
        <FileWorkbench
          key={connectionKey}
          density={ui.compact}
          onOpenReview={onReview}
          t={t}
          selected={selectedFile}
          directory={directory}
          onNavigate={onNavigate}
          connectionKey={connectionKey}
          ready={runtime.p4Version !== "loading"}
          workspaceReady={canScanWorkspace(runtime)}
        />
      );
    case "pending":
      return (
        <PendingPage
          key={connectionKey}
          t={t}
          clientName={runtime.context.client}
          connectionKey={connectionKey}
          demo={runtime.mode === "mock"}
          ready={runtime.p4Version !== "loading"}
          navigation={
            searchNavigation?.target.type === "pendingChange"
              ? {
                  changeId: searchNavigation.target.changeId,
                  nonce: searchNavigation.nonce,
                }
              : undefined
          }
        />
      );
    case "submitted":
      return (
        <SubmittedPage
          key={connectionKey}
          runtime={runtime}
          t={t}
          onOperation={onOperation}
          navigation={
            searchNavigation?.target.type === "submittedChange"
              ? {
                  changeId: searchNavigation.target.changeId,
                  nonce: searchNavigation.nonce,
                }
              : undefined
          }
        />
      );
    case "shelf":
      return (
        <ShelfDetailPage
          key={`${connectionKey}:${target.target}`}
          target={target.target}
          runtime={runtime}
          zh={zh}
        />
      );
    case "workspaces":
      return <WorkspacePage t={t} runtime={runtime} onRuntime={onRuntime} />;
    case "diff":
    case "revgraph":
      return (
        <FileReviewPage
          key={connectionKey}
          kind={page}
          target={target.target}
          locked={target.locked}
          onTargetChange={changeTarget}
          runtime={runtime}
          zh={zh}
        />
      );
    case "history":
    case "streams":
      return (
        <ReadOnlyPage
          key={connectionKey}
          kind={page}
          runtime={runtime}
          target={target.target}
          locked={target.locked}
          onTargetChange={changeTarget}
          onRuntime={onRuntime}
          onOpenStreamGraph={() => onOpenPage("streamgraph")}
          onOpenBranchMappings={() => onOpenPage("branchmappings")}
          navigation={page === "streams" ? streamNavigation : undefined}
          zh={zh}
        />
      );
    case "streamgraph":
      return (
        <StreamGraphPage
          key={connectionKey}
          runtime={runtime}
          onRuntime={onRuntime}
          onLocateStream={onLocateStream}
          zh={zh}
        />
      );
    case "branchmappings":
      return (
        <BranchMappingsPage key={connectionKey} runtime={runtime} zh={zh} />
      );
    case "preview":
      return (
        <FilePreviewPage
          key={connectionKey}
          target={target.target}
          locked={target.locked}
          onTargetChange={changeTarget}
          runtime={runtime}
          zh={zh}
        />
      );
    case "settings":
      return (
        <SettingsPage
          runtime={runtime}
          onConnection={onConnection}
          onRuntime={onRuntime}
          theme={theme}
          onTheme={setTheme}
          locale={locale}
          onLocale={setLocale}
          ui={ui}
          onUi={setUi}
        />
      );
    case "terminal":
    case "p4log":
      return (
        <ToolPanel
          key={connectionKey}
          kind={page}
          t={t}
          zh={zh}
          native={runtime.mode === "tauri"}
          connectionKey={connectionKey}
          context={runtime.context}
          onOpenSettings={() =>
            window.dispatchEvent(new Event("p4deck:open-settings"))
          }
        />
      );
    default: {
      const unreachable: never = page;
      throw new Error(`Unregistered page renderer: ${unreachable}`);
    }
  }
}
export function PageRenderer(props: Props) {
  return (
    <PanelErrorBoundary
      resetKey={JSON.stringify([
        props.page,
        props.connectionKey,
        props.target.target,
      ])}
      zh={props.preferences.zh}
    >
      <Suspense
        fallback={
          <div className="workspace-empty" role="status">
            {props.preferences.zh ? "正在打开页面…" : "Opening page…"}
          </div>
        }
      >
        <Content {...props} />
      </Suspense>
    </PanelErrorBoundary>
  );
}
