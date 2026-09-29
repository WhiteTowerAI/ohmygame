import { describe, expect, it } from "vitest";
import { playableElementContext, playableSurfaceContext, playableSurfaceReferences } from "../src/shared/playable-chat-context.js";
import { createNodeGraphFixture } from "./playable-fixture.js";

describe("Playable chat context", () => {
  it("describes an open Node with its sources, Signals, and Assets", () => {
    const context = playableSurfaceContext(createNodeGraphFixture(), { kind: "node", nodeId: "menu" });

    expect(context?.label).toBe("Main menu");
    expect(context?.text).toContain('Node "menu" (Main menu) open in the Playable editor. It is the Entry Node.');
    expect(context?.text).toContain("Sources: nodes/menu/index.html, nodes/menu/style.css, nodes/menu/node.js");
    expect(context?.text).toContain('- start "Start" → lobby (replace)');
    expect(context?.text).toContain("Assets: background (image)");
  });

  it("describes the Shell and returns nothing for a missing surface", () => {
    const graph = createNodeGraphFixture();
    const shell = playableSurfaceContext(graph, { kind: "shell" });
    expect(shell?.label).toBe("Overlay");
    expect(shell?.text).toContain('- home "Home" → menu (replace)');
    expect(shell?.text).toContain('- archive "Archive" → archive (replace)');
    expect(playableSurfaceContext(graph, { kind: "node", nodeId: "gone" })).toBeUndefined();
    expect(playableSurfaceContext({ ...graph, shell: undefined }, { kind: "shell" })).toBeUndefined();
  });

  it("references the surface's source files", () => {
    expect(playableSurfaceReferences(createNodeGraphFixture(), { kind: "shell" })).toEqual([
      { type: "workspace-file", path: "shell/index.html" },
      { type: "workspace-file", path: "shell/style.css" },
      { type: "workspace-file", path: "shell/shell.js" },
    ]);
  });

  it("locates a picked element by source, or by CSS path when a script created it", () => {
    const pick = { nodeId: "menu", cssPath: "main > button:nth-of-type(2)", tag: "button", text: "Start", box: { x: 10.4, y: 19.6, width: 100, height: 40.2 } };

    const scripted = playableElementContext(pick);
    expect(scripted.label).toBe('<button> "Start"');
    expect(scripted.text).toContain("Source: created by script");
    expect(scripted.text).toContain("x 10, y 20, 100×40");

    expect(playableElementContext({ ...pick, source: "nodes/menu/index.html:4:3" }).text).toContain("Source: nodes/menu/index.html:4:3");
    expect(playableElementContext({ ...pick, nodeId: "shell" }).text).toContain("preview of the Shell");
  });
});
