import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "./i18n.js";
import { TriangleAlert } from "./icons.js";
import { Button, Empty } from "./ui/index.js";

/** A failed pane keeps navigation and the conversation input available. */
export class ErrorBoundary extends Component<
  {
    children: ReactNode;
    label: string;
    resetKey?: string;
    onHome?: () => void;
    homeLabel?: string;
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
      <div className="pane-error-boundary">
        <Empty
          fill
          tone="error"
          icon={<TriangleAlert size="md" />}
          title={t("errorBoundary.failed", { label: this.props.label })}
          description={t("errorBoundary.hint")}
          details={this.state.error.message}
          action={
            <>
              <Button
                variant="primary"
                onClick={() => this.setState({ error: undefined })}
              >
                {t("errorBoundary.retry")}
              </Button>
              {this.props.onHome ? (
                <Button
                  onClick={() => {
                    this.props.onHome?.();
                    this.setState({ error: undefined });
                  }}
                >
                  {this.props.homeLabel ?? t("errorBoundary.back")}
                </Button>
              ) : null}
            </>
          }
        />
      </div>
    );
  }
}
