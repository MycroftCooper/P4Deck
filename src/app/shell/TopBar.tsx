import { ChevronDown } from "lucide-react";
import type { RuntimeInfo } from "../../shared/contracts/types";
export function WorkspaceSwitcher({
  runtime,
  onSettings,
}: {
  runtime: RuntimeInfo;
  onSettings(): void;
}) {
  return (
    <div className="connection-picker">
      <button
        className="connection"
        onClick={onSettings}
        title={`${runtime.context.user}@${runtime.context.client} · ${runtime.context.server}\n${runtime.mode === "mock" ? "Demo / 演示连接" : runtime.connection.message}\nConnection settings / 连接设置`}
      >
        <span
          className={`status-dot connection-${runtime.mode === "mock" ? "demo" : runtime.connection.state}`}
        />
        <span className="connection-client">{runtime.context.client}</span>
        <ChevronDown size={13} />
      </button>
    </div>
  );
}
export function TopBar({
  runtime,
  onSettings,
}: {
  runtime: RuntimeInfo;
  onSettings(): void;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">P4</span>
        <strong>P4Deck</strong>
      </div>
      <WorkspaceSwitcher runtime={runtime} onSettings={onSettings} />
      <div className="titlebar-reserved" aria-hidden="true" />
    </header>
  );
}
