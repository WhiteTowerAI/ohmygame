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

.cinematic {
  display: grid;
  width: 100%;
  height: 100%;
  background: #000;
}

.cinematic video {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.cinematic .skip {
  position: absolute;
  right: var(--space-3);
  bottom: var(--space-3);
}
`,
  "shared/style/components.js": `/**
 * Plays a declared video Asset full screen, offers skip, and emits a Signal
 * when the video ends or is skipped. Cinematic transitions are Node content,
 * not a Runtime feature, so change or replace this function freely.
 *
 * @param {object} context the Node context passed to mount
 * @param {object} options
 * @param {string} options.assetId a video Asset declared by this Node
 * @param {string} options.signal the Signal to emit when playback finishes
 * @param {string} [options.skipLabel]
 * @returns {() => void} cleanup
 */
export function playCinematic(context, { assetId, signal, skipLabel = "Skip" }) {
  const figure = document.createElement("figure");
  figure.className = "cinematic";
  figure.style.margin = "0";
  figure.style.position = "relative";
  const video = document.createElement("video");
  video.src = context.assets.url(assetId);
  video.autoplay = true;
  video.playsInline = true;
  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "action is-quiet skip";
  skip.textContent = skipLabel;
  figure.append(video, skip);
  context.root.append(figure);

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    void context.navigation.emit(signal);
  };
  video.addEventListener("ended", finish);
  skip.addEventListener("click", finish);
  // A blocked autoplay should not trap the player on a still frame.
  video.play?.().catch(() => skip.focus());

  return () => {
    video.removeEventListener("ended", finish);
    skip.removeEventListener("click", finish);
    video.pause();
    figure.remove();
  };
}
`,
};
