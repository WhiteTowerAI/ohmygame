import { describe, expect, it } from "vitest";
import { defaultProjectName, PROJECT_TYPES, projectTypeLabel } from "../src/renderer/project-types.js";

describe("project types", () => {
  it("keeps the shared labels and display order", () => {
    expect(PROJECT_TYPES).toEqual([
      { label: "Web Game", value: "web-game" },
      { label: "Asset Canvas", value: "asset-canvas" },
      { label: "Godot", value: "godot-game" },
      { label: "General Game", value: "general" },
    ]);
  });

  it("provides labels and default names", () => {
    expect(projectTypeLabel("general")).toBe("General Game");
    expect(defaultProjectName("general")).toBe("Untitled project");
    expect(defaultProjectName("web-game")).toBe("Untitled project");
  });
});
