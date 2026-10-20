import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type PlayableVideoClip } from "../shared/playable-video-clip.js";
import { X } from "./icons.js";
import { t } from "./i18n.js";
import { VideoTrimEditor } from "./video-trim-editor.js";

/** Accept seconds or minutes:seconds, retaining original-file coordinates. */
export function parseTrimTime(value: string): number | undefined {
  const text = value.trim();
  if (!/^(?:\d+:)?\d+(?:\.\d{1,3})?$/.test(text)) return undefined;
  const parts = text.split(":").map(Number);
  if (parts.length === 2 && parts[1]! >= 60) return undefined;
  const seconds = parts.length === 2 ? parts[0]! * 60 + parts[1]! : parts[0]!;
  return Number.isFinite(seconds) ? seconds : undefined;
}

const round = (value: number) => Math.round(value * 1000) / 1000;
const display = (value: number) => {
  const milliseconds = Math.round(value * 1000);
  return `${Math.floor(milliseconds / 60000)}:${((milliseconds % 60000) / 1000).toFixed(3).padStart(6, "0")}`;
};

/** Edits a draft against the original Blob; only Apply writes project source. */
export function PlayableVideoTrimDialog({
  blob,
  clip,
  onApply,
  onClose,
}: {
  blob: Blob;
  clip?: PlayableVideoClip;
  onApply: (clip: PlayableVideoClip | undefined) => Promise<void>;
  onClose: () => void;
}) {
  const titleId = useId();
  const hintId = useId();
  const dialog = useRef<HTMLElement>(null);
  const callbacks = useRef({ onClose, onApply });
  callbacks.current = { onClose, onApply };
  const pending = useRef(false);
  const [url, setUrl] = useState<string>();
  const [duration, setDuration] = useState(0);
  const [startText, setStartText] = useState(display(clip?.start ?? 0));
  const [endText, setEndText] = useState(
    clip?.end === undefined ? "" : display(clip.end),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const start = parseTrimTime(startText);
  const end = parseTrimTime(endText);
  const minimum = Math.min(0.1, duration);
  const valid =
    duration > 0 &&
    start !== undefined &&
    end !== undefined &&
    start >= 0 &&
    end <= duration + 0.001 &&
    end - start >= minimum - 0.0005;
  const selectedStart = valid ? start : 0;
  const selectedEnd = valid ? Math.min(end, duration) : duration;

  useEffect(() => {
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    dialog.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!pending.current) callbacks.current.onClose();
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const elements = [
        ...dialog.current.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), [tabindex='0']:not([aria-disabled='true'])",
        ),
      ];
      const first = elements[0];
      const last = elements.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === dialog.current)
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          document.activeElement === dialog.current)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      previous?.focus();
    };
  }, []);

  const apply = async () => {
    if (!valid || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const next =
        start === 0 && Math.abs(end - duration) < 0.001
          ? undefined
          : {
              start: round(start),
              ...(Math.abs(end - duration) < 0.001 ? {} : { end: round(end) }),
            };
      await callbacks.current.onApply(next);
      callbacks.current.onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="project-create-backdrop playable-trim-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={dialog}
        className="project-create-dialog playable-trim-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hintId}
        tabIndex={-1}
      >
        <header>
          <div>
            <h2 id={titleId}>{t("sceneWorkbench.trim.title")}</h2>
            <p id={hintId}>{t("sceneWorkbench.trim.hint")}</p>
          </div>
          <button
            type="button"
            aria-label={t("common.close")}
            disabled={busy}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void apply();
          }}
        >
          {url ? (
            <VideoTrimEditor
              url={url}
              label={t("sceneWorkbench.trim.title")}
              loadSource={() => Promise.resolve(blob)}
              trim={
                start !== undefined && end !== undefined
                  ? { start, end }
                  : undefined
              }
              disabled={busy || !valid}
              onTrimChange={(next) => {
                setStartText(display(next?.start ?? 0));
                setEndText(display(next?.end ?? duration));
              }}
              onDurationChange={(length) => {
                const total = Math.floor(length * 1000) / 1000;
                setDuration(total);
                if (total > 0)
                  setEndText(display(Math.min(clip?.end ?? total, total)));
              }}
            />
          ) : null}
          <div className="playable-trim-times">
            <label>
              <span>{t("sceneWorkbench.trim.start")}</span>
              <input
                aria-label={t("sceneWorkbench.trim.startTime")}
                value={startText}
                disabled={busy}
                onChange={(event) => {
                  setStartText(event.target.value);
                }}
              />
            </label>
            <label>
              <span>{t("sceneWorkbench.trim.end")}</span>
              <input
                aria-label={t("sceneWorkbench.trim.endTime")}
                value={endText}
                disabled={busy}
                onChange={(event) => {
                  setEndText(event.target.value);
                }}
              />
            </label>
            <p>
              {valid
                ? t("sceneWorkbench.trim.length", {
                    seconds: round(selectedEnd - selectedStart),
                  })
                : t("sceneWorkbench.trim.invalid")}
            </p>
          </div>
          {error ? (
            <p className="playable-trim-error" role="alert">
              {error}
            </p>
          ) : null}
          <footer>
            <button
              type="button"
              disabled={!duration || busy}
              onClick={() => {
                setStartText(display(0));
                setEndText(display(duration));
              }}
            >
              {t("sceneWorkbench.trim.reset")}
            </button>
            <span />
            <button type="button" disabled={busy} onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              className="project-create-submit"
              disabled={!valid || busy}
            >
              {t(
                busy
                  ? "sceneWorkbench.trim.saving"
                  : "sceneWorkbench.trim.apply",
              )}
            </button>
          </footer>
        </form>
      </section>
    </div>,
    document.body,
  );
}
