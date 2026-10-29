// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closePanel, createPanelNodes, movePanel, PanelLayout, PanelMount, showPanel, visiblePanels, type Layout, type PanelDef } from "../src/renderer/panel-layout.js";
import { fitLayout, mergeLayout, openingLayout, panelsOf, presetLayout, presetsFor, saveLayout, type WorkspacePanel } from "../src/renderer/workspace-layout.js";

const tabs = (layout: Layout) => Object.fromEntries(Object.entries(layout).map(([area, value]) => [area, value.panels.map((id) => id === value.active ? `*${id}` : id).join(",")]));
const GAME: WorkspacePanel[] = ["chat", "game", "design", "code", "assets"];
const STORY: WorkspacePanel[] = ["chat", "story"];

beforeEach(() => localStorage.clear());

describe("workspace layouts", () => {
  it("offers each project type its panels in one default layout", () => {
    expect(panelsOf({ type: "web-game", webPreviewEnabled: true })).toEqual(GAME);
    expect(tabs(presetLayout("default", GAME))).toMatchObject({ left: "*chat", center: "*game,design,code,assets", right: "" });
    // Without a preview there is no game, and the project opens on its code.
    const general = panelsOf({ type: "general" });
    expect(general).toEqual(["chat", "design", "code", "assets"]);
    expect(tabs(presetLayout("default", general)).center).toBe("*code,design,assets");
    expect(panelsOf({ type: "godot-game" })).toEqual(general);
    expect(panelsOf({ type: "godot-game", pluginType: { preview: "web-build" } } as never)).toEqual(GAME);
    expect(tabs(presetLayout("default", STORY))).toMatchObject({ left: "*chat", center: "*story" });
    expect(presetsFor(GAME)).toEqual(["default", "art", "code"]);
    expect(presetsFor(STORY)).toEqual(["default"]);
    expect(tabs(presetLayout("art", GAME)).center).toBe("*design,game,code,assets");
  });

  it("opens with the saved arrangement, or the chat where the old setting put it", () => {
    expect(tabs(openingLayout(GAME).layout)).toMatchObject({ left: "*chat", right: "" });
    localStorage.setItem("ohmygame:chat-layout", "right");
    const right = openingLayout(STORY).layout;
    expect(tabs(right)).toMatchObject({ left: "", right: "*chat", center: "*story" });
    expect(right.right.size).toBe(right.left.size);
    saveLayout({ layout: presetLayout("default", GAME), known: GAME });
    expect(tabs(openingLayout(STORY).layout).left).toBe("*chat");
  });

  it("fits the one saved layout to each project's panels", () => {
    const fallback = presetLayout("default", GAME);
    const saved = { layout: closePanel(movePanel(fallback, "code", "right"), "assets"), known: GAME };
    // Closed panels stay closed; a panel the project doesn't offer is left out,
    // and its area shows the default's tab.
    expect(tabs(fitLayout(saved, GAME, fallback))).toMatchObject({ center: "*game,design", right: "*code" });
    const general = ["chat", "design", "code", "assets"] as WorkspacePanel[];
    expect(tabs(fitLayout(saved, general, presetLayout("default", general))).center).toBe("*design");
    // A story's panel, never seen before, opens where the default puts it.
    expect(tabs(fitLayout(saved, STORY, presetLayout("default", STORY)))).toMatchObject({ left: "*chat", center: "*story", right: "" });
  });

  it("opens new panels on the default's front tab", () => {
    // Saved from a story, a Godot project without a preview opens on Code, in
    // the default's order.
    const story = { layout: presetLayout("default", STORY), known: STORY };
    const general = panelsOf({ type: "godot-game" });
    expect(tabs(fitLayout(story, general, presetLayout("default", general))).center).toBe("*code,design,assets");
  });

  it("keeps the other types' panels when a story's layout changes", () => {
    const game = { layout: movePanel(presetLayout("default", GAME), "code", "right"), known: GAME };
    const story = fitLayout(game, STORY, presetLayout("default", STORY));
    const merged = mergeLayout(game, story, movePanel(story, "chat", "right"), STORY);
    expect(merged.known).toEqual(expect.arrayContaining([...GAME, "story"]));
    // Back in a game, the chat follows to the right and Code stays where it was.
    expect(tabs(fitLayout(merged, GAME, presetLayout("default", GAME)))).toMatchObject({ left: "", center: "*game,design,assets", right: "code,*chat" });
  });

  it("keeps a game's front tab when a project without it changes nothing there", () => {
    const game = { layout: presetLayout("default", GAME), known: GAME };
    const general = ["chat", "design", "code", "assets"] as WorkspacePanel[];
    const fitted = fitLayout(game, general, presetLayout("default", general));
    expect(tabs(fitted).center).toBe("design,*code,assets");
    // Bringing Design forward there changes the front tab, but not the order.
    const merged = mergeLayout(game, fitted, showPanel(fitted, "design", "center"), general);
    expect(tabs(merged.layout).center).toBe("game,*design,code,assets");
    // Moving the chat only, the game keeps Game in front.
    const moved = mergeLayout(game, fitted, movePanel(fitted, "chat", "right"), general);
    expect(tabs(moved.layout)).toMatchObject({ center: "*game,design,code,assets", right: "*chat" });
  });

  it("moves, closes and shows panels", () => {
    const layout = presetLayout("default", GAME);
    const moved = movePanel(layout, "chat", "right");
    expect(tabs(moved)).toMatchObject({ left: "", right: "*chat" });
    expect(tabs(closePanel(layout, "game")).center).toBe("*design,code,assets");
    expect(tabs(showPanel(closePanel(layout, "game"), "game", "center")).center).toBe("design,code,assets,*game");
    expect(visiblePanels(moved, new Set(["chat", "game", "code"])).sort()).toEqual(["chat", "game"]);
  });
});

describe("the panel layout", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const game = createPanelNodes();
  const panels: PanelDef[] = [
    { id: "chat", title: "Chat", icon: null, content: "Talk", home: "left" },
    { id: "game", title: "Game", icon: null, content: createElement(PanelMount, { nodes: game }), home: "center" },
    { id: "code", title: "Code", icon: null, content: "Files", home: "right", badge: 2 },
  ];
  const layout: Layout = {
    left: { panels: ["chat"], active: "chat", size: 280 },
    center: { panels: ["game"], active: "game", size: 0 },
    right: { panels: ["code"], active: "code", size: 280 },
    bottom: { panels: [], size: 200 },
  };
  const render = (value: Layout) => act(async () =>
    root.render(createElement(PanelLayout, { layout: value, panels, onChange: () => {}, empty: null })));

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps a closed panel's view in the document and moves it without reloading", async () => {
    const frame = document.createElement("iframe");
    game.body.append(frame);
    const moveBefore = vi.fn(function (this: Element, node: Node) { this.append(node); });
    Object.defineProperty(Element.prototype, "moveBefore", { configurable: true, value: moveBefore });
    try {
      await render(layout);
      expect(container.querySelector(".dock-area-center .dock-mount")?.contains(frame)).toBe(true);
      await render(closePanel(layout, "game"));
      // Closed, the view waits out of reach in the document, so the game keeps running.
      expect(frame.isConnected).toBe(true);
      const parking = frame.closest<HTMLElement>(".dock-parking")!;
      expect(parking.getAttribute("aria-hidden")).toBe("true");
      expect(parking.inert).toBe(true);
      await render(movePanel(layout, "game", "right"));
      expect(container.querySelector(".dock-area-right .dock-mount")?.contains(frame)).toBe(true);
      expect(moveBefore).toHaveBeenCalledWith(game.body, null);
    } finally {
      delete (Element.prototype as { moveBefore?: unknown }).moveBefore;
    }
  });

  it("stacks the areas when the window is too narrow for the sides", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
    await render(layout);
    const dock = container.querySelector<HTMLElement>(".dock")!;
    expect(dock.classList.contains("is-stacked")).toBe(true);
    expect(dock.style.gridTemplateAreas).toBe('"left" "center" "right"');
    expect(container.querySelector(".dock-resizer")).toBeNull();
  });

  it("names every tab, so a narrow area's icon-only tabs still read", async () => {
    await render(layout);
    expect([...container.querySelectorAll('[role="tab"]')].map((tab) => tab.getAttribute("aria-label"))).toEqual(["Chat", "Game", "Code (2)"]);
    expect(container.querySelector(".dock")!.classList.contains("is-stacked")).toBe(false);
  });
});
