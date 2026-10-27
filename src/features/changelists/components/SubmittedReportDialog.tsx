import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { backend } from "../../../infrastructure/backend";
import { writeClipboardText } from "../../../infrastructure/clipboard";
import type { RuntimeInfo } from "../../../shared/contracts/types";
import {
  collectReport,
  reportBounds,
  reportPrompt,
  reportRange,
  submissionKinds,
  submissionKindLabel,
  type CollectedReport,
  type ReportScope,
  type SubmissionKind,
} from "../submittedReport";

export function SubmittedReportDialog({
  runtime,
  zh,
  source,
  initialUser,
  onClose,
}: {
  runtime: RuntimeInfo;
  zh: boolean;
  source: HTMLElement | null;
  initialUser: string;
  onClose(): void;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [scope, setScope] = useState<ReportScope>(() => ({
    user: initialUser,
    ...reportRange("thisWeek"),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
  const [included, setIncluded] = useState<SubmissionKind[]>(["ordinary"]);
  const [result, setResult] = useState<CollectedReport>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const active = useRef<
    { id: string; cancelled: boolean; partial?: CollectedReport } | undefined
  >(undefined);
  const cancel = () => {
    const run = active.current;
    if (!run) return;
    run.cancelled = true;
    active.current = undefined;
    void backend.cancelOperation(run.id).catch(() => undefined);
  };
  useEffect(() => () => cancel(), []);
  const prompt = useMemo(
    () => (result ? reportPrompt(scope, result, included, zh) : ""),
    [scope, result, included, zh],
  );
  const update = (next: ReportScope) => {
    cancel();
    setBusy(false);
    setScope(next);
    setResult(undefined);
    setMessage("");
  };
  async function generate() {
    if (active.current) return;
    setMessage("");
    setResult(undefined);
    try {
      reportBounds(scope);
    } catch (e) {
      setMessage(String(e));
      return;
    }
    if (runtime.mode !== "mock" && runtime.connection.state !== "connected") {
      setMessage(tr("连接不可用", "Connection unavailable"));
      return;
    }
    const run: { id: string; cancelled: boolean; partial?: CollectedReport } = {
      id: crypto.randomUUID(),
      cancelled: false,
    };
    active.current = run;
    setBusy(true);
    const value = await collectReport(
      scope,
      (q) => backend.queryChangelists(q),
      {
        operationId: run.id,
        generation: runtime.contextGeneration,
        cancelled: () => run.cancelled,
        progress: (value) => {
          run.partial = value;
          if (active.current === run)
            setMessage(
              `${tr("已读取", "Read")}: ${value.rows.length} CL / ${value.pages} ${tr("页", "pages")}`,
            );
        },
      },
    );
    if (active.current !== run) return;
    active.current = undefined;
    setBusy(false);
    setResult(value);
    setMessage("");
  }
  return (
    <Dialog
      title={tr("生成周报提示词", "Generate weekly report prompt")}
      source={source}
      zh={zh}
      onRequestClose={onClose}
      footer={
        <>
          {busy ? (
            <button
              onClick={() => {
                const partial = active.current?.partial;
                cancel();
                setBusy(false);
                setResult({
                  ...partial,
                  rows: partial?.rows ?? [],
                  pages: partial?.pages ?? 0,
                  scanned: partial?.scanned ?? 0,
                  complete: false,
                  reason: "已取消 / Cancelled",
                });
              }}
            >
              {tr("停止读取", "Stop reading")}
            </button>
          ) : (
            <button onClick={() => void generate()}>
              {tr("读取并生成", "Read and generate")}
            </button>
          )}
          <button
            disabled={!prompt || busy}
            onClick={() =>
              void writeClipboardText(prompt)
                .then(() => setMessage(tr("已复制", "Copied")))
                .catch((e) => setMessage(String(e)))
            }
          >
            {tr("复制提示词", "Copy prompt")}
          </button>
        </>
      }
    >
      {runtime.mode === "mock" && (
        <DialogNotice>{tr("模拟数据", "Simulated data")}</DialogNotice>
      )}
      <div className="submitted-report-fields">
        <label>
          {tr("用户", "User")}
          <input
            data-dialog-autofocus
            value={scope.user}
            onChange={(e) => update({ ...scope, user: e.target.value })}
          />
        </label>
        <label>
          {tr("起始时间（包含）", "Start (inclusive)")}
          <input
            type="datetime-local"
            value={scope.from}
            onChange={(e) => update({ ...scope, from: e.target.value })}
          />
        </label>
        <label>
          {tr("结束时间（不包含）", "End (exclusive)")}
          <input
            type="datetime-local"
            value={scope.to}
            onChange={(e) => update({ ...scope, to: e.target.value })}
          />
        </label>
      </div>
      <div className="submitted-report-options">
        {(["today", "thisWeek", "lastWeek"] as const).map((value, index) => (
          <button
            key={value}
            className="secondary"
            onClick={() => update({ ...scope, ...reportRange(value) })}
          >
            {
              (zh
                ? ["今天", "本周", "上周"]
                : ["Today", "This week", "Last week"])[index]
            }
          </button>
        ))}
      </div>
      <fieldset className="submitted-report-options">
        <legend>
          {tr(
            "导出类别（默认仅普通提交）",
            "Export categories (ordinary by default)",
          )}
        </legend>
        {submissionKinds.map((kind) => (
          <label key={kind}>
            <input
              type="checkbox"
              checked={included.includes(kind)}
              onChange={(e) => {
                setIncluded(
                  e.target.checked
                    ? [...included, kind]
                    : included.filter((k) => k !== kind),
                );
                setMessage("");
              }}
            />
            {submissionKindLabel(kind, zh)}
          </label>
        ))}
      </fieldset>
      {message && <DialogNotice>{message}</DialogNotice>}
      {result && !result.complete && (
        <DialogNotice error>
          {tr("不完整：", "Incomplete: ")}
          {result.reason}
        </DialogNotice>
      )}
      <textarea
        className="submitted-report-prompt"
        aria-label={tr("周报提示词", "Weekly report prompt")}
        readOnly
        value={prompt}
      />
    </Dialog>
  );
}
