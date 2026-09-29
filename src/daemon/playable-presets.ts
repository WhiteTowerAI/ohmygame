import type { PlayableSignal } from "../shared/playable-nodes.js";

/**
 * Presets are starting points, not Node types: the chosen name is never
 * stored, and a Node created from one can become anything. Each Preset brings
 * starter source that already uses the Project Style, its starter Signals, and
 * a brief that tells the Agent what the author usually wants next.
 */
export const PLAYABLE_PRESET_IDS = [
  "blank",
  "main-menu",
  "cinematic",
  "dialogue-choice",
  "archive",
  "investigation",
  "ending",
] as const;

export type PlayablePresetId = (typeof PLAYABLE_PRESET_IDS)[number];

export interface PlayablePreset {
  id: PlayablePresetId;
  label: string;
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
    brief:
      "Title, subtitle, entry list, and a background image slot. Declare an image Asset and set it on the stage, then rename the `start` Signal and add one Signal per entry.",
    signals: [signal("start", "Start")],
    source: (title) => ({
      html: [
        '<main class="stage is-cover">',
        '  <p class="eyebrow">A new case</p>',
        `  <h1 class="title">${escapeHtml(title)}</h1>`,
        '  <ul class="menu">',
        '    <li><button type="button" class="action" data-signal="start">Start</button></li>',
        '    <li><button type="button" class="action is-quiet" data-continue>Continue</button></li>',
        "  </ul>",
        "</main>",
        "",
      ].join("\n"),
      css: `${STYLE_IMPORT}\n/* Set a declared image Asset as the background in node.js. */\n`,
      javascript: [
        "export function mount(context) {",
        '  const start = context.root.querySelector(\'[data-signal="start"]\');',
        '  const resume = context.root.querySelector("[data-continue]");',
        "  const begin = () => context.navigation.emit(\"start\");",
        "  const restore = () => context.session.continue();",
        "  // Continue is only offered when a save exists.",
        '  if (!context.session.hasSave()) resume.setAttribute("aria-disabled", "true");',
        '  else resume.addEventListener("click", restore);',
        '  start.addEventListener("click", begin);',
        "  return () => {",
        '    start.removeEventListener("click", begin);',
        '    resume.removeEventListener("click", restore);',
        "  };",
        "}",
        "",
      ].join("\n"),
    }),
  },
  {
    id: "cinematic",
    label: "Cinematic scene",
    brief:
      "Full-screen video with skip that emits `next` when playback ends. Declare a video Asset on this Node and pass its ID to playCinematic. For a different ending behaviour, replace the call with your own code.",
    signals: [signal("next", "Next")],
    source: () => ({
      html: "<main></main>\n",
      css: STYLE_IMPORT,
      javascript: [
        'import { playCinematic } from "../../shared/style/components.js";',
        "",
        "export function mount(context) {",
        "  // Declare a video Asset on this Node and use its ID here.",
        '  return playCinematic(context, { assetId: "cinematic", signal: "next" });',
        "}",
        "",
      ].join("\n"),
    }),
  },
  {
    id: "dialogue-choice",
    label: "Dialogue choice",
    brief:
      "A speaker line and options that may read State. Rewrite the options for this beat, rename the Signals to the outcomes they describe, and gate an option on State when the story needs it.",
    signals: [signal("option-a", "Option A"), signal("option-b", "Option B")],
    source: (title) => ({
      html: [
        '<main class="stage is-cover">',
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
        "export function mount(context) {",
        '  const options = [...context.root.querySelectorAll("[data-signal]")];',
        "  const choose = (event) => {",
        '    const chosen = event.currentTarget.dataset.signal;',
        "    return context.navigation.emit(chosen);",
        "  };",
        '  for (const option of options) option.addEventListener("click", choose);',
        "  return () => {",
        '    for (const option of options) option.removeEventListener("click", choose);',
        "  };",
        "}",
        "",
      ].join("\n"),
    }),
  },
  {
    id: "archive",
    label: "Archive",
    brief:
      "A folder with an index that changes the visible page. Replace the entries with the real records; read State to reveal records the player has unlocked. Reached with a `push` edge so `leave` can return.",
    signals: [signal("leave", "Leave")],
    source: (title) => ({
      html: [
        '<main class="stage">',
        `  <h1 class="title">${escapeHtml(title)}</h1>`,
        '  <section class="panel" style="display: grid; grid-template-columns: 200px 1fr; gap: var(--space-3);">',
        '    <ul class="menu" data-index>',
        '      <li><button type="button" class="action is-quiet" data-page="first">First record</button></li>',
        '      <li><button type="button" class="action is-quiet" data-page="second">Second record</button></li>',
        "    </ul>",
        '    <article class="body" data-page-body>Choose a record.</article>',
        "  </section>",
        '  <button type="button" class="action" data-signal="leave">Close the archive</button>',
        "</main>",
        "",
      ].join("\n"),
      css: STYLE_IMPORT,
      javascript: [
        "const PAGES = {",
        '  first: "The first record is water damaged; only a date survives.",',
        '  second: "The second record names a witness who never testified.",',
        "};",
        "",
        "export function mount(context) {",
        '  const index = context.root.querySelector("[data-index]");',
        '  const body = context.root.querySelector("[data-page-body]");',
        '  const leave = context.root.querySelector(\'[data-signal="leave"]\');',
        "  const show = (event) => {",
        '    const page = event.target.closest("[data-page]")?.dataset.page;',
        "    if (page) body.textContent = PAGES[page];",
        "  };",
        '  const close = () => context.navigation.emit("leave");',
        '  index.addEventListener("click", show);',
        '  leave.addEventListener("click", close);',
        "  return () => {",
        '    index.removeEventListener("click", show);',
        '    leave.removeEventListener("click", close);',
        "  };",
        "}",
        "",
      ].join("\n"),
    }),
  },
  {
    id: "investigation",
    label: "Investigation",
    brief:
      "An image with hotspots that record findings in State. Declare the scene image Asset, position the hotspots over it, and declare the State key that collects findings before writing to it.",
    signals: [signal("done", "Done")],
    source: (title) => ({
      html: [
        '<main class="stage is-cover" style="position: relative;">',
        `  <h1 class="title">${escapeHtml(title)}</h1>`,
        '  <button type="button" class="action is-quiet" data-clue="ledger" style="position: absolute; left: 22%; top: 46%;">Ledger</button>',
        '  <button type="button" class="action is-quiet" data-clue="key" style="position: absolute; left: 63%; top: 61%;">Key</button>',
        '  <p class="body" data-found>Nothing found yet.</p>',
        '  <button type="button" class="action" data-signal="done">Leave the room</button>',
        "</main>",
        "",
      ].join("\n"),
      css: STYLE_IMPORT,
      javascript: [
        "export function mount(context) {",
        '  const hotspots = [...context.root.querySelectorAll("[data-clue]")];',
        '  const found = context.root.querySelector("[data-found]");',
        '  const done = context.root.querySelector(\'[data-signal="done"]\');',
        "  // Declare an array State key such as foundClues and use it here.",
        "  const render = (clues) => {",
        '    found.textContent = clues.length ? `Found: ${clues.join(", ")}` : "Nothing found yet.";',
        "  };",
        "  const collect = async (event) => {",
        "    const clue = event.currentTarget.dataset.clue;",
        '    const clues = context.state.get("foundClues") ?? [];',
        "    if (clues.includes(clue)) return;",
        '    await context.state.set("foundClues", [...clues, clue]);',
        "  };",
        '  const leave = () => context.navigation.emit("done");',
        '  const stop = context.state.subscribe((state) => render(state.foundClues ?? []));',
        '  for (const hotspot of hotspots) hotspot.addEventListener("click", collect);',
        '  done.addEventListener("click", leave);',
        '  render(context.state.get("foundClues") ?? []);',
        "  return () => {",
        "    stop();",
        '    for (const hotspot of hotspots) hotspot.removeEventListener("click", collect);',
        '    done.removeEventListener("click", leave);',
        "  };",
        "}",
        "",
      ].join("\n"),
    }),
  },
  {
    id: "ending",
    label: "Ending",
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
