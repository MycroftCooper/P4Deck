import { t as translate, useIsZh } from "../../../shared/i18n";
import {
  useRemovalActions,
  projectShelfChanges,
  projectRemovalChanges,
  shelfObservation,
} from "../../actions/shelfObservation";
import {
  projectGenericPendingChanges,
  useGenericFileProjections,
} from "../../actions/genericFileProjection";
import { recordFrontendOperationLog } from "../../../infrastructure/backend/frontendOperationLog";
import {
  useMoveAttempts,
  projectMoves,
  startOptimisticMove,
  checkOptimisticMove,
  blockedPathDetails,
  formatBlockedPaths,
  reconcileMoveCache,
  mergeConfirmedMoves,
} from "../moveOptimism";
import {
  emptyOpenedSelection,
  selectOpenedFile,
  snapshotOpenedSelection,
  type SelectedOpenedFile,
} from "../selectedFiles";
import { SelectedFilesSubmitDialog } from "./SelectedFilesSubmitDialog";
import type { SelectedSubmitExpectation } from "../selectedSubmit";
import { customSubmitRoute } from "../../companySubmit/customSubmit";
import { useChangeDetails } from "./ChangeDetailsDialog";
import { useCommandFocus } from "../../../app/shell/CommandContext";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  useContext,
  useRef,
  useMemo,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import {
  defaultRangeExtractor,
  useVirtualizer,
  type VirtualItem,
} from "@tanstack/react-virtual";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  FolderArchive,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Send,
  Trash2,
  ListChecks,
  LoaderCircle,
  PackageOpen,
} from "lucide-react";
import type {
  PendingChange,
  PendingChangeSort,
  PendingChangeMutationResult,
  WorkspaceNode,
} from "../../../shared/contracts";
import type { messages } from "../../../shared/i18n";
import { backend } from "../../../infrastructure/backend";
import { PendingFileList } from "./PendingFileList";
import { useContextMenu } from "../../../app/context-menu/ContextMenu";
import { action, copy } from "../../../app/context-menu/bindings";
import { useRecordSelection } from "../../../app/context-menu/useRecordSelection";
import { CommandExecutionContext } from "../../../app/shell/CommandContext";
import { ChangelistFormDialog } from "./ChangelistFormDialog";
import { ShelfDialog, type ShelfRequest } from "./ShelfDialog";
import { startUnshelveDirect } from "../unshelveDirectTask";
import {
  projectUnshelvedChanges,
  useUnshelveProjections,
} from "../unshelveProjection";
import { MoveFilesDialog, type MoveFilesRequest } from "./MoveFilesDialog";
import { mergePendingMutation } from "../pendingQueries";
import {
  authoritativeChangeId,
  beginPendingClIntent,
  lifecycleOf,
  lookupPendingClReceipt,
  pendingClCommitted,
  pendingClDeleteConfirmed,
  recoverPendingClUnknown,
  settlePendingClIntent,
  unwrapPendingClLegacy,
} from "../../actions/pendingClLifecycle";
export { mergePendingMutation } from "../pendingQueries";
import { usePendingCache } from "../pendingCache";
import {
  readPendingFilterState,
  sortPendingChanges,
  writePendingFilterState,
} from "../pendingFilterState";
import { useMenuEnvironment } from "../../../app/context-menu/environment";
import type { WorkflowRefreshDetail } from "../workflowRefresh";
import { swarmMenuAction } from "../../swarm/SwarmAction";
import { pendingFilePath } from "../pendingFilePath";
import { filterPendingChanges } from "../pendingQueries";
import { connectionPresentation } from "../../settings/connectionWizard";
import { PageHeaderActionsContext } from "../../../app/docking/chrome";
type T = (typeof messages)[keyof typeof messages];
const openedStates: Record<string, WorkspaceNode["state"]> = {
  add: "openedAdd",
  branch: "openedAdd",
  edit: "openedEdit",
  integrate: "openedEdit",
  delete: "openedDelete",
  "move/add": "openedMoveAdd",
  "move/delete": "openedMoveDelete",
};
/**
 * F10: the only durable release entry for an unknown write fence is the
 * Operation Log's ActionAdmission list, so every blocked hint must point there
 * instead of reading as a permanent dead end.
 */
const withAdmissionHint = (text: string, _zh: boolean) =>
  `${text} ${translate("pending.release.write.blocks.under.tools")}`;

/** Unshelve runs immediately into the current workspace/default CL: no dialog, no FE preflight. */
function DirectUnshelve({
  request,
  currentWorkspace,
  connectionKey,
  onDismiss,
}: {
  request: ShelfRequest;
  currentWorkspace: string;
  connectionKey: string;
  onDismiss(): void;
}) {
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    startUnshelveDirect({
      connectionKey,
      sourceChangeId: request.changeId,
      depotPaths: request.paths,
      targetWorkspace: currentWorkspace,
      targetChangeId: request.changeId,
    });
    onDismiss();
  }, []);
  return null;
}

export function PendingPage({
  t,
  clientName,
  connectionKey,
  demo,
  ready: cliReady,
  checkingConnection = false,
  navigation,
}: {
  t: T;
  clientName: string;
  connectionKey: string;
  demo: boolean;
  ready: boolean;
  checkingConnection?: boolean;
  navigation?: { changeId: number; nonce: number };
}) {
  const menuEnvironment = useMenuEnvironment();
  const connection = menuEnvironment.runtime.connection;
  // Subscribed locale so switching language re-renders this page.
  const zh = useIsZh();
  const ready = cliReady && connection.state === "connected";
  const checking = checkingConnection || connection.state === "notTested";
  const connectionProblem = !checking && connection.state !== "connected";
  const connectionReason = ready
    ? undefined
    : translate("pending.connection.is.not.ready");
  const retryConnection = () =>
    window.dispatchEvent(new Event("p4deck:auto-refresh"));
  const focus = useCommandFocus();
  const headerTarget = useContext(PageHeaderActionsContext);
  const surface = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const handledNavigation = useRef<number | undefined>(undefined);
  const [form, setForm] = useState<{
    change?: PendingChange;
    source: HTMLElement | null;
  }>();
  const openForm = (change?: PendingChange) => {
    if (!ready) return;
    setForm({
      change,
      source: surface.current?.ownerDocument
        .activeElement as HTMLElement | null,
    });
  };
  const pending = usePendingCache(menuEnvironment.runtime, ready);
  const moveAttempts = useMoveAttempts();
  const moveProjection = useMemo(
    () => projectMoves(pending.changes, connectionKey, moveAttempts),
    [pending.changes, connectionKey, moveAttempts],
  );
  const removalActions = useRemovalActions();
  const genericFileProjections = useGenericFileProjections();
  const genericProjectedChanges = useMemo(
    () => projectGenericPendingChanges(moveProjection.changes, connectionKey),
    [moveProjection.changes, connectionKey, genericFileProjections],
  );
  const observation = shelfObservation(menuEnvironment.runtime).version;
  const unshelveProjections = useUnshelveProjections();
  const removalProjectedChanges = useMemo(
    () =>
      projectRemovalChanges(
        "revert",
        projectShelfChanges(
          genericProjectedChanges,
          connectionKey,
          observation,
          removalActions,
        ),
        connectionKey,
        observation,
        removalActions,
      ),
    [genericProjectedChanges, connectionKey, observation, removalActions],
  );
  // Optimistic unshelve rows: appear in the target CL immediately, replaced by the authoritative refresh.
  const cachedChanges = useMemo(
    () => projectUnshelvedChanges(removalProjectedChanges, connectionKey),
    [removalProjectedChanges, connectionKey, unshelveProjections],
  );
  const currentMoves = moveAttempts.filter(
    (attempt) => attempt.scope === connectionKey,
  );
  const blockedDetails = blockedPathDetails(connectionKey);
  const blockedPaths = new Set(blockedDetails.keys());
  useEffect(() => {
    const merged = mergeConfirmedMoves(
      pending.changes,
      connectionKey,
      moveAttempts,
    );
    if (merged !== pending.changes) {
      pending.updateChanges(
        (base) => mergeConfirmedMoves(base, connectionKey, moveAttempts),
        { revalidate: false },
      );
    }
    reconcileMoveCache(connectionKey, merged);
  }, [connectionKey, pending.changes, moveAttempts, pending.updateChanges]);
  const setChanges = pending.updateChanges;
  const [openedSelection, setOpenedSelection] = useState(() =>
    emptyOpenedSelection(connectionKey),
  );
  const openedRef = useRef(openedSelection);
  if (openedRef.current.scope !== connectionKey)
    openedRef.current = emptyOpenedSelection(connectionKey);
  const [selectedSubmit, setSelectedSubmit] = useState<{
    files: readonly SelectedOpenedFile[];
    expected: SelectedSubmitExpectation;
    scope: string;
  }>();
  const openingSelected = useRef(false);
  const bindingRef = useRef(connectionKey);
  bindingRef.current = connectionKey;
  useEffect(() => {
    setOpenedSelection(emptyOpenedSelection(connectionKey));
  }, [connectionKey]);
  const selectedNodes: WorkspaceNode[] = cachedChanges.flatMap((change) =>
    change.files.map((file) => ({
      id: file.depotPath,
      name: file.depotPath.split("/").at(-1)!,
      kind: "file" as const,
      absolutePath: "",
      relativePath: pendingFilePath(file, menuEnvironment.runtime.context),
      depotPath: file.depotPath,
      changelistId: change.id,
      state: file.state ?? "controlled",
    })),
  );
  const visibleOpenedRows = useRef(
    new Map<number, readonly SelectedOpenedFile[]>(),
  );
  const reportVisibleOpened = useCallback(
    (changeId: number, rows: readonly SelectedOpenedFile[]) => {
      visibleOpenedRows.current.set(changeId, rows);
    },
    [],
  );
  const sharedSelection = {
    reportVisible: reportVisibleOpened,
    state:
      openedSelection.scope === connectionKey
        ? openedSelection
        : emptyOpenedSelection(connectionKey),
    nodes: selectedNodes,
    change: (
      rows: readonly SelectedOpenedFile[],
      path: string,
      gesture = {},
    ) => {
      const next = selectOpenedFile(
        openedRef.current,
        connectionKey,
        changes.flatMap((change) =>
          change.id === rows[0]?.originalChangeId
            ? rows
            : (visibleOpenedRows.current.get(change.id) ?? []),
        ),
        path,
        gesture,
      );
      openedRef.current = next;
      setOpenedSelection(next);
      return next.files;
    },
    clear: () => {
      const next = emptyOpenedSelection(connectionKey);
      openedRef.current = next;
      setOpenedSelection(next);
    },
  };
  const openSelectedSubmit = async (files: readonly SelectedOpenedFile[]) => {
    if (!ready || openingSelected.current || !files.length) return;
    if (files.some((file) => blockedPaths.has(file.depotPath))) {
      const blockedText = formatBlockedPaths(
        files.map((file) => file.depotPath),
        blockedDetails,
        zh,
      );
      setError(
        blockedText
          ? withAdmissionHint(blockedText, zh)
          : translate("pending.selected.files.have.unresolved.items"),
      );
      return;
    }
    const scope = connectionKey;
    const frozen = snapshotOpenedSelection({ scope, files }).files;
    openingSelected.current = true;
    try {
      const connection = await backend.companySubmitConnectionSnapshot();
      const profiles = await backend.listConnectionProfiles();
      if (bindingRef.current !== scope) return;
      customSubmitRoute(profiles, connection, ["1"]); // Validate active profile identity without launching.
      const profile = profiles.profiles.find(
        (p) => p.id === profiles.activeProfileId,
      )!;
      setSelectedSubmit({
        files: frozen,
        scope,
        expected: {
          connection,
          customSubmitExecutablePath:
            profile.context.customSubmitExecutablePath ?? "",
        },
      });
    } catch (cause) {
      if (bindingRef.current === scope) setError(String(cause));
    } finally {
      openingSelected.current = false;
    }
  };

  const loading = pending.initialLoading || pending.refreshing;
  const loaded = !!pending.data;
  const partial = pending.data?.partial ?? false;
  const truncated = pending.data?.stats.truncatedBySafetyLimit ?? false;
  const stats = pending.data?.stats ?? { scannedCount: 0, matchedCount: 0 };
  const reload = useCallback(() => {
    setError("");
    if (!ready) {
      window.dispatchEvent(new Event("p4deck:auto-refresh"));
      return Promise.resolve();
    }
    return pending.refresh();
  }, [pending.refresh, ready]);
  const [move, setMove] = useState<MoveFilesRequest>();
  const [drag, setDrag] = useState<{
    connectionKey: string;
    from: number;
    paths: string[];
    origins: Record<string, number>;
  }>();
  const dragSnapshot = useRef<typeof drag>(undefined);
  const dropContext = useRef({ connectionKey, ready, changes: cachedChanges });
  dropContext.current = { connectionKey, ready, changes: cachedChanges };
  const dropAlive = useRef(true);
  useEffect(() => {
    dropAlive.current = true;
    return () => {
      dropAlive.current = false;
      dragSnapshot.current = undefined;
    };
  }, []);
  const [dropTarget, setDropTarget] = useState<number>();
  const [deleting, setDeleting] = useState<number>();
  const deletingRef = useRef(false);
  const currentBinding = useRef(connectionKey);
  currentBinding.current = connectionKey;
  const [shelfRequest, setShelfRequest] = useState<{
    request: ShelfRequest;
    unshelve: boolean;
  }>();
  const openShelf = (
    change: PendingChange,
    mode: "shelve" | "delete" | "unshelve",
    paths: string[],
    source?: HTMLElement,
  ) => {
    if (!ready) return;
    setShelfRequest({
      request: {
        changeId: change.id,
        paths: [...paths],
        hasShelf: !!change.shelvedFiles.length,
        mode: mode === "delete" ? "delete" : "shelve",
        source:
          source ??
          (surface.current?.ownerDocument.activeElement as HTMLElement | null),
      },
      unshelve: mode === "unshelve",
    });
  };
  const openMove = (from: number, paths: string[]) => {
    if (!ready) return;
    setMove({
      from,
      paths: [...paths],
      origins: Object.fromEntries(
        paths.map((path) => [
          path,
          cachedChanges.find((change) =>
            change.files.some((file) => file.depotPath === path),
          )?.id ?? from,
        ]),
      ),
      source: surface.current?.ownerDocument
        .activeElement as HTMLElement | null,
    });
  };
  const beginDrag = (
    from: number,
    paths: string[],
    event: DragEvent<HTMLElement>,
  ) => {
    if (!ready || move || menuEnvironment.commandBusy) {
      event.preventDefault();
      return;
    }
    const snapshot = {
      connectionKey,
      from,
      paths: [...new Set(paths)],
      origins: Object.fromEntries(
        paths.map((path) => [
          path,
          cachedChanges.find((change) =>
            change.files.some((file) => file.depotPath === path),
          )?.id ?? from,
        ]),
      ),
    };
    dragSnapshot.current = snapshot;
    setDrag(snapshot);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(
      "application/x-p4deck-opened-files",
      JSON.stringify({ from, count: snapshot.paths.length, connectionKey }),
    );
    event.dataTransfer.setData("text/plain", snapshot.paths.join("\n"));
  };
  const dropFiles = (targetChangeId: number, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(undefined);
    // Only our in-memory drag snapshot is trusted; consume synchronously before awaiting IPC.
    const snapshot = dragSnapshot.current;
    dragSnapshot.current = undefined;
    setDrag(undefined);
    if (
      !ready ||
      move ||
      menuEnvironment.commandBusy ||
      !snapshot ||
      snapshot.connectionKey !== connectionKey
    )
      return;
    const target = cachedChanges.find((c) => c.id === targetChangeId);
    if (
      !target ||
      target.status !== "pending" ||
      !Number.isSafeInteger(targetChangeId) ||
      targetChangeId < 0
    )
      return;
    const files = snapshot.paths
      .filter((path) => snapshot.origins[path] !== targetChangeId)
      .map((depotPath) => ({
        depotPath,
        sourceChangeId: snapshot.origins[depotPath],
      }));
    if (!files.length) return;
    const scope = connectionKey;
    void (async () => {
      try {
        const connection = await backend.companySubmitConnectionSnapshot();
        const current = dropContext.current;
        if (
          !dropAlive.current ||
          current.connectionKey !== scope ||
          !current.ready
        )
          return;
        if (
          !connection.profileId ||
          !/^\d+$/.test(connection.generation) ||
          ![connection.server, connection.user, connection.client].every((v) =>
            v.trim(),
          )
        )
          throw Error("invalidConnection");
        if (
          !current.changes.some(
            (c) => c.id === targetChangeId && c.status === "pending",
          ) ||
          files.some(
            (f) =>
              !current.changes
                .find((c) => c.id === f.sourceChangeId)
                ?.files.some((v) => v.depotPath === f.depotPath),
          )
        )
          throw Error(translate("pending.move.selection.changed.select.again"));
        const { profileId, generation, server, user, client } = connection;
        if (
          !startOptimisticMove(
            scope,
            {
              operationId: crypto.randomUUID(),
              connection: { profileId, generation, server, user, client },
              files,
              target: { kind: "existing", changeId: targetChangeId },
            },
            current.changes,
          )
        )
          throw Error(translate("pending.files.have.an.unresolved.move"));
        setExpanded((value) => new Set([...value, targetChangeId]));
      } catch (cause) {
        if (dropAlive.current && dropContext.current.connectionKey === scope)
          setError(String(cause));
      }
    })();
  };
  const allShelfReason = (change: PendingChange) =>
    !ready
      ? connectionReason
      : menuEnvironment.commandBusy
        ? translate("pending.operation.in.progress")
        : loading || partial || truncated || pending.error
          ? translate("pending.shelf.scope.is.incomplete.refresh.before")
          : !Number.isSafeInteger(change.id) ||
              change.id <= 0 ||
              !change.shelvedFiles.length
            ? translate("pending.no.shelved.files.available")
            : undefined;
  const openAllShelf = (
    change: PendingChange,
    mode: "unshelve" | "delete",
    source?: HTMLElement,
  ) => {
    if (allShelfReason(change)) return;
    openShelf(
      change,
      mode,
      [...new Set(change.shelvedFiles.map((file) => file.depotPath))],
      source,
    );
  };
  const openShelfDetail = (changeId: number, path?: string, fresh = false) =>
    menuEnvironment.openFilePage(
      "shelf",
      {
        id: `shelf:${changeId}:${path ?? ""}`,
        name: `Shelf ${changeId}`,
        kind: "file",
        absolutePath: "",
        relativePath: "",
        depotPath: `${changeId}${path ? `::${encodeURIComponent(path)}` : ""}`,
        state: "controlled",
      },
      fresh,
    );
  useEffect(() => {
    const mergeWorkflow = (event: Event) => {
      const detail = (event as CustomEvent<WorkflowRefreshDetail>).detail;
      if (!detail || detail.connectionKey !== connectionKey) return;
      const operation = detail.result.operationIds.join(", ");
      setNotice(
        `${detail.result.message}${operation ? ` · ${translate("pending.operations")} ${operation}` : ""}${detail.result.logReference ? ` · ${translate("pending.log")} ${detail.result.logReference}` : ""}`,
      );
    };
    window.addEventListener("p4deck:workflow-result", mergeWorkflow);
    return () => {
      window.removeEventListener("p4deck:workflow-result", mergeWorkflow);
    };
  }, [connectionKey, t.files]);
  const initialFilter = useRef(readPendingFilterState()).current;
  const [keyword, setKeyword] = useState(initialFilter.keyword);
  const [sort, setSort] = useState<PendingChangeSort>(initialFilter.sort);
  const [optimisticDeleted, setOptimisticDeleted] = useState<Set<number>>(
    new Set(),
  );
  const visibleChanges = useMemo(
    () => cachedChanges.filter((change) => !optimisticDeleted.has(change.id)),
    [cachedChanges, optimisticDeleted],
  );
  const changes = useMemo(
    () =>
      sortPendingChanges(filterPendingChanges(visibleChanges, keyword), sort),
    [visibleChanges, keyword, sort],
  );
  const mounted = useRef(true);
  const activeChangeId = useRef<number | undefined>(undefined);
  const restoreVirtualFocus = useRef(false);
  const setError = (message: string) => {
    if (!message) return;
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
  };
  const error = pending.error;
  useEffect(() => {
    if (!pending.error) return;
    const id = crypto.randomUUID();
    void recordFrontendOperationLog({
      eventId: `${id}-refresh`,
      operationId: id,
      action: "otherOperation",
      phase: "refresh",
      outcome: "failed",
      code: "refreshFailed",
      targetCount: 0,
    });
  }, [pending.error, connectionKey]);
  const authenticationRequired =
    ["authRequired", "ticketExpired"].includes(
      menuEnvironment.runtime.connection.state,
    ) ||
    /session has expired|ticket (?:has )?expired|password (?:invalid|unset)|not logged in|authenticationRequired/i.test(
      error,
    );
  const [, setNotice] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set([31821]));
  const [collapsedShelves, setCollapsedShelves] = useState<Set<number>>(
    new Set(),
  );
  useEffect(() => {
    const relevant = moveAttempts.filter((a) => a.scope === connectionKey);
    const ids = relevant
      .filter(
        (a) =>
          a.request.target.kind === "new" && a.receipt?.targetChangeId != null,
      )
      .map((a) => a.receipt!.targetChangeId!);
    if (ids.length) setExpanded((value) => new Set([...value, ...ids]));
    setOpenedSelection((value) => {
      if (value.scope !== connectionKey) return value;
      const files = value.files.map((file) => {
        const latest = relevant
          .filter((a) =>
            a.request.files.some((f) => f.depotPath === file.depotPath),
          )
          .at(-1);
        const fact = latest?.receipt?.files.find(
          (f) => f.depotPath === file.depotPath,
        );
        const id =
          fact?.state === "notMoved"
            ? fact.sourceChangeId
            : fact?.state === "moved" || fact?.state === "alreadyInTarget"
              ? latest?.receipt?.targetChangeId
              : undefined;
        return id != null ? { ...file, originalChangeId: id } : file;
      });
      return files.every(
        (f, i) => f.originalChangeId === value.files[i].originalChangeId,
      )
        ? value
        : { ...value, files };
    });
  }, [moveAttempts, connectionKey]);
  useEffect(() => writePendingFilterState({ keyword, sort }), [keyword, sort]);
  useEffect(() => {
    setExpanded(new Set());
    setCollapsedShelves(new Set());
    setOptimisticDeleted(new Set());
    setDrag(undefined);
    dragSnapshot.current = undefined;
    setDropTarget(undefined);
  }, [connectionKey]);
  useEffect(() => {
    if (!navigation || handledNavigation.current === navigation.nonce) return;
    if (!cachedChanges.some((change) => change.id === navigation.changeId))
      return;
    if (!changes.some((change) => change.id === navigation.changeId)) {
      setKeyword(String(navigation.changeId));
      return;
    }
    handledNavigation.current = navigation.nonce;
    setExpanded((value) => new Set([...value, navigation.changeId]));
    surface.current
      ?.querySelector<HTMLElement>(
        `[data-pending-change="${navigation.changeId}"]`,
      )
      ?.focus();
  }, [cachedChanges, changes, navigation]);
  const toggleShelf = (id: number) =>
    setCollapsedShelves((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const menu = useContextMenu();
  const openChangeDetails = useChangeDetails();
  const run = useContext(CommandExecutionContext);
  const selection = useRecordSelection(
    changes,
    (change) => String(change.id),
    connectionKey,
  );
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: changes.length,
    getScrollElement: () => list.current,
    estimateSize: (index) => (expanded.has(changes[index]?.id) ? 380 : 54),
    // Expansion needs the committed height, even before ResizeObserver delivers.
    measureElement: (element) => (element as HTMLDivElement).offsetHeight,
    overscan: 6,
    getItemKey: (index) => changes[index]?.id ?? index,
    initialRect: { width: 800, height: 600 },
    rangeExtractor: (range) =>
      [...new Set([0, ...defaultRangeExtractor(range)])].filter(
        (index) => index < changes.length,
      ),
  });
  useLayoutEffect(() => {
    list.current
      ?.querySelectorAll<HTMLDivElement>(".pending-change-virtual-row")
      .forEach((element) => rowVirtualizer.measureElement(element));
  }, [rowVirtualizer, changes, expanded, collapsedShelves]);
  const measuredRows = rowVirtualizer.getVirtualItems();
  const virtualRows: VirtualItem[] = measuredRows.length
    ? measuredRows
    : Array.from({ length: Math.min(changes.length, 20) }, (_, index) => ({
        index,
        key: changes[index].id,
        start: index * 66,
        size: 66,
        end: (index + 1) * 66,
        lane: 0,
      }));
  useEffect(() => {
    const changeId = activeChangeId.current;
    if (!restoreVirtualFocus.current || changeId === undefined) return;
    const document = surface.current?.ownerDocument;
    if (
      document &&
      document.activeElement !== document.body &&
      document.activeElement !== list.current
    )
      return;
    const target = surface.current?.querySelector<HTMLElement>(
      `[data-pending-change="${changeId}"]`,
    );
    if (target) {
      restoreVirtualFocus.current = false;
      target.focus();
    }
  }, [virtualRows]);
  const applyMutation = async (
    raw: unknown,
    incompleteMessage: string,
    successMessage: string,
  ) => {
    const lifecycle = lifecycleOf(raw);
    const legacy =
      unwrapPendingClLegacy<PendingChangeMutationResult>(raw) ??
      (raw as PendingChangeMutationResult);
    if (lifecycle && lifecycle.state !== "legacy") {
      const id = lifecycle.operationId ?? legacy?.operation?.operationId ?? "";
      settlePendingClIntent(id);
      let effective = lifecycle;
      if (!pendingClCommitted(effective)) {
        // Unknown/rejected: exactly ONE same-operationId lookup (never a new id, no retry).
        const recovered = await recoverPendingClUnknown(id, {
          connection: () => backend.companySubmitConnectionSnapshot(),
          lookup: lookupPendingClReceipt,
        });
        if (recovered.result) effective = recovered.result;
        settlePendingClIntent(id);
      }
      if (pendingClCommitted(effective)) {
        const effectiveLegacy =
          unwrapPendingClLegacy<PendingChangeMutationResult>(effective) ??
          legacy;
        if (effectiveLegacy?.refreshedChanges?.length)
          setChanges((value) => mergePendingMutation(value, effectiveLegacy));
        else void reload().catch(() => undefined);
        const authoritative = authoritativeChangeId(effective);
        setError("");
        setNotice(
          `${successMessage}${authoritative ? ` · CL ${authoritative}` : ""} · ${translate("pending.operation")} ${id}${demo ? translate("pending.browser.mock.no.real.p4.server") : ""}`,
        );
        // No p4deck:pending-* events on the wired path: host result + readback are the authority.
      } else {
        setNotice("");
        setError(
          translate("pending.outcome.unconfirmed.existing.rows.kept.and"),
        );
        void reload().catch(() => undefined);
      }
      return;
    }
    if (!legacy?.operation) {
      setError(incompleteMessage);
      return;
    }
    if (!legacy.refreshError)
      setChanges((value) => mergePendingMutation(value, legacy));
    setError(
      legacy.refreshError ? `${incompleteMessage}: ${legacy.refreshError}` : "",
    );
    setNotice(
      legacy.refreshError
        ? ""
        : `${successMessage} · ${translate("pending.operation")} ${legacy.operation.operationId}${demo ? translate("pending.browser.mock.no.real.p4.server") : ""}`,
    );
    if (legacy.refreshError)
      window.dispatchEvent(new Event("p4deck:pending-refresh"));
    else
      window.dispatchEvent(
        new CustomEvent("p4deck:pending-mutation", { detail: legacy }),
      );
  };
  const deleteEmptyChange = async (change: PendingChange) => {
    if (
      !ready ||
      menuEnvironment.commandBusy ||
      deletingRef.current ||
      change.id <= 0 ||
      change.files.length ||
      change.shelvedFiles.length ||
      change.jobs.length
    )
      return;
    const binding = connectionKey;
    deletingRef.current = true;
    setDeleting(change.id);
    setError("");
    const operationId = crypto.randomUUID();
    beginPendingClIntent({
      operationId,
      kind: "pendingClDelete",
      changeId: change.id,
    });
    // Intent-only: the row is hidden while the command is in flight, but the success notice is
    // only produced once the host confirms; unknown/rejected/legacy restores it below.
    setOptimisticDeleted((current) => new Set(current).add(change.id));
    setChanges((current) => current.filter((item) => item.id !== change.id), {
      revalidate: false,
    });
    try {
      const raw: unknown = await backend.mutatePendingChange({
        type: "delete",
        changeId: change.id,
        operationId,
      });
      if (!mounted.current || currentBinding.current !== binding) return;
      const lifecycle = lifecycleOf(raw);
      const confirmed =
        !!lifecycle &&
        pendingClCommitted(lifecycle) &&
        pendingClDeleteConfirmed(lifecycle, change.id);
      if (lifecycle && !confirmed) {
        // Unknown/rejected: keep the row (no fabricated "deleted") and refetch once from authority.
        setOptimisticDeleted((current) => {
          const next = new Set(current);
          next.delete(change.id);
          return next;
        });
        setChanges(
          (current) =>
            current.some((item) => item.id === change.id)
              ? current
              : [...current, change].sort((left, right) =>
                  left.id === 0 ? -1 : right.id === 0 ? 1 : right.id - left.id,
                ),
          { revalidate: false },
        );
      }
      await applyMutation(
        raw,
        translate("pending.delete.refresh.incomplete"),
        translate("pending.changelist.delete.confirmed"),
      );
    } catch (cause) {
      settlePendingClIntent(operationId);
      if (!mounted.current || currentBinding.current !== binding) return;
      setOptimisticDeleted((current) => {
        const next = new Set(current);
        next.delete(change.id);
        return next;
      });
      setChanges(
        (current) =>
          current.some((item) => item.id === change.id)
            ? current
            : [...current, change].sort((left, right) =>
                left.id === 0 ? -1 : right.id === 0 ? 1 : right.id - left.id,
              ),
        { revalidate: false },
      );
      // Err with an operationId is persisted as unknown by the host: recover once by the same id.
      const recovered = await recoverPendingClUnknown(operationId, {
        connection: () => backend.companySubmitConnectionSnapshot(),
        lookup: lookupPendingClReceipt,
      });
      if (recovered.result && pendingClCommitted(recovered.result)) {
        await applyMutation(
          recovered.result,
          translate("pending.delete.refresh.incomplete"),
          translate("pending.changelist.delete.confirmed"),
        );
      } else {
        void reload().catch(() => undefined);
        if (mounted.current && currentBinding.current === binding)
          setError(String(cause));
      }
    } finally {
      deletingRef.current = false;
      if (mounted.current) setDeleting(undefined);
    }
  };
  const deleteReason = (change: PendingChange) =>
    !ready || menuEnvironment.commandBusy || deleting !== undefined
      ? translate("pending.wait.for.the.current.operation")
      : change.id <= 0
        ? translate("pending.default.cannot.be.deleted")
        : change.files.length ||
            change.shelvedFiles.length ||
            change.jobs.length
          ? translate("pending.changelist.contains.files.shelves.or.jobs")
          : undefined;
  const toggle = (id: number) =>
    setExpanded((value) => {
      const next = new Set(value);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const moveFocus = (
    change: PendingChange,
    event: KeyboardEvent<HTMLElement>,
  ) => {
    if (event.target !== event.currentTarget) return;
    if (selection.keyboard(change, event)) return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const index = changes.findIndex((item) => item.id === change.id);
    const target = Math.max(
      0,
      Math.min(
        changes.length - 1,
        index + (event.key === "ArrowDown" ? 1 : -1),
      ),
    );
    if (target === index) return;
    event.preventDefault();
    rowVirtualizer.scrollToIndex(target, { align: "auto" });
    requestAnimationFrame(() =>
      surface.current
        ?.querySelector<HTMLElement>(
          `[data-pending-change="${changes[target].id}"]`,
        )
        ?.focus(),
    );
  };
  const changeMenu = (change: PendingChange) => {
    const conflictNodes: WorkspaceNode[] = change.files
      .filter((file) => file.resolve === "unresolved")
      .map((file) => ({
        id: file.depotPath,
        name: file.depotPath.split("/").pop() ?? file.depotPath,
        kind: "file",
        state: "conflicted",
        absolutePath: file.clientPath ?? "",
        relativePath: file.clientPath ?? file.depotPath,
        depotPath: file.depotPath,
        revision: file.revision,
        changelistId: change.id,
      }));
    return menu(
      selection.targets(change).length > 1
        ? "C12"
        : change.id === 0
          ? "C01"
          : "C02",
      () => ({
        "展开/折叠": action(() => toggle(change.id)),
        查看详情: action((source) =>
          openChangeDetails?.(
            { kind: "pending", changeId: change.id, snapshot: change },
            source,
          ),
        ),
        "解决冲突…": conflictNodes.length
          ? {
              ...action(
                (source) =>
                  run(
                    "resolve",
                    {
                      type: "file",
                      node: conflictNodes[0],
                      nodes: conflictNodes,
                    },
                    source,
                  ),
                connectionReason,
              ),
              emphasis: "primary" as const,
            }
          : { hidden: true },
        "复制标识 default": copy("default"),
        "复制 CL 编号": copy(change.id),
        复制描述: copy(change.description),
        刷新: action(reload),
        "在 Swarm 中打开": swarmMenuAction(
          menuEnvironment.runtime,
          menuEnvironment.preferences.zh,
          {
            kind: change.shelvedFiles.length ? "shelf" : "pendingChange",
            changeId: change.id,
          },
        ),
        "编辑 CL…": action(
          () => openForm(change),
          connectionReason ??
            (change.id > 0
              ? undefined
              : translate("pending.default.has.no.numbered.spec")),
        ),
        "删除空 CL": action(
          () => deleteEmptyChange(change),
          deleteReason(change),
        ),
        "搁置…": action(
          (source) =>
            openShelf(
              change,
              "shelve",
              change.files.map((file) => file.depotPath),
              source,
            ),
          connectionReason ??
            (change.files.length
              ? undefined
              : translate("pending.no.opened.files")),
        ),
        "创建编号 CL 并搁置…": action(
          (source) =>
            openShelf(
              change,
              "shelve",
              change.files.map((file) => file.depotPath),
              source,
            ),
          connectionReason ??
            (change.files.length
              ? undefined
              : translate("pending.no.opened.files")),
        ),
        "移动文件到编号 CL…": action(
          () =>
            openMove(
              change.id,
              change.files.map((file) => file.depotPath),
            ),
          connectionReason ??
            (change.files.length
              ? undefined
              : translate("pending.no.files.to.move")),
        ),
        "移动文件到其他 CL…": action(
          () =>
            openMove(
              change.id,
              change.files.map((file) => file.depotPath),
            ),
          connectionReason ??
            (change.files.length
              ? undefined
              : translate("pending.no.files.to.move")),
        ),
        "复制 CL 编号列表": copy(
          selection
            .targets(change)
            .map((v) => v.id || "default")
            .join("\n"),
        ),
        复制摘要列表: copy(
          selection
            .targets(change)
            .map((v) => `${v.id || "default"} ${v.description}`)
            .join("\n"),
        ),
        "提交整个 CL…": action(
          (source) =>
            run(
              "submit",
              {
                type: "pending",
                id: change.id,
                count: change.files.length,
              },
              source,
            ),
          connectionReason ??
            (change.files.length
              ? undefined
              : translate("pending.empty.cl.cannot.submit")),
        ),
      }),
      {
        title: change.id ? `CL ${change.id}` : "Default",
        onOpen: () => selection.context(change),
      },
    );
  };
  const headerActions =
    headerTarget &&
    createPortal(
      <>
        {(checking || move || deleting !== undefined) && (
          <span className="pending-operation-state" role="status">
            <LoaderCircle size={16} className="spin" />
            <span className="sr-only">
              {checking
                ? translate("pending.checking.connection.and.login")
                : translate("pending.operation.in.progress.2")}
            </span>
          </span>
        )}
        <button
          disabled={!ready}
          title={connectionReason}
          aria-label={t.newCl}
          onClick={() => openForm()}
        >
          <Plus size={15} aria-hidden="true" />
          <span>{t.newCl}</span>
        </button>
      </>,
      headerTarget,
    );
  return (
    <section className="pending-page" ref={surface}>
      {selectedSubmit && (
        <SelectedFilesSubmitDialog
          files={selectedSubmit.files}
          expected={selectedSubmit.expected}
          active={selectedSubmit.scope === connectionKey}
          zh={zh}
          onDismiss={() => {
            setSelectedSubmit(undefined);
            void reload();
          }}
          onContinue={(id, count, expected) => {
            if (bindingRef.current === selectedSubmit.scope)
              run("submit", {
                type: "pending",
                id,
                count,
                selectedSubmitExpectation: expected,
              });
          }}
        />
      )}
      {headerActions}
      {shelfRequest &&
        (shelfRequest.unshelve ? (
          <DirectUnshelve
            request={shelfRequest.request}
            currentWorkspace={clientName}
            connectionKey={connectionKey}
            onDismiss={() => setShelfRequest(undefined)}
          />
        ) : (
          <ShelfDialog
            request={shelfRequest.request}
            connectionKey={connectionKey}
            demo={demo}
            zh={zh}
            onDismiss={() => setShelfRequest(undefined)}
          />
        ))}
      {move && (
        <MoveFilesDialog
          request={move}
          changes={cachedChanges}
          client={clientName}
          connectionKey={connectionKey}
          zh={zh}
          onDismiss={() => setMove(undefined)}
          onStart={(request) => {
            if (!startOptimisticMove(connectionKey, request, cachedChanges))
              return false;
            if (request.target.kind === "existing") {
              const id = request.target.changeId;
              setExpanded((value) => new Set([...value, id]));
            }
            return true;
          }}
        />
      )}
      {form && (
        <ChangelistFormDialog
          mode={form.change ? "edit" : "create"}
          changeId={form.change?.id}
          initial={
            form.change
              ? {
                  description: form.change.description,
                  jobs: [...form.change.jobs],
                }
              : undefined
          }
          client={clientName}
          zh={zh}
          source={form.source}
          onDismiss={() => setForm(undefined)}
          onSubmit={async (draft) => {
            const operationId = crypto.randomUUID();
            beginPendingClIntent({
              operationId,
              kind: form.change ? "pendingClEdit" : "pendingClCreate",
              changeId: form.change?.id,
            });
            try {
              const raw: unknown = await backend.mutatePendingChange(
                form.change
                  ? {
                      type: "edit",
                      changeId: form.change.id,
                      description: draft.description,
                      jobs: draft.jobs,
                      operationId,
                    }
                  : {
                      type: "create",
                      description: draft.description,
                      jobs: draft.jobs,
                      operationId,
                    },
              );
              await applyMutation(
                raw,
                translate("pending.save.refresh.incomplete"),
                form.change
                  ? translate("pending.changelist.edit.confirmed")
                  : translate("pending.changelist.creation.confirmed"),
              );
            } catch (cause) {
              settlePendingClIntent(operationId);
              // Err with an operationId is persisted as unknown by the host: one same-id recovery.
              const recovered = await recoverPendingClUnknown(operationId, {
                connection: () => backend.companySubmitConnectionSnapshot(),
                lookup: lookupPendingClReceipt,
              });
              if (recovered.result && pendingClCommitted(recovered.result)) {
                await applyMutation(
                  recovered.result,
                  translate("pending.save.refresh.incomplete"),
                  form.change
                    ? translate("pending.changelist.edit.confirmed")
                    : translate("pending.changelist.creation.confirmed"),
                );
                return;
              }
              // No legacy refresh event on the wired path; one bounded authoritative refetch.
              void reload().catch(() => undefined);
              throw cause;
            }
          }}
        />
      )}
      <div
        className="pending-query-bar"
        aria-label="Pending changelist filters"
      >
        <input
          className="search-field"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={translate(
            "pending.filter.cached.cl.description.or.file",
          )}
          aria-label={translate("pending.filter.pending.changelists")}
        />
        <button
          className="secondary"
          type="button"
          onClick={() =>
            setSort((value) => (value === "newest" ? "oldest" : "newest"))
          }
          aria-label={translate(
            "pending.toggle.ascending.descending.cl.number",
          )}
          aria-pressed={sort === "oldest"}
        >
          {sort === "oldest"
            ? translate("pending.cl.ascending")
            : translate("pending.cl.descending")}
        </button>
      </div>
      {(authenticationRequired || connectionProblem) && (
        <div
          role="alert"
          className={`workspace-load-error${connectionProblem || authenticationRequired ? " pending-connection-status" : ""}`}
        >
          {authenticationRequired ? (
            <>
              <p>{translate("pending.your.login.has.expired.or.is")}</p>
              <button
                className="secondary"
                onClick={() => menuEnvironment.openPage("settings")}
              >
                {translate("pending.connection.settings")}
              </button>
            </>
          ) : connectionProblem ? (
            <>
              <p>
                {connectionPresentation(connection, zh).title}
                {" · "}
                {translate(
                  loaded
                    ? "pending.showing.local.cache"
                    : "pending.no.local.cache",
                )}
              </p>
              {connection.recovery === "retry" && (
                <button className="secondary" onClick={retryConnection}>
                  {translate("pending.retry.connection")}
                </button>
              )}
              <button
                className="secondary"
                onClick={() => menuEnvironment.openPage("settings")}
              >
                {translate("pending.connection.settings.2")}
              </button>
            </>
          ) : (
            error
          )}
        </div>
      )}
      {(partial || truncated) && (
        <div role="status" className="workspace-notice">
          {translate("pending.partial.results.counts", {
            scanned: stats.scannedCount,
            matched: stats.matchedCount,
          })}
        </div>
      )}
      {currentMoves.some(
        (a) => a.busy || !a.receipt || a.receipt.stage !== "completed",
      ) && (
        <div className="pending-move-status" role="status">
          {currentMoves
            .filter(
              (a) => a.busy || !a.receipt || a.receipt.stage !== "completed",
            )
            .map((a) => (
              <div key={a.request.operationId}>
                <span>
                  {translate(
                    "pending.local.grouping.preview.unconfirmed.files.need",
                  )}{" "}
                  · {a.request.files.length}
                </span>
                <details>
                  <summary>{translate("pending.file.status")}</summary>
                  {a.request.files.map((file) => (
                    <div key={file.depotPath}>
                      {file.depotPath} ·{" "}
                      {(() => {
                        const state =
                          a.receipt?.files.find(
                            (f) => f.depotPath === file.depotPath,
                          )?.state ?? "unknown";
                        return zh
                          ? {
                              moved: translate("pending.mark.moved"),
                              notMoved: translate("pending.mark.not.moved"),
                              unknown: translate("pending.mark.unverified"),
                              alreadyInTarget: translate(
                                "pending.mark.already.in.target",
                              ),
                            }[state]
                          : state;
                      })()}
                    </div>
                  ))}
                </details>
                {a.busy ? (
                  <button
                    className="secondary"
                    onClick={() =>
                      void backend
                        .cancelOperation(a.request.operationId)
                        .catch((cause) => setError(String(cause)))
                    }
                  >
                    {translate("pending.stop.remaining.operations")}
                  </button>
                ) : (
                  <button
                    className="secondary"
                    onClick={() => checkOptimisticMove(a.request.operationId)}
                  >
                    {translate("pending.check.this.attempt")}
                  </button>
                )}
              </div>
            ))}
        </div>
      )}
      {moveProjection.temporary.map((group) => (
        <section
          className="pending-move-temporary"
          key={group.operationId}
          aria-label={translate("pending.new.cl.number.not.confirmed")}
        >
          <strong>{translate("pending.new.cl.number.not.confirmed")}</strong> ·{" "}
          {group.description}
          <ul>
            {group.files.map((file) => (
              <li key={file.depotPath}>{file.depotPath}</li>
            ))}
          </ul>
        </section>
      ))}
      <div
        className="pending-list"
        ref={list}
        tabIndex={0}
        data-testid="pending-change-virtual-list"
        {...menu("C13", () => ({
          "新建 CL…": action(() => openForm(), connectionReason),
          刷新: action(reload),
          全选当前筛选结果: action(selection.all),
          清除选择: action(selection.clear),
        }))}
      >
        <div
          className="pending-change-spacer"
          style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
        >
          {virtualRows.map((virtualRow: VirtualItem) => {
            const change = changes[virtualRow.index];
            const label = change.id ? `CL ${change.id}` : "Default";
            const unavailable =
              (() => {
                const blockedText = formatBlockedPaths(
                  change.files.map((file) => file.depotPath),
                  blockedDetails,
                  zh,
                );
                return blockedText
                  ? withAdmissionHint(blockedText, zh)
                  : undefined;
              })() ??
              (!ready
                ? translate("pending.connection.is.not.ready")
                : menuEnvironment.commandBusy || deleting !== undefined
                  ? translate("pending.wait.for.the.current.operation")
                  : !change.files.length
                    ? translate("pending.no.opened.files")
                    : undefined);
            const numberedReason =
              unavailable ??
              (change.id === 0
                ? translate("pending.move.files.to.a.numbered")
                : undefined);
            const revertTarget = () => {
              const revertNodes: WorkspaceNode[] = change.files.map((file) => ({
                id: file.depotPath,
                name: file.depotPath.split("/").pop()!,
                kind: "file",
                depotPath: file.depotPath,
                absolutePath: "",
                relativePath: pendingFilePath(
                  file,
                  menuEnvironment.runtime.context,
                ),
                state: file.state ?? openedStates[file.action] ?? "unknown",
                changelistId: change.id,
              }));
              return revertNodes.length
                ? {
                    type: "file" as const,
                    node: revertNodes[0],
                    nodes: revertNodes,
                    scopeLabel: `${label} · ${translate("pending.all.opened.files")}`,
                    wholeChangelistId: change.id,
                  }
                : undefined;
            };
            return (
              <div
                key={change.id}
                ref={rowVirtualizer.measureElement}
                data-index={virtualRow.index}
                className={`pending-change-virtual-row ${change.id === 0 && !expanded.has(0) ? "pending-default-row" : ""}`}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <section
                  className={`pending-card ${selection.isSelected(change) ? "command-selected" : ""} ${dropTarget === change.id ? "drop-target" : ""}`}
                  aria-label={`${change.id === 0 ? "Default" : `CL ${change.id}`} drop target`}
                  onDragOver={(event) => {
                    if (
                      drag?.connectionKey === connectionKey &&
                      drag.paths.some(
                        (path) => drag.origins[path] !== change.id,
                      )
                    ) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setDropTarget(change.id);
                    }
                  }}
                  onDragLeave={(event) => {
                    if (
                      !event.relatedTarget ||
                      !event.currentTarget.contains(event.relatedTarget as Node)
                    )
                      setDropTarget(undefined);
                  }}
                  onDrop={(event) => dropFiles(change.id, event)}
                >
                  <header
                    data-pending-change={change.id}
                    tabIndex={0}
                    {...changeMenu(change)}
                    onKeyDown={(event) => moveFocus(change, event)}
                    onFocus={() => {
                      activeChangeId.current = change.id;
                      focus({
                        type: "pending",
                        id: change.id,
                        count: change.files.length,
                      });
                    }}
                    onBlur={(event) => {
                      if (!event.relatedTarget)
                        restoreVirtualFocus.current = true;
                    }}
                    onClick={(event) => {
                      selection.select(change, event);

                      toggle(change.id);
                      focus({
                        type: "pending",
                        id: change.id,
                        count: change.files.length,
                      });
                    }}
                  >
                    <ChevronDown
                      size={15}
                      className={
                        expanded.has(change.id)
                          ? ""
                          : "pending-chevron-collapsed"
                      }
                    />
                    <strong>
                      {change.id === 0 ? "Default" : `CL ${change.id}`}
                    </strong>
                    <span
                      className="pending-description"
                      title={change.description}
                    >
                      {change.description}
                    </span>
                    {change.files.some(
                      (file) => file.resolve === "unresolved",
                    ) && (
                      <span
                        className="pending-resolve-badge"
                        role="img"
                        title={translate(
                          "pending.changelist.has.files.that.need",
                        )}
                        aria-label={translate("pending.needs.resolve")}
                      >
                        !
                      </span>
                    )}
                    <b>
                      {change.files.length} {t.files}
                    </b>
                    <div
                      className="pending-cl-actions"
                      role="group"
                      aria-label={`${label} ${translate("pending.actions")}`}
                    >
                      <button
                        type="button"
                        disabled={!!numberedReason}
                        title={
                          numberedReason ??
                          translate("pending.submit.entire", { label })
                        }
                        aria-label={translate("pending.submit.label", {
                          label,
                        })}
                        onClick={(event) => {
                          event.stopPropagation();
                          run(
                            "submit",
                            {
                              type: "pending",
                              id: change.id,
                              count: change.files.length,
                            },
                            event.currentTarget,
                          );
                        }}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        <Send size={14} />
                        <span>{translate("pending.submit")}</span>
                      </button>
                      <button
                        type="button"
                        disabled={!!unavailable}
                        title={
                          unavailable ??
                          translate("pending.revert.all.opened.in", { label })
                        }
                        aria-label={translate("pending.revert.all.label", {
                          label,
                        })}
                        onClick={(event) => {
                          event.stopPropagation();
                          const target = revertTarget();
                          if (target)
                            run("revert", target, event.currentTarget);
                        }}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        <RotateCcw size={14} />
                        <span>{translate("pending.revert.all")}</span>
                      </button>
                      <button
                        type="button"
                        disabled={!!unavailable}
                        title={
                          unavailable ??
                          translate("pending.revert.only.unchanged.in", {
                            label,
                          })
                        }
                        aria-label={translate(
                          "pending.revert.unchanged.label",
                          { label },
                        )}
                        onClick={(event) => {
                          event.stopPropagation();
                          const target = revertTarget();
                          if (target)
                            run("revertUnchanged", target, event.currentTarget);
                        }}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        <ListChecks size={14} />
                        <span>{translate("pending.revert.unchanged")}</span>
                      </button>
                      <button
                        type="button"
                        disabled={!!numberedReason}
                        title={
                          numberedReason ??
                          translate("pending.shelve.all.opened.in", { label })
                        }
                        aria-label={translate("pending.shelve.all.label", {
                          label,
                        })}
                        onClick={(event) => {
                          event.stopPropagation();
                          openShelf(
                            change,
                            "shelve",
                            change.files.map((file) => file.depotPath),
                            event.currentTarget,
                          );
                        }}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        <FolderArchive size={14} />
                        <span>{translate("pending.shelve.all")}</span>
                      </button>
                    </div>
                    {change.id ? (
                      <button
                        title={translate("pending.delete.an.empty.numbered.cl")}
                        aria-label={t.delete}
                        disabled={!!deleteReason(change)}
                        aria-busy={deleting === change.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          void deleteEmptyChange(change);
                        }}
                      >
                        {deleting === change.id ? (
                          <LoaderCircle size={14} className="spin" />
                        ) : (
                          <Trash2 size={14} />
                        )}
                      </button>
                    ) : null}
                    <button
                      aria-label={`${translate("pending.open.cl.menu")} ${change.id || "Default"}`}
                      onClick={(event) =>
                        changeMenu(change).onContextMenu(event)
                      }
                    >
                      <MoreHorizontal size={16} />
                    </button>
                  </header>
                  {expanded.has(change.id) ? (
                    <div className="pending-body">
                      <PendingFileList
                        files={change.files}
                        sharedSelection={sharedSelection}
                        onSubmitSelected={(files) =>
                          void openSelectedSubmit(files)
                        }
                        changeId={change.id}
                        refresh={reload}
                        onMove={(paths) => openMove(change.id, paths)}
                        onDragFiles={(paths, event) =>
                          beginDrag(change.id, paths, event)
                        }
                        onDragEnd={() => {
                          dragSnapshot.current = undefined;
                          setDrag(undefined);
                          setDropTarget(undefined);
                        }}
                        onShelf={(mode, paths, source) =>
                          openShelf(change, mode, paths, source)
                        }
                      />
                      {change.shelvedFiles.length ? (
                        <>
                          <h4
                            className="pending-shelf-heading"
                            tabIndex={0}
                            {...menu("C06", () => ({
                              "Unshelve 到 CL…": action(
                                (source) =>
                                  openAllShelf(change, "unshelve", source),
                                allShelfReason(change),
                              ),
                              查看搁置详情: action(() =>
                                openShelfDetail(change.id),
                              ),
                              "删除搁置内容…": action(
                                (source) =>
                                  openAllShelf(change, "delete", source),
                                allShelfReason(change),
                              ),
                              "展开/折叠": action(() => toggleShelf(change.id)),
                              "复制来源 CL 编号": copy(change.id),
                              刷新: action(reload),
                              "在 Swarm 中打开": swarmMenuAction(
                                menuEnvironment.runtime,
                                menuEnvironment.preferences.zh,
                                { kind: "shelf", changeId: change.id },
                              ),
                            }))}
                          >
                            <button
                              type="button"
                              className="pending-shelf-toggle"
                              aria-label={translate(
                                collapsedShelves.has(change.id)
                                  ? "pending.expand.shelved.files"
                                  : "pending.collapse.shelved.files",
                                { id: change.id },
                              )}
                              aria-expanded={!collapsedShelves.has(change.id)}
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleShelf(change.id);
                              }}
                              onKeyDown={(event) => event.stopPropagation()}
                            >
                              <ChevronDown
                                size={15}
                                className={
                                  collapsedShelves.has(change.id)
                                    ? "pending-chevron-collapsed"
                                    : ""
                                }
                              />
                            </button>
                            <FolderArchive size={13} aria-hidden="true" />
                            <span>{t.shelves}</span>
                            <span
                              className="pending-shelf-actions"
                              role="group"
                              aria-label={translate(
                                "pending.shelved.files.actions",
                                { id: change.id },
                              )}
                            >
                              <button
                                type="button"
                                className="secondary"
                                disabled={!!allShelfReason(change)}
                                title={
                                  allShelfReason(change) ??
                                  translate("pending.move.all.shelved.from", {
                                    id: change.id,
                                  })
                                }
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openAllShelf(
                                    change,
                                    "unshelve",
                                    event.currentTarget,
                                  );
                                }}
                                onKeyDown={(event) => event.stopPropagation()}
                              >
                                <PackageOpen size={13} aria-hidden="true" />
                                {translate("pending.move.all.to.cl")}
                              </button>
                              <button
                                type="button"
                                className="secondary"
                                disabled={!!allShelfReason(change)}
                                title={
                                  allShelfReason(change) ??
                                  translate("pending.delete.all.shelved.in", {
                                    id: change.id,
                                  })
                                }
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openAllShelf(
                                    change,
                                    "delete",
                                    event.currentTarget,
                                  );
                                }}
                                onKeyDown={(event) => event.stopPropagation()}
                              >
                                <Trash2 size={13} aria-hidden="true" />
                                {translate("pending.delete.all")}
                              </button>
                            </span>
                          </h4>
                          {!collapsedShelves.has(change.id) && (
                            <PendingFileList
                              files={change.shelvedFiles}
                              changeId={change.id}
                              shelf
                              onInspect={(path, fresh) =>
                                openShelfDetail(change.id, path, fresh)
                              }
                              onShelf={(mode, paths, source) =>
                                openShelf(change, mode, paths, source)
                              }
                              refresh={reload}
                            />
                          )}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              </div>
            );
          })}
        </div>
        {loading && !loaded && !changes.length ? (
          <div role="status">{translate("pending.loading")}</div>
        ) : null}
        {(loaded || !loading) &&
        !changes.length &&
        !error &&
        !authenticationRequired &&
        !checking &&
        !connectionProblem ? (
          <div className="empty-state">{t.empty}</div>
        ) : null}
      </div>
    </section>
  );
}
