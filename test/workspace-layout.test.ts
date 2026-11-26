// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closePanel, createPanelNodes, movePanel, PanelLayout, PanelMount, showPanel, visiblePanels, type Layout, type PanelDef } from "../src/renderer/panel-layout.js";
import { fitLayout, gamePanelAddable, mergeLayout, openingLayout, panelsOf, presetLayout, presetsFor, saveLayout, type WorkspacePanel } from "../src/renderer/workspace-layout.js";

const tabs = (layout: Layout) => Object.fromEntries(Object.entries(layout).map(([area, value]) => [area, value.panels.map((id) => id === value.active ? `*${id}` : id).join(",")]));
const GAME: WorkspacePanel[] = ["chat", "game", "design", "canvas", "code", "assets"];
const GENERAL: WorkspacePanel[] = ["chat", "design", "canvas", "code", "assets"];

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
    // A General project can add the game back, where it then says how to turn the preview on.
    expect(gamePanelAddable({ type: "general" })).toBe(true);
    expect(panelsOf({ type: "general" }, true)).toEqual(GAME);
    for (const project of [{ type: "general", webPreviewEnabled: true }, { type: "general", pluginType: { preview: "native" } }, { type: "godot-game" }, { type: "asset-canvas" }] as never[]) {
      expect(gamePanelAddable(project)).toBe(false);
    }
    expect(panelsOf({ type: "general", pluginType: { preview: "native" } } as never, true)).toEqual(GENERAL);
    expect(panelsOf({ type: "godot-game", pluginType: { preview: "web-build" } } as never)).toEqual(GAME);
    expect(presetsFor(GAME)).toEqual(["default", "art", "code"]);
    expect(tabs(presetLayout("code", GAME)).center).toBe("*code,game,design,canvas,assets");
    expect(presetsFor(["chat", "canvas"])).toEqual(["default"]);
    // An asset canvas opens on its canvas, with its files in a Code panel.
    const canvas = panelsOf({ type: "asset-canvas" });
    expect(canvas).toEqual(["chat", "canvas", "code"]);
    expect(tabs(presetLayout("default", canvas)).center).toBe("*canvas,code");
    // Art brings the canvas forward, not the design document.
    expect(tabs(presetLayout("art", GAME)).center).toBe("*canvas,game,design,code,assets");
  });

  it("opens with the saved arrangement, or the chat where the old setting put it", () => {
    expect(tabs(openingLayout(GAME).layout)).toMatchObject({ left: "*chat", right: "" });
    localStorage.setItem("ohmygame:chat-layout", "right");
    const right = openingLayout(GAME).layout;
    expect(tabs(right)).toMatchObject({ left: "", right: "*chat", center: "*game,design,canvas,code,assets" });
    expect(right.right.size).toBe(right.left.size);
    saveLayout({ layout: presetLayout("default", GAME), known: GAME });
    expect(tabs(openingLayout(GENERAL).layout).left).toBe("*chat");
  });

  it("fits the one saved layout to each project's panels", () => {
    const fallback = presetLayout("default", GAME);
    const saved = { layout: closePanel(movePanel(fallback, "code", "right"), "assets"), known: GAME };
    // Closed panels stay closed; a panel the project doesn't offer is left out,
    // and its area shows the default's tab.
    expect(tabs(fitLayout(saved, GAME, fallback))).toMatchObject({ center: "*game,design,canvas", right: "*code" });
    expect(tabs(fitLayout(saved, GENERAL, presetLayout("default", GENERAL))).center).toBe("*design,canvas");
    // A game's panel, never seen before, opens where the default puts it; the
    // panels it shares with the other types stay where they were.
    const withoutGame = { layout: closePanel(movePanel(presetLayout("default", GENERAL), "code", "right"), "assets"), known: GENERAL };
    expect(tabs(fitLayout(withoutGame, GAME, fallback))).toMatchObject({ left: "*chat", center: "*design,canvas,game", right: "*code" });
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

  it("leaves a plugin's on-request panel out until it is opened, then keeps it where it was put", () => {
    const tests = "plugin:acme/tests:tests" as const;
    const homes = { [tests]: "right" } as const;
    const onRequest = new Set([tests]);
    const offered = [...GAME, tests];
    const fallback = presetLayout("default", offered, homes, onRequest);
    expect(tabs(fallback).right).toBe("");
    expect(tabs(openingLayout(offered, homes, onRequest).layout).right).toBe("");
    // A saved layout from before the plugin doesn't take it in either.
    const before = { layout: presetLayout("default", GAME), known: GAME };
    const fitted = fitLayout(before, offered, fallback, onRequest);
    expect(tabs(fitted).right).toBe("");
    // Opened from a command or the panel menu, it stays open.
    const opened = mergeLayout(before, fitted, showPanel(fitted, tests, "right"), offered);
    expect(tabs(fitLayout(opened, offered, fallback, onRequest)).right).toBe(`*${tests}`);
  });

  it("opens new panels on the default's front tab", () => {
    // Saved when stories had a Story map, which OhMyGame no longer has, a
    // Godot project without a preview opens on Code.
    const older = ["chat", "story"] as never as WorkspacePanel[];
    const story = { layout: presetLayout("default", older), known: older };
    const general = panelsOf({ type: "godot-game" });
    expect(tabs(fitLayout(story, general, presetLayout("default", general))).center).toBe("*code,design,canvas,assets");
  });

  it("keeps the other types' panels when a General project's layout changes", () => {
    const game = { layout: movePanel(presetLayout("default", GAME), "code", "right"), known: GAME };
    const general = fitLayout(game, GENERAL, presetLayout("default", GENERAL));
    const merged = mergeLayout(game, general, movePanel(general, "chat", "right"), GENERAL);
    expect(merged.known).toEqual(expect.arrayContaining(GAME));
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
