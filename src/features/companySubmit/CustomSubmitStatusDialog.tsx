import { tFor } from "../../shared/i18n";
import { Dialog } from "../../app/dialogs/Dialog";
import type { CustomSubmitView } from "./useCustomSubmit";

export function CustomSubmitStatusDialog({
  view,
  zh,
  onClose,
  onRefresh,
}: {
  view: CustomSubmitView;
  zh: boolean;
  onClose(): void;
  onRefresh(): void;
}) {
  const pending = view.phase === "checking" || view.phase === "starting";
  const session = view.phase === "session" ? view.session : undefined;
  const intent = view.phase === "session" ? view.intent : undefined;
  const message =
    view.phase === "checking"
      ? tFor(zh ? "zh-CN" : "en-US", "companySubmit.reading.active.configuration")
      : view.phase === "starting"
        ? tFor(zh ? "zh-CN" : "en-US", "companySubmit.starting")
        : view.phase === "error"
          ? view.uncertain
            ? tFor(zh ? "zh-CN" : "en-US", "companySubmit.launch.outcome.unknown.check.status")
            : tFor(zh ? "zh-CN" : "en-US", "companySubmit.not.started.check.the.configuration")
          : intent === "running"
            ? tFor(zh ? "zh-CN" : "en-US", "companySubmit.external.tool.started.running.this")
            : intent === "rejected"
              ? tFor(zh ? "zh-CN" : "en-US", "companySubmit.host.positively.reports.the.tool")
              : tFor(zh ? "zh-CN" : "en-US", "companySubmit.tool.process.exited.or.is");
  return (
    <Dialog
      title={tFor(zh ? "zh-CN" : "en-US", "companySubmit.custom.submit.tool")}
      zh={zh}
      onRequestClose={onClose}
      footer={
        <>
          <button type="button" onClick={onRefresh} disabled={pending}>
            {tFor(zh ? "zh-CN" : "en-US", "companySubmit.check.status")}
          </button>
          <button type="button" onClick={onClose}>
            {tFor(zh ? "zh-CN" : "en-US", "companySubmit.close")}
          </button>
        </>
      }
    >
      <p role="status">{message}</p>
      {session && (
        <>
          <p>CL {session.changeId}</p>
          <p style={{ overflowWrap: "anywhere" }}>
            {tFor(zh ? "zh-CN" : "en-US", "companySubmit.path.used.for.this.attempt")}
            {session.executablePath}
          </p>
          <p>
            {tFor(zh ? "zh-CN" : "en-US", "companySubmit.this.records.that.launch.attempt")}
          </p>
          {session.exitCode !== null && (
            <p>
              {tFor(zh ? "zh-CN" : "en-US", "companySubmit.exit.code.display.only.not")}
              {session.exitCode}
            </p>
          )}
        </>
      )}
      {(view.phase === "error" || session?.reason) && (
        <p role="alert">
          {view.phase === "error" ? view.message : session?.reason}
        </p>
      )}
      <p>
        {tFor(zh ? "zh-CN" : "en-US", "companySubmit.no.fallback.to.native.submission")}
      </p>
    </Dialog>
  );
}
