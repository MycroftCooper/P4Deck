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
const errors: Record<PlanError, string> = {
  singleNumberedChangeRequired:
    "companySubmit.select.one.numbered.cl.default.multiple",
  invalidChangeId: "companySubmit.invalidChangeId",
  invalidExecutablePath: "companySubmit.a.local.drive.absolute.exe.path",
  invalidConnection: "companySubmit.active.profile.identity.or.host.connection",
  connectionChanged:
    "companySubmit.connection.changed.verification.is.required.again",
  toolMissing: "companySubmit.toolMissing",
  toolNotFile: "companySubmit.toolNotFile",
  toolUnverified: "companySubmit.tool.availability.has.not.been.verified",
  toolChanged: "companySubmit.toolChanged",
  busy: "companySubmit.busy",
  staleSession: "companySubmit.staleSession",
  invalidTransition: "companySubmit.invalidTransition",
  realStartDisabled: "companySubmit.realStartDisabled",
};
const phases = {
  reserved: "companySubmit.simulation.reserved.session.creation.is.not",
  running: "companySubmit.simulation.running.submission.result.unverified",
  notStarted: "companySubmit.notStarted",
  outcomeUnknown:
    "companySubmit.simulation.session.or.submission.outcome.unknown",
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
        <p role="alert">
          {tFor(zh ? "zh-CN" : "en-US", errors[error] as MsgKey)}
        </p>
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
      {state && (
        <p role="status">
          {tFor(zh ? "zh-CN" : "en-US", phases[state.state.state] as MsgKey)}
        </p>
      )}
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
