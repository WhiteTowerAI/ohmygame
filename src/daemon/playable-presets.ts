import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PlayableSignal } from "../shared/playable-nodes.js";
import { withPlayableTemplateArtwork } from "./playable-template-artwork.js";

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
  "story-map",
  "visual-novel",
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
  /** Source for `nodes/<id>/`; `files` are further files there, keyed by file name. */
  /** `id` is the new Node's, for source that names its own files. */
  source: (title: string, id: string) => { html: string; css: string; javascript: string; files?: Record<string, string> };
  /** Shared files the source imports, keyed by workspace path. Added only when the project lacks them. */
  sharedFiles?: Record<string, string>;
  /** Bundled binary files to copy once, keyed by workspace path. */
  sharedFileCopies?: Record<string, string>;
}

export function playablePreset(id: string): PlayablePreset | undefined {
  return PLAYABLE_PRESETS.find((preset) => preset.id === id);
}

function signal(id: string, label: string): PlayableSignal {
  return { id, label };
}

/**
 * Template content lives as ordinary files under `assets/story-templates/`:
 * `project/` is the Project Style every story starts with, `<id>/scene/` is a
 * Template's Scene, and `<id>/project/` holds shared files the Template adds
 * to a project that lacks them. Paths inside `project/` are workspace paths.
 */
const TEMPLATES = path.join(import.meta.dirname, "assets/story-templates");

const BASE_PLAYABLE_PRESETS: PlayablePreset[] = [
  {
    id: "blank",
    label: "Blank",
    summary: "A video or an image, then next",
    brief:
      "A full-screen background that emits `next` when its video ends or the player clicks. The author sets the background from the editor. Build the screen over the background (a `.subtitle` for a line of dialogue, for example), and rename `next` or add Signals for each outcome the player can reach.",
    signals: [signal("next", "Next")],
    source: templateSource("blank"),
  },
  {
    id: "main-menu",
    label: "Main menu",
    summary: "A title, the game's entries, Load, and Settings",
    brief:
      "Title, tagline, and entry list over the background, which the author sets from the editor. Rename the `start` Signal and add one Signal per entry. The entry marked `data-new-game` calls `context.session.reset()` before its Signal, so a new game begins with the starting Variables; keep that on the entry that starts the game. An entry whose Signal is not connected shows disabled, such as Story map before the project has a Story map Scene; remove the entry and its Signal when the author does not want it. Load and Settings open over the menu from this Scene's own code, with no Signal: Load lists the games saved in slots and continues the one picked, and Settings has a slider for each preference, the music and sound volumes the Runtime reads. Add a slider for another preference the game reads, such as a Visual Novel's `textSpeed` and `autoWait`, and remove Load or Settings when the author does not want them.",
    signals: [signal("start", "Start"), { id: "story-map", label: "Story map", role: "navigation" }],
    source: templateSource("main-menu"),
  },
  {
    id: "choice",
    label: "Choice",
    summary: "Answers that lead different ways",
    brief:
      "A line of dialogue with its speaker and answer bars that may read State, over the background. Rewrite the line and the answers for this beat, rename the Signals to the outcomes they describe, and gate an answer on State when the story needs it. Add a time limit only when asked, with the Project Style's `.timer`.",
    signals: [signal("option-a", "Option A"), signal("option-b", "Option B")],
    source: templateSource("choice"),
  },
  {
    id: "qte",
    label: "QTE",
    summary: "Press in time, or miss",
    brief:
      "A timed prompt: a ring runs out around the key, pressing the key or clicking it in time emits `success`, and running out of time emits `fail`. Set the key, the time limit, and the prompt for this moment, and rename the Signals to what happens.",
    signals: [signal("success", "Made it"), signal("fail", "Missed")],
    source: templateSource("qte"),
  },
  {
    id: "hotspot",
    label: "Hotspot",
    summary: "Spots on a picture to click",
    brief:
      "Pulsing spots over the background picture, each emitting its own Signal; a spot's name shows on hover. Place one spot per thing the player can click, and name each Signal after it. To require several finds before moving on, record them in a declared State key and mark found spots with `is-found`.",
    signals: [signal("door", "Door"), signal("window", "Window")],
    source: templateSource("hotspot"),
  },
  {
    id: "ending",
    label: "Ending",
    summary: "The end, with Play again",
    brief:
      "Ending title with a stamp, closing lines, and a restart action. Endings need no Signals because they use session controls; add one if this ending continues into an epilogue.",
    signals: [],
    source: templateSource("ending"),
  },
  {
    id: "story-map",
    label: "Story map",
    summary: "The branches the player has found so far",
    brief:
      "Shows the story as a map: the Scenes the player has seen, the locked ones a step past them, and the endings found, with a line for each way taken. It lays the story out from graph.json in `layout.js` and reads what the player has seen with `context.story.seen()`. Reach it from a menu, a pause button, or an ending through an Exit with Allow Back; Back and Esc return there. In `node.js`, list the IDs of Scenes that are not steps in the story, such as menus and settings, in `OFF_MAP`, give players another name than a title in `LABELS`, and change `isEnding` where the guess from Exits is wrong. Set `SHOW_ALL` to show every Scene, locked.",
    signals: [],
    source: templateSource("story-map"),
  },
  {
    id: "visual-novel",
    label: "Visual Novel",
    summary: "Dialogue lines with characters, then answers",
    brief:
      "A Scene that plays `script.txt` in its folder: dialogue with names, narration, character pictures, background changes, music that plays on into later Scenes, and answers that leave through Signals. The player saves at every line and has Save, Load, Auto, Skip, Log, Settings, and Title. The script format is at the top of `shared/vn/player.js`, and characters with their looks (image Asset IDs) are in `shared/vn/characters.json`. The author writes the lines: never write, rewrite, or extend dialogue or narration unless asked, and keep their wording when restructuring. Declare every Asset the script or its characters use in this Node's `assets`, every Variable it reads or sets in `initialState`, and one Signal per answer or `->` exit, renaming `option-a` and `option-b` to the outcomes. Connect the `title` navigation Exit to the title screen (Main menu) when there is one; Title shows disabled until then. Change the player's look in `shared/vn/player.css`, which every Visual Novel Scene shares.",
    signals: [
      signal("option-a", "Option A"),
      signal("option-b", "Option B"),
      { id: "title", label: "Title", role: "navigation" },
    ],
    source: templateSource("visual-novel"),
    sharedFiles: templateProjectFiles("visual-novel"),
  },
];

export const PLAYABLE_PRESETS = BASE_PLAYABLE_PRESETS.map(withPlayableTemplateArtwork);

/**
 * Blank: a background that emits `next` when its video ends, or when the
 * player clicks a still. New projects start with it too.
 */
export function blankSource(): { html: string; css: string; javascript: string } {
  const { html, css, javascript } = templateSource("blank")("", "");
  return { html, css, javascript };
}

/** The Project Style: shared theme tokens and components that every Scene imports, keyed by workspace path. */
export const PLAYABLE_PROJECT_STYLE_FILES = readTemplateFiles(path.join(TEMPLATES, "project"));

/** The Visual Novel Template's shared player and characters, keyed by workspace path. */
export const VISUAL_NOVEL_SHARED_FILES = templateProjectFiles("visual-novel");

/**
 * A Template's Scene files. `{{title}}` in its HTML becomes the Scene's title,
 * and `{{id}}` in any of its files the Scene's ID.
 */
function templateSource(id: PlayablePresetId): PlayablePreset["source"] {
  const { "index.html": html, "style.css": css, "node.js": javascript, ...files } = readTemplateFiles(path.join(TEMPLATES, id, "scene"));
  if (html === undefined || css === undefined || javascript === undefined) throw new Error(`The ${id} Template is missing a Scene file.`);
  return (title, nodeId) => {
    const fill = (text: string) => text.replaceAll("{{id}}", nodeId);
    return {
      html: fill(html).replaceAll("{{title}}", escapeHtml(title)),
      css: fill(css),
      javascript: fill(javascript),
      ...(Object.keys(files).length ? { files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, fill(content)])) } : {}),
    };
  };
}

function templateProjectFiles(id: PlayablePresetId): Record<string, string> {
  return readTemplateFiles(path.join(TEMPLATES, id, "project"));
}

/** Every file under `directory`, keyed by its path from there with `/` separators. */
function readTemplateFiles(directory: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        return [path.relative(directory, file).split(path.sep).join("/"), readFileSync(file, "utf8")];
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  );
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
