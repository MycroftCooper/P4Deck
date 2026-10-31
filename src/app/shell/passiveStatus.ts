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
  const unknown = zh ? "暂无近期样本" : "No recent samples";
  const connection = {
    unknown,
    reachable: zh ? "连接正常" : "Reachable",
    failed: zh ? "连接失败" : "Connection failed",
  }[s.connection];
  const access = {
    unknown,
    ok: zh ? "最近请求已授权" : "Last request authorized",
    loginRequired: zh ? "需要登录或登录已过期" : "Sign in required or expired",
    permissionDenied: zh ? "权限不足" : "Permission denied",
  }[s.access];
  // "本机响应" shows the latest request duration directly; bucketed quality refines the wording.
  const lastMs = zh
    ? `最近 ${s.lastElapsedMs} ms`
    : `Last ${s.lastElapsedMs} ms`;
  const baseQuality = {
    smooth: zh ? "流畅" : "Smooth",
    slow: zh ? "变慢" : "Slower",
    persistentTimeout: zh ? "持续超时" : "Persistent timeouts",
  }[s.quality as "smooth" | "slow" | "persistentTimeout"];
  const quality =
    baseQuality && s.lastElapsedMs != null
      ? `${baseQuality} · ${lastMs}`
      : (baseQuality ??
        (s.lastElapsedMs != null
          ? lastMs
          : s.samples && s.samples > 0
            ? zh
              ? `样本不足（${s.samples}/5）`
              : `Insufficient samples (${s.samples}/5)`
            : s.observedAt
              ? zh
                ? "已观察请求，尚未测速"
                : "Requests observed; no speed sample yet"
              : unknown));
  const rows = [
    { label: zh ? "连接" : "Connection", value: connection },
    { label: zh ? "登录 / 权限" : "Login / permissions", value: access },
    { label: zh ? "本机响应" : "Local response", value: quality },
  ];
  const note =
    (zh
      ? "已有请求的本机观测，非服务器负载"
      : "Observed existing requests; not server load") +
    (s.connectionSource === "manual"
      ? zh
        ? "；连接来自手动检查"
        : "; connection from manual check"
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
