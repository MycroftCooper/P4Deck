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
import type { FilePageId } from "../panels";
import {
  commandReason,
  commandTargetKey,
  type CommandId,
  type CommandTarget,
} from "./commandPolicy";

const groups: {
  id: CommandId;
  icon: typeof RefreshCw;
  zh: string;
  en: string;
}[][] = [
  [
    { id: "refresh", icon: RefreshCw, zh: "刷新", en: "Refresh" },
    { id: "getLatest", icon: CloudDownload, zh: "获取最新", en: "Get latest" },
  ],
  [
    { id: "checkout", icon: SquarePen, zh: "签出", en: "Checkout" },
    { id: "add", icon: FilePlus2, zh: "添加", en: "Add" },
    { id: "delete", icon: FileX2, zh: "标记删除", en: "Mark delete" },
    { id: "revert", icon: RotateCcw, zh: "还原", en: "Revert" },
    { id: "lock", icon: LockKeyhole, zh: "锁定", en: "Lock" },
    { id: "unlock", icon: LockKeyholeOpen, zh: "解锁", en: "Unlock" },
  ],
  [
    { id: "diff", icon: Columns2, zh: "差异", en: "Diff" },
    { id: "history", icon: History, zh: "历史", en: "History" },
    { id: "revgraph", icon: GitBranch, zh: "修订图", en: "Revgraph" },
    { id: "preview", icon: Eye, zh: "文件预览", en: "Preview" },
  ],
  [
    { id: "reveal", icon: FolderOpen, zh: "系统中定位", en: "Reveal" },
    { id: "openWith", icon: AppWindow, zh: "其他软件打开", en: "Open with…" },
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
  const [operation, setOperation] = useState<{
    id: string;
    label: string;
    progress?: number;
    cancellable: boolean;
  }>();
  useEffect(() => {
    onBusyChange(!!operation || dialogs.pending);
    return () => onBusyChange(false);
  }, [!!operation, dialogs.pending, onBusyChange]);
  useEffect(() => {
    setAddress(targetPath);
    navigation.current++;
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
    setError("");
    setLocating(false);
  }, [connectionKey]);
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
      throw new Error(
        zh
          ? "连接已改变，请重新选择目标"
          : "Connection changed; select the target again",
      );
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
    if (
      (id === "getLatest" || id === "getRevision") &&
      target.type === "file"
    ) {
      dialogs.open({
        kind: "sync",
        nodes: nodes.map((node) => ({ ...node })),
        revisionMode: id === "getRevision" ? "choose" : "head",
        scopeLabel: target.scopeLabel,
        source: source ?? (document.activeElement as HTMLElement | null),
      });
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
      setOperation({
        id: operationId,
        label: zh ? "等待系统窗口" : "Waiting for system dialog",
        cancellable: false,
      });
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
        setOperation({
          id: queryOperationId,
          label: zh ? "读取待提交 CL" : "Loading pending changelists",
          cancellable: true,
        });
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
      const label = zh ? "正在删除本地文件…" : "Deleting local files…";
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
            setOperation({ id: operationId, label, cancellable: true });
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
    if (running.current)
      throw new Error(
        zh
          ? "另一个操作正在运行，请稍后重试"
          : "Another operation is running; try again later",
      );
    const operationId = crypto.randomUUID();
    const epoch = generation.current;
    running.current = operationId;
    const entry =
      groups.flat().find((item) => item.id === id) ??
      (id === "revertUnchanged"
        ? {
            zh: "还原未更改",
            en: "Revert unchanged",
          }
        : {
            zh: "获取指定版本",
            en: "Get revision",
          });
    setOperation({
      id: operationId,
      label: zh ? entry.zh : entry.en,
      cancellable: id !== "refresh",
    });
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
        `${String(cause)}${id !== "refresh" ? "\n" + (zh ? "此操作可能已部分执行；失败或取消不会自动回滚，请检查日志和文件状态。" : "This operation may have partially applied. Failure or cancellation does not roll back changes; inspect logs and file state.") : ""}`,
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
      aria-label={zh ? "地址和操作" : "Address and actions"}
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
          aria-label={zh ? "统一地址栏" : "Address"}
          placeholder={
            zh
              ? "输入本地 / depot 地址，Enter 跳转；粘贴自动跳转"
              : "Local / depot path · Enter or paste to navigate"
          }
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
          title={zh ? "跳转" : "Go"}
          aria-label={zh ? "跳转" : "Go"}
          disabled={!ready || !address.trim()}
        >
          <ArrowRight size={16} />
        </button>
        <button
          type="button"
          title={zh ? "复制当前对象的地址" : "Copy current target address"}
          aria-label={zh ? "复制地址" : "Copy address"}
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
          title={zh ? "粘贴、清理并跳转" : "Paste, clean and navigate"}
          aria-label={zh ? "粘贴地址" : "Paste address"}
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
          aria-label={zh ? "对象操作" : "Object actions"}
        >
          {groups.map((group, index) => (
            <div className="command-group" key={index}>
              {group.map(({ id, icon: Icon, zh: cn, en }) => {
                const reason = !ready
                  ? zh
                    ? "正在连接"
                    : "Connecting"
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
                        ? zh
                          ? "刷新文件与待提交列表（不会自动同步）"
                          : "Refresh files and pending lists (does not sync)"
                        : zh
                          ? cn
                          : en)
                    }
                  >
                    <button
                      aria-label={zh ? cn : en}
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
                      <span>{zh ? cn : en}</span>
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
          title={zh ? "设置" : "Settings"}
          aria-label={zh ? "设置" : "Settings"}
          onClick={() => openPage("settings")}
        >
          <Settings size={17} aria-hidden="true" />
          <span>{zh ? "设置" : "Settings"}</span>
        </button>
      </div>
    </section>
  );
}
