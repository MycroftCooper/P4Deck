import { t, tFor, type MsgKey } from "../../../shared/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { backend } from "../../../infrastructure/backend";
import { writeClipboardText } from "../../../infrastructure/clipboard";
import type { RuntimeInfo } from "../../../shared/contracts";
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
      setMessage(t("pending.connection.unavailable"));
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
        zh,
        cancelled: () => run.cancelled,
        progress: (value) => {
          run.partial = value;
          if (active.current === run)
            setMessage(
              `${t("pending.read")}: ${value.rows.length} CL / ${value.pages} ${t("pending.pages.2")}`,
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
      title={t("pending.generate.weekly.report.prompt")}
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
                  reason: t("pending.cancelled"),
                });
              }}
            >
              {t("pending.stop.reading")}
            </button>
          ) : (
            <button onClick={() => void generate()}>
              {t("pending.read.and.generate")}
            </button>
          )}
          <button
            disabled={!prompt || busy}
            onClick={() =>
              void writeClipboardText(prompt)
                .then(() => setMessage(t("pending.copied")))
                .catch((e) => setMessage(String(e)))
            }
          >
            {t("pending.copy.prompt")}
          </button>
        </>
      }
    >
      {runtime.mode === "mock" && (
        <DialogNotice>{t("pending.simulated.data")}</DialogNotice>
      )}
      <div className="submitted-report-fields">
        <label>
          {t("pending.user.2")}
          <input
            data-dialog-autofocus
            value={scope.user}
            onChange={(e) => update({ ...scope, user: e.target.value })}
          />
        </label>
        <label>
          {t("pending.start.inclusive")}
          <input
            type="datetime-local"
            value={scope.from}
            onChange={(e) => update({ ...scope, from: e.target.value })}
          />
        </label>
        <label>
          {t("pending.end.exclusive")}
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
            {tFor(
              zh ? "zh-CN" : "en-US",
              [
                "pending.reportPreset.today",
                "pending.reportPreset.thisWeek",
                "pending.reportPreset.lastWeek",
              ][index] as MsgKey,
            )}
          </button>
        ))}
      </div>
      <fieldset className="submitted-report-options">
        <legend>{t("pending.export.categories.ordinary.by.default")}</legend>
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
          {t("pending.incomplete.2")}
          {result.reason}
        </DialogNotice>
      )}
      <textarea
        className="submitted-report-prompt"
        aria-label={t("pending.weekly.report.prompt")}
        readOnly
        value={prompt}
      />
    </Dialog>
  );
}
