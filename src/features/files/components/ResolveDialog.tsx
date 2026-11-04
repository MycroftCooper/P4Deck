import { useEffect, useRef, useState } from "react";
import { backend } from "../../../infrastructure/backend";
import type {
  ManualMergeSaveResult,
  ManualMergeSession,
  ManualMergeValidation,
  ResolveConfirmation,
  ResolveConflictDetail,
  ResolvePreflight,
  ResolvePreflightRequest,
  ResolveSelection,
  ResolveStats,
  ResolveStatsRequest,
  ResolveStrategy,
  ResolveVersionStats,
  WorkflowResult,
  WorkspaceNode,
} from "../../../shared/contracts";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { requestDesktopAttention } from "../../../app/notifications/notifications";
import { publishWorkflowResult } from "../../changelists/workflowRefresh";
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
type Phase = "idle" | "checking" | "ready" | "stale" | "running" | "failed";

/** The preflight IPC has no cancellation path; never leave the dialog stuck. */
export const RESOLVE_CHECK_TIMEOUT_MS = 30_000;

function executableStrategies(detail: ResolveConflictDetail) {
  return detail.availableStrategies.filter(
    (strategy): strategy is ExecutableStrategy => strategy !== "mergePreview",
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function pickConflictIndex(
  conflicts: ResolveConflictDetail[],
  previousIndex: number,
  resolvedPath?: string,
) {
  if (resolvedPath) {
    const at = conflicts.findIndex((item) => item.depotPath === resolvedPath);
    if (at >= 0) return at;
  }
  const after = conflicts.findIndex(
    (item, index) => index >= previousIndex && item.status === "unresolved",
  );
  if (after >= 0) return after;
  const first = conflicts.findIndex((item) => item.status === "unresolved");
  if (first >= 0) return first;
  return Math.min(previousIndex, Math.max(0, conflicts.length - 1));
}

const STRATEGIES: ExecutableStrategy[] = [
  "safe",
  "acceptYours",
  "acceptTheirs",
];
const RESOLVE_TYPES = [
  "content",
  "filetype",
  "branch",
  "move",
  "unknown",
] as const;
const RESOLVE_STATUSES = ["unresolved", "blocked", "unknown"] as const;

export function ResolveDialog({
  nodes,
  source,
  connectionKey,
  demo = false,
  zh,
  onDismiss,
  check = (value) => backend.preflightResolve(value),
  execute = (value) => backend.confirmResolve(value),
  resolveStats = (request) => backend.resolveStats(request),
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
  resolveStats?(request: ResolveStatsRequest): Promise<ResolveStats>;
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
  /**
   * A selection with already-resolved (not yet submitted) records and no
   * unresolved file must re-resolve with `p4 resolve -f`; mixed selections keep
   * the normal path because those files still have real unresolved conflicts.
   */
  const force =
    snapshot.nodes.some((node) => node.status?.resolve === "resolved") &&
    !snapshot.nodes.some((node) => node.status?.resolve === "unresolved");
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [preflight, setPreflight] = useState<ResolvePreflight>();
  const [result, setResult] = useState<WorkflowResult>();
  const [message, setMessage] = useState("");
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [externalBusy, setExternalBusy] = useState(false);
  const [statsByKey, setStatsByKey] = useState<
    Record<string, ResolveStats | null>
  >({});
  const generation = useRef(0);
  const running = useRef(false);
  const statsInFlight = useRef(new Set<string>());
  const autoInspected = useRef(false);
  const initialUnresolved = useRef<number | undefined>(undefined);
  const staleConnection = snapshot.connectionKey !== connectionKey;
  const sourceChanged =
    JSON.stringify(
      [
        ...new Set(nodes.map((node) => node.depotPath || node.absolutePath)),
      ].sort(),
    ) !== JSON.stringify([...paths].sort());
  const invalidated = staleConnection || sourceChanged;
  const busy = phase === "checking" || phase === "running";
  const conflicts = preflight?.conflicts ?? [];
  const current = conflicts[index];
  const baseSource = current?.sources.find((item) => item.role === "base");
  const sourceVersion = current?.sources.find((item) => item.role === "theirs");
  const statsKey = current
    ? JSON.stringify([
        current.depotPath,
        baseSource?.revision ?? null,
        sourceVersion?.revision ?? null,
      ])
    : undefined;
  const stats = statsKey ? statsByKey[statsKey] : undefined;
  const safeAvailable =
    !!current &&
    current.status === "unresolved" &&
    executableStrategies(current).includes("safe");
  // `safe` in the preflight is only a capability. The actual decision needs the
  // measured three-way conflict count: 0 conflicts means P4's -am can merge.
  const autoMergeable = safeAvailable && stats?.conflicts === 0;
  const statsRequest: ResolveStatsRequest | undefined = current
    ? {
        depotPath: current.depotPath,
        baseDepotPath: baseSource?.depotPath,
        baseRevision: baseSource?.revision,
        sourceDepotPath: sourceVersion?.depotPath,
        sourceRevision: sourceVersion?.revision,
        targetPath: current.clientPath ?? current.depotPath,
        ...(force ? { force: true } : {}),
      }
    : undefined;
  const expired = !!preflight && preflight.expiresAt <= Date.now();
  const executeReady =
    !!preflight &&
    preflight.ready &&
    !!preflight.token &&
    !preflight.blockers.length &&
    !expired &&
    !busy &&
    !invalidated;

  /** Reject malformed payloads instead of letting a bad row crash the dialog. */
  function validatePreflight(value: unknown): ResolvePreflight {
    const p = value as ResolvePreflight | undefined;
    const fail = (reason: string): never => {
      throw new Error(
        tr(
          `Resolve 数据无效：${reason}`,
          `Invalid resolve preflight payload: ${reason}`,
        ),
      );
    };
    if (!p || typeof p !== "object")
      fail(tr("未返回 Resolve 数据", "no resolve data returned"));
    if (
      !p!.target ||
      p!.target.kind !== "resolve" ||
      !Array.isArray(p!.target.depotPaths)
    )
      fail(tr("目标范围缺失", "missing resolve target"));
    if (
      !Array.isArray(p!.conflicts) ||
      !Array.isArray(p!.blockers) ||
      !Array.isArray(p!.warnings)
    )
      fail(
        tr("conflicts/blockers 不是数组", "conflicts/blockers are not arrays"),
      );
    if (!Number.isFinite(p!.expiresAt))
      fail(tr("缺少过期时间", "missing expiry"));
    const expected = [...paths].sort();
    if (
      JSON.stringify([...p!.target.depotPaths].sort()) !==
      JSON.stringify(expected)
    )
      fail(tr("目标文件范围不匹配", "target scope mismatch"));
    if (p!.ready && typeof p!.token !== "string")
      fail(tr("ready 但缺少 token", "ready without a token"));
    const allowed = new Set(expected);
    const seen = new Set<string>();
    const normalized = p!.conflicts.map((raw: unknown) => {
      const conflict = raw as Partial<ResolveConflictDetail> | undefined;
      if (
        !conflict ||
        typeof conflict !== "object" ||
        typeof conflict.depotPath !== "string" ||
        !conflict.depotPath
      )
        fail(tr("冲突缺少 depotPath", "conflict without depotPath"));
      const depotPath = conflict!.depotPath!;
      if (seen.has(depotPath))
        fail(
          tr(`重复的冲突文件 ${depotPath}`, `duplicate conflict ${depotPath}`),
        );
      seen.add(depotPath);
      if (!allowed.has(depotPath))
        fail(
          tr(
            `冲突不在目标范围内 ${depotPath}`,
            `conflict outside scope ${depotPath}`,
          ),
        );
      const sources = Array.isArray(conflict!.sources)
        ? conflict!.sources.filter((item) => !!item && typeof item === "object")
        : [];
      const strategies = Array.isArray(conflict!.availableStrategies)
        ? conflict!.availableStrategies.filter(
            (item): item is ResolveStrategy =>
              typeof item === "string" &&
              (STRATEGIES as string[]).concat("mergePreview").includes(item),
          )
        : [];
      const preview = Array.isArray(conflict!.preview)
        ? conflict!.preview.filter(
            (line): line is string => typeof line === "string",
          )
        : [];
      return {
        ...conflict,
        depotPath: conflict!.depotPath,
        status: RESOLVE_STATUSES.includes(
          conflict!.status as (typeof RESOLVE_STATUSES)[number],
        )
          ? (conflict!.status as ResolveConflictDetail["status"])
          : ("unknown" as const),
        conflictType: RESOLVE_TYPES.includes(
          conflict!.conflictType as (typeof RESOLVE_TYPES)[number],
        )
          ? (conflict!.conflictType as ResolveConflictDetail["conflictType"])
          : ("unknown" as const),
        availableStrategies: strategies,
        sources,
        preview,
      } as ResolveConflictDetail;
    });
    // Resolved files disappear from the next inspection; the target scope may
    // legitimately contain more paths than the still-unresolved conflicts.
    return { ...p!, conflicts: normalized };
  }

  async function inspect(selection?: {
    previousIndex?: number;
    resolvedPath?: string;
    advance?: boolean;
    initial?: boolean;
  }): Promise<boolean> {
    if (running.current || invalidated || !paths.length) return false;
    const epoch = ++generation.current;
    running.current = true;
    const previousIndex = selection?.previousIndex ?? index;
    setPhase("checking");
    setMessage("");
    setResult(undefined);

    try {
      const value = await withTimeout(
        check({ depotPaths: paths, force }),
        RESOLVE_CHECK_TIMEOUT_MS,
        tr(
          "读取冲突超时（30 秒）。请重试或检查连接。",
          "Conflict inspection timed out after 30 seconds. Retry or check the connection.",
        ),
      );
      if (epoch !== generation.current) return false;
      const next = validatePreflight(value);
      setPreflight(next);
      if (initialUnresolved.current === undefined)
        initialUnresolved.current = next.conflicts.filter(
          (item) => item.status === "unresolved",
        ).length;
      setChecked((previous) => {
        const unresolved = next.conflicts
          .filter((item) => item.status === "unresolved")
          .map((item) => item.depotPath);
        const kept = unresolved.filter((path) => previous.has(path));
        return new Set(kept.length ? kept : unresolved.slice(0, 1));
      });
      setIndex(
        selection?.initial
          ? 0
          : selection?.resolvedPath || selection?.advance
            ? pickConflictIndex(
                next.conflicts,
                previousIndex,
                selection.resolvedPath,
              )
            : Math.min(previousIndex, Math.max(0, next.conflicts.length - 1)),
      );
      // Opening a clean file asks for nothing: no conflict and no blocker means
      // there is no attention to request.
      if (next.conflicts.length || next.blockers.length)
        requestDesktopAttention({
          key: `resolve-preflight:${next.contentDigest}`,
          title: tr("Resolve 等待处理", "Resolve awaits attention"),
          body: next.blockers.length
            ? tr(
                `${next.blockers.length} 个 Resolve 阻断项需要处理。`,
                `${next.blockers.length} Resolve blocker(s) need review.`,
              )
            : tr(
                `${next.conflicts.filter((item) => item.status === "unresolved").length} 个冲突等待选择策略。`,
                `${next.conflicts.filter((item) => item.status === "unresolved").length} conflict(s) await a strategy.`,
              ),
          kind: "attention",
        });
      setPhase("ready");
      return true;
    } catch (cause) {
      if (epoch === generation.current) {
        setPreflight(undefined);
        setMessage(cause instanceof Error ? cause.message : String(cause));
        setPhase("failed");
      }
      return false;
    } finally {
      running.current = false;
    }
  }

  async function recoverMergeUnknown(
    operationId: string,
    currentResult?: MergeResolveActionResultLike,
  ) {
    // Same-operationId lookup only: never a fresh retry id, never an automatic re-execution.
    if (!mergeUncertain(currentResult) && currentResult) return false;
    try {
      const connection = await backend.companySubmitConnectionSnapshot();
      const found = await lookupMergeReceipt(operationId, connection);
      if (found.kind !== "found" || found.receipt.state !== "settled")
        return false;
      const recovered = found.receipt.result;
      if (!recovered) return false;
      const legacy = unwrapMergeLegacy<WorkflowResult>(recovered);
      if (mergeResolveSucceeded(recovered)) {
        if (legacy) setResult(legacy);
        setMessage(recovered.message);
        return true;
      }
      const remaining = mergeRemaining(recovered);
      if (remaining.length)
        setMessage(
          `${recovered.message} · ${tr("仍有未解决/未证实", "still unresolved/unproven")}: ${remaining.map((file) => file.depotPath).join(", ")}`,
        );
    } catch {
      /* A failed lookup is not permission to retry the write. */
    }
    return false;
  }

  /** Execute one confirmation immediately, then re-inspect the whole scope. */
  async function resolve(
    resolutions: ResolveSelection[],
    options: {
      label: string;
      previousIndex: number;
      resolvedPath?: string;
      advance?: boolean;
    },
  ) {
    if (!executeReady || !preflight?.token || !resolutions.length) return;
    const epoch = generation.current;
    running.current = true;
    setPhase("running");
    setMessage("");
    setResult(undefined);

    const operationId = crypto.randomUUID();
    beginMergeIntent({
      kind: "resolve",
      operationId,
      targetKey: connectionKey,
    });
    const fail = async (
      detail: string,
      attentionBody: string,
      recovered?: MergeResolveActionResultLike,
    ): Promise<void> => {
      settleMergeIntent(operationId);
      running.current = false;
      setPreflight(undefined);
      setMessage(detail);
      setPhase("failed");
      requestDesktopAttention({
        key: `resolve-result:${operationId}`,
        title: tr("Resolve 需要处理", "Resolve needs attention"),
        body: attentionBody,
        kind: "failure",
      });
      const recoveredOk = await recoverMergeUnknown(operationId, recovered);
      if (recoveredOk) {
        const checked = await inspect({
          previousIndex: options.previousIndex,
          resolvedPath: options.resolvedPath,
        });
        if (!checked) setMessage(detail);
        else
          setMessage(tr("已按回执确认解决。", "Resolved per durable receipt."));
      }
    };
    try {
      const raw: unknown = await execute({
        token: preflight.token,
        target: preflight.target,
        resolutions,
        operationId,
      } as never);
      if (epoch !== generation.current) return;
      const lifecycle = lifecycleOf(raw);
      const legacy =
        unwrapMergeLegacy<WorkflowResult>(raw) ?? (raw as WorkflowResult);
      if (lifecycle && lifecycle.state !== "legacy") {
        // Intent-only boundary: success may only come from committed per-file facts.
        if (!mergeResolveSucceeded(lifecycle)) {
          settleMergeIntent(operationId);
          setResult(legacy);
          const remaining = mergeRemaining(lifecycle);
          await fail(
            `${lifecycle.message}${
              remaining.length
                ? ` · ${tr("仍有未解决/未证实", "still unresolved/unproven")}: ${remaining.map((file) => file.depotPath).join(", ")}`
                : ""
            }`,
            lifecycle.message,
            lifecycle,
          );
          return;
        }
        settleMergeIntent(operationId);
        running.current = false;
        const done = `${options.label}: ${lifecycle.message}`;
        const checked = await inspect({
          previousIndex: options.previousIndex,
          resolvedPath: options.resolvedPath,
          advance: options.advance,
        });
        if (checked) setMessage(done);
        return;
      }
      // Legacy payload (mock / pre-S4c host).
      if (!legacy || !Array.isArray(legacy.files)) {
        await fail(
          tr(
            "Resolve 返回了无法识别的结果。",
            "Resolve returned an unknown result.",
          ),
          tr("Resolve 返回未知结果。", "Resolve returned an unknown result."),
        );
        return;
      }
      setResult(legacy);
      await publishWorkflowResult(legacy, preflight.target, connectionKey);
      const succeeded =
        legacy.outcome === "succeeded" &&
        legacy.files.length === resolutions.length &&
        legacy.files.every((file) => file.state === "succeeded");
      if (!succeeded) {
        await fail(legacy.message, legacy.message);
        return;
      }
      settleMergeIntent(operationId);
      running.current = false;
      const done = `${options.label}: ${legacy.message}`;
      const checked = await inspect({
        previousIndex: options.previousIndex,
        resolvedPath: options.resolvedPath,
        advance: options.advance,
      });
      if (checked) setMessage(done);
    } catch (cause) {
      settleMergeIntent(operationId);
      if (epoch !== generation.current) return;
      running.current = false;
      await fail(
        cause instanceof Error ? cause.message : String(cause),
        String(cause),
      );
    } finally {
      running.current = false;
    }
  }

  useEffect(() => {
    if (!invalidated) return;
    generation.current++;
    running.current = false;
    setPreflight(undefined);

    setMessage(
      tr(
        "连接或 Resolve 范围已改变，请刷新。",
        "Connection or Resolve scope changed; inspect again.",
      ),
    );
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
  // P4V opens with the file list loaded; inspect once on mount.
  useEffect(() => {
    if (autoInspected.current || preflight || invalidated || !paths.length)
      return;
    autoInspected.current = true;
    void inspect({ initial: true });
    // React StrictMode mounts effects twice in development. The first cleanup
    // invalidates the first inspection; reset the latch so the second mount
    // starts a fresh request instead of leaving the dialog stuck in "checking".
    return () => {
      autoInspected.current = false;
      generation.current++;
      running.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Read-only per-file detail for the version panes. Results are cached by
  // depotPath + base/source revisions; a late response for another file only
  // fills its own cache entry and never replaces the current pane.
  useEffect(() => {
    if (!current || !statsKey || !statsRequest) return;
    if (statsByKey[statsKey] !== undefined) return;
    if (statsInFlight.current.has(statsKey)) return;
    statsInFlight.current.add(statsKey);
    const key = statsKey;
    let cancelled = false;
    resolveStats(statsRequest)
      .then((value) => {
        if (cancelled) return;
        setStatsByKey((previous) => ({ ...previous, [key]: value }));
      })
      .catch(() => {
        if (cancelled) return;
        // Failure keeps the "not returned / pending" placeholders and does not
        // block the dialog; cache the miss so switching back does not loop.
        setStatsByKey((previous) => ({ ...previous, [key]: null }));
      })
      .finally(() => {
        statsInFlight.current.delete(key);
      });
    return () => {
      // Switching files or unmounting ignores this file's late response.
      cancelled = true;
      statsInFlight.current.delete(key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsKey]);

  const select = (next: number) => {
    setIndex(next);

    setMessage("");
  };
  const blockedReason = (conflict: ResolveConflictDetail | undefined) => {
    if (!conflict) return tr("没有可解决的文件", "No file to resolve");
    if (conflict.status === "blocked")
      return tr("后端标记为阻塞", "Blocked by backend");
    if (conflict.status === "unknown")
      return tr("冲突状态未知", "Conflict state unknown");
    if (!executableStrategies(conflict).length)
      return tr("没有可执行策略", "No executable strategy");
    return undefined;
  };
  const canManual =
    !demo &&
    !!current &&
    current.status === "unresolved" &&
    current.conflictType === "content" &&
    !busy &&
    !invalidated;

  const unresolvedConflicts = conflicts.filter(
    (conflict) => conflict.status === "unresolved",
  );
  const resolvedCount = Math.max(
    0,
    (initialUnresolved.current ?? unresolvedConflicts.length) -
      unresolvedConflicts.length,
  );
  const allChecked =
    unresolvedConflicts.length > 0 &&
    unresolvedConflicts.every((conflict) => checked.has(conflict.depotPath));
  const toggleChecked = (depotPath: string) => {
    setChecked((previous) => {
      const next = new Set(previous);
      if (next.has(depotPath)) next.delete(depotPath);
      else next.add(depotPath);
      return next;
    });
  };
  const toggleAll = () =>
    setChecked(
      allChecked
        ? new Set()
        : new Set(unresolvedConflicts.map((conflict) => conflict.depotPath)),
    );
  const actionReason = (strategy: ExecutableStrategy) => {
    const blocked = blockedReason(current);
    if (blocked) return blocked;
    if (!current) return tr("没有当前文件。", "No current file.");
    if (!executeReady) return tr("当前不能执行。", "Execution is unavailable.");
    if (!executableStrategies(current).includes(strategy))
      return tr("后端未批准此策略。", "Strategy is not approved by backend.");
    return undefined;
  };
  const canRun = (strategy: ExecutableStrategy) => !actionReason(strategy);
  const resolveCurrent = (strategy: ExecutableStrategy) => {
    if (!current || !canRun(strategy)) return;
    void resolve([{ depotPath: current.depotPath, strategy }], {
      label:
        strategy === "safe"
          ? tr("接受自动合并", "Accept auto-merge")
          : strategy === "acceptTheirs"
            ? tr("保留来源", "Keep source")
            : tr("保留本地", "Keep local"),
      previousIndex: index,
      resolvedPath: current.depotPath,
    });
  };

  async function openP4Merge() {
    if (!current || externalBusy || busy) return;
    setExternalBusy(true);
    setMessage("");
    try {
      const opened = await backend.openManualMerge({
        depotPath: current.depotPath,
        operationId: crypto.randomUUID(),
      });
      const session = unwrapMergeLegacy<ManualMergeSession>(opened);
      if (!session)
        throw new Error(
          tr("无法读取合并会话。", "Unable to open merge session."),
        );
      const external = await backend.runExternalMerge({
        sessionId: session.sessionId,
        result: session.result,
        operationId: crypto.randomUUID(),
      });
      if (external.status === "notInstalled")
        throw new Error(
          external.reason ??
            tr(
              "未检测到 P4Merge，请先安装/配置。",
              "P4Merge is not installed.",
            ),
        );
      if (external.status === "cancelled" || external.status === "timeout")
        throw new Error(
          external.reason ??
            tr("P4Merge 已取消或超时。", "P4Merge was cancelled or timed out."),
        );
      if (external.status !== "completed" && external.status !== "unchanged")
        throw new Error(
          external.reason ?? tr("P4Merge 执行失败。", "P4Merge failed."),
        );
      const merged =
        external.status === "completed"
          ? (external.result ?? session.result)
          : session.result;
      const validatedRaw = await backend.validateManualMerge({
        sessionId: session.sessionId,
        result: merged,
        operationId: crypto.randomUUID(),
      });
      const validation = unwrapMergeLegacy<ManualMergeValidation>(validatedRaw);
      if (!validation?.valid || !validation.token)
        throw new Error(
          validation?.message ??
            tr(
              "P4Merge 合并结果仍有未解决内容。",
              "The P4Merge result still has unresolved content.",
            ),
        );
      const savedRaw = await backend.confirmManualMergeSave({
        token: validation.token,
        sessionId: session.sessionId,
        resultDigest: validation.resultDigest,
        operationId: crypto.randomUUID(),
      });
      const saved = unwrapMergeLegacy<ManualMergeSaveResult>(savedRaw);
      if (!saved?.resolveToken)
        throw new Error(
          saved?.message ??
            tr("保存合并结果失败。", "Saving the merge result failed."),
        );
      const resolvedRaw = await backend.confirmManualMergeResolve({
        token: saved.resolveToken,
        sessionId: session.sessionId,
        resultDigest: saved.resultDigest,
        acknowledge: true,
        operationId: crypto.randomUUID(),
      });
      const resolved =
        unwrapMergeLegacy<WorkflowResult>(resolvedRaw) ??
        (resolvedRaw as WorkflowResult);
      if (resolved.outcome !== "succeeded") throw new Error(resolved.message);
      setResult(resolved);
      setMessage(resolved.message);
      if (preflight)
        await publishWorkflowResult(resolved, preflight.target, connectionKey);
      const checked = await inspect({
        previousIndex: index,
        resolvedPath: current.depotPath,
      });
      if (checked)
        setMessage(
          tr("P4Merge 合并完成。", "P4Merge merge completed.") +
            " " +
            resolved.message,
        );
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
      setPhase("failed");
    } finally {
      setExternalBusy(false);
    }
  }

  const statsBase = stats?.base;
  const statsSource = stats?.source;
  const statsTarget = stats?.target;
  const conflictBlocks = stats?.conflicts;
  const versionIdentity = (
    value: ResolveVersionStats | undefined,
    fallbackRevision?: number,
  ) => {
    const revision = value?.revision ?? fallbackRevision;
    const parts: string[] = [];
    if (revision !== undefined) parts.push(`#${revision}`);
    if (value?.change !== undefined) parts.push(`CL ${value.change}`);
    return parts.length ? parts.join(" · ") : tr("未返回", "not returned");
  };
  const localTime = (value?: string) => {
    if (!value) return tr("未返回", "not returned");
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
  };
  const versionMeta = (value: ResolveVersionStats | undefined) =>
    `${tr("提交人", "User")}: ${value?.user ?? tr("未返回", "not returned")} · ${tr("时间", "Time")}: ${localTime(value?.time)}`;
  const pathDetails = (value?: string, summaryLabel?: string) => {
    if (!value)
      return (
        <strong className="resolve-version-path">
          {tr("未返回", "not returned")}
        </strong>
      );
    return (
      <details className="resolve-path">
        <summary title={value}>{summaryLabel ?? tr("路径", "Path")}</summary>
        <p>{value}</p>
      </details>
    );
  };
  const diffBlocksText = (value?: number) =>
    value === undefined
      ? tr("与 base 差异块：待统计", "Diff blocks vs base: pending")
      : tr(`与 base 差异块：${value}`, `Diff blocks vs base: ${value}`);
  const targetBaseRevision = statsTarget?.baseRevision ?? baseSource?.revision;
  const mergedBefore =
    conflictBlocks === undefined
      ? tr("待统计", "pending")
      : tr(`${conflictBlocks} 个冲突块`, `${conflictBlocks} conflict block(s)`);
  const mergedAfter =
    conflictBlocks === undefined && !autoMergeable
      ? tr("待统计", "pending")
      : tr(
          `${autoMergeable ? 0 : conflictBlocks} 个冲突块`,
          `${autoMergeable ? 0 : conflictBlocks} conflict block(s)`,
        );

  return (
    <Dialog
      title={tr("解决文件合并", "Resolve files")}
      description={
        preflight
          ? tr(
              `待处理 ${unresolvedConflicts.length} · 已解决 ${resolvedCount}`,
              `${unresolvedConflicts.length} pending · ${resolvedCount} resolved`,
            )
          : tr("正在读取冲突…", "Reading conflicts…")
      }
      source={source}
      zh={zh}
      busy={busy}
      footer={null}
      hideFooter
      onRequestClose={onDismiss}
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
        {force && (
          <DialogNotice>
            {tr(
              "重新解决：基于上次解决结果再次解决（p4 resolve -f）；如需保留原始工作区内容，请先 revert 该文件。",
              "Re-resolve: resolves again on top of the previous resolution (p4 resolve -f). Revert first if you need the original workspace content.",
            )}
          </DialogNotice>
        )}
        <div className="resolve-merge">
          <aside className="resolve-sidebar">
            <div className="resolve-sidebar-head">
              <strong>{tr("文件", "Files")}</strong>
              <label>
                <input
                  type="checkbox"
                  checked={allChecked}
                  disabled={busy || !unresolvedConflicts.length}
                  onChange={toggleAll}
                />
                {tr("全选", "Select all")}
              </label>
            </div>
            <div className="resolve-list" role="list">
              {conflicts.map((conflict, conflictIndex) => {
                const name =
                  conflict.clientPath?.split(/[\\/]/).pop() ??
                  conflict.depotPath.split("/").pop() ??
                  conflict.depotPath;
                const safe =
                  conflict.status === "unresolved" &&
                  executableStrategies(conflict).includes("safe");
                const auto = conflictIndex === index && autoMergeable;
                const autoLabel = auto
                  ? tr("可自动合并", "Auto-mergeable")
                  : safe
                    ? tr("需检查冲突块", "Check conflict blocks")
                    : tr("需手工处理", "Manual");
                return (
                  <div
                    key={conflict.depotPath}
                    role="listitem"
                    className={
                      "resolve-list-item" +
                      (conflictIndex === index ? " is-current" : "")
                    }
                  >
                    <input
                      type="checkbox"
                      checked={checked.has(conflict.depotPath)}
                      disabled={busy || conflict.status !== "unresolved"}
                      onChange={() => toggleChecked(conflict.depotPath)}
                      aria-label={tr(`选择 ${name}`, `Select ${name}`)}
                    />
                    <button
                      type="button"
                      className="resolve-list-copy"
                      onClick={() => select(conflictIndex)}
                      disabled={busy}
                    >
                      <strong>{name}</strong>
                      <em className={auto ? "auto" : "manual"}>{autoLabel}</em>
                    </button>
                  </div>
                );
              })}
              {!conflicts.length && (
                <p className="resolve-list-empty">
                  {phase === "checking"
                    ? tr("正在读取冲突…", "Reading conflicts…")
                    : tr("没有冲突", "No conflicts")}
                </p>
              )}
            </div>
          </aside>
          <div className="resolve-preview">
            {current ? (
              <>
                <header className="resolve-preview-head">
                  <h3>
                    {current.clientPath?.split(/[\\/]/).pop() ??
                      current.depotPath.split("/").pop() ??
                      current.depotPath}
                  </h3>
                  {pathDetails(
                    current.clientPath ?? current.depotPath,
                    tr("路径", "Path"),
                  )}
                </header>
                <div className="resolve-base-card">
                  <span>{tr("Base · 共同基线", "Base")}</span>
                  {pathDetails(statsBase?.depotPath ?? baseSource?.depotPath)}
                  <small>
                    {versionIdentity(statsBase, baseSource?.revision)}
                  </small>
                  <small>
                    {statsBase?.description ||
                      baseSource?.description ||
                      tr("基线版本", "Base revision")}
                  </small>
                  <small className="resolve-version-meta">
                    {versionMeta(statsBase)}
                  </small>
                </div>
                <div className="resolve-source-grid">
                  <section className="resolve-version-card is-source">
                    <span>{tr("来源 · Depot", "Source · depot")}</span>
                    {pathDetails(
                      statsSource?.depotPath ?? sourceVersion?.depotPath,
                    )}
                    <small>
                      {versionIdentity(statsSource, sourceVersion?.revision)}
                    </small>
                    <small>
                      {statsSource?.description ||
                        sourceVersion?.description ||
                        tr("传入版本", "Incoming revision")}
                    </small>
                    <em>{diffBlocksText(statsSource?.diffBlocks)}</em>
                  </section>
                  <section className="resolve-version-card is-target">
                    <span>{tr("目标 · 本地", "Target · local")}</span>
                    {pathDetails(
                      statsTarget?.path ??
                        current.clientPath ??
                        current.depotPath,
                    )}
                    <small>
                      {tr(
                        `工作区修改 · 基于 #${targetBaseRevision ?? "—"}`,
                        `Workspace modification · based on #${targetBaseRevision ?? "—"}`,
                      )}
                    </small>
                    <em>{diffBlocksText(statsTarget?.diffBlocks)}</em>
                  </section>
                </div>
                <div className="resolve-merged-card">
                  <div className="resolve-merge-head">
                    <strong>{tr("合并", "Merge")}</strong>
                    <span>
                      {autoMergeable
                        ? tr("无剩余冲突", "No remaining conflicts")
                        : conflictBlocks !== undefined
                          ? tr("仍有冲突", "Conflicts remain")
                          : tr("冲突待统计", "Conflicts pending")}
                    </span>
                  </div>
                  <div className="resolve-merge-stats">
                    <div>
                      <span>{tr("自动合并前", "Before auto-merge")}</span>
                      <strong>{mergedBefore}</strong>
                    </div>
                    <span className="resolve-merge-arrow">→</span>
                    <div>
                      <span>{tr("自动合并后", "After auto-merge")}</span>
                      <strong>{mergedAfter}</strong>
                    </div>
                  </div>
                  <p>
                    {autoMergeable
                      ? tr(
                          "已自动处理冲突块，可接受自动合并结果。",
                          "Conflict blocks were auto-resolved; accept the merged result.",
                        )
                      : tr(
                          "需要选择保留一侧，或打开合并工具处理。",
                          "Choose one side, or open the merge tool.",
                        )}
                  </p>
                </div>
                <div className="resolve-action-row">
                  <div>
                    <strong>{tr("保留双方修改", "Keep both changes")}</strong>
                    <p>
                      {tr(
                        "接受自动合并生成的结果。",
                        "Accept the auto-merged result.",
                      )}
                    </p>
                  </div>
                  <button
                    className="primary"
                    disabled={!autoMergeable}
                    title={
                      !safeAvailable
                        ? tr(
                            "后端未提供自动合并策略。",
                            "Auto-merge is not offered by the backend.",
                          )
                        : conflictBlocks === undefined
                          ? tr(
                              "正在统计冲突块，请稍候。",
                              "Measuring conflict blocks; please wait.",
                            )
                          : conflictBlocks > 0
                            ? tr(
                                "仍有冲突块，不能直接接受自动合并。",
                                "Conflict blocks remain; auto-merge cannot be accepted.",
                              )
                            : undefined
                    }
                    onClick={() => resolveCurrent("safe")}
                  >
                    {tr("接受自动合并", "Accept auto-merge")}
                  </button>
                </div>
                <div className="resolve-action-row">
                  <div>
                    <strong>{tr("仅保留来源", "Keep source only")}</strong>
                    <p>
                      {tr(
                        "用来源替换本地，舍弃本地独有修改。",
                        "Replace local with source; discard local-only changes.",
                      )}
                    </p>
                  </div>
                  <button
                    className="secondary"
                    disabled={!canRun("acceptTheirs")}
                    title={actionReason("acceptTheirs")}
                    onClick={() => resolveCurrent("acceptTheirs")}
                  >
                    {tr("保留来源", "Keep source")}
                  </button>
                </div>
                <div className="resolve-action-row">
                  <div>
                    <strong>{tr("仅保留本地", "Keep local only")}</strong>
                    <p>
                      {tr(
                        "保留本地内容，舍弃来源独有修改。",
                        "Keep local content; discard source-only changes.",
                      )}
                    </p>
                  </div>
                  <button
                    className="secondary"
                    disabled={!canRun("acceptYours")}
                    title={actionReason("acceptYours")}
                    onClick={() => resolveCurrent("acceptYours")}
                  >
                    {tr("保留本地", "Keep local")}
                  </button>
                </div>
                <div className="resolve-action-row">
                  <div>
                    <strong>{tr("手工合并", "Manual merge")}</strong>
                    <p>
                      {tr(
                        "使用合并工具逐处检查并处理。",
                        "Inspect and merge each location with the merge tool.",
                      )}
                    </p>
                  </div>
                  <button
                    className="secondary"
                    disabled={!canManual || externalBusy}
                    onClick={() => void openP4Merge()}
                  >
                    {externalBusy
                      ? tr("正在打开 P4Merge…", "Opening P4Merge…")
                      : tr("打开 P4Merge…", "Open P4Merge…")}
                  </button>
                </div>
              </>
            ) : (
              <div className="resolve-preview-empty">
                {phase === "checking" ? (
                  tr("正在读取冲突…", "Reading conflicts…")
                ) : (
                  <>
                    <strong>{tr("没有冲突", "No conflicts")}</strong>
                    <small>
                      {tr(
                        "所选文件没有待解决的冲突。",
                        "No unresolved conflicts in the selected files.",
                      )}
                    </small>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        {result && phase !== "running" && (
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
        {phase === "running" && (
          <DialogNotice>
            {tr(
              "正在对当前选择执行 Resolve，并会重新读取全部文件。",
              "Resolving the current selection; the full scope will be read again.",
            )}
          </DialogNotice>
        )}
        {message && phase !== "running" && (phase === "failed" || !result) && (
          <DialogNotice error={phase === "failed"}>{message}</DialogNotice>
        )}
      </div>
    </Dialog>
  );
}
