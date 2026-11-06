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
    everyProject: true,
    examples: [],
    settings: [],
    skills: [],
    adds: { projectTypes: [], panels: [], commands: [], mcpServers: [], modelProviders: [], agents: [], tools: 0, skills: 0 },
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
  const off = { everyProject: false };
  store = [
    storePlugin("new-tool", "New tool", {
      appliesTo: ["web-game"],
      skills: [{ id: "skills/plan/SKILL.md", name: "plan-game", description: "Plan a game" }],
      adds: { projectTypes: [], panels: [], commands: [], mcpServers: ["Tool"], modelProviders: [], agents: [], tools: 0, skills: 1 },
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
    storePlugin("unreal-engine", "Unreal Engine", { ...off, grants: { enabled: false, allowed: [] }, categories: ["engine"], adds: { projectTypes: [], panels: [], commands: [], mcpServers: ["Unreal"], modelProviders: [], agents: [], tools: 0, skills: 0 } }),
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
      if (init.method === "PUT" && route.startsWith("/plugin-store/") && route.endsWith("/every-project")) {
        const id = route.slice("/plugin-store/".length, -"/every-project".length);
        store.find((plugin) => plugin.id === id)!.everyProject = JSON.parse(String(init.body)).on;
        return new Response(null, { status: 204 });
      }
      if (init.method === "POST" && route === "/plugin-sources/inspect")
        return Response.json({ source: { type: "github", url: "https://github.com/acme/fresh", commit: "a".repeat(40) }, digest: "b".repeat(64), id: "acme/fresh", version: "1.0.0", displayName: "Fresh", description: "Fresh", appWide: true, asks: [], skills: 1, mcpServers: [], settings: false, installedVersions: [] });
      if (init.method === "POST" && route === "/plugin-sources/install") {
        store.push(storePlugin("fresh", "Fresh", { id: "acme/fresh", bundled: false, origin: { type: "github", repository: "acme/fresh", commit: "a".repeat(40) }, skills: [{ id: "skills/fresh/SKILL.md", name: "fresh-skill", description: "Fresh" }] }));
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
  it("groups plugins by the categories they declare, including those a project turns on", async () => {
    await renderCatalog();
    const sections = [...container.querySelectorAll(".plugins-section")];
    expect(
      sections.map((section) => section.querySelector("h2")?.textContent),
    ).toEqual([
      "Game creation",
      "Engines & platforms",
      "Art & assets",
      "Other plugins",
    ]);
    expect(cards(sections[0])).toEqual(["Game Studio", "Three.js World", "Web Game Studio"]);
    expect(cards(sections[1])).toEqual(["Cocos Creator", "Douyin Mini Games", "Unity", "Unreal Engine", "WeChat Mini Games"]);
    expect(cards(sections[2])).toEqual(["Aseprite", "Blender", "Image to Three.js", "Tiled"]);
    expect(cards(sections[3])).toEqual(["New tool"]);
    // Each says where it is on, and switches that for every project. One
    // stopped everywhere from its page says so and has no switch.
    expect(sections[0].textContent).toContain("On in every project");
    const unreal = [...sections[1].querySelectorAll(".plugin-card")].find((item) => item.textContent?.includes("Unreal Engine"))!;
    expect(unreal.textContent).toContain("On in chosen projects");
    expect(unreal.textContent).toContain("Disabled");
    expect(unreal.querySelector('[role="switch"]')).toBeNull();
    expect(sections[1].querySelector('[aria-label="Turn Unity on in every project"]')?.getAttribute("aria-checked")).toBe("false");

    // What the person made, or added from this computer, is theirs to edit, under Mine.
    await click("Mine");
    const mine = container.querySelector('section[aria-label="Your plugins"]')!;
    expect(cards(mine)).toEqual(["Alpha", "Zebra"]);
    expect(mine.textContent).toContain("Create a plugin with AI");
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

  it("keeps cards in place when switched for every project", async () => {
    await renderCatalog();
    const before = cards();
    const blender = () => container.querySelector('[aria-label="Turn Blender on in every project"]');
    await click("Turn Blender on in every project");
    expect(cards()).toEqual(before);
    expect(blender()?.getAttribute("aria-checked")).toBe("false");
    await click("Turn Blender on in every project");
    expect(cards()).toEqual(before);
    expect(blender()?.getAttribute("aria-checked")).toBe("true");
  });

  it("searches every plugin without group expansion", async () => {
    await renderCatalog();
    await search("Mini Games");
    expect(cards()).toEqual(["Douyin Mini Games", "WeChat Mini Games"]);
    expect(container.querySelectorAll(".plugins-section h2")).toHaveLength(0);
    expect(container.textContent).not.toContain("View all");
    await search("a");
    expect(cards()).not.toContain("Alpha");
    await click("Mine");
    expect(cards()).toContain("Alpha");
    await click("Installed");
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
      expect.arrayContaining(["Create with AI…", "Add plugin…"]),
    );
    // The market is a tab, so the menu doesn't offer it again.
    expect(items.map((item) => item.textContent)).not.toContain("Browse plugins");
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

    it("shows featured and listed plugins on Discover, marking what's installed", async () => {
      store.push(fromNpm("owned"));
      market = { status: "ready", blocked: [], plugins: [
        listed("picked", { featured: true }), listed("popular", { sourceVerified: true, stars: 1200, weeklyDownloads: 3400 }), listed("owned"),
      ] };
      const opened: Array<string | undefined> = [];
      await act(async () => root.render(<PluginsSettings onPluginChange={(id) => opened.push(id)} onTryPlugin={async () => {}} />));
      await click("Discover");
      expect(cards(section("Featured"))).toEqual(["Market picked"]);
      expect(cards(section("On npm"))).toEqual(["Market popular", "Market owned"]);
      const owned = [...section("On npm").querySelectorAll(".plugin-card")].find((item) => item.textContent?.includes("Market owned"))!;
      expect(owned.querySelector(".plugins-installed-label")?.textContent).toBe("Installed");
      // One that's installed opens its page rather than the review.
      await act(async () => owned.querySelector<HTMLButtonElement>(".plugin-card-link")!.click());
      expect(opened).toEqual(["acme/owned"]);
      expect(document.querySelector(".ui-dialog")).toBeNull();
      expect(section("On npm").textContent).toContain("★ 1.2K");
      expect(section("On npm").querySelector('[aria-label="Source verified"]')).toBeTruthy();
      expect(section("Featured").querySelector('[aria-label="Source verified"]')).toBeNull();
      await search("popular");
      expect(cards()).toEqual(["Market popular"]);
    });

    it("opens the review of a listed plugin from its card", async () => {
      market = { status: "ready", blocked: [], plugins: [listed("picked")] };
      await renderCatalog();
      await click("Discover");
      await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".plugin-card-link")].find((item) => item.textContent?.includes("Market picked"))!.click());
      expect(document.querySelector(".ui-dialog")).toBeTruthy();
    });

    it("says so when the market can't be reached, or may be out of date, and still shows the page", async () => {
      market = { status: "unavailable", plugins: [], blocked: [] };
      await renderCatalog();
      await click("Discover");
      expect(container.textContent).toContain("Couldn't load the plugin list");
      await click("Installed");
      expect(cards()).toContain("Game Studio");
      market = { status: "stale", plugins: [listed("picked")], blocked: [] };
      await act(async () => root.unmount());
      root = createRoot(container);
      await renderCatalog();
      await click("Discover");
      expect(cards()).toContain("Market picked");
      expect(container.textContent).toContain("may be out of date");
    });

    it("offers a newer version only for a plugin added from npm", async () => {
      const other = { ...fromNpm("other"), origin: { type: "npm", package: "@acme/other", version: "1.0.0", registry: "https://registry.example.com" } } satisfies StorePlugin;
      store.push(fromNpm("owned"), personal("local", "Installed local", { id: "acme/local" }), other);
      market = { status: "ready", blocked: [], plugins: [listed("owned", { version: "1.2.0" }), listed("local", { version: "1.2.0" }), listed("other", { version: "1.2.0" })] };
      await renderCatalog();
      const card = (name: string) => [...container.querySelectorAll(".plugin-card")].find((item) => item.textContent?.includes(name))!;
      expect(card("Installed owned").textContent).toContain("Update available");
      // The tab says so too, with a dot rather than a count.
      const installedTab = container.querySelector('[role="tab"]')!;
      expect(installedTab.querySelector(".ui-tab-dot")?.textContent).toBe("Updates available");
      // One added from this computer is the person's own, under Mine, and never updates from the market.
      await click("Mine");
      expect(card("Installed local").textContent).not.toContain("Update available");
      // Another registry is a source of its own, so npm's package couldn't join it.
      expect(card("Installed other").textContent).not.toContain("Update available");
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

    it("picks up what the market reads later while the page stays open", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      try {
        await renderCatalog();
        await click("Discover");
        expect(cards()).not.toContain("Market picked");
        market = { status: "ready", blocked: [], plugins: [listed("picked")] };
        await act(async () => { vi.advanceTimersByTime(2 * 60_000); });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
        expect(cards()).toContain("Market picked");
      } finally {
        vi.useRealTimers();
      }
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
      await click("Discover");
      expect(container.querySelector('[role="alert"]')).toBeNull();
      await click("Installed");
      expect(cards()).toContain("Game Studio");
    });
  });

  it("switches tabs with the arrow keys, keeps the tab in the route, and has no counts", async () => {
    const shown: string[] = [];
    await act(async () => root.render(<PluginsSettings tab="mine" onTabChange={(tab) => shown.push(tab)} onPluginChange={() => {}} onTryPlugin={async () => {}} />));
    const tabs = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Installed", "Discover", "Mine"]);
    expect(tabs[2].getAttribute("aria-selected")).toBe("true");
    expect(container.querySelectorAll(".plugins-count")).toHaveLength(0);
    tabs[2].focus();
    await act(async () =>
      tabs[2].dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      ),
    );
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(shown).toEqual(["discover"]);
  });

  it("filters installed plugins by what they add, Skills included", async () => {
    await renderCatalog();
    // One category filter, offering only what some installed plugin adds.
    const category = container.querySelector<HTMLButtonElement>('[aria-label="Category"]')!;
    await act(async () => category.click());
    expect([...document.querySelectorAll('[role="option"]')].map((option) => option.textContent))
      .toEqual(["All categories", "Skills", "MCP"]);
    await act(async () => category.click());
    await pick("Category", "MCP");
    expect(cards()).toEqual(["Unreal Engine", "New tool"]);

    // Skills shows each Skill on its own, and they go on and off with their plugin.
    await pick("Category", "Skills");
    await vi.waitFor(() => expect(container.textContent).toContain("plan-game"));
    expect(container.textContent).toContain("design-game");
    expect(container.textContent).not.toContain("stripes");
    expect(container.querySelector('[aria-label="Disable design-game"]')).toBeNull();
    await search("plan");
    expect(container.textContent).toContain("plan-game");
    expect(container.textContent).not.toContain("design-game");
  });

  it("shows a plugin's skills after adding it", async () => {
    await renderCatalog();
    await pick("Category", "Skills");
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
