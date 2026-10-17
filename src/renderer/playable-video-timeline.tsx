import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Flag, Pause, Play } from "./icons.js";
import type {
  PlayableMediaCommand,
  PlayableMediaState,
} from "../shared/playable-player-protocol.js";
import { formatMediaTime } from "../shared/playable-chat-context.js";
import { t } from "./i18n.js";

/** Arrow keys on the track step this many seconds; with Shift, a tenth of it. */
const KEY_STEP = 1;
/** How far, in seconds, the playhead waits for a video behind it instead of stepping back. */
const HOLD_BEHIND = 0.3;

/** The background video as the timeline last heard of it, and when. */
export interface TimelineMedia extends PlayableMediaState {
  /** `performance.now()` when the preview reported it, to move the playhead in between. */
  receivedAt: number;
}

/**
 * A timeline for the Scene's background video, over the preview: play and
 * pause, the time, a track to scrub, and Mark, which puts the current moment
 * in the chat. The video plays in the preview frame; this only sends it
 * commands and shows what it reports.
 */
export function VideoTimeline({
  media,
  moment,
  onCommand,
  onMark,
}: {
  media: TimelineMedia;
  /** The moment in the chat, in seconds, shown on the track. */
  moment?: number;
  onCommand: (command: PlayableMediaCommand) => void;
  onMark: (time: number) => void;
}) {
  const [scrubbing, setScrubbing] = useState<{
    pointerId: number;
    time: number;
  }>();
  const now = usePlayheadTime(media);
  const time = scrubbing?.time ?? now;
  const fraction = (value: number) =>
    `${(Math.min(Math.max(value / media.duration, 0), 1) * 100).toFixed(3)}%`;
  const seek = (value: number) =>
    onCommand({
      action: "seek",
      time: Math.min(Math.max(value, 0), media.duration),
    });
  const timeAt = (event: ReactPointerEvent<HTMLElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return bounds.width
      ? Math.min(Math.max((event.clientX - bounds.left) / bounds.width, 0), 1) *
          media.duration
      : 0;
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? KEY_STEP / 10 : KEY_STEP;
    const target =
      event.key === "ArrowLeft"
        ? time - step
        : event.key === "ArrowRight"
          ? time + step
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? media.duration
              : undefined;
    if (target === undefined) return;
    event.preventDefault();
    seek(target);
  };

  return (
    <div
      className="playable-video-timeline"
      role="group"
      aria-label={t("sceneWorkbench.timeline.label")}
    >
      <button
        type="button"
        title={
          media.paused
            ? t("sceneWorkbench.timeline.play")
            : t("sceneWorkbench.timeline.pause")
        }
        aria-label={
          media.paused
            ? t("sceneWorkbench.timeline.play")
            : t("sceneWorkbench.timeline.pause")
        }
        onClick={() => onCommand({ action: media.paused ? "play" : "pause" })}
      >
        {media.paused ? <Play size={14} /> : <Pause size={14} />}
      </button>
      <span className="playable-video-timeline-time">
        {formatMediaTime(time)} / {formatMediaTime(media.duration)}
      </span>
      <div
        className="playable-video-timeline-track"
        role="slider"
        tabIndex={0}
        aria-label={t("sceneWorkbench.timeline.position")}
        aria-valuemin={0}
        aria-valuemax={Number(media.duration.toFixed(1))}
        aria-valuenow={Number(time.toFixed(1))}
        aria-valuetext={formatMediaTime(time)}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const next = timeAt(event);
          setScrubbing({ pointerId: event.pointerId, time: next });
          seek(next);
        }}
        onPointerMove={(event) => {
          if (scrubbing?.pointerId !== event.pointerId) return;
          const next = timeAt(event);
          setScrubbing({ pointerId: event.pointerId, time: next });
          seek(next);
        }}
        onPointerUp={(event) => {
          if (scrubbing?.pointerId === event.pointerId) setScrubbing(undefined);
        }}
        onPointerCancel={(event) => {
          if (scrubbing?.pointerId === event.pointerId) setScrubbing(undefined);
        }}
      >
        <span
          className="playable-video-timeline-played"
          style={{ width: fraction(time) }}
        />
        {moment !== undefined ? (
          <span
            className="playable-video-timeline-moment"
            style={{ left: fraction(moment) }}
            title={formatMediaTime(moment)}
          />
        ) : null}
        <span
          className="playable-video-timeline-playhead"
          style={{ left: fraction(time) }}
        />
      </div>
      <button
        type="button"
        title={t("sceneWorkbench.timeline.markTitle")}
        onClick={() => onMark(time)}
      >
        <Flag size={14} />
        <span>{t("sceneWorkbench.timeline.mark")}</span>
      </button>
    </div>
  );
}

/**
 * Where the playhead is now. The preview reports the time a few times a
 * second, so while the video's time moves the playhead moves on from the last
 * report. A video asked to play that is still seeking or loading stands
 * still, so the playhead does not run ahead and jump back.
 */
function usePlayheadTime(media: TimelineMedia): number {
  const shown = useRef<number | undefined>(undefined);
  const estimate = () => {
    if (!media.advancing) return (shown.current = media.time);
    const next = Math.min(
      media.time + (performance.now() - media.receivedAt) / 1000,
      media.duration,
    );
    // A video that fell a little behind the estimate holds the playhead until it catches up.
    const held =
      shown.current !== undefined &&
      next < shown.current &&
      shown.current - next < HOLD_BEHIND;
    return (shown.current = held ? shown.current! : next);
  };
  const [time, setTime] = useState(estimate);
  const latest = useRef(estimate);
  latest.current = estimate;

  useEffect(() => {
    setTime(latest.current());
    if (!media.advancing) return;
    let frame = requestAnimationFrame(function tick() {
      setTime(latest.current());
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [media]);

  return time;
}
