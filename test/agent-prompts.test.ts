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

  it("gives Interactive Drama agents the Playable Nodes contract and verification duty", () => {
    const prompt = appendSystemPromptForProject("interactive-drama").join("\n\n");

    expect(prompt).toContain("Playable Nodes creation agent");
    expect(prompt).toContain("graph.json");
    expect(prompt).toContain("compile every Node and Shell");
    expect(prompt).toContain("Playtest");
    expect(prompt).toContain("do not recreate legacy Story node types");
  });
});
