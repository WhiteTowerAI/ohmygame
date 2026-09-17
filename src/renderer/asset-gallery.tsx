import { useEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { X } from "./icons.js";
import { ModelPreview } from "./model-preview.js";

export type AssetMediaType = "image" | "video" | "audio" | "model";

export function useNearViewport<T extends Element>(): readonly [RefObject<T | null>, boolean] {
  const target = useRef<T>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = target.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: "160px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [target, visible] as const;
}

export function AssetCardShell({ title, subtitle, preview, badge, footer, actions, className = "", articleRef, onOpen }: {
  title: string;
  subtitle?: ReactNode;
  preview: ReactNode;
  badge?: ReactNode;
  footer?: ReactNode;
  actions?: ReactNode;
  className?: string;
  articleRef?: Ref<HTMLElement>;
  onOpen: () => void;
}) {
  return <article className={`library-asset-card${className ? ` ${className}` : ""}`} ref={articleRef}>
    <button className="library-asset-card-open" type="button" onClick={onOpen} title={title}>
      <div className="library-asset-thumbnail">
        {preview}
        {badge ? <span className="library-asset-type">{badge}</span> : null}
      </div>
      <span className="library-asset-info"><strong>{title}</strong>{subtitle ? <span>{subtitle}</span> : null}</span>
    </button>
    {actions}
    {footer}
  </article>;
}

export function AssetDialogShell({ title, subtitle, preview, footer, headerActions, headerActionsRef, labelledBy, onClose, onEscape }: {
  title: string;
  subtitle?: ReactNode;
  preview: ReactNode;
  footer: ReactNode;
  headerActions?: ReactNode;
  headerActionsRef?: Ref<HTMLDivElement>;
  labelledBy: string;
  onClose: () => void;
  onEscape?: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  const escapeRef = useRef(onEscape);
  closeRef.current = onClose;
  escapeRef.current = onEscape;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        (escapeRef.current ?? closeRef.current)();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled), [href], audio[controls], video[controls], [tabindex]:not([tabindex='-1'])")];
      if (!focusable.length) {
        event.preventDefault();
        dialog.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (document.activeElement === dialog.current) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => {
      window.removeEventListener("keydown", keyboard);
      previousFocus?.focus();
    };
  }, []);

  return <div className="library-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="library-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}>
      <header className="library-dialog-header">
        <div className="library-dialog-title"><h2 id={labelledBy} title={title}>{title}</h2>{subtitle ? <p>{subtitle}</p> : null}</div>
        <div className="library-dialog-header-actions" ref={headerActionsRef}>
          {headerActions}
          <button type="button" onClick={onClose} aria-label="Close asset preview"><X size={17} /></button>
        </div>
      </header>
      <div className="library-dialog-preview">{preview}</div>
      {footer}
    </section>
  </div>;
}

export function AssetMedia({ type, url, label }: { type: AssetMediaType; url: string; label: string }) {
  if (type === "image") return <img src={url} alt={label} />;
  if (type === "video") return <video src={url} controls preload="metadata" />;
  if (type === "audio") return <audio src={url} controls />;
  return <ModelPreview source={url} label={label} minHeight={420} />;
}
