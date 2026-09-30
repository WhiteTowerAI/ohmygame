/**
 * The default Project Style: shared theme tokens and components that every
 * Node imports, so screens stay recognizably part of one game. It is ordinary
 * project source, copied into new projects and edited freely afterwards.
 */
export const PLAYABLE_PROJECT_STYLE_FILES: Record<string, string> = {
  "shared/style/theme.css": `/* Project Style tokens. Every Node imports this file, so changing a value
   here restyles the whole game. */
:host {
  --color-ink: #f7f3e8;
  --color-muted: #c0c3c7;
  --color-page: #171a1f;
  --color-panel: #1f242b;
  --color-accent: #d9b36c;
  --color-line: #ffffff26;
  --font-body: system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-display: var(--font-body);
  --text-eyebrow: 13px;
  --text-body: 18px;
  --text-title: 48px;
  --space-1: 8px;
  --space-2: 16px;
  --space-3: 24px;
  --space-4: 40px;
  --edge: 8%;
  --radius: 4px;

  display: block;
  width: 100%;
  height: 100%;
  color: var(--color-ink);
  font-family: var(--font-body);
}
`,
  "shared/style/components.css": `/* Shared components. Import this file from a Node's style.css and use the
   class names in its HTML. */
@import "./theme.css";

.stage {
  box-sizing: border-box;
  display: grid;
  width: 100%;
  height: 100%;
  padding: var(--edge);
  gap: var(--space-2);
  place-content: center;
  justify-items: start;
  background: var(--color-page);
}

.stage.is-cover {
  place-content: end start;
  background-position: center;
  background-size: cover;
}

.eyebrow {
  margin: 0;
  color: var(--color-accent);
  font-size: var(--text-eyebrow);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.title {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--text-title);
  font-weight: 600;
  line-height: 1.1;
}

.body {
  margin: 0;
  max-width: 60ch;
  color: var(--color-muted);
  font-size: var(--text-body);
  line-height: 1.6;
}

.panel {
  box-sizing: border-box;
  border: 1px solid var(--color-line);
  border-radius: var(--radius);
  padding: var(--space-3);
  background: color-mix(in srgb, var(--color-panel) 88%, transparent);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.action {
  border: 1px solid var(--color-accent);
  border-radius: var(--radius);
  padding: 12px 18px;
  color: var(--color-page);
  background: var(--color-accent);
  font: inherit;
  cursor: pointer;
}

.action.is-quiet {
  color: var(--color-ink);
  background: transparent;
}

.action[aria-disabled="true"] {
  opacity: 0.45;
  cursor: default;
}

.menu {
  display: grid;
  margin: 0;
  padding: 0;
  gap: var(--space-1);
  list-style: none;
}

/* A Node's background: the one \`.backdrop\` element, full screen behind the
   stage's content. Its data-asset and data-type name a declared Asset, which
   showBackdrop() in components.js shows; until then it is a plain gradient. */
.has-backdrop {
  position: relative;
  isolation: isolate;
}

.backdrop {
  position: absolute;
  inset: 0;
  z-index: -1;
  overflow: hidden;
  background: radial-gradient(circle at 70% 30%, var(--color-panel), var(--color-page) 70%);
}

.backdrop > video,
.backdrop > img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* A Scene: only its background, with Skip or Continue. */
.scene {
  display: grid;
  width: 100%;
  height: 100%;
  place-items: center;
}

.scene .skip {
  position: absolute;
  right: var(--space-3);
  bottom: var(--space-3);
}

.scene .scene-empty {
  box-sizing: border-box;
  display: grid;
  width: 64%;
  height: 56%;
  margin: 0;
  place-items: center;
  border: 1px dashed var(--color-line);
  border-radius: var(--radius);
  color: var(--color-muted);
  font-size: var(--text-body);
}
`,
  "shared/style/components.js": `/**
 * Shows the Node's background: the one \`.backdrop\` element, whose
 * \`data-asset\` and \`data-type\` ("image" or "video") name a declared
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
  video.play?.().catch(() => {
    video.muted = true;
    return video.play?.();
  }).catch(() => {});
  return {
    video,
    shown: true,
    cleanup: () => {
      video.pause();
      video.remove();
    },
  };
}

/**
 * A Scene: shows the background and emits a Signal when its video ends, or
 * when the player skips or continues. Without a background it shows a
 * placeholder the player can continue past. Scene transitions are Node
 * content, not a Runtime feature, so change or replace this function freely.
 *
 * @param {object} context the Node context passed to mount
 * @param {object} options
 * @param {string} options.signal the Signal to emit when the Scene finishes
 * @param {string} [options.skipLabel]
 * @returns {() => void} cleanup
 */
export function playScene(context, { signal, skipLabel }) {
  const stage = context.root.querySelector('[data-media="backdrop"]')?.parentElement ?? context.root;
  const backdrop = showBackdrop(context);
  const added = [];
  if (!backdrop.shown) {
    const empty = document.createElement("p");
    empty.className = "scene-empty";
    empty.textContent = "Add a video or an image";
    added.push(empty);
  }
  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "action is-quiet skip";
  skip.textContent = skipLabel ?? (backdrop.video ? "Skip" : "Continue");
  added.push(skip);
  stage.append(...added);

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    void context.navigation.emit(signal);
  };
  backdrop.video?.addEventListener("ended", finish);
  skip.addEventListener("click", finish);

  return () => {
    backdrop.video?.removeEventListener("ended", finish);
    skip.removeEventListener("click", finish);
    backdrop.cleanup();
    for (const element of added) element.remove();
  };
}
`,
};
