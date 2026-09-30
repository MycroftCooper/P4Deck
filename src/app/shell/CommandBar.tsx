import { useEffect, useRef, useState } from "react";
import { fileActionFeedback } from "./fileActionFeedback";
import { useCommandDialogs } from "../dialogs/useCommandDialogs";
import type { OperationConfirmation } from "../dialogs/OperationConfirmDialog";
import {
  ArrowRight,
  AlertCircle,
  Check,
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
  Send,
  Square,
  SquarePen,
  AppWindow,
  Columns2,
} from "lucide-react";
import { selectionRequest } from "../../features/files/selectionCommands";
import { resolveSelection } from "../../features/files/resolveSelection";
import { nodeKey } from "../../features/files/selection";
import { backend } from "../../infrastructure/backend";
import {
  readClipboardText,
  writeClipboardText,
} from "../../infrastructure/clipboard";
import type { RuntimeInfo, WorkspaceNode } from "../../shared/contracts/types";
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
    { id: "submit", icon: Send, zh: "提交 CL", en: "Submit CL" },
  ],
  [
    { id: "checkout", icon: SquarePen, zh: "签出", en: "Checkout" },
    { id: "add", icon: FilePlus2, zh: "添加", en: "Add" },
    { id: "delete", icon: FileX2, zh: "标记删除", en: "Mark delete" },
    { id: "revert", icon: RotateCcw, zh: "还原", en: "Revert" },
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
  [{ id: "cancel", icon: Square, zh: "取消", en: "Cancel" }],
];
interface Props {
  onBusyChange(value: boolean): void;
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
  onReview(page: FilePageId, node: WorkspaceNode): void;
}
export function CommandBar({
  zh,
  runtime,
  connectionKey,
  target,
  targetError,
  onNavigate,
  onFocus,
  onReview,
  registerCommand,
  onBusyChange,
}: Props) {
  const menu = useContextMenu();
  const { preferences, openPage } = useMenuEnvironment();
  const localCapabilities = useLocalPathCapabilities(
    target,
    runtime.mode === "tauri",
    connectionKey,
  );
  const nodes = target.type === "file" ? (target.nodes ?? [target.node]) : [];
  const targetPath =
    target.type === "file"
      ? target.node.absolutePath || target.node.depotPath || ""
      : "";
  const targetKey = commandTargetKey(target);
  const [address, setAddress] = useState(targetPath);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [locating, setLocating] = useState(false);
  const dialogs = useCommandDialogs(connectionKey, runtime.context.client, zh);
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
  const running = useRef<string | undefined>(undefined);
  const navigation = useRef(0);
  const generation = useRef(0);
  const latest = useRef({ connectionKey, targetPath, targetKey });
  latest.current = { connectionKey, targetPath, targetKey };
  useEffect(() => {
    setAddress(targetPath);
    setNotice("");
    setError("");
    navigation.current++;
    setLocating(false);
  }, [targetPath, targetKey]);
  useEffect(() => {
    navigation.current++;
    generation.current++;
    setError("");
    setNotice("");
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
    setNotice("");
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
    const reason = commandReason(
      id,
      target,
      !!running.current || dialogs.pending,
      runtime.mode === "tauri",
      zh,
      capabilities,
    );
    if (reason) throw new Error(reason);
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
    if (id === "rename" && target.type === "file") {
      dialogs.open({
        kind: "rename",
        node: { ...target.node },
        source: source ?? (document.activeElement as HTMLElement | null),
      });
      return;
    }
    if (id === "submit" && target.type === "pending") {
      dialogs.open({
        kind: "submit",
        id: target.id,
        count: target.count,
        source: source ?? (document.activeElement as HTMLElement | null),
      });
      return;
    }
    if (id === "cancel") {
      if (running.current && operation?.cancellable)
        await backend.cancelOperation(running.current);
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
    const revisionEpoch = generation.current;
    const folders = nodes.some((n) => n.kind === "directory");
    const mutation = [
      "getLatest",
      "getRevision",
      "checkout",
      "add",
      "delete",
      "revert",
    ].includes(id);
    if (
      ["delete", "revert"].includes(id) ||
      (mutation && id !== "getRevision" && (folders || nodes.length > 1))
    ) {
      const confirmed = await dialogs.confirm({
        operation: id as OperationConfirmation["operation"],
        nodes: nodes.map((node) => ({ ...node })),
        scopeLabel: target.type === "file" ? target.scopeLabel : undefined,
        source: source ?? (document.activeElement as HTMLElement | null),
      });
      if (!confirmed) return;
    }
    const revision =
      id === "getRevision"
        ? await dialogs.getRevision({
            nodes: nodes.map((node) => ({ ...node })),
            scopeLabel: target.type === "file" ? target.scopeLabel : undefined,
            source: source ?? (document.activeElement as HTMLElement | null),
          })
        : undefined;
    if (id === "getRevision" && !revision) return;
    if (
      revisionEpoch !== generation.current ||
      latest.current.connectionKey !== connectionKey
    )
      return;
    if (running.current)
      throw new Error(
        zh
          ? "另一个操作正在运行，请稍后重试"
          : "Another operation is running; try again later",
      );
    const operationId = crypto.randomUUID();
    const epoch = generation.current;
    running.current = operationId;
    const entry = groups.flat().find((item) => item.id === id) ?? {
      zh: "获取指定版本",
      en: "Get revision",
    };
    setOperation({
      id: operationId,
      label: zh ? entry.zh : entry.en,
      cancellable: id !== "refresh",
    });
    let completionMessage = zh ? "刷新完成" : "Refresh completed";
    try {
      if (id !== "refresh") {
        if (
          target.type === "file" &&
          [
            "getLatest",
            "getRevision",
            "checkout",
            "add",
            "delete",
            "revert",
          ].includes(id)
        ) {
          const result = await backend.performFileAction({
            ...selectionRequest(
              id as
                | "getLatest"
                | "getRevision"
                | "checkout"
                | "add"
                | "delete"
                | "revert",
              nodes,
              operationId,
            ),
            revision: revision ?? undefined,
          });
          const feedback = fileActionFeedback(result, zh);
          if (feedback.failed) throw new Error(feedback.message);
          completionMessage = feedback.message;
        }
      }
      await workspaceCache.invalidateQueries({
        queryKey: ["workspace-files", connectionKey],
      });
      await workspaceCache.invalidateQueries({
        queryKey: ["depot-files", connectionKey],
      });
      window.dispatchEvent(new Event("p4deck:pending-refresh"));
      if (epoch !== generation.current) return;
      if (target.type === "file" && latest.current.targetKey === targetKey) {
        try {
          const updated = await resolveSelection(
            nodes,
            connectionKey,
            runtime.context.cwd,
            true,
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
        } catch {
          if (
            epoch === generation.current &&
            latest.current.targetKey === targetKey
          )
            onFocus({ type: "none" });
        }
      } else if (
        target.type === "pending" &&
        latest.current.targetKey === targetKey
      )
        onFocus({ type: "none" });
      if (epoch === generation.current) setNotice(completionMessage);
    } catch (cause) {
      // A batch can partially succeed before P4 reports an error or cancellation.
      await Promise.all([
        workspaceCache.invalidateQueries({
          queryKey: ["workspace-files", connectionKey],
        }),
        workspaceCache.invalidateQueries({
          queryKey: ["depot-files", connectionKey],
        }),
      ]);
      window.dispatchEvent(new Event("p4deck:pending-refresh"));
      if (
        epoch === generation.current &&
        latest.current.targetKey === targetKey
      )
        onFocus({ type: "none" });
      throw new Error(
        `${String(cause)}${id !== "refresh" ? "\n" + (zh ? "此操作可能已部分执行；失败或取消不会自动回滚，请检查日志和文件状态。" : "This operation may have partially applied. Failure or cancellation does not roll back changes; inspect logs and file state.") : ""}`,
      );
    } finally {
      running.current = undefined;
      setOperation(undefined);
      void workspaceCache.invalidateQueries({
        queryKey: ["local-path-capabilities", connectionKey],
      });
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
      {nodes.length > 1 && (
        <div className="selection-summary" role="status">
          {zh
            ? `已选择 ${nodes.length} 项 · 文件 ${nodes.filter((n) => n.kind === "file").length} / 目录 ${nodes.filter((n) => n.kind === "directory").length} · 地址栏显示主目标`
            : `${nodes.length} selected · Address shows primary target`}
        </div>
      )}
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
              setNotice(zh ? "地址已复制" : "Address copied");
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
                  : id === "cancel" && !operation?.cancellable
                    ? zh
                      ? "没有可取消的工具栏 P4 任务"
                      : "No cancellable toolbar P4 operation"
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
      </div>
      {(error || targetError || notice || operation) && (
        <div
          className={`command-feedback ${error || targetError ? "is-error" : ""}`}
          role={error || targetError ? "alert" : "status"}
        >
          {operation ? (
            <>
              <LoaderCircle size={13} className="spin" />
              {operation.label}
              <progress max={100} value={operation.progress} />
            </>
          ) : (
            <>
              {error || targetError ? (
                <AlertCircle size={13} />
              ) : (
                <Check size={13} />
              )}
              <span className="command-feedback-message">
                {error || targetError || notice}
              </span>
            </>
          )}
          {error && (
            <button
              aria-label={zh ? "关闭错误提示" : "Dismiss error"}
              onClick={() => setError("")}
            >
              ×
            </button>
          )}
        </div>
      )}
    </section>
  );
}
