/**
 * Shows the Node's background: the one `.backdrop` element, whose
 * `data-asset` and `data-type` ("image" or "video") name a declared
 * Asset. A video plays once with sound and stops on its last frame. The
 * editor sets the two attributes itself, so change the background there
 * rather than adding media elements. Call it from mount().
 *
 * @param {object} context the Node context passed to mount
 * @returns {{ video?: HTMLVideoElement, shown: boolean, cleanup: () => void }}
 */
export function showBackdrop(context) {
  const backdrop = context.root.querySelector('[data-media="backdrop"]');
  const assetId = backdrop?.getAttribute("data-asset");
  if (!backdrop || !assetId) return { shown: false, cleanup: () => {} };
  const url = context.assets.url(assetId);
  if (backdrop.getAttribute("data-type") !== "video") {
    const image = document.createElement("img");
    image.src = url;
    image.alt = "";
    backdrop.append(image);
    return { shown: true, cleanup: () => image.remove() };
  }
  const video = document.createElement("video");
  video.src = url;
  video.playsInline = true;
  backdrop.append(video);
  // Where sound may not start on its own, play muted rather than stay black.
  const started = Promise.resolve(video.play?.()).catch(() => {
    video.muted = true;
    return video.play?.();
  }).then(() => true, () => false);
  return {
    video,
    /** Whether the video started playing, with or without sound. */
    started,
    shown: true,
    cleanup: () => {
      video.pause();
      video.remove();
    },
  };
}

/**
 * Shows the background and emits a Signal when the player moves on. A video
 * plays to its end, as in an interactive film: clicking does not cut it
 * short, and a `[data-skip]` button shows only when the player has seen the
 * Scene before. An image, or no background, waits for a click, and so does a
 * video that cannot play, so the player is never stuck. A `.continue-hint`
 * shows only while a click moves on. This is Node content, not a Runtime
 * feature, so change or replace it freely.
 *
 * @param {object} context the Node context passed to mount
 * @param {object} options
 * @param {string} options.signal the Signal to emit when the player moves on
 * @returns {() => void} cleanup
 */
export function playScene(context, { signal }) {
  const stage = context.root.querySelector('[data-media="backdrop"]')?.parentElement ?? context.root;
  const backdrop = showBackdrop(context);
  const hint = stage.querySelector(".continue-hint");
  const skip = stage.querySelector("[data-skip]");

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    void context.navigation.emit(signal);
  };
  let playing = Boolean(backdrop.video);
  const update = () => {
    if (hint) hint.hidden = playing;
    if (skip) skip.hidden = !(playing && context.story.seenBefore);
  };
  const stopped = () => {
    playing = false;
    update();
  };
  const click = () => {
    if (!playing) finish();
  };
  backdrop.video?.addEventListener("ended", finish);
  backdrop.video?.addEventListener("error", stopped);
  void backdrop.started?.then((started) => {
    if (!started) stopped();
  });
  skip?.addEventListener("click", finish);
  stage.addEventListener("click", click);
  update();

  return () => {
    backdrop.video?.removeEventListener("ended", finish);
    backdrop.video?.removeEventListener("error", stopped);
    skip?.removeEventListener("click", finish);
    stage.removeEventListener("click", click);
    backdrop.cleanup();
  };
}
