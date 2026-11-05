import { t, tFor, type MsgKey } from "../../shared/i18n";
import { startGenericFileAction } from "../../features/actions/genericFileTask";
import { discardGenericFileProjectionsForTarget } from "../../features/actions/genericFileProjection";
import { revertTargets, startRevert } from "../../features/actions/revertTask";
import {
  cancelLocalDelete,
  localDeleteRecord,
  startLocalDelete,
} from "../../features/actions/localDeleteTask";
import type { PendingSnapshot } from "../../features/changelists/pendingCache";
import { useCustomSubmit } from "../../features/companySubmit/useCustomSubmit";
import { historyDiffTarget } from "./commandPolicy";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { queryAllPendingChanges } from "../../features/changelists/pendingQueries";
import {
  cachedPendingChanges,
  pendingSnapshotKey,
} from "../../features/changelists/pendingCache";
import { invalidateData } from "../../shared/cache/dataEffects";
import { isFresh, readSnapshot } from "../../shared/cache/snapshots";
import { commandActions } from "../actions/actionCatalog";
import { startKeymapPersistence } from "../commands/keymapPersistence";
import {
  refreshFileLockFacts,
  useCommandDialogs,
} from "../dialogs/useCommandDialogs";
import type { OperationConfirmation } from "../dialogs/OperationConfirmDialog";
import {
  Settings,
  ArrowRight,
  ClipboardPaste,
  CloudDownload,
  Copy,
  Eye,
  FilePlus2,
  FileX2,
  FolderOpen,
  GitBranch,
  History,
  ListRestart,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  SquarePen,
  AppWindow,
  Columns2,
  LockKeyhole,
  LockKeyholeOpen,
  X,
} from "lucide-react";
import {
  affectedPathAliases,
  selectionRequest,
} from "../../features/files/selectionCommands";
import { resolveSelection } from "../../features/files/resolveSelection";
import { nodeKey } from "../../features/files/selection";
import { backend } from "../../infrastructure/backend";
import {
  readClipboardText,
  writeClipboardText,
} from "../../infrastructure/clipboard";
import type { RuntimeInfo, WorkspaceNode } from "../../shared/contracts";
import { subscribeSafely } from "../../shared/lib/subscription";
import { cleanAddress } from "../../features/files/address";
import { workspaceCache } from "../../features/files/workspaceQueries";
import { resolveAddress } from "../../features/files/resolveAddress";
import { useContextMenu } from "../context-menu/ContextMenu";
import { useMenuEnvironment } from "../context-menu/environment";
import { action } from "../context-menu/bindings";
import { useLocalPathCapabilities } from "./useLocalPathCapabilities";
import { defaultUi } from "../../features/settings/preferences";
import type { FilePageId } from "../panels";
import {
  commandReason,
  commandTargetKey,
  type CommandId,
  type CommandTarget,
} from "./commandPolicy";
import {
  startOperation,
  useOperationWatchdog,
  type ActiveOperation,
} from "./useOperationWatchdog";
import { commandFamily } from "./commandWatchdog";
import { recordFrontendOperationLog } from "../../infrastructure/backend/frontendOperationLog";

const groups: {
  id: CommandId;
  icon: typeof RefreshCw;
  zh: string;
  en: string;
}[][] = [
  [
    {
      id: "refresh",
      icon: RefreshCw,
      zh: "shell.refresh",
      en: "shell.refresh",
    },
    {
      id: "getLatest",
      icon: CloudDownload,
      zh: "shell.get.latest",
      en: "shell.get.latest",
    },
  ],
  [
    {
      id: "checkout",
      icon: SquarePen,
      zh: "shell.checkout",
      en: "shell.checkout",
    },
    { id: "add", icon: FilePlus2, zh: "shell.add", en: "shell.add" },
    {
      id: "delete",
      icon: FileX2,
      zh: "shell.mark.delete",
      en: "shell.mark.delete",
    },
    { id: "revert", icon: RotateCcw, zh: "shell.revert", en: "shell.revert" },
    { id: "lock", icon: LockKeyhole, zh: "shell.lock", en: "shell.lock" },
    {
      id: "unlock",
      icon: LockKeyholeOpen,
      zh: "shell.unlock",
      en: "shell.unlock",
    },
  ],
  [
    { id: "diff", icon: Columns2, zh: "shell.diff", en: "shell.diff" },
    { id: "history", icon: History, zh: "shell.history", en: "shell.history" },
    {
      id: "revgraph",
      icon: GitBranch,
      zh: "shell.revgraph",
      en: "shell.revgraph",
    },
    { id: "preview", icon: Eye, zh: "shell.preview", en: "shell.preview" },
  ],
  [
    { id: "reveal", icon: FolderOpen, zh: "shell.reveal", en: "shell.reveal" },
    {
      id: "openWith",
      icon: AppWindow,
      zh: "shell.open.with",
      en: "shell.open.with",
    },
  ],
];
interface Props {
  navigationActions?: ReactNode;
  settingsActive?: boolean;
  onBusyChange(value: boolean): void;
  onOpenOperations(error?: string): void;
  registerCommand(
    handler:
      | ((id: CommandId, target?: CommandTarget, source?: HTMLElement) => void)
      | undefined,
  ): void;
  zh: boolean;
  runtime: RuntimeInfo;
  connectionKey: string;
  target: CommandTarget;
  targetError: string;
  onNavigate(node: WorkspaceNode): void;
  onFocus(target: CommandTarget): void;
  onHistoryDiff?(path: string, left: number, right: number): void;
  onReview(page: FilePageId, node: WorkspaceNode): void;
}
export function CommandBar({
  navigationActions,
  settingsActive,
  zh,
  runtime,
  connectionKey,
  target,
  targetError,
  onNavigate,
  onFocus,
  onReview,
  onHistoryDiff,
  registerCommand,
  onBusyChange,
  onOpenOperations,
}: Props) {
  const customSubmit = useCustomSubmit(connectionKey, backend);
  const menu = useContextMenu();
  const { preferences, openPage } = useMenuEnvironment();
  // Defensive read: hosts/tests that provide an older UiPreferences shape must
  // keep the documented default instead of disabling confirmation entirely.
  const getLatestConfirmThreshold =
    preferences.ui.getLatestConfirmThreshold ??
    defaultUi.getLatestConfirmThreshold;
  const localCapabilities = useLocalPathCapabilities(
    target,
    runtime.mode === "tauri",
    connectionKey,
  );
  const targetPath =
    target.type === "file"
      ? target.node.absolutePath || target.node.depotPath || ""
      : target.type === "history"
        ? target.path
        : "";
  const targetKey = commandTargetKey(target);
  const [address, setAddress] = useState(targetPath);
  const addressInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  // Dismissible inline notices; the toolbar itself stays silent and stable.
  const [notice, setNotice] = useState("");
  // Route frontend-only failures to the host log without opening a panel.
  const openOperations = useRef(onOpenOperations);
  openOperations.current = onOpenOperations;
  useEffect(() => {
    if (error) openOperations.current(error);
  }, [error]);
  useEffect(() => {
    if (targetError) openOperations.current(targetError);
  }, [targetError, connectionKey]);
  const [locating, setLocating] = useState(false);
  const running = useRef<string | undefined>(undefined);
  const navigation = useRef(0);
  const generation = useRef(0);
  const latest = useRef({ connectionKey, targetPath, targetKey });
  latest.current = { connectionKey, targetPath, targetKey };
  const dialogs = useCommandDialogs(
    connectionKey,
    runtime.context.client,
    zh,
    runtime.mode === "mock",
    targetKey,
    async (refreshNodes) => {
      const epoch = generation.current;
      const expectedConnection = connectionKey;
      const expectedTarget = targetKey;
      try {
        const updated = await resolveSelection(
          refreshNodes,
          connectionKey,
          runtime.context.cwd,
          true,
        );
        if (
          epoch !== generation.current ||
          latest.current.connectionKey !== expectedConnection ||
          latest.current.targetKey !== expectedTarget
        )
          return;
        const primaryKey =
          target.type === "file" ? nodeKey(target.node) : undefined;
        const primary =
          updated.find((node) => nodeKey(node) === primaryKey) ??
          updated.at(-1);
        onFocus(
          primary
            ? { type: "file", node: primary, nodes: updated }
            : { type: "none" },
        );
      } catch {
        if (
          epoch === generation.current &&
          latest.current.connectionKey === expectedConnection &&
          latest.current.targetKey === expectedTarget
        )
          onFocus({ type: "none" });
      }
    },
  );
  const [operation, setOperation] = useState<ActiveOperation>();
  const refreshInFlight = useRef(false);
  // A hung host call must not leave the toolbar disabled forever. Once the limit
  // is exceeded the operation is abandoned as an uncertain result.
  const timedOut = useRef<string | undefined>(undefined);
  useOperationWatchdog(operation, (stale) => {
    // The interval may tick again before React clears it; report each
    // operation exactly once.
    if (timedOut.current === stale.id) return;
    timedOut.current = stale.id;
    if (running.current === stale.id) running.current = undefined;
    setOperation((old) => (old && old.id === stale.id ? undefined : old));
    setNotice(t("shell.the.operation.did.not.return"));
    void recordFrontendOperationLog({
      eventId: `${stale.id}-watchdog`,
      operationId: stale.id,
      action: "otherOperation",
      phase: "execute",
      outcome: "unknown",
      code: "uncertainOutcome",
      targetCount: stale.targetCount,
    });
  });
  useEffect(() => {
    onBusyChange(!!operation || dialogs.pending);
    return () => onBusyChange(false);
  }, [!!operation, dialogs.pending, onBusyChange]);
  useEffect(() => {
    setAddress(targetPath);
    navigation.current++;
    // Selecting another target must NOT abandon an in-flight operation: the
    // backend command keeps running and the user still needs its busy state and
    // Cancel entry. Only a connection/generation change may force-clear it.
    setLocating(false);
  }, [targetPath, targetKey]);
  // P4V Jump to Address Bar (Alt+L / Ctrl+G) is dispatched by the app catalog
  // through this window event so the shared shortcut path stays in one place.
  useEffect(() => {
    const focus = () => {
      const input = addressInput.current;
      if (!input || input.disabled) return;
      input.focus();
      input.select();
    };
    window.addEventListener("p4deck:focus-address", focus);
    return () => window.removeEventListener("p4deck:focus-address", focus);
  }, []);
  // Load the profile keymap once per window; Settings edits persist through the
  // shared keymap store and are restored here on the next startup/profile switch.
  useEffect(
    () => startKeymapPersistence(runtime.activeProfileId),
    [runtime.activeProfileId],
  );
  useEffect(() => {
    navigation.current++;
    generation.current++;
    running.current = undefined;
    setOperation(undefined);
    setNotice("");
    setError("");
    setLocating(false);
  }, [connectionKey, runtime.contextGeneration]);
  useEffect(
    () => () => {
      navigation.current++;
      generation.current++;
    },
    [],
  );
  useEffect(
    () =>
      subscribeSafely(
        () =>
          backend.subscribeOperationEvents((event) => {
            if (event.operationId === running.current && event.progress != null)
              setOperation((old) =>
                old ? { ...old, progress: event.progress } : old,
              );
          }),
        (cause) => setError(String(cause)),
      ),
    [],
  );
  const attempt = (work: () => Promise<void>) => {
    const epoch = generation.current;
    setError("");
    void work().catch((cause) => {
      if (epoch === generation.current) setError(String(cause));
    });
  };
  async function navigate(raw: string) {
    const seq = ++navigation.current;
    setLocating(false);
    const path = cleanAddress(raw);
    setAddress(path);
    setLocating(true);
    try {
      const node = await resolveAddress(
        path,
        connectionKey,
        runtime.context.cwd,
      );
      if (seq === navigation.current) onNavigate(node);
    } catch (cause) {
      if (seq === navigation.current) setError(String(cause));
    } finally {
      if (seq === navigation.current) setLocating(false);
    }
  }
  async function execute(
    id: CommandId,
    snapshot?: CommandTarget,
    source?: HTMLElement,
  ) {
    const epoch = generation.current;
    const actionTarget = snapshot ?? target;
    const actionNodes =
      actionTarget.type === "file"
        ? (actionTarget.nodes ?? [actionTarget.node])
        : [];
    const capabilities =
      snapshot &&
      actionTarget.type === "file" &&
      runtime.mode === "tauri" &&
      ["reveal", "openWith"].includes(id)
        ? await backend.localPathCapabilities(actionTarget.node.absolutePath)
        : snapshot
          ? undefined
          : localCapabilities;
    if (
      epoch !== generation.current ||
      latest.current.connectionKey !== connectionKey
    )
      throw new Error(t("shell.connection.changed.select.the.target"));
    return executeTarget(id, actionTarget, actionNodes, capabilities, source);
  }
  async function executeTarget(
    id: CommandId,
    target: CommandTarget,
    nodes: WorkspaceNode[],
    capabilities: typeof localCapabilities | undefined,
    source?: HTMLElement,
  ) {
    // A menu can execute a locked target different from the toolbar selection.
    // Only refresh focus if that exact target is still selected when it completes.
    const targetKey = commandTargetKey(target);
    discardGenericFileProjectionsForTarget(connectionKey, targetKey);
    const reason = commandReason(
      id,
      target,
      !!running.current || dialogs.pending,
      runtime.mode === "tauri",
      zh,
      capabilities,
    );
    if (reason) throw new Error(reason);
    if (id === "diff" && target.type === "history") {
      const pair = historyDiffTarget(target);
      if (pair) onHistoryDiff?.(pair.path, pair.left, pair.right);
      return;
    }
    if ((id === "moveFiles" || id === "shelve") && target.type === "file") {
      dialogs.open({
        kind: "fileCl",
        nodes: nodes.map((node) => ({ ...node })),
        mode: id,
        source: source ?? (document.activeElement as HTMLElement | null),
      });
      return;
    }
    if (id === "resolve" && target.type === "file") {
      dialogs.open({
        kind: "resolve",
        nodes: nodes.map((node) => ({ ...node })),
        source: source ?? (document.activeElement as HTMLElement | null),
      });
      return;
    }
    if (id === "getRevision" && target.type === "file") {
      dialogs.open({
        kind: "sync",
        nodes: nodes.map((node) => ({ ...node })),
        revisionMode: "choose",
        scopeLabel: target.scopeLabel,
        source: source ?? (document.activeElement as HTMLElement | null),
      });
      return;
    }
    if (id === "getLatest" && target.type === "file") {
      // One-click Get Latest always runs the cheap `p4 sync -n` preflight in the
      // background (spinner, no dialog). Only the preview's affected-file count
      // decides whether an explicit confirmation is required; a preview failure
      // never executes and never opens a dialog.
      const operationId = crypto.randomUUID();
      const epoch = generation.current;
      running.current = operationId;
      setOperation(
        startOperation(operationId, t("shell.get.latest"), {
          kind: "getLatest",
          cancellable: true,
          targetCount: nodes.length,
        }),
      );
      let paths: readonly string[] = [];
      let failed = true;
      let failure: unknown;
      let attemptedExecution = false;
      let delegatedToDialog = false;
      try {
        paths = selectionRequest("getLatest", nodes).paths;
        if (!paths.length)
          throw new Error(t("shell.no.target.selected.for.get"));
        const revision = { kind: "head" as const, value: "" };
        const plan = await backend.previewSync({
          paths: [...paths],
          revision,
          force: false,
          operationId,
        });
        const affected =
          plan.counts.added + plan.counts.updated + plan.counts.deleted;
        if (affected > getLatestConfirmThreshold) {
          delegatedToDialog = true;
          failed = false;
          dialogs.open({
            kind: "sync",
            nodes: nodes.map((node) => ({ ...node })),
            revisionMode: "head",
            scopeLabel: target.scopeLabel,
            source: source ?? (document.activeElement as HTMLElement | null),
          });
        } else {
          attemptedExecution = true;
          const result = await backend.syncLatest({
            paths: [...paths],
            revision,
            operationId,
          });
          if (result.outcome === "succeeded") failed = false;
          else failure = new Error(result.message);
        }
      } catch (cause) {
        failure = cause;
      } finally {
        if (running.current === operationId) {
          running.current = undefined;
          setOperation(undefined);
        }
      }
      if (delegatedToDialog) return;
      if (failed) {
        // Only a real sync attempt may have partially applied. A failed
        // preflight left the workspace untouched, so it must not invalidate.
        if (attemptedExecution)
          void invalidateData(commandActions.getLatest.effects, {
            connectionKey,
            affectedPaths: [...paths],
          }).catch(() => undefined);
        // Keep the target selected: the user needs it to retry, inspect or
        // resolve the failure. A failed Get Latest never clears selection.
        throw failure instanceof Error ? failure : new Error(String(failure));
      }
      void (async () => {
        await invalidateData(commandActions.getLatest.effects, {
          connectionKey,
          affectedPaths: [...paths],
        });
        if (epoch !== generation.current) return;
        if (target.type === "file" && latest.current.targetKey === targetKey) {
          const updated = await resolveSelection(
            nodes,
            connectionKey,
            runtime.context.cwd,
          );
          if (
            epoch === generation.current &&
            latest.current.targetKey === targetKey
          )
            onFocus({
              type: "file",
              node:
                updated.find((n) => nodeKey(n) === nodeKey(target.node)) ??
                updated.at(-1)!,
              nodes: updated,
            });
        }
      })().catch(() => {
        // Background refresh never turns a completed sync into a failure.
      });
      void workspaceCache
        .invalidateQueries({
          queryKey: ["local-path-capabilities", connectionKey],
        })
        .catch(() => undefined);
      return;
    }
    if (id === "rename" && target.type === "file") {
      dialogs.open({
        kind: "rename",
        node: { ...target.node },
        source: source ?? (document.activeElement as HTMLElement | null),
      });
      return;
    }
    if ((id === "lock" || id === "unlock") && target.type === "file") {
      dialogs.open({
        kind: "fileLock",
        nodes: nodes.map((node) => ({ ...node })),
        operation: id,
        source: source ?? (document.activeElement as HTMLElement | null),
      });
      return;
    }
    if (id === "submit" && target.type === "pending") {
      const ids = Number.isSafeInteger(target.id) ? [String(target.id)] : [];
      if (await customSubmit.handle(ids, target.selectedSubmitExpectation))
        return;
      dialogs.open({
        kind: "submit",
        id: target.id,
        count: target.count,
        source: source ?? (document.activeElement as HTMLElement | null),
      });
      return;
    }
    if (id === "cancel") {
      if (running.current && operation?.cancellable) {
        if (localDeleteRecord(running.current))
          cancelLocalDelete(running.current);
        else await backend.cancelOperation(running.current);
      }
      // Cancel is a request signal: it never implies a rollback or that nothing ran.
      return;
    }
    if (
      target.type === "file" &&
      ["diff", "history", "revgraph", "preview"].includes(id)
    ) {
      onReview(id as FilePageId, target.node);
      return;
    }
    if (target.type === "file" && (id === "reveal" || id === "openWith")) {
      const operationId = crypto.randomUUID();
      running.current = operationId;
      setOperation(
        startOperation(operationId, t("shell.waiting.for.system.dialog"), {
          kind: "other",
          cancellable: false,
          targetCount: 1,
        }),
      );
      try {
        await backend.openLocalPath({
          path: target.node.absolutePath,
          mode: id,
        });
      } finally {
        running.current = undefined;
        setOperation(undefined);
        void workspaceCache.invalidateQueries({
          queryKey: ["local-path-capabilities", connectionKey],
        });
      }
      return;
    }
    const actionEpoch = generation.current;
    const folders = nodes.some((n) => n.kind === "directory");
    let checkoutChangeId = 0;
    if (id === "checkout" && !preferences.ui.checkoutUseDefault) {
      const selectionKey = latest.current.targetKey;
      // The picker opens from the Pending snapshot. P4 is read first only when
      // there is no snapshot, or a stale one would skip the picker entirely.
      let changes = await cachedPendingChanges(runtime);
      const stale = !isFresh(pendingSnapshotKey(runtime));
      if (!changes || (stale && !changes.some((change) => change.id > 0))) {
        const queryOperationId = crypto.randomUUID();
        running.current = queryOperationId;
        setOperation(
          startOperation(
            queryOperationId,
            t("shell.loading.pending.changelists"),
            {
              // Reading pending changelists is a plain query, not a mutation.
              kind: "other",
              cancellable: true,
              targetCount: nodes.length,
            },
          ),
        );
        try {
          changes = await queryAllPendingChanges(queryOperationId);
        } finally {
          running.current = undefined;
          setOperation(undefined);
        }
      }
      if (
        actionEpoch !== generation.current ||
        latest.current.connectionKey !== connectionKey ||
        latest.current.targetKey !== selectionKey
      )
        return;
      if (changes.some((change) => change.id > 0)) {
        const choice = await dialogs.checkout({
          changes,
          count: nodes.length,
          recursive: folders,
          source: source ?? (document.activeElement as HTMLElement | null),
        });
        if (
          !choice ||
          actionEpoch !== generation.current ||
          latest.current.connectionKey !== connectionKey
        )
          return;
        checkoutChangeId = choice.changelistId;
        if (choice.alwaysUseDefault)
          preferences.setUi((ui) => ({ ...ui, checkoutUseDefault: true }));
      }
    }
    if ((id === "revert" || id === "revertUnchanged") && target.type === "file")
      nodes = revertTargets(
        nodes,
        readSnapshot<PendingSnapshot>(pendingSnapshotKey(runtime))?.data,
      );
    const mutation = ["add", "delete", "revert"].includes(id);
    if (
      ["delete", "revert"].includes(id) ||
      (mutation && (folders || nodes.length > 1))
    ) {
      const confirmed = await dialogs.confirm({
        operation: id as OperationConfirmation["operation"],
        nodes: nodes.map((node) => ({ ...node })),
        scopeLabel: target.type === "file" ? target.scopeLabel : undefined,
        source: source ?? (document.activeElement as HTMLElement | null),
      });
      if (!confirmed) return;
    }
    if (
      actionEpoch !== generation.current ||
      latest.current.connectionKey !== connectionKey
    )
      return;
    if (
      (id === "revert" || id === "revertUnchanged") &&
      target.type === "file"
    ) {
      startRevert(
        connectionKey,
        runtime,
        nodes,
        id,
        () =>
          actionEpoch === generation.current &&
          latest.current.connectionKey === connectionKey,
        target.wholeChangelistId,
      );
      return;
    }
    if (
      target.type === "file" &&
      id === "delete" &&
      nodes.length > 0 &&
      nodes.every((n) => n.state === "untracked" || n.state === "ignored")
    ) {
      const label = t("shell.deleting.local.files");
      startLocalDelete(
        connectionKey,
        runtime,
        nodes.map((n) => n.absolutePath).filter((p): p is string => !!p),
        () =>
          actionEpoch === generation.current &&
          latest.current.connectionKey === connectionKey,
        undefined,
        {
          onStarted: (operationId) => {
            running.current = operationId;
            setOperation(
              startOperation(operationId, label, {
                kind: "other",
                cancellable: true,
                targetCount: nodes.length,
              }),
            );
          },
          onSettled: (operationId) => {
            if (running.current === operationId) {
              running.current = undefined;
              setOperation(undefined);
            }
          },
        },
      );
      return;
    }
    if (
      target.type === "file" &&
      (id === "checkout" || id === "add" || id === "delete")
    ) {
      const request = {
        ...selectionRequest(id, nodes),
        ...(id === "checkout" ? { changelistId: checkoutChangeId } : {}),
      };
      startGenericFileAction(
        connectionKey,
        runtime,
        request,
        affectedPathAliases(request.paths, nodes) ?? request.paths,
        () =>
          actionEpoch === generation.current &&
          latest.current.connectionKey === connectionKey,
        undefined,
        targetKey,
      );
      return;
    }
    // Refresh is read-only bookkeeping and stays available while a mutation is
    // pending (commandPolicy). Run it without adopting the in-flight operation
    // identity, and treat a second concurrent refresh as a no-op.
    if (id === "refresh" && running.current) {
      if (operation?.kind === "refresh" || refreshInFlight.current) return;
      refreshInFlight.current = true;
      try {
        await refreshFileLockFacts(connectionKey);
        if (actionEpoch !== generation.current) return;
        await invalidateData(commandActions.refresh.effects, { connectionKey });
      } finally {
        refreshInFlight.current = false;
      }
      return;
    }
    if (running.current)
      throw new Error(t("shell.another.operation.is.running.try"));
    const operationId = crypto.randomUUID();
    const epoch = generation.current;
    running.current = operationId;
    const entry =
      groups.flat().find((item) => item.id === id) ??
      (id === "revertUnchanged"
        ? {
            zh: "shell.revert.unchanged",
            en: "shell.revert.unchanged",
          }
        : {
            zh: "shell.get.revision",
            en: "shell.get.revision",
          });
    setOperation(
      startOperation(
        operationId,
        tFor(zh ? "zh-CN" : "en-US", entry.zh as MsgKey),
        {
          // Each command names its host family instead of sharing one wide
          // "sync" bucket: a checkout that the host bounds at 660 s must not be
          // watched as a transfer, and a refresh must not inherit that bound.
          kind: commandFamily(id),
          cancellable: id !== "refresh",
          targetCount: nodes.length,
        },
      ),
    );
    let affectedPaths: readonly string[] | undefined;
    let feedbackCompleted = false;
    try {
      if (id === "refresh") await refreshFileLockFacts(connectionKey);

      // The mutation is now confirmed. Return the toolbar to its idle state
      // before cache invalidation and reconciliation, which are background work.
      running.current = undefined;
      setOperation(undefined);
      feedbackCompleted = true;
      void (async () => {
        await invalidateData(commandActions[id].effects, {
          connectionKey,
          affectedPaths,
        });
        if (epoch !== generation.current) return;
        if (target.type === "file" && latest.current.targetKey === targetKey) {
          const updated = await resolveSelection(
            nodes,
            connectionKey,
            runtime.context.cwd,
          );
          if (
            epoch === generation.current &&
            latest.current.targetKey === targetKey
          )
            onFocus({
              type: "file",
              node:
                updated.find((n) => nodeKey(n) === nodeKey(target.node)) ??
                updated.at(-1)!,
              nodes: updated,
            });
        } else if (
          target.type === "pending" &&
          latest.current.targetKey === targetKey
        )
          onFocus({ type: "none" });
      })().catch(() => {
        // A failed background refresh must not turn a confirmed P4 mutation
        // into a failed action. The visible query retains its prior data.
      });
      void workspaceCache
        .invalidateQueries({
          queryKey: ["local-path-capabilities", connectionKey],
        })
        .catch(() => undefined);
    } catch (cause) {
      // A batch can partially succeed before P4 reports an error or cancellation.
      void invalidateData(commandActions[id].effects, {
        connectionKey,
        affectedPaths,
      }).catch(() => undefined);
      if (
        epoch === generation.current &&
        latest.current.targetKey === targetKey
      )
        onFocus({ type: "none" });
      throw new Error(
        `${String(cause)}${id !== "refresh" ? "\n" + t("shell.this.operation.may.have.partially") : ""}`,
      );
    } finally {
      if (!feedbackCompleted) {
        running.current = undefined;
        setOperation(undefined);
        void workspaceCache
          .invalidateQueries({
            queryKey: ["local-path-capabilities", connectionKey],
          })
          .catch(() => undefined);
      }
    }
  }
  useEffect(() => {
    registerCommand((id, snapshot, source) =>
      attempt(() => execute(id, snapshot, source)),
    );
    return () => registerCommand(undefined);
  });
  const ready = runtime.p4Version !== "loading";
  return (
    <section
      className="command-center"
      {...menu("T07", () => ({
        "显示/隐藏工具文字": {
          ...action(() =>
            preferences.setUi((v) => ({ ...v, toolbarText: !v.toolbarText })),
          ),
          checked: preferences.ui.toolbarText,
        },
        打开界面设置: action(() => openPage("settings")),
      }))}
      aria-label={t("shell.address.and.actions")}
    >
      {dialogs.element}
      <form
        className="global-address"
        onSubmit={(event) => {
          event.preventDefault();
          attempt(() => navigate(address));
        }}
      >
        <ListRestart size={16} />
        <span className="address-scope">
          {target.type === "pending" || target.type === "submitted"
            ? `CL ${target.id || "default"}`
            : target.type === "file"
              ? target.node.kind === "directory"
                ? "FOLDER"
                : "FILE"
              : "LOCATION"}
        </span>
        <input
          ref={addressInput}
          aria-label={t("shell.address")}
          placeholder={t("shell.local.depot.path.enter.or")}
          value={address}
          onChange={(e) => {
            navigation.current++;
            setLocating(false);
            setAddress(e.target.value);
          }}
          onPaste={(e) => {
            e.preventDefault();
            attempt(() => navigate(e.clipboardData.getData("text/plain")));
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              navigation.current++;
              setLocating(false);
              setAddress(targetPath);
            }
          }}
          disabled={!ready}
        />
        {locating && <LoaderCircle size={15} className="spin" />}
        <button
          type="submit"
          title={t("shell.go")}
          aria-label={t("shell.go")}
          disabled={!ready || !address.trim()}
        >
          <ArrowRight size={16} />
        </button>
        <button
          type="button"
          title={t("shell.copy.current.target.address")}
          aria-label={t("shell.copy.address")}
          disabled={!targetPath}
          onClick={() =>
            attempt(async () => {
              await writeClipboardText(targetPath);
            })
          }
        >
          <Copy size={15} />
        </button>
        <button
          type="button"
          title={t("shell.paste.clean.and.navigate")}
          aria-label={t("shell.paste.address")}
          disabled={!ready}
          onClick={() =>
            attempt(async () => {
              await navigate(await readClipboardText());
            })
          }
        >
          <ClipboardPaste size={15} />
        </button>
      </form>
      <div className="command-toolbar-row">
        <div
          className="global-tools"
          role="toolbar"
          aria-label={t("shell.object.actions")}
        >
          {groups.map((group, index) => (
            <div className="command-group" key={index}>
              {group.map(({ id, icon: Icon, zh: cnKey }) => {
                const cn = tFor(zh ? "zh-CN" : "en-US", cnKey as MsgKey);
                const reason = !ready
                  ? t("shell.connecting")
                  : commandReason(
                      id,
                      target,
                      !!operation,
                      runtime.mode === "tauri",
                      zh,
                      localCapabilities,
                    );
                return (
                  <span
                    key={id}
                    title={
                      reason ||
                      (id === "refresh"
                        ? t("shell.refresh.files.and.pending.lists")
                        : cn)
                    }
                  >
                    <button
                      aria-label={cn}
                      aria-description={reason}
                      disabled={!!reason}
                      className={
                        id === "getLatest" || id === "preview"
                          ? "command-accent"
                          : ""
                      }
                      onClick={() => attempt(() => execute(id))}
                    >
                      <Icon size={17} />
                      <span>{cn}</span>
                    </button>
                  </span>
                );
              })}
            </div>
          ))}
        </div>
        {navigationActions && (
          <div className="command-navigation-slot">{navigationActions}</div>
        )}
        <button
          type="button"
          className="command-settings"
          aria-current={settingsActive ? "page" : undefined}
          title={t("shell.settings")}
          aria-label={t("shell.settings")}
          onClick={() => openPage("settings")}
        >
          <Settings size={17} aria-hidden="true" />
          <span>{t("shell.settings")}</span>
        </button>
      </div>
      {(error || notice) && (
        <div className="command-notices">
          {error && (
            <div className="command-notice command-notice-error" role="alert">
              <span className="command-notice-message">{error}</span>
              <button
                type="button"
                aria-label={t("shell.dismiss.error")}
                title={t("shell.dismiss")}
                onClick={() => setError("")}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          )}
          {notice && (
            <div className="command-notice command-notice-warning" role="alert">
              <span className="command-notice-message">{notice}</span>
              <button
                type="button"
                aria-label={t("shell.dismiss.notice")}
                title={t("shell.dismiss")}
                onClick={() => setNotice("")}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
