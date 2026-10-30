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
} from "../../../shared/contracts";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import {
  PreflightStatus,
  type PreflightState,
} from "../../../app/dialogs/PreflightStatus";
import { requestDesktopAttention } from "../../../app/notifications/notifications";
import { publishWorkflowResult } from "../../changelists/workflowRefresh";
import { ManualMergeEditor } from "./ManualMergeEditor";
import {
  beginMergeIntent,
  lifecycleOf,
  lookupMergeReceipt,
  mergeRemaining,
  mergeResolveSucceeded,
  mergeUncertain,
  settleMergeIntent,
  unwrapMergeLegacy,
  type MergeResolveActionResultLike,
} from "../../actions/mergeResolveLifecycle";

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
  execute?(
    confirmation: ResolveConfirmation,
  ): Promise<WorkflowResult | unknown>;
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
  const [method, setMethod] = useState<"interactive" | "auto">("interactive");
  const [manualPath, setManualPath] = useState<string>();
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
    setManualPath(undefined);
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
      requestDesktopAttention({
        key: `resolve-preflight:${value.contentDigest}`,
        title: tr("Resolve 等待处理", "Resolve awaits attention"),
        body: value.blockers.length
          ? tr(
              `${value.blockers.length} 个 Resolve 阻断项需要检查。`,
              `${value.blockers.length} Resolve blocker(s) need review.`,
            )
          : tr(
              `${value.conflicts.length} 个冲突等待选择策略。`,
              `${value.conflicts.length} conflict(s) await a strategy.`,
            ),
        kind: "attention",
      });
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

  async function recoverMergeUnknown(
    operationId: string,
    currentResult?: MergeResolveActionResultLike,
  ) {
    // Same-operationId lookup only: never a fresh retry id, never an automatic re-execution.
    if (!mergeUncertain(currentResult) && currentResult) return;
    try {
      const connection = await backend.companySubmitConnectionSnapshot();
      const found = await lookupMergeReceipt(operationId, connection);
      if (found.kind !== "found" || found.receipt.state !== "settled") return;
      const recovered = found.receipt.result;
      if (!recovered) return;
      const legacy = unwrapMergeLegacy<WorkflowResult>(recovered);
      if (mergeResolveSucceeded(recovered)) {
        if (legacy) setResult(legacy);
        setMessage(recovered.message);
        setPhase("success");
        return;
      }
      const remaining = mergeRemaining(recovered);
      if (remaining.length)
        setMessage(
          `${recovered.message} · ${tr("仍有未解决/未证实", "still unresolved/unproven")}: ${remaining.map((file) => file.depotPath).join(", ")}`,
        );
    } catch {
      /* A failed lookup is not permission to retry the write. */
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
    const operationId = crypto.randomUUID();
    beginMergeIntent({
      kind: "resolve",
      operationId,
      targetKey: connectionKey,
    });
    try {
      const raw: unknown = await execute({
        token: preflight.token,
        target: preflight.target,
        resolutions: preflight.conflicts.map((conflict) => ({
          depotPath: conflict.depotPath,
          strategy: plans[conflict.depotPath]!,
        })),
        operationId,
      } as never);
      if (epoch !== generation.current) return;
      settleMergeIntent(operationId);
      const lifecycle = lifecycleOf(raw);
      const legacy =
        unwrapMergeLegacy<WorkflowResult>(raw) ?? (raw as WorkflowResult);
      if (lifecycle && lifecycle.state !== "legacy") {
        // Intent-only boundary: success may only come from committed per-file facts.
        const succeeded = mergeResolveSucceeded(lifecycle);
        setResult(legacy);
        const remaining = mergeRemaining(lifecycle);
        setMessage(
          succeeded
            ? lifecycle.message
            : `${lifecycle.message}${
                remaining.length
                  ? ` · ${tr("仍有未解决/未证实", "still unresolved/unproven")}: ${remaining.map((file) => file.depotPath).join(", ")}`
                  : ""
              }`,
        );
        setPhase(succeeded ? "success" : "failed");
        if (!succeeded) {
          requestDesktopAttention({
            key: `resolve-result:${lifecycle.operationId ?? operationId}`,
            title: tr("Resolve 需要处理", "Resolve needs attention"),
            body: lifecycle.message,
            kind: "failure",
          });
          await recoverMergeUnknown(operationId, lifecycle);
          setPreflight(undefined);
        }
        // Wired lifecycle: no legacy publishWorkflow* refresh (zero double-send).
        return;
      }
      // Legacy payload (host did not run the S4c lifecycle for this call).
      setResult(legacy);
      setMessage(legacy.message);
      const succeeded =
        legacy.outcome === "succeeded" &&
        legacy.files.length === preflight.conflicts.length &&
        legacy.files.every((file) => file.state === "succeeded");
      setPhase(succeeded ? "success" : "failed");
      if (!succeeded)
        requestDesktopAttention({
          key: `resolve-result:${legacy.logReference ?? legacy.outcome}`,
          title: tr("Resolve 需要处理", "Resolve needs attention"),
          body: legacy.message,
          kind: "failure",
        });
      await publishWorkflowResult(legacy, preflight.target, connectionKey);
      if (!succeeded) setPreflight(undefined);
    } catch (cause) {
      settleMergeIntent(operationId);
      // The host persists state=unknown before returning Err when an operationId was supplied.
      if (epoch === generation.current) {
        setMessage(String(cause));
        setPhase("failed");
        setPreflight(undefined);
        await recoverMergeUnknown(operationId);
      }
    } finally {
      running.current = false;
    }
  }

  const select = (next: number) => {
    setIndex(next);
    setManualPath(undefined);
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

  const resolveTypeLabel = (
    type: "content" | "filetype" | "branch" | "move" | "unknown",
  ) =>
    ({
      content: tr("内容", "content"),
      filetype: tr("文件类型", "filetype"),
      branch: tr("分支", "branch"),
      move: tr("移动", "move"),
      unknown: tr("未知", "unknown"),
    })[type];
  const planFor = (strategy: ExecutableStrategy) => {
    if (!current || current.status !== "unresolved") return;
    setPlans((old) => ({ ...old, [current.depotPath]: strategy }));
  };
  const canPlan = (strategy: ExecutableStrategy) =>
    !!current &&
    current.status === "unresolved" &&
    executableStrategies(current).includes(strategy) &&
    !busy &&
    !invalidated;
  const canManual =
    !!current &&
    current.status === "unresolved" &&
    current.conflictType === "content" &&
    !demo &&
    !busy &&
    !invalidated;

  // P4V-style "auto resolve multiple files": only backend-approved safe merges are auto-planned.
  useEffect(() => {
    if (method !== "auto" || !preflight || phase !== "ready") return;
    const next: Record<string, ExecutableStrategy | undefined> = {};
    for (const conflict of preflight.conflicts) {
      if (conflict.status !== "unresolved") continue;
      const allowed = executableStrategies(conflict);
      if (allowed.includes("safe")) next[conflict.depotPath] = "safe";
    }
    setPlans(next);
  }, [method, preflight, phase]);

  // P4V opens with the file list already loaded; inspect once on mount instead of an empty table.
  const autoInspected = useRef(false);
  useEffect(() => {
    if (autoInspected.current || preflight || invalidated || !paths.length)
      return;
    autoInspected.current = true;
    void inspect();
  });

  return (
    <Dialog
      title={tr("解决冲突（Resolve）", "Resolve")}
      description={
        preflight
          ? preflight.target.client +
            ", " +
            preflight.target.server +
            ", " +
            preflight.target.user
          : tr(
              "打开后自动检查冲突；blocked / unknown 文件不会执行。",
              "Conflicts are inspected automatically. Blocked or unknown files never execute.",
            )
      }
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
            disabled={
              phase !== "ready" ||
              !preflight?.token ||
              !allExecutable ||
              !!manualPath
            }
            onClick={() => void confirm()}
          >
            {tr("执行逐文件计划", "Run per-file plan")}
          </button>
        </>
      }
    >
      <div className="resolve-p4v">
        {demo && (
          <DialogNotice>
            {tr(
              "浏览器 Mock 只返回未知冲突并保持阻塞，不访问真实 P4 Server。",
              "Browser Mock returns unknown conflicts and keeps execution blocked; it does not access a real P4 server.",
            )}
          </DialogNotice>
        )}
        <div className="resolve-row">
          <span className="resolve-row-label">
            {tr("Resolve 方式", "Resolve method")}:
          </span>
          <div className="resolve-row-control resolve-methods">
            <label>
              <input
                type="radio"
                name="resolve-method"
                checked={method === "auto"}
                disabled={busy}
                onChange={() => setMethod("auto")}
              />
              {tr("自动解决多个文件", "Auto resolve multiple files")}
            </label>
            <label>
              <input
                type="radio"
                name="resolve-method"
                checked={method === "interactive"}
                disabled={busy}
                onChange={() => setMethod("interactive")}
              />
              {tr(
                "交互式逐个解决文件",
                "Interactively resolve files one at a time",
              )}
            </label>
          </div>
        </div>
        <div className="resolve-row">
          <span className="resolve-row-label">
            {tr("行尾与空白选项", "Line ending and whitespace options")}
          </span>
          <select
            className="resolve-select"
            disabled
            title={tr(
              "后端当前固定按此规则比较；暂不支持切换。",
              "The backend always compares with this rule; switching is not supported yet.",
            )}
          >
            <option>
              {tr(
                "识别行尾与空白差异",
                "Recognize line ending and white space differences",
              )}
            </option>
          </select>
        </div>
        <section
          className="resolve-files"
          aria-label={tr("待解决文件", "Files to resolve")}
        >
          <div className="resolve-files-head">
            <span>{tr("待解决文件", "Files to resolve")}:</span>
            <span className="resolve-files-count">
              {current ? index + 1 : 0}/
              {preflight?.conflicts.length ?? paths.length}
            </span>
          </div>
          <div className="resolve-file-table" role="table">
            <div role="row" className="resolve-file-row resolve-file-head">
              <span role="columnheader">
                {tr("Resolve（目标）", "Resolve (target)")}
              </span>
              <span role="columnheader">
                {tr("Resolve With（来源）", "Resolve with (source)")}
              </span>
              <span role="columnheader">
                {tr("Resolve Type", "Resolve type")}
              </span>
            </div>
            {(preflight?.conflicts ?? []).map((conflict, conflictIndex) => {
              const source =
                conflict.sources.find((item) => item.role === "theirs") ??
                conflict.sources.find((item) => item.role === "merge");
              const plan = plans[conflict.depotPath];
              return (
                <button
                  type="button"
                  role="row"
                  key={conflict.depotPath}
                  className={
                    "resolve-file-row" +
                    (conflictIndex === index ? " is-current" : "")
                  }
                  onClick={() => select(conflictIndex)}
                  disabled={busy}
                >
                  <span role="cell" title={conflict.depotPath}>
                    {conflict.clientPath ?? conflict.depotPath}
                    {plan ? " · " + strategyLabel(plan, zh) : ""}
                  </span>
                  <span role="cell" title={source?.depotPath ?? ""}>
                    {source?.depotPath ??
                      tr("后端未返回来源", "Source not returned")}
                  </span>
                  <span role="cell">
                    {resolveTypeLabel(conflict.conflictType)}
                  </span>
                </button>
              );
            })}
            {!preflight &&
              paths.map((path) => (
                <div
                  role="row"
                  key={path}
                  className="resolve-file-row resolve-file-placeholder"
                >
                  <span role="cell" title={path}>
                    {path}
                  </span>
                  <span role="cell">
                    {busy
                      ? tr("正在读取冲突…", "Inspecting conflicts…")
                      : tr("检查后读取来源", "Source loads after inspection")}
                  </span>
                  <span role="cell">{tr("待检查", "pending")}</span>
                </div>
              ))}
          </div>
        </section>
        <label className="resolve-checkbox">
          <input type="checkbox" disabled />
          {tr(
            "将二进制文件按文本合并",
            "Merge binary files as text when resolving content",
          )}
        </label>
        {current && (
          <section
            className="resolve-current"
            aria-label={tr("当前文件", "Current file")}
          >
            <div className="resolve-recommended">
              <strong>{tr("推荐操作", "Recommended action")}:</strong>{" "}
              {current.status !== "unresolved"
                ? tr(
                    "此文件当前不可执行，请先核对阻塞原因。",
                    "This file cannot execute now; review its blockers first.",
                  )
                : current.conflictType === "content"
                  ? tr(
                      "可在合并工具中逐段查看差异，或直接接受某一侧（会丢弃另一侧修改）。",
                      "Review differences in the merge tool, or accept one side (the other side is discarded).",
                    )
                  : tr(
                      "该冲突类型只能接受来源或目标；请先确认文件类型/分支影响。",
                      "This conflict type only supports accepting source or target; check filetype/branch impact first.",
                    )}
            </div>
            <div className="workflow-version-grid resolve-versions">
              {(["base", "yours", "theirs"] as const).map((role) => {
                const value = current.sources.find(
                  (item) => item.role === role,
                );
                const label = {
                  base: tr("共同基线", "Common base"),
                  yours: tr("目标文件", "Target file"),
                  theirs: tr("来源文件", "Source file"),
                }[role];
                return (
                  <section key={role} aria-label={label}>
                    <h4>{label}</h4>
                    {value ? (
                      <p>
                        {value.depotPath ?? current.depotPath}
                        {value.revision !== undefined
                          ? "#" + value.revision
                          : ""}
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
            {manualPath === current.depotPath ? (
              <>
                <button
                  className="secondary"
                  onClick={() => setManualPath(undefined)}
                  disabled={busy}
                >
                  {tr("返回策略选择", "Back to strategy choices")}
                </button>
                <ManualMergeEditor
                  depotPath={current.depotPath}
                  connectionKey={connectionKey}
                  zh={zh}
                  onFinished={async (value) => {
                    setResult(value);
                    setMessage(value.message);
                    setPhase(
                      value.outcome === "succeeded" ? "success" : "failed",
                    );
                    await publishWorkflowResult(
                      value,
                      preflight.target,
                      connectionKey,
                    );
                  }}
                />
              </>
            ) : (
              <>
                <div className="resolve-options">
                  <span className="resolve-options-title">
                    {tr("Resolve 选项", "Resolve options")}:
                  </span>
                  <div className="resolve-option-row">
                    <span>
                      {tr(
                        "用来源文件替换目标文件",
                        "Replace target file with source",
                      )}
                    </span>
                    <button
                      className="secondary"
                      disabled={!canPlan("acceptTheirs")}
                      onClick={() => planFor("acceptTheirs")}
                    >
                      {tr("接受来源", "Accept Source")}
                    </button>
                  </div>
                  <div className="resolve-option-row">
                    <span>
                      {tr(
                        "保留目标文件不变",
                        "Leave the target file unchanged",
                      )}
                    </span>
                    <button
                      className="secondary"
                      disabled={!canPlan("acceptYours")}
                      onClick={() => planFor("acceptYours")}
                    >
                      {tr("接受目标", "Accept Target")}
                    </button>
                  </div>
                  <div className="resolve-option-row">
                    <span>
                      {tr(
                        "使用后端安全合并结果",
                        "Use the backend safe merge result",
                      )}
                    </span>
                    <button
                      className="secondary"
                      disabled={!canPlan("safe")}
                      onClick={() => planFor("safe")}
                    >
                      {tr("接受合并结果", "Accept Merged")}
                    </button>
                  </div>
                  <div className="resolve-option-row">
                    <span>
                      {tr(
                        "手工合并来源和目标后接受",
                        "Manually merge source and target",
                      )}
                    </span>
                    <button
                      className="secondary"
                      disabled={!canManual}
                      onClick={() => setManualPath(current.depotPath)}
                    >
                      {tr("运行合并工具…", "Run Merge Tool…")}
                    </button>
                  </div>
                </div>
                <details className="resolve-additional">
                  <summary>{tr("其他操作 ▾", "Additional Actions ▾")}</summary>
                  <button
                    className="secondary"
                    disabled={busy || !preflight}
                    onClick={() => {
                      if (!preflight) return;
                      const next = { ...plans };
                      for (const conflict of preflight.conflicts) {
                        if (
                          conflict.status === "unresolved" &&
                          executableStrategies(conflict).includes("acceptYours")
                        )
                          next[conflict.depotPath] = "acceptYours";
                      }
                      setPlans(next);
                    }}
                  >
                    {tr("全部接受目标", "Accept target for all")}
                  </button>
                  <button
                    className="secondary"
                    disabled={busy || !preflight}
                    onClick={() => {
                      if (!preflight) return;
                      const next = { ...plans };
                      for (const conflict of preflight.conflicts) {
                        if (
                          conflict.status === "unresolved" &&
                          executableStrategies(conflict).includes(
                            "acceptTheirs",
                          )
                        )
                          next[conflict.depotPath] = "acceptTheirs";
                      }
                      setPlans(next);
                    }}
                  >
                    {tr("全部接受来源", "Accept source for all")}
                  </button>
                </details>
              </>
            )}
          </section>
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
                {result.failure ? " · " + result.failure : ""} ·{" "}
                {result.refresh.reason}
              </DialogNotice>
            )}
            {!!result.operationIds.length && (
              <p className="workflow-context">
                {tr("操作记录", "Operations")} {result.operationIds.join(", ")}
                {result.logReference
                  ? " · " + tr("日志", "Log") + " " + result.logReference
                  : ""}
              </p>
            )}
            {result.files.map((file) => (
              <DialogNotice
                key={file.depotPath}
                error={file.state !== "succeeded"}
              >
                {file.state} · {file.depotPath} · {file.message}
              </DialogNotice>
            ))}
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
      </div>
    </Dialog>
  );
}
