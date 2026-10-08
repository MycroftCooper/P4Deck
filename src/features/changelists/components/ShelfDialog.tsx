import { useEffect, useRef, useState } from "react";
import { backend } from "../../../infrastructure/backend";
import type {
  ShelfPreflight,
  ShelfPreflightRequest,
  WorkflowConfirmation,
  WorkflowResult,
} from "../../../shared/contracts/types";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import {
  PreflightStatus,
  type PreflightState,
} from "../../../app/dialogs/PreflightStatus";
import { TargetList } from "../../../app/dialogs/TargetList";
import {
  publishWorkflowFailure,
  publishWorkflowResult,
} from "../workflowRefresh";

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
  | "success"
  | "failed";

export function ShelfDialog({
  request,
  connectionKey,
  demo = false,
  zh,
  onDismiss,
  onBack,
  check = (value) => backend.preflightShelf(value),
  execute = (value) => backend.confirmShelf(value),
}: {
  request: ShelfRequest;
  connectionKey: string;
  demo?: boolean;
  zh: boolean;
  onDismiss(): void;
  onBack?(): void;
  check?(request: ShelfPreflightRequest): Promise<ShelfPreflight>;
  execute?(confirmation: WorkflowConfirmation): Promise<WorkflowResult>;
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
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const running = useRef(false);
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
    try {
      const value = await execute({
        token: preflight.token,
        target: preflight.target,
      });
      if (epoch !== generation.current || invalidated) return;
      setResult(value);
      setMessage(value.message);
      const succeeded =
        value.outcome === "succeeded" &&
        value.files.length === snapshot.paths.length &&
        value.files.every((file) => file.state === "succeeded");
      setPhase(succeeded ? "success" : "failed");
      await publishWorkflowResult(value, preflight.target, connectionKey);
      if (!succeeded) {
        setPreflight(undefined);
        setAck(false);
      }
    } catch (cause) {
      if (epoch === generation.current) {
        setMessage(String(cause));
        setPhase("failed");
        setPreflight(undefined);
        setAck(false);
        await publishWorkflowFailure(connectionKey);
      }
    } finally {
      running.current = false;
    }
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
                  phase === "success"
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
          <button
            disabled={
              busy ||
              invalidated ||
              snapshot.changeId <= 0 ||
              !snapshot.paths.length ||
              phase === "success"
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
      {message && (result || phase === "success") && (
        <DialogNotice error={phase === "failed"}>{message}</DialogNotice>
      )}
      {result && (
        <>
          {result.outcome !== "succeeded" && (
            <DialogNotice error>
              {tr("结果：", "Outcome: ")}
              {result.outcome}
              {result.failure ? ` · ${result.failure}` : ""} ·{" "}
              {result.refresh.reason}
            </DialogNotice>
          )}
          {result.files.map((file) => (
            <DialogNotice
              key={file.depotPath}
              error={file.state !== "succeeded"}
            >
              {file.state} · {file.depotPath} · {file.message}
            </DialogNotice>
          ))}
          {!!result.operationIds.length && (
            <p className="workflow-context">
              {tr("操作记录", "Operations")} {result.operationIds.join(", ")}
              {result.logReference
                ? ` · ${tr("日志", "Log")} ${result.logReference}`
                : ""}
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}
