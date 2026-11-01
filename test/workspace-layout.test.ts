// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closePanel, createPanelNodes, movePanel, PanelLayout, PanelMount, showPanel, visiblePanels, type Layout, type PanelDef } from "../src/renderer/panel-layout.js";
import { fitLayout, mergeLayout, openingLayout, panelsOf, presetLayout, presetsFor, saveLayout, type WorkspacePanel } from "../src/renderer/workspace-layout.js";

const tabs = (layout: Layout) => Object.fromEntries(Object.entries(layout).map(([area, value]) => [area, value.panels.map((id) => id === value.active ? `*${id}` : id).join(",")]));
const GAME: WorkspacePanel[] = ["chat", "game", "design", "canvas", "code", "assets"];
const GENERAL: WorkspacePanel[] = ["chat", "design", "canvas", "code", "assets"];
const STORY: WorkspacePanel[] = ["chat", "story", "design", "canvas", "code", "assets"];

beforeEach(() => localStorage.clear());

describe("workspace layouts", () => {
  it("offers each project type its panels in one default layout", () => {
    expect(panelsOf({ type: "web-game", webPreviewEnabled: true })).toEqual(GAME);
    expect(tabs(presetLayout("default", GAME))).toMatchObject({ left: "*chat", center: "*game,design,canvas,code,assets", right: "" });
    // Without a preview there is no game, and the project opens on its code.
    const general = panelsOf({ type: "general" });
    expect(general).toEqual(GENERAL);
    expect(tabs(presetLayout("default", general)).center).toBe("*code,design,canvas,assets");
    expect(panelsOf({ type: "godot-game" })).toEqual(general);
    expect(panelsOf({ type: "godot-game", pluginType: { preview: "web-build" } } as never)).toEqual(GAME);
    // A story opens on its Story map, not its code.
    expect(panelsOf({ type: "interactive-story" })).toEqual(STORY);
    expect(tabs(presetLayout("default", STORY))).toMatchObject({ left: "*chat", center: "*story,design,canvas,code,assets" });
    expect(presetsFor(GAME)).toEqual(["default", "art", "code"]);
    expect(presetsFor(STORY)).toEqual(["default", "art", "code"]);
    expect(tabs(presetLayout("art", STORY)).center).toBe("*canvas,story,design,code,assets");
    expect(tabs(presetLayout("code", STORY)).center).toBe("*code,story,design,canvas,assets");
    expect(presetsFor(["chat", "canvas"])).toEqual(["default"]);
    // An asset canvas opens on its canvas, with Preview and Code beside it.
    const canvas = panelsOf({ type: "asset-canvas" });
    expect(canvas).toEqual(["chat", "canvas", "game", "code"]);
    expect(tabs(presetLayout("default", canvas)).center).toBe("*canvas,game,code");
    // Art brings the canvas forward, not the design document.
    expect(tabs(presetLayout("art", GAME)).center).toBe("*canvas,game,design,code,assets");
  });

  it("opens with the saved arrangement, or the chat where the old setting put it", () => {
    expect(tabs(openingLayout(GAME).layout)).toMatchObject({ left: "*chat", right: "" });
    localStorage.setItem("ohmygame:chat-layout", "right");
    const right = openingLayout(STORY).layout;
    expect(tabs(right)).toMatchObject({ left: "", right: "*chat", center: "*story,design,canvas,code,assets" });
    expect(right.right.size).toBe(right.left.size);
    saveLayout({ layout: presetLayout("default", GAME), known: GAME });
    expect(tabs(openingLayout(STORY).layout).left).toBe("*chat");
  });

  it("fits the one saved layout to each project's panels", () => {
    const fallback = presetLayout("default", GAME);
    const saved = { layout: closePanel(movePanel(fallback, "code", "right"), "assets"), known: GAME };
    // Closed panels stay closed; a panel the project doesn't offer is left out,
    // and its area shows the default's tab.
    expect(tabs(fitLayout(saved, GAME, fallback))).toMatchObject({ center: "*game,design,canvas", right: "*code" });
    expect(tabs(fitLayout(saved, GENERAL, presetLayout("default", GENERAL))).center).toBe("*design,canvas");
    // A story's panel, never seen before, opens where the default puts it, in
    // front; the panels it shares with games stay where they were.
    expect(tabs(fitLayout(saved, STORY, presetLayout("default", STORY)))).toMatchObject({ left: "*chat", center: "design,canvas,*story", right: "*code" });
  });

  it("opens a plugin's panels in the areas it names, and keeps them closed once closed", () => {
    const preview = "plugin:acme/maker:preview" as const;
    const log = "plugin:acme/maker:log" as const;
    const homes = { [preview]: "right", [log]: "bottom" } as const;
    const offered = [...GAME, preview, log];
    const fallback = presetLayout("default", offered, homes);
    expect(tabs(fallback)).toMatchObject({ left: "*chat", center: "*game,design,canvas,code,assets", right: `*${preview}`, bottom: `*${log}` });
    // A saved layout from before the plugin gets its panels where they belong.
    const before = { layout: presetLayout("default", GAME), known: GAME };
    expect(tabs(fitLayout(before, offered, fallback))).toMatchObject({ right: `*${preview}`, bottom: `*${log}` });
    // Closed, the panel stays closed; the plugin turned off, it goes.
    const closed = mergeLayout(before, fitLayout(before, offered, fallback), closePanel(fitLayout(before, offered, fallback), log), offered);
    expect(tabs(fitLayout(closed, offered, fallback)).bottom).toBe("");
    expect(tabs(fitLayout(closed, GAME, presetLayout("default", GAME))).right).toBe("");
  });

  it("opens new panels on the default's front tab", () => {
    // Saved when stories had only the Story map, a story gets its new panels
    // in the default's order, and a Godot project without a preview opens on Code.
    const older: WorkspacePanel[] = ["chat", "story"];
    const story = { layout: presetLayout("default", older), known: older };
    expect(tabs(fitLayout(story, STORY, presetLayout("default", STORY))).center).toBe("*story,design,canvas,code,assets");
    const general = panelsOf({ type: "godot-game" });
    expect(tabs(fitLayout(story, general, presetLayout("default", general))).center).toBe("*code,design,canvas,assets");
  });

  it("keeps the other types' panels when a story's layout changes", () => {
    const game = { layout: movePanel(presetLayout("default", GAME), "code", "right"), known: GAME };
    const story = fitLayout(game, STORY, presetLayout("default", STORY));
    const merged = mergeLayout(game, story, movePanel(story, "chat", "right"), STORY);
    expect(merged.known).toEqual(expect.arrayContaining([...GAME, "story"]));
    // Back in a game, the chat follows to the right and Code stays where it was.
    expect(tabs(fitLayout(merged, GAME, presetLayout("default", GAME)))).toMatchObject({ left: "", center: "*game,design,canvas,assets", right: "code,*chat" });
  });

  it("keeps a game's front tab when a project without it changes nothing there", () => {
    const game = { layout: presetLayout("default", GAME), known: GAME };
    const general = GENERAL;
    const fitted = fitLayout(game, general, presetLayout("default", general));
    expect(tabs(fitted).center).toBe("design,canvas,*code,assets");
    // Bringing Design forward there changes the front tab, but not the order.
    const merged = mergeLayout(game, fitted, showPanel(fitted, "design", "center"), general);
    expect(tabs(merged.layout).center).toBe("game,*design,canvas,code,assets");
    // Moving the chat only, the game keeps Game in front.
    const moved = mergeLayout(game, fitted, movePanel(fitted, "chat", "right"), general);
    expect(tabs(moved.layout)).toMatchObject({ center: "*game,design,canvas,code,assets", right: "*chat" });
  });

  it("moves, closes and shows panels", () => {
    const layout = presetLayout("default", GAME);
    const moved = movePanel(layout, "chat", "right");
    expect(tabs(moved)).toMatchObject({ left: "", right: "*chat" });
    expect(tabs(closePanel(layout, "game")).center).toBe("*design,canvas,code,assets");
    expect(tabs(showPanel(closePanel(layout, "game"), "game", "center")).center).toBe("design,canvas,code,assets,*game");
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
