import { DialogNotice } from "./Dialog";
export type PreflightState =
  | {
      kind: "unavailable" | "idle" | "checking" | "empty" | "stale" | "offline";
    }
  | { kind: "failed"; message: string }
  | { kind: "ready" | "blocked"; blockers: string[]; warnings: string[] };
/** Shared presentation only. It never infers server readiness from local UI validation. */
export function PreflightStatus({
  state,
  zh,
}: {
  state: PreflightState;
  zh: boolean;
}) {
  const text: Record<PreflightState["kind"], [string, string]> = {
    unavailable: [
      "预检尚未接通，不能执行。",
      "Preflight is not connected. Execution unavailable.",
    ],
    idle: ["尚未预检。", "Not checked yet."],
    checking: ["正在预检，请稍候…", "Preflight in progress…"],
    empty: ["预检范围内没有文件。", "No files in the preflight scope."],
    stale: [
      "预检已过期或目标已改变，请重新检查。",
      "Preflight expired or target changed. Check again.",
    ],
    offline: [
      "连接不可用，无法验证当前服务器状态。",
      "Connection unavailable; current server state cannot be verified.",
    ],
    failed: ["预检失败。", "Preflight failed."],
    blocked: ["存在阻塞项，不能执行。", "Blockers prevent execution."],
    ready: [
      "预检结果已就绪，请核对文件范围和警告。",
      "Preflight results ready. Review scope and warnings.",
    ],
  };
  return (
    <section
      aria-label={zh ? "预检状态" : "Preflight status"}
      aria-busy={state.kind === "checking"}
    >
      <DialogNotice
        error={["failed", "blocked", "stale", "offline"].includes(state.kind)}
      >
        {text[state.kind][zh ? 0 : 1]}
      </DialogNotice>
      {state.kind === "failed" && (
        <DialogNotice error>{state.message}</DialogNotice>
      )}
      {(state.kind === "ready" || state.kind === "blocked") && (
        <>
          {state.blockers.map((value, index) => (
            <DialogNotice key={`b${index}`} error>
              {zh ? "阻塞：" : "Blocker: "}
              {value}
            </DialogNotice>
          ))}
          {state.warnings.map((value, index) => (
            <DialogNotice key={`w${index}`}>
              {zh ? "警告：" : "Warning: "}
              {value}
            </DialogNotice>
          ))}
        </>
      )}
    </section>
  );
}
