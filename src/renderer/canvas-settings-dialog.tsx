import { useEffect, useId, useRef, useState } from "react";
import type { Viewport } from "../shared/canvas-formats.js";
import {
  canvasFormatForViewport,
  canvasFormatPreset,
  canvasFormatSummary,
  type CanvasFormatPresetId,
} from "../shared/canvas-formats.js";
import { X } from "./icons.js";
import { CanvasFormatOptions } from "./canvas-format-options.js";

export function CanvasSettingsDialog({
  viewport,
  hasContent,
  onClose,
  onChange,
}: {
  viewport: Viewport;
  hasContent: boolean;
  onClose: () => void;
  onChange: (viewport: Viewport) => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const [selection, setSelection] = useState<CanvasFormatPresetId | undefined>(
    () => canvasFormatForViewport(viewport)?.id,
  );
  const selectedViewport = selection
    ? canvasFormatPreset(selection).viewport
    : viewport;
  const changed =
    selectedViewport.width !== viewport.width ||
    selectedViewport.height !== viewport.height;

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
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

  return (
    <div
      className="project-create-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        className="project-create-dialog story-canvas-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header>
          <div>
            <h2 id={titleId}>Canvas format</h2>
            <p>{canvasFormatSummary(viewport)}</p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="story-canvas-settings-content">
          <CanvasFormatOptions value={selection} onChange={setSelection} />
          {changed && hasContent ? (
            <p className="story-format-warning">
              Existing UI and media are not reframed automatically. Review every
              scene after applying this change.
            </p>
          ) : null}
        </div>
        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="project-create-submit"
            type="button"
            disabled={!changed}
            onClick={() => {
              onChange(selectedViewport);
              onClose();
            }}
          >
            Apply format
          </button>
        </footer>
      </section>
    </div>
  );
}
