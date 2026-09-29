import { describe, expect, it } from "vitest";
import { appendSystemPromptForProject } from "../src/daemon/agent-prompts.js";

describe("OhMyGame system prompt", () => {
  it("preserves shared interaction guidance for every project type", () => {
    for (const projectType of ["web-game", "godot-game", "interactive-drama"] as const) {
      const prompt = appendSystemPromptForProject(projectType).join("\n\n");

      expect(prompt).toContain("brief commentary update before the first tool call");
      expect(prompt).toContain("use update_plan");
      expect(prompt).toContain("Do not create files for casual conversation");
    }
  });

  it("adds game-making guidance only to Web Game projects", () => {
    const webGamePrompt = appendSystemPromptForProject("web-game").join("\n\n");
    const otherProjectPrompts = (["godot-game", "interactive-drama"] as const)
      .map((projectType) => appendSystemPromptForProject(projectType).join("\n\n"));

    expect(webGamePrompt).toContain("create and evolve games");
    expect(webGamePrompt).toContain("preserving existing work");
    expect(webGamePrompt).toContain("smallest reliable change");
    for (const prompt of otherProjectPrompts) {
      expect(prompt).not.toContain("create and evolve games");
      expect(prompt).not.toContain("smallest reliable change");
    }
  });

  it("tells the Interactive Drama agent how to build and check Playable Nodes", () => {
    const prompt = appendSystemPromptForProject("interactive-drama").join("\n\n");

    expect(prompt).toContain("playable_add_node");
    expect(prompt).toContain("playable_check");
    expect(prompt).toContain("game_use");
    expect(prompt).toContain("<editor-context>");
    expect(appendSystemPromptForProject("web-game").join("\n\n")).not.toContain("playable_check");
  });
});
