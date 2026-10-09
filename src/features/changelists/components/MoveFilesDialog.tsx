import { useEffect, useRef, useState } from "react";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { TargetList } from "../../../app/dialogs/TargetList";
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
    origins: request.origins ? { ...request.origins } : undefined,
    paths: [...new Set(request.paths)],
    connectionKey,
    changes: changes.map((change) => ({
      id: change.id,
      description: change.description,
      status: change.status,
    })),
  }));
  const [filter, setFilter] = useState("");
  const [target, setTarget] = useState<number | undefined>(request.target);
  const [preflight, setPreflight] = useState<MoveFilesPreflight>();
  const [result, setResult] = useState<MoveFilesResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const activeOperation = useRef<string | undefined>(undefined);
  const staleConnection = snapshot.connectionKey !== connectionKey;
  const originIds = [
    ...new Set(
      snapshot.paths.map((path) => snapshot.origins?.[path] ?? snapshot.from),
    ),
  ];
  const effectivePaths = snapshot.paths.filter(
    (path) =>
      target === undefined ||
      (snapshot.origins?.[path] ?? snapshot.from) !== target,
  );
  const available = snapshot.changes.filter(
    (change) =>
      change.status === "pending" &&
      (originIds.length > 1 || change.id !== snapshot.from),
  );
  const matches = available.filter((change) =>
    `${change.id === 0 ? "default" : change.id} ${change.description}`
      .toLowerCase()
      .includes(filter.trim().toLowerCase()),
  );
  const name = (id: number) => (id === 0 ? "Default" : `CL ${id}`);
  const fromLabel = originIds.map(name).join(", ");

  useEffect(() => {
    if (staleConnection) {
      generation.current += 1;
      if (activeOperation.current)
        void backend.cancelOperation(activeOperation.current);
      activeOperation.current = undefined;
      setBusy(false);
      setPreflight(undefined);
      setError(
        tr(
          "连接或 Workspace 已改变，请关闭后重新选择文件。",
          "Connection or workspace changed. Close and select the files again.",
        ),
      );
    }
    return () => void ++generation.current;
  }, [staleConnection]);

  const runCheck = () => {
    if (
      target === undefined ||
      !effectivePaths.length ||
      busy ||
      staleConnection
    )
      return;
    const epoch = ++generation.current;
    const operationId = crypto.randomUUID();
    activeOperation.current = operationId;
    setBusy(true);
    setError("");
    setResult(undefined);
    void check({
      targetChangeId: target,
      depotPaths: effectivePaths,
      operationId,
    })
      .then((value) => {
        if (epoch === generation.current) setPreflight(value);
      })
      .catch((cause) => {
        if (epoch === generation.current) setError(String(cause));
      })
      .finally(() => {
        if (epoch === generation.current) {
          activeOperation.current = undefined;
          setBusy(false);
        }
      });
  };

  const confirm = () => {
    if (!preflight?.ready || !preflight.token || busy || staleConnection)
      return;
    const epoch = generation.current;
    const operationId = crypto.randomUUID();
    activeOperation.current = operationId;
    setBusy(true);
    setError("");
    void execute({
      token: preflight.token,
      target: preflight.target,
      operationId,
    })
      .then(async (value) => {
        if (epoch !== generation.current) return;
        setResult(value);
        setPreflight(undefined);
        await onResult?.(value);
        if (value.outcome === "succeeded") onDismiss();
      })
      .catch((cause) => {
        if (epoch === generation.current) setError(String(cause));
      })
      .finally(() => {
        if (epoch === generation.current) {
          activeOperation.current = undefined;
          setBusy(false);
        }
      });
  };

  const cancelActive = () => {
    const operationId = activeOperation.current;
    if (operationId) void backend.cancelOperation(operationId);
  };

  return (
    <Dialog
      title={tr("移动文件到 CL", "Move files to changelist")}
      description={tr(
        "拖放与键盘入口共用同一服务：先冻结选择并预检，再逐项 reopen 与验证。",
        "Drag/drop and keyboard entry share one service: freeze and preflight, then reopen and verify each file.",
      )}
      source={snapshot.source}
      zh={zh}
      busy={busy}
      onRequestClose={() => !busy && onDismiss()}
      footer={
        <>
          <button
            disabled={busy && !activeOperation.current}
            onClick={busy ? cancelActive : onDismiss}
          >
            {busy ? tr("取消操作", "Cancel operation") : tr("关闭", "Close")}
          </button>
          <button
            className="primary"
            disabled={
              busy ||
              staleConnection ||
              target === undefined ||
              !effectivePaths.length
            }
            onClick={runCheck}
          >
            {busy && !preflight
              ? tr("检查中…", "Checking…")
              : tr("预检（不执行）", "Preflight (no execution)")}
          </button>
          {preflight?.ready && (
            <button
              className="primary"
              disabled={busy || Date.now() >= preflight.expiresAt}
              onClick={confirm}
            >
              {busy ? tr("移动中…", "Moving…") : tr("确认移动", "Confirm move")}
            </button>
          )}
        </>
      }
    >
      <div className="workflow-context">
        {client} · {tr("来源", "From")} {fromLabel} · {snapshot.paths.length}{" "}
        {tr("个文件", "files")}
      </div>
      {staleConnection && <DialogNotice error>{error}</DialogNotice>}
      <TargetList
        paths={effectivePaths}
        label={tr("将移动的文件", "Files to move")}
      />
      {effectivePaths.length < snapshot.paths.length && (
        <DialogNotice>
          {tr(
            "已跳过本来就在目标 CL 的文件：",
            "Files already in the target CL are skipped: ",
          )}
          {snapshot.paths.length - effectivePaths.length}
        </DialogNotice>
      )}
      {!snapshot.paths.length && (
        <DialogNotice error>
          {tr("没有选择文件。", "No files selected.")}
        </DialogNotice>
      )}
      <label>
        {tr("筛选目标 CL", "Filter target changelists")}
        <input
          autoFocus
          data-dialog-autofocus
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={tr("编号或描述", "Number or description")}
        />
      </label>
      <label>
        {tr("目标 CL", "Target changelist")}
        <select
          value={target ?? ""}
          onChange={(event) => {
            generation.current += 1;
            setTarget(
              event.target.value === ""
                ? undefined
                : Number(event.target.value),
            );
            setPreflight(undefined);
            setResult(undefined);
            setError("");
          }}
        >
          <option value="">{tr("请选择目标 CL", "Choose a target")}</option>
          {target !== undefined &&
            !matches.some((change) => change.id === target) && (
              <option value={target}>
                {name(target)} ·{" "}
                {tr("已选择，被筛选隐藏", "Selected, filtered out")}
              </option>
            )}
          {matches.map((change) => (
            <option key={change.id} value={change.id}>
              {name(change.id)} · {change.description}
            </option>
          ))}
        </select>
      </label>
      <label>
        {tr("离屏目标编号", "Off-screen target ID")}
        <input
          type="number"
          min={0}
          value={target ?? ""}
          onChange={(event) => {
            generation.current += 1;
            const value = event.target.value;
            setTarget(value === "" ? undefined : Number(value));
            setPreflight(undefined);
            setResult(undefined);
            setError("");
          }}
          placeholder={tr("0 表示 Default", "0 means Default")}
        />
      </label>
      <p className="workflow-context">
        {tr(
          "拖放仅接受当前已挂载的可见卡片；滚动会自动挂载新目标。键盘或右键入口可在此直接输入未挂载的 CL 编号。",
          "Drop accepts mounted visible cards; scrolling mounts additional targets. Keyboard and context-menu flows can enter an unmounted CL ID here.",
        )}
      </p>
      {target !== undefined && (
        <p className="workflow-context">
          {fromLabel} → {name(target)} · {effectivePaths.length}{" "}
          {tr("个文件", "files")}
        </p>
      )}
      {preflight && (
        <>
          <DialogNotice error={!preflight.ready}>
            {preflight.ready
              ? tr(
                  `预检通过：${preflight.files.length} 个文件。`,
                  `Preflight ready: ${preflight.files.length} file(s).`,
                )
              : tr(
                  `预检阻止：${preflight.blockers.length} 项。`,
                  `Preflight blocked: ${preflight.blockers.length} issue(s).`,
                )}
          </DialogNotice>
          {preflight.blockers.map((issue, index) => (
            <DialogNotice key={`${issue.code}-${index}`} error>
              {issue.message}
              {issue.paths.length ? ` · ${issue.paths.join(", ")}` : ""}
            </DialogNotice>
          ))}
        </>
      )}
      {result && (
        <DialogNotice error={result.outcome !== "succeeded"}>
          {result.message}
          {result.files
            .filter((file) => file.state !== "succeeded")
            .map((file) => `\n${file.depotPath}: ${file.message}`)}
        </DialogNotice>
      )}
      {error && !staleConnection && <DialogNotice error>{error}</DialogNotice>}
    </Dialog>
  );
}
