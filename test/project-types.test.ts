import { describe, expect, it } from "vitest";
import { defaultProjectName, GAME_PROJECT_TYPES, PROJECT_TYPES, projectTypeLabel } from "../src/renderer/project-types.js";

describe("project types", () => {
  it("keeps the shared labels and display order", () => {
    expect(PROJECT_TYPES).toEqual([
      { label: "General Game", value: "general" },
      { label: "Web Game", value: "web-game" },
      { label: "Interactive Story", value: "interactive-story" },
      { label: "Asset Canvas", value: "asset-canvas" },
      { label: "Godot", value: "godot-game" },
    ]);
  });

  it("keeps Asset Canvas out of the home game types", () => {
    expect(GAME_PROJECT_TYPES.map(({ value }) => value)).toEqual(["general", "web-game", "interactive-story", "godot-game"]);
  });

  it("provides labels and default names", () => {
    expect(projectTypeLabel("general")).toBe("General Game");
    expect(defaultProjectName("general")).toBe("Untitled project");
    expect(projectTypeLabel("interactive-story")).toBe("Interactive Story");
    expect(defaultProjectName("interactive-story")).toBe("Untitled story");
    expect(defaultProjectName("web-game")).toBe("Untitled project");
  });
});
