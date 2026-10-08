import { lazy, Suspense } from "react";
import { FileWorkbench } from "../features/files/components/FileWorkbench";
import type {
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
const SettingsPage = lazy(() =>
  import("../features/settings/SettingsPage").then((m) => ({
    default: m.SettingsPage,
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
  onOperation(warnings: string[]): Promise<void>;
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
  onOperation,
}: Props) {
  const { t, zh, ui, theme, setTheme, locale, setLocale, setUi } = preferences;
  switch (page) {
    case "search":
      return (
        <SearchPage
          zh={zh}
          client={runtime.context.client}
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
        />
      );
    case "submitted":
      return (
        <SubmittedPage
          key={connectionKey}
          runtime={runtime}
          t={t}
          onOperation={onOperation}
        />
      );
    case "workspaces":
      return <WorkspacePage t={t} runtime={runtime} />;
    case "diff":
    case "revgraph":
      return (
        <FileReviewPage
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
          kind={page}
          runtime={runtime}
          target={target.target}
          locked={target.locked}
          onTargetChange={changeTarget}
          zh={zh}
        />
      );
    case "preview":
      return (
        <FilePreviewPage
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
          theme={theme}
          onTheme={setTheme}
          locale={locale}
          onLocale={setLocale}
          ui={ui}
          onUi={setUi}
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
