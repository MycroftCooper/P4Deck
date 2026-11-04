import { t } from "../../shared/i18n";
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
    "仅支持单个编号 CL，不支持 Default、多选或文件提交。",
    "Select one numbered CL; Default, multiple CLs and file submission are unsupported.",
  ],
  invalidChangeId: ["CL 编号无效。", "Invalid CL number."],
  invalidExecutablePath: [
    "需要本机盘符绝对 .exe 路径。",
    "A local-drive absolute .exe path is required.",
  ],
  invalidConnection: [
    "缺少有效配置身份或宿主连接代次。",
    "Active profile identity or host connection generation is missing.",
  ],
  connectionChanged: [
    "连接已切换，请重新核验。",
    "Connection changed; verification is required again.",
  ],
  toolMissing: ["工具不存在。", "Tool is missing."],
  toolNotFile: ["工具路径不是文件。", "Tool path is not a file."],
  toolUnverified: [
    "工具存在性尚未经宿主核验。",
    "Tool availability has not been verified by the host.",
  ],
  toolChanged: ["工具身份已变化。", "Tool identity changed."],
  busy: ["已有未结束或未核实的会话。", "A session is active or unresolved."],
  staleSession: ["会话已过期。", "Stale session."],
  invalidTransition: ["无效会话状态转换。", "Invalid session transition."],
  realStartDisabled: ["真实启动仍禁用。", "Real launch remains disabled."],
};
const phases = {
  reserved: [
    "模拟：请求已预约，尚未确定创建会话。",
    "Simulation: reserved; session creation is not known.",
  ],
  running: [
    "模拟：工具运行中，提交结果未核实。",
    "Simulation: running; submission result unverified.",
  ],
  notStarted: ["模拟：明确未创建进程。", "Simulation: no process was created."],
  outcomeUnknown: [
    "模拟：会话或提交结果未知；不自动重试或回退普通提交。",
    "Simulation: session or submission outcome unknown; no automatic retry or normal-submit fallback.",
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
  const tr = (pair: readonly string[]) => pair[zh ? 0 : 1];
  const result = currentReply(reply, request, requestId);
  const error = inputHint(request) || (!result?.ok ? result?.error : undefined);
  const state =
    simulation?.binding === requestBinding(request) ? simulation : undefined;
  return (
    <section
      aria-label={
        t("companySubmit.custom.submit.tool.plan.preview")
      }
    >
      <h2>
        {t("companySubmit.custom.submit.tool.not.connected")}
      </h2>
      <p>
        {t("companySubmit.real.launch.is.disabled.pending")}
      </p>
      {error ? (
        <p role="alert">{tr(errors[error])}</p>
      ) : !result ? (
        <p role="status">
          {t("companySubmit.awaiting.host.planning.tool.availability")}
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
          {t("companySubmit.an.earlier.snapshot.has.a")}
        </p>
      )}
      <button type="button" disabled>
        {t("companySubmit.launch.custom.submit.tool.disabled")}
      </button>
    </section>
  );
}
