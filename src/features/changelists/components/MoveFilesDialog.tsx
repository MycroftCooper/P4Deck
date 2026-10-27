import { useEffect, useRef, useState } from "react";
import { AlertCircle, ChevronRight, LoaderCircle } from "lucide-react";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { backend } from "../../../infrastructure/backend";
import type {
  MoveFilesPreflight,
  MoveFilesPreflightRequest,
  MoveFilesResult,
  PendingChange,
  WorkflowConfirmation,
} from "../../../shared/contracts/types";

export interface MoveFilesRequest {
  from: number;
  origins?: Record<string, number>;
  paths: string[];
  target?: number;
  source: HTMLElement | null;
}

/** Drops already name a destination; menu entry only needs a destination picker. */
export function MoveFilesDialog({
  request,
  changes,
  client,
  connectionKey,
  zh,
  onDismiss,
  onResult,
  check = (value) => backend.preflightMoveFiles(value),
  execute = (value) => backend.confirmMoveFiles(value),
}: {
  request: MoveFilesRequest;
  changes: PendingChange[];
  client: string;
  connectionKey: string;
  zh: boolean;
  onDismiss(): void;
  onResult?(result: MoveFilesResult): Promise<void> | void;
  check?(request: MoveFilesPreflightRequest): Promise<MoveFilesPreflight>;
  execute?(confirmation: WorkflowConfirmation): Promise<MoveFilesResult>;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [snapshot] = useState(() => ({
    ...request,
    paths: [...new Set(request.paths)],
    origins: { ...request.origins },
    connectionKey,
    changes: changes.map(({ id, description, status }) => ({
      id,
      description,
      status,
    })),
  }));
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const activeOperation = useRef<string | undefined>(undefined);
  const running = useRef(false);
  const started = useRef(false);
  const binding = useRef(connectionKey);
  binding.current = connectionKey;
  const staleConnection = snapshot.connectionKey !== connectionKey;
  const direct = snapshot.target !== undefined;
  const name = (id: number) => (id === 0 ? "Default" : `CL ${id}`);
  const pathsFor = (target: number) =>
    snapshot.paths.filter(
      (path) => (snapshot.origins[path] ?? snapshot.from) !== target,
    );
  const available = snapshot.changes.filter(
    (change) =>
      change.status === "pending" &&
      pathsFor(change.id).length &&
      `${change.id === 0 ? "default" : change.id} ${change.description}`
        .toLowerCase()
        .includes(filter.trim().toLowerCase()),
  );

  useEffect(() => {
    if (staleConnection) {
      setBusy(false);
      running.current = false;
      activeOperation.current = undefined;
    }
    return () => {
      generation.current++;
      if (activeOperation.current)
        void backend.cancelOperation(activeOperation.current).catch(() => {});
    };
  }, [connectionKey]);

  async function move(target: number) {
    if (
      running.current ||
      staleConnection ||
      binding.current !== snapshot.connectionKey
    )
      return;
    const paths = pathsFor(target);
    if (!paths.length) {
      onDismiss();
      return;
    }
    running.current = true;
    const epoch = generation.current;
    const current = () =>
      epoch === generation.current &&
      binding.current === snapshot.connectionKey;
    setBusy(true);
    setError("");
    try {
      activeOperation.current = crypto.randomUUID();
      const plan = await check({
        targetChangeId: target,
        depotPaths: paths,
        operationId: activeOperation.current,
      });
      if (!current()) return;
      if (!plan.ready || !plan.token) {
        throw new Error(
          plan.blockers.map((issue) => issue.message).join("\n") ||
            tr(
              "这些文件暂时无法移动，请刷新后重试。",
              "These files cannot be moved. Refresh and try again.",
            ),
        );
      }
      activeOperation.current = crypto.randomUUID();
      const result = await execute({
        token: plan.token,
        target: plan.target,
        operationId: activeOperation.current,
      });
      if (!current()) return;
      void Promise.resolve(onResult?.(result)).catch(() => undefined);
      if (result.outcome === "succeeded") onDismiss();
      else {
        setError(
          [
            result.message,
            result.refreshError,
            ...result.files
              .filter((file) => file.state !== "succeeded")
              .map((file) => `${file.depotPath}: ${file.message}`),
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
    } catch (cause) {
      if (current()) setError(String(cause));
    } finally {
      if (current()) {
        activeOperation.current = undefined;
        running.current = false;
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    const epoch = generation.current;
    if (snapshot.target === undefined || staleConnection) return;
    queueMicrotask(() => {
      if (epoch !== generation.current || started.current) return;
      started.current = true;
      void move(snapshot.target!);
    });
  }, [snapshot, staleConnection]);

  const message = staleConnection
    ? tr(
        "连接或工作区已改变，请重新选择文件。",
        "Connection or workspace changed. Select the files again.",
      )
    : error;
  if (direct)
    return message ? (
      <div className="move-feedback is-error" role="alert">
        <AlertCircle size={16} />
        <span>{message}</span>
        <button
          onClick={onDismiss}
          aria-label={tr("关闭移动提示", "Dismiss move message")}
        >
          ×
        </button>
      </div>
    ) : null;

  return (
    <Dialog
      title={tr("移动到 CL", "Move to changelist")}
      description={tr(
        "选择目标 CL 即可移动所选文件。",
        "Choose a destination to move the selected files.",
      )}
      source={snapshot.source}
      zh={zh}
      busy={busy}
      onRequestClose={() => !busy && onDismiss()}
      footer={
        <button disabled={busy} onClick={onDismiss}>
          {tr("取消", "Cancel")}
        </button>
      }
    >
      <div className="workflow-context">
        {client} · {snapshot.paths.length} {tr("个文件", "files")}
      </div>
      <label>
        {tr("筛选目标 CL", "Filter target changelists")}
        <input
          autoFocus
          data-dialog-autofocus
          value={filter}
          disabled={busy || staleConnection}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={tr("编号或描述", "Number or description")}
        />
      </label>
      <div className="move-destinations">
        {available.map((change) => (
          <button
            key={change.id}
            disabled={busy || staleConnection}
            onClick={() => void move(change.id)}
          >
            <strong>{name(change.id)}</strong>
            <span>{change.description}</span>
            <ChevronRight size={16} />
          </button>
        ))}
      </div>
      {!available.length && (
        <DialogNotice>
          {tr("没有匹配的目标 CL。", "No matching changelists.")}
        </DialogNotice>
      )}
      {busy && (
        <span className="move-running" role="status">
          <LoaderCircle className="spin" size={16} />
          {tr("正在移动…", "Moving…")}
        </span>
      )}
      {message && <DialogNotice error>{message}</DialogNotice>}
    </Dialog>
  );
}
