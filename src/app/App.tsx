import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SelectionContext } from "../features/files/SelectionContext";
import { ResourceExplorer } from "../features/files/components/ResourceExplorer";
import { resolveAddress } from "../features/files/resolveAddress";
import { ToolArea, type ToolHandle } from "../features/tools/ToolArea";
import type {
  GlobalSearchTarget,
  WorkspaceNode,
} from "../shared/contracts/types";
import { storage } from "../shared/lib/storage";
import { DockWorkspace, detachedPage } from "./DockWorkspace";
import { PageRenderer } from "./PageRenderer";
import {
  pageForSearchTarget,
  pageLabels,
  targetForPage,
  type FilePageId,
} from "./panels";
import { usePreferences } from "./hooks/usePreferences";
import { useRuntime } from "./hooks/useRuntime";
import { usePageNavigation } from "./hooks/usePageNavigation";
import { TopBar } from "./shell/TopBar";
import { AppControls } from "./shell/AppControls";
import { CommandBar } from "./shell/CommandBar";
import { ContextMenuProvider } from "./context-menu/ContextMenu";
import { MenuEnvironment } from "./context-menu/environment";
import type { CommandTarget, CommandId } from "./shell/commandPolicy";
import {
  CommandContext,
  CommandExecutionContext,
} from "./shell/CommandContext";
import { useWorkspaceSelection } from "./hooks/useWorkspaceSelection";
import { StatusBar } from "./shell/StatusBar";
import { ActivityBar } from "./shell/ActivityBar";

export function App() {
  const preferences = usePreferences();
  const { t, zh, ui } = preferences;
  const { runtime, applyConnection, connectionKey, error } = useRuntime();
  const navigation = usePageNavigation();
  const { dockRef, route, pages, setPages, onActive, openPage } = navigation;
  const commandExecutor = useRef<
    | ((id: CommandId, target?: CommandTarget, source?: HTMLElement) => void)
    | undefined
  >(undefined);
  const registerCommand = useCallback(
    (
      handler:
        | ((
            id: CommandId,
            target?: CommandTarget,
            source?: HTMLElement,
          ) => void)
        | undefined,
    ) => {
      commandExecutor.current = handler;
    },
    [],
  );
  const executeCommand = useCallback(
    (id: CommandId, target?: CommandTarget, source?: HTMLElement) =>
      commandExecutor.current?.(id, target, source),
    [],
  );
  const [commandBusy, setCommandBusy] = useState(false);
  const [searchDirectory, setSearchDirectory] = useState<string>();
  const toolsRef = useRef<ToolHandle>(null);
  const [toolOpen, setToolOpen] = useState(
    () => storage.getItem("p4deck.toolOpen") === "true",
  );
  const [leftOpen, setLeftOpen] = useState(
    () => storage.getItem("p4deck.leftOpen") !== "false",
  );
  const [treeMode, setTreeMode] = useState<"workspace" | "depot">("workspace");
  const openFiles = useCallback(() => openPage("files"), [openPage]);
  const {
    selectedFile,
    directory,
    command,
    navigate: navigateFile,
    context: selectionContext,
  } = useWorkspaceSelection(connectionKey, runtime.context.cwd, openFiles);
  const [searchNavigation, setSearchNavigation] = useState<{
    target: GlobalSearchTarget;
    nonce: number;
  }>();
  const searchNavigationNonce = useRef(0);
  const navigateSearchTarget = useCallback(
    async (target: GlobalSearchTarget) => {
      const page = pageForSearchTarget(target);
      if (target.type === "job" || !page)
        throw new Error(
          zh ? "尚无 Job 详情页。" : "No Job details page exists yet.",
        );
      if (
        target.type === "submittedChange" ||
        target.type === "pendingChange"
      ) {
        searchNavigationNonce.current += 1;
        setSearchNavigation({ target, nonce: searchNavigationNonce.current });
        dockRef.current?.open(page);
        return;
      }
      const path =
        target.type === "workspaceFile"
          ? target.absolutePath
          : target.depotPath;
      const node = await resolveAddress(
        path,
        connectionKey,
        runtime.context.cwd,
      );
      navigateFile(node);
    },
    [connectionKey, dockRef, navigateFile, runtime.context.cwd, zh],
  );
  useEffect(() => setSearchNavigation(undefined), [connectionKey]);
  const labels = useMemo(() => pageLabels(zh), [zh]);
  useEffect(() => {
    storage.setItem("p4deck.leftOpen", String(leftOpen));
  }, [leftOpen]);
  const openReview = useCallback(
    (kind: FilePageId, node: WorkspaceNode) => {
      dockRef.current?.open(
        kind,
        targetForPage(kind, node.depotPath, node.absolutePath),
      );
    },
    [dockRef],
  );
  const afterOperation = useCallback(async (warnings: string[]) => {
    await toolsRef.current?.afterOperation(warnings);
  }, []);
  const hasSidebar = leftOpen && !detachedPage;
  return (
    <ContextMenuProvider
      scope={connectionKey + ":" + route + ":" + commandBusy}
      zh={zh}
    >
      <MenuEnvironment.Provider
        value={{
          runtime,
          connectionKey,
          commandBusy,
          openPage,
          searchDirectory,
          searchInDirectory: (path) => {
            setSearchDirectory(path);
            openPage("search");
          },
          navigate: navigateFile,
          openFilePage: (page, node, fresh) =>
            dockRef.current?.open(
              page,
              targetForPage(page, node.depotPath, node.absolutePath),
              fresh,
            ),
          preferences,
        }}
      >
        <SelectionContext.Provider value={selectionContext}>
          <CommandExecutionContext.Provider value={executeCommand}>
            <CommandContext.Provider value={command.focus}>
              <div
                className={`app-shell ${toolOpen ? "with-tools" : ""} ${detachedPage ? "detached-shell" : ""}`}
              >
                <TopBar
                  runtime={runtime}
                  onSettings={() => openPage("settings")}
                />
                <CommandBar
                  zh={zh}
                  runtime={runtime}
                  connectionKey={connectionKey}
                  registerCommand={registerCommand}
                  onBusyChange={setCommandBusy}
                  target={command.target}
                  targetError={command.targetError}
                  onFocus={command.focus}
                  onNavigate={navigateFile}
                  onReview={openReview}
                />
                {error && (
                  <div className="runtime-error" role="alert">
                    {error}
                  </div>
                )}
                <div
                  className={`workbench ${hasSidebar ? "" : "left-collapsed"}`}
                  style={
                    hasSidebar
                      ? {
                          gridTemplateColumns: `var(--activity-bar-width, 48px) ${ui.sidebarWidth}px minmax(0,1fr)`,
                        }
                      : undefined
                  }
                >
                  <ActivityBar
                    active={route}
                    zh={zh}
                    labels={labels}
                    pages={pages}
                    onOpenPage={(page) => dockRef.current?.open(page)}
                    onCloseAll={() => dockRef.current?.closeAll()}
                  />
                  <ResourceExplorer
                    collapsed={!leftOpen}
                    onToggle={() => setLeftOpen(!leftOpen)}
                    zh={zh}
                    key={connectionKey}
                    clientName={runtime.context.client}
                    connectionKey={connectionKey}
                    ready={runtime.p4Version !== "loading"}
                    mode={treeMode}
                    onModeChange={setTreeMode}
                    t={t}
                    directory={directory}
                    onNavigate={navigateFile}
                  />
                  <section className="main-stage">
                    <div className="route-view">
                      <DockWorkspace
                        ref={dockRef}
                        pages={pages}
                        active={route}
                        zh={zh}
                        selectedLocalPath={
                          selectedFile?.kind === "file"
                            ? selectedFile.absolutePath
                            : undefined
                        }
                        selectedPath={
                          selectedFile?.kind === "file"
                            ? (selectedFile.depotPath ??
                              selectedFile.absolutePath)
                            : undefined
                        }
                        labels={labels}
                        onPages={setPages}
                        onActive={onActive}
                        onTarget={command.onTarget}
                        render={(page, target, changeTarget) => (
                          <PageRenderer
                            page={page}
                            target={target}
                            changeTarget={changeTarget}
                            preferences={preferences}
                            runtime={runtime}
                            connectionKey={connectionKey}
                            selectedFile={selectedFile}
                            directory={directory}
                            onNavigate={navigateFile}
                            onReview={openReview}
                            onConnection={applyConnection}
                            onOperation={afterOperation}
                            searchNavigation={searchNavigation}
                            onSearchNavigate={navigateSearchTarget}
                          />
                        )}
                      />
                    </div>
                  </section>
                </div>
                <ToolArea
                  ref={toolsRef}
                  t={t}
                  context={runtime.context}
                  onOpenChange={setToolOpen}
                />
                <StatusBar
                  onOpenLogs={(id) => toolsRef.current?.open("logs", id)}
                  connectionKey={connectionKey}
                  native={runtime.mode === "tauri"}
                  zh={zh}
                >
                  <AppControls preferences={preferences} />
                </StatusBar>
              </div>
            </CommandContext.Provider>
          </CommandExecutionContext.Provider>
        </SelectionContext.Provider>
      </MenuEnvironment.Provider>
    </ContextMenuProvider>
  );
}
