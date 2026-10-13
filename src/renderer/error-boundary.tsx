import { Component, type ErrorInfo, type ReactNode } from "react";

/** A failed pane keeps navigation and the conversation input available. */
export class ErrorBoundary extends Component<
  {
    children: ReactNode;
    label: string;
    resetKey?: string;
    onHome?: () => void;
  },
  { error?: Error }
> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.label} failed`, error, info.componentStack);
  }
  componentDidUpdate(previous: Readonly<typeof this.props>) {
    if (previous.resetKey !== this.props.resetKey && this.state.error)
      this.setState({ error: undefined });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="pane-error-boundary" role="alert">
        <strong>{this.props.label} could not be displayed</strong>
        <p>You can retry this view or return to your projects.</p>
        <details>
          <summary>Error details</summary>
          <pre>{this.state.error.message}</pre>
        </details>
        <div>
          <button
            type="button"
            onClick={() => this.setState({ error: undefined })}
          >
            Retry view
          </button>
          {this.props.onHome ? (
            <button
              type="button"
              onClick={() => {
                this.props.onHome?.();
                this.setState({ error: undefined });
              }}
            >
              Back to projects
            </button>
          ) : null}
        </div>
      </div>
    );
  }
}
