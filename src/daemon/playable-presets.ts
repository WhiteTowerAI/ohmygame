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
    summary: "A video or an image, then next",
    brief:
      "A full-screen background that emits `next` when its video ends or the player clicks. The author sets the background from the editor. Build the screen over the background (a `.subtitle` for a line of dialogue, for example), and rename `next` or add Signals for each outcome the player can reach.",
    signals: [signal("next", "Next")],
    source: blankSource,
  },
  {
    id: "main-menu",
    label: "Main menu",
    summary: "A title and a list of choices",
    brief:
      "Title, tagline, and entry list over the background, which the author sets from the editor. Rename the `start` Signal and add one Signal per entry.",
    signals: [signal("start", "Start")],
    source: (title) => ({
      html: [
        '<main class="stage is-left has-backdrop">',
        '  <div class="backdrop is-warm" data-media="backdrop"></div>',
        '  <p class="eyebrow rise">A new case</p>',
        `  <h1 class="title is-display rise" style="--delay: 0.15s">${escapeHtml(title)}</h1>`,
        '  <p class="tagline rise" style="--delay: 0.3s">Shanghai, 1937</p>',
        '  <ul class="menu">',
        '    <li class="rise" style="--delay: 0.5s"><button type="button" class="action" data-signal="start">Start</button></li>',
        '    <li class="rise" style="--delay: 0.6s"><button type="button" class="action" data-continue>Continue <small>No save yet</small></button></li>',
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
        "  else {",
        '    resume.querySelector("small").remove();',
        '    resume.addEventListener("click", restore);',
        "  }",
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
    id: "choice",
    label: "Choice",
    summary: "Answers that lead different ways",
    brief:
      "A line of dialogue with its speaker and answer bars that may read State, over the background. Rewrite the line and the answers for this beat, rename the Signals to the outcomes they describe, and gate an answer on State when the story needs it. Add a time limit only when asked, with the Project Style's `.timer`.",
    signals: [signal("option-a", "Option A"), signal("option-b", "Option B")],
    source: (title) => ({
      html: [
        '<main class="stage has-backdrop">',
        '  <div class="backdrop is-lamp" data-media="backdrop"></div>',
        `  <p class="eyebrow hud rise">${escapeHtml(title)}</p>`,
        '  <div class="choices">',
        '    <button type="button" class="option rise" style="--delay: 0.6s" data-signal="option-a"><kbd>1</kbd>I had no choice.</button>',
        '    <button type="button" class="option rise" style="--delay: 0.7s" data-signal="option-b"><kbd>2</kbd>Who else would come?</button>',
        "  </div>",
        '  <div class="subtitle rise">',
        '    <p class="speaker">STRANGER</p>',
        '    <p class="line">"You came alone. That was brave."</p>',
        "  </div>",
        "</main>",
        "",
      ].join("\n"),
      css: STYLE_IMPORT,
      javascript: [
        'import { showBackdrop } from "../../shared/style/components.js";',
        "",
        "export function mount(context) {",
        "  const backdrop = showBackdrop(context);",
        '  const choices = context.root.querySelector(".choices");',
        '  const options = [...context.root.querySelectorAll("[data-signal]")];',
        "  const choose = (option) => {",
        '    if (choices.classList.contains("is-made")) return;',
        '    choices.classList.add("is-made");',
        '    option.classList.add("is-picked");',
        "    void context.navigation.emit(option.dataset.signal);",
        "  };",
        "  const onClick = (event) => choose(event.currentTarget);",
        "  // Number keys pick the answer with that number.",
        "  const onKey = (event) => {",
        "    const option = options[Number(event.key) - 1];",
        "    if (option) choose(option);",
        "  };",
        '  for (const option of options) option.addEventListener("click", onClick);',
        '  window.addEventListener("keydown", onKey);',
        "  return () => {",
        "    backdrop.cleanup();",
        '    for (const option of options) option.removeEventListener("click", onClick);',
        '    window.removeEventListener("keydown", onKey);',
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
      "A timed prompt: a ring runs out around the key, pressing the key or clicking it in time emits `success`, and running out of time emits `fail`. Set the key, the time limit, and the prompt for this moment, and rename the Signals to what happens.",
    signals: [signal("success", "Made it"), signal("fail", "Missed")],
    source: (title) => ({
      html: [
        '<main class="stage has-backdrop">',
        '  <div class="backdrop is-alarm" data-media="backdrop"></div>',
        `  <p class="eyebrow hud rise">${escapeHtml(title)}</p>`,
        '  <div class="qte rise" data-qte>',
        '    <svg class="qte-ring" viewBox="0 0 100 100" aria-hidden="true">',
        '      <circle class="qte-track" cx="50" cy="50" r="44" />',
        '      <circle class="qte-time" cx="50" cy="50" r="44" data-time />',
        "    </svg>",
        '    <button type="button" class="key" data-press>Space</button>',
        "  </div>",
        '  <p class="title rise" style="--delay: 0.15s">Jump!</p>',
        "</main>",
        "",
      ].join("\n"),
      css: STYLE_IMPORT,
      javascript: [
        'import { showBackdrop } from "../../shared/style/components.js";',
        "",
        '/** The key to press and how long the player has, in milliseconds. */',
        'const KEY = " ";',
        "const TIME_LIMIT = 3000;",
        "/** How long the hit or miss shows before the story moves on. */",
        "const FEEDBACK = 450;",
        "",
        "export function mount(context) {",
        "  const backdrop = showBackdrop(context);",
        '  const qte = context.root.querySelector("[data-qte]");',
        '  const press = context.root.querySelector("[data-press]");',
        '  const time = context.root.querySelector("[data-time]");',
        "  let done = false;",
        "  let next;",
        "  const finish = (signal, state) => {",
        "    if (done) return;",
        "    done = true;",
        "    ring.pause();",
        "    qte.classList.add(state);",
        "    next = setTimeout(() => void context.navigation.emit(signal), FEEDBACK);",
        "  };",
        '  const hit = () => finish("success", "is-hit");',
        "  const onKey = (event) => {",
        "    if (event.key !== KEY) return;",
        "    event.preventDefault();",
        "    hit();",
        "  };",
        "  // The ring runs out over the time limit and turns red near the end.",
        '  const ring = time.animate([{ strokeDashoffset: 0 }, { strokeDashoffset: 276.5 }], { duration: TIME_LIMIT, fill: "forwards" });',
        '  const late = setTimeout(() => qte.classList.add("is-late"), TIME_LIMIT * 0.7);',
        '  const timer = setTimeout(() => finish("fail", "is-missed"), TIME_LIMIT);',
        '  press.addEventListener("click", hit);',
        '  window.addEventListener("keydown", onKey);',
        "  return () => {",
        "    backdrop.cleanup();",
        "    clearTimeout(late);",
        "    clearTimeout(timer);",
        "    clearTimeout(next);",
        "    ring.cancel();",
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
      "Pulsing spots over the background picture, each emitting its own Signal; a spot's name shows on hover. Place one spot per thing the player can click, and name each Signal after it. To require several finds before moving on, record them in a declared State key and mark found spots with `is-found`.",
    signals: [signal("door", "Door"), signal("window", "Window")],
    source: (title) => ({
      html: [
        '<main class="stage has-backdrop">',
        '  <div class="backdrop is-room" data-media="backdrop"></div>',
        `  <p class="eyebrow hud rise">${escapeHtml(title)}</p>`,
        '  <button type="button" class="hotspot" data-signal="door" style="left: 26%; top: 49%;"><span>Door</span></button>',
        '  <button type="button" class="hotspot" data-signal="window" style="left: 67%; top: 33%;"><span>Window</span></button>',
        '  <div class="subtitle rise" style="--delay: 0.2s">',
        '    <p class="line">Look around.</p>',
        "  </div>",
        "</main>",
        "",
      ].join("\n"),
      css: [
        STYLE_IMPORT,
        "/* Place each spot over the thing it stands for in the picture. */",
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
      "Ending title with a stamp, closing lines, and a restart action. Endings need no Signals because they use session controls; add one if this ending continues into an epilogue.",
    signals: [],
    source: (title) => ({
      html: [
        '<main class="stage has-backdrop">',
        '  <div class="backdrop is-dusk" data-media="backdrop"></div>',
        '  <p class="eyebrow rise">Ending</p>',
        '  <div class="sealed">',
        `    <h1 class="title is-display spread">${escapeHtml(title)}</h1>`,
        '    <span class="seal">Fin</span>',
        "  </div>",
        '  <p class="body rise" style="--delay: 0.9s">Write the closing lines of this ending here.</p>',
        '  <div class="actions rise" style="--delay: 1.4s">',
        '    <button type="button" class="action" data-restart>Play again</button>',
        "  </div>",
        "</main>",
        "",
      ].join("\n"),
      css: STYLE_IMPORT,
      javascript: [
        'import { showBackdrop } from "../../shared/style/components.js";',
        "",
        "export function mount(context) {",
        "  const backdrop = showBackdrop(context);",
        '  const again = context.root.querySelector("[data-restart]");',
        "  const restart = () => context.session.restart();",
        '  again.addEventListener("click", restart);',
        "  return () => {",
        '    again.removeEventListener("click", restart);',
        "    backdrop.cleanup();",
        "  };",
        "}",
        "",
      ].join("\n"),
    }),
  },
];

/**
 * Blank: a background that emits `next` when its video ends or the player
 * clicks. New projects start with it too.
 */
export function blankSource(): { html: string; css: string; javascript: string } {
  return {
    html: [
      '<main class="scene has-backdrop">',
      '  <div class="backdrop is-night" data-media="backdrop"></div>',
      '  <p class="continue-hint">Click to continue ▸</p>',
      "</main>",
      "",
    ].join("\n"),
    css: STYLE_IMPORT,
    javascript: [
      'import { playScene } from "../../shared/style/components.js";',
      "",
      "export function mount(context) {",
      '  return playScene(context, { signal: "next" });',
      "}",
      "",
    ].join("\n"),
  };
}

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
