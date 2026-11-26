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
let models: { provider: string; providerName: string; id: string; name: string; reasoningLevels: string[] }[] = [];
const generateGameIdea = vi.fn(async (_input: { type: string; model?: { provider: string; id: string }; avoid?: string }) => "Make a lighthouse keeper game where the fog hides ghost ships");
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  waitForRuntime: async () => undefined,
  getHomeComposerCapabilities: async () => capabilities,
  listModels: async () => ({ models }),
  generateGameIdea: (input: { type: string; model?: { provider: string; id: string }; avoid?: string }) => generateGameIdea(input),
}));
const { ProjectPromptCreator } =
  await import("../src/renderer/project-prompt-creator.js");
const { notifyAgentModelsChanged } = await import("../src/renderer/model-settings-events.js");

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
  models = [];
  generateGameIdea.mockClear();
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

async function render(projectType = "web-game") {
  await act(async () =>
    root.render(
      <ProjectPromptCreator
        type={projectType}
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
const randomIdea = () => act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Random idea"]')!.click());
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
    vi.spyOn(Math, "random").mockReturnValue(0);
    await render();
    // No plugin is chosen for the person: the box has no plugin menu.
    expect(container.querySelector(".home-plugin-trigger")).toBeNull();
    // With no model, the idea button beside + fills the prompt with one of the type's own.
    await randomIdea();
    expect(generateGameIdea).not.toHaveBeenCalled();
    expect(promptText(container)).toBe("Make a pixel-art dungeon roguelike with turn-based combat");
    // Another click gives another idea.
    await randomIdea();
    expect(promptText(container)).toBe("Make a casual portrait merge game for phones");
    expect(await mentionable()).toEqual(["Blender", "Web Game Studio", "Sprites", "Notes"]);

    await render("godot-game");
    expect(await mentionable()).toEqual(["Game Studio", "Blender", "Sprites", "Notes"]);
    await randomIdea();
    expect(promptText(container)).toBe("Make a third-person 3D scene in Godot you can walk around");
    vi.restoreAllMocks();
  });

  it("asks the model for a random idea of the type, and uses the type's own when it can't", async () => {
    models = [{ provider: "openai", providerName: "OpenAI", id: "gpt-6", name: "GPT-6", reasoningLevels: ["off"] }];
    await render();
    // The model list is shared and cached; tell it the models changed.
    await act(async () => notifyAgentModelsChanged());
    await type("A game about bees");
    await render("interactive-story");
    await randomIdea();
    expect(generateGameIdea).toHaveBeenCalledWith({ type: "interactive-story", model: expect.objectContaining({ provider: "openai", id: "gpt-6" }), avoid: "A game about bees" });
    expect(promptText(container)).toBe("Make a lighthouse keeper game where the fog hides ghost ships");

    generateGameIdea.mockRejectedValueOnce(new Error("No language model is available"));
    vi.spyOn(Math, "random").mockReturnValue(0);
    await randomIdea();
    expect(promptText(container)).toBe("Make a branching mystery story with three endings");
    // A plugin's type without ideas of its own asks for a general game.
    await render("acme/tiles:tile-map");
    await randomIdea();
    expect(generateGameIdea).toHaveBeenLastCalledWith(expect.objectContaining({ type: "general" }));
    vi.restoreAllMocks();
  });

  it("preserves a new draft or project type while a random idea is pending", async () => {
    models = [{ provider: "openai", providerName: "OpenAI", id: "gpt-6", name: "GPT-6", reasoningLevels: ["off"] }];
    await render();
    await act(async () => notifyAgentModelsChanged());
    for (const change of ["edit", "switch"]) {
      let finish!: (text: string) => void;
      generateGameIdea.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
      await randomIdea();
      if (change === "edit") await type("Keep my draft");
      else await render("interactive-story");
      await act(async () => finish("Late idea"));
      expect(promptText(container)).toBe("Keep my draft");
      expect(container.querySelector<HTMLButtonElement>('[aria-label="Random idea"]')!.disabled).toBe(false);
    }
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
    await render("godot-game");
    await historyKey("ArrowUp");
    await send();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ prompt: "@Sprites Make an island" }), expect.any(Function));
    expect(onSubmit.mock.calls[0]![0].turnOn).toBeUndefined();
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
