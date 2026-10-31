import { Component, type ReactNode } from "react";
import { closeState } from "../closeGuard";
interface Props {
  children: ReactNode;
  resetKey: string;
  zh: boolean;
}
export class PanelErrorBoundary extends Component<
  Props,
  { error: string | null }
> {
  state: { error: string | null } = { error: null };
  componentDidCatch() {
    closeState.markUnknown();
  }
  static getDerivedStateFromError(error: unknown) {
    return { error: String(error) };
  }
  componentDidUpdate(previous: Props) {
    if (previous.resetKey !== this.props.resetKey && this.state.error)
      this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="workspace-empty" role="alert">
        <h2>
          {this.props.zh
            ? "此页签暂时无法显示"
            : "This tab could not be displayed"}
        </h2>
        <p>{this.state.error}</p>
        <button onClick={() => location.reload()}>
          {this.props.zh ? "重新加载应用" : "Reload app"}
        </button>
      </div>
    );
  }
}
