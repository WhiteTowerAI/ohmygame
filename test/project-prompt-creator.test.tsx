import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composerDrafts, homeDraftScope } from "../src/renderer/composer-drafts.js";
import { ProjectPromptCreator, workspaceFolderName } from "../src/renderer/project-prompt-creator.js";

function render(): string {
  return renderToStaticMarkup(<ProjectPromptCreator draftKey="home" projectType="web-game" placeholder="Describe the game" onCreate={() => undefined} />);
}

describe("project prompt creator workspace", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("defaults to a new managed folder when the desktop folder picker is available", () => {
    vi.stubGlobal("window", { ohMyGameDesktop: { selectProjectDirectory: async () => undefined } });
    const html = render();
    expect(html).toContain("New folder");
    expect(html).toContain('aria-label="Workspace: new folder in OhMyGame storage"');
  });

  it("hides the workspace selector without the desktop folder picker", () => {
    vi.stubGlobal("window", {});
    expect(render()).not.toContain("New folder");
  });

  it("restores the unsent prompt after returning to its start page", () => {
    vi.stubGlobal("window", {});
    composerDrafts.get(homeDraftScope("home")).update({ prompt: "A tiny racing game" });
    expect(render()).toContain("A tiny racing game");
    composerDrafts.get(homeDraftScope("home")).update({ prompt: "" });
  });

  it("labels external workspaces by folder name", () => {
    expect(workspaceFolderName("/Users/me/Games/space-race")).toBe("space-race");
    expect(workspaceFolderName("/Users/me/Games/space-race/")).toBe("space-race");
    expect(workspaceFolderName("C:\\Games\\space-race")).toBe("space-race");
  });
});
