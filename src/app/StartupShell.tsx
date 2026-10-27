import { Component, type PropsWithChildren } from "react";

export class StartupBoundary extends Component<
  PropsWithChildren,
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    window.dispatchEvent(
      new CustomEvent("p4deck:startup-error", { detail: error }),
    );
  }
  render() {
    return this.state.failed ? <StartupShell /> : this.props.children;
  }
}

/** The window has a frame immediately, while application modules load. */
export function StartupShell() {
  return (
    <div className="startup-shell" aria-label="P4Deck">
      <div className="startup-title">P4Deck</div>
      <div className="startup-toolbar" />
      <div className="startup-body">
        <aside />
        <main>
          <div className="startup-progress" role="status">
            正在启动 P4Deck…
          </div>
        </main>
      </div>
    </div>
  );
}
