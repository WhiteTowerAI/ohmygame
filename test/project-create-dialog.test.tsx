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
const getHomeComposerCapabilities = vi.fn(async () => capabilities);
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  getHomeComposerCapabilities,
  createProject,
  createConversation,
}));
const { ProjectCreateDialog } =
  await import("../src/renderer/project-create-dialog.js");

const godot = { name: "godot", displayName: "Godot", marketplaceId: "bundled" };
const godotPlugin = {
  id: "godot@bundled",
  ...godot,
  description: "",
  marketplaceDisplayName: "Bundled",
  projectTypes: ["godot-game", "general"] as const,
};
const godotMessage = {
  prompt: "@Godot Make a maze",
  mentions: [godot],
  attachments: [],
  mode: "normal" as const,
};
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  capabilities = { plugins: [], skills: [] };
  createProject.mockClear();
  createConversation.mockClear();
  getHomeComposerCapabilities.mockClear();
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

  it("waits for the plugins before creating, so the type follows the starting plugin", async () => {
    let answer!: (value: ConversationCapabilities) => void;
    getHomeComposerCapabilities.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    await act(async () =>
      root.render(<ProjectCreateDialog firstMessage={godotMessage} onClose={() => {}} onCreated={() => {}} />),
    );
    expect(button("Create and start").disabled).toBe(true);
    await act(async () => button("Create and start").click());
    expect(createProject).not.toHaveBeenCalled();
    await act(async () => answer({ plugins: [{ ...godotPlugin, projectTypes: [...godotPlugin.projectTypes] }], skills: [] }));
    expect(button("Create and start").disabled).toBe(false);
    // A second click while the first is still creating does nothing.
    await act(async () => {
      button("Create and start").click();
      button("Create and start").click();
    });
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(createProject).toHaveBeenCalledWith({ type: "godot-game" });
  });

  it("offers a retry when the plugins fail to load", async () => {
    getHomeComposerCapabilities.mockRejectedValueOnce(new Error("offline"));
    await act(async () =>
      root.render(<ProjectCreateDialog firstMessage={godotMessage} onClose={() => {}} onCreated={() => {}} />),
    );
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("Couldn't load plugins");
    expect(button("Create and start").disabled).toBe(true);
    capabilities = { plugins: [{ ...godotPlugin, projectTypes: [...godotPlugin.projectTypes] }], skills: [] };
    await act(async () => button("Retry").click());
    expect(document.querySelector('[role="dialog"] [role="alert"]')).toBeNull();
    expect(typeSelect().textContent).toBe("Godot");
    expect(button("Create and start").disabled).toBe(false);
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
