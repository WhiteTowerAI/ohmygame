import type { PlayableMediaCommand, PlayableMediaState } from "./playable-player-protocol.js";
import type { DocumentPlayableSurfaceHost } from "./playable-page-host.js";

export interface BackdropMediaReport {
  control: (command: PlayableMediaCommand) => void;
  stop: () => void;
}

const MEDIA_EVENTS = ["loadedmetadata", "durationchange", "timeupdate", "play", "playing", "waiting", "pause", "seeking", "seeked", "ended"] as const;

/**
 * Reports the Node's background video to the Workbench timeline as it plays,
 * and applies the timeline's commands to it.
 */
export function reportBackdropMedia(
  host: DocumentPlayableSurfaceHost,
  send: (media: PlayableMediaState | undefined) => void,
): BackdropMediaReport {
  let video: HTMLVideoElement | undefined;
  const report = () => send(video && mediaState(video));
  const listen = (target: HTMLVideoElement | undefined, add: boolean) => {
    for (const type of MEDIA_EVENTS) {
      if (add) target?.addEventListener(type, report);
      else target?.removeEventListener(type, report);
    }
  };
  const stopWatching = host.watchBackdropVideo((next) => {
    listen(video, false);
    video = next;
    listen(video, true);
    report();
  });
  return {
    control: (command) => {
      if (!video) return;
      if (command.action === "seek") video.currentTime = Math.min(command.time, video.duration || command.time);
      else if (command.action === "pause") video.pause();
      // Where sound may not start on its own, play muted rather than not at all.
      else void video.play().catch((error: unknown) => {
        if ((error as Error | undefined)?.name !== "NotAllowedError") return;
        video!.muted = true;
        return video!.play();
      }).catch(() => {});
    },
    stop: () => {
      stopWatching();
      listen(video, false);
      video = undefined;
    },
  };
}

/**
 * Undefined until the video has loaded its metadata. Its length is known a
 * moment earlier, before the Node's code can move it from the start.
 */
function mediaState(video: HTMLVideoElement): PlayableMediaState | undefined {
  if (video.readyState < HTMLMediaElement.HAVE_METADATA) return undefined;
  if (!Number.isFinite(video.duration) || video.duration <= 0) return undefined;
  const assetId = video.closest('[data-media="backdrop"]')?.getAttribute("data-asset");
  return {
    ...(assetId ? { assetId } : {}),
    duration: video.duration,
    time: Math.min(video.currentTime, video.duration),
    paused: video.paused || video.ended,
    advancing: !video.paused && !video.ended && !video.seeking && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA,
  };
}
