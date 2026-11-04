import { tFor, type MsgKey } from "../../shared/i18n";
import {
  currentReply,
  inputHint,
  requestBinding,
  type PlanRequest,
  type PreviewReply,
  type Simulation,
  type PlanError,
} from "./model";
const errors: Record<PlanError, [string, string]> = {
  singleNumberedChangeRequired: [
    "companySubmit.select.one.numbered.cl.default.multiple",
    "companySubmit.select.one.numbered.cl.default.multiple",
  ],
  invalidChangeId: ["CL 编号无效。", "Invalid CL number."],
  invalidExecutablePath: [
    "companySubmit.a.local.drive.absolute.exe.path",
    "companySubmit.a.local.drive.absolute.exe.path",
  ],
  invalidConnection: [
    "companySubmit.active.profile.identity.or.host.connection",
    "companySubmit.active.profile.identity.or.host.connection",
  ],
  connectionChanged: [
    "companySubmit.connection.changed.verification.is.required.again",
    "companySubmit.connection.changed.verification.is.required.again",
  ],
  toolMissing: ["工具不存在。", "Tool is missing."],
  toolNotFile: ["工具路径不是文件。", "Tool path is not a file."],
  toolUnverified: [
    "companySubmit.tool.availability.has.not.been.verified",
    "companySubmit.tool.availability.has.not.been.verified",
  ],
  toolChanged: ["工具身份已变化。", "Tool identity changed."],
  busy: ["已有未结束或未核实的会话。", "A session is active or unresolved."],
  staleSession: ["会话已过期。", "Stale session."],
  invalidTransition: ["无效会话状态转换。", "Invalid session transition."],
  realStartDisabled: ["真实启动仍禁用。", "Real launch remains disabled."],
};
const phases = {
  reserved: [
    "companySubmit.simulation.reserved.session.creation.is.not",
    "companySubmit.simulation.reserved.session.creation.is.not",
  ],
  running: [
    "companySubmit.simulation.running.submission.result.unverified",
    "companySubmit.simulation.running.submission.result.unverified",
  ],
  notStarted: ["模拟：明确未创建进程。", "Simulation: no process was created."],
  outcomeUnknown: [
    "companySubmit.simulation.session.or.submission.outcome.unknown",
    "companySubmit.simulation.session.or.submission.outcome.unknown",
  ],
};
/** No launch callback. Mock state is supplied only by tests; normal UI cannot advance it. */
export function CompanySubmitPreview({
  request,
  requestId,
  reply,
  simulation,
  zh = true,
}: {
  request: PlanRequest;
  requestId: string;
  reply?: PreviewReply;
  simulation?: Simulation;
  zh?: boolean;
}) {
  const tr = (pair: readonly string[]) =>
    tFor(zh ? "zh-CN" : "en-US", pair[0] as MsgKey);
  const result = currentReply(reply, request, requestId);
  const error = inputHint(request) || (!result?.ok ? result?.error : undefined);
  const state =
    simulation?.binding === requestBinding(request) ? simulation : undefined;
  return (
    <section
      aria-label={tFor(
        zh ? "zh-CN" : "en-US",
        "companySubmit.custom.submit.tool.plan.preview",
      )}
    >
      <h2>
        {tFor(
          zh ? "zh-CN" : "en-US",
          "companySubmit.custom.submit.tool.not.connected",
        )}
      </h2>
      <p>
        {tFor(
          zh ? "zh-CN" : "en-US",
          "companySubmit.real.launch.is.disabled.pending",
        )}
      </p>
      {error ? (
        <p role="alert">{tr(errors[error])}</p>
      ) : !result ? (
        <p role="status">
          {tFor(
            zh ? "zh-CN" : "en-US",
            "companySubmit.awaiting.host.planning.tool.availability",
          )}
        </p>
      ) : null}
      {!error && result?.ok && (
        <>
          <p>{result.plan.executablePath}</p>
          <ol aria-label="argv">
            {result.plan.argv.map((arg, i) => (
              <li key={i} style={{ overflowWrap: "anywhere" }}>
                {arg}
              </li>
            ))}
          </ol>
          <ul>
            {result.plan.blockers.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </>
      )}
      {state && <p role="status">{tr(phases[state.state.state])}</p>}
      {simulation && !state && (
        <p role="status">
          {tFor(
            zh ? "zh-CN" : "en-US",
            "companySubmit.an.earlier.snapshot.has.a",
          )}
        </p>
      )}
      <button type="button" disabled>
        {tFor(
          zh ? "zh-CN" : "en-US",
          "companySubmit.launch.custom.submit.tool.disabled",
        )}
      </button>
    </section>
  );
}
