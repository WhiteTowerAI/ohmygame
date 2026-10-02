import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectPromptCreator, workspaceFolderName } from "../src/renderer/project-prompt-creator.js";

function render(): string {
  return renderToStaticMarkup(<ProjectPromptCreator projectType="web-game" placeholder="Describe the game" onCreate={() => undefined} />);
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

  it("labels external workspaces by folder name", () => {
    expect(workspaceFolderName("/Users/me/Games/space-race")).toBe("space-race");
    expect(workspaceFolderName("/Users/me/Games/space-race/")).toBe("space-race");
    expect(workspaceFolderName("C:\\Games\\space-race")).toBe("space-race");
  });
});
