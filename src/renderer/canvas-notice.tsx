import { useRef, useState, type ReactNode } from "react";
import { LoaderCircle, X } from "./icons.js";
import "./canvas-notice.css";

export function CanvasNotice({ message, detail, tone = "neutral", className = "", actionLabel, onAction, onDismiss, children }: {
  message: string;
  detail?: string;
  tone?: "neutral" | "error" | "warning";
  className?: string;
  actionLabel?: string;
  onAction?: () => Promise<unknown>;
  onDismiss?: () => void;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [failure, setFailure] = useState<{ identity: string; detail: string }>();
  const [dismissed, setDismissed] = useState<string>();
  const identity = `${message}\n${detail ?? ""}`;
  if (dismissed === identity) return null;
  const retryFailed = failure?.identity === identity;
  const details = retryFailed ? failure.detail : detail;
  return <div className={`canvas-notice is-${tone} ${className}`} role={tone === "error" ? "alert" : "status"}>
    <span className="canvas-notice-dot" aria-hidden="true" />
    <div className="canvas-notice-content"><span>{message}</span>{retryFailed ? <span className="canvas-notice-feedback">Retry failed. See details.</span> : null}{details ? <details><summary>Details</summary><div>{details}</div></details> : null}</div>
    {children}
    {onAction ? <button type="button" disabled={busy} onClick={() => {
      if (pending.current) return;
      pending.current = true; setBusy(true); setFailure(undefined);
      void Promise.resolve().then(onAction).catch((cause) => {
        setFailure({ identity, detail: cause instanceof Error ? cause.message : String(cause) });
      }).finally(() => { pending.current = false; setBusy(false); });
    }}>{busy ? <><LoaderCircle size={12} className="spin" />Retrying…</> : actionLabel ?? "Retry"}</button> : null}
    <button type="button" className="canvas-notice-close" aria-label="Dismiss notice" title="Dismiss" onClick={() => { setDismissed(identity); onDismiss?.(); }}><X size={13} /></button>
  </div>;
}
