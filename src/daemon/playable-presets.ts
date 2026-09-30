import type { PlayableSignal } from "../shared/playable-nodes.js";

/**
 * Presets are starting points, not Node types: the chosen name is never
 * stored, and a Node created from one can become anything. Each Preset brings
 * starter source that already uses the Project Style, its starter Signals, a
 * one-line summary for the author, and a brief that tells the Agent what the
 * author usually wants next.
 */
export const PLAYABLE_PRESET_IDS = [
  "blank",
  "main-menu",
  "scene",
  "choice",
  "qte",
  "hotspot",
  "ending",
] as const;

export type PlayablePresetId = (typeof PLAYABLE_PRESET_IDS)[number];

export interface PlayablePreset {
  id: PlayablePresetId;
  label: string;
  /** One line for the author, shown in Add a Scene. */
  summary: string;
  /** What the Agent should do next with a Node made from this Preset. */
  brief: string;
  signals: PlayableSignal[];
  /** Source for `nodes/<id>/`, keyed by file name. */
  source: (title: string) => { html: string; css: string; javascript: string };
}

export function playablePreset(id: string): PlayablePreset | undefined {
  return PLAYABLE_PRESETS.find((preset) => preset.id === id);
}

const STYLE_IMPORT = '@import "../../shared/style/components.css";\n';

function signal(id: string, label: string): PlayableSignal {
  return { id, label };
}

export const PLAYABLE_PRESETS: PlayablePreset[] = [
  {
    id: "blank",
    label: "Blank",
    summary: "Start from an empty screen",
    brief:
      "An empty full-screen stage using the Project Style. Describe the screen you want and build it here; add Signals for each outcome the player can reach.",
    signals: [],
    source: (title) => ({
      html: `<main class="stage">\n  <h1 class="title">${escapeHtml(title)}</h1>\n  <p class="body">Describe this screen in chat to build it.</p>\n</main>\n`,
      css: STYLE_IMPORT,
      javascript: "export function mount() {}\n",
    }),
  },
  {
    id: "main-menu",
    label: "Main menu",
    summary: "A title and a list of choices",
    brief:
      "Title, subtitle, and entry list over the background, which the author sets from the editor. Rename the `start` Signal and add one Signal per entry.",
    signals: [signal("start", "Start")],
    source: (title) => ({
      html: [
        '<main class="stage is-cover has-backdrop">',
        '  <div class="backdrop" data-media="backdrop"></div>',
        '  <p class="eyebrow">A new case</p>',
        `  <h1 class="title">${escapeHtml(title)}</h1>`,
        '  <ul class="menu">',
        '    <li><button type="button" class="action" data-signal="start">Start</button></li>',
        '    <li><button type="button" class="action is-quiet" data-continue>Continue</button></li>',
        "  </ul>",
        "</main>",
        "",
      ].join("\n"),
      css: STYLE_IMPORT,
      javascript: [
        'import { showBackdrop } from "../../shared/style/components.js";',
        "",
        "export function mount(context) {",
        "  const backdrop = showBackdrop(context);",
        '  const start = context.root.querySelector(\'[data-signal="start"]\');',
        '  const resume = context.root.querySelector("[data-continue]");',
        "  const begin = () => context.navigation.emit(\"start\");",
        "  const restore = () => context.session.continue();",
        "  // Continue is only offered when a save exists.",
        '  if (!context.session.hasSave()) resume.setAttribute("aria-disabled", "true");',
        '  else resume.addEventListener("click", restore);',
        '  start.addEventListener("click", begin);',
        "  return () => {",
        "    backdrop.cleanup();",
        '    start.removeEventListener("click", begin);',
        '    resume.removeEventListener("click", restore);',
        "  };",
        "}",
        "",
      ].join("\n"),
    }),
  },
  {
    id: "scene",
    label: "Scene",
    summary: "A full-screen video or image",
    brief:
      "A full-screen background video or image that emits `next` when the video ends, is skipped, or the player continues past an image. The author sets the background from the editor. For a different ending behaviour, replace the playScene call with your own code.",
    signals: [signal("next", "Next")],
    source: () => ({
      html: '<main class="scene has-backdrop">\n  <div class="backdrop" data-media="backdrop"></div>\n</main>\n',
      css: STYLE_IMPORT,
      javascript: [
        'import { playScene } from "../../shared/style/components.js";',
        "",
        "export function mount(context) {",
        '  return playScene(context, { signal: "next" });',
        "}",
        "",
      ].join("\n"),
    }),
  },
  {
    id: "choice",
    label: "Choice",
    summary: "Answers that lead different ways",
    brief:
      "A line and options that may read State, over the background. Rewrite the options for this beat, rename the Signals to the outcomes they describe, and gate an option on State when the story needs it. Add a time limit only when asked.",
    signals: [signal("option-a", "Option A"), signal("option-b", "Option B")],
    source: (title) => ({
      html: [
        '<main class="stage is-cover has-backdrop">',
        '  <div class="backdrop" data-media="backdrop"></div>',
        '  <section class="panel">',
        `    <p class="eyebrow">${escapeHtml(title)}</p>`,
        '    <p class="body" data-line>"You came alone. That was brave."</p>',
        '    <div class="actions">',
        '      <button type="button" class="action" data-signal="option-a">I had no choice.</button>',
        '      <button type="button" class="action is-quiet" data-signal="option-b">Who else would come?</button>',
        "    </div>",
        "  </section>",
        "</main>",
        "",
      ].join("\n"),
      css: STYLE_IMPORT,
      javascript: [
        'import { showBackdrop } from "../../shared/style/components.js";',
        "",
        "export function mount(context) {",
        "  const backdrop = showBackdrop(context);",
        '  const options = [...context.root.querySelectorAll("[data-signal]")];',
        "  const choose = (event) => {",
        '    const chosen = event.currentTarget.dataset.signal;',
        "    return context.navigation.emit(chosen);",
        "  };",
        '  for (const option of options) option.addEventListener("click", choose);',
        "  return () => {",
        "    backdrop.cleanup();",
        '    for (const option of options) option.removeEventListener("click", choose);',
        "  };",
        "}",
        "",
      ].join("\n"),
    }),
  },
  {
    id: "qte",
    label: "QTE",
    summary: "Press in time, or miss",
    brief:
      "A timed prompt: pressing the key or the button in time emits `success`, running out of time emits `fail`. Set the key, the time limit, and the prompt for this moment, and rename the Signals to what happens.",
    signals: [signal("success", "Made it"), signal("fail", "Missed")],
    source: (title) => ({
      html: [
        '<main class="stage is-cover has-backdrop">',
        '  <div class="backdrop" data-media="backdrop"></div>',
        `  <p class="eyebrow">${escapeHtml(title)}</p>`,
        '  <h1 class="title">Jump!</h1>',
        '  <button type="button" class="action" data-press>Press Space</button>',
        '  <div class="qte-time" aria-hidden="true"><span data-time></span></div>',
        "</main>",
        "",
      ].join("\n"),
      css: [
        STYLE_IMPORT,
        ".qte-time {",
        "  width: 320px;",
        "  height: 6px;",
        "  overflow: hidden;",
        "  border-radius: 3px;",
        "  background: var(--color-line);",
        "}",
        "",
        ".qte-time span {",
        "  display: block;",
        "  height: 100%;",
        "  background: var(--color-accent);",
        "  transform-origin: left;",
        "}",
        "",
      ].join("\n"),
      javascript: [
        'import { showBackdrop } from "../../shared/style/components.js";',
        "",
        '/** The key to press and how long the player has, in milliseconds. */',
        'const KEY = " ";',
        "const TIME_LIMIT = 3000;",
        "",
        "export function mount(context) {",
        "  const backdrop = showBackdrop(context);",
        '  const press = context.root.querySelector("[data-press]");',
        '  const time = context.root.querySelector("[data-time]");',
        "  let done = false;",
        "  const finish = (signal) => {",
        "    if (done) return;",
        "    done = true;",
        "    void context.navigation.emit(signal);",
        "  };",
        '  const hit = () => finish("success");',
        "  const onKey = (event) => {",
        "    if (event.key !== KEY) return;",
        "    event.preventDefault();",
        "    hit();",
        "  };",
        "  // The bar empties over the time limit.",
        "  const bar = time.animate([{ transform: \"scaleX(1)\" }, { transform: \"scaleX(0)\" }], { duration: TIME_LIMIT, fill: \"forwards\" });",
        '  const timer = setTimeout(() => finish("fail"), TIME_LIMIT);',
        '  press.addEventListener("click", hit);',
        '  window.addEventListener("keydown", onKey);',
        "  return () => {",
        "    backdrop.cleanup();",
        "    clearTimeout(timer);",
        "    bar.cancel();",
        '    press.removeEventListener("click", hit);',
        '    window.removeEventListener("keydown", onKey);',
        "  };",
        "}",
        "",
      ].join("\n"),
    }),
  },
  {
    id: "hotspot",
    label: "Hotspot",
    summary: "Spots on a picture to click",
    brief:
      "Clickable spots over the background picture, each emitting its own Signal. Place one spot per thing the player can click, and name each Signal after it. To require several finds before moving on, record them in a declared State key.",
    signals: [signal("door", "Door"), signal("window", "Window")],
    source: (title) => ({
      html: [
        '<main class="stage is-cover has-backdrop">',
        '  <div class="backdrop" data-media="backdrop"></div>',
        `  <p class="eyebrow">${escapeHtml(title)}</p>`,
        '  <p class="body">Look around.</p>',
        '  <button type="button" class="action is-quiet hotspot" data-signal="door" style="left: 24%; top: 38%;">Door</button>',
        '  <button type="button" class="action is-quiet hotspot" data-signal="window" style="left: 64%; top: 30%;">Window</button>',
        "</main>",
        "",
      ].join("\n"),
      css: [
        STYLE_IMPORT,
        "/* Place each spot over the thing it stands for in the picture. */",
        ".hotspot {",
        "  position: absolute;",
        "}",
        "",
      ].join("\n"),
      javascript: [
        'import { showBackdrop } from "../../shared/style/components.js";',
        "",
        "export function mount(context) {",
        "  const backdrop = showBackdrop(context);",
        '  const spots = [...context.root.querySelectorAll("[data-signal]")];',
        "  const open = (event) => context.navigation.emit(event.currentTarget.dataset.signal);",
        '  for (const spot of spots) spot.addEventListener("click", open);',
        "  return () => {",
        "    backdrop.cleanup();",
        '    for (const spot of spots) spot.removeEventListener("click", open);',
        "  };",
        "}",
        "",
      ].join("\n"),
    }),
  },
  {
    id: "ending",
    label: "Ending",
    summary: "The end, with Play again",
    brief:
      "Ending title and text with restart and return-to-menu actions. Endings need no Signals because they use session controls; add one if this ending continues into an epilogue.",
    signals: [],
    source: (title) => ({
      html: [
        '<main class="stage">',
        '  <p class="eyebrow">Ending</p>',
        `  <h1 class="title">${escapeHtml(title)}</h1>`,
        '  <p class="body">Write the closing lines of this ending here.</p>',
        '  <div class="actions">',
        '    <button type="button" class="action" data-restart>Play again</button>',
        "  </div>",
        "</main>",
        "",
      ].join("\n"),
      css: STYLE_IMPORT,
      javascript: [
        "export function mount(context) {",
        '  const again = context.root.querySelector("[data-restart]");',
        "  const restart = () => context.session.restart();",
        '  again.addEventListener("click", restart);',
        '  return () => again.removeEventListener("click", restart);',
        "}",
        "",
      ].join("\n"),
    }),
  },
];

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}
