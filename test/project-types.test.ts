import { describe, expect, it } from "vitest";
import { defaultProjectName, GAME_PROJECT_TYPES, PROJECT_TYPES, projectTypeLabel } from "../src/renderer/project-types.js";

describe("project types", () => {
  it("keeps the shared labels and display order", () => {
    expect(PROJECT_TYPES).toEqual([
      { label: "Web Game", value: "web-game" },
      { label: "Interactive Drama", value: "interactive-drama" },
      { label: "Asset Canvas", value: "asset-canvas" },
      { label: "Godot", value: "godot-game" },
    ]);
  });

  it("keeps Asset Canvas out of the home game types", () => {
    expect(GAME_PROJECT_TYPES.map(({ value }) => value)).toEqual(["web-game", "interactive-drama", "godot-game"]);
  });

  it("provides labels and default names", () => {
    expect(projectTypeLabel("interactive-drama")).toBe("Interactive Drama");
    expect(defaultProjectName("interactive-drama")).toBe("Untitled drama");
    expect(defaultProjectName("web-game")).toBe("Untitled project");
  });
});
