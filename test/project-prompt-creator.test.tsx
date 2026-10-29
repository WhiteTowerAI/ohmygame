// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationCapabilities } from "../src/shared/contracts.js";

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
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  waitForRuntime: async () => undefined,
  getHomeComposerCapabilities: async () => capabilities,
  listModels: async () => ({ models: [] }),
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
const picker = () =>
  container.querySelector<HTMLButtonElement>(
    '[aria-label="Start with plugin"]',
  )!;

describe("Home prompt box", () => {
  it("starts with the first enabled starting plugin and offers only plugins that start projects", async () => {
    await render();
    expect(picker().textContent).toBe("Web Game Studio");
    // Its ideas fill the prompt.
    const idea = [
      ...container.querySelectorAll<HTMLButtonElement>(".home-idea"),
    ].find((button) => button.textContent?.includes("dungeon"))!;
    await act(async () => idea.click());
    expect(container.querySelector("textarea")!.value).toBe(
      "Make a pixel-art dungeon roguelike with turn-based combat",
    );

    await act(async () => picker().click());
    const options = [...document.querySelectorAll('[role="option"]')].map(
      (option) => option.querySelector("span > span")?.textContent,
    );
    expect(options).toEqual(["Web Game Studio", "Godot", "No plugin"]);
  });

  it("hands the prompt with its starting plugin to the dialog instead of creating a project", async () => {
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
    }, expect.any(Function));
  });

  it("sends the prompt alone with No plugin", async () => {
    await render();
    await act(async () => picker().click());
    const none = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ].find((option) => option.textContent === "No plugin")!;
    await act(async () => none.click());
    expect(picker().textContent).toBe("No plugin");
    await type("Make a maze");
    await send();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Make a maze", mentions: [] }),
      expect.any(Function),
    );
  });

  it("hides the picker when no starting plugin is enabled", async () => {
    capabilities = { plugins: [plugin("blender", "Blender")], skills: [] };
    await render();
    expect(picker()).toBeNull();
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
