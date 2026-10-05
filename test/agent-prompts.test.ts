import { describe, expect, it } from "vitest";
import { appendSystemPromptForProject } from "../src/daemon/agent-prompts.js";

function prompt(project: Parameters<typeof appendSystemPromptForProject>[0]): string {
  return appendSystemPromptForProject(project).join("\n\n");
}

describe("OhMyGame system prompt", () => {
  it("preserves shared interaction guidance for every project type", () => {
    for (const type of ["web-game", "godot-game", "interactive-story", "asset-canvas"] as const) {
      const text = prompt({ type });

      expect(text).toContain("brief commentary update before the first tool call");
      expect(text).toContain("update_plan");
      expect(text).toContain("Do not create or change files for casual conversation");
      expect(text).toContain("do not revert changes you did not make");
      expect(text).toContain("its main document before implementing game changes");
      expect(text).not.toContain("may be empty");
    }
  });

  it("carries the Web Game platform contract in the system prompt", () => {
    const text = prompt({ type: "web-game" });

    expect(text).toContain("create and evolve browser games");
    expect(text).toContain("smallest reliable change");
    expect(text).toContain("OhMyGame owns the dev server");
    expect(text).toContain("inside an iframe of any size");
    expect(text).toContain("__OHMYGAME_PLAYTEST__");
    expect(text).toContain("the workspace root");
    expect(text).toContain('a "dev" script and a "build" script');
    expect(text).toContain("--host 127.0.0.1 --port <port> --strictPort");
    expect(text).toContain("dist/, build/, or out/");
    expect(text).toContain("missing from the published build");
    expect(text).not.toContain("playable_check");
    expect(text).not.toContain("existing folder as the workspace");
  });

  it("explains how an explicitly referenced design revision should be used", () => {
    const text = prompt({ type: "web-game" });

    expect(text).toContain("explicitly referenced snapshot and revision");
    expect(text).toContain("as the design context for that turn");
    expect(text).toContain("design/documents/<id>.md and are editable Markdown sources");
  });

  it("describes the configured run settings and external workspaces", () => {
    const text = prompt({ type: "web-game", startupDirectory: "client", startupScript: "start", packageManager: "pnpm", workspaceLocation: "external" });

    expect(text).toContain("the client/ folder of the workspace, run with pnpm");
    expect(text).toContain('a "start" script');
    expect(text).toContain('Preview runs the "start" script');
    expect(text).toContain("existing folder as the workspace");
  });

  it("tells the Interactive Story agent how to build, use media in, and check Playable Nodes", () => {
    const text = prompt({ type: "interactive-story" });

    expect(text).toContain("playable_add_node");
    expect(text).toContain("playable_check");
    expect(text).toContain('mode "publish"');
    expect(text).toContain('"kind": "workspace"');
    expect(text).toContain("viewport from graph.json");
    expect(text).toContain("<editor-context>");
    expect(text).toContain("drawing");
    expect(text).not.toContain("create and evolve browser games");
    expect(text).not.toContain("OhMyGame owns the dev server");
  });
});
