import { useEffect, useId, useRef, useState } from "react";
import type { StoryPlayerConfig } from "../shared/contracts.js";
import { X } from "./icons.js";

export function StoryPlayerSettingsDialog({ controls, onClose, onApply }: {
  controls: StoryPlayerConfig["controls"];
  onClose: () => void;
  onApply: (controls: StoryPlayerConfig["controls"]) => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const [draft, setDraft] = useState(() => structuredClone(controls));
  const changed = draft.pause !== controls.pause;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex]:not([tabindex='-1'])")];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (document.activeElement === dialog.current || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  return <div className="project-create-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog} className="project-create-dialog story-player-settings-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header>
        <div><h2 id={titleId}>Player</h2><p>Controls shown while the story is playing.</p></div>
        <button type="button" aria-label="Close" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="story-player-settings-content">
        <div className="story-player-setting">
          <div><strong>Pause control</strong><span>Show pause in scenes, interactions, and choices.</span></div>
          <button className="story-player-switch" type="button" role="switch" aria-label="Pause control" aria-checked={draft.pause} onClick={() => setDraft((current) => ({ ...current, pause: !current.pause }))}><span /></button>
        </div>
      </div>
      <footer>
        <button type="button" onClick={onClose}>Cancel</button>
        <button className="project-create-submit" type="button" disabled={!changed} onClick={() => { onApply(draft); onClose(); }}>Apply</button>
      </footer>
    </section>
  </div>;
}
