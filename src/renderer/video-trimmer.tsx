import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { LibraryAsset } from "../shared/contracts.js";
import { uploadLibraryAsset } from "./api.js";
import { LoaderCircle, Pause, Play, Scissors } from "./icons.js";
import { t } from "./i18n.js";
import {
  clampVideoTrim,
  isWholeVideo,
  MIN_TRIM_SECONDS,
  trimmedVideoType,
  trimVideo,
  videoFilmstrip,
  type VideoTrim,
} from "./video-trim.js";

/** Arrow keys move a focused handle by this many seconds; with Shift, a tenth of it. */
const KEY_STEP = 1;
/** Frames in the strip under the handles. */
const FILMSTRIP_FRAMES = 10;
const FILMSTRIP_HEIGHT = 44;

type Edge = "start" | "end";

/**
 * A video with its own controls for trimming: play and pause, a strip of
 * frames to scrub, and two handles that set the part to keep. Saving encodes
 * that part as a new video; the original stays as it is.
 */
export function VideoTrimmer({
  url,
  label,
  loadSource,
  onSave,
}: {
  url: string;
  label: string;
  /** The video's file, for its frames and for encoding the trimmed part. */
  loadSource: () => Promise<Blob>;
  /** Keeps the trimmed video; resolves once it is saved. */
  onSave: (video: Blob, trim: VideoTrim) => Promise<void>;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const source = useRef<Promise<Blob> | undefined>(undefined);
  const [duration, setDuration] = useState<number>();
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [trim, setTrim] = useState<VideoTrim>();
  const [frames, setFrames] = useState<string[]>([]);
  const [saving, setSaving] = useState<{
    progress: number;
    controller: AbortController;
  }>();
  const [error, setError] = useState<string>();
  const dragging = useRef<{ pointerId: number; edge?: Edge } | undefined>(
    undefined,
  );

  const file = useCallback(
    () => (source.current ??= loadSource()),
    [loadSource],
  );
  const kept = trim ?? (duration ? { start: 0, end: duration } : undefined);
  const changed = Boolean(duration && kept && !isWholeVideo(kept, duration));

  useEffect(() => {
    let cancelled = false;
    void file()
      .then((blob) => videoFilmstrip(blob, FILMSTRIP_FRAMES, FILMSTRIP_HEIGHT))
      .then((strip) => {
        if (!cancelled) setFrames(strip);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [file]);

  // Leaving the trimmer stops a save in progress.
  useEffect(() => () => saving?.controller.abort(), [saving?.controller]);

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
    if (!element || !kept) return;
    if (!element.paused) return element.pause();
    // Play shows the kept part, from its start when the playhead is outside it.
    if (
      changed &&
      (element.currentTime < kept.start ||
        element.currentTime >= kept.end - 0.05)
    )
      seek(kept.start);
    void element.play().catch(() => undefined);
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
    setTrim(next);
    seek(next[edge]);
  };

  const onPointerDown = (
    event: ReactPointerEvent<HTMLElement>,
    edge?: Edge,
  ) => {
    if (event.button !== 0 || saving) return;
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
    if (event.key === " " && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      return togglePlay();
    }
    const step = event.shiftKey ? KEY_STEP / 10 : KEY_STEP;
    const delta =
      event.key === "ArrowLeft"
        ? -step
        : event.key === "ArrowRight"
          ? step
          : undefined;
    if (delta === undefined || saving) return;
    event.preventDefault();
    event.stopPropagation();
    if (edge && kept) moveEdge(edge, kept[edge] + delta);
    else seek(time + delta);
  };

  const save = async () => {
    if (!kept || !changed || saving) return;
    const controller = new AbortController();
    video.current?.pause();
    setError(undefined);
    setSaving({ progress: 0, controller });
    try {
      const trimmed = await trimVideo(await file(), kept, {
        signal: controller.signal,
        onProgress: (progress) =>
          setSaving((current) =>
            current?.controller === controller
              ? { ...current, progress }
              : current,
          ),
      });
      if (controller.signal.aborted) return;
      await onSave(trimmed, kept);
      setTrim(undefined);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          t("videoTrim.failed", {
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        );
    } finally {
      setSaving((current) =>
        current?.controller === controller ? undefined : current,
      );
    }
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
          if (Number.isFinite(length) && length > 0) setDuration(length);
        }}
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
          disabled={!duration}
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
                    aria-disabled={saving ? true : undefined}
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
      <div className="video-trimmer-footer">
        <span className="video-trimmer-summary" aria-live="polite">
          {kept && changed
            ? t("videoTrim.kept", {
                start: formatTime(kept.start),
                end: formatTime(kept.end),
                length: (kept.end - kept.start).toFixed(1),
              })
            : t("videoTrim.hint")}
        </span>
        {error ? (
          <span className="video-trimmer-error" role="alert">
            {error}
          </span>
        ) : null}
        {saving ? (
          <>
            <span
              className="video-trimmer-progress"
              role="progressbar"
              aria-label={t("videoTrim.saving")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(saving.progress * 100)}
            >
              <LoaderCircle className="spin" size={14} />
              {t("videoTrim.savingPercent", {
                percent: Math.round(saving.progress * 100),
              })}
            </span>
            <button type="button" onClick={() => saving.controller.abort()}>
              {t("common.cancel")}
            </button>
          </>
        ) : (
          <>
            {changed ? (
              <button type="button" onClick={() => setTrim(undefined)}>
                {t("videoTrim.reset")}
              </button>
            ) : null}
            <button
              type="button"
              className="video-trimmer-save"
              disabled={!changed}
              title={t("videoTrim.saveTitle")}
              onClick={() => void save()}
            >
              <Scissors size={14} />
              {t("videoTrim.save")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Uploads a trimmed video to the Library under the original's name with a
 * trimmed suffix, recording where it was cut from when the original is a
 * Library asset.
 */
export async function saveTrimmedVideo(
  video: Blob,
  trim: VideoTrim,
  original: { name: string; libraryAssetId?: string },
): Promise<LibraryAsset> {
  const type = trimmedVideoType(video.type);
  const stem = original.name.replace(/\.[^./]+$/, "") || "video";
  const name = `${t("videoTrim.fileName", { name: stem }).slice(0, 190)}.${type.extension}`;
  const kept = {
    start: roundMilliseconds(trim.start),
    end: roundMilliseconds(trim.end),
  };
  return uploadLibraryAsset(
    new File([video], name, { type: type.mediaType }),
    type.mediaType,
    roundMilliseconds(kept.end - kept.start),
    undefined,
    original.libraryAssetId
      ? { assetId: original.libraryAssetId, trim: kept }
      : undefined,
  );
}

function roundMilliseconds(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/** A time to the nearest tenth of a second as m:ss.t, such as 1:04.2. */
export function formatTime(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10));
  const minutes = Math.floor(tenths / 600);
  const rest = tenths - minutes * 600;
  return `${minutes}:${String(Math.floor(rest / 10)).padStart(2, "0")}.${rest % 10}`;
}
