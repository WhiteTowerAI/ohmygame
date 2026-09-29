import { describe, expect, it } from "vitest";
import { playableElementContext, playableNodeContext, playableNodeReferences } from "../src/shared/playable-chat-context.js";
import { createNodeGraphFixture } from "./playable-fixture.js";

describe("Playable chat context", () => {
  it("describes an open Node with its sources, Signals, and Assets", () => {
    const context = playableNodeContext(createNodeGraphFixture(), "menu");

    expect(context?.label).toBe("Main menu");
    expect(context?.text).toContain('Node "menu" (Main menu) open in the Playable editor. It is the Entry Node.');
    expect(context?.text).toContain("Sources: nodes/menu/index.html, nodes/menu/style.css, nodes/menu/node.js");
    expect(context?.text).toContain('- start "Start" → lobby (replace)');
    expect(context?.text).toContain("Assets: background (image)");
  });

  it("lists a shared component's Signals as the Node's own, and returns nothing for a missing Node", () => {
    const graph = createNodeGraphFixture();
    const lobby = playableNodeContext(graph, "lobby");
    expect(lobby?.label).toBe("Lobby");
    expect(lobby?.text).toContain('- home "Home" → menu (replace)');
    expect(lobby?.text).toContain('- archive "Archive" → archive (replace)');
    expect(playableNodeContext(graph, "gone")).toBeUndefined();
  });

  it("references the Node's source files", () => {
    expect(playableNodeReferences(createNodeGraphFixture(), "archive")).toEqual([
      { type: "workspace-file", path: "nodes/archive/index.html" },
      { type: "workspace-file", path: "nodes/archive/style.css" },
      { type: "workspace-file", path: "nodes/archive/node.js" },
    ]);
    expect(playableNodeReferences(createNodeGraphFixture(), "gone")).toEqual([]);
  });

  it("locates a picked element by source, or by CSS path when a script created it", () => {
    const pick = { nodeId: "menu", cssPath: "main > button:nth-of-type(2)", tag: "button", text: "Start", box: { x: 10.4, y: 19.6, width: 100, height: 40.2 } };

    const scripted = playableElementContext(pick);
    expect(scripted.label).toBe('<button> "Start"');
    expect(scripted.text).toContain("Source: created by script");
    expect(scripted.text).toContain("x 10, y 20, 100×40");

    expect(playableElementContext({ ...pick, source: "nodes/menu/index.html:4:3" }).text).toContain("Source: nodes/menu/index.html:4:3");
    expect(scripted.text).toContain('preview of Node "menu"');
  });
});
