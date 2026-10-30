// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationCapabilities,
  ProjectState,
} from "../src/shared/contracts.js";
import type { ProjectPluginChoice } from "../src/shared/plugins.js";

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
// Godot's type is the app's own, so only the other plugin type is added to the menu.
const listProjectTypes = vi.fn(async () => [
  { id: "general", title: "General" },
  { id: "ohmygame/godot:godot-game", title: "Godot game", plugin: { id: "ohmygame/godot", version: "1.0.0" } },
  { id: "acme/tiles:map", title: "Tile Map", description: "A Tiled map game", plugin: { id: "acme/tiles", version: "2.1.0" } },
]);
let pluginChoices: ProjectPluginChoice[] = [];
const listProjectPluginChoices = vi.fn(async () => pluginChoices);
const consentToPlugin = vi.fn(async () => {});
const setProjectPluginVersion = vi.fn(async () => {});
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  getHomeComposerCapabilities,
  listProjectTypes,
  listProjectPluginChoices,
  waitForRuntime: async () => undefined,
  consentToPlugin,
  setProjectPluginVersion,
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
  pluginChoices = [];
  createProject.mockClear();
  createConversation.mockClear();
  consentToPlugin.mockClear();
  setProjectPluginVersion.mockClear();
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
  // Each option's name, without the line on what the type is for.
  const options = [...document.querySelectorAll('[role="option"] .ui-option-text > span')].map(
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
      "Tile Map",
      "More types…",
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
    // A plugin that works only in some of the app's types leaves plugins' own types out.
    expect(await typeOptions()).toEqual(["Godot", "General Game", "More types…"]);

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

  it("creates the type chosen on Home, a plugin's included, and turns on the plugins chosen for it", async () => {
    const onCreated = vi.fn();
    const tools = { id: "acme/tools", displayName: "Tools", description: "", version: "1.2.0", capabilities: ["network:tools.example.com"], consented: false, providesTypes: [] };
    const tiles = { id: "acme/tiles", displayName: "Tiles", description: "", version: "2.1.0", capabilities: [], consented: true, providesTypes: ["acme/tiles:map"] };
    await act(async () => root.render(
      <ProjectCreateDialog firstMessage={{ prompt: "Make a map", mentions: [], attachments: [], mode: "normal", type: "acme/tiles:map", projectPlugins: [tools, tiles] }}
        onClose={() => {}} onCreated={onCreated} />,
    ));
    expect(typeSelect().textContent).toBe("Tile Map");
    await act(async () => button("Create and start").click());
    expect(createProject).toHaveBeenCalledWith({ projectType: "acme/tiles:map" });
    // What the person allowed on Home is granted now; the type's own plugin is on already.
    expect(consentToPlugin).toHaveBeenCalledWith("acme/tools", ["network:tools.example.com"]);
    expect(setProjectPluginVersion.mock.calls).toEqual([["maze", "acme/tools", "1.2.0"]]);
    expect(onCreated).toHaveBeenCalled();
  });

  it("allows what a type's plugin asks for when creating the type, once its types have loaded", async () => {
    let types!: (value: Awaited<ReturnType<typeof listProjectTypes>>) => void;
    listProjectTypes.mockImplementationOnce(() => new Promise((resolve) => { types = resolve; }));
    pluginChoices = [{ id: "acme/tiles", displayName: "Tiles", description: "", version: "2.1.0", capabilities: ["processes:tiled"], consented: false, providesTypes: ["acme/tiles:map"] }];
    await act(async () => root.render(
      <ProjectCreateDialog firstMessage={{ prompt: "Make a map", mentions: [], attachments: [], mode: "normal", type: "acme/tiles:map" }}
        onClose={() => {}} onCreated={() => {}} />,
    ));
    // Home's plugin type is not in the menu yet, so creating would make another type.
    expect(button("Create and start").disabled).toBe(true);
    await act(async () => types([{ id: "acme/tiles:map", title: "Tile Map", plugin: { id: "acme/tiles", version: "2.1.0" } }]));
    expect(typeSelect().textContent).toBe("Tile Map");
    expect(document.querySelector(".new-project-consent")!.textContent).toContain("processes:tiled");
    await act(async () => button("Create and start").click());
    expect(consentToPlugin).toHaveBeenCalledWith("acme/tiles", ["processes:tiled"]);
    expect(consentToPlugin.mock.invocationCallOrder[0]!).toBeLessThan(createProject.mock.invocationCallOrder[0]!);
    expect(createProject).toHaveBeenCalledWith({ projectType: "acme/tiles:map" });
  });

  it("allows a type's plugin that asks for nothing, and offers a retry when types fail to load", async () => {
    listProjectTypes.mockRejectedValueOnce(new Error("offline"));
    pluginChoices = [{ id: "acme/tiles", displayName: "Tiles", description: "", version: "2.1.0", capabilities: [], consented: false, providesTypes: ["acme/tiles:map"] }];
    await act(async () => root.render(
      <ProjectCreateDialog firstMessage={{ prompt: "Make a map", mentions: [], attachments: [], mode: "normal", type: "acme/tiles:map" }}
        onClose={() => {}} onCreated={() => {}} />,
    ));
    // Creating would make another type than Home's.
    expect(button("Create and start").disabled).toBe(true);
    await act(async () => button("Retry").click());
    expect(typeSelect().textContent).toBe("Tile Map");
    await act(async () => button("Create and start").click());
    expect(consentToPlugin).toHaveBeenCalledWith("acme/tiles", []);
    expect(createProject).toHaveBeenCalledWith({ projectType: "acme/tiles:map" });
  });

  it("waits for what a type's plugin asks for, with a retry when that fails to load", async () => {
    listProjectPluginChoices.mockRejectedValueOnce(new Error("offline"));
    pluginChoices = [{ id: "acme/tiles", displayName: "Tiles", description: "", version: "2.1.0", capabilities: ["processes:tiled"], consented: false, providesTypes: ["acme/tiles:map"] }];
    await act(async () => root.render(
      <ProjectCreateDialog firstMessage={{ prompt: "Make a map", mentions: [], attachments: [], mode: "normal", type: "acme/tiles:map" }}
        onClose={() => {}} onCreated={() => {}} />,
    ));
    expect(button("Create and start").disabled).toBe(true);
    await act(async () => button("Retry").click());
    expect(document.querySelector(".new-project-consent")!.textContent).toContain("processes:tiled");
    expect(button("Create and start").disabled).toBe(false);
  });

  it("turns on the Godot plugin chosen on Home in the app's Godot type, which does not turn it on", async () => {
    capabilities = { plugins: [{ ...godotPlugin, projectTypes: [...godotPlugin.projectTypes] }], skills: [] };
    const godotV2 = { id: "ohmygame/godot", displayName: "Godot", description: "", version: "1.0.0", capabilities: [], consented: true, providesTypes: ["ohmygame/godot:godot-game"] };
    await act(async () => root.render(
      <ProjectCreateDialog firstMessage={{ prompt: "Make a maze", mentions: [], attachments: [], mode: "normal", type: "godot-game", projectPlugins: [godotV2] }}
        onClose={() => {}} onCreated={() => {}} />,
    ));
    await act(async () => button("Create and start").click());
    expect(createProject).toHaveBeenCalledWith({ type: "godot-game" });
    expect(setProjectPluginVersion).toHaveBeenCalledWith("maze", "ohmygame/godot", "1.0.0");
  });

  it("leaves for the plugins that add project types from More types…", async () => {
    const onClose = vi.fn();
    await act(async () => root.render(<ProjectCreateDialog onClose={onClose} onCreated={() => {}} />));
    await act(async () => typeSelect().click());
    const more = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.includes("More types…"))!;
    await act(async () => more.click());
    expect(onClose).toHaveBeenCalled();
    expect(window.location.hash).toBe("#/plugins?adds=projectType");
    expect(createProject).not.toHaveBeenCalled();
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
