/**
 * The Visual Novel Template: a Scene that plays its own script, line by line,
 * over its background. The player and its look are ordinary shared project
 * source under `shared/vn/`, added the first time a project gets a Visual
 * Novel Scene and edited freely afterwards, like the Project Style. Each Scene
 * keeps its lines in `nodes/<id>/script.txt`.
 */

/** Shared files a Visual Novel Scene imports, written only when missing. */
export const VISUAL_NOVEL_SHARED_FILES: Record<string, string> = {
  "shared/vn/characters.json": `{
  "stranger": {
    "name": "Stranger",
    "color": "#e0483b",
    "looks": {}
  }
}
`,
  "shared/vn/player.css": `/* The Visual Novel player: sprites, the dialogue box, answers, the quick menu,
   and the log. Every Visual Novel Scene imports this file, so changing it
   restyles them all. Answers use the Project Style's .choices and .option. */
@import "../style/components.css";

.vn {
  --letterbox: 0cqw;
  --vn-box: rgb(10 10 14 / 0.78);

  position: relative;
  width: 100%;
  height: 100%;
  cursor: default;
  user-select: none;
}

.vn .backdrop::after {
  background: linear-gradient(transparent 55%, rgb(0 0 0 / 0.45));
}

/* A background from the script hides the placeholder picture. */
.vn .backdrop:has(> img, > video)::before {
  display: none;
}

/* Characters stand on the bottom edge, at the left, centre, or right. */
.vn-sprites {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.vn-sprite {
  position: absolute;
  bottom: 0;
  height: 92%;
  transform: translateX(-50%);
  transition: left 0.35s, filter 0.25s, opacity 0.3s;
  animation: vn-fade 0.3s both;
}

.vn-sprite.is-left { left: 24%; }
.vn-sprite.is-center { left: 50%; }
.vn-sprite.is-right { left: 76%; }

.vn-sprite > img {
  display: block;
  height: 100%;
}

/* While someone else speaks, the others step back. */
.vn.has-speaker .vn-sprite:not(.is-speaking) {
  filter: brightness(0.6);
}

/* A figure in a hat, drawn for a character with no picture yet. */
.vn-sprite.is-placeholder {
  height: 70%;
  aspect-ratio: 0.6;
  background: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 60 100'><g fill='%23050506'><path d='M18 17C19 7 23 3 30 3S41 7 42 17Z'/><ellipse cx='30' cy='17' rx='21' ry='2.4'/><ellipse cx='30' cy='28' rx='10' ry='12'/><rect x='25' y='37' width='10' height='10'/><path d='M0 100L2 62C4 54 14 50 24 47H36C46 50 56 54 58 62L60 100Z'/></g></svg>") bottom / contain no-repeat;
}

/* The dialogue box along the bottom, with the speaker's name above it. */
.vn-box {
  position: absolute;
  left: 6cqw;
  right: 6cqw;
  bottom: 2.4cqw;
  box-sizing: border-box;
  min-height: 12cqw;
  padding: 2.4cqw 3cqw 3cqw;
  border: 1px solid var(--color-line);
  border-radius: calc(var(--radius) * 3);
  background: var(--vn-box);
  backdrop-filter: blur(0.4cqw);
}

.vn-box[hidden] {
  display: none;
}

.vn-name {
  position: absolute;
  left: 2.4cqw;
  top: 0;
  margin: 0;
  padding: 0.5cqw 1.6cqw;
  border-radius: var(--radius);
  background: var(--vn-speaker, var(--color-accent));
  color: #fff;
  font-size: var(--text-body);
  font-weight: 700;
  letter-spacing: 0.08em;
  transform: translateY(-55%);
}

.vn-name:empty {
  display: none;
}

.vn-text {
  margin: 0;
  font-size: var(--text-line);
  line-height: 1.65;
  letter-spacing: 0.04em;
  white-space: pre-wrap;
}

/* Shown when the line is complete and a click moves on. */
.vn-next {
  position: absolute;
  right: 2.4cqw;
  bottom: 1.4cqw;
  color: var(--color-muted);
  font-size: var(--text-body);
  animation: hint-blink 1.6s ease-in-out infinite;
}

.vn-next[hidden] {
  display: none;
}

/* The quick menu, small along the box's bottom edge. */
.vn-menu {
  position: absolute;
  right: 7cqw;
  bottom: 0.4cqw;
  display: flex;
  gap: 1.6cqw;
}

.vn-menu button {
  border: 0;
  padding: 0.3cqw 0;
  background: none;
  color: var(--color-muted);
  font: inherit;
  font-size: var(--text-eyebrow);
  letter-spacing: 0.2em;
  text-transform: uppercase;
  cursor: pointer;
}

.vn-menu button:hover,
.vn-menu button:focus-visible,
.vn-menu button[aria-pressed="true"] {
  outline: none;
  color: var(--color-accent-ink);
}

.vn-menu button[aria-disabled="true"] {
  opacity: 0.35;
  cursor: default;
}

.vn .choices {
  z-index: 1;
}

/* An answer whose Exit goes nowhere yet. A filter, since the entrance animation holds opacity. */
.vn .option[aria-disabled="true"] {
  filter: opacity(0.35);
  cursor: default;
}

/* Save, Load, Log, and Settings open over everything. */
.vn-panel {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: var(--space-2);
  padding: 3.2cqw 10cqw 2.6cqw;
  background: rgb(6 6 8 / 0.92);
}

.vn-panel[hidden] {
  display: none;
}

.vn-panel h2 {
  margin: 0;
  color: var(--color-muted);
  font-size: var(--text-eyebrow);
  font-weight: 400;
  letter-spacing: 0.4em;
  text-transform: uppercase;
}

.vn-panel-body {
  display: grid;
  min-height: 0;
}

.vn-panel .action {
  justify-self: center;
}

.vn-log {
  overflow: auto;
  margin: 0;
  padding: 0;
  list-style: none;
  scrollbar-width: thin;
}

.vn-log li {
  display: grid;
  grid-template-columns: 12cqw 1fr;
  gap: var(--space-2);
  padding: var(--space-1) 0;
  font-size: var(--text-body);
  line-height: 1.6;
}

.vn-log li > b {
  color: var(--vn-speaker, var(--color-accent-ink));
  text-align: right;
}

/* Slots in a grid: number, when, and the line the game was saved on. */
.vn-slots {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-auto-rows: 1fr;
  gap: var(--space-2);
}

.vn-slot {
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-rows: auto 1fr;
  gap: 0.3cqw var(--space-2);
  align-content: start;
  min-width: 0;
  padding: var(--space-2);
  border: 1px solid var(--color-line);
  border-radius: var(--radius);
  background: rgb(255 255 255 / 0.03);
  color: var(--color-ink);
  font: inherit;
  text-align: start;
  cursor: pointer;
}

.vn-slot:hover:not(:disabled),
.vn-slot:focus-visible {
  outline: none;
  border-color: var(--color-accent);
}

.vn-slot:disabled {
  opacity: 0.4;
  cursor: default;
}

.vn-slot b {
  grid-row: span 2;
  color: var(--color-accent-ink);
  font-family: var(--font-display);
  font-size: var(--text-line);
}

.vn-slot small {
  color: var(--color-muted);
  font-size: var(--text-eyebrow);
}

.vn-slot span {
  overflow: hidden;
  font-size: var(--text-eyebrow);
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Settings: a slider per preference, with its value. */
.vn-settings {
  display: grid;
  align-content: center;
  gap: var(--space-3);
  width: 60cqw;
  justify-self: center;
}

.vn-settings label {
  display: grid;
  grid-template-columns: 14cqw 1fr 6cqw;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-body);
}

.vn-settings input {
  width: 100%;
  accent-color: var(--color-accent);
}

.vn-settings output {
  color: var(--color-muted);
  text-align: right;
}

@keyframes vn-fade {
  from {
    opacity: 0;
  }
}
`,
  "shared/vn/player.js": `/**
 * Visual Novel player. A Visual Novel Scene keeps its lines in script.txt and
 * mounts with playScript(context, script). Characters are listed once in
 * characters.json: an ID, the name players see, the name's colour, and
 * "looks" from a look name to an image Asset ID ("default" when a line does
 * not name one). A character with no looks shows a placeholder figure.
 *
 * Script lines, one step each. Blank lines are skipped.
 *
 *   # a note               not shown
 *   @bg <asset> [video]    change the background
 *   @show <who> [look] [left|center|right]
 *   @hide <who>
 *   @music <asset>         music that plays on into later Scenes; @music stop ends it
 *   @sfx <asset>           play a sound once
 *   @set <key> = <value>   also += and -=; <key> is a Variable
 *   who: words             a line of dialogue; <who> is a character ID or any name
 *   words                  narration; start with \\ to keep a leading "name:"
 *   ? words -> <exit>      an answer; consecutive answers are asked together
 *   ? [trust >= 3] words -> <exit> {trust += 1}
 *   -> <exit>              leave the Scene; -> [key] <exit> only when key holds
 *
 * A condition is "<key> <op> <value>" with ==, !=, >, >=, <, or <=, or a
 * bare key that must be truthy, or !key. A value is a number, true, false,
 * null, or "quoted text". Each <exit> is one of the Scene's Signals.
 *
 * The game saves at every line, so Continue and a loaded slot return to the
 * line the player was on. Variables set by the script are saved when the
 * Scene is left; until then the Scene works them out again from its start.
 * Music plays on into the next Scene until a script changes it, and turns
 * down while a video with sound plays.
 *
 * The quick menu offers Save, Load, Auto, Skip, Log, Settings, and Title.
 * Title leaves through the Scene's "title" Signal, a navigation Exit, and
 * shows disabled until it is connected.
 */
import { showBackdrop } from "../style/components.js";
import characters from "./characters.json" with { type: "json" };

/** Words the player sees on the controls. */
const LABELS = {
  save: "Save",
  load: "Load",
  auto: "Auto",
  skip: "Skip",
  log: "Log",
  settings: "Settings",
  title: "Title",
  close: "Close",
  empty: "Empty",
  incompatible: "From another version",
  music: "Music",
  sound: "Sound",
  textSpeed: "Text speed",
  autoWait: "Auto wait",
};
/** How many slots Save and Load show. */
const SLOT_COUNT = 12;
/** Characters per second while a line types out, until the player changes it in Settings. */
const TEXT_SPEED = 40;
/** Seconds Auto waits after a line, until the player changes it, plus a little per character. */
const AUTO_WAIT = 1.2;
const AUTO_WAIT_PER_CHARACTER = 0.045;
/** How quickly Skip moves through lines, in milliseconds. */
const SKIP_DELAY = 70;

const POSITIONS = ["left", "center", "right"];
const NAME = "[A-Za-z0-9][A-Za-z0-9._-]*";
const CONDITION = "(?:\\\\[([^\\\\]]+)\\\\]\\\\s*)?";

/**
 * Reads a script into steps. Throws with the line number at the first line
 * it cannot read, so a mistake shows as soon as the Scene opens.
 *
 * @param {string} text
 */
export function parseScript(text) {
  const steps = [];
  // Answers and an exit that always leaves end the Scene; nothing may follow.
  let closed;
  const lines = text.split(/\\r?\\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const number = index + 1;
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;
    const indent = lines[index].length - lines[index].trimStart().length;
    const fail = (message) => {
      throw new Error("script.txt line " + number + ": " + message);
    };
    const step = readLine(line, fail);
    step.line = number;
    // Where a line's words start, so the editor can change them in place.
    if (step.kind === "say") step.column = indent + line.length - step.text.length + 1;
    const previous = steps[steps.length - 1];
    if (step.kind === "answer" && previous?.kind === "choice") {
      previous.answers.push(step);
      continue;
    }
    if (closed) fail("nothing runs after " + closed + "; move this line before it.");
    if (step.kind === "answer") {
      steps.push({ kind: "choice", answers: [step], line: number });
      closed = "the answers above";
      continue;
    }
    steps.push(step);
    if (step.kind === "exit" && !step.when) closed = "-> " + step.signal;
  }
  return steps;
}

function readLine(line, fail) {
  if (line.startsWith("\\\\")) return { kind: "say", text: line.slice(1).trim() };
  if (line.startsWith("@")) return readCommand(line, fail);
  if (line.startsWith("?")) {
    const match = new RegExp("^\\\\?\\\\s*" + CONDITION + "(.+?)\\\\s*->\\\\s*(" + NAME + ")\\\\s*(?:\\\\{([^}]*)\\\\})?$").exec(line);
    if (!match) fail("an answer is written \\"? words -> exit\\".");
    return {
      kind: "answer",
      when: match[1] ? readCondition(match[1], fail) : undefined,
      text: match[2],
      signal: match[3],
      effects: match[4] ? match[4].split(";").map((effect) => effect.trim()).filter(Boolean).map((effect) => readEffect(effect, fail)) : [],
    };
  }
  if (line.startsWith("->")) {
    const match = new RegExp("^->\\\\s*" + CONDITION + "(" + NAME + ")$").exec(line);
    if (!match) fail("an exit is written \\"-> exit\\".");
    return { kind: "exit", when: match[1] ? readCondition(match[1], fail) : undefined, signal: match[2] };
  }
  const spoken = /^([^\\s:：]{1,24})\\s*[:：]\\s*(.+)$/.exec(line);
  if (spoken) return { kind: "say", who: spoken[1], text: spoken[2] };
  return { kind: "say", text: line };
}

function readCommand(line, fail) {
  const [command, ...words] = line.slice(1).split(/\\s+/);
  const name = (word, what) => {
    if (!word || !new RegExp("^" + NAME + "$").test(word)) fail("@" + command + " needs " + what + ".");
    return word;
  };
  switch (command) {
    case "bg":
      if (words.length > 2 || (words[1] && words[1] !== "video")) fail("write @bg <asset> or @bg <asset> video.");
      return { kind: "bg", asset: name(words[0], "an Asset ID"), video: words[1] === "video" };
    case "show": {
      const who = name(words[0], "a character");
      let look;
      let at;
      for (const word of words.slice(1)) {
        if (POSITIONS.includes(word) && !at) at = word;
        else if (!look && !POSITIONS.includes(word)) look = name(word, "a look");
        else fail("write @show <who> [look] [left|center|right].");
      }
      return { kind: "show", who, look, at };
    }
    case "hide":
      if (words.length !== 1) fail("write @hide <who>.");
      return { kind: "hide", who: name(words[0], "a character") };
    case "music":
      if (words.length !== 1) fail("write @music <asset> or @music stop.");
      return { kind: "music", asset: words[0] === "stop" ? null : name(words[0], "an Asset ID") };
    case "sfx":
      if (words.length !== 1) fail("write @sfx <asset>.");
      return { kind: "sfx", asset: name(words[0], "an Asset ID") };
    case "set":
      return { kind: "set", ...readEffect(words.join(" "), fail) };
    default:
      fail("unknown command @" + command + ". Use @bg, @show, @hide, @music, @sfx, or @set.");
  }
}

function readEffect(text, fail) {
  const match = new RegExp("^(" + NAME + ")\\\\s*(\\\\+=|-=|=)\\\\s*(.+)$").exec(text.trim());
  if (!match) fail("a change is written \\"key = value\\", \\"key += 1\\", or \\"key -= 1\\".");
  const value = readValue(match[3], fail);
  if (match[2] !== "=" && typeof value !== "number") fail(match[2] + " needs a number.");
  return { key: match[1], op: match[2], value };
}

function readCondition(text, fail) {
  const trimmed = text.trim();
  const bare = new RegExp("^(!?)(" + NAME + ")$").exec(trimmed);
  if (bare) return { key: bare[2], op: bare[1] ? "falsy" : "truthy" };
  const match = new RegExp("^(" + NAME + ")\\\\s*(==|!=|>=|<=|>|<)\\\\s*(.+)$").exec(trimmed);
  if (!match) fail("a condition is written [key >= 3], [key], or [!key].");
  return { key: match[1], op: match[2], value: readValue(match[3], fail) };
}

function readValue(text, fail) {
  const value = text.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\\d+(?:\\.\\d+)?$/.test(value)) return Number(value);
  if (/^"(?:[^"\\\\]|\\\\.)*"$/.test(value)) return JSON.parse(value);
  fail("\\"" + value + "\\" is not a number, true, false, null, or \\"quoted text\\".");
}
/**
 * Plays a script over the Scene's background. Call it from mount() and
 * return what it returns.
 *
 * @param {object} context the Node context passed to mount
 * @param {string} script the Scene's script.txt
 * @param {{ source?: string }} [options] the script's path in the project,
 *   which lets the editor change a line's words where the player shows them
 * @returns {() => void} cleanup
 */
export function playScript(context, script, options = {}) {
  const steps = parseScript(script);
  const version = scriptVersion(script);
  const stage = context.root.querySelector(".vn") ?? context.root.firstElementChild;
  const ui = buildInterface(stage);
  let backdrop = showBackdrop(context);

  // Check every Asset, Variable, and character first, so a mistake shows now
  // rather than halfway through the Scene.
  const variables = {};
  const read = (key) => {
    if (!(key in variables)) variables[key] = context.state.get(key);
    return variables[key];
  };
  const changed = new Set();
  for (const step of steps) {
    const checks = step.kind === "choice" ? step.answers : [step];
    for (const check of checks) {
      if (check.when) read(check.when.key);
      for (const effect of check.effects ?? []) read(effect.key);
      if (check.kind === "set") read(check.key);
      if (check.asset) context.assets.url(check.asset);
      if (check.kind === "show") lookAsset(check.who, check.look, step.line);
      if (check.kind === "hide") character(check.who, step.line);
    }
  }

  const sprites = new Map();
  const log = [];
  let index = 0;
  let typing;
  let waiting = false;
  let leaving = false;
  let mode;
  let timer;
  let panel;

  const holds = (condition) => {
    if (!condition) return true;
    const value = read(condition.key);
    switch (condition.op) {
      case "truthy": return Boolean(value);
      case "falsy": return !value;
      case "==": return value === condition.value;
      case "!=": return value !== condition.value;
      case ">": return value > condition.value;
      case ">=": return value >= condition.value;
      case "<": return value < condition.value;
      case "<=": return value <= condition.value;
    }
  };
  const apply = (effect) => {
    const current = read(effect.key);
    if (effect.op === "=") variables[effect.key] = effect.value;
    else variables[effect.key] = (typeof current === "number" ? current : 0) + (effect.op === "+=" ? effect.value : -effect.value);
    changed.add(effect.key);
  };
  const preference = (key, fallback) => {
    const value = context.preferences.get()[key];
    return typeof value === "number" ? value : fallback;
  };
  /** Saves the game at a line or answers, so the player comes back to them. */
  const remember = (step) => {
    context.position.set({ script: version, step }).catch(() => {});
  };

  const leave = async (signal) => {
    if (leaving) return;
    leaving = true;
    setMode(undefined);
    if (changed.size) await context.state.patch(Object.fromEntries([...changed].map((key) => [key, variables[key]])));
    await context.navigation.emit(signal);
  };

  const setBackground = (step) => {
    backdrop.cleanup();
    const element = document.createElement(step.video ? "video" : "img");
    element.src = context.assets.url(step.asset);
    if (step.video) {
      element.playsInline = true;
      element.play?.().catch(() => {});
    } else element.alt = "";
    ui.backdrop.append(element);
    backdrop = { cleanup: () => element.remove() };
  };

  const show = (step) => {
    const who = character(step.who, step.line);
    let sprite = sprites.get(step.who);
    if (!sprite) {
      sprite = document.createElement("div");
      sprite.className = "vn-sprite is-center";
      sprites.set(step.who, sprite);
      ui.sprites.append(sprite);
    }
    if (step.at) {
      for (const position of POSITIONS) sprite.classList.toggle("is-" + position, position === step.at);
    }
    const asset = lookAsset(step.who, step.look, step.line);
    sprite.classList.toggle("is-placeholder", !asset);
    sprite.replaceChildren();
    if (asset) {
      const image = document.createElement("img");
      image.src = context.assets.url(asset);
      image.alt = who.name ?? step.who;
      sprite.append(image);
    }
  };

  const speaker = (step) => {
    const who = step.who ? characters[step.who] : undefined;
    return { name: step.who ? who?.name ?? step.who : "", color: who?.color ?? "" };
  };

  /** Applies a step that changes the scene rather than waiting for the player. */
  const perform = (step, replaying) => {
    switch (step.kind) {
      case "bg": return setBackground(step);
      case "show": return show(step);
      case "hide":
        sprites.get(step.who)?.remove();
        sprites.delete(step.who);
        return;
      case "music": return context.audio.music(step.asset);
      case "sfx": if (!replaying) context.audio.sound(step.asset); return;
      case "set": return apply(step);
    }
  };

  const say = (step) => {
    const { name, color } = speaker(step);
    ui.box.hidden = false;
    ui.name.textContent = name;
    if (options.source) ui.text.setAttribute("data-ohmygame-source", options.source + ":" + step.line + ":" + step.column);
    ui.box.style.setProperty("--vn-speaker", color || null);
    stage.classList.toggle("has-speaker", Boolean(step.who && sprites.has(step.who)));
    for (const [id, sprite] of sprites) sprite.classList.toggle("is-speaking", id === step.who);
    log.push({ name, color, text: step.text });

    const glyphs = Array.from(step.text);
    let shown = 0;
    ui.next.hidden = true;
    const finish = () => {
      clearInterval(typing?.interval);
      typing = undefined;
      ui.text.textContent = step.text;
      ui.next.hidden = false;
      waiting = true;
      if (mode === "auto") timer = setTimeout(advance, (preference("autoWait", AUTO_WAIT) + AUTO_WAIT_PER_CHARACTER * glyphs.length) * 1000);
      if (mode === "skip") timer = setTimeout(advance, SKIP_DELAY);
    };
    if (mode === "skip") return finish();
    ui.text.textContent = "";
    typing = {
      finish,
      interval: setInterval(() => {
        shown += 1;
        ui.text.textContent = glyphs.slice(0, shown).join("");
        if (shown >= glyphs.length) finish();
      }, 1000 / Math.max(1, preference("textSpeed", TEXT_SPEED))),
    };
  };

  const ask = (step) => {
    setMode(undefined);
    ui.next.hidden = true;
    const answers = step.answers.filter((answer) => holds(answer.when));
    ui.choices.replaceChildren(...answers.map((answer, position) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "option rise";
      button.style.setProperty("--delay", position * 0.08 + "s");
      const key = document.createElement("kbd");
      key.textContent = String(position + 1);
      button.append(key, answer.text);
      // An answer whose Exit goes nowhere yet shows disabled.
      if (!context.navigation.connected(answer.signal)) button.setAttribute("aria-disabled", "true");
      button.answer = answer;
      return button;
    }));
    ui.choices.hidden = false;
  };

  const choose = (button) => {
    if (!button || button.getAttribute("aria-disabled") === "true" || ui.choices.classList.contains("is-made")) return;
    ui.choices.classList.add("is-made");
    button.classList.add("is-picked");
    for (const effect of button.answer.effects) apply(effect);
    void leave(button.answer.signal);
  };

  /** Runs steps up to the next line, answers, or exit. */
  const run = () => {
    waiting = false;
    while (index < steps.length && !leaving) {
      const step = steps[index];
      index += 1;
      if (step.kind === "say" || step.kind === "choice") {
        remember(index - 1);
        return step.kind === "say" ? say(step) : ask(step);
      }
      if (step.kind === "exit") {
        if (holds(step.when)) return void leave(step.signal);
        continue;
      }
      perform(step, false);
    }
    // The end of a script with no exit: the last line stays.
    setMode(undefined);
  };

  /**
   * Picks up at the line the save was made on: the steps before it set the
   * scene and the Variables again, without sounds or waiting.
   */
  const resume = () => {
    const saved = context.position.get();
    const step = saved?.script === version ? saved.step : undefined;
    if (!Number.isInteger(step) || step <= 0 || step >= steps.length) return;
    if (steps[step].kind !== "say" && steps[step].kind !== "choice") return;
    for (; index < step; index += 1) {
      const passed = steps[index];
      if (passed.kind === "say") log.push({ ...speaker(passed), text: passed.text });
      else if (passed.kind !== "exit" && passed.kind !== "choice") perform(passed, true);
    }
  };

  const advance = () => {
    clearTimeout(timer);
    if (leaving || panel || !ui.choices.hidden) return;
    if (typing) return typing.finish();
    if (waiting) run();
  };

  const setMode = (next) => {
    mode = next;
    clearTimeout(timer);
    ui.buttons.auto.setAttribute("aria-pressed", String(mode === "auto"));
    ui.buttons.skip.setAttribute("aria-pressed", String(mode === "skip"));
    if (mode && waiting) timer = setTimeout(advance, mode === "skip" ? SKIP_DELAY : preference("autoWait", AUTO_WAIT) * 1000);
    if (mode === "skip" && typing) typing.finish();
  };

  const openPanel = (kind) => {
    setMode(undefined);
    panel = kind;
    ui.panel.hidden = false;
    ui.panel.dataset.panel = kind;
    ui.panelTitle.textContent = LABELS[kind];
    renderPanel();
  };
  const closePanel = () => {
    panel = undefined;
    ui.panel.hidden = true;
  };
  const renderPanel = () => {
    if (panel === "log") ui.panelBody.replaceChildren(logList(log));
    else if (panel === "settings") ui.panelBody.replaceChildren(settingsForm(context.preferences.get()));
    else ui.panelBody.replaceChildren(slotGrid(context.session.slots(), panel));
    if (panel === "log") ui.panelBody.firstChild.scrollTop = ui.panelBody.firstChild.scrollHeight;
  };
  const useSlot = async (id) => {
    if (panel === "save") {
      const last = log[log.length - 1];
      const note = last ? (last.name ? last.name + ": " : "") + last.text : "";
      await context.session.saveSlot(id, note.length > 120 ? note.slice(0, 119) + "…" : note || undefined);
      renderPanel();
      return;
    }
    closePanel();
    await context.session.loadSlot(id);
  };

  const onClick = (event) => {
    const button = event.target.closest?.("button");
    if (button?.dataset.slot) return void useSlot(button.dataset.slot).catch(() => {});
    if (button === ui.close) return closePanel();
    if (panel) return;
    const action = button?.dataset.action;
    if (action === "auto") return setMode(mode === "auto" ? undefined : "auto");
    if (action === "skip") return setMode(mode === "skip" ? undefined : "skip");
    if (action === "title") return button.getAttribute("aria-disabled") === "true" ? undefined : void leave("title");
    if (action) return openPanel(action);
    if (button && ui.choices.contains(button)) return choose(button);
    if (!ui.choices.hidden) return;
    // A click while Auto or Skip runs hands control back to the player.
    if (mode) return setMode(undefined);
    advance();
  };
  const onInput = (event) => {
    const key = event.target.name;
    if (!key) return;
    const value = Number(event.target.value);
    event.target.nextElementSibling.textContent = formatSetting(key, value);
    void context.preferences.set({ [key]: value }).catch(() => {});
  };
  const onKey = (event) => {
    if (event.key === "Escape" && panel) return closePanel();
    if (panel) return;
    if (!ui.choices.hidden) {
      const button = ui.choices.children[Number(event.key) - 1];
      if (button) choose(button);
      return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (mode) setMode(undefined);
      else advance();
    }
  };
  const onWheel = (event) => {
    if (event.deltaY < 0 && !panel) openPanel("log");
  };

  // Title is a way around the game; it shows disabled until its Exit is connected.
  if (!context.navigation.connected("title")) ui.buttons.title.setAttribute("aria-disabled", "true");
  stage.addEventListener("click", onClick);
  stage.addEventListener("input", onInput);
  stage.addEventListener("wheel", onWheel, { passive: true });
  window.addEventListener("keydown", onKey);
  resume();
  run();

  return () => {
    clearInterval(typing?.interval);
    clearTimeout(timer);
    backdrop.cleanup();
    stage.removeEventListener("click", onClick);
    stage.removeEventListener("input", onInput);
    stage.removeEventListener("wheel", onWheel);
    window.removeEventListener("keydown", onKey);
  };

  function character(id, line) {
    const found = characters[id];
    if (!found) throw new Error("script.txt line " + line + ": \\"" + id + "\\" is not in shared/vn/characters.json.");
    return found;
  }

  function lookAsset(id, look, line) {
    const looks = character(id, line).looks ?? {};
    const names = Object.keys(looks);
    if (!names.length) return undefined;
    const name = look ?? ("default" in looks ? "default" : names[0]);
    const asset = looks[name];
    if (!asset) throw new Error("script.txt line " + line + ": " + id + " has no look \\"" + name + "\\" in shared/vn/characters.json.");
    context.assets.url(asset);
    return asset;
  }
}

/** A short fingerprint of the script, so a save made before it changed starts the Scene over. */
function scriptVersion(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

function logList(log) {
  const list = document.createElement("ol");
  list.className = "vn-log";
  list.append(...log.map((entry) => {
    const item = document.createElement("li");
    const name = document.createElement("b");
    name.textContent = entry.name;
    if (entry.color) item.style.setProperty("--vn-speaker", entry.color);
    item.append(name, entry.text);
    return item;
  }));
  return list;
}

function slotGrid(slots, mode) {
  const grid = document.createElement("div");
  grid.className = "vn-slots";
  const byId = new Map(slots.map((slot) => [slot.id, slot]));
  for (let number = 1; number <= SLOT_COUNT; number += 1) {
    const id = String(number);
    const slot = byId.get(id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vn-slot";
    button.dataset.slot = id;
    const title = document.createElement("b");
    title.textContent = String(number).padStart(2, "0");
    const when = document.createElement("small");
    when.textContent = slot ? new Date(slot.savedAt).toLocaleString() : LABELS.empty;
    const note = document.createElement("span");
    note.textContent = slot?.incompatible ? LABELS.incompatible : slot?.note ?? "";
    button.append(title, when, note);
    // Only a slot that holds a game this version can play can be loaded.
    if (mode === "load" && (!slot || slot.incompatible)) {
      button.disabled = true;
      delete button.dataset.slot;
    }
    grid.append(button);
  }
  return grid;
}

/** Settings: each slider changes one preference as it moves. */
const SETTINGS = [
  { key: "musicVolume", label: "music", min: 0, max: 1, step: 0.05, fallback: 0.7 },
  { key: "soundVolume", label: "sound", min: 0, max: 1, step: 0.05, fallback: 1 },
  { key: "textSpeed", label: "textSpeed", min: 10, max: 120, step: 5, fallback: TEXT_SPEED },
  { key: "autoWait", label: "autoWait", min: 0.4, max: 4, step: 0.1, fallback: AUTO_WAIT },
];

function settingsForm(preferences) {
  const form = document.createElement("div");
  form.className = "vn-settings";
  for (const setting of SETTINGS) {
    const row = document.createElement("label");
    const name = document.createElement("span");
    name.textContent = LABELS[setting.label];
    const input = document.createElement("input");
    input.type = "range";
    input.name = setting.key;
    input.min = String(setting.min);
    input.max = String(setting.max);
    input.step = String(setting.step);
    const value = typeof preferences[setting.key] === "number" ? preferences[setting.key] : setting.fallback;
    input.value = String(value);
    const shown = document.createElement("output");
    shown.textContent = formatSetting(setting.key, value);
    row.append(name, input, shown);
    form.append(row);
  }
  return form;
}

function formatSetting(key, value) {
  if (key === "musicVolume" || key === "soundVolume") return Math.round(value * 100) + "%";
  if (key === "autoWait") return value.toFixed(1) + "s";
  return String(value);
}

/** The player's elements, added to the Scene's stage after its background. */
function buildInterface(stage) {
  const element = (tag, className, parent) => {
    const created = document.createElement(tag);
    if (className) created.className = className;
    parent?.append(created);
    return created;
  };
  let backdrop = stage.querySelector('[data-media="backdrop"]');
  if (!backdrop) {
    backdrop = element("div", "backdrop");
    stage.prepend(backdrop);
  }
  const sprites = element("div", "vn-sprites", stage);
  const choices = element("div", "choices", stage);
  choices.hidden = true;
  const box = element("div", "vn-box", stage);
  box.hidden = true;
  const name = element("p", "vn-name", box);
  const text = element("p", "vn-text", box);
  const next = element("span", "vn-next", box);
  next.textContent = "▼";
  next.hidden = true;
  const menu = element("nav", "vn-menu", stage);
  const buttons = {};
  for (const action of ["save", "load", "auto", "skip", "log", "settings", "title"]) {
    const button = element("button", "", menu);
    button.type = "button";
    button.dataset.action = action;
    button.textContent = LABELS[action];
    buttons[action] = button;
  }
  const panel = element("section", "vn-panel", stage);
  panel.hidden = true;
  const panelTitle = element("h2", "", panel);
  const panelBody = element("div", "vn-panel-body", panel);
  const close = element("button", "action", panel);
  close.type = "button";
  close.textContent = LABELS.close;
  return { backdrop, sprites, choices, box, name, text, next, buttons, panel, panelTitle, panelBody, close };
}
`,
};

/** A Visual Novel Scene's own files, keyed by file name inside `nodes/<id>/`. */
export function visualNovelSource(_title: string, id?: string): {
  html: string;
  css: string;
  javascript: string;
  files: Record<string, string>;
} {
  return {
    html: [
      '<main class="vn has-backdrop">',
      '  <div class="backdrop is-room" data-media="backdrop"></div>',
      "</main>",
      "",
    ].join("\n"),
    css: '@import "../../shared/style/components.css";\n@import "../../shared/vn/player.css";\n',
    javascript: [
      'import { playScript } from "../../shared/vn/player.js";',
      'import script from "./script.txt";',
      "",
      "export function mount(context) {",
      ...(id
        ? [`  return playScript(context, script, { source: ${JSON.stringify(`nodes/${id}/script.txt`)} });`]
        : ["  return playScript(context, script);"]),
      "}",
      "",
    ].join("\n"),
    files: {
      "script.txt": [
        "# One step per line. shared/vn/player.js lists every command.",
        "@show stranger center",
        "The rain had not stopped since noon.",
        "stranger: You came alone. That was brave.",
        "stranger: Or foolish. We will find out which.",
        "? I had no choice. -> option-a",
        "? Who else would come? -> option-b",
        "",
      ].join("\n"),
    },
  };
}
