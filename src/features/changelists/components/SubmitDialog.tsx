import { useEffect, useRef, useState } from "react";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { TargetList } from "../../../app/dialogs/TargetList";
import { backend } from "../../../infrastructure/backend";
import type { ConnectionSnapshot } from "../../companySubmit/model";
import type {
  PendingChange,
  SubmitConfirmation,
  SubmitPreflight,
  SubmitResult,
} from "../../../shared/contracts";
import {
  submitConnectionMatchesTarget,
  submitLifecycle,
  type SubmitLifecycle,
} from "../submitLifecycle";
import { requestDesktopAttention } from "../../../app/notifications/notifications";

export type SubmitCheck = SubmitPreflight;
interface Props {
  changeId: number;
  count: number;
  client: string;
  connectionKey: string;
  zh: boolean;
  source?: HTMLElement | null;
  onDismiss(): void;
  loadSummary(): Promise<PendingChange | undefined>;
  check?(id: number): Promise<SubmitCheck>;
  /**
   * Adapter must atomically revalidate token, connection and whole-CL scope,
   * and own the single bounded refresh/unknown-receipt recovery.
   */
  submit?(
    confirmation: SubmitConfirmation,
    connection: ConnectionSnapshot,
  ): Promise<SubmitResult>;
  /** Exact dispatching connection snapshot; captured once per confirm. */
  connection?(): Promise<ConnectionSnapshot>;
}
type Phase =
  | "summary"
  | "unchecked"
  | "checking"
  | "blocked"
  | "ready"
  | "stale"
  | "failed"
  | "submitting"
  | "unknown"
  | "submitted";

export function SubmitDialog(props: Props) {
  const { zh, onDismiss } = props;
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [origin] = useState(() => ({
    id: props.changeId,
    count: props.count,
    client: props.client,
    connectionKey: props.connectionKey,
  }));
  const [phase, setPhase] = useState<Phase>("summary");
  const [summary, setSummary] = useState<PendingChange>();
  const [check, setCheck] = useState<SubmitCheck>();
  const [submitResult, setSubmitResult] = useState<SubmitResult>();
  const [lifecycle, setLifecycle] = useState<SubmitLifecycle>();
  const [message, setMessage] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const generation = useRef(0);
  const running = useRef(false);
  const operationId = useRef<string | undefined>(undefined);
  const staleConnection = origin.connectionKey !== props.connectionKey;
  const latestConnection = useRef(props.connectionKey);
  latestConnection.current = props.connectionKey;
  const loadSummary = useRef(props.loadSummary);
  useEffect(() => {
    if (origin.connectionKey !== props.connectionKey) {
      generation.current++;
      running.current = false;
      setPhase("stale");
      setAcknowledged(false);
    }
  }, [origin.connectionKey, props.connectionKey]);
  useEffect(() => {
    const epoch = ++generation.current;
    void loadSummary
      .current()
      .then((change) => {
        if (epoch !== generation.current) return;
        if (change?.id !== origin.id)
          throw new Error(
            tr(
              "找不到此 CL 的文件摘要，请刷新后重试。",
              "Changelist summary unavailable. Refresh and retry.",
            ),
          );
        setSummary(change);
        setPhase("unchecked");
      })
      .catch((error) => {
        if (epoch === generation.current) {
          setMessage(String(error));
          setPhase("failed");
        }
      });
    return () => {
      generation.current++;
    };
  }, [origin]);
  useEffect(() => {
    if (!check || phase !== "ready") return;
    const timer = setTimeout(
      () => {
        setPhase("stale");
        setAcknowledged(false);
      },
      Math.min(2147483647, Math.max(0, check.expiresAt - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [check, phase]);
  async function inspect() {
    if (
      !props.check ||
      running.current ||
      staleConnection ||
      phase === "summary"
    )
      return;
    running.current = true;
    const epoch = generation.current;
    setPhase("checking");
    setMessage("");
    setCheck(undefined);
    setSubmitResult(undefined);
    setLifecycle(undefined);
    operationId.current = undefined;
    setAcknowledged(false);
    try {
      const result = await props.check(origin.id);
      if (
        epoch !== generation.current ||
        latestConnection.current !== origin.connectionKey
      )
        return;
      if (
        (result.change !== undefined && result.change.id !== origin.id) ||
        result.target.changeId !== origin.id ||
        result.target.client !== origin.client ||
        (result.ready && (!result.change || !result.token)) ||
        !Number.isFinite(result.expiresAt)
      )
        throw new Error(
          tr(
            "预检结果与目标不匹配。",
            "Preflight result does not match the target.",
          ),
        );
      setCheck(result);
      setSummary(result.change);
      requestDesktopAttention({
        key: `submit-preflight:${origin.id}:${result.fileSummary.contentDigest}`,
        title: tr("Submit 等待确认", "Submit awaits confirmation"),
        body: result.blockers.length
          ? tr(
              `CL ${origin.id} 有 ${result.blockers.length} 个阻断项。`,
              `CL ${origin.id} has ${result.blockers.length} blocker(s).`,
            )
          : tr(
              `请确认提交 CL ${origin.id}。`,
              `Review and confirm CL ${origin.id}.`,
            ),
        kind: "attention",
      });
      const checkedChange = result.change;
      setPhase(
        !result.ready ||
          result.blockers.length ||
          !checkedChange ||
          !checkedChange.files.length ||
          !checkedChange.description.trim()
          ? "blocked"
          : result.expiresAt <= Date.now()
            ? "stale"
            : "ready",
      );
    } catch (error) {
      if (epoch === generation.current) {
        setMessage(String(error));
        setPhase("failed");
      }
    } finally {
      running.current = false;
    }
  }
  async function confirm() {
    if (
      !props.submit ||
      !check ||
      phase !== "ready" ||
      running.current ||
      !acknowledged ||
      staleConnection
    )
      return;
    if (check.expiresAt <= Date.now()) {
      setPhase("stale");
      return;
    }
    const epoch = generation.current;
    running.current = true;
    setPhase("submitting");
    setMessage("");
    setSubmitResult(undefined);
    setLifecycle(undefined);
    // One UUID for this dispatch; a receipt lookup must reuse it and a new
    // user-initiated submit gets a new one only after an explicit new preflight.
    const id = crypto.randomUUID();
    operationId.current = id;
    try {
      const dispatching = await (
        props.connection ?? (() => backend.companySubmitConnectionSnapshot())
      )();
      if (
        epoch !== generation.current ||
        latestConnection.current !== origin.connectionKey
      )
        return;
      if (!submitConnectionMatchesTarget(check.target, dispatching))
        throw new Error(
          tr(
            "连接身份与提交预检目标不一致，未执行提交。",
            "Connection identity changed; nothing was submitted.",
          ),
        );
      const result = await props.submit(
        { token: check.token!, target: check.target, operationId: id },
        dispatching,
      );
      if (
        epoch !== generation.current ||
        latestConnection.current !== origin.connectionKey
      )
        return;
      const life = submitLifecycle(result, id);
      setSubmitResult(result);
      setLifecycle(life);
      setMessage(result.message);
      setPhase(
        life.state === "submitted"
          ? "submitted"
          : life.state === "unknown"
            ? "unknown"
            : "failed",
      );
      if (life.state !== "submitted") {
        requestDesktopAttention({
          key: `submit-result:${origin.id}:${life.operationId ?? life.state}`,
          title: tr("Submit 需要处理", "Submit needs attention"),
          body: result.message,
          kind: "failure",
        });
        setCheck(undefined);
        setAcknowledged(false);
      }
    } catch (error) {
      if (epoch === generation.current) {
        setMessage(String(error));
        setPhase("failed");
        setCheck(undefined);
        setAcknowledged(false);
      }
    } finally {
      running.current = false;
    }
  }
  /** Cancellation uses the existing IPC with the SAME operationId (never a new id). */
  async function cancel() {
    const id = operationId.current;
    if (!id || !running.current) return;
    await backend.cancelOperation(id).catch(() => undefined);
  }
  const busy = phase === "checking" || phase === "submitting";
  return (
    <Dialog
      title={tr(`提交整个 CL ${origin.id}`, `Submit entire CL ${origin.id}`)}
      description={tr(
        "提交范围始终是这个 CL 的全部文件，不会只提交当前选择的文件。",
        "Submission always covers every file in this CL, not just selected files.",
      )}
      zh={zh}
      source={props.source}
      busy={busy}
      onRequestClose={onDismiss}
      footer={
        <>
          <button disabled={busy} onClick={onDismiss}>
            {tr("关闭", "Close")}
          </button>
          {phase === "submitting" && (
            <button onClick={() => void cancel()}>
              {tr("取消操作", "Cancel operation")}
            </button>
          )}
          <button
            disabled={
              !props.check ||
              busy ||
              staleConnection ||
              origin.id <= 0 ||
              phase === "summary" ||
              phase === "submitted"
            }
            onClick={() => void inspect()}
          >
            {tr("重新预检", "Run preflight")}
          </button>
          <button
            className="primary"
            disabled={
              !props.submit ||
              phase !== "ready" ||
              staleConnection ||
              !acknowledged
            }
            onClick={() => void confirm()}
          >
            {tr("确认提交整个 CL", "Confirm entire CL submission")}
          </button>
        </>
      }
    >
      <div className="workflow-context">
        {origin.client} · CL {origin.id} ·{" "}
        {summary?.files.length ?? origin.count}{" "}
        {tr("个文件（整个 CL）", "files (entire CL)")}
      </div>
      {(!props.check || !props.submit) && (
        <DialogNotice>
          {tr(
            "界面预览：提交预检/执行尚未接通。文件摘要不代表已通过权限、冲突或最新状态检查，不能提交。",
            "UI preview: preflight/execution is not connected. A file summary does not validate permissions, conflicts or current state. Submission is unavailable.",
          )}
        </DialogNotice>
      )}
      {staleConnection && (
        <DialogNotice error>
          {tr(
            "连接已改变，请关闭后重新打开。旧预检已失效。",
            "Connection changed. Close and reopen; previous checks are invalid.",
          )}
        </DialogNotice>
      )}
      {phase === "summary" && (
        <DialogNotice>
          {tr("正在加载文件摘要…", "Loading file summary…")}
        </DialogNotice>
      )}
      {summary && (
        <>
          <p className="workflow-summary-description">
            {summary.description || tr("未填写描述", "No description")}
          </p>
          <TargetList
            paths={summary.files.map((file) => file.depotPath)}
            label={tr("整个 CL 的文件清单", "Entire CL file list")}
          />
          {!summary.files.length && (
            <DialogNotice error>
              {tr("空 CL 不可提交。", "An empty CL cannot be submitted.")}
            </DialogNotice>
          )}
        </>
      )}
      {phase === "unchecked" && (
        <DialogNotice>{tr("尚未预检", "Not checked")}</DialogNotice>
      )}
      {phase === "checking" && (
        <DialogNotice>
          {tr("正在预检，请稍候…", "Preflight in progress…")}
        </DialogNotice>
      )}
      {phase === "submitting" && (
        <DialogNotice>
          {tr(
            "正在提交；关闭此界面不能撤销服务器已接收的操作。",
            "Submitting. Closing this view cannot undo operations accepted by the server.",
          )}
        </DialogNotice>
      )}
      {phase === "blocked" && (
        <DialogNotice error>
          {tr("预检未通过，不能提交。", "Preflight blocked submission.")}
        </DialogNotice>
      )}
      {phase === "stale" && (
        <DialogNotice error>
          {tr("预检已过期，请重新检查。", "Preflight expired. Check again.")}
        </DialogNotice>
      )}
      {check?.blockers.map((item, index) => (
        <DialogNotice key={`b${item.code}-${index}`} error>
          {item.certainty === "unknown"
            ? tr("未知阻塞：", "Unknown blocker: ")
            : tr("阻塞：", "Blocker: ")}
          {item.message}
        </DialogNotice>
      ))}
      {check?.warnings.map((item, index) => (
        <DialogNotice key={`w${item.code}-${index}`}>
          {item.certainty === "unknown"
            ? tr("未知：", "Unknown: ")
            : tr("警告：", "Warning: ")}
          {item.message}
        </DialogNotice>
      ))}
      {message && (
        <DialogNotice error={phase === "failed" || phase === "unknown"}>
          {message}
        </DialogNotice>
      )}
      {lifecycle?.state === "submitted" && (
        <DialogNotice>
          {tr("提交结果（权威）：", "Authoritative submit result: ")}
          CL {lifecycle.submittedChangeId}
          {lifecycle.submittedChangeId !== submitResult?.changeId
            ? ""
            : ` ${tr("（原 CL 号）", "(same change id)")}`}
          {!lifecycle.envelope
            ? tr(
                " · 旧版结果（无命令级 envelope）",
                " · legacy result (no command envelope)",
              )
            : ""}
        </DialogNotice>
      )}
      {phase === "unknown" && (
        <DialogNotice error>
          {tr(
            "结果不确定：提交可能已到达服务器。已用同一操作号查询持久回执，并以真实结果/刷新纠正；请先核对 Pending/Submitted，不要用新操作号直接重试。",
            "Outcome uncertain: the submit may have reached the server. The durable receipt was queried with the same operation id and corrected from real data; inspect Pending/Submitted before any retry with a new operation id.",
          )}
        </DialogNotice>
      )}
      {submitResult &&
        lifecycle?.state !== "submitted" &&
        lifecycle?.state !== "unknown" && (
          <DialogNotice error>
            {tr("结果：", "Outcome: ")}
            {submitResult.outcome}
            {submitResult.failure ? ` · ${submitResult.failure}` : ""}.{" "}
            {submitResult.refresh.reason}
          </DialogNotice>
        )}
      {(lifecycle?.operationId ?? submitResult?.operationId) && (
        <p className="workflow-context">
          {tr("操作记录", "Operation")}{" "}
          {lifecycle?.operationId ?? submitResult?.operationId}
          {submitResult?.logReference
            ? ` · ${tr("日志", "Log")} ${submitResult.logReference}`
            : ""}
        </p>
      )}
      {phase === "ready" && !staleConnection && (
        <label className="workflow-checkbox">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          {tr(
            "确认提交整个 CL，并已阅读上述警告。",
            "Confirm the entire CL and acknowledge the warnings above.",
          )}
        </label>
      )}
    </Dialog>
  );
}
