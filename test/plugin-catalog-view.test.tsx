// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginSummary } from "../src/shared/plugins.js";
import { PluginsSettings } from "../src/renderer/plugins.js";

function plugin(
  name: string,
  displayName: string,
  enabled = true,
  personal = false,
): PluginSummary {
  return {
    id: `${personal ? "personal" : "ohmygame"}:${name}`,
    name,
    displayName,
    description: "Fixture tool",
    enabled,
    installed: true,
    source: { type: personal ? "directory" : "builtIn" },
    marketplace: {
      id: personal ? "personal" : "ohmygame",
      displayName: personal ? "Personal" : "OhMyGame",
    },
    icon: { type: "preset", id: "package" },
  };
}

let container: HTMLDivElement, root: ReturnType<typeof createRoot>;
let catalog: PluginSummary[];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  catalog = [
    plugin("game-studio", "Game Studio"),
    plugin("web-game-studio", "Web Game Studio"),
    plugin("threejs-world", "Three.js World"),
    plugin("godot", "Godot"),
    plugin("taptap-maker", "TapTap Maker", false),
    plugin("cocos-creator", "Cocos Creator", false),
    plugin("unity", "Unity", false),
    plugin("unreal-engine", "Unreal Engine", false),
    plugin("wechat-minigame", "WeChat Mini Games", false),
    plugin("douyin-minigame", "Douyin Mini Games", false),
    plugin("blender", "Blender"),
    plugin("img2threejs", "Image to Three.js"),
    plugin("aseprite", "Aseprite", false),
    plugin("tiled", "Tiled", false),
    plugin("new-tool", "New tool"),
    plugin("zebra", "Zebra", true, true),
    plugin("alpha", "Alpha", false, true),
  ].reverse();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init: RequestInit = {}) => {
      const route = new URL(String(url), "http://localhost").pathname.replace(
        /^\/api/,
        "",
      );
      if (route === "/health") return Response.json({ status: "ok" });
      if (route === "/plugins/setup-sessions") return Response.json([]);
      if (route === "/plugins")
        return Response.json({ plugins: catalog, errors: [] });
      if (init.method === "PUT" && route.endsWith("/settings")) {
        const id = decodeURIComponent(
          route.slice("/plugins/".length, -"/settings".length),
        );
        const item = catalog.find((plugin) => plugin.id === id)!;
        item.enabled = JSON.parse(String(init.body)).enabled;
        return Response.json({ ...item, skills: [], connections: [] });
      }
      throw new Error(`Unexpected request: ${route}`);
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderCatalog() {
  await act(async () =>
    root.render(
      <PluginsSettings
        onPluginChange={() => {}}
        onTryPlugin={async () => {}}
      />,
    ),
  );
}
function cards(parent: ParentNode = container) {
  return [...parent.querySelectorAll(".plugin-card-title strong")].map(
    (item) => item.textContent,
  );
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (button) =>
      button.textContent === label ||
      button.getAttribute("aria-label") === label,
  )!;
  expect(button, label).toBeTruthy();
  await act(async () => button.click());
}
async function search(value: string) {
  const input = container.querySelector<HTMLInputElement>(
    '[aria-label="Search plugins"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("plugin catalog browsing", () => {
  it("groups public plugins in curated order and retains unknown plugins", async () => {
    await renderCatalog();
    const sections = [...container.querySelectorAll(".plugins-installed")];
    expect(
      sections.map((section) => section.querySelector("h2")?.textContent),
    ).toEqual([
      "Game creation 3",
      "Engines & platforms 7",
      "Art & assets 4",
      "Other plugins 1",
    ]);
    expect(cards(sections[0])).toEqual([
      "Game Studio",
      "Web Game Studio",
      "Three.js World",
    ]);
    expect(cards(sections[1])).toEqual([
      "Godot",
      "TapTap Maker",
      "Cocos Creator",
      "Unity",
      "Unreal Engine",
      "WeChat Mini Games",
    ]);
    expect(cards(sections[2])).toEqual([
      "Blender",
      "Image to Three.js",
      "Aseprite",
      "Tiled",
    ]);
    expect(cards()).not.toContain("Alpha");
  });

  it("expands and collapses an individual group", async () => {
    await renderCatalog();
    await click("View all (7)");
    expect(cards()).toContain("Douyin Mini Games");
    await click("Show less");
    expect(cards()).not.toContain("Douyin Mini Games");
    expect(cards()).toContain("Tiled");
  });

  it("keeps enabled and disabled cards in place when toggled", async () => {
    await renderCatalog();
    const before = cards();
    await click("Disable Godot");
    expect(cards()).toEqual(before);
    expect(
      container.querySelector('[aria-label="Enable Godot"]'),
    ).not.toBeNull();
    await click("Enable Godot");
    expect(cards()).toEqual(before);
  });

  it("searches every plugin without group expansion", async () => {
    await renderCatalog();
    await search("Mini Games");
    expect(cards()).toEqual(["WeChat Mini Games", "Douyin Mini Games"]);
    expect(container.querySelectorAll(".plugins-installed h2")).toHaveLength(0);
    expect(container.querySelector(".plugins-show-more")).toBeNull();
    await search("missing tool");
    expect(cards()).toEqual([]);
    expect(container.textContent).toContain("No plugins in this collection.");
  });

  it("switches source tabs with keyboard support and sorts personal plugins by name", async () => {
    await renderCatalog();
    const tabs = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ];
    tabs[0].focus();
    await act(async () =>
      tabs[0].dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      ),
    );
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(cards()).toEqual(["Alpha", "Zebra"]);
    await act(async () =>
      tabs[1].dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
      ),
    );
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(cards()).not.toContain("Zebra");
  });
});
