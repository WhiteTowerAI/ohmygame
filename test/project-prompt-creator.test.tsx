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
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  waitForRuntime: async () => undefined,
  getHomeComposerCapabilities: async () => capabilities,
  listModels: async () => ({ models: [] }),
  listProjectPluginChoices: async () => projectPlugins,
  listProjectTypes: async () => [
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
  ];
  localStorage.clear();
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
const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".home-plugin-row")]
    .find((item) => item.querySelector(".home-plugin-text > span")?.textContent === label);

describe("Home prompt box", () => {
  it("starts with the plugin the type names, and changes it with the type", async () => {
    await render();
    expect(typePicker().textContent).toBe("Web Game");
    expect(pluginButton().getAttribute("aria-label")).toBe("Plugins: starts with Web Game Studio");
    // Its ideas fill the prompt.
    const idea = [
      ...container.querySelectorAll<HTMLButtonElement>(".home-idea"),
    ].find((button) => button.textContent?.includes("dungeon"))!;
    await act(async () => idea.click());
    expect(container.querySelector("textarea")!.value).toBe(
      "Make a pixel-art dungeon roguelike with turn-based combat",
    );

    // Plugins' own types follow the app's; Godot's is the app's Godot type.
    await act(async () => typePicker().click());
    expect(options()).toEqual(["Web Game", "Interactive Story", "Asset Canvas", "Godot", "General Game", "Tile Map", "More types…"]);
    await act(async () => typePicker().click());

    await chooseType("Godot");
    expect(pluginButton().getAttribute("aria-label")).toBe("Plugins: starts with Godot");
    // Only plugins that start this type are offered; Blender starts none.
    await act(async () => pluginButton().click());
    expect([...document.querySelectorAll('[role="menuitemradio"]')].map((item) => item.querySelector(".home-plugin-text > span")?.textContent))
      .toEqual(["Godot", "No plugin"]);
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

  it("keeps a starting plugin the person chose when Home mounts again", async () => {
    capabilities.plugins.push(plugin("threejs-world", "Three.js World", ["web-game"]));
    await render();
    await act(async () => pluginButton().click());
    await act(async () => menuItem("Three.js World")!.click());
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(pluginButton().getAttribute("aria-label")).toBe("Plugins: starts with Three.js World");
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

  it("sends the prompt alone with No plugin", async () => {
    await render();
    await act(async () => pluginButton().click());
    await act(async () => menuItem("No plugin")!.click());
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
    await act(async () => menuItem("Tiles")!.click());
    expect(document.body.textContent).toContain("network:tiles.example.com");
    const allow = [...document.querySelectorAll("button")].find((button) => button.textContent === "Allow and turn on")!;
    await act(async () => allow.click());
    expect(pluginButton().textContent).toBe("+1");
    await type("Make a maze");
    await send();
    expect(onSubmit.mock.calls[0]![0].projectPlugins.map((plugin: ProjectPluginChoice) => plugin.id)).toEqual(["acme/tiles"]);

    // A plugin that adds the chosen type is on in that project already.
    await chooseType("Tile Map");
    await act(async () => pluginButton().click());
    expect([...document.querySelectorAll('[role="menuitemcheckbox"]')].map((item) => item.querySelector(".home-plugin-text > span")?.textContent))
      .toEqual(["Godot"]);
  });

  it("offers only No plugin when no starting plugin is enabled, and links to plugins when none can be turned on", async () => {
    capabilities = { plugins: [plugin("blender", "Blender")], skills: [] };
    projectPlugins = [];
    await render();
    await act(async () => pluginButton().click());
    expect([...document.querySelectorAll('[role="menuitemradio"]')].map((item) => item.querySelector(".home-plugin-text > span")?.textContent))
      .toEqual(["No plugin"]);
    expect(document.querySelector(".home-plugin-empty a")!.getAttribute("href")).toBe("#/plugins");
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
