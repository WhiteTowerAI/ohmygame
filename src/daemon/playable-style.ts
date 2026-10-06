/**
 * The default Project Style: shared theme tokens and components that every
 * Node imports, so screens stay recognizably part of one game. It is ordinary
 * project source, copied into new projects and edited freely afterwards.
 */
export const PLAYABLE_PROJECT_STYLE_FILES: Record<string, string> = {
  "shared/style/theme.css": `/* Project Style tokens. Every Node imports this file, so changing a value
   here restyles the whole game. Sizes are in cqw (hundredths of the screen
   width), so a screen looks the same at any size. */
:host {
  container-type: size;
  --color-ink: #efe9dc;
  --color-muted: #b3ada3;
  --color-page: #0b0b0d;
  --color-panel: #17171a;
  --color-accent: #b8322a;
  --color-accent-ink: #e0483b;
  --color-shade: rgb(8 8 10 / 0.72);
  --color-line: #ffffff2e;
  --font-body: "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif;
  --font-display: "Iowan Old Style", "Palatino Linotype", Palatino, "Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --text-eyebrow: 1.05cqw;
  --text-body: 1.6cqw;
  --text-line: 2cqw;
  --text-action: 1.7cqw;
  --text-title: 4.5cqw;
  --text-display: 9cqw;
  --space-1: 0.6cqw;
  --space-2: 1.2cqw;
  --space-3: 2cqw;
  --space-4: 3.2cqw;
  --edge: 8cqw;
  /* Black bars above and below the picture; 0 turns them off. */
  --letterbox: 4.2cqw;
  --radius: 0.3cqw;

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

/* A screen. Content is centred; .is-left lines it up on the left. */
.stage {
  box-sizing: border-box;
  display: grid;
  width: 100%;
  height: 100%;
  padding: var(--edge);
  gap: var(--space-2);
  place-content: center;
  justify-items: center;
  text-align: center;
  background: var(--color-page);
}

.stage.is-left {
  place-content: center start;
  justify-items: start;
  text-align: start;
}

.eyebrow {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  color: var(--color-muted);
  font-size: var(--text-eyebrow);
  letter-spacing: 0.4em;
  text-transform: uppercase;
}

.eyebrow::before {
  content: "";
  width: 3cqw;
  height: 1px;
  background: var(--color-accent);
}

.title {
  margin: 0;
  max-width: 64cqw;
  font-family: var(--font-display);
  font-size: var(--text-title);
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: 0.06em;
  text-wrap: balance;
  text-shadow: 0 0.3cqw 1.6cqw rgb(0 0 0 / 0.7);
}

.title.is-display {
  font-size: var(--text-display);
  font-weight: 900;
  line-height: 1;
  letter-spacing: 0.12em;
}

.tagline {
  margin: 0 0 var(--space-4);
  color: var(--color-muted);
  font-family: var(--font-display);
  font-size: 1.4cqw;
  letter-spacing: 0.2em;
}

.body {
  margin: 0;
  max-width: 46cqw;
  color: var(--color-muted);
  font-family: var(--font-display);
  font-size: var(--text-body);
  line-height: 1.8;
}

.panel {
  box-sizing: border-box;
  padding: var(--space-3) var(--space-4);
  background: var(--color-shade);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
}

/* A text button with an underline. */
.action {
  border: 0;
  border-bottom: 1px solid var(--color-line);
  padding: 0.3cqw 0 0.3cqw 0.3em;
  color: var(--color-ink);
  background: none;
  font: inherit;
  font-size: 1.3cqw;
  letter-spacing: 0.3em;
  cursor: pointer;
  transition: border-color 0.2s, color 0.2s;
}

.action:hover,
.action:focus-visible {
  border-color: var(--color-accent-ink);
  outline: none;
}

.action.is-quiet {
  color: var(--color-muted);
}

.action[aria-disabled="true"] {
  opacity: 0.35;
  cursor: default;
}

/* A menu: large text entries; the one in focus gets a short red line. */
.menu {
  display: grid;
  margin: 0;
  padding: 0;
  gap: 0.2cqw;
  justify-items: start;
  list-style: none;
}

.menu .action {
  position: relative;
  border: 0;
  padding: 0.5cqw 0 0.5cqw 2.4cqw;
  font-family: var(--font-display);
  font-size: 1.9cqw;
  letter-spacing: 0.2em;
  transition: padding 0.25s, color 0.2s;
}

.menu .action::before {
  content: "";
  position: absolute;
  left: 0;
  top: 50%;
  width: 0;
  height: 0.18cqw;
  background: var(--color-accent);
  transition: width 0.25s;
}

.menu .action:not([aria-disabled="true"]):is(:hover, :focus-visible) {
  padding-left: 3cqw;
}

.menu .action:not([aria-disabled="true"]):is(:hover, :focus-visible)::before {
  width: 1.8cqw;
}

.menu .action small {
  margin-left: var(--space-2);
  font-family: var(--font-body);
  font-size: 0.95cqw;
  letter-spacing: 0.1em;
}

/* A line of dialogue at the bottom of the screen, like a film subtitle. */
.subtitle {
  position: absolute;
  left: 10cqw;
  right: 10cqw;
  bottom: calc(var(--letterbox) + 3.2cqw);
  display: grid;
  gap: 0.5cqw;
  justify-items: center;
  text-align: center;
  text-shadow: 0 0.15cqw 0.6cqw rgb(0 0 0 / 0.9);
}

.speaker {
  margin: 0;
  padding-left: 0.4em;
  color: var(--color-accent-ink);
  font-size: var(--text-eyebrow);
  font-weight: 700;
  letter-spacing: 0.4em;
}

.line {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--text-line);
  letter-spacing: 0.06em;
}

/* A corner label above the picture, such as the Scene's chapter. */
.hud {
  position: absolute;
  left: 5cqw;
  top: calc(var(--letterbox) + 2.2cqw);
}

/* Answers as dark bars across the middle of the screen. */
.choices {
  position: absolute;
  left: 50%;
  top: 27%;
  display: grid;
  width: 48cqw;
  gap: 0.9cqw;
  transform: translateX(-50%);
}

.option {
  position: relative;
  border: 0;
  padding: 1.1cqw 4cqw;
  color: var(--color-ink);
  background: linear-gradient(90deg, transparent, var(--color-shade) 18%, var(--color-shade) 82%, transparent);
  font: inherit;
  font-size: var(--text-action);
  letter-spacing: 0.08em;
  cursor: pointer;
  transition: background 0.2s, opacity 0.3s;
}

.option:hover,
.option:focus-visible,
.option.is-picked {
  outline: none;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--color-accent) 80%, transparent) 18%, color-mix(in srgb, var(--color-accent) 80%, transparent) 82%, transparent);
}

.choices.is-made .option:not(.is-picked) {
  opacity: 0.2;
}

/* A key the player can press, as a small outlined label. */
kbd,
.key {
  border: 1px solid currentColor;
  border-radius: var(--radius);
  font-family: var(--font-mono);
  letter-spacing: 0.1em;
}

.option kbd {
  position: absolute;
  left: 9cqw;
  top: 50%;
  padding: 0 0.5cqw;
  color: var(--color-muted);
  font-size: 0.95cqw;
  transform: translateY(-50%);
}

/* A thin line that empties toward the middle; animate its span's scaleX. */
.timer {
  height: 0.16cqw;
  margin-bottom: 0.6cqw;
  background: var(--color-line);
}

.timer > span {
  display: block;
  height: 100%;
  background: var(--color-ink);
}

/* A ring that runs out around a key to press. */
.qte {
  position: relative;
  display: grid;
  width: 15cqw;
  aspect-ratio: 1;
  place-items: center;
}

.qte-ring {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  transform: rotate(-90deg);
}

.qte-ring circle {
  fill: none;
  stroke-width: 1.6;
}

.qte-ring .qte-track {
  stroke: var(--color-line);
}

.qte-ring .qte-time {
  stroke: var(--color-ink);
  stroke-dasharray: 276.5;
  transition: stroke 0.3s;
}

.qte.is-late .qte-time,
.qte.is-missed .qte-time {
  stroke: var(--color-accent-ink);
}

.key {
  position: relative;
  padding: 0.7cqw 1.4cqw;
  color: var(--color-ink);
  background: rgb(0 0 0 / 0.45);
  font-size: 1.5cqw;
  cursor: pointer;
}

.qte.is-hit::after {
  content: "";
  position: absolute;
  inset: -10%;
  border: 0.25cqw solid var(--color-ink);
  border-radius: 50%;
  animation: qte-burst 0.6s ease-out forwards;
}

@keyframes qte-burst {
  from { opacity: 1; transform: scale(0.85); }
  to { opacity: 0; transform: scale(1.5); }
}

/* A pulsing dot over something in the picture; its name shows on hover. */
.hotspot {
  position: absolute;
  width: 2.2cqw;
  height: 2.2cqw;
  padding: 0;
  border: 0.14cqw solid var(--color-ink);
  border-radius: 50%;
  background: rgb(255 255 255 / 0.14);
  font: inherit;
  color: var(--color-ink);
  transform: translate(-50%, -50%);
  cursor: pointer;
}

.hotspot::after {
  content: "";
  position: absolute;
  inset: -0.14cqw;
  border: 0.14cqw solid var(--color-ink);
  border-radius: 50%;
  animation: hotspot-pulse 2s ease-out infinite;
}

.hotspot > span {
  position: absolute;
  left: 150%;
  top: 50%;
  padding: 0.3cqw 0.9cqw;
  background: var(--color-shade);
  font-size: 1.15cqw;
  letter-spacing: 0.2em;
  white-space: nowrap;
  opacity: 0;
  transform: translateY(-50%);
  transition: opacity 0.2s;
  pointer-events: none;
}

.hotspot:is(:hover, :focus-visible, .is-found) > span {
  opacity: 1;
}

.hotspot:focus-visible {
  outline: none;
}

.hotspot.is-found {
  border-color: var(--color-accent);
  background: var(--color-accent);
}

.hotspot.is-found::after {
  animation: none;
  opacity: 0;
}

@keyframes hotspot-pulse {
  from { opacity: 0.8; transform: scale(1); }
  to { opacity: 0; transform: scale(2.4); }
}

/* A title with a red stamp at its corner. */
.sealed {
  position: relative;
}

.seal {
  position: absolute;
  right: -4.4cqw;
  top: 0.6cqw;
  display: grid;
  width: 3.8cqw;
  height: 3.8cqw;
  place-items: center;
  border: 0.2cqw solid var(--color-accent);
  border-radius: var(--radius);
  color: var(--color-accent-ink);
  font-family: var(--font-display);
  font-size: 1.5cqw;
  font-weight: 900;
  animation: seal-stamp 0.5s 1.3s cubic-bezier(0.3, 1.6, 0.5, 1) both;
  transform: rotate(-9deg);
}

@keyframes seal-stamp {
  from { opacity: 0; transform: rotate(-9deg) scale(2.2); }
  to { opacity: 1; transform: rotate(-9deg) scale(1); }
}

/* "Click to continue", fading in and out at the bottom right. */
.continue-hint {
  position: absolute;
  right: 5cqw;
  bottom: calc(var(--letterbox) + 1.8cqw);
  margin: 0;
  color: var(--color-muted);
  font-size: var(--text-eyebrow);
  letter-spacing: 0.3em;
  animation: hint-blink 2.4s 1.5s ease-in-out infinite both;
}

@keyframes hint-blink {
  0%, 100% { opacity: 0.25; }
  50% { opacity: 0.9; }
}

/* Entrance: content rises into place. Stagger with style="--delay: 0.2s".
   The rise adds to the element's own translate, so a moved element rises
   into the place it was moved to. */
.rise {
  animation:
    rise 0.8s var(--delay, 0s) cubic-bezier(0.2, 0.7, 0.2, 1) both,
    rise-up 0.8s var(--delay, 0s) cubic-bezier(0.2, 0.7, 0.2, 1) both;
  animation-composition: replace, add;
}

/* A title whose letters draw together as it appears. */
.spread {
  animation: spread 1.6s cubic-bezier(0.2, 0.7, 0.2, 1) both;
}

@keyframes rise {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes rise-up {
  from { translate: 0 1.2cqw; }
  to { translate: 0 0; }
}

@keyframes spread {
  from { opacity: 0; letter-spacing: 0.6em; }
}

/* A Node's background: the one \`.backdrop\` element, full screen behind the
   stage's content. Its data-asset and data-type name a declared Asset, which
   showBackdrop() in components.js shows. Until one is set it shows a
   placeholder picture picked by a class: is-night, is-warm, is-lamp,
   is-alarm, is-room, or is-dusk. Black bars, a vignette, and film grain sit
   over every background. */
.has-backdrop {
  position: relative;
  overflow: hidden;
  isolation: isolate;
}

.has-backdrop::before,
.has-backdrop::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  z-index: 2;
  height: var(--letterbox);
  background: #000;
  pointer-events: none;
}

.has-backdrop::before {
  top: 0;
}

.has-backdrop::after {
  bottom: 0;
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

.backdrop::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(ellipse at center, transparent 45%, rgb(0 0 0 / 0.75) 100%),
    url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.35'/></svg>");
}

/* Placeholder figure in a hat, drawn until a background is set. */
.backdrop:not([data-asset]):is(.is-night, .is-warm, .is-lamp)::before {
  content: "";
  position: absolute;
  left: var(--figure-x);
  bottom: calc(var(--letterbox) - 2cqw);
  width: var(--figure-width);
  aspect-ratio: 1;
  background: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><g fill='%23050506'><path d='M34 24C35 12 40 7 50 7S65 12 66 24Z'/><ellipse cx='50' cy='24' rx='30' ry='3'/><ellipse cx='50' cy='37' rx='14' ry='16'/><rect x='43' y='48' width='14' height='16'/><path d='M0 100L4 78C8 70 24 66 40 62H60C76 66 92 70 96 78L100 100Z'/></g></svg>") center / contain no-repeat;
}

.backdrop.is-night {
  --figure-x: 20%;
  --figure-width: 15cqw;
  background:
    linear-gradient(#050506, #050506) 70% 43% / 0.4cqw 40% no-repeat,
    repeating-linear-gradient(104deg, transparent 0 1.2cqw, rgb(200 210 230 / 0.05) 1.2cqw 1.32cqw),
    radial-gradient(ellipse 22cqw 26cqw at 70% 26%, rgb(255 186 105 / 0.42), transparent 70%),
    radial-gradient(ellipse 30cqw 6cqw at 70% 86%, rgb(255 186 105 / 0.14), transparent 70%),
    linear-gradient(180deg, #111318, #1a1c21 64%, #0b0c0e 64.3%, #08090a);
}

.backdrop.is-warm {
  --figure-x: 60%;
  --figure-width: 26cqw;
  background:
    radial-gradient(ellipse 32cqw 40cqw at 72% 48%, rgb(214 148 78 / 0.5), transparent 70%),
    linear-gradient(90deg, #0a0a0c 0%, #131216 50%, #1d1813 100%);
}

.backdrop.is-lamp {
  --figure-x: 64%;
  --figure-width: 22cqw;
  background:
    linear-gradient(#000, #000) 30% 0 / 0.15cqw 14% no-repeat,
    radial-gradient(ellipse 3.6cqw 1.4cqw at 30% 15%, #0b0c0d 97%, transparent 100%),
    radial-gradient(ellipse 28cqw 26cqw at 30% 22%, rgb(168 196 176 / 0.3), transparent 70%),
    linear-gradient(180deg, #0f1113, #171a1c 72%, #0a0b0c);
}

.backdrop.is-alarm {
  background:
    repeating-linear-gradient(90deg, #050404 0 0.5cqw, transparent 0.5cqw 7cqw) 0 100% / 100% 26% no-repeat,
    linear-gradient(#050404, #050404) 0 74% / 100% 0.7cqw no-repeat,
    radial-gradient(ellipse 50cqw 28cqw at 50% 0%, rgb(200 40 30 / 0.5), transparent 70%),
    repeating-linear-gradient(115deg, transparent 0 3cqw, rgb(255 255 255 / 0.03) 3cqw 3.25cqw),
    linear-gradient(#1b0d0d, #0b0707);
}

/* A room with a door on the left and a moonlit window on the right. */
.backdrop.is-room {
  background:
    radial-gradient(circle 0.4cqw at 30.5% 51%, #6d6248 97%, transparent 100%),
    linear-gradient(#0a0e11, #0a0e11) 22.4% 49.2% / 13% 41% no-repeat,
    linear-gradient(#1d262d, #1d262d) 22.1% 48.3% / 14% 42% no-repeat,
    radial-gradient(ellipse 16cqw 10cqw at 70% 80%, rgb(150 180 215 / 0.08), transparent 70%),
    linear-gradient(180deg, #0e1317, #141b20 70%, #0b0f12 70.3%, #080b0d);
}

.backdrop.is-room:not([data-asset])::before {
  content: "";
  position: absolute;
  left: 58%;
  top: 18%;
  width: 18%;
  height: 30%;
  box-sizing: border-box;
  border: 0.45cqw solid #090c0e;
  background:
    linear-gradient(90deg, transparent 48.5%, #090c0e 48.5% 51.5%, transparent 51.5%),
    linear-gradient(180deg, transparent 48%, #090c0e 48% 52%, transparent 52%),
    linear-gradient(160deg, rgb(160 190 220 / 0.45), rgb(60 80 100 / 0.25));
}

.backdrop.is-dusk {
  background:
    linear-gradient(rgb(220 170 120 / 0.18), rgb(220 170 120 / 0.18)) 0 71% / 100% 1px no-repeat,
    radial-gradient(ellipse 70cqw 22cqw at 50% 100%, rgb(170 110 60 / 0.25), transparent 70%),
    linear-gradient(#070708, #0e0d0e);
}

/* A Scene: only its background. */
.scene {
  display: grid;
  width: 100%;
  height: 100%;
  place-items: center;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition: none !important;
  }
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
 * Shows the background and emits a Signal when its video ends or the player
 * clicks anywhere. This is Node content, not a Runtime feature, so change or
 * replace it freely.
 *
 * @param {object} context the Node context passed to mount
 * @param {object} options
 * @param {string} options.signal the Signal to emit when the player moves on
 * @returns {() => void} cleanup
 */
export function playScene(context, { signal }) {
  const stage = context.root.querySelector('[data-media="backdrop"]')?.parentElement ?? context.root;
  const backdrop = showBackdrop(context);

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    void context.navigation.emit(signal);
  };
  backdrop.video?.addEventListener("ended", finish);
  stage.addEventListener("click", finish);

  return () => {
    backdrop.video?.removeEventListener("ended", finish);
    stage.removeEventListener("click", finish);
    backdrop.cleanup();
  };
}
`,
};
