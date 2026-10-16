/**
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
 *   @music <asset>         loop music for this Scene; @music stop ends it
 *   @sfx <asset>           play a sound once
 *   @set <key> = <value>   also += and -=; <key> is a Variable
 *   who: words             a line of dialogue; <who> is a character ID or any name
 *   words                  narration; start with \ to keep a leading "name:"
 *   ? words -> <exit>      an answer; consecutive answers are asked together
 *   ? [trust >= 3] words -> <exit> {trust += 1}
 *   -> <exit>              leave the Scene; -> [key] <exit> only when key holds
 *
 * A condition is "<key> <op> <value>" with ==, !=, >, >=, <, or <=, or a
 * bare key that must be truthy, or !key. A value is a number, true, false,
 * null, or "quoted text". Each <exit> is one of the Scene's Signals.
 *
 * Variables set by the script are kept while the Scene plays and saved when
 * the Scene is left, so a Scene picked up from a save plays again from its
 * first line with the Variables it started with. Music stops when the Scene
 * ends.
 */
import { showBackdrop } from "../style/components.js";
import characters from "./characters.json";

/** Words on the player's controls. */
const LABELS = { auto: "Auto", skip: "Skip", log: "Log", close: "Close" };
/** Characters per second while a line types out. */
const TEXT_SPEED = 40;
/** How long Auto waits after a line, plus a little per character, in milliseconds. */
const AUTO_DELAY = 1200;
const AUTO_DELAY_PER_CHARACTER = 45;
/** How quickly Skip moves through lines, in milliseconds. */
const SKIP_DELAY = 70;
const MUSIC_VOLUME = 0.6;

const POSITIONS = ["left", "center", "right"];
const NAME = "[A-Za-z0-9][A-Za-z0-9._-]*";
const CONDITION = "(?:\\[([^\\]]+)\\]\\s*)?";

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
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const number = index + 1;
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;
    const fail = (message) => {
      throw new Error("script.txt line " + number + ": " + message);
    };
    const step = readLine(line, fail);
    step.line = number;
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
  if (line.startsWith("\\")) return { kind: "say", text: line.slice(1).trim() };
  if (line.startsWith("@")) return readCommand(line, fail);
  if (line.startsWith("?")) {
    const match = new RegExp("^\\?\\s*" + CONDITION + "(.+?)\\s*->\\s*(" + NAME + ")\\s*(?:\\{([^}]*)\\})?$").exec(line);
    if (!match) fail("an answer is written \"? words -> exit\".");
    return {
      kind: "answer",
      when: match[1] ? readCondition(match[1], fail) : undefined,
      text: match[2],
      signal: match[3],
      effects: match[4] ? match[4].split(";").map((effect) => effect.trim()).filter(Boolean).map((effect) => readEffect(effect, fail)) : [],
    };
  }
  if (line.startsWith("->")) {
    const match = new RegExp("^->\\s*" + CONDITION + "(" + NAME + ")$").exec(line);
    if (!match) fail("an exit is written \"-> exit\".");
    return { kind: "exit", when: match[1] ? readCondition(match[1], fail) : undefined, signal: match[2] };
  }
  const spoken = /^([^\s:：]{1,24})\s*[:：]\s*(.+)$/.exec(line);
  if (spoken) return { kind: "say", who: spoken[1], text: spoken[2] };
  return { kind: "say", text: line };
}

function readCommand(line, fail) {
  const [command, ...words] = line.slice(1).split(/\s+/);
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
  const match = new RegExp("^(" + NAME + ")\\s*(\\+=|-=|=)\\s*(.+)$").exec(text.trim());
  if (!match) fail("a change is written \"key = value\", \"key += 1\", or \"key -= 1\".");
  const value = readValue(match[3], fail);
  if (match[2] !== "=" && typeof value !== "number") fail(match[2] + " needs a number.");
  return { key: match[1], op: match[2], value };
}

function readCondition(text, fail) {
  const trimmed = text.trim();
  const bare = new RegExp("^(!?)(" + NAME + ")$").exec(trimmed);
  if (bare) return { key: bare[2], op: bare[1] ? "falsy" : "truthy" };
  const match = new RegExp("^(" + NAME + ")\\s*(==|!=|>=|<=|>|<)\\s*(.+)$").exec(trimmed);
  if (!match) fail("a condition is written [key >= 3], [key], or [!key].");
  return { key: match[1], op: match[2], value: readValue(match[3], fail) };
}

function readValue(text, fail) {
  const value = text.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) return JSON.parse(value);
  fail("\"" + value + "\" is not a number, true, false, null, or \"quoted text\".");
}

/**
 * Plays a script over the Scene's background. Call it from mount() and
 * return what it returns.
 *
 * @param {object} context the Node context passed to mount
 * @param {string} script the Scene's script.txt
 * @returns {() => void} cleanup
 */
export function playScript(context, script) {
  const steps = parseScript(script);
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
  let music;
  let index = 0;
  let typing;
  let waiting = false;
  let leaving = false;
  let mode;
  let timer;

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

  const playMusic = (asset) => {
    music?.pause();
    music = undefined;
    if (!asset) return;
    music = new Audio(context.assets.url(asset));
    music.loop = true;
    music.volume = MUSIC_VOLUME;
    // Sound may only start after the player's first click.
    music.play().catch(() => stage.addEventListener("pointerdown", () => music?.play().catch(() => {}), { once: true }));
  };

  const say = (step) => {
    const who = step.who ? characters[step.who] : undefined;
    const name = step.who ? who?.name ?? step.who : "";
    ui.box.hidden = false;
    ui.name.textContent = name;
    const color = who?.color ?? "";
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
      if (mode === "auto") timer = setTimeout(advance, AUTO_DELAY + AUTO_DELAY_PER_CHARACTER * glyphs.length);
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
      }, 1000 / TEXT_SPEED),
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
      switch (step.kind) {
        case "bg": setBackground(step); break;
        case "show": show(step); break;
        case "hide":
          sprites.get(step.who)?.remove();
          sprites.delete(step.who);
          break;
        case "music": playMusic(step.asset); break;
        case "sfx": void new Audio(context.assets.url(step.asset)).play().catch(() => {}); break;
        case "set": apply(step); break;
        case "say": return say(step);
        case "choice": return ask(step);
        case "exit":
          if (holds(step.when)) return void leave(step.signal);
          break;
      }
    }
    // The end of a script with no exit: the last line stays.
    setMode(undefined);
  };

  const advance = () => {
    clearTimeout(timer);
    if (leaving || !ui.log.hidden || !ui.choices.hidden) return;
    if (typing) return typing.finish();
    if (waiting) run();
  };

  const setMode = (next) => {
    mode = next;
    clearTimeout(timer);
    ui.auto.setAttribute("aria-pressed", String(mode === "auto"));
    ui.skip.setAttribute("aria-pressed", String(mode === "skip"));
    if (mode && waiting) timer = setTimeout(advance, mode === "skip" ? SKIP_DELAY : AUTO_DELAY);
    if (mode === "skip" && typing) typing.finish();
  };

  const openLog = () => {
    setMode(undefined);
    ui.logLines.replaceChildren(...log.map((entry) => {
      const item = document.createElement("li");
      const name = document.createElement("b");
      name.textContent = entry.name;
      if (entry.color) item.style.setProperty("--vn-speaker", entry.color);
      item.append(name, entry.text);
      return item;
    }));
    ui.log.hidden = false;
    ui.logLines.scrollTop = ui.logLines.scrollHeight;
  };
  const closeLog = () => {
    ui.log.hidden = true;
  };

  const onClick = (event) => {
    const target = event.target;
    const button = target.closest?.("button");
    if (button === ui.auto) return setMode(mode === "auto" ? undefined : "auto");
    if (button === ui.skip) return setMode(mode === "skip" ? undefined : "skip");
    if (button === ui.logButton) return openLog();
    if (button === ui.close) return closeLog();
    if (button && ui.choices.contains(button)) return choose(button);
    if (!ui.log.hidden || !ui.choices.hidden) return;
    // A click while Auto or Skip runs hands control back to the player.
    if (mode) return setMode(undefined);
    advance();
  };
  const onKey = (event) => {
    if (event.key === "Escape" && !ui.log.hidden) return closeLog();
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
    if (event.deltaY < 0 && ui.log.hidden) openLog();
  };

  stage.addEventListener("click", onClick);
  stage.addEventListener("wheel", onWheel, { passive: true });
  window.addEventListener("keydown", onKey);
  run();

  return () => {
    clearInterval(typing?.interval);
    clearTimeout(timer);
    music?.pause();
    backdrop.cleanup();
    stage.removeEventListener("click", onClick);
    stage.removeEventListener("wheel", onWheel);
    window.removeEventListener("keydown", onKey);
  };

  function character(id, line) {
    const found = characters[id];
    if (!found) throw new Error("script.txt line " + line + ": \"" + id + "\" is not in shared/vn/characters.json.");
    return found;
  }

  function lookAsset(id, look, line) {
    const looks = character(id, line).looks ?? {};
    const names = Object.keys(looks);
    if (!names.length) return undefined;
    const name = look ?? ("default" in looks ? "default" : names[0]);
    const asset = looks[name];
    if (!asset) throw new Error("script.txt line " + line + ": " + id + " has no look \"" + name + "\" in shared/vn/characters.json.");
    context.assets.url(asset);
    return asset;
  }
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
  const button = (label) => {
    const created = element("button", "", menu);
    created.type = "button";
    created.textContent = label;
    return created;
  };
  const auto = button(LABELS.auto);
  const skip = button(LABELS.skip);
  const logButton = button(LABELS.log);
  const log = element("div", "vn-log", stage);
  log.hidden = true;
  const logLines = element("ol", "", log);
  const close = element("button", "action", log);
  close.type = "button";
  close.textContent = LABELS.close;
  return { backdrop, sprites, choices, box, name, text, next, auto, skip, logButton, log, logLines, close };
}
