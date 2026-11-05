import {  t , tFor, type MsgKey } from "../../shared/i18n";
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
  const text: Record<PreflightState["kind"], string> = {
    unavailable: "preflight.unavailable",
    idle: "preflight.idle",
    checking: "preflight.checking",
    empty: "preflight.empty",
    stale: "preflight.stale",
    offline: "preflight.offline",
    failed: "preflight.failed",
    blocked: "preflight.blocked",
    ready: "preflight.ready",
  };
  return (
    <section
      aria-label={t("dialogs.preflight.status")}
      aria-busy={state.kind === "checking"}
    >
      <DialogNotice
        error={["failed", "blocked", "stale", "offline"].includes(state.kind)}
      >
        {tFor(zh ? "zh-CN" : "en-US", text[state.kind] as MsgKey)}
      </DialogNotice>
      {state.kind === "failed" && (
        <DialogNotice error>{state.message}</DialogNotice>
      )}
      {(state.kind === "ready" || state.kind === "blocked") && (
        <>
          {state.blockers.map((value, index) => (
            <DialogNotice key={`b${index}`} error>
              {t("dialogs.blocker")}
              {value}
            </DialogNotice>
          ))}
          {state.warnings.map((value, index) => (
            <DialogNotice key={`w${index}`}>
              {t("dialogs.warning")}
              {value}
            </DialogNotice>
          ))}
        </>
      )}
    </section>
  );
}
