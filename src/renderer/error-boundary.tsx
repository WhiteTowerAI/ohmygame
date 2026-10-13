import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "./i18n.js";

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
        <strong>{t("errorBoundary.failed", { label: this.props.label })}</strong>
        <p>{t("errorBoundary.hint")}</p>
        <details>
          <summary>{t("common.errorDetails")}</summary>
          <pre>{this.state.error.message}</pre>
        </details>
        <div>
          <button
            type="button"
            onClick={() => this.setState({ error: undefined })}
          >
            {t("errorBoundary.retry")}
          </button>
          {this.props.onHome ? (
            <button
              type="button"
              onClick={() => {
                this.props.onHome?.();
                this.setState({ error: undefined });
              }}
            >
              {t("errorBoundary.back")}
            </button>
          ) : null}
        </div>
      </div>
    );
  }
}
