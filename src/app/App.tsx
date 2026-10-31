import { useCustomExitRefresh } from "../features/companySubmit/useCustomExitRefresh";
import { recordFrontendOperationLog } from "../infrastructure/backend/frontendOperationLog";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { SelectionContext } from "../features/files/SelectionContext";
import { ResourceExplorer } from "../features/files/components/ResourceExplorer";
import { resolveAddress } from "../features/files/resolveAddress";
import { ToolArea, type ToolHandle } from "../features/tools/ToolArea";
import type { GlobalSearchTarget, WorkspaceNode } from "../shared/contracts";
import { storage } from "../shared/lib/storage";
import { detachedPage } from "./docking/types";
const DockWorkspace = lazy(() =>
  import("./DockWorkspace").then((m) => ({ default: m.DockWorkspace })),
);
const PageRenderer = lazy(() =>
  import("./PageRenderer").then((m) => ({ default: m.PageRenderer })),
);
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
import {
  commandReason,
  type CommandTarget,
  type CommandId,
} from "./shell/commandPolicy";
import {
  CommandContext,
  CommandExecutionContext,
} from "./shell/CommandContext";
import { useWorkspaceSelection } from "./hooks/useWorkspaceSelection";
import { StatusBar } from "./shell/StatusBar";
import { ActivityBar } from "./shell/ActivityBar";
import { SidebarResizeHandle } from "./shell/SidebarResizeHandle";
import { isTauri } from "@tauri-apps/api/core";
import {
  buildSwarmLink,
  openSwarmLink,
  type SwarmLinkTarget,
} from "../features/swarm/swarmLinks";
import { NoticeHost } from "./shell/NoticeHost";
import { CommandPalette } from "./commands/CommandPalette";
import {
  appCommandReason,
  appCommands,
  commandForShortcut,
  type AppCommandId,
} from "./commands/catalog";
import {
  detachedBindingMatches,
  opaqueConnectionBinding,
  readDetachedBinding,
} from "./docking/detachedBinding";
import { useAutoRefresh } from "./refresh/autoRefresh";
import { useDesktopNotifications } from "./notifications/notifications";
import { canScanWorkspace } from "../features/files/workspaceQueries";
import { toggleAutoRefresh } from "../features/settings/preferences";
import {
  usePendingCacheSync,
  PendingExitRefreshPartial,
} from "../features/changelists/pendingCache";
import { ConnectionSetupGate } from "../features/settings/ConnectionSetupGate";
import { requestGuardedClose, useCloseGuardReady } from "./closeGuard";
import { UpdatePanel } from "./update/UpdatePanel";
import { startUpdateWatcher } from "./update/updateService";

import {
  ChangeDetailsContext,
  useChangeDetailsDialog,
} from "../features/changelists/components/ChangeDetailsDialog";

export function App() {
  useCloseGuardReady();
  // Startup check plus the six-hour timer; a no-op outside the main Tauri window.
  useEffect(() => startUpdateWatcher(), []);
  const preferences = usePreferences();
  const state = useRuntime();
  return (
    <ConnectionSetupGate state={state} preferences={preferences}>
      <ConnectedApp preferences={preferences} state={state} />
    </ConnectionSetupGate>
  );
}

function ConnectedApp({
  preferences,
  state,
}: {
  preferences: ReturnType<typeof usePreferences>;
  state: ReturnType<typeof useRuntime>;
}) {
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (!performance.getEntriesByName("p4deck:shell-visible").length)
        performance.mark("p4deck:shell-visible");
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const { t, zh, ui } = preferences;
  const {
    runtime,
    applyRuntime,
    applyConnection,
    connectionKey,
    error,
    checkingConnection,
  } = state;
  const operationContext = useRef({ runtime, connectionKey });
  operationContext.current = { runtime, connectionKey };
  const changeDetails = useChangeDetailsDialog(runtime, connectionKey, zh);
  // Hydrate locally and keep mutations coherent even while Pending is closed.
  usePendingCacheSync(runtime, connectionKey);
  useCustomExitRefresh(runtime, connectionKey, (event, cause) => {
    const operationId = event?.requestId ?? crypto.randomUUID();
    void recordFrontendOperationLog({
      eventId: `${operationId}-exit-refresh`,
      operationId,
      action: "customSubmit",
      phase: "refresh",
      outcome:
        cause instanceof PendingExitRefreshPartial ? "partial" : "failed",
      code: "refreshFailed",
      targetCount: 0,
      ...(event ? { changeId: event.changeId } : {}),
    });
  });
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchDirectory, setSearchDirectory] = useState<string>();
  const toolsRef = useRef<ToolHandle>(null);
  const [toolOpen, setToolOpen] = useState(
    () => storage.getItem("p4deck.toolOpen") === "true",
  );
  const [leftOpen, setLeftOpen] = useState(
    () => storage.getItem("p4deck.leftOpen") !== "false",
  );
  const [sidebarPreview, setSidebarPreview] = useState<number>();
  const [treeMode, setTreeMode] = useState<"workspace" | "depot">("workspace");
  const openFiles = useCallback(() => openPage("files"), [openPage]);
  const {
    selectedFile,
    directory,
    command,
    navigate: navigateFile,
    reveal,
    consumeReveal,
    context: selectionContext,
  } = useWorkspaceSelection(connectionKey, runtime.context.cwd, openFiles);
  useEffect(() => {
    if (reveal?.connectionKey !== connectionKey) return;
    setLeftOpen(true);
    setTreeMode("workspace");
  }, [reveal, connectionKey]);
  const [searchNavigation, setSearchNavigation] = useState<{
    target: GlobalSearchTarget;
    nonce: number;
  }>();
  const [streamNavigation, setStreamNavigation] = useState<{
    stream: string;
    nonce: number;
  }>();
  const streamNavigationNonce = useRef(0);
  const locateStream = useCallback(
    (stream: string) => {
      streamNavigationNonce.current += 1;
      setStreamNavigation({ stream, nonce: streamNavigationNonce.current });
      dockRef.current?.open("streams");
    },
    [dockRef],
  );
  const navigateSearchTarget = useCallback(
    async (target: GlobalSearchTarget) => {
      const page = pageForSearchTarget(target);
      if (target.type === "job" || !page)
        throw new Error(
          zh
            ? "该搜索结果的详情页尚未接入。"
            : "This search result has no details page yet.",
        );
      if (target.type === "stream") {
        locateStream(target.streamPath);
        return;
      }
      if (target.type === "shelf") {
        dockRef.current?.open("shelf", String(target.changeId));
        return;
      }
      if (
        target.type === "submittedChange" ||
        target.type === "pendingChange"
      ) {
        changeDetails.open({
          kind: target.type === "submittedChange" ? "submitted" : "pending",
          changeId: target.changeId,
        });
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
    [
      connectionKey,
      changeDetails.open,
      dockRef,
      locateStream,
      navigateFile,
      runtime.context.cwd,
      zh,
    ],
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
  const autoRefreshPaused = !ui.autoRefresh || ui.autoRefreshMinutes === 0;
  const autoRefresh = useAutoRefresh(
    runtime,
    connectionKey,
    autoRefreshPaused ||
      !runtime.context.server.trim() ||
      !runtime.context.user.trim(),
    !!detachedPage,
    route,
    ui.autoRefreshMinutes,
  );
  useDesktopNotifications(
    runtime,
    {
      enabled: ui.desktopNotifications,
      failuresOnly: ui.notifyOnlyFailures,
    },
    zh,
  );
  const commandEnvironment = useMemo(() => {
    const swarmTarget: SwarmLinkTarget | undefined =
      command.target.type === "submitted"
        ? { kind: "submittedChange", changeId: command.target.id }
        : command.target.type === "pending"
          ? { kind: "pendingChange", changeId: command.target.id }
          : command.target.type === "file" && command.target.node.depotPath
            ? { kind: "file", depotPath: command.target.node.depotPath }
            : undefined;
    const swarm = swarmTarget
      ? buildSwarmLink(runtime.context.swarmBaseUrl, swarmTarget)
      : undefined;
    return {
      detached: !!detachedPage,
      runtimeReady: runtime.p4Version !== "loading",
      connected: runtime.connection.state === "connected",
      busy: commandBusy,
      target: command.target.type,
      pendingCount:
        command.target.type === "pending" ? command.target.count : undefined,
      pendingId:
        command.target.type === "pending" ? command.target.id : undefined,
      shellReasons: Object.fromEntries(
        appCommands.flatMap((item) =>
          item.execution?.kind === "shell"
            ? [
                [
                  item.execution.command,
                  commandReason(
                    item.execution.command,
                    command.target,
                    commandBusy,

                    isTauri(),
                    zh,
                  ),
                ],
              ]
            : [],
        ),
      ),
      swarmReason: !swarmTarget
        ? zh
          ? "请先选择 CL 或 Depot 文件"
          : "Select a changelist or depot file first"
        : swarm && swarm.enabled
          ? undefined
          : swarm?.reason,
    };
  }, [
    command.target,
    commandBusy,
    runtime.connection.state,
    runtime.p4Version,
    runtime.context.swarmBaseUrl,
    zh,
  ]);
  const runtimeBinding = useMemo(
    () => ({
      profileId: runtime.activeProfileId,
      contextGeneration: runtime.contextGeneration,
      connectionKey: opaqueConnectionBinding(connectionKey),
    }),
    [connectionKey, runtime.activeProfileId, runtime.contextGeneration],
  );
  const detachedRebound =
    !!detachedPage &&
    runtime.p4Version !== "loading" &&
    !detachedBindingMatches(
      readDetachedBinding(location.search),
      runtimeBinding,
    );
  const executeAppCommand = useCallback(
    (id: AppCommandId) => {
      if (appCommandReason(id, commandEnvironment, zh)) return;
      const execution = appCommands.find((item) => item.id === id)?.execution;
      if (execution?.kind === "shell") {
        executeCommand(execution.command);
        return;
      }
      if (execution?.kind === "page") {
        openPage(execution.page);
        return;
      }
      if (execution?.kind === "tool") {
        toolsRef.current?.open(execution.tool);
        return;
      }
      switch (id) {
        case "app.commandPalette":
          setPaletteOpen(true);
          break;
        case "navigation.focusAddress":
          window.dispatchEvent(new Event("p4deck:focus-address"));
          break;
        case "view.refresh":
          void autoRefresh.refreshNow();
          break;
        case "swarm.open": {
          const target: SwarmLinkTarget | undefined =
            command.target.type === "submitted"
              ? { kind: "submittedChange", changeId: command.target.id }
              : command.target.type === "pending"
                ? { kind: "pendingChange", changeId: command.target.id }
                : command.target.type === "file" &&
                    command.target.node.depotPath
                  ? {
                      kind: "file",
                      depotPath: command.target.node.depotPath,
                    }
                  : undefined;
          if (target) void openSwarmLink(runtime, target);
          break;
        }
        case "tools.openTerminal":
          dockRef.current?.open("terminal");
          break;
        case "tools.openP4Log":
          dockRef.current?.open("p4log");
          break;
        case "tools.popoutTerminal":
          void dockRef.current?.popoutPage("terminal");
          break;
        case "tools.popoutP4Log":
          void dockRef.current?.popoutPage("p4log");
          break;
        case "refresh.toggleAuto":
          preferences.setUi(toggleAutoRefresh);
          break;
        case "panel.dockBack":
          if (isTauri())
            void requestGuardedClose("window").catch(console.error);
          else window.close();
          break;
      }
    },
    [
      autoRefresh,
      commandEnvironment,
      dockRef,
      executeCommand,
      openPage,
      preferences,
      command.target,
      runtime,
      zh,
    ],
  );
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const id = commandForShortcut(event);
      if (!id) return;
      event.preventDefault();
      executeAppCommand(id);
    };
    window.addEventListener("keydown", onKeyDown);
    const openSettings = () => openPage("settings");
    window.addEventListener("p4deck:open-settings", openSettings);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("p4deck:open-settings", openSettings);
    };
  }, [executeAppCommand, openPage]);
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
          getOperationContext: () => operationContext.current,
          reportOperationError: (event) => {
            void recordFrontendOperationLog(event);
          },
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
        <ChangeDetailsContext.Provider value={changeDetails.open}>
          {changeDetails.dialog}
          <SelectionContext.Provider value={selectionContext}>
            <CommandExecutionContext.Provider value={executeCommand}>
              <CommandContext.Provider value={command.focus}>
                <div
                  className={`app-shell ${toolOpen ? "with-tools" : ""} ${detachedPage ? "detached-shell" : ""}`}
                >
                  <TopBar
                    runtime={runtime}
                    zh={zh}
                    onRuntime={applyRuntime}
                    onSettings={() => openPage("settings")}
                  />
                  {detachedPage && (
                    <button
                      className="detached-dock-back"
                      onClick={() => executeAppCommand("panel.dockBack")}
                    >
                      Dock back / 停靠回主窗口 <kbd>Ctrl+Alt+D</kbd>
                    </button>
                  )}
                  <CommandBar
                    navigationActions={
                      <ActivityBar
                        active={route}
                        zh={zh}
                        labels={labels}
                        pages={pages}
                        onOpenPage={openPage}
                      />
                    }
                    settingsActive={route === "settings"}
                    zh={zh}
                    runtime={runtime}
                    connectionKey={connectionKey}
                    registerCommand={registerCommand}
                    onBusyChange={setCommandBusy}
                    onOpenOperations={(error) => {
                      if (error) {
                        const id = crypto.randomUUID();
                        void recordFrontendOperationLog({
                          eventId: `${id}-execute`,
                          operationId: id,
                          action: "otherOperation",
                          phase: "execute",
                          outcome: "failed",
                          code: "operationFailed",
                          targetCount: 0,
                        });
                      } else toolsRef.current?.open("journal");
                    }}
                    target={command.target}
                    targetError={command.targetError}
                    onFocus={command.focus}
                    onNavigate={navigateFile}
                    onHistoryDiff={(path, left, right) =>
                      dockRef.current?.open("diff", path, true, { left, right })
                    }
                    onReview={openReview}
                  />
                  {error && (
                    <div className="runtime-error" role="alert">
                      {error}
                    </div>
                  )}
                  {detachedRebound && (
                    <div className="runtime-rebound" role="status">
                      {zh
                        ? "连接或运行时代次已变化；此窗口已取消旧请求并重新绑定到当前连接。"
                        : "The connection or runtime generation changed. Stale requests were cancelled and this window rebound to the current connection."}
                    </div>
                  )}
                  <div
                    className={`workbench ${hasSidebar ? "" : "left-collapsed"}`}
                    style={
                      {
                        "--resource-sidebar-width": `${sidebarPreview ?? ui.sidebarWidth}px`,
                      } as React.CSSProperties
                    }
                  >
                    <ResourceExplorer
                      resizeHandle={
                        <SidebarResizeHandle
                          width={sidebarPreview ?? ui.sidebarWidth}
                          collapsed={!leftOpen}
                          zh={zh}
                          onPreview={setSidebarPreview}
                          onCommit={(sidebarWidth) =>
                            preferences.setUi((value) => ({
                              ...value,
                              sidebarWidth,
                            }))
                          }
                          onCollapsedChange={(collapsed) =>
                            setLeftOpen(!collapsed)
                          }
                        />
                      }
                      collapsed={!leftOpen}
                      onToggle={() => setLeftOpen(!leftOpen)}
                      zh={zh}
                      key={connectionKey}
                      clientName={runtime.context.client}
                      connectionKey={connectionKey}
                      ready={
                        runtime.p4Version !== "loading" &&
                        !!runtime.context.server.trim() &&
                        !!runtime.context.user.trim()
                      }
                      workspaceReady={canScanWorkspace(runtime)}
                      checkingConnection={checkingConnection}
                      mode={treeMode}
                      onModeChange={setTreeMode}
                      t={t}
                      onNavigate={navigateFile}
                      reveal={reveal}
                      onRevealConsumed={consumeReveal}
                    />
                    <main className="main-stage">
                      <div className="route-view">
                        <Suspense fallback={null}>
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
                            runtimeBinding={runtimeBinding}
                            onPages={setPages}
                            onActive={onActive}
                            onTarget={command.onTarget}
                            render={(page, target, changeTarget) => (
                              <Suspense fallback={null}>
                                <PageRenderer
                                  page={page}
                                  target={target}
                                  changeTarget={changeTarget}
                                  preferences={preferences}
                                  runtime={runtime}
                                  checkingConnection={checkingConnection}
                                  connectionKey={connectionKey}
                                  selectedFile={selectedFile}
                                  directory={directory}
                                  onNavigate={navigateFile}
                                  onReview={openReview}
                                  onCompareRevisions={(path, comparison) =>
                                    dockRef.current?.open(
                                      "diff",
                                      path,
                                      true,
                                      comparison,
                                    )
                                  }
                                  onConnection={applyConnection}
                                  onRuntime={applyRuntime}
                                  onOpenPage={openPage}
                                  streamNavigation={streamNavigation}
                                  onLocateStream={locateStream}
                                  onOperation={afterOperation}
                                  searchNavigation={searchNavigation}
                                  onSearchNavigate={navigateSearchTarget}
                                />
                              </Suspense>
                            )}
                          />
                        </Suspense>
                      </div>
                    </main>
                  </div>
                  <ToolArea
                    ref={toolsRef}
                    t={t}
                    zh={zh}
                    native={runtime.mode === "tauri"}
                    connectionKey={connectionKey}
                    context={runtime.context}
                    onOpenChange={setToolOpen}
                    onOpenSettings={() => openPage("settings")}
                  />
                  <StatusBar
                    serverScopeHint={{
                      profileId: runtime.activeProfileId ?? null,
                      server: runtime.context.server,
                      user: runtime.context.user,
                      client: runtime.context.client,
                    }}
                    onOpenLogs={(id) => toolsRef.current?.open("logs", id)}
                    connectionKey={connectionKey}
                    native={runtime.mode === "tauri"}
                    zh={zh}
                    autoRefresh={autoRefresh.status}
                    autoRefreshPaused={autoRefreshPaused}
                    onToggleAutoRefresh={() =>
                      preferences.setUi(toggleAutoRefresh)
                    }
                  >
                    <AppControls preferences={preferences} />
                  </StatusBar>
                </div>
                <CommandPalette
                  open={paletteOpen}
                  zh={zh}
                  environment={commandEnvironment}
                  onClose={() => setPaletteOpen(false)}
                  onExecute={executeAppCommand}
                />
                <NoticeHost />
                <UpdatePanel zh={zh} />
              </CommandContext.Provider>
            </CommandExecutionContext.Provider>
          </SelectionContext.Provider>
        </ChangeDetailsContext.Provider>
      </MenuEnvironment.Provider>
    </ContextMenuProvider>
  );
}
