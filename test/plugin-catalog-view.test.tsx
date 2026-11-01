// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketPlugin, PluginMarketListing, StorePlugin } from "../src/shared/plugins.js";
import { PluginsSettings } from "../src/renderer/plugins.js";

function storePlugin(name: string, displayName: string, overrides: Partial<StorePlugin> = {}): StorePlugin {
  return {
    id: `ohmygame/${name}`,
    version: "1.0.0",
    revision: "a".repeat(64),
    displayName,
    description: "Fixture tool",
    capabilities: [],
    grants: { enabled: true, allowed: [] },
    bundled: true,
    appWide: true,
    examples: [],
    settings: [],
    skills: [],
    adds: { projectTypes: [], panels: [], commands: [], mcpServers: [], tools: 0, skills: 0 },
    ...overrides,
  };
}

function personal(name: string, displayName: string, overrides: Partial<StorePlugin> = {}): StorePlugin {
  return storePlugin(name, displayName, { id: `personal/${name}`, bundled: false, ...overrides });
}

let container: HTMLDivElement, root: ReturnType<typeof createRoot>;
let store: StorePlugin[];
let market: PluginMarketListing;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  market = { status: "off", plugins: [], blocked: [] };
  const off = { grants: { enabled: false, allowed: [] } };
  store = [
    storePlugin("new-tool", "New tool", {
      appliesTo: ["web-game"],
      skills: [{ id: "skills/plan/SKILL.md", name: "plan-game", description: "Plan a game" }],
      adds: { projectTypes: [], panels: [], commands: [], mcpServers: ["Tool"], tools: 0, skills: 1 },
    }),
    personal("zebra", "Zebra", { skills: [{ id: "skills/stripes/SKILL.md", name: "stripes", description: "Stripes" }] }),
    personal("alpha", "Alpha", { grants: { enabled: false, allowed: [] }, skills: [{ id: "skills/publish/SKILL.md", name: "publish-wechat", description: "Publish" }] }),
    storePlugin("game-studio", "Game Studio", { categories: ["workflow"], skills: [{ id: "skills/design/SKILL.md", name: "design-game", description: "Design a game" }] }),
    storePlugin("web-game-studio", "Web Game Studio", { categories: ["workflow"] }),
    storePlugin("threejs-world", "Three.js World", { categories: ["workflow"] }),
    storePlugin("cocos-creator", "Cocos Creator", { ...off, categories: ["engine"] }),
    storePlugin("unity", "Unity", { ...off, categories: ["engine"] }),
    storePlugin("wechat-minigame", "WeChat Mini Games", { ...off, categories: ["publishing"] }),
    storePlugin("douyin-minigame", "Douyin Mini Games", { ...off, categories: ["publishing"] }),
    storePlugin("blender", "Blender", { categories: ["art"] }),
    storePlugin("img2threejs", "Image to Three.js", { bundled: false, preinstalled: true, categories: ["art"] }),
    storePlugin("aseprite", "Aseprite", { ...off, categories: ["art"] }),
    storePlugin("tiled", "Tiled", { ...off, categories: ["art"] }),
    storePlugin("unreal-engine", "Unreal Engine", { ...off, appWide: false, categories: ["engine"], adds: { projectTypes: [], panels: [], commands: [], mcpServers: ["Unreal"], tools: 0, skills: 0 } }),
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init: RequestInit = {}) => {
      const route = new URL(String(url), "http://localhost").pathname.replace(
        /^\/api/,
        "",
      );
      if (route === "/health") return Response.json({ status: "ok" });
      if (route === "/plugins/setup-sessions") return Response.json([]);
      if (route === "/plugin-store/plugins") return Response.json(store);
      if (route === "/plugin-market") return Response.json(market);
      if (init.method === "PUT" && route.startsWith("/plugin-store/") && route.endsWith("/enabled")) {
        const id = route.slice("/plugin-store/".length, -"/enabled".length);
        store.find((plugin) => plugin.id === id)!.grants = { enabled: JSON.parse(String(init.body)).enabled, allowed: [] };
        return new Response(null, { status: 204 });
      }
      if (init.method === "POST" && route === "/plugin-sources/inspect")
        return Response.json({ source: { type: "github", url: "https://github.com/acme/fresh", commit: "a".repeat(40) }, digest: "b".repeat(64), id: "acme/fresh", version: "1.0.0", displayName: "Fresh", description: "Fresh", appWide: true, asks: [], skills: 1, mcpServers: [], settings: false, installedVersions: [] });
      if (init.method === "POST" && route === "/plugin-sources/install") {
        store.push(storePlugin("fresh", "Fresh", { id: "acme/fresh", bundled: false, skills: [{ id: "skills/fresh/SKILL.md", name: "fresh-skill", description: "Fresh" }] }));
        return Response.json({ id: "acme/fresh", version: "1.0.0" }, { status: 201 });
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

async function renderCatalog(pluginId?: string) {
  await act(async () =>
    root.render(
      <PluginsSettings
        {...(pluginId ? { pluginId } : {})}
        onPluginChange={() => {}}
        onTryPlugin={async () => {}}
      />,
    ),
  );
}
function cards(parent: ParentNode = container) {
  return [...parent.querySelectorAll(".plugin-card-name")].map(
    (item) => item.textContent,
  );
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (button) =>
      button.textContent === label ||
      button.getAttribute("aria-label") === label ||
      (button.getAttribute("role") === "tab" && button.textContent?.startsWith(label)),
  )!;
  expect(button, label).toBeTruthy();
  await act(async () => button.click());
}
async function search(value: string, label = "Search plugins") {
  const input = container.querySelector<HTMLInputElement>(
    `[aria-label="${label}"]`,
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
  it("groups plugins by the categories they declare, apart from those a project turns on", async () => {
    await renderCatalog();
    const sections = [...container.querySelectorAll(".plugins-section")];
    expect(
      sections.map((section) => section.querySelector("h2")?.textContent),
    ).toEqual([
      "Game creation 3",
      "Engines & platforms 4",
      "Art & assets 4",
      "Other plugins 1",
      "Turned on per project 1",
      "Personal 2",
    ]);
    expect(cards(sections[0])).toEqual(["Game Studio", "Three.js World", "Web Game Studio"]);
    expect(cards(sections[1])).toEqual(["Cocos Creator", "Douyin Mini Games", "Unity", "WeChat Mini Games"]);
    expect(cards(sections[2])).toEqual(["Aseprite", "Blender", "Image to Three.js", "Tiled"]);
    expect(cards(sections[3])).toEqual(["New tool"]);
    expect(cards(sections[4])).toEqual(["Unreal Engine"]);
    expect(cards(sections[5])).toEqual(["Alpha", "Zebra"]);
    expect(sections[5].textContent).toContain("Create a plugin with AI");
    // Each says how it applies.
    expect(sections[0].textContent).toContain("Every project");
    expect(sections[4].textContent).toContain("Per project");
  });

  it("expands and collapses an individual group", async () => {
    store.push(...["one", "two", "three", "four", "five", "six"].map((name) => storePlugin(`extra-${name}`, `Extra ${name}`)));
    await renderCatalog();
    const other = () => [...container.querySelectorAll(".plugins-section")].find((section) => section.querySelector("h2")?.textContent?.startsWith("Other plugins"))!;
    expect(cards(other())).toHaveLength(6);
    await click("View all (7)");
    expect(cards(other())).toHaveLength(7);
    await click("Show less");
    expect(cards(other())).toHaveLength(6);
    expect(cards()).toContain("Tiled");
  });

  it("keeps enabled and disabled cards in place when toggled", async () => {
    await renderCatalog();
    const before = cards();
    await click("Disable Blender");
    expect(cards()).toEqual(before);
    expect(
      container.querySelector('[aria-label="Enable Blender"]'),
    ).not.toBeNull();
    await click("Enable Blender");
    expect(cards()).toEqual(before);
  });

  it("searches every plugin without group expansion", async () => {
    await renderCatalog();
    await search("Mini Games");
    expect(cards()).toEqual(["Douyin Mini Games", "WeChat Mini Games"]);
    expect(container.querySelectorAll(".plugins-section h2")).toHaveLength(0);
    expect(container.textContent).not.toContain("View all");
    await search("a");
    expect(cards()).toContain("Alpha");
    await search("missing tool");
    expect(cards()).toEqual([]);
    expect(container.textContent).toContain("No matching plugins");
    await click("Clear");
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="Search plugins"]')
        ?.value,
    ).toBe("");
    expect(cards()).toContain("Game Studio");
  });

  it("adds plugins from a menu that closes on Escape", async () => {
    await renderCatalog();
    const add = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Add",
    )!;
    await act(async () => add.click());
    expect(add.getAttribute("aria-expanded")).toBe("true");
    const items = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ];
    expect(items.map((item) => item.textContent)).toEqual(
      expect.arrayContaining(["Browse plugins", "Create with AI…", "Add plugin…"]),
    );
    expect(document.activeElement).toBe(items[0]);
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(add.getAttribute("aria-expanded")).toBe("false");

    await act(async () => add.click());
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((item) => item.textContent?.startsWith("Add plugin"))!
        .click(),
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector(".ui-dialog-title")?.textContent).toBe(
      "Add a plugin",
    );
  });

  describe("with the plugin market", () => {
    const listed = (name: string, fields: Partial<MarketPlugin> = {}): MarketPlugin => ({
      id: `acme/${name}`, package: `@acme/${name}`, version: "1.0.0", displayName: `Market ${name}`, description: "From npm",
      asks: [], adds: { skills: 2 }, featured: false, sourceVerified: false, ...fields,
    });
    const fromNpm = (name: string, version = "1.0.0"): StorePlugin => personal(name, `Installed ${name}`, {
      id: `acme/${name}`, version, origin: { type: "npm", package: `@acme/${name}`, version, registry: "npmjs" },
    });
    const section = (title: string) => container.querySelector(`section[aria-label="${title}"]`)!;

    it("shows featured and listed plugins on Browse, leaving out what's installed", async () => {
      store.push(fromNpm("owned"));
      market = { status: "ready", blocked: [], plugins: [
        listed("picked", { featured: true }), listed("popular", { sourceVerified: true, stars: 1200, weeklyDownloads: 3400 }), listed("owned"),
      ] };
      await renderCatalog();
      await click("Browse");
      expect(cards(section("Featured"))).toEqual(["Market picked"]);
      expect(cards(section("On npm"))).toEqual(["Market popular"]);
      expect(cards()).not.toContain("Market owned");
      expect(section("On npm").textContent).toContain("★ 1.2K");
      expect(section("On npm").querySelector('[aria-label="Source verified"]')).toBeTruthy();
      expect(section("Featured").querySelector('[aria-label="Source verified"]')).toBeNull();
      await search("popular");
      expect(cards()).toEqual(["Market popular"]);
    });

    it("opens the review of a listed plugin from its card", async () => {
      market = { status: "ready", blocked: [], plugins: [listed("picked")] };
      await renderCatalog();
      await click("Browse");
      await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".plugin-card-link")].find((item) => item.textContent?.includes("Market picked"))!.click());
      expect(document.querySelector(".ui-dialog")).toBeTruthy();
    });

    it("says so when the market can't be reached, or may be out of date, and still shows the page", async () => {
      market = { status: "unavailable", plugins: [], blocked: [] };
      await renderCatalog();
      await click("Browse");
      expect(container.textContent).toContain("Couldn't load the plugin list");
      expect(cards()).toContain("Game Studio");
      market = { status: "stale", plugins: [listed("picked")], blocked: [] };
      await act(async () => root.unmount());
      root = createRoot(container);
      await renderCatalog();
      await click("Browse");
      expect(cards()).toContain("Market picked");
      expect(container.textContent).toContain("may be out of date");
    });

    it("offers a newer version only for a plugin added from npm", async () => {
      store.push(fromNpm("owned"), personal("local", "Installed local", { id: "acme/local" }));
      market = { status: "ready", blocked: [], plugins: [listed("owned", { version: "1.2.0" }), listed("local", { version: "1.2.0" })] };
      await renderCatalog();
      const card = (name: string) => [...container.querySelectorAll(".plugin-card")].find((item) => item.textContent?.includes(name))!;
      expect(card("Installed owned").textContent).toContain("Update available");
      expect(card("Installed local").textContent).not.toContain("Update available");
      await renderCatalog("acme/owned");
      await click("Update to 1.2.0");
      expect(document.querySelector(".ui-dialog")).toBeTruthy();
    });

    it("warns about an installed version the maintainers blocked, without switching it off", async () => {
      store.push(fromNpm("owned"));
      market = { status: "ready", plugins: [], blocked: [{ package: "@acme/owned", version: "1.0.0", reason: "steals keys" }] };
      await renderCatalog();
      const card = [...container.querySelectorAll(".plugin-card")].find((item) => item.textContent?.includes("Installed owned"))!;
      expect(card.textContent).toContain("Blocked");
      expect(store.at(-1)!.grants?.enabled).toBe(true);
      await renderCatalog("acme/owned");
      expect(container.textContent).toContain("OhMyGame blocked version 1.0.0: steals keys");
    });

    it("works the same when the market's route fails", async () => {
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        const route = new URL(String(url), "http://localhost").pathname.replace(/^\/api/, "");
        if (route === "/health") return Response.json({ status: "ok" });
        if (route === "/plugins/setup-sessions") return Response.json([]);
        if (route === "/plugin-store/plugins") return Response.json(store);
        return Response.json({ error: "no" }, { status: 500 });
      }));
      await renderCatalog();
      await click("Browse");
      expect(cards()).toContain("Game Studio");
      expect(container.querySelector('[role="alert"]')).toBeNull();
    });
  });

  it("switches tabs with the arrow keys and filters Browse by source and project type", async () => {
    await renderCatalog();
    const tabs = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Installed15", "Browse", "Skills4"]);
    tabs[0].focus();
    await act(async () =>
      tabs[0].dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      ),
    );
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(cards()).toHaveLength(15);
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(0);

    await pick("Source", "Other sources");
    expect(cards()).toEqual(["Alpha", "Zebra"]);
    await pick("Source", "OhMyGame");
    // One category filter, offering only what some plugin adds.
    const category = container.querySelector<HTMLButtonElement>('[aria-label="Category"]')!;
    await act(async () => category.click());
    expect([...document.querySelectorAll('[role="option"]')].map((option) => option.textContent))
      .toEqual(["All categories", "Skills", "MCP"]);
    await act(async () => category.click());
    expect(container.querySelector('[aria-label="Works with"]')).toBeNull();
    await pick("Category", "MCP");
    expect(cards()).toEqual(["New tool", "Unreal Engine"]);
    const card = [...container.querySelectorAll(".plugin-card")].find((item) => item.textContent?.includes("New tool"))!;
    expect([...card.querySelectorAll(".plugins-tag")].map((tag) => tag.textContent)).toEqual(["Web Game", "1 skill", "MCP"]);
  });

  it("lists every plugin's skills, which go on and off with their plugin", async () => {
    await renderCatalog();
    await click("Skills");
    await vi.waitFor(() => expect(container.textContent).toContain("plan-game"));
    const sections = [...container.querySelectorAll(".plugins-section")];
    expect(sections.map((section) => section.querySelector("h2")?.textContent)).toEqual([
      "From plugins 2",
      "Personal 2",
    ]);
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Skills4");
    expect(container.textContent).toContain("design-game");
    expect(container.querySelector('[aria-label="Disable design-game"]')).toBeNull();
    await search("stripes", "Search skills");
    expect(container.textContent).not.toContain("plan-game");
    expect(container.textContent).toContain("stripes");
  });

  it("shows a plugin's skills after adding it", async () => {
    await renderCatalog();
    await click("Skills");
    await vi.waitFor(() => expect(container.textContent).toContain("plan-game"));
    await click("Add");
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((item) => item.textContent?.startsWith("Add plugin"))!
        .click(),
    );
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('.ui-dialog [role="tab"]')].find((item) => item.textContent === "GitHub")!.click());
    const url = document.querySelector<HTMLInputElement>('.ui-dialog input[type="url"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(url, "https://github.com/acme/fresh");
      url.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => url.form!.requestSubmit());
    await vi.waitFor(() => expect(document.querySelector(".ui-dialog-title")?.textContent).toBe("Add Fresh?"));
    await act(async () => document.querySelector<HTMLFormElement>("#plugin-add-form")!.requestSubmit());
    await vi.waitFor(() => expect(container.textContent).toContain("fresh-skill"));
  });
});

async function pick(label: string, option: string) {
  const trigger = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  expect(trigger, label).toBeTruthy();
  await act(async () => trigger.click());
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((item) => item.textContent === option)!
      .click(),
  );
}
