import { tFor } from "../../shared/i18n";
import {
  Circle,
  CircleCheck,
  Clock,
  KeyRound,
  ShieldAlert,
  Unplug,
  TimerOff,
} from "lucide-react";
import {
  passiveStatusPresentation,
  type PassiveStatusView,
} from "./passiveStatus";
import "./passiveStatus.css";
const icons = {
  unknown: Circle,
  healthy: CircleCheck,
  slow: Clock,
  login: KeyRound,
  permission: ShieldAlert,
  failed: Unplug,
  timeout: TimerOff,
};
export function PassiveServerStatusIcon({
  status,
  zh,
}: {
  status?: PassiveStatusView;
  zh: boolean;
}) {
  const view = passiveStatusPresentation(status, zh);
  const Icon = icons[view.icon];
  return (
    <span
      className={`passive-server-status tone-${view.tone}`}
      role="img"
      aria-label={view.title}
      title={view.title}
      data-status-icon={view.icon}
    >
      <Icon size={13} aria-hidden="true" />
    </span>
  );
}
export function PassiveServerStatusDetails({
  status,
  zh,
}: {
  status?: PassiveStatusView;
  zh: boolean;
}) {
  const view = passiveStatusPresentation(status, zh);
  return (
    <dl
      className="passive-server-details"
      aria-label={tFor(zh ? "zh-CN" : "en-US", "shell.p4.passive.connection.status")}
      title={view.note}
    >
      {view.rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
/**
 * Independent collapsed panel opened from the bottom status icon. It owns the three passive status
 * rows (one inline row on wide screens, wrapping on narrow) plus the manual check action; the P4 task
 * panel no longer contains either.
 */
export function PassiveStatusPanel({
  id,
  status,
  zh,
  native,
  onCheckServer,
  checkingServer,
  onClose,
}: {
  id: string;
  status?: PassiveStatusView;
  zh: boolean;
  native: boolean;
  onCheckServer?(): void;
  checkingServer: boolean;
  onClose(): void;
}) {
  const view = passiveStatusPresentation(status, zh);
  const reason = onCheckServer
    ? ""
    : native
      ? tFor(zh ? "zh-CN" : "en-US", "shell.the.connection.is.not.ready")
      : tFor(zh ? "zh-CN" : "en-US", "shell.manual.check.requires.the.desktop");
  const checkTitle = checkingServer
    ? tFor(zh ? "zh-CN" : "en-US", "shell.checking")
    : onCheckServer
      ? tFor(zh ? "zh-CN" : "en-US", "shell.check.reachability.only.preserve.response")
      : reason;
  return (
    <section
      id={id}
      className="passive-server-panel"
      role="dialog"
      aria-label={tFor(zh ? "zh-CN" : "en-US", "shell.p4.connection.status")}
    >
      <header role="presentation">
        <span>{tFor(zh ? "zh-CN" : "en-US", "shell.p4.connection.status")}</span>
        <button
          onClick={onClose}
          aria-label={tFor(zh ? "zh-CN" : "en-US", "shell.close.connection.status")}
        >
          ×
        </button>
      </header>
      <PassiveServerStatusDetails status={status} zh={zh} />
      <div className="passive-server-check">
        <button
          className="secondary"
          disabled={!onCheckServer || checkingServer}
          aria-busy={checkingServer}
          title={checkTitle}
          onClick={() => {
            if (!checkingServer) onCheckServer?.();
          }}
        >
          {checkingServer
            ? tFor(zh ? "zh-CN" : "en-US", "shell.checking")
            : tFor(zh ? "zh-CN" : "en-US", "shell.check.now")}
        </button>
      </div>
      {!onCheckServer && (
        <p className="passive-server-check-reason" role="status">
          {reason}
        </p>
      )}
      <p className="passive-server-note">{view.note}</p>
    </section>
  );
}
