// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationCapabilities,
  ProjectState,
} from "../src/shared/contracts.js";

const created: ProjectState = {
  id: "maze",
  name: "Untitled project",
  type: "godot-game",
  updatedAt: "2026-10-29T00:00:00Z",
  workspacePath: "/tmp/maze",
  preview: { status: "waiting" },
};
let capabilities: ConversationCapabilities = { plugins: [], skills: [] };
const createProject = vi.fn(async () => created);
const createConversation = vi.fn(async () => ({ id: "first" }));
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  getHomeComposerCapabilities: async () => capabilities,
  createProject,
  createConversation,
}));
const { ProjectCreateDialog } =
  await import("../src/renderer/project-create-dialog.js");

const godot = { name: "godot", displayName: "Godot", marketplaceId: "bundled" };
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  capabilities = { plugins: [], skills: [] };
  createProject.mockClear();
  createConversation.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const typeSelect = () =>
  document.querySelector<HTMLButtonElement>(
    '[role="dialog"] [aria-label="Type"]',
  )!;
async function typeOptions(): Promise<string[]> {
  await act(async () => typeSelect().click());
  const options = [...document.querySelectorAll('[role="option"]')].map(
    (option) => option.textContent ?? "",
  );
  await act(async () => typeSelect().click());
  return options;
}
function button(text: string): HTMLButtonElement {
  return [
    ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  ].find((element) => element.textContent === text)!;
}

describe("new project dialog", () => {
  it("offers every project type, Asset Canvas included, and asks only for name, type and folder", async () => {
    await act(async () =>
      root.render(
        <ProjectCreateDialog onClose={() => {}} onCreated={() => {}} />,
      ),
    );
    expect(typeSelect().textContent).toBe("Web Game");
    expect(await typeOptions()).toEqual([
      "Web Game",
      "Interactive Story",
      "Asset Canvas",
      "Godot",
      "General Game",
    ]);
    const dialog = document.querySelector('[role="dialog"]')!.textContent;
    // Examples are played and remixed from Explore, and a story's format is set in its settings.
    expect(dialog).not.toContain("Start from");
    expect(dialog).not.toContain("Canvas format");
    expect(dialog).not.toContain("First message");
    expect(button("Create")).toBeDefined();
  });

  it("starts the project with the prompt as its first message, in a type its plugin supports", async () => {
    capabilities = {
      plugins: [
        {
          id: "godot@bundled",
          ...godot,
          description: "",
          marketplaceDisplayName: "Bundled",
          projectTypes: ["godot-game", "general"],
        },
      ],
      skills: [],
    };
    const onCreated = vi.fn();
    await act(async () =>
      root.render(
        <ProjectCreateDialog
          firstMessage={{
            prompt: "@Godot Make a maze",
            mentions: [godot],
            attachments: [],
            mode: "planning",
          }}
          onClose={() => {}}
          onCreated={onCreated}
        />,
      ),
    );
    expect(
      document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!
        .value,
    ).toBe("@Godot Make a maze");
    // The name comes from the first message unless one is typed.
    expect(
      document.querySelector<HTMLInputElement>('[role="dialog"] input')!
        .placeholder,
    ).toBe("Named from the first message");
    expect(typeSelect().textContent).toBe("Godot");
    expect(await typeOptions()).toEqual(["Godot", "General Game"]);

    await act(async () => button("Create and start").click());
    expect(createProject).toHaveBeenCalledWith({ type: "godot-game" });
    expect(createConversation).toHaveBeenCalledWith("maze");
    expect(onCreated).toHaveBeenCalledWith(created, {
      conversationId: "first",
      prompt: "@Godot Make a maze",
      mentions: [godot],
      mode: "planning",
      attachments: [],
    });
  });

  it("opens a blank project without a conversation", async () => {
    const onCreated = vi.fn();
    await act(async () =>
      root.render(
        <ProjectCreateDialog
          initialType="interactive-story"
          initialWorkspacePath="/Users/me/Games/story"
          onClose={() => {}}
          onCreated={onCreated}
        />,
      ),
    );
    expect(
      document.querySelector<HTMLInputElement>(
        '[role="dialog"] input[readonly]',
      )!.value,
    ).toBe("/Users/me/Games/story");
    await act(async () => button("Create").click());
    expect(createProject).toHaveBeenCalledWith({
      type: "interactive-story",
      workspacePath: "/Users/me/Games/story",
    });
    expect(createConversation).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith(created);
  });
});
