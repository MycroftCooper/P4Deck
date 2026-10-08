import { useEffect, useRef, useState } from "react";
import { backend } from "../../../infrastructure/backend";
import type {
  ResolveConfirmation,
  ResolveConflictDetail,
  ResolvePreflight,
  ResolvePreflightRequest,
  ResolveStrategy,
  WorkflowResult,
  WorkspaceNode,
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
} from "../../changelists/workflowRefresh";

type ExecutableStrategy = Exclude<ResolveStrategy, "mergePreview">;
type Phase =
  | "idle"
  | "checking"
  | "ready"
  | "blocked"
  | "stale"
  | "running"
  | "success"
  | "failed";

const strategyLabel = (strategy: ExecutableStrategy, zh: boolean): string =>
  ({
    safe: zh ? "安全自动合并" : "Safe automatic merge",
    acceptYours: zh ? "保留工作区一侧" : "Accept yours",
    acceptTheirs: zh ? "接受传入一侧" : "Accept theirs",
  })[strategy];

function executableStrategies(detail: ResolveConflictDetail) {
  return detail.availableStrategies.filter(
    (strategy): strategy is ExecutableStrategy => strategy !== "mergePreview",
  );
}

export function ResolveDialog({
  nodes,
  source,
  connectionKey,
  demo = false,
  zh,
  onDismiss,
  check = (value) => backend.preflightResolve(value),
  execute = (value) => backend.confirmResolve(value),
}: {
  nodes: WorkspaceNode[];
  source: HTMLElement | null;
  connectionKey: string;
  demo?: boolean;
  zh: boolean;
  onDismiss(): void;
  check?(request: ResolvePreflightRequest): Promise<ResolvePreflight>;
  execute?(confirmation: ResolveConfirmation): Promise<WorkflowResult>;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [snapshot] = useState(() => ({
    nodes: [
      ...new Map(
        nodes.map((node) => [node.depotPath || node.absolutePath, { ...node }]),
      ).values(),
    ],
    connectionKey,
  }));
  const paths = snapshot.nodes.map(
    (node) => node.depotPath || node.absolutePath,
  );
  const [index, setIndex] = useState(0);
  const [plans, setPlans] = useState<
    Record<string, ExecutableStrategy | undefined>
  >({});
  const [phase, setPhase] = useState<Phase>("idle");
  const [preflight, setPreflight] = useState<ResolvePreflight>();
  const [result, setResult] = useState<WorkflowResult>();
  const [message, setMessage] = useState("");
  const [discard, setDiscard] = useState(false);
  const generation = useRef(0);
  const running = useRef(false);
  const staleConnection = snapshot.connectionKey !== connectionKey;
  const sourceChanged =
    JSON.stringify(
      [
        ...new Set(nodes.map((node) => node.depotPath || node.absolutePath)),
      ].sort(),
    ) !== JSON.stringify([...paths].sort());
  const invalidated = staleConnection || sourceChanged;
  const busy = phase === "checking" || phase === "running";
  const current = preflight?.conflicts[index];
  const currentPlan = current ? plans[current.depotPath] : undefined;
  const allExecutable =
    !!preflight?.conflicts.length &&
    preflight.conflicts.every(
      (conflict) =>
        conflict.status === "unresolved" &&
        plans[conflict.depotPath] !== undefined &&
        executableStrategies(conflict).includes(plans[conflict.depotPath]!),
    );

  useEffect(() => {
    if (!invalidated) return;
    generation.current++;
    running.current = false;
    setPreflight(undefined);
    setPlans({});
    setPhase("stale");
  }, [invalidated]);
  useEffect(() => {
    if (!preflight || phase !== "ready") return;
    const timer = setTimeout(
      () => setPhase("stale"),
      Math.min(2147483647, Math.max(0, preflight.expiresAt - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [phase, preflight]);
  useEffect(() => () => void ++generation.current, []);

  async function inspect() {
    if (running.current || invalidated || !paths.length) return;
    const epoch = ++generation.current;
    running.current = true;
    setPhase("checking");
    setMessage("");
    setResult(undefined);
    setPlans({});
    try {
      const value = await check({ depotPaths: paths });
      if (epoch !== generation.current) return;
      const expected = JSON.stringify([...paths].sort());
      const targetMatches =
        value.target.kind === "resolve" &&
        JSON.stringify([...value.target.depotPaths].sort()) === expected;
      const conflictMatches =
        new Set(value.conflicts.map((item) => item.depotPath)).size ===
          value.conflicts.length &&
        JSON.stringify(value.conflicts.map((item) => item.depotPath).sort()) ===
          expected;
      if (
        !targetMatches ||
        !conflictMatches ||
        (value.ready && !value.token) ||
        !Number.isFinite(value.expiresAt)
      )
        throw new Error(
          tr(
            "冲突详情与固定文件范围不匹配。",
            "Conflict details do not match the fixed file scope.",
          ),
        );
      setPreflight(value);
      setIndex(0);
      const hasUnsafeConflict = value.conflicts.some(
        (item) =>
          item.status !== "unresolved" || !executableStrategies(item).length,
      );
      setPhase(
        !value.ready || value.blockers.length || hasUnsafeConflict
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
      !allExecutable
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
        resolutions: preflight.conflicts.map((conflict) => ({
          depotPath: conflict.depotPath,
          strategy: plans[conflict.depotPath]!,
        })),
      });
      if (epoch !== generation.current) return;
      setResult(value);
      setMessage(value.message);
      const succeeded =
        value.outcome === "succeeded" &&
        value.files.length === preflight.conflicts.length &&
        value.files.every((file) => file.state === "succeeded");
      setPhase(succeeded ? "success" : "failed");
      await publishWorkflowResult(value, preflight.target, connectionKey);
      if (!succeeded) setPreflight(undefined);
    } catch (cause) {
      if (epoch === generation.current) {
        setMessage(String(cause));
        setPhase("failed");
        setPreflight(undefined);
        await publishWorkflowFailure(connectionKey);
      }
    } finally {
      running.current = false;
    }
  }

  const select = (next: number) => {
    setIndex(next);
    setMessage("");
  };
  const dismiss = () =>
    Object.values(plans).some(Boolean) && phase !== "success"
      ? setDiscard(true)
      : onDismiss();
  const derivedBlockers = preflight
    ? preflight.conflicts
        .filter(
          (conflict) =>
            conflict.status !== "unresolved" ||
            !executableStrategies(conflict).length,
        )
        .map((conflict) =>
          conflict.status === "unknown"
            ? `${conflict.depotPath}: ${tr("冲突状态未知", "conflict state unknown")}`
            : conflict.status === "blocked"
              ? `${conflict.depotPath}: ${tr("后端标记为阻塞", "blocked by backend")}`
              : `${conflict.depotPath}: ${tr("没有可执行策略", "no executable strategy")}`,
        )
    : [];
  const status: PreflightState = !paths.length
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
                blockers: [
                  ...preflight.blockers.map(
                    (item) =>
                      `${item.certainty === "unknown" ? tr("未知：", "Unknown: ") : ""}${item.message}`,
                  ),
                  ...derivedBlockers,
                ],
                warnings: preflight.warnings.map(
                  (item) =>
                    `${item.certainty === "unknown" ? tr("未知：", "Unknown: ") : ""}${item.message}`,
                ),
              }
            : { kind: "idle" };

  return (
    <Dialog
      title={tr("解决冲突（Resolve）", "Resolve conflicts")}
      description={tr(
        "后端预检提供逐文件冲突详情和允许的策略；blocked 或 unknown 文件不会执行。",
        "Backend preflight provides per-file conflict details and allowed strategies. Blocked or unknown files never execute.",
      )}
      source={source}
      zh={zh}
      busy={busy}
      onRequestClose={dismiss}
      footer={
        <>
          <button disabled={busy} onClick={dismiss}>
            {tr("关闭", "Close")}
          </button>
          <button
            disabled={
              busy || invalidated || !paths.length || phase === "success"
            }
            onClick={() => void inspect()}
          >
            {tr("检查冲突", "Inspect conflicts")}
          </button>
          <button
            className="primary"
            disabled={phase !== "ready" || !preflight?.token || !allExecutable}
            onClick={() => void confirm()}
          >
            {tr("执行逐文件计划", "Run per-file plan")}
          </button>
        </>
      }
    >
      <div className="workflow-context">
        {paths.length} {tr("个固定目标", "fixed targets")} ·{" "}
        {current ? index + 1 : 0}/{preflight?.conflicts.length ?? paths.length}
      </div>
      {demo && (
        <DialogNotice>
          {tr(
            "浏览器 Mock 只返回未知冲突并保持阻塞，不访问真实 P4 Server。",
            "Browser Mock returns unknown conflicts and keeps execution blocked; it does not access a real P4 server.",
          )}
        </DialogNotice>
      )}
      <TargetList
        paths={preflight?.conflicts.map((item) => item.depotPath) ?? paths}
        label={tr("待处理文件", "Files to resolve")}
        selectedIndex={index}
        onSelect={select}
      />
      <div className="workflow-navigation">
        <button disabled={index === 0} onClick={() => select(index - 1)}>
          {tr("上一项", "Previous")}
        </button>
        <button
          disabled={index >= (preflight?.conflicts.length ?? paths.length) - 1}
          onClick={() => select(index + 1)}
        >
          {tr("下一项", "Next")}
        </button>
      </div>
      {!preflight && paths.length > 0 && (
        <DialogNotice>
          {tr(
            "尚未从后端读取冲突事实；文件列表状态不用于推断 Resolve 结论。",
            "Conflict facts have not been loaded from the backend. List state is not treated as a Resolve conclusion.",
          )}
        </DialogNotice>
      )}
      {current && (
        <>
          <p className="workflow-summary-description">
            {current.depotPath}
            {current.clientPath ? ` · ${current.clientPath}` : ""}
          </p>
          <div className="workflow-context">
            {tr("冲突类型", "Conflict type")}: {current.conflictType} ·{" "}
            {tr("状态", "Status")}: {current.status}
          </div>
          <div className="workflow-version-grid">
            {(["base", "yours", "theirs"] as const).map((role) => {
              const value = current.sources.find((item) => item.role === role);
              const label = {
                base: tr("共同基线", "Base"),
                yours: tr("工作区一侧", "Yours"),
                theirs: tr("传入一侧", "Theirs"),
              }[role];
              return (
                <section key={role} aria-label={label}>
                  <h3>{label}</h3>
                  {value ? (
                    <p>
                      {value.depotPath ?? current.depotPath}
                      {value.revision !== undefined ? `#${value.revision}` : ""}
                      <br />
                      {value.description}
                    </p>
                  ) : (
                    <p>
                      {tr(
                        "后端未返回此来源。",
                        "Backend did not return this source.",
                      )}
                    </p>
                  )}
                </section>
              );
            })}
          </div>
          {!!current.preview.length && (
            <pre className="workflow-resolve-preview">
              {current.preview.join("\n").slice(0, 100_000)}
            </pre>
          )}
          {current.status === "unresolved" &&
          executableStrategies(current).length ? (
            <label>
              {tr("当前文件的允许策略", "Allowed strategy for current file")}
              <select
                data-dialog-autofocus
                value={currentPlan ?? ""}
                onChange={(event) =>
                  setPlans((old) => ({
                    ...old,
                    [current.depotPath]: event.target.value
                      ? (event.target.value as ExecutableStrategy)
                      : undefined,
                  }))
                }
              >
                <option value="">
                  {tr("请选择策略", "Choose a strategy")}
                </option>
                {executableStrategies(current).map((strategy) => (
                  <option key={strategy} value={strategy}>
                    {strategyLabel(strategy, zh)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <DialogNotice error>
              {tr(
                "此文件没有后端允许的可执行策略，不能执行。",
                "No executable backend-approved strategy is available for this file.",
              )}
            </DialogNotice>
          )}
          {(currentPlan === "acceptYours" ||
            currentPlan === "acceptTheirs") && (
            <DialogNotice error>
              {tr(
                "选择一侧会丢弃另一侧修改，请逐文件核对来源。",
                "Choosing one side discards the other side's changes. Review the sources for this file.",
              )}
            </DialogNotice>
          )}
        </>
      )}
      {!result && <PreflightStatus state={status} zh={zh} />}
      {phase === "running" && (
        <DialogNotice>
          {tr(
            "后端正在逐文件执行并复核 unresolved 状态；关闭保护已启用。",
            "The backend is resolving each file and verifying unresolved state; closing is disabled.",
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
      {discard && (
        <section className="workflow-discard" role="alert">
          <p>
            {tr(
              "关闭会丢弃尚未执行的逐文件计划。",
              "Closing discards the unexecuted per-file plan.",
            )}
          </p>
          <button onClick={() => setDiscard(false)}>
            {tr("继续编辑", "Keep editing")}
          </button>
          <button onClick={onDismiss}>
            {tr("放弃计划并关闭", "Discard plan and close")}
          </button>
        </section>
      )}
    </Dialog>
  );
}
