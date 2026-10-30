import { invalidateShelfObservations } from "../../actions/shelfObservation";
import { useContext, useEffect, useRef, useState } from "react";
import { MenuEnvironment } from "../../../app/context-menu/environment";
import { DeleteShelfDialog } from "./DeleteShelfDialog";
import { shelfIdentity } from "../deleteShelfTask";
import { startShelveDirect } from "../shelveDirectTask";
import { backend } from "../../../infrastructure/backend";
import type {
  ShelfPreflight,
  ShelfPreflightRequest,
  WorkflowConfirmation,
  WorkflowResult,
} from "../../../shared/contracts";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import {
  PreflightStatus,
  type PreflightState,
} from "../../../app/dialogs/PreflightStatus";
import { TargetList } from "../../../app/dialogs/TargetList";
import type { ConnectionSnapshot } from "../../companySubmit/model";
import {
  lookupWorkflowAction,
  type WorkflowActionLookup,
} from "../../actions/workflowReceipt";
import {
  boundedRefresh,
  runShelfUnshelve,
  workflowConnectionMatchesTarget,
  type ShelfUnshelveLifecycle,
} from "../shelfUnshelveLifecycle";

export interface ShelfRequest {
  changeId: number;
  paths: string[];
  mode: "shelve" | "delete";
  hasShelf: boolean;
  source: HTMLElement | null;
}

type Phase =
  | "idle"
  | "checking"
  | "ready"
  | "blocked"
  | "stale"
  | "running"
  | "completed"
  | "unknown"
  | "failed";

export function ShelfDialog(props: Parameters<typeof ShelfWorkflowDialog>[0]) {
  if (props.request.mode === "delete")
    return (
      <DeleteShelfDialog
        request={props.request}
        connectionKey={props.connectionKey}
        zh={props.zh}
        onDismiss={props.onDismiss}
      />
    );
  // Nested/audited shelf flows (cross-CL group choice or an injected preflight
  // port) keep the explicit review dialog with "back to CL groups"; the plain
  // one-click entry from the Pending page keeps the direct shelf command.
  if (props.onBack || props.check) return <ShelfWorkflowDialog {...props} />;
  return <DirectShelve {...props} />;
}
/** Direct shelve: no dialog, no FE preflight; the host command owns its internal preflight. */
function DirectShelve({
  request,
  connectionKey,
  onDismiss,
}: Parameters<typeof ShelfWorkflowDialog>[0]) {
  const env = useContext(MenuEnvironment);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    try {
      const context = env?.getOperationContext?.();
      if (!context || !env?.reportOperationError) return;
      startShelveDirect(
        {
          connectionKey,
          changeId: request.changeId,
          paths: [...new Set(request.paths)].sort(),
          ...shelfIdentity(context.runtime),
        },
        {
          current: () => env.getOperationContext!(),
          connection: backend.companySubmitConnectionSnapshot,
          lookup: lookupWorkflowAction,
          report: env.reportOperationError,
          execute: (directRequest) => backend.shelveFiles(directRequest),
        },
      );
    } finally {
      onDismiss();
    }
  }, [connectionKey, env, onDismiss, request.changeId, request.paths]);
  return null;
}
function ShelfWorkflowDialog({
  request,
  connectionKey,
  demo = false,
  zh,
  onDismiss,
  onBack,
  check = (value) => backend.preflightShelf(value),
  execute = (value) => backend.confirmShelf(value),
  connection = () => backend.companySubmitConnectionSnapshot(),
  lookup = lookupWorkflowAction,
}: {
  request: ShelfRequest;
  connectionKey: string;
  demo?: boolean;
  zh: boolean;
  onDismiss(): void;
  onBack?(): void;
  check?(request: ShelfPreflightRequest): Promise<ShelfPreflight>;
  execute?(confirmation: WorkflowConfirmation): Promise<WorkflowResult>;
  /** Exact dispatching connection snapshot; captured once per confirm. */
  connection?(): Promise<ConnectionSnapshot>;
  /** Durable receipt recovery by the SAME operationId. */
  lookup?(request: {
    operationId: string;
    connection: ConnectionSnapshot;
  }): Promise<WorkflowActionLookup>;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [snapshot] = useState(() => ({
    ...request,
    paths: [...new Set(request.paths)].sort(),
    connectionKey,
  }));
  const [replace, setReplace] = useState(false);
  const [ack, setAck] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [preflight, setPreflight] = useState<ShelfPreflight>();
  const [result, setResult] = useState<WorkflowResult>();
  const [lifecycle, setLifecycle] = useState<ShelfUnshelveLifecycle>();
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const running = useRef(false);
  const operationId = useRef<string | undefined>(undefined);
  const staleConnection = snapshot.connectionKey !== connectionKey;
  const sourceChanged =
    request.changeId !== snapshot.changeId ||
    request.mode !== snapshot.mode ||
    JSON.stringify([...new Set(request.paths)].sort()) !==
      JSON.stringify(snapshot.paths);
  const invalidated = staleConnection || sourceChanged;
  const deleting = snapshot.mode === "delete";
  const risky = deleting || replace;
  const busy = phase === "checking" || phase === "running";

  useEffect(() => {
    if (!invalidated) return;
    generation.current++;
    running.current = false;
    setPreflight(undefined);
    setAck(false);
    setPhase("stale");
  }, [invalidated]);
  useEffect(() => {
    if (!preflight || phase !== "ready") return;
    const timer = setTimeout(
      () => {
        setPhase("stale");
        setAck(false);
      },
      Math.min(2147483647, Math.max(0, preflight.expiresAt - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [phase, preflight]);
  useEffect(() => () => void ++generation.current, []);

  const resetCheck = () => {
    generation.current++;
    running.current = false;
    setPreflight(undefined);
    setResult(undefined);
    setLifecycle(undefined);
    setRefreshFailed(false);
    operationId.current = undefined;
    setMessage("");
    setPhase("idle");
  };

  async function inspect() {
    if (
      running.current ||
      invalidated ||
      snapshot.changeId <= 0 ||
      !snapshot.paths.length
    )
      return;
    const epoch = ++generation.current;
    running.current = true;
    setPhase("checking");
    setMessage("");
    setResult(undefined);
    setLifecycle(undefined);
    setRefreshFailed(false);
    try {
      const value = await check({
        changeId: snapshot.changeId,
        depotPaths: snapshot.paths,
        mode: deleting ? "delete" : "createOrUpdate",
        replace: deleting ? undefined : replace,
      });
      if (epoch !== generation.current || invalidated) return;
      const samePaths =
        JSON.stringify([...value.target.depotPaths].sort()) ===
        JSON.stringify(snapshot.paths);
      if (
        value.target.kind !== "shelf" ||
        value.target.sourceChangeId !== snapshot.changeId ||
        !samePaths ||
        (value.ready && !value.token) ||
        !Number.isFinite(value.expiresAt)
      )
        throw new Error(
          tr(
            "预检结果与固定目标不匹配。",
            "Preflight does not match the fixed target.",
          ),
        );
      setPreflight(value);
      setPhase(
        !value.ready || value.blockers.length
          ? "blocked"
          : value.expiresAt <= Date.now()
            ? "stale"
            : "ready",
      );
    } catch (cause) {
      if (epoch === generation.current) {
        setMessage(String(cause));
        setPhase("failed");
      }
    } finally {
      running.current = false;
    }
  }

  async function confirm() {
    if (
      running.current ||
      invalidated ||
      phase !== "ready" ||
      !preflight?.token ||
      (risky && !ack)
    )
      return;
    if (preflight.expiresAt <= Date.now()) {
      setPhase("stale");
      return;
    }
    const epoch = generation.current;
    running.current = true;
    setPhase("running");
    setMessage("");
    setResult(undefined);
    setLifecycle(undefined);
    setRefreshFailed(false);
    // One UUID for this dispatch; it is reused by receipt lookup, never by a retry.
    const id = crypto.randomUUID();
    operationId.current = id;
    try {
      const dispatching = await connection();
      if (epoch !== generation.current || invalidated) return;
      if (
        !workflowConnectionMatchesTarget(preflight.target, dispatching, "shelf")
      )
        throw new Error(
          tr(
            "连接身份与预检目标不一致，未执行任何搁置操作。",
            "Connection identity changed; nothing was shelved.",
          ),
        );
      // A newer explicit shelf action retires older visual shelf-delete claims.
      invalidateShelfObservations(connectionKey, request.paths);
      const run = await runShelfUnshelve(
        { token: preflight.token, target: preflight.target, operationId: id },
        "shelf",
        {
          connection: dispatching,
          connectionKey,
          execute,
          lookup,
          refresh: (key, target, value) => boundedRefresh(key, target, value),
        },
      );
      if (epoch !== generation.current || invalidated) return;
      setResult(run.result);
      setLifecycle(run.lifecycle);
      setRefreshFailed(!run.refreshSucceeded);
      if (run.lifecycle.state === "commandCompleted") setPhase("completed");
      else if (run.lifecycle.state === "legacy")
        setPhase(
          run.lifecycle.outcome === "succeeded"
            ? "completed"
            : run.lifecycle.outcome === "unknown"
              ? "unknown"
              : "failed",
        );
      else setPhase("unknown");
      if (run.lifecycle.state !== "commandCompleted") {
        setPreflight(undefined);
        setAck(false);
      }
    } catch (cause) {
      if (epoch === generation.current) {
        setMessage(String(cause));
        setPhase("failed");
        setPreflight(undefined);
        setAck(false);
      }
    } finally {
      running.current = false;
    }
  }

  /** Cancellation is the existing IPC with the SAME operationId (never a new id). */
  async function cancel() {
    const id = operationId.current;
    if (!id || !running.current) return;
    await backend.cancelOperation(id).catch(() => undefined);
  }

  const status: PreflightState = !snapshot.paths.length
    ? { kind: "empty" }
    : phase === "checking"
      ? { kind: "checking" }
      : phase === "stale"
        ? { kind: "stale" }
        : phase === "failed" && !result
          ? { kind: "failed", message }
          : preflight
            ? {
                kind:
                  phase === "ready" ||
                  phase === "running" ||
                  phase === "completed"
                    ? "ready"
                    : "blocked",
                blockers: preflight.blockers.map(
                  (item) =>
                    `${item.certainty === "unknown" ? tr("未知：", "Unknown: ") : ""}${item.message}`,
                ),
                warnings: preflight.warnings.map(
                  (item) =>
                    `${item.certainty === "unknown" ? tr("未知：", "Unknown: ") : ""}${item.message}`,
                ),
              }
            : { kind: "idle" };

  return (
    <Dialog
      title={
        deleting
          ? tr("删除搁置内容", "Delete shelved files")
          : tr("搁置文件", "Shelve files")
      }
      description={tr(
        "范围固定为下方文件，不会自动扩大为整个 CL。",
        "The scope is exactly the files below, never implicitly the entire CL.",
      )}
      source={snapshot.source}
      zh={zh}
      danger={risky}
      busy={busy}
      onRequestClose={onDismiss}
      footer={
        <>
          {onBack && (
            <button disabled={busy} onClick={onBack}>
              {tr("返回 CL 分组", "Back to CL groups")}
            </button>
          )}
          <button data-dialog-autofocus disabled={busy} onClick={onDismiss}>
            {tr("关闭", "Close")}
          </button>
          {phase === "running" && (
            <button onClick={() => void cancel()}>
              {tr("取消操作", "Cancel operation")}
            </button>
          )}
          <button
            disabled={
              busy ||
              invalidated ||
              snapshot.changeId <= 0 ||
              !snapshot.paths.length ||
              phase === "completed"
            }
            onClick={() => void inspect()}
          >
            {tr("运行预检", "Run preflight")}
          </button>
          <button
            className={risky ? "danger" : "primary"}
            disabled={phase !== "ready" || !preflight?.token || (risky && !ack)}
            onClick={() => void confirm()}
          >
            {deleting
              ? tr("确认删除所选搁置版本", "Delete selected shelf revisions")
              : tr("确认搁置所选文件", "Shelve selected files")}
          </button>
        </>
      }
    >
      <div className="workflow-context">
        {snapshot.changeId ? `CL ${snapshot.changeId}` : "Default"} ·{" "}
        {snapshot.paths.length} {tr("个文件", "files")}
      </div>
      {demo && (
        <DialogNotice>
          {tr(
            "浏览器 Mock 会模拟结果，不访问真实 P4 Server。",
            "Browser Mock simulates the result and does not access a real P4 server.",
          )}
        </DialogNotice>
      )}
      <TargetList
        paths={snapshot.paths}
        label={tr("明确的文件范围", "Explicit file scope")}
      />
      {snapshot.changeId <= 0 && (
        <DialogNotice error>
          {tr(
            "需要先创建编号 CL，再选择文件搁置。",
            "Create a numbered CL before shelving files.",
          )}
        </DialogNotice>
      )}
      {!deleting && snapshot.hasShelf && (
        <label>
          {tr("已有搁置内容的处理方式", "Existing shelf handling")}
          <select
            value={replace ? "replace" : "preserve"}
            onChange={(event) => {
              setReplace(event.target.value === "replace");
              setAck(false);
              resetCheck();
            }}
          >
            <option value="preserve">
              {tr("保留已有内容", "Preserve existing content")}
            </option>
            <option value="replace">
              {tr("替换所选文件的搁置版本", "Replace selected shelf revisions")}
            </option>
          </select>
        </label>
      )}
      {risky && (
        <>
          <DialogNotice error>
            {deleting
              ? tr(
                  "删除后这些服务器搁置版本将不可再用于 Unshelve。不会同时删除工作区文件或整个 CL。",
                  "Deleted shelf revisions can no longer be unshelved. Workspace files and the CL are not deleted.",
                )
              : tr(
                  "替换会覆盖所选文件已有的搁置版本；未选文件不在本次范围内。",
                  "Replacement overwrites selected shelf revisions; unselected files remain out of scope.",
                )}
          </DialogNotice>
          <label className="workflow-checkbox">
            <input
              type="checkbox"
              checked={ack}
              onChange={(event) => setAck(event.target.checked)}
            />
            {tr(
              "我已核对文件范围并明确确认此危险操作。",
              "I reviewed the scope and explicitly confirm this destructive operation.",
            )}
          </label>
        </>
      )}
      {preflight && (
        <div className="workflow-context">
          {tr("新增", "Create")} {preflight.scope.createPaths.length} ·{" "}
          {tr("替换", "Replace")} {preflight.scope.replacePaths.length} ·{" "}
          {tr("删除", "Delete")} {preflight.scope.deletePaths.length}
        </div>
      )}
      {!result && <PreflightStatus state={status} zh={zh} />}
      {phase === "running" && (
        <DialogNotice>
          {tr(
            "正在执行；关闭保护已启用。",
            "Operation in progress; closing is disabled.",
          )}
        </DialogNotice>
      )}
      {message && (
        <DialogNotice error={phase === "failed"}>{message}</DialogNotice>
      )}
      {lifecycle?.state === "commandCompleted" && (
        <DialogNotice>
          {tr(
            "命令已完成（仅命令级生命周期）。逐文件搁置状态没有权威事实，不能据此认定搁置成功；请以刷新后的搁置详情与 Pending 为准。",
            "Command completed (command-level lifecycle only). Per-file shelf state has no authoritative fact here, so this is not a per-file success; rely on the refreshed shelf detail and Pending.",
          )}
        </DialogNotice>
      )}
      {lifecycle?.state === "unknown" && (
        <DialogNotice error>
          {tr(
            "结果不确定：命令可能已执行，逐文件状态未知。已按同一操作号查询回执并刷新一次；请先核对搁置/CL 状态，不要直接重复确认。",
            "Outcome uncertain: the command may have run and per-file state is unknown. The receipt was queried with the same operation id and one bounded refresh was done; inspect the shelf/CL before confirming again.",
          )}
        </DialogNotice>
      )}
      {lifecycle?.state === "legacy" && lifecycle.outcome !== "succeeded" && (
        <DialogNotice error>
          {tr("结果：", "Outcome: ")}
          {lifecycle.outcome}
          {result?.failure ? ` · ${result.failure}` : ""} ·{" "}
          {result?.refresh.reason}
        </DialogNotice>
      )}
      {lifecycle?.state === "legacy" && lifecycle.outcome === "partial" && (
        <DialogNotice>
          {tr(
            "部分完成：仅下列 succeeded 行有逐文件事实，其余仍未知。",
            "Partial: only the succeeded rows below have per-file facts; the rest stay unknown.",
          )}
        </DialogNotice>
      )}
      {(lifecycle?.state === "legacy"
        ? lifecycle.outcome === "partial"
          ? lifecycle.files.filter((file) => file.state === "succeeded")
          : lifecycle.files
        : (lifecycle?.files ?? [])
      ).map((file) => (
        <DialogNotice key={file.depotPath} error={file.state !== "succeeded"}>
          {file.state} · {file.depotPath} · {file.message}
        </DialogNotice>
      ))}
      {lifecycle?.state !== "legacy" && !!lifecycle?.files.length && (
        <p className="workflow-context">
          {tr("逐文件权威事实", "Per-file facts")} {lifecycle.files.length}
        </p>
      )}
      {lifecycle && result?.message && (
        <DialogNotice error={lifecycle.state === "unknown"}>
          {result.message}
        </DialogNotice>
      )}
      {refreshFailed && (
        <DialogNotice error>
          {tr(
            "刷新视图失败：显示可能过期，请稍后手动刷新；不会重试写操作。",
            "View refresh failed: the display may be stale. Refresh manually later; the write is not retried.",
          )}
        </DialogNotice>
      )}
      {(lifecycle?.operationId || result?.operationIds.length) && (
        <p className="workflow-context">
          {tr("操作记录", "Operations")}{" "}
          {lifecycle?.operationId ?? result?.operationIds.join(", ")}
          {result?.logReference
            ? ` · ${tr("日志", "Log")} ${result.logReference}`
            : ""}
        </p>
      )}
    </Dialog>
  );
}
