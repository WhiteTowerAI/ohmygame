// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { closePanel, movePanel, showPanel, visiblePanels, type Layout } from "../src/renderer/panel-layout.js";
import { fitLayout, openingLayout, panelsOf, presetLayout, saveLayout, workspaceKind } from "../src/renderer/workspace-layout.js";

const tabs = (layout: Layout) => Object.fromEntries(Object.entries(layout).map(([area, value]) => [area, value.panels.map((id) => id === value.active ? `*${id}` : id).join(",")]));

beforeEach(() => localStorage.clear());

describe("workspace layouts", () => {
  it("offers each project type its own panels", () => {
    const web = { type: "web-game", webPreviewEnabled: true } as const;
    expect(workspaceKind(web)).toBe("game");
    expect(panelsOf(web)).toEqual(["chat", "game", "design", "code", "assets"]);
    // A General project without a preview has no game panel and opens on its code.
    expect(panelsOf({ type: "general" })).toEqual(["chat", "design", "code", "assets"]);
    expect(tabs(presetLayout("game", "default", panelsOf({ type: "general" }))).center).toBe("*code,design,assets");
    expect(workspaceKind({ type: "godot-game" })).toBe("engine");
    expect(workspaceKind({ type: "godot-game", pluginType: { preview: "web-build" } } as never)).toBe("game");
    expect(tabs(presetLayout("engine", "default"))).toMatchObject({ left: "", center: "*chat,design,code,assets" });
    expect(panelsOf({ type: "interactive-story" })).toEqual(["chat", "story"]);
    expect(panelsOf({ type: "asset-canvas" })).toEqual(["chat", "canvas"]);
  });

  it("opens with the saved arrangement, or the chat where the old setting put it", () => {
    expect(tabs(openingLayout("game", ["chat", "game"]).layout)).toMatchObject({ left: "*chat", right: "" });
    localStorage.setItem("ohmygame:chat-layout", "right");
    const right = openingLayout("story", ["chat", "story"]).layout;
    expect(tabs(right)).toMatchObject({ left: "", right: "*chat", center: "*story" });
    expect(right.right.size).toBe(right.left.size);
    saveLayout("story", { layout: presetLayout("story", "default"), known: ["chat", "story"] });
    expect(tabs(openingLayout("story", ["chat", "story"]).layout).left).toBe("*chat");
  });

  it("fits a saved layout to the panels a project offers", () => {
    const fallback = presetLayout("game", "default");
    const closed = closePanel(movePanel(fallback, "code", "right"), "assets");
    const saved = { layout: closed, known: ["chat", "game", "design", "code", "assets"] };
    // Closed panels stay closed; a panel the project doesn't offer goes, and its area shows the default's tab.
    expect(tabs(fitLayout(saved, ["chat", "game", "design", "code", "assets"], fallback))).toMatchObject({ center: "*game,design", right: "*code" });
    expect(tabs(fitLayout(saved, ["chat", "design", "code", "assets"], fallback)).center).toBe("*design");
    // A panel the layout never knew opens where the default puts it.
    expect(tabs(fitLayout({ ...saved, known: ["chat", "design", "code", "assets"] }, ["chat", "game", "design", "code", "assets"], fallback)).center).toBe("*game,design");
  });

  it("moves, closes and shows panels", () => {
    const layout = presetLayout("game", "default");
    const moved = movePanel(layout, "chat", "right");
    expect(tabs(moved)).toMatchObject({ left: "", right: "*chat" });
    expect(tabs(closePanel(layout, "game")).center).toBe("*design,code,assets");
    expect(tabs(showPanel(closePanel(layout, "game"), "game", "center")).center).toBe("design,code,assets,*game");
    expect(visiblePanels(moved, new Set(["chat", "game", "code"])).sort()).toEqual(["chat", "game"]);
  });
});
