import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Pause, Play } from "./icons.js";
import { t } from "./i18n.js";
import {
  clampVideoTrim,
  isWholeVideo,
  MIN_TRIM_SECONDS,
  videoFilmstrip,
  type VideoTrim,
} from "./video-trim.js";

/** Arrow keys move a focused handle by this many seconds; with Shift, a tenth of it. */
const KEY_STEP = 1;
/** Frames in the strip under the handles. */
const FILMSTRIP_FRAMES = 10;
const FILMSTRIP_HEIGHT = 44;

type Edge = "start" | "end";

export interface VideoTrimEditorState {
  trim: VideoTrim | undefined;
  duration: number | undefined;
  changed: boolean;
  reset: () => void;
  pause: () => void;
}

/** Shared Asset Studio timeline. Persistence belongs to its caller, not this UI. */
export function VideoTrimEditor({
  url,
  label,
  loadSource,
  trim,
  onTrimChange,
  disabled = false,
  onDurationChange,
  renderFooter,
}: {
  url: string;
  label: string;
  loadSource: () => Promise<Blob>;
  trim?: VideoTrim;
  onTrimChange: (trim: VideoTrim | undefined) => void;
  disabled?: boolean;
  onDurationChange?: (duration: number) => void;
  renderFooter?: (state: VideoTrimEditorState) => ReactNode;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const loadSourceRef = useRef(loadSource);
  loadSourceRef.current = loadSource;
  const previousTrim = useRef(trim);
  const [duration, setDuration] = useState<number>();
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [frames, setFrames] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const dragging = useRef<{ pointerId: number; edge?: Edge } | undefined>(
    undefined,
  );

  const kept = trim ?? (duration ? { start: 0, end: duration } : undefined);
  const changed = Boolean(duration && kept && !isWholeVideo(kept, duration));

  useEffect(() => {
    let cancelled = false;
    void loadSourceRef
      .current()
      .then((blob) => videoFilmstrip(blob, FILMSTRIP_FRAMES, FILMSTRIP_HEIGHT))
      .then((strip) => {
        if (!cancelled) setFrames(strip);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [url]);

  // Numeric edits and Reset use the same preview as dragging the handles.
  useEffect(() => {
    const before = previousTrim.current;
    previousTrim.current = trim;
    const element = video.current;
    if (!element || !duration) return;
    if (before?.start !== trim?.start || before?.end !== trim?.end) {
      element.pause();
      element.currentTime = Math.min(
        trim && before?.end !== trim?.end && before?.start === trim?.start
          ? (trim?.end ?? duration)
          : (trim?.start ?? 0),
        Math.max(0, duration - 0.001),
      );
      setTime(element.currentTime);
    }
    if (disabled) element.pause();
  }, [trim?.start, trim?.end, duration, disabled]);

  // While playing, the playhead follows the video and stops at the end of the kept part.
  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function tick() {
      const element = video.current;
      if (!element) return;
      if (kept && changed && element.currentTime >= kept.end) {
        element.pause();
        element.currentTime = kept.end;
      }
      setTime(element.currentTime);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing, kept?.end, changed]);

  const seek = (seconds: number) => {
    const element = video.current;
    if (!element || !duration) return;
    const next = Math.min(Math.max(seconds, 0), duration);
    element.currentTime = next;
    setTime(next);
  };

  const togglePlay = () => {
    const element = video.current;
    if (!element || !kept || disabled) return;
    if (!element.paused) return element.pause();
    // Play shows the kept part, from its start when the playhead is outside it.
    if (
      changed &&
      (element.currentTime < kept.start ||
        element.currentTime >= kept.end - 0.05)
    )
      seek(kept.start);
    void element.play().catch(() => setError(t("videoTrim.unavailable")));
  };

  const timeAt = (clientX: number) => {
    const bounds = track.current?.getBoundingClientRect();
    if (!bounds?.width || !duration) return 0;
    return (
      Math.min(Math.max((clientX - bounds.left) / bounds.width, 0), 1) *
      duration
    );
  };

  const moveEdge = (edge: Edge, seconds: number) => {
    if (!duration || !kept) return;
    const next = clampVideoTrim(
      edge === "start"
        ? {
            start: Math.min(seconds, kept.end - MIN_TRIM_SECONDS),
            end: kept.end,
          }
        : {
            start: kept.start,
            end: Math.max(seconds, kept.start + MIN_TRIM_SECONDS),
          },
      duration,
    );
    onTrimChange(next);
    seek(next[edge]);
  };

  const onPointerDown = (
    event: ReactPointerEvent<HTMLElement>,
    edge?: Edge,
  ) => {
    if (event.button !== 0 || disabled) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    video.current?.pause();
    dragging.current = {
      pointerId: event.pointerId,
      ...(edge ? { edge } : {}),
    };
    if (edge) moveEdge(edge, timeAt(event.clientX));
    else seek(timeAt(event.clientX));
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (disabled) return;
    const drag = dragging.current;
    if (drag?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (drag.edge) moveEdge(drag.edge, timeAt(event.clientX));
    else seek(timeAt(event.clientX));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragging.current?.pointerId === event.pointerId)
      dragging.current = undefined;
  };

  const onKey = (event: ReactKeyboardEvent<HTMLElement>, edge?: Edge) => {
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      (event.target instanceof HTMLElement && event.target.isContentEditable)
    )
      return;
    if (event.key === " " && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      event.stopPropagation();
      return togglePlay();
    }
    const step = event.shiftKey ? KEY_STEP / 10 : KEY_STEP;
    const delta =
      event.key === "ArrowLeft"
        ? -step
        : event.key === "ArrowRight"
          ? step
          : undefined;
    if (delta === undefined || disabled) return;
    event.preventDefault();
    event.stopPropagation();
    if (edge && kept) moveEdge(edge, kept[edge] + delta);
    else seek(time + delta);
  };

  const fraction = (seconds: number) =>
    `${duration ? (Math.min(Math.max(seconds / duration, 0), 1) * 100).toFixed(3) : 0}%`;

  return (
    <div className="video-trimmer" onKeyDown={(event) => onKey(event)}>
      <video
        ref={video}
        src={url}
        playsInline
        preload="auto"
        aria-label={label}
        onClick={togglePlay}
        onLoadedMetadata={(event) => {
          const length = event.currentTarget.duration;
          if (!Number.isFinite(length) || length <= 0) {
            setError(t("videoTrim.unavailable"));
            return;
          }
          setError(undefined);
          setDuration(length);
          event.currentTarget.currentTime = Math.min(
            trim?.start ?? 0,
            Math.max(0, length - 0.001),
          );
          setTime(event.currentTarget.currentTime);
          onDurationChange?.(length);
        }}
        onError={() => {
          setDuration(undefined);
          setError(t("videoTrim.unavailable"));
          onDurationChange?.(0);
        }}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onEnded={() => setPlaying(false)}
        onPlay={() => setPlaying(true)}
        onPause={(event) => {
          setPlaying(false);
          setTime(event.currentTarget.currentTime);
        }}
        onSeeked={(event) => setTime(event.currentTarget.currentTime)}
      />
      <div className="video-trimmer-bar">
        <button
          type="button"
          className="video-trimmer-play"
          disabled={!duration || disabled}
          title={playing ? t("videoTrim.pause") : t("videoTrim.play")}
          aria-label={playing ? t("videoTrim.pause") : t("videoTrim.play")}
          onClick={togglePlay}
        >
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <div
          ref={track}
          className="video-trimmer-track"
          role="slider"
          tabIndex={0}
          aria-disabled={disabled ? true : undefined}
          aria-label={t("videoTrim.position")}
          aria-valuemin={0}
          aria-valuemax={Number((duration ?? 0).toFixed(1))}
          aria-valuenow={Number(time.toFixed(1))}
          aria-valuetext={formatTime(time)}
          onPointerDown={(event) => onPointerDown(event)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={(event) => onKey(event)}
        >
          <div className="video-trimmer-frames" aria-hidden="true">
            {frames.map((frame, index) => (
              <img key={index} src={frame} alt="" draggable={false} />
            ))}
          </div>
          {kept && duration ? (
            <>
              <span
                className="video-trimmer-cut"
                style={{ left: 0, width: fraction(kept.start) }}
              />
              <span
                className="video-trimmer-cut"
                style={{ left: fraction(kept.end), right: 0 }}
              />
              <span
                className="video-trimmer-kept"
                style={{
                  left: fraction(kept.start),
                  width: `calc(${fraction(kept.end)} - ${fraction(kept.start)})`,
                }}
              >
                {(["start", "end"] as const).map((edge) => (
                  <span
                    key={edge}
                    className={`video-trimmer-handle is-${edge}`}
                    role="slider"
                    tabIndex={0}
                    aria-label={
                      edge === "start"
                        ? t("videoTrim.start")
                        : t("videoTrim.end")
                    }
                    aria-valuemin={0}
                    aria-valuemax={Number(duration.toFixed(1))}
                    aria-valuenow={Number(kept[edge].toFixed(1))}
                    aria-valuetext={formatTime(kept[edge])}
                    aria-disabled={disabled ? true : undefined}
                    onPointerDown={(event) => onPointerDown(event, edge)}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    onKeyDown={(event) => onKey(event, edge)}
                  />
                ))}
              </span>
            </>
          ) : null}
          <span
            className="video-trimmer-playhead"
            style={{ left: fraction(time) }}
          />
        </div>
        <span className="video-trimmer-time">
          {formatTime(time)} / {formatTime(duration ?? 0)}
        </span>
      </div>
      {error ? (
        <span className="video-trimmer-error" role="alert">
          {error}
        </span>
      ) : null}
      {renderFooter?.({
        trim: kept,
        duration,
        changed,
        reset: () => onTrimChange(undefined),
        pause: () => video.current?.pause(),
      })}
    </div>
  );
}
/** A time to the nearest tenth of a second as m:ss.t, such as 1:04.2. */
export function formatTime(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10));
  const minutes = Math.floor(tenths / 600);
  const rest = tenths - minutes * 600;
  return `${minutes}:${String(Math.floor(rest / 10)).padStart(2, "0")}.${rest % 10}`;
}
