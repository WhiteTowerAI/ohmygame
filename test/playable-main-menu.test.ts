import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLAYABLE_PROJECT_STYLE_FILES, playablePreset } from "../src/daemon/playable-presets.js";
import type {
  NodeGraph,
  PlayableNode,
  PlayableNodeContext,
} from "../src/shared/playable-nodes.js";
import {
  MemoryPlayablePreferencesStore,
  MemoryPlayableSaveStore,
  NodeRuntime,
} from "../src/shared/playable-runtime.js";

const preset = playablePreset("main-menu")!;
const source = preset.source("Ash Club", "ash-club");

it("names the menu's right-hand placement without changing left-aligned stages", () => {
  expect(source.html).toContain('class="stage is-right has-backdrop"');
  expect(source.css).toContain(".stage.is-right");
  expect(source.css).not.toContain(".stage.is-left");
});

/** The Main menu's node.js, beside the Project Style module it imports. */
async function loadMainMenuModule(): Promise<{
  mount: (context: PlayableNodeContext) => () => void;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-menu-module-"));
  try {
    await mkdir(path.join(directory, "nodes/menu"), { recursive: true });
    await mkdir(path.join(directory, "shared/style"), { recursive: true });
    await writeFile(
      path.join(directory, "package.json"),
      '{ "type": "module" }',
    );
    await writeFile(
      path.join(directory, "shared/style/components.js"),
      PLAYABLE_PROJECT_STYLE_FILES["shared/style/components.js"]!,
    );
    const file = path.join(directory, "nodes/menu/node.js");
    await writeFile(file, source.javascript);
    return await import(pathToFileURL(file).href);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function scene(id: string, signals: PlayableNode["signals"]): PlayableNode {
  return {
    id,
    title: id,
    source: {
      html: `nodes/${id}/index.html`,
      css: `nodes/${id}/style.css`,
      javascript: `nodes/${id}/node.js`,
    },
    assets: [],
    signals,
  };
}

/** A game of the Main menu and one chapter with a Home Exit back to it, the menu mounted from the Template's HTML. */
async function startGame() {
  const { mount } = await loadMainMenuModule();
  const graph: NodeGraph = {
    version: 1,
    title: "Ash Club",
    viewport: { width: 1280, height: 720 },
    entryNodeId: "menu",
    initialState: { trust: 0 },
    assets: {},
    nodes: [
      scene("menu", preset.signals),
      scene("chapter", [{ id: "home", label: "Home", role: "navigation" }]),
    ],
    edges: [
      {
        id: "menu-start",
        source: { nodeId: "menu", signal: "start" },
        targetNodeId: "chapter",
        mode: "replace",
      },
      {
        id: "chapter-home",
        source: { nodeId: "chapter", signal: "home" },
        targetNodeId: "menu",
        mode: "replace",
      },
    ],
  };
  const preferences = new MemoryPlayablePreferencesStore();
  let menu: ShadowRoot | undefined;
  let chapter: Omit<PlayableNodeContext, "root"> | undefined;
  const runtime = new NodeRuntime({
    graph,
    graphSignature: "menu-v1",
    surfaceHost: {
      async mountNode(surface, context) {
        if (surface.id !== "menu") {
          chapter = context;
          menu = undefined;
          return { destroy() {} };
        }
        const host = document.createElement("div");
        document.body.append(host);
        const root = host.attachShadow({ mode: "open" });
        root.innerHTML = source.html;
        menu = root;
        const cleanup = mount({ ...context, root });
        return { cleanup, destroy: () => host.remove() };
      },
    },
    saveStore: new MemoryPlayableSaveStore(),
    preferencesStore: preferences,
    assetUrls: {},
  });
  await runtime.start();
  const button = (selector: string) =>
    menu!.querySelector<HTMLButtonElement>(selector)!;
  return {
    runtime,
    preferences,
    menu: () => menu!,
    chapter: () => chapter!,
    button,
  };
}

// The menu's module runs as Node code, so the page it expects is set up around it.
let page: Window;
beforeEach(() => {
  page = new Window();
  Object.assign(globalThis, { document: page.document });
});
afterEach(async () => {
  Reflect.deleteProperty(globalThis, "document");
  await page.happyDOM.close();
});

describe("Main menu Template", () => {
  it("starts a new game with the starting Variables after the player goes Home", async () => {
    const { runtime, chapter, button } = await startGame();

    button('[data-signal="start"]').click();
    await expect.poll(() => runtime.snapshot().currentNodeId).toBe("chapter");
    await chapter().state.set("trust", 3);
    await chapter().navigation.emit("home");
    expect(runtime.snapshot()).toMatchObject({
      currentNodeId: "menu",
      state: { trust: 3 },
    });
    button('[data-signal="start"]').click();

    await expect
      .poll(() => runtime.snapshot())
      .toMatchObject({ currentNodeId: "chapter", state: { trust: 0 } });
  });

  it("offers Load once a slot holds a game, and continues the game picked", async () => {
    const { runtime, menu, chapter, button } = await startGame();
    expect(button('[data-open="load"]').getAttribute("aria-disabled")).toBe(
      "true",
    );

    button('[data-signal="start"]').click();
    await expect.poll(() => runtime.snapshot().currentNodeId).toBe("chapter");
    await chapter().state.set("trust", 2);
    await chapter().session.saveSlot("1", "The rain had not stopped.");
    await chapter().state.set("trust", 5);
    await chapter().navigation.emit("home");

    const load = button('[data-open="load"]');
    expect(load.getAttribute("aria-disabled")).toBeNull();
    expect(load.textContent!.trim()).toBe("Load");
    load.click();
    expect(
      menu().querySelector<HTMLElement>('[data-panel="load"]')!.hidden,
    ).toBe(false);
    expect(
      menu().querySelector<HTMLElement>('[data-panel="settings"]')!.hidden,
    ).toBe(true);
    const slots = [...menu().querySelectorAll<HTMLButtonElement>(".menu-slot")];
    expect(slots.map((slot) => slot.textContent)).toEqual([
      expect.stringMatching(/^01.*The rain had not stopped\.$/),
    ]);
    slots[0]!.click();

    await expect
      .poll(() => runtime.snapshot())
      .toMatchObject({ currentNodeId: "chapter", state: { trust: 2 } });
  });

  it("closes Load with Back or Esc", async () => {
    const { runtime, chapter, menu, button } = await startGame();
    button('[data-signal="start"]').click();
    await expect.poll(() => runtime.snapshot().currentNodeId).toBe("chapter");
    await chapter().session.saveSlot("1");
    await chapter().navigation.emit("home");
    const panel = () =>
      menu().querySelector<HTMLElement>('[data-panel="load"]')!;

    button('[data-open="load"]').click();
    panel().querySelector<HTMLButtonElement>("[data-close]")!.click();
    expect(panel().hidden).toBe(true);
    button('[data-open="load"]').click();
    document.dispatchEvent(
      new page.KeyboardEvent("keydown", { key: "Escape" }) as unknown as Event,
    );
    expect(panel().hidden).toBe(true);
  });

  it("changes the music and sound volumes from Settings", async () => {
    const { preferences, menu, button } = await startGame();

    button('[data-open="settings"]').click();
    expect(
      menu().querySelector<HTMLElement>('[data-panel="settings"]')!.hidden,
    ).toBe(false);
    const music = menu().querySelector<HTMLInputElement>(
      'input[name="musicVolume"]',
    )!;
    const sound = menu().querySelector<HTMLInputElement>(
      'input[name="soundVolume"]',
    )!;
    expect([music.value, music.nextElementSibling!.textContent]).toEqual([
      "0.7",
      "70%",
    ]);
    expect(sound.nextElementSibling!.textContent).toBe("100%");
    music.value = "0.25";
    music.dispatchEvent(new page.Event("input") as unknown as Event);

    expect(music.nextElementSibling!.textContent).toBe("25%");
    await expect.poll(() => preferences.load()).toEqual({ musicVolume: 0.25 });
  });
});
