/** Seconds in the original video, scoped to one Scene's background use. */
export interface PlayableVideoClip {
  start: number;
  end?: number;
}

export function parsePlayableVideoClip(
  start?: string | null,
  end?: string | null,
): PlayableVideoClip | undefined {
  if (start == null && end == null) return undefined;
  const number = (value: string) => {
    if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)))
      throw new Error("Video clip times must be finite, non-negative seconds.");
    return Number(value);
  };
  const clip = {
    start: start == null ? 0 : number(start),
    ...(end == null ? {} : { end: number(end) }),
  };
  if (clip.end !== undefined && clip.end <= clip.start)
    throw new Error("Video clip end must be after its start.");
  return clip;
}

/**
 * Installs before authored mount(), including projects with customized media
 * helpers. No clip attributes means no video listeners or playback changes.
 * Paused editor seeks remain in original-file coordinates; playing respects
 * the range. An early end uses the same event as the natural end of a video.
 */
export function installPlayableVideoClips(
  root: ShadowRoot,
  onDiagnostic: (message: string) => void = () => {},
): () => void {
  const view = root.ownerDocument.defaultView!;
  const controllers = new Map<HTMLVideoElement, () => void>();
  const scan = () => {
    const present = new Set<HTMLVideoElement>();
    for (const backdrop of root.querySelectorAll('[data-media="backdrop"]')) {
      let clip: PlayableVideoClip | undefined;
      try {
        clip = parsePlayableVideoClip(
          backdrop.getAttribute("data-clip-start"),
          backdrop.getAttribute("data-clip-end"),
        );
      } catch (cause) {
        onDiagnostic(String(cause));
        continue;
      }
      if (!clip || backdrop.getAttribute("data-type") !== "video") continue;
      for (const video of backdrop.querySelectorAll<HTMLVideoElement>(
        "video",
      )) {
        present.add(video);
        if (!controllers.has(video))
          controllers.set(
            video,
            controlPlayableVideoClip(video, clip, onDiagnostic),
          );
      }
    }
    for (const [video, stop] of controllers)
      if (!present.has(video)) {
        stop();
        controllers.delete(video);
      }
  };
  const observer = new view.MutationObserver(scan);
  observer.observe(root, { childList: true, subtree: true });
  scan();
  return () => {
    observer.disconnect();
    for (const stop of controllers.values()) stop();
    controllers.clear();
  };
}

export function controlPlayableVideoClip(
  video: HTMLVideoElement,
  clip: PlayableVideoClip,
  onDiagnostic: (message: string) => void,
): () => void {
  const view = video.ownerDocument.defaultView!;
  let stopped = false;
  let disabled = false;
  let finished = false;
  let initialized = false;
  let frame: number | undefined;
  let videoFrame = false;
  const cancel = () => {
    if (frame === undefined) return;
    if (videoFrame) video.cancelVideoFrameCallback(frame);
    else view.cancelAnimationFrame(frame);
    frame = undefined;
  };
  const initialize = () => {
    if (initialized || !Number.isFinite(video.duration) || video.duration <= 0)
      return;
    initialized = true;
    if (clip.start >= video.duration) {
      disabled = true;
      onDiagnostic(
        "Video clip starts outside the video. Playing the full video instead.",
      );
      return;
    }
    video.currentTime = clip.start;
  };
  const schedule = () => {
    if (stopped || disabled || video.paused || frame !== undefined) return;
    videoFrame = typeof video.requestVideoFrameCallback === "function";
    frame = videoFrame
      ? video.requestVideoFrameCallback(tick)
      : view.requestAnimationFrame(tick);
  };
  const check = () => {
    initialize();
    if (!initialized || disabled || video.seeking || video.paused) return;
    const end = Math.min(clip.end ?? video.duration, video.duration);
    if (video.currentTime < clip.start) video.currentTime = clip.start;
    if (video.currentTime < end) return;
    if (video.loop) {
      video.currentTime = clip.start;
      return;
    }
    if (finished) return;
    finished = true;
    cancel();
    video.pause();
    // Seek within the selected range, preserving its last displayed frame.
    video.currentTime = Math.max(clip.start, end - 0.001);
    video.dispatchEvent(new view.Event("ended"));
  };
  const tick = () => {
    frame = undefined;
    check();
    if (!finished) schedule();
  };
  const play = () => {
    initialize();
    if (disabled) return;
    const end = Math.min(clip.end ?? video.duration, video.duration);
    if (finished || video.currentTime < clip.start || video.currentTime >= end)
      video.currentTime = clip.start;
    finished = false;
    schedule();
  };
  // A natural ended at the file boundary still belongs to the Scene. Never
  // synthesize a second one, even if timeupdate follows it.
  const ended = () => {
    finished = true;
    cancel();
  };
  const metadata = () => {
    initialize();
    schedule();
  };
  const pause = () => cancel();
  const listeners: [string, () => void][] = [
    ["loadedmetadata", metadata],
    ["durationchange", metadata],
    ["play", play],
    ["playing", play],
    ["timeupdate", check],
    ["pause", pause],
    ["ended", ended],
  ];
  for (const [type, listener] of listeners)
    video.addEventListener(type, listener);
  initialize();
  if (!video.paused) play();
  return () => {
    stopped = true;
    cancel();
    for (const [type, listener] of listeners)
      video.removeEventListener(type, listener);
  };
}
