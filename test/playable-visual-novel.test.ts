// @vitest-environment happy-dom
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addPlayableNode } from "../src/daemon/playable-add-node.js";
import { createHash } from "node:crypto";
import { createNodeCodebase, openNodeCodebaseDetail, readNodeCodebase } from "../src/daemon/playable-codebase.js";
import { validatePlayableProject } from "../src/daemon/playable-project.js";
import { PLAYABLE_PROJECT_STYLE_FILES } from "../src/daemon/playable-style.js";
import { VISUAL_NOVEL_PLAYER_UPGRADES, VISUAL_NOVEL_SHARED_FILES } from "../src/daemon/playable-visual-novel.js";
import { createStarterCodebaseWithScene } from "./playable-fixture.js";

interface Step {
  kind: string;
  [key: string]: unknown;
}

interface Player {
  parseScript(text: string): Step[];
  playScript(context: unknown, script: string): () => void;
}

const DEFAULT_CHARACTERS = {
  mio: { name: "Mio", color: "#f3a5b9", looks: { default: "mio", smile: "mio-smile" } },
  stranger: { name: "Stranger", looks: {} },
};

/** The shared player as a project bundles it, with the given characters.json. */
async function loadPlayer(characters: object = DEFAULT_CHARACTERS): Promise<Player> {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-vn-player-"));
  try {
    const files = {
      ...PLAYABLE_PROJECT_STYLE_FILES,
      ...VISUAL_NOVEL_SHARED_FILES,
      "shared/vn/characters.json": JSON.stringify(characters),
    };
    for (const [relative, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
      await writeFile(path.join(directory, relative), content);
    }
    const bundled = await build({
      entryPoints: [path.join(directory, "shared/vn/player.js")],
      bundle: true,
      format: "iife",
      globalName: "player",
      write: false,
    });
    // Evaluated here rather than imported, so it runs against this test's DOM.
    return new Function(`${bundled.outputFiles[0]!.text}\nreturn player;`)() as Player;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("Visual Novel script", () => {
  it("reads commands, lines, answers, and exits", async () => {
    const { parseScript } = await loadPlayer();
    const steps = parseScript([
      "# a note",
      "@bg street video",
      "@show mio smile left",
      "@music rain",
      "@set trust += 1",
      "The rain had not stopped.",
      "mio：你来了。",
      "\\Note: not a name",
      "-> [trust >= 5] secret",
      "? Stay -> stay {trust += 1; metMio = true}",
      "",
      '? [!metMio] Leave -> leave',
    ].join("\n"));
    expect(steps).toEqual([
      { kind: "bg", asset: "street", video: true, line: 2 },
      { kind: "show", who: "mio", look: "smile", at: "left", line: 3 },
      { kind: "music", asset: "rain", line: 4 },
      { kind: "set", key: "trust", op: "+=", value: 1, line: 5 },
      { kind: "say", text: "The rain had not stopped.", line: 6 },
      { kind: "say", who: "mio", text: "你来了。", line: 7 },
      { kind: "say", text: "Note: not a name", line: 8 },
      { kind: "exit", when: { key: "trust", op: ">=", value: 5 }, signal: "secret", line: 9 },
      {
        kind: "choice",
        line: 10,
        answers: [
          {
            kind: "answer",
            when: undefined,
            text: "Stay",
            signal: "stay",
            effects: [{ key: "trust", op: "+=", value: 1 }, { key: "metMio", op: "=", value: true }],
            line: 10,
          },
          { kind: "answer", when: { key: "metMio", op: "falsy" }, text: "Leave", signal: "leave", effects: [], line: 12 },
        ],
      },
    ]);
  });

  it("names the line of the first mistake", async () => {
    const { parseScript } = await loadPlayer();
    expect(() => parseScript("Hello\n@dance mio")).toThrow("script.txt line 2: unknown command @dance");
    expect(() => parseScript("? Stay -> stay\nAfter")).toThrow("script.txt line 2: nothing runs after the answers above");
    expect(() => parseScript("-> out\n? Stay -> stay")).toThrow("script.txt line 2: nothing runs after -> out");
    expect(() => parseScript("? Stay")).toThrow("script.txt line 1: an answer is written");
    expect(() => parseScript("@set name += \"x\"")).toThrow("+= needs a number");
    expect(() => parseScript("@show mio smile left right")).toThrow("write @show");
  });
});

describe("playScript", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  /** Mounts a Scene playing `script` with a fake Node context. */
  async function play(script: string, options: {
    state?: Record<string, unknown>;
    assets?: string[];
    connected?: string[];
    characters?: object;
    position?: unknown;
    slots?: { id: string; savedAt: string; nodeId: string; note?: string; incompatible?: true }[];
  } = {}) {
    const { playScript } = await loadPlayer(options.characters);
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = '<main class="vn has-backdrop"><div class="backdrop" data-media="backdrop"></div></main>';
    const state = { ...options.state };
    const assets = new Set(options.assets ?? []);
    const connected = new Set(options.connected ?? ["option-a", "option-b"]);
    const emitted: string[] = [];
    const patches: Record<string, unknown>[] = [];
    const positions: unknown[] = [];
    const audio: string[] = [];
    const session: string[] = [];
    const preferences: Record<string, unknown> = { musicVolume: 0.7, soundVolume: 1 };
    const context = {
      position: {
        get: () => options.position ?? null,
        set: async (value: unknown) => { positions.push(value); },
      },
      audio: {
        music: (id: string | null) => {
          if (id !== null && !assets.has(id)) throw new Error(`Asset "${id}" is not declared for this Playable surface.`);
          audio.push(`music:${id}`);
        },
        sound: (id: string) => { audio.push(`sound:${id}`); },
      },
      preferences: {
        get: () => ({ ...preferences }),
        set: async (values: Record<string, unknown>) => { Object.assign(preferences, values); },
      },
      session: {
        slots: () => options.slots ?? [],
        saveSlot: async (id: string, note?: string) => { session.push(`save:${id}:${note}`); },
        loadSlot: async (id: string) => { session.push(`load:${id}`); },
      },
      root,
      assets: {
        url: (id: string) => {
          if (!assets.has(id)) throw new Error(`Asset "${id}" is not declared for this Playable surface.`);
          return `blob:${id}`;
        },
      },
      state: {
        get: (key: string) => {
          if (!(key in state)) throw new Error(`Project State key "${key}" is not declared in initialState.`);
          return state[key];
        },
        patch: async (values: Record<string, unknown>) => {
          patches.push(values);
          Object.assign(state, values);
        },
      },
      navigation: {
        emit: async (signal: string) => { emitted.push(signal); },
        connected: (signal: string) => connected.has(signal),
      },
    };
    const cleanup = playScript(context, script);
    const stage = root.querySelector<HTMLElement>(".vn")!;
    const click = (target: Element = stage) => target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const text = () => root.querySelector(".vn-text")!.textContent;
    const name = () => root.querySelector(".vn-name")!.textContent;
    const answers = () => [...root.querySelectorAll<HTMLButtonElement>(".choices .option")];
    const menu = (action: string) => root.querySelector<HTMLButtonElement>(`.vn-menu [data-action="${action}"]`)!;
    return { root, stage, click, text, name, answers, menu, emitted, patches, positions, audio, session, preferences, cleanup, state };
  }

  it("types a line, completes it on a click, and moves on with the next", async () => {
    const scene = await play("stranger: You came alone.\nThe rain went on.");
    expect(scene.name()).toBe("Stranger");
    expect(scene.text()).not.toBe("You came alone.");
    scene.click();
    expect(scene.text()).toBe("You came alone.");
    scene.click();
    expect(scene.name()).toBe("");
    vi.runAllTimers();
    expect(scene.text()).toBe("The rain went on.");
    // A character with no looks stands in as a placeholder figure.
    scene.cleanup();
  });

  it("asks only the answers whose conditions hold and leaves with the chosen one's changes saved", async () => {
    const scene = await play([
      "@set trust += 1",
      "mio: Well?",
      "? [trust >= 2] Trust her -> option-a {trust += 1}",
      "? Walk away -> option-b {trust -= 1}",
      "? Not yet built -> later",
    ].join("\n"), { state: { trust: 0 }, assets: ["mio", "mio-smile"] });
    vi.runAllTimers();
    scene.click();
    const answers = scene.answers();
    expect(answers.map((answer) => answer.textContent)).toEqual(["1Walk away", "2Not yet built"]);
    // An answer whose Exit is not connected yet shows disabled and does nothing.
    expect(answers[1]!.getAttribute("aria-disabled")).toBe("true");
    scene.click(answers[1]!);
    expect(scene.emitted).toEqual([]);
    scene.click(answers[0]!);
    await vi.runAllTimersAsync();
    expect(scene.patches).toEqual([{ trust: 0 }]);
    expect(scene.emitted).toEqual(["option-b"]);
  });

  it("takes a conditional exit only when it holds", async () => {
    const scene = await play("-> [met] option-a\nmio: First time?\n-> option-b", {
      state: { met: false },
      assets: ["mio"],
    });
    expect(scene.name()).toBe("Mio");
    vi.runAllTimers();
    scene.click();
    await vi.runAllTimersAsync();
    expect(scene.emitted).toEqual(["option-b"]);
    expect(scene.patches).toEqual([]);
  });

  it("shows a character's look and switches it in place", async () => {
    const scene = await play("@show mio left\nmio: Hi.\n@show mio smile\nmio: There.", { assets: ["mio", "mio-smile"] });
    const sprite = () => scene.root.querySelector<HTMLElement>(".vn-sprite")!;
    expect(sprite().classList.contains("is-left")).toBe(true);
    expect(sprite().querySelector("img")!.getAttribute("src")).toBe("blob:mio");
    expect(sprite().classList.contains("is-speaking")).toBe(true);
    vi.runAllTimers();
    scene.click();
    vi.runAllTimers();
    expect(scene.root.querySelectorAll(".vn-sprite")).toHaveLength(1);
    expect(sprite().classList.contains("is-left")).toBe(true);
    expect(sprite().querySelector("img")!.getAttribute("src")).toBe("blob:mio-smile");
  });

  it("skips to the answers and keeps the lines in the log", async () => {
    const scene = await play("One.\nTwo.\nThree.\n? Go -> option-a", {});
    scene.click(scene.menu("skip"));
    vi.runAllTimers();
    expect(scene.answers()).toHaveLength(1);
    expect(scene.menu("skip").getAttribute("aria-pressed")).toBe("false");
    scene.click(scene.menu("log"));
    expect([...scene.root.querySelectorAll(".vn-log li")].map((item) => item.textContent)).toEqual(["One.", "Two.", "Three."]);
    // While a panel is open, a click does not move the story on.
    scene.click();
    expect(scene.root.querySelector(".vn-panel")!.hasAttribute("hidden")).toBe(false);
  });

  it("saves its place at every line and answers", async () => {
    const scene = await play("One.\n@set trust += 1\nTwo.\n? Go -> option-a", { state: { trust: 0 } });
    vi.runAllTimers();
    scene.click();
    vi.runAllTimers();
    scene.click();
    const version = (scene.positions[0] as { script: string }).script;
    expect(scene.positions).toEqual([{ script: version, step: 0 }, { script: version, step: 2 }, { script: version, step: 3 }]);
  });

  it("picks up at the saved line with the scene, Variables, and log as they were, without replaying sounds", async () => {
    const script = [
      "@bg street",
      "@show mio smile left",
      "@music rain",
      "@sfx door",
      "mio: First.",
      "@set trust += 2",
      "@hide mio",
      "Second.",
      "? [trust >= 2] Trust -> option-a",
      "? Leave -> option-b",
    ].join("\n");
    const assets = ["street", "mio", "mio-smile", "rain", "door"];
    const first = await play(script, { state: { trust: 0 }, assets });
    const version = (first.positions[0] as { script: string }).script;
    first.cleanup();
    document.body.replaceChildren();

    const scene = await play(script, { state: { trust: 0 }, assets, position: { script: version, step: 8 } });
    expect(scene.answers().map((answer) => answer.textContent)).toEqual(["1Trust", "2Leave"]);
    expect(scene.root.querySelector(".backdrop img")!.getAttribute("src")).toBe("blob:street");
    expect(scene.root.querySelectorAll(".vn-sprite")).toHaveLength(0);
    expect(scene.audio).toEqual(["music:rain"]);
    scene.click(scene.menu("log"));
    expect([...scene.root.querySelectorAll(".vn-log li")].map((item) => item.textContent)).toEqual(["MioFirst.", "Second."]);
    scene.click(scene.root.querySelector(".vn-panel .action")!);
    scene.click(scene.answers()[0]!);
    await vi.runAllTimersAsync();
    expect(scene.patches).toEqual([{ trust: 2 }]);
  });

  it("starts over when the script changed since the save", async () => {
    const scene = await play("One.\nTwo.", { position: { script: "older", step: 1 } });
    vi.runAllTimers();
    expect(scene.text()).toBe("One.");
  });

  it("saves to a slot with the current line and loads a slot that holds a game", async () => {
    const scene = await play("mio: You came alone.", {
      assets: ["mio", "mio-smile"],
      slots: [
        { id: "1", savedAt: "2026-10-16T00:00:00.000Z", nodeId: "chapter", note: "Earlier" },
        { id: "2", savedAt: "2026-10-16T00:00:00.000Z", nodeId: "chapter", incompatible: true },
      ],
    });
    vi.runAllTimers();
    scene.click(scene.menu("save"));
    const slots = () => [...scene.root.querySelectorAll<HTMLButtonElement>(".vn-slot")];
    expect(slots()).toHaveLength(12);
    expect(slots()[0]!.textContent).toContain("Earlier");
    scene.click(slots()[2]!);
    await vi.runAllTimersAsync();
    expect(scene.session).toEqual(["save:3:Mio: You came alone."]);
    scene.click(scene.root.querySelector(".vn-panel .action")!);

    scene.click(scene.menu("load"));
    expect(slots().map((slot) => slot.disabled).slice(0, 3)).toEqual([false, true, true]);
    scene.click(slots()[0]!);
    await vi.runAllTimersAsync();
    expect(scene.session.at(-1)).toBe("load:1");
  });

  it("changes a setting as its slider moves and types at the chosen speed", async () => {
    const scene = await play("Hello there.");
    scene.click(scene.menu("settings"));
    const speed = scene.root.querySelector<HTMLInputElement>('.vn-settings input[name="textSpeed"]')!;
    speed.value = "120";
    speed.dispatchEvent(new Event("input", { bubbles: true }));
    expect(scene.preferences.textSpeed).toBe(120);
    expect(speed.nextElementSibling!.textContent).toBe("120");
  });

  it("leaves by Title only once its Exit is connected", async () => {
    const unconnected = await play("Hello.");
    expect(unconnected.menu("title").getAttribute("aria-disabled")).toBe("true");
    unconnected.click(unconnected.menu("title"));
    expect(unconnected.emitted).toEqual([]);
    unconnected.cleanup();

    const scene = await play("@set trust += 1\nHello.", { connected: ["title"], state: { trust: 0 } });
    scene.click(scene.menu("title"));
    await vi.runAllTimersAsync();
    expect(scene.emitted).toEqual(["title"]);
    // Leaving keeps what the Scene changed, as any exit does.
    expect(scene.patches).toEqual([{ trust: 1 }]);
  });

  it("stops at mount on an undeclared Asset, Variable, or character", async () => {
    await expect(play("@bg street")).rejects.toThrow('Asset "street" is not declared');
    await expect(play("@music rain")).rejects.toThrow('Asset "rain" is not declared');
    await expect(play("@set trust += 1")).rejects.toThrow('Project State key "trust"');
    await expect(play("@show ghost")).rejects.toThrow('script.txt line 1: "ghost" is not in shared/vn/characters.json');
    await expect(play("@show mio angry", { assets: ["mio"] })).rejects.toThrow('mio has no look "angry"');
  });
});

describe("Visual Novel Template", () => {
  it("adds the script and the shared player, keeps an edited player, and compiles", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "ohmygame-vn-template-"));
    await createNodeCodebase(workspacePath, createStarterCodebaseWithScene("Novel", { width: 1280, height: 720 }));

    const result = await addPlayableNode(workspacePath, { preset: "visual-novel", id: "chapter-1" });
    expect(result.files).toContain("nodes/chapter-1/script.txt");
    expect(result.signals).toEqual(["option-a", "option-b", "title"]);
    for (const [relative, content] of Object.entries(VISUAL_NOVEL_SHARED_FILES)) {
      expect(await readFile(path.join(workspacePath, relative), "utf8")).toBe(content);
    }
    expect((await validatePlayableProject(workspacePath, "draft")).issues).toEqual([]);

    // The author's changes to the shared player stay when another Scene is added.
    await writeFile(path.join(workspacePath, "shared/vn/player.css"), "/* mine */\n");
    await addPlayableNode(workspacePath, { preset: "visual-novel", id: "chapter-2" });
    expect(await readFile(path.join(workspacePath, "shared/vn/player.css"), "utf8")).toBe("/* mine */\n");
    expect(await readFile(path.join(workspacePath, "nodes/chapter-2/script.txt"), "utf8")).toContain("? I had no choice.");
    expect((await readNodeCodebase(workspacePath)).graph.nodes.map((node) => node.id)).toEqual(["start", "chapter-1", "chapter-2"]);
  });

  it("brings a player the author never changed up to date when the project opens, and leaves a changed one alone", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "ohmygame-vn-upgrade-"));
    await createNodeCodebase(workspacePath, createStarterCodebaseWithScene("Novel", { width: 1280, height: 720 }));
    await addPlayableNode(workspacePath, { preset: "visual-novel", id: "chapter-1" });
    const earlier = path.join(import.meta.dirname, "fixtures/visual-novel-player-v1");
    await writeFile(path.join(workspacePath, "shared/vn/player.js"), await readFile(path.join(earlier, "player.js")));
    await writeFile(path.join(workspacePath, "shared/vn/player.css"), `${await readFile(path.join(earlier, "player.css"), "utf8")}/* mine */\n`);
    await writeFile(path.join(workspacePath, "shared/vn/characters.json"), "{}\n");

    await openNodeCodebaseDetail(workspacePath);
    expect(await readFile(path.join(workspacePath, "shared/vn/player.js"), "utf8")).toBe(VISUAL_NOVEL_SHARED_FILES["shared/vn/player.js"]);
    expect(await readFile(path.join(workspacePath, "shared/vn/player.css"), "utf8")).toContain("/* mine */");
    expect(await readFile(path.join(workspacePath, "shared/vn/characters.json"), "utf8")).toBe("{}\n");
  });

  it("records the player that ships now, so changing it keeps earlier copies upgradable", () => {
    const shipped = Object.fromEntries(Object.keys(VISUAL_NOVEL_PLAYER_UPGRADES).map((relative) => [
      relative,
      createHash("sha256").update(VISUAL_NOVEL_SHARED_FILES[relative]!).digest("hex"),
    ]));
    // When this fails because a player file changed, add the old hash below to
    // VISUAL_NOVEL_PLAYER_UPGRADES, then record the new one here.
    expect(shipped).toEqual({
      "shared/vn/player.js": "d164b05a476d8177749d6988b41789a487a889912a8d8cf8f036f059efaf0133",
      "shared/vn/player.css": "aeffa88b0e3f5880af7a118d8f0657d150ce5ebdb95c347140152ff9974ef0ea",
    });
    for (const [relative, hash] of Object.entries(shipped)) expect(VISUAL_NOVEL_PLAYER_UPGRADES[relative]).not.toContain(hash);
  });
});
