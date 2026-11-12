// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationCapabilities } from "../src/shared/contracts.js";
import { placeCaret, pressKey, promptChips, promptText, typePrompt } from "./prompt-field.js";

type Plugin = ConversationCapabilities["plugins"][number];
const plugin = (name: string, displayName: string, more: Partial<Plugin> = {}): Plugin => ({
  id: `${name}@bundled`,
  name,
  displayName,
  description: `${displayName} description`,
  marketplaceId: "bundled",
  marketplaceDisplayName: "Bundled",
  ...more,
});
let capabilities: ConversationCapabilities;
// Set to hold GET /project-types until a test answers it.
let pendingTypes: Promise<never> | undefined;
let pendingCapabilities: Promise<ConversationCapabilities> | undefined;
let typesFail = 0;
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  waitForRuntime: async () => undefined,
  getHomeComposerCapabilities: async () => pendingCapabilities ?? capabilities,
  listModels: async () => ({ models: [] }),
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
  // Blender helps any project; the studios suit their own kinds of project.
  capabilities = {
    plugins: [
      plugin("game-studio", "Game Studio", { appliesTo: ["general", "godot-game", "interactive-story"] }),
      plugin("blender", "Blender"),
      plugin("web-game-studio", "Web Game Studio", { appliesTo: ["web-game"] }),
      // Off in every project, so mentioning it turns it on in the new one.
      plugin("sprites", "Sprites", { off: true, asks: ["network:sprites.example.com"] }),
      plugin("notes", "Notes", { off: true }),
    ],
    skills: [],
  };
  localStorage.clear();
  pendingTypes = undefined;
  pendingCapabilities = undefined;
  typesFail = 0;
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
const type = (value: string) => typePrompt(value, container);
const send = () =>
  act(async () =>
    container
      .querySelector<HTMLButtonElement>('button[type="submit"]')!
      .click(),
  );
const typePicker = () =>
  container.querySelector<HTMLButtonElement>('[aria-label="Project type"]')!;
const optionLabel = (option: Element) => option.querySelector(".ui-option-text > span")?.textContent;
const options = () => [...document.querySelectorAll('[role="option"]')].map(optionLabel);
async function chooseType(label: string) {
  await act(async () => typePicker().click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((item) => optionLabel(item) === label)!;
  await act(async () => option.click());
}
const ideasButton = () =>
  [...container.querySelectorAll<HTMLButtonElement>(".home-starts button")].find((item) => item.textContent === "Ideas")!;
async function chooseIdea(text: string) {
  await act(async () => ideasButton().click());
  const idea = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.includes(text))!;
  await act(async () => idea.click());
}
async function historyKey(key: "ArrowUp" | "ArrowDown") {
  await placeCaret(key === "ArrowUp" ? 0 : promptText(container).length, container);
  await pressKey(key, {}, container);
}
/** What `@` offers, by name. */
async function mentionable(): Promise<string[]> {
  await type("@");
  await placeCaret(1, container);
  const names = [...document.querySelectorAll('[role="option"]')].map((item) => item.textContent ?? "");
  await type("");
  return capabilities.plugins.map((item) => item.displayName).filter((name) => names.some((text) => text.startsWith(name)));
}
async function mention(text: string, name: string) {
  await type(text);
  await placeCaret(text.length, container);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"], [role="menuitem"]')].find((item) => item.textContent?.includes(name))!;
  await act(async () => option.click());
}

describe("Home prompt box", () => {
  it("offers the type's ideas, and only the plugins that suit it", async () => {
    await render();
    expect(typePicker().textContent).toBe("Web Game");
    // No plugin is chosen for the person: the box has no plugin menu.
    expect(container.querySelector(".home-plugin-trigger")).toBeNull();
    // Its ideas sit behind one button in the row of ways to start, and fill the prompt.
    await chooseIdea("dungeon");
    expect(promptText(container)).toBe("Make a pixel-art dungeon roguelike with turn-based combat");
    expect(await mentionable()).toEqual(["Blender", "Web Game Studio", "Sprites", "Notes"]);

    // Plugins' own types follow the app's; Godot's is the app's Godot type.
    await act(async () => typePicker().click());
    expect(options()).toEqual(["Web Game", "Interactive Story", "Asset Canvas", "Godot", "General Game", "Tile Map", "More types…"]);
    await act(async () => typePicker().click());

    await chooseType("Godot");
    expect(await mentionable()).toEqual(["Game Studio", "Blender", "Sprites", "Notes"]);
    await chooseIdea("third-person");
    expect(promptText(container)).toBe("Make a third-person 3D scene in Godot you can walk around");
  });

  it("hands the prompt as written, with its type, to the dialog instead of creating a project", async () => {
    await render();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    await type("Make a maze");
    await send();
    expect(onSubmit).toHaveBeenCalledWith({
      prompt: "Make a maze",
      mentions: [],
      attachments: [],
      mode: "normal",
      type: "web-game",
    }, expect.any(Function));
  });

  it("keeps plugins and Skills in the text where they are picked", async () => {
    capabilities.skills = [{ name: "game-design", description: "Write a brief" }];
    await render();
    await mention("@Blen", "Blender");
    expect(promptText(container)).toBe("@Blender ");
    await mention(`${promptText(container)}then $game`, "Game Design");
    expect(promptChips(container)).toEqual(["Blender", "Game Design"]);
    await type(`${promptText(container)}Make an island`);
    await send();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "@Blender then $game-design Make an island",
      mentions: [{ name: "blender", displayName: "Blender", marketplaceId: "bundled" }],
    }), expect.any(Function));
    // Blender is on in every project, so the new project needs nothing turned on.
    expect(onSubmit.mock.calls[0]![0].turnOn).toBeUndefined();
  });

  it("turns a mentioned plugin that's off on in the new project, which allows it, without asking", async () => {
    await render();
    await mention("@Spr", "Sprites");
    expect(document.querySelector(".ui-dialog")).toBeNull();
    expect(promptChips(container)).toEqual(["Sprites"]);
    await mention(`${promptText(container)}@No`, "Notes");
    expect(promptChips(container)).toEqual(["Sprites", "Notes"]);
    await type(`${promptText(container)}Make a maze`);
    await send();
    expect(onSubmit.mock.calls[0]![0].turnOn.map((item: Plugin) => item.id)).toEqual(["sprites@bundled", "notes@bundled"]);
  });

  it("sends a prompt from history whose plugin is off, turning it on in the new project", async () => {
    const mentions = [{ name: "sprites", displayName: "Sprites", marketplaceId: "bundled" }];
    localStorage.setItem("ohmygame.home-prompt-history", JSON.stringify([{ prompt: "@Sprites Make an island", mentions }]));
    await render();
    await historyKey("ArrowUp");
    expect(promptChips(container)).toEqual(["Sprites"]);
    await send();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "@Sprites Make an island",
      mentions,
      turnOn: [expect.objectContaining({ id: "sprites@bundled" })],
    }), expect.any(Function));

    // A plugin that doesn't suit the type stays a mention, and is not turned on.
    onSubmit.mockReset();
    capabilities.plugins[3] = { ...capabilities.plugins[3]!, appliesTo: ["web-game"] };
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await chooseType("Godot");
    await historyKey("ArrowUp");
    await send();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ prompt: "@Sprites Make an island" }), expect.any(Function));
    expect(onSubmit.mock.calls[0]![0].turnOn).toBeUndefined();
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
    expect(promptText(container)).toBe("A tiny racing game");
  });

  it("clears the prompt once the dialog has created the project", async () => {
    await render();
    await type("Make a maze");
    await send();
    expect(promptText(container)).toBe("Make a maze");
    await act(async () => onSubmit.mock.calls[0]![1]());
    expect(promptText(container)).toBe("");
  });
});
