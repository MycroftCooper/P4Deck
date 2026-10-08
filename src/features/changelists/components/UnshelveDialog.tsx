import { useEffect, useRef, useState } from "react";
import { backend } from "../../../infrastructure/backend";
import type {
  ClientWorkspace,
  PendingChange,
  UnshelvePreflight,
  UnshelvePreflightRequest,
  WorkflowConfirmation,
  WorkflowResult,
} from "../../../shared/contracts/types";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import {
  PreflightStatus,
  type PreflightState,
} from "../../../app/dialogs/PreflightStatus";
import { TargetList } from "../../../app/dialogs/TargetList";
import type { ShelfRequest } from "./ShelfDialog";
import {
  publishWorkflowFailure,
  publishWorkflowResult,
} from "../workflowRefresh";

type Phase =
  | "idle"
  | "checking"
  | "ready"
  | "blocked"
  | "stale"
  | "running"
  | "success"
  | "failed";

export function UnshelveDialog({
  request,
  changes,
  currentWorkspace,
  connectionKey,
  demo = false,
  zh,
  onDismiss,
  loadWorkspaces = () => backend.listUserWorkspaces(),
  check = (value) => backend.preflightUnshelve(value),
  execute = (value) => backend.confirmUnshelve(value),
}: {
  request: ShelfRequest;
  changes: PendingChange[];
  currentWorkspace: string;
  connectionKey: string;
  demo?: boolean;
  zh: boolean;
  onDismiss(): void;
  loadWorkspaces?(): Promise<ClientWorkspace[]>;
  check?(request: UnshelvePreflightRequest): Promise<UnshelvePreflight>;
  execute?(confirmation: WorkflowConfirmation): Promise<WorkflowResult>;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [snapshot] = useState(() => ({
    ...request,
    paths: [...new Set(request.paths)].sort(),
    changes: changes.map((change) => ({
      id: change.id,
      description: change.description,
    })),
    connectionKey,
  }));
  const [workspaces, setWorkspaces] = useState<ClientWorkspace[]>([]);
  const [workspaceError, setWorkspaceError] = useState("");
  const [targetWorkspace, setTargetWorkspace] = useState(currentWorkspace);
  const [targetChange, setTargetChange] = useState("0");
  const [ack, setAck] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [preflight, setPreflight] = useState<UnshelvePreflight>();
  const [result, setResult] = useState<WorkflowResult>();
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const running = useRef(false);
  const loadWorkspacesRef = useRef(loadWorkspaces);
  const staleConnection = snapshot.connectionKey !== connectionKey;
  const sourceChanged =
    request.changeId !== snapshot.changeId ||
    JSON.stringify([...new Set(request.paths)].sort()) !==
      JSON.stringify(snapshot.paths);
  const invalidated = staleConnection || sourceChanged;
  const targetId = Number(targetChange);
  const validTarget = Number.isInteger(targetId) && targetId >= 0;
  const busy = phase === "checking" || phase === "running";

  useEffect(() => {
    let live = true;
    void loadWorkspacesRef
      .current()
      .then((value) => {
        if (!live) return;
        const next = [...value];
        if (!next.some((item) => item.name === currentWorkspace))
          next.unshift({
            name: currentWorkspace,
            owner: "",
            host: "",
            root: "",
            stream: "",
            description: tr("当前工作区", "Current workspace"),
            updated: null,
            accessed: null,
          });
        setWorkspaces(next);
      })
      .catch((cause) => live && setWorkspaceError(String(cause)));
    return () => {
      live = false;
    };
  }, [currentWorkspace]);
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

  const targetChanged = () => {
    generation.current++;
    running.current = false;
    setPreflight(undefined);
    setResult(undefined);
    setMessage("");
    setAck(false);
    setPhase("idle");
  };

  async function inspect() {
    if (
      running.current ||
      invalidated ||
      !snapshot.paths.length ||
      !targetWorkspace ||
      !validTarget
    )
      return;
    const epoch = ++generation.current;
    running.current = true;
    setPhase("checking");
    setMessage("");
    setResult(undefined);
    setAck(false);
    try {
      const value = await check({
        sourceChangeId: snapshot.changeId,
        depotPaths: snapshot.paths,
        targetWorkspace,
        targetChangeId: targetId,
      });
      if (epoch !== generation.current) return;
      const samePaths =
        JSON.stringify([...value.target.depotPaths].sort()) ===
        JSON.stringify(snapshot.paths);
      if (
        value.target.kind !== "unshelve" ||
        value.target.sourceChangeId !== snapshot.changeId ||
        value.target.targetChangeId !== targetId ||
        value.target.client !== targetWorkspace ||
        !samePaths ||
        (value.ready && !value.token) ||
        !Number.isFinite(value.expiresAt)
      )
        throw new Error(
          tr(
            "预检结果与来源或目标不匹配。",
            "Preflight does not match the source or target.",
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
      !ack
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
      if (epoch !== generation.current) return;
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
      title={tr("Unshelve 到工作区", "Unshelve to workspace")}
      description={tr(
        "将固定的来源 Shelf 子集应用到目标工作区与 CL；来源 Shelf 保留，不会强制覆盖本地内容。",
        "Apply the fixed source shelf subset to a target workspace and changelist. The source shelf remains and local content is never force-overwritten.",
      )}
      zh={zh}
      source={snapshot.source}
      busy={busy}
      onRequestClose={onDismiss}
      footer={
        <>
          <button disabled={busy} onClick={onDismiss}>
            {tr("关闭", "Close")}
          </button>
          <button
            disabled={
              busy ||
              invalidated ||
              !snapshot.paths.length ||
              !targetWorkspace ||
              !validTarget ||
              phase === "success"
            }
            onClick={() => void inspect()}
          >
            {tr("运行预检", "Run preflight")}
          </button>
          <button
            className="primary"
            disabled={phase !== "ready" || !preflight?.token || !ack}
            onClick={() => void confirm()}
          >
            {tr("确认 Unshelve", "Confirm unshelve")}
          </button>
        </>
      }
    >
      <div className="workflow-context">
        {tr("来源搁置", "Source shelf")} CL {snapshot.changeId} ·{" "}
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
        paths={snapshot.paths.map((path) => `${path}@=${snapshot.changeId}`)}
        label={tr("固定来源文件", "Fixed source files")}
      />
      <label>
        {tr("目标 Workspace", "Target workspace")}
        <select
          data-dialog-autofocus
          value={targetWorkspace}
          onChange={(event) => {
            setTargetWorkspace(event.target.value);
            targetChanged();
          }}
        >
          {!workspaces.some((item) => item.name === targetWorkspace) && (
            <option value={targetWorkspace}>{targetWorkspace}</option>
          )}
          {workspaces.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
              {item.root ? ` · ${item.root}` : ""}
            </option>
          ))}
        </select>
      </label>
      {workspaceError && <DialogNotice error>{workspaceError}</DialogNotice>}
      <label>
        {tr("目标 CL（0 为 Default）", "Target CL (0 means Default)")}
        <input
          type="number"
          min={0}
          step={1}
          value={targetChange}
          onChange={(event) => {
            setTargetChange(event.target.value);
            targetChanged();
          }}
        />
      </label>
      {!validTarget && (
        <DialogNotice error>
          {tr(
            "请输入 Default（0）或有效的编号 CL。",
            "Enter Default (0) or a valid numbered changelist.",
          )}
        </DialogNotice>
      )}
      <div className="workflow-context">
        CL {snapshot.changeId} → {targetWorkspace} ·{" "}
        {targetId === 0 ? "Default" : `CL ${targetId}`}
      </div>
      <DialogNotice>
        {tr(
          "预检会验证映射、本地覆盖、锁、权限、已有打开状态和 Resolve 风险；执行不会启用强制覆盖。",
          "Preflight verifies mapping, local overwrite risk, locks, permissions, opened state and Resolve risk. Execution does not enable force overwrite.",
        )}
      </DialogNotice>
      {preflight?.mappings.length ? (
        <div className="workflow-mapping-scroll">
          <table className="workflow-mapping-table">
            <thead>
              <tr>
                <th>{tr("来源", "Source")}</th>
                <th>{tr("目标映射", "Target mapping")}</th>
                <th>{tr("状态", "Status")}</th>
              </tr>
            </thead>
            <tbody>
              {preflight.mappings.map((mapping) => (
                <tr key={mapping.depotPath}>
                  <td>{mapping.depotPath}</td>
                  <td>{mapping.targetPath ?? tr("未映射", "Unmapped")}</td>
                  <td>
                    {[
                      !mapping.mapped && tr("映射失败", "unmapped"),
                      mapping.locallyModified &&
                        tr("本地修改", "local modification"),
                      mapping.locked && tr("已锁定", "locked"),
                      mapping.openedChangeId !== undefined &&
                        `${tr("已打开于", "opened in")} CL ${mapping.openedChangeId}`,
                      mapping.resolveRisk !== "none" &&
                        `${tr("Resolve 风险", "Resolve risk")}: ${mapping.resolveRisk}`,
                    ]
                      .filter(Boolean)
                      .join(" · ") || tr("未发现风险", "No risk found")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {!result && <PreflightStatus state={status} zh={zh} />}
      {phase === "ready" && (
        <label className="workflow-checkbox">
          <input
            type="checkbox"
            checked={ack}
            onChange={(event) => setAck(event.target.checked)}
          />
          {tr(
            "我已核对目标、映射和风险；仅按普通 Unshelve 执行，不强制覆盖。",
            "I reviewed the target, mappings and risks; run normal unshelve without force overwrite.",
          )}
        </label>
      )}
      {phase === "running" && (
        <DialogNotice>
          {tr(
            "正在 Unshelve；关闭保护已启用。",
            "Unshelve in progress; closing is disabled.",
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
