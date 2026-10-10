import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogNotice } from "../../app/dialogs/Dialog";
import { PreflightStatus } from "../../app/dialogs/PreflightStatus";
import { backend } from "../../infrastructure/backend";
import type {
  BranchMappingDetail,
  BranchMappingDraft,
  BranchMutationMode,
  BranchMutationPreflight,
  BranchMutationResult,
  BranchViewLine,
  RuntimeInfo,
} from "../../shared/contracts/types";
import { validateBranchDraft, validateBranchView } from "./branchMappingModel";

type Phase = "edit" | "checking" | "review" | "running" | "result";

const blankLine = (): BranchViewLine => ({
  modifier: "map",
  source: "",
  target: "",
});

function initialDraft(
  mode: BranchMutationMode,
  detail: BranchMappingDetail | undefined,
  owner: string,
): BranchMappingDraft | undefined {
  if (mode === "delete") return undefined;
  if (mode === "edit" && detail)
    return {
      name: detail.name,
      owner: detail.owner,
      description: detail.description,
      locked: detail.locked,
      view: detail.view.map((line) => ({ ...line })),
    };
  return {
    name: "",
    owner,
    description: "",
    locked: false,
    view: [blankLine()],
  };
}

export function BranchMappingMutationDialog({
  mode,
  detail,
  runtime,
  connectionKey,
  source,
  zh,
  onDismiss,
  onResult,
}: {
  mode: BranchMutationMode;
  detail?: BranchMappingDetail;
  runtime: RuntimeInfo;
  connectionKey: string;
  source: HTMLElement | null;
  zh: boolean;
  onDismiss(): void;
  onResult(result: BranchMutationResult, selectedName?: string): void;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [draft, setDraft] = useState(() =>
    initialDraft(mode, detail, runtime.context.user),
  );
  const [phase, setPhase] = useState<Phase>("edit");
  const [preflight, setPreflight] = useState<BranchMutationPreflight>();
  const [result, setResult] = useState<BranchMutationResult>();
  const [error, setError] = useState("");
  const [acknowledgeDelete, setAcknowledgeDelete] = useState(false);
  const sequence = useRef(0);
  const activeOperation = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const connection = useRef(connectionKey);
  connection.current = connectionKey;
  const name = mode === "create" ? (draft?.name ?? "") : (detail?.name ?? "");
  const draftIssues = useMemo(
    () => (draft ? validateBranchDraft(draft) : []),
    [draft],
  );
  const lineIssues = useMemo(
    () => (draft ? validateBranchView(draft.view) : []),
    [draft],
  );
  const lineIssueMap = useMemo(
    () => new Map(lineIssues.map((issue) => [issue.index, issue.messages])),
    [lineIssues],
  );
  const editingBlocked = mode === "edit" && detail?.editable !== true;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current += 1;
      if (activeOperation.current)
        void backend.cancelOperation(activeOperation.current);
    };
  }, []);

  useEffect(() => {
    sequence.current += 1;
    if (activeOperation.current)
      void backend.cancelOperation(activeOperation.current);
    activeOperation.current = undefined;
    setError("");
    setPreflight(undefined);
    setResult(undefined);
    setPhase("edit");
  }, [connectionKey]);

  useEffect(() => {
    if (phase !== "review" || !preflight) return;
    const timeout = window.setTimeout(
      () => {
        setPreflight(undefined);
        setAcknowledgeDelete(false);
        setError(
          tr(
            "预检已过期，请重新检查 Branch Mapping。",
            "The preflight expired; inspect the Branch Mapping again.",
          ),
        );
        setPhase("edit");
      },
      Math.min(2147483647, Math.max(0, preflight.expiresAt - Date.now())),
    );
    return () => window.clearTimeout(timeout);
  }, [phase, preflight, zh]);

  const updateLine = (index: number, value: BranchViewLine) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            view: current.view.map((line, row) =>
              row === index ? value : line,
            ),
          }
        : current,
    );

  const moveLine = (index: number, delta: -1 | 1) =>
    setDraft((current) => {
      if (!current) return current;
      const target = index + delta;
      if (target < 0 || target >= current.view.length) return current;
      const view = [...current.view];
      [view[index], view[target]] = [view[target], view[index]];
      return { ...current, view };
    });

  async function runPreflight() {
    if (
      phase === "checking" ||
      phase === "running" ||
      editingBlocked ||
      !name ||
      draftIssues.length ||
      lineIssues.length
    )
      return;
    const seq = ++sequence.current;
    const expectedConnection = connectionKey;
    const operationId = crypto.randomUUID();
    activeOperation.current = operationId;
    setPhase("checking");
    setError("");
    setResult(undefined);
    setPreflight(undefined);
    setAcknowledgeDelete(false);
    try {
      const value = await backend.preflightBranchMappingMutation({
        mode,
        name,
        desired: mode === "delete" ? undefined : draft,
        operationId,
      });
      if (
        !mounted.current ||
        seq !== sequence.current ||
        connection.current !== expectedConnection
      )
        return;
      setPreflight(value);
      setPhase("review");
    } catch (cause) {
      if (mounted.current && seq === sequence.current) {
        setError(String(cause));
        setPhase("edit");
      }
    } finally {
      if (seq === sequence.current) activeOperation.current = undefined;
    }
  }

  async function confirm() {
    if (
      phase !== "review" ||
      !preflight?.ready ||
      !preflight.token ||
      !preflight.target ||
      preflight.expiresAt <= Date.now() ||
      (mode === "delete" && !acknowledgeDelete)
    )
      return;
    const seq = ++sequence.current;
    const expectedConnection = connectionKey;
    const operationId = crypto.randomUUID();
    activeOperation.current = operationId;
    setPhase("running");
    setError("");
    try {
      const value = await backend.confirmBranchMappingMutation({
        token: preflight.token,
        target: preflight.target,
        previewDigest: preflight.previewDigest,
        acknowledgeDangerousDelete: mode === "delete" && acknowledgeDelete,
        operationId,
      });
      if (
        !mounted.current ||
        seq !== sequence.current ||
        connection.current !== expectedConnection
      )
        return;
      setResult(value);
      setPhase("result");
      if (value.refreshBranchMappings || value.outcome === "succeeded")
        onResult(
          value,
          value.outcome === "succeeded" && mode !== "delete"
            ? preflight.name
            : undefined,
        );
    } catch (cause) {
      if (!mounted.current || seq !== sequence.current) return;
      setError(String(cause));
      setPhase("result");
    } finally {
      if (seq === sequence.current) activeOperation.current = undefined;
    }
  }

  function reset() {
    sequence.current += 1;
    if (activeOperation.current)
      void backend.cancelOperation(activeOperation.current);
    activeOperation.current = undefined;
    setPreflight(undefined);
    setResult(undefined);
    setError("");
    setAcknowledgeDelete(false);
    setPhase("edit");
  }

  const title =
    mode === "create"
      ? tr("创建 Branch Mapping", "Create Branch Mapping")
      : mode === "edit"
        ? tr("编辑 Branch Mapping", "Edit Branch Mapping")
        : tr("删除 Branch Mapping", "Delete Branch Mapping");
  const busy = phase === "checking" || phase === "running";
  const preflightState = busy
    ? ({ kind: "checking" } as const)
    : error
      ? ({ kind: "failed", message: error } as const)
      : preflight
        ? ({
            kind: preflight.ready ? "ready" : "blocked",
            blockers: preflight.blockers.map((issue) => issue.message),
            warnings: preflight.warnings.map((issue) => issue.message),
          } as const)
        : ({ kind: "idle" } as const);

  return (
    <Dialog
      title={title}
      description={tr(
        "所有写入只经专用预检和一次性确认令牌；不会使用 force，也不会执行 integrate。",
        "Every write uses the dedicated preflight and one-use confirmation token. P4Deck never forces the change or runs integrate here.",
      )}
      source={source}
      zh={zh}
      danger={mode === "delete"}
      busy={busy}
      onRequestClose={() => {
        if (busy && activeOperation.current)
          void backend.cancelOperation(activeOperation.current);
        else onDismiss();
      }}
      footer={
        <>
          {phase === "edit" && (
            <>
              <button onClick={onDismiss}>{tr("取消", "Cancel")}</button>
              <button
                className={mode === "delete" ? "danger" : "primary"}
                data-dialog-autofocus
                disabled={
                  editingBlocked ||
                  !name ||
                  !!draftIssues.length ||
                  !!lineIssues.length
                }
                onClick={() => void runPreflight()}
              >
                {tr("预检并审阅", "Preflight and review")}
              </button>
            </>
          )}
          {phase === "checking" && (
            <button
              onClick={() =>
                activeOperation.current &&
                backend.cancelOperation(activeOperation.current)
              }
            >
              {tr("取消预检", "Cancel preflight")}
            </button>
          )}
          {phase === "review" && (
            <>
              <button onClick={reset}>{tr("返回编辑", "Back to edit")}</button>
              <button
                className={mode === "delete" ? "danger" : "primary"}
                disabled={
                  !preflight?.ready ||
                  !preflight.token ||
                  !preflight.target ||
                  preflight.expiresAt <= Date.now() ||
                  (mode === "delete" && !acknowledgeDelete)
                }
                onClick={() => void confirm()}
              >
                {mode === "delete"
                  ? tr("确认永久删除", "Confirm permanent delete")
                  : tr("确认保存", "Confirm save")}
              </button>
            </>
          )}
          {phase === "running" && (
            <button
              onClick={() =>
                activeOperation.current &&
                backend.cancelOperation(activeOperation.current)
              }
            >
              {tr("取消操作", "Cancel operation")}
            </button>
          )}
          {phase === "result" && (
            <>
              <button onClick={onDismiss}>{tr("关闭", "Close")}</button>
              {result?.outcome !== "succeeded" && (
                <button className="primary" onClick={reset}>
                  {tr("重新预检", "Preflight again")}
                </button>
              )}
            </>
          )}
        </>
      }
    >
      {runtime.mode === "mock" && (
        <DialogNotice>
          {tr(
            "Browser Mock：预检与保存均为模拟，不访问真实服务器。",
            "Browser Mock: preflight and save are simulated; no real server is accessed.",
          )}
        </DialogNotice>
      )}
      <div className="workflow-context">
        <strong>{name || tr("新 Mapping", "New mapping")}</strong>
        {" · "}
        {runtime.context.server} · {runtime.context.user}
      </div>
      <PreflightStatus zh={zh} state={preflightState} />

      {phase === "edit" && mode === "delete" && (
        <DialogNotice error>
          {tr(
            "删除不可撤销。预检会重新读取 Mapping、owner、锁定状态和权限，确认阶段还会执行 TOCTOU 复核。",
            "Deletion is irreversible. Preflight re-reads the mapping, owner, lock state, and permissions; confirmation repeats the TOCTOU checks.",
          )}
        </DialogNotice>
      )}
      {editingBlocked && (
        <DialogNotice error>
          {tr(
            "该 Mapping 含未知字段、注释或无法往返的 View 行，禁止编辑；详情仍可只读查看。",
            "This mapping contains unknown fields, comments, or non-round-trippable View lines. Editing is blocked; details remain read-only.",
          )}
        </DialogNotice>
      )}

      {phase === "edit" && draft && (
        <div className="branch-mutation-editor">
          <div className="branch-mutation-fields">
            <label>
              <span>{tr("名称", "Name")}</span>
              <input
                aria-label={tr("Branch Mapping 名称", "Branch Mapping name")}
                value={draft.name}
                disabled={mode === "edit"}
                maxLength={128}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
            </label>
            <label>
              <span>Owner</span>
              <input aria-label="Owner" value={draft.owner} readOnly />
            </label>
            <label className="branch-description-field">
              <span>Description</span>
              <textarea
                aria-label="Description"
                value={draft.description}
                maxLength={4096}
                onChange={(event) =>
                  setDraft({ ...draft, description: event.target.value })
                }
              />
            </label>
            <label className="workflow-checkbox">
              <input
                type="checkbox"
                checked={draft.locked}
                onChange={(event) =>
                  setDraft({ ...draft, locked: event.target.checked })
                }
              />
              {tr("锁定 Mapping", "Lock mapping")}
            </label>
          </div>
          {draftIssues.map((message) => (
            <DialogNotice key={message} error>
              {message}
            </DialogNotice>
          ))}
          <div className="branch-view-editor-header">
            <div>
              <strong>View</strong>
              <span>{draft.view.length} / 512</span>
            </div>
            <button
              disabled={draft.view.length >= 512}
              onClick={() =>
                setDraft({ ...draft, view: [...draft.view, blankLine()] })
              }
            >
              <Plus size={14} /> {tr("添加行", "Add line")}
            </button>
          </div>
          <ol className="branch-view-editor" aria-label="Branch View editor">
            {draft.view.map((line, index) => (
              <li
                key={index}
                className={lineIssueMap.has(index) ? "invalid" : ""}
              >
                <span className="branch-view-index">{index + 1}</span>
                <select
                  aria-label={`View line ${index + 1} modifier`}
                  value={line.modifier}
                  onChange={(event) =>
                    updateLine(index, {
                      modifier: event.target
                        .value as BranchViewLine["modifier"],
                      source: line.source,
                      target: line.target,
                    })
                  }
                >
                  <option value="map">map</option>
                  <option value="exclude">exclude</option>
                  <option value="overlay">overlay</option>
                </select>
                <input
                  aria-label={`View line ${index + 1} source`}
                  placeholder="//source/..."
                  value={line.source ?? ""}
                  onChange={(event) =>
                    updateLine(index, { ...line, source: event.target.value })
                  }
                />
                <input
                  aria-label={`View line ${index + 1} target`}
                  placeholder="//target/..."
                  value={line.target ?? ""}
                  onChange={(event) =>
                    updateLine(index, { ...line, target: event.target.value })
                  }
                />
                <span className="branch-view-row-actions">
                  <button
                    aria-label={`Move View line ${index + 1} up`}
                    disabled={index === 0}
                    onClick={() => moveLine(index, -1)}
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    aria-label={`Move View line ${index + 1} down`}
                    disabled={index === draft.view.length - 1}
                    onClick={() => moveLine(index, 1)}
                  >
                    <ArrowDown size={13} />
                  </button>
                  <button
                    aria-label={`Delete View line ${index + 1}`}
                    disabled={draft.view.length === 1}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        view: draft.view.filter((_, row) => row !== index),
                      })
                    }
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
                {lineIssueMap.get(index)?.map((message) => (
                  <span className="branch-view-line-error" key={message}>
                    {message}
                  </span>
                ))}
              </li>
            ))}
          </ol>
        </div>
      )}

      {phase === "review" && preflight && (
        <div className="branch-preflight-review">
          <DialogNotice>
            {tr("一次性令牌剩余", "One-use token remaining")} ·{" "}
            {Math.max(0, Math.ceil((preflight.expiresAt - Date.now()) / 1000))}s
          </DialogNotice>
          <dl>
            <div>
              <dt>Mode</dt>
              <dd>{preflight.mode}</dd>
            </div>
            <div>
              <dt>Name</dt>
              <dd>{preflight.name}</dd>
            </div>
            <div>
              <dt>Owner</dt>
              <dd>
                {preflight.desired?.owner ?? preflight.current?.owner ?? "—"}
              </dd>
            </div>
            <div>
              <dt>View lines</dt>
              <dd>
                {preflight.desired?.view.length ??
                  preflight.current?.view.length ??
                  0}
              </dd>
            </div>
          </dl>
          {mode === "delete" && (
            <label className="workflow-checkbox danger-check">
              <input
                type="checkbox"
                checked={acknowledgeDelete}
                onChange={(event) => setAcknowledgeDelete(event.target.checked)}
              />
              {tr(
                "我确认永久删除该 Branch Mapping",
                "I understand this permanently deletes the Branch Mapping",
              )}
            </label>
          )}
        </div>
      )}

      {phase === "result" && (
        <DialogNotice error={!result || result.outcome !== "succeeded"}>
          <strong>
            {result?.outcome === "succeeded"
              ? tr("已由服务器验证", "Verified by server")
              : tr("操作未成功", "Operation did not succeed")}
          </strong>
          <br />
          {error || result?.message || tr("未知结果", "Unknown result")}
          {result?.failure && (
            <>
              <br />
              <code>{result.failure}</code>
            </>
          )}
        </DialogNotice>
      )}
    </Dialog>
  );
}
