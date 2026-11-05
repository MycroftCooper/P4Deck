import { tFor } from "../../shared/i18n";
/** Local presentation input only. IPC scope/revision contract belongs to BE. */
export interface PassiveStatusView {
  connection: "unknown" | "reachable" | "failed";
  access: "unknown" | "ok" | "loginRequired" | "permissionDenied";
  quality: "unknown" | "smooth" | "slow" | "persistentTimeout";
  fresh: boolean;
  connectionSource?: "unknown" | "passive" | "manual";
  /** Observed response samples (bucketed); used only to explain an unknown quality row. */
  samples?: number;
  /** Last observed request timestamp; distinguishes "never observed" from "observed, not enough samples". */
  observedAt?: number | null;
  /** Latest completed remote request duration in ms, shown directly (no sample threshold). */
  lastElapsedMs?: number | null;
}
export const unknownPassiveStatus: PassiveStatusView = {
  connection: "unknown",
  access: "unknown",
  quality: "unknown",
  fresh: false,
};
export type PassiveStatusIcon =
  | "unknown"
  | "healthy"
  | "slow"
  | "login"
  | "permission"
  | "failed"
  | "timeout";
/** Only present host facts: no latency thresholds or inference from operation progress. */
export function passiveStatusPresentation(
  input: PassiveStatusView | undefined,
  zh: boolean,
) {
  const s = input?.fresh ? input : unknownPassiveStatus;
  // Icon reflects reachability/authorization immediately; bucketed quality only refines slow/timeout.
  const icon: PassiveStatusIcon =
    s.connection === "failed"
      ? "failed"
      : s.access === "loginRequired"
        ? "login"
        : s.access === "permissionDenied"
          ? "permission"
          : s.quality === "persistentTimeout"
            ? "timeout"
            : s.quality === "slow"
              ? "slow"
              : s.connection === "reachable"
                ? "healthy"
                : "unknown";
  const unknown = tFor(zh ? "zh-CN" : "en-US", "shell.no.recent.samples");
  const connection = {
    unknown,
    reachable: tFor(zh ? "zh-CN" : "en-US", "shell.reachable"),
    failed: tFor(zh ? "zh-CN" : "en-US", "shell.connection.failed"),
  }[s.connection];
  const access = {
    unknown,
    ok: tFor(zh ? "zh-CN" : "en-US", "shell.last.request.authorized"),
    loginRequired: tFor(
      zh ? "zh-CN" : "en-US",
      "shell.sign.in.required.or.expired",
    ),
    permissionDenied: tFor(zh ? "zh-CN" : "en-US", "shell.permission.denied"),
  }[s.access];
  // "本机响应" shows the latest request duration directly; bucketed quality refines the wording.
  const lastMs = tFor(zh ? "zh-CN" : "en-US", "shell.last.ms", {
    p1: s.lastElapsedMs ?? 0,
  });
  const baseQuality = {
    smooth: tFor(zh ? "zh-CN" : "en-US", "shell.smooth"),
    slow: tFor(zh ? "zh-CN" : "en-US", "shell.slower"),
    persistentTimeout: tFor(
      zh ? "zh-CN" : "en-US",
      "shell.persistent.timeouts",
    ),
  }[s.quality as "smooth" | "slow" | "persistentTimeout"];
  const quality =
    baseQuality && s.lastElapsedMs != null
      ? `${baseQuality} · ${lastMs}`
      : (baseQuality ??
        (s.lastElapsedMs != null
          ? lastMs
          : s.samples && s.samples > 0
            ? tFor(zh ? "zh-CN" : "en-US", "shell.insufficient.samples.5", {
                p1: s.samples ?? 0,
              })
            : s.observedAt
              ? tFor(
                  zh ? "zh-CN" : "en-US",
                  "shell.requests.observed.no.speed.sample",
                )
              : unknown));
  const rows = [
    {
      label: tFor(zh ? "zh-CN" : "en-US", "shell.connection"),
      value: connection,
    },
    {
      label: tFor(zh ? "zh-CN" : "en-US", "shell.login.permissions"),
      value: access,
    },
    {
      label: tFor(zh ? "zh-CN" : "en-US", "shell.local.response"),
      value: quality,
    },
  ];
  const note =
    tFor(
      zh ? "zh-CN" : "en-US",
      "shell.observed.existing.requests.not.server",
    ) +
    (s.connectionSource === "manual"
      ? tFor(zh ? "zh-CN" : "en-US", "shell.connection.from.manual.check")
      : "");
  return {
    icon,
    tone:
      icon === "healthy"
        ? "success"
        : icon === "failed" || icon === "timeout"
          ? "danger"
          : icon === "unknown"
            ? "muted"
            : "warning",
    rows,
    note,
    title: rows.map((r) => `${r.label}: ${r.value}`).join("; ") + `. ${note}`,
  };
}
