// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationCapabilities } from "../src/shared/contracts.js";
import type { ProjectPluginChoice } from "../src/shared/plugins.js";

const plugin = (
  name: string,
  displayName: string,
  projectTypes?: ConversationCapabilities["plugins"][number]["projectTypes"],
) => ({
  id: `${name}@bundled`,
  name,
  displayName,
  description: `${displayName} description`,
  marketplaceId: "bundled",
  marketplaceDisplayName: "Bundled",
  ...(projectTypes ? { projectTypes } : {}),
});
let capabilities: ConversationCapabilities;
let projectPlugins: ProjectPluginChoice[];
// Set to hold GET /project-types until a test answers it.
let pendingTypes: Promise<never> | undefined;
let pendingCapabilities: Promise<ConversationCapabilities> | undefined;
let typesFail = 0;
let choicesFail = 0;
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  waitForRuntime: async () => undefined,
  getHomeComposerCapabilities: async () => pendingCapabilities ?? capabilities,
  listModels: async () => ({ models: [] }),
  listProjectPluginChoices: async () => choicesFail-- > 0 ? Promise.reject(new Error("offline")) : projectPlugins,
  listProjectTypes: async () => typesFail-- > 0 ? Promise.reject(new Error("offline")) : pendingTypes ?? [
    { id: "ohmygame/godot:godot-game", title: "Godot game", plugin: { id: "ohmygame/godot", version: "1.0.0" } },
    { id: "acme/tiles:tile-map", title: "Tile Map", plugin: { id: "acme/tiles", version: "2.1.0" } },
  ],
}));
const { ProjectPromptCreator } =
  await import("../src/renderer/project-prompt-creator.js");

let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
const onSubmit = vi.fn();
// Drafts outlive a mounted prompt box, so each test gets its own.
let draftKey = "";
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Blender helps any project but does not start one, so the picker leaves it out.
  capabilities = {
    plugins: [
      plugin("godot", "Godot", ["godot-game", "general"]),
      plugin("blender", "Blender"),
      plugin("web-game-studio", "Web Game Studio", ["web-game"]),
    ],
    skills: [],
  };
  projectPlugins = [
    { id: "ohmygame/godot", displayName: "Godot", description: "Godot games.", version: "1.0.0", capabilities: [], consented: true, providesTypes: ["ohmygame/godot:godot-game"] },
    { id: "acme/tiles", displayName: "Tiles", description: "Tile maps.", version: "2.1.0", capabilities: ["network:tiles.example.com"], consented: false, providesTypes: ["acme/tiles:tile-map"] },
    { id: "acme/sprites", displayName: "Sprites", description: "Sprite sheets.", version: "1.2.0", capabilities: ["network:sprites.example.com"], consented: false, providesTypes: [] },
  ];
  localStorage.clear();
  pendingTypes = undefined;
  pendingCapabilities = undefined;
  typesFail = 0;
  choicesFail = 0;
  window.location.hash = "";
  onSubmit.mockReset();
  draftKey = `test-${crypto.randomUUID()}`;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () =>
    root.render(
      <ProjectPromptCreator
        draftKey={draftKey}
        placeholder="Describe the game"
        onSubmit={onSubmit}
      />,
    ),
  );
}
async function type(value: string) {
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const send = () =>
  act(async () =>
    container
      .querySelector<HTMLButtonElement>('button[type="submit"]')!
      .click(),
  );
const typePicker = () =>
  container.querySelector<HTMLButtonElement>('[aria-label="Project type"]')!;
const pluginButton = () =>
  container.querySelector<HTMLButtonElement>(".home-plugin-trigger")!;
const optionLabel = (option: Element) => option.querySelector(".ui-option-text > span")?.textContent;
const options = () => [...document.querySelectorAll('[role="option"]')].map(optionLabel);
async function chooseType(label: string) {
  await act(async () => typePicker().click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((item) => optionLabel(item) === label)!;
  await act(async () => option.click());
}
const starterItems = () =>
  [...document.querySelectorAll('[role="group"][aria-label="Start with plugins"] [role="menuitemcheckbox"]')]
    .map((item) => item.querySelector(".home-plugin-text > span")?.textContent);
const ideasButton = () =>
  [...container.querySelectorAll<HTMLButtonElement>(".home-starts button")].find((item) => item.textContent === "Ideas")!;
async function chooseIdea(text: string) {
  await act(async () => ideasButton().click());
  const idea = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.includes(text))!;
  await act(async () => idea.click());
}
async function historyKey(key: "ArrowUp" | "ArrowDown") {
  const textarea = container.querySelector("textarea")!;
  const at = key === "ArrowUp" ? 0 : textarea.value.length;
  textarea.setSelectionRange(at, at);
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
}
const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".home-plugin-row")]
    .find((item) => item.querySelector(".home-plugin-text > span")?.textContent === label);

describe("Home prompt box", () => {
  it("starts with the plugin the type names, and changes it with the type", async () => {
    await render();
    expect(typePicker().textContent).toBe("Web Game");
    expect(pluginButton().getAttribute("aria-label")).toBe("Plugins: Web Game Studio");
    // Its ideas sit behind one button in the row of ways to start, and fill the prompt.
    expect(ideasButton()).toBeDefined();
    await chooseIdea("dungeon");
    expect(container.querySelector("textarea")!.value).toBe(
      "Make a pixel-art dungeon roguelike with turn-based combat",
    );

    // Plugins' own types follow the app's; Godot's is the app's Godot type.
    await act(async () => typePicker().click());
    expect(options()).toEqual(["Web Game", "Interactive Story", "Asset Canvas", "Godot", "General Game", "Tile Map", "More types…"]);
    await act(async () => typePicker().click());

    await chooseType("Godot");
    expect(pluginButton().getAttribute("aria-label")).toBe("Plugins: Godot");
    // Only plugins that start this type are offered; Blender starts none.
    await act(async () => pluginButton().click());
    expect(starterItems()).toEqual(["Godot"]);
    await act(async () => pluginButton().click());

    // A type no starter names starts with no plugin, and sends none.
    await chooseType("Tile Map");
    expect(pluginButton().getAttribute("aria-label")).toBe("Plugins");
    await type("Make a map");
    await send();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Make a map", mentions: [], type: "acme/tiles:tile-map" }),
      expect.any(Function),
    );
  });

  it("brings back every starting plugin of a prompt from history", async () => {
    capabilities.plugins.push(plugin("threejs-world", "Three.js World", ["web-game"]));
    const mentions = [capabilities.plugins[2], capabilities.plugins[3]].map((item) => ({ name: item.name, displayName: item.displayName, marketplaceId: item.marketplaceId }));
    localStorage.setItem("ohmygame.home-prompt-history", JSON.stringify([{ prompt: "@Web Game Studio @Three.js World Make an island", mentions }]));
    await render();
    await historyKey("ArrowUp");
    expect(container.querySelector("textarea")!.value).toBe("Make an island");
    expect(pluginButton().getAttribute("aria-label")).toBe("Plugins: Web Game Studio, Three.js World");
    await send();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ prompt: "@Web Game Studio @Three.js World Make an island" }), expect.any(Function));

    // A plugin that does not fit the type now stays in the prompt instead.
    onSubmit.mockReset();
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await chooseType("Godot");
    await historyKey("ArrowUp");
    expect(container.querySelector("textarea")!.value).toBe("@Three.js World Make an island");
    await send();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ prompt: "@Web Game Studio @Three.js World Make an island" }), expect.any(Function));
  });

  it("starts with several plugins, keeps them when Home mounts again, and sends them in order", async () => {
    capabilities.plugins.push(plugin("threejs-world", "Three.js World", ["web-game"]));
    await render();
    await act(async () => pluginButton().click());
    await act(async () => menuItem("Three.js World")!.click());
    expect(pluginButton().getAttribute("aria-label")).toBe("Plugins: Web Game Studio, Three.js World");
    expect(pluginButton().textContent).toBe("+1");
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(pluginButton().getAttribute("aria-label")).toBe("Plugins: Web Game Studio, Three.js World");
    await type("Make an island");
    await send();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "@Web Game Studio @Three.js World Make an island",
      mentions: [
        { name: "web-game-studio", displayName: "Web Game Studio", marketplaceId: "bundled" },
        { name: "threejs-world", displayName: "Three.js World", marketplaceId: "bundled" },
      ],
    }), expect.any(Function));

    // Removing the lead keeps the others, also once Home brings the type's starter back.
    onSubmit.mockReset();
    const textarea = () => container.querySelector("textarea")!;
    textarea().setSelectionRange(0, 0);
    await act(async () => { textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true })); });
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await send();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ prompt: "@Web Game Studio @Three.js World Make an island" }), expect.any(Function));

    // While plugins load, the draft's plugins are still sent.
    onSubmit.mockReset();
    await act(async () => root.unmount());
    pendingCapabilities = new Promise(() => {});
    root = createRoot(container);
    await render();
    await type("Make a reef");
    await send();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "@Web Game Studio @Three.js World Make a reef",
      mentions: expect.arrayContaining([expect.objectContaining({ name: "threejs-world" })]),
    }), expect.any(Function));
  });

  it("keeps the other plugins when the lead is replaced by a mention", async () => {
    capabilities.plugins.push(plugin("threejs-world", "Three.js World", ["web-game"]));
    await render();
    await act(async () => pluginButton().click());
    await act(async () => menuItem("Three.js World")!.click());
    await act(async () => pluginButton().click());
    const textarea = container.querySelector("textarea")!;
    textarea.setSelectionRange(0, 0);
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true })); });
    await type("@Blen");
    textarea.setSelectionRange(5, 5);
    await act(async () => { textarea.dispatchEvent(new Event("select", { bubbles: true })); });
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"], [role="menuitem"]')].find((item) => item.textContent?.includes("Blender"))!;
    await act(async () => option.click());
    await type("Make an island");
    await send();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "@Blender @Three.js World Make an island",
      mentions: expect.arrayContaining([expect.objectContaining({ name: "blender" }), expect.objectContaining({ name: "threejs-world" })]),
    }), expect.any(Function));
  });

  it("moves a following plugin up when a mention makes it the lead", async () => {
    capabilities.plugins.push(plugin("threejs-world", "Three.js World", ["web-game"]));
    await render();
    await act(async () => pluginButton().click());
    await act(async () => menuItem("Three.js World")!.click());
    await act(async () => pluginButton().click());
    const textarea = container.querySelector("textarea")!;
    const backspace = async () => {
      textarea.setSelectionRange(0, 0);
      await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true })); });
    };
    await backspace();
    await type("@Three");
    textarea.setSelectionRange(6, 6);
    await act(async () => { textarea.dispatchEvent(new Event("select", { bubbles: true })); });
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"], [role="menuitem"]')].find((item) => item.textContent?.includes("Three.js World"))!;
    await act(async () => option.click());
    expect(pluginButton().getAttribute("aria-label")).toBe("Plugins: Three.js World");
    await type("Make an island");
    await backspace();
    expect(pluginButton().getAttribute("aria-label")).toBe("Plugins");
    await send();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Make an island", mentions: [] }), expect.any(Function));
  });

  it("hands the prompt with its type and starting plugin to the dialog instead of creating a project", async () => {
    await render();
    // The plugin alone is not a message.
    expect(
      container.querySelector<HTMLButtonElement>('button[type="submit"]')!
        .disabled,
    ).toBe(true);
    await type("Make a maze");
    await send();
    expect(onSubmit).toHaveBeenCalledWith({
      prompt: "@Web Game Studio Make a maze",
      mentions: [
        {
          name: "web-game-studio",
          displayName: "Web Game Studio",
          marketplaceId: "bundled",
        },
      ],
      attachments: [],
      mode: "normal",
      type: "web-game",
      projectPlugins: [],
    }, expect.any(Function));
  });

  it("sends the prompt alone once its plugin is unchecked", async () => {
    await render();
    await act(async () => pluginButton().click());
    await act(async () => menuItem("Web Game Studio")!.click());
    expect(pluginButton().getAttribute("aria-label")).toBe("Plugins");
    await type("Make a maze");
    await send();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Make a maze", mentions: [] }),
      expect.any(Function),
    );
  });

  it("turns plugins on for the new project alone once the person allows what they ask for", async () => {
    await render();
    await act(async () => pluginButton().click());
    // Plugins that add project types are picked as the type instead.
    expect([...document.querySelectorAll('[role="group"][aria-label="On in this project only"] [role="menuitemcheckbox"]')].map((item) => item.querySelector(".home-plugin-text > span")?.textContent))
      .toEqual(["Sprites"]);
    await act(async () => menuItem("Sprites")!.click());
    expect(document.body.textContent).toContain("network:sprites.example.com");
    const allow = [...document.querySelectorAll("button")].find((button) => button.textContent === "Allow and turn on")!;
    await act(async () => allow.click());
    expect(pluginButton().textContent).toBe("+1");
    await type("Make a maze");
    await send();
    expect(onSubmit.mock.calls[0]![0].projectPlugins.map((plugin: ProjectPluginChoice) => plugin.id)).toEqual(["acme/sprites"]);
  });

  it("leaves out the list of plugins for this project when only type plugins could go in it", async () => {
    projectPlugins = projectPlugins.filter((plugin) => plugin.providesTypes.length);
    await render();
    await act(async () => pluginButton().click());
    expect(starterItems()).toEqual(["Web Game Studio"]);
    expect(document.querySelector('[role="group"][aria-label="On in this project only"]')).toBeNull();
  });

  it("offers no starting plugins when none is enabled, and links to plugins when none can be turned on", async () => {
    capabilities = { plugins: [plugin("blender", "Blender")], skills: [] };
    projectPlugins = [];
    await render();
    await act(async () => pluginButton().click());
    expect(starterItems()).toEqual([]);
    expect(document.querySelector(".home-plugin-empty a")!.getAttribute("href")).toBe("#/plugins");
  });

  it("waits for plugins' types before sending a plugin's type it remembered", async () => {
    localStorage.setItem("ohmygame.home.projectType", "acme/tiles:tile-map");
    pendingTypes = new Promise(() => {});
    await render();
    await type("Make a map");
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    await send();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("offers a retry when plugins' types fail to load for a type it remembered", async () => {
    localStorage.setItem("ohmygame.home.projectType", "acme/tiles:tile-map");
    typesFail = 1;
    await render();
    expect(container.querySelector(".home-notice")!.textContent).toContain("Couldn't load plugins");
    const retry = [...container.querySelectorAll<HTMLButtonElement>(".home-notice button")].find((item) => item.textContent === "Retry")!;
    await act(async () => retry.click());
    expect(container.querySelector(".home-notice")).toBeNull();
    expect(typePicker().textContent).toBe("Tile Map");
  });

  it("offers a retry when plugins' types fail to load while an app type is chosen", async () => {
    typesFail = 1;
    await render();
    const retry = [...container.querySelectorAll<HTMLButtonElement>(".home-notice button")].find((item) => item.textContent === "Retry")!;
    await act(async () => retry.click());
    expect(container.querySelector(".home-notice")).toBeNull();
  });

  it("offers a retry when the plugins a project can turn on fail to load", async () => {
    choicesFail = 1;
    await render();
    await act(async () => pluginButton().click());
    expect(document.querySelector(".home-plugin-empty")!.textContent).toContain("Couldn't load the plugins");
    const retry = [...document.querySelectorAll<HTMLButtonElement>(".home-plugin-empty button")].find((item) => item.textContent === "Retry")!;
    await act(async () => retry.click());
    expect(menuItem("Sprites")).toBeDefined();
  });

  it("offers a plugin that sets up its own projects as a type, which keeps that plugin on", async () => {
    capabilities.plugins.push({ ...plugin("taptap-maker", "TapTap Maker", ["general"]), integration: { createProject: true } as never });
    await render();
    await act(async () => typePicker().click());
    expect(options()).toEqual(["Web Game", "Interactive Story", "Asset Canvas", "Godot", "General Game", "Tile Map", "TapTap Maker", "More types…"]);
    await act(async () => typePicker().click());
    // Another type does not offer it as a plugin; it would set up a second project.
    await chooseType("General Game");
    await act(async () => pluginButton().click());
    expect(starterItems()).not.toContain("TapTap Maker");
    await act(async () => pluginButton().click());

    await chooseType("TapTap Maker");
    expect(pluginButton().getAttribute("aria-label")).toBe("Plugins: TapTap Maker");
    await act(async () => pluginButton().click());
    expect(starterItems()[0]).toBe("TapTap Maker");
    expect(menuItem("TapTap Maker")!.getAttribute("aria-disabled")).toBe("true");
    await act(async () => menuItem("TapTap Maker")!.click());
    expect(menuItem("TapTap Maker")!.getAttribute("aria-checked")).toBe("true");
    await type("Make a puzzle");
    await send();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "@TapTap Maker Make a puzzle",
      type: "general",
    }), expect.any(Function));
  });

  it("keeps a type's own plugin when the prompt is cleared, for plugins outside the starter list too", async () => {
    capabilities.plugins.push({ ...plugin("island-maker", "Island Maker", ["general"]), integration: { createProject: true } as never });
    await render();
    await chooseType("Island Maker");
    // /plan clears the prompt and its plugins; the type's plugin comes back.
    await type("/plan");
    await send();
    expect(pluginButton().getAttribute("aria-label")).toBe("Plugins: Island Maker");
    await type("Make an island");
    // Browsing history and coming back keeps the plugin once.
    localStorage.setItem("ohmygame.home-prompt-history", JSON.stringify([{ prompt: "Make a maze", mentions: [] }]));
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await historyKey("ArrowUp");
    expect(container.querySelector("textarea")!.value).toBe("Make a maze");
    await historyKey("ArrowDown");
    expect(container.querySelector("textarea")!.value).toBe("Make an island");
    await send();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ prompt: "@Island Maker Make an island", type: "general" }), expect.any(Function));
  });

  it("keeps a lead plugin from history in the prompt after the type's own plugin", async () => {
    capabilities.plugins.push({ ...plugin("taptap-maker", "TapTap Maker", ["general"]), integration: { createProject: true } as never });
    const mention = { name: "blender", displayName: "Blender", marketplaceId: "bundled" };
    localStorage.setItem("ohmygame.home-prompt-history", JSON.stringify([{ prompt: "@Blender Make a maze", mentions: [mention] }]));
    await render();
    await chooseType("TapTap Maker");
    await historyKey("ArrowUp");
    expect(container.querySelector("textarea")!.value).toBe("@Blender Make a maze");
    await send();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "@TapTap Maker @Blender Make a maze",
      mentions: expect.arrayContaining([expect.objectContaining({ name: "taptap-maker" }), expect.objectContaining({ name: "blender" })]),
    }), expect.any(Function));
  });

  it("keeps the order of plugins from history after the type's own plugin", async () => {
    capabilities.plugins.push(
      { ...plugin("taptap-maker", "TapTap Maker", ["general"]), integration: { createProject: true } as never },
      plugin("game-studio", "Game Studio", ["general"]),
    );
    const mentions = [{ name: "game-studio", displayName: "Game Studio", marketplaceId: "bundled" }, { name: "godot", displayName: "Godot", marketplaceId: "bundled" }];
    localStorage.setItem("ohmygame.home-prompt-history", JSON.stringify([{ prompt: "@Game Studio @Godot Make a maze", mentions }]));
    await render();
    await chooseType("TapTap Maker");
    await historyKey("ArrowUp");
    expect(pluginButton().getAttribute("aria-label")).toBe("Plugins: TapTap Maker, Game Studio, Godot");
    await send();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ prompt: "@TapTap Maker @Game Studio @Godot Make a maze" }), expect.any(Function));
  });

  it("drops a remembered plugin type's plugin once that plugin is gone", async () => {
    capabilities.plugins.push({ ...plugin("taptap-maker", "TapTap Maker", ["general"]), integration: { createProject: true } as never });
    await render();
    await chooseType("TapTap Maker");
    await type("Make a puzzle");
    await act(async () => root.unmount());
    capabilities.plugins.pop();
    root = createRoot(container);
    await render();
    expect(typePicker().textContent).toBe("Web Game");
    await send();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ prompt: "@Web Game Studio Make a puzzle", type: "web-game" }), expect.any(Function));
  });

  it("keeps a remembered plugin type pending when plugins fail to load", async () => {
    localStorage.setItem("ohmygame.home.projectType", "starter:taptap-maker@bundled");
    pendingCapabilities = Promise.reject(new Error("Plugins unavailable"));
    pendingCapabilities.catch(() => {});
    await render();
    await type("Make a puzzle");
    expect(container.textContent).toContain("Plugins unavailable");
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  });

  it("waits for plugins before sending a plugin's own type it remembered", async () => {
    localStorage.setItem("ohmygame.home.projectType", "starter:taptap-maker@bundled");
    let answer!: (value: ConversationCapabilities) => void;
    pendingCapabilities = new Promise((resolve) => { answer = resolve; });
    await render();
    await type("Make a puzzle");
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    capabilities.plugins.push({ ...plugin("taptap-maker", "TapTap Maker", ["general"]), integration: { createProject: true } as never });
    await act(async () => answer(capabilities));
    expect(typePicker().textContent).toBe("TapTap Maker");
    await send();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ prompt: "@TapTap Maker Make a puzzle", type: "general" }), expect.any(Function));
  });

  it("remembers the type, and leads to plugins that add types", async () => {
    await render();
    await chooseType("Interactive Story");
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(typePicker().textContent).toBe("Interactive Story");

    await chooseType("More types…");
    expect(window.location.hash).toBe("#/plugins?adds=projectType");
    expect(typePicker().textContent).toBe("Interactive Story");
  });

  it("keeps the unsent prompt when Home mounts again", async () => {
    await render();
    await type("A tiny racing game");
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(container.querySelector("textarea")!.value).toBe("A tiny racing game");
  });

  it("clears the prompt once the dialog has created the project", async () => {
    await render();
    await type("Make a maze");
    await send();
    expect(container.querySelector("textarea")!.value).toBe("Make a maze");
    await act(async () => onSubmit.mock.calls[0]![1]());
    expect(container.querySelector("textarea")!.value).toBe("");
  });
});
