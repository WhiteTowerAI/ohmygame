// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketPlugin, PluginMarketListing, PluginMarketSettings, StorePlugin } from "../src/shared/plugins.js";
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
let marketSettings: PluginMarketSettings;
beforeEach(() => {
  marketSettings = { index: "https://plugins.example.com/index.json", defaultIndex: "https://plugins.example.com/index.json", extra: [], download: "auto", proxy: "" };
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
    storePlugin("blender", "Blender", { categories: ["art"], keywords: ["sculpt"] }),
    storePlugin("img2threejs", "Image to Three.js", { bundled: false, preinstalled: true, categories: ["art"] }),
    storePlugin("aseprite", "Aseprite", { ...off, categories: ["art"] }),
    storePlugin("tiled", "Tiled", { ...off, categories: ["art"] }),
    storePlugin("unreal-engine", "Unreal Engine", { ...off, grants: { enabled: false, allowed: [] }, categories: ["engine"], adds: { projectTypes: [], panels: [], commands: [], mcpServers: ["Unreal"], modelProviders: [], agents: ["Unreal agent"], tools: 0, skills: 0 } }),
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
      if (route === "/settings/plugin-market") {
        if (init.method === "PUT") marketSettings = { ...marketSettings, ...JSON.parse(String(init.body)) };
        return Response.json(marketSettings);
      }
      if (route === "/plugin-market/avatars/42" || route === "/plugin-market/images") return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "Content-Type": "image/png" } });
      if (init.method === "PUT" && route.startsWith("/plugin-store/") && route.endsWith("/every-project")) {
        const id = route.slice("/plugin-store/".length, -"/every-project".length);
        store.find((plugin) => plugin.id === id)!.everyProject = JSON.parse(String(init.body)).on;
        return new Response(null, { status: 204 });
      }
      if (init.method === "POST" && route === "/plugin-sources/inspect")
        return Response.json({ source: { type: "github", url: "https://github.com/acme/fresh", commit: "a".repeat(40) }, digest: "b".repeat(64), id: "acme/fresh", version: "1.0.0", displayName: "Fresh", description: "Fresh", appWide: true, asks: [], adds: { projectTypes: [], panels: [], commands: [], mcpServers: [], modelProviders: [], agents: [], tools: 0, skills: 1 }, settings: false, installedVersions: [] });
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

/** The page as the app routes it: opening a plugin or a tab changes what it's given. */
function Routed({ pluginId, tab }: { pluginId?: string; tab?: "installed" | "discover" }) {
  const [route, setRoute] = useState<{ pluginId?: string; tab?: "installed" | "discover" }>({ pluginId, tab });
  return <PluginsSettings {...(route.pluginId ? { pluginId: route.pluginId } : {})} {...(route.tab ? { tab: route.tab } : {})}
    onPluginChange={(id, next) => setRoute({ ...(id ? { pluginId: id } : {}), ...(next ? { tab: next } : {}) })}
    onTabChange={(next) => setRoute({ tab: next })} onTryPlugin={async () => {}} />;
}

/** The page on a tab, Installed unless said; Discover is the page's own first. */
async function renderCatalog(pluginId?: string, tab: "installed" | "discover" = "installed") {
  await act(async () =>
    root.render(
      <PluginsSettings
        {...(pluginId ? { pluginId } : {})}
        tab={tab}
        onPluginChange={() => {}}
        onTryPlugin={async () => {}}
      />,
    ),
  );
}
function cards(parent: ParentNode = container) {
  return [...parent.querySelectorAll(".plugin-card-name, .installed-plugin-inventory:not([hidden]) .installed-plugin-name")].filter((item) => !item.closest(".installed-plugin-workspace[style*='display: none']")).map(
    (item) => item.textContent,
  );
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (button) =>
      button.textContent === label ||
      button.getAttribute("aria-label") === label ||
      (button.matches(".plugins-rail-item") && button.firstElementChild?.textContent === label) ||
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
  it("lists every installed plugin once, including those a project turns on and the person's own", async () => {
    await renderCatalog();
    // What the person made comes first, under its own heading.
    const own = ["Alpha", "Zebra"];
    expect(cards()).toEqual([...own, ...store.map((plugin) => plugin.displayName).filter((name) => !own.includes(name)).sort((a, b) => a.localeCompare(b))]);
    const mine = container.querySelector('section[aria-label="Made by you"]')!;
    expect([...mine.querySelectorAll(".installed-plugin-name")].map((name) => name.textContent)).toEqual(own);
    const unreal = [...container.querySelectorAll(".installed-plugin-row")].find((item) => item.textContent?.includes("Unreal Engine"))!;
    expect(unreal.textContent).toContain("Disabled");
    expect(unreal.querySelector('[role="switch"]')).toBeNull();
    await renderCatalog("ohmygame/unity");
    expect(container.querySelector('[aria-label="Turn Unity on in every project"]')?.getAttribute("aria-checked")).toBe("false");
  });

  it("keeps rows in place when switched for every project", async () => {
    await renderCatalog();
    const before = cards();
    await renderCatalog(store.find((plugin) => plugin.displayName === "Blender")!.id);
    const blender = () => container.querySelector('[aria-label="Turn Blender on in every project"]');
    await click("Turn Blender on in every project");
    expect(cards()).toEqual(before);
    expect(blender()?.getAttribute("aria-checked")).toBe("false");
    await click("Turn Blender on in every project");
    expect(cards()).toEqual(before);
    expect(blender()?.getAttribute("aria-checked")).toBe("true");
  });

  it("searches installed plugins by description, name, keywords, agents, and skills", async () => {
    await renderCatalog();
    await search("Mini Games");
    expect(cards()).toEqual(["Douyin Mini Games", "WeChat Mini Games"]);
    await search("a");
    expect(cards()).toContain("Alpha");
    // Keywords and what a plugin adds by name are searched too.
    await search("sculpt");
    expect(cards()).toEqual(["Blender"]);
    await search("unreal agent");
    expect(cards()).toEqual(["Unreal Engine"]);
    await search("publish-wechat");
    expect(cards()).toEqual(["Alpha"]);
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
    const add = container.querySelector<HTMLButtonElement>('.plugins-toolbar button[aria-label="More actions"]')!;
    await act(async () => add.click());
    expect(add.getAttribute("aria-expanded")).toBe("true");
    const items = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ];
    // Making one with AI is the header's own button.
    expect(items.map((item) => item.textContent)).toEqual(["Add plugin", "Add MCP service"]);
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
      id: `acme/${name}`, version: "1.0.0", displayName: `Market ${name}`, description: "From GitHub",
      asks: [], adds: { skills: 2 }, featured: false, sourceVerified: false, repository: `https://github.com/acme/${name}`, ...fields,
    });
    const fromMarket = (name: string, version = "1.0.0"): StorePlugin => personal(name, `Installed ${name}`, {
      id: `acme/${name}`, version, origin: { type: "github", repository: `acme/${name}`, commit: "c".repeat(40), release: `v${version}` },
    });
    const section = (title: string) => container.querySelector(`section[aria-label="${title}"]`)!;

    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

    it("opens on Discover, marking only what's installed, and opens a plugin on its own page", async () => {
      store.push(fromMarket("owned"));
      market = { status: "ready", blocked: [], plugins: [
        listed("picked", { featured: true }), listed("popular", { sourceVerified: true, stars: 1200, repository: "https://github.com/acme/popular" }), listed("owned"),
        listed("official", { id: "ohmygame/official", repository: "https://github.com/WhiteTowerAI/ohmygame-plugins", avatar: "42" }),
        listed("avatar", { sourceVerified: true, avatar: "42", icon: "./icon.png" }),
      ] };
      const opened: Array<string | undefined> = [];
      await act(async () => root.render(<PluginsSettings onPluginChange={(id) => opened.push(id)} onTryPlugin={async () => {}} />));
      expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Discover");
      // Featured first, then each section; a plugin no section takes is in Other, featured ones first, then by name.
      expect(cards(section("Featured"))).toEqual(["Market picked"]);
      expect(cards(section("Other"))).toEqual(["Market picked", "Market avatar", "Market official", "Market owned", "Market popular"]);
      const card = (name: string) => [...section("Other").querySelectorAll(".plugin-card")].find((item) => item.textContent?.includes(name))!;
      // A card is one button: it is added from its page.
      expect(card("Market popular").querySelectorAll("button")).toHaveLength(1);
      expect(card("Market owned").querySelector(".ui-badge")?.textContent).toBe("Installed");
      // A community plugin says whose it is; OhMyGame's say nothing more.
      expect(card("Market popular").querySelector(".plugin-card-fact")?.textContent).toBe("Community · @acme");
      expect(card("Market official").querySelector(".plugin-card-fact")).toBeNull();
      // Installed is a card's one mark: Official, Beta and a verified source are on the plugin's page.
      expect(card("Market official").querySelector('[aria-label="Official"]')).toBeNull();
      expect(card("Market popular").querySelector('[aria-label="Source verified"]')).toBeNull();
      // Without an icon, a card shows the plugin's first letter, in the same colour each time.
      const letter = card("Market popular").querySelector<HTMLElement>(".plugin-monogram")!;
      expect(letter.textContent).toBe("M");
      expect(letter.style.getPropertyValue("--monogram-hue")).toMatch(/^var\(--hue-[a-z]+\)$/);
      // With one, its own icon, read from the package file mirror; a publisher's avatar is only on its page.
      await vi.waitFor(() => expect(card("Market avatar").querySelector(".plugin-tile img")).toBeTruthy());
      expect(card("Market official").querySelector(".plugin-tile img")).toBeNull();
      expect(card("Market official").querySelector(".plugin-monogram")?.textContent).toBe("M");
      // A card opens the plugin's page, installed or not.
      await act(async () => card("Market popular").querySelector<HTMLButtonElement>(".plugin-card-link")!.click());
      await act(async () => card("Market owned").querySelector<HTMLButtonElement>(".plugin-card-link")!.click());
      expect(opened).toEqual(["acme/popular", "acme/owned"]);
      expect(dialog()).toBeNull();
      // A search keeps the sections but not Featured.
      await search("popular");
      expect(cards()).toEqual(["Market popular"]);
      expect(container.querySelector('section[aria-label="Featured"]')).toBeNull();
    });

    it("gives a plugin that isn't installed the installed one's page, with its marks, and comes back to the list", async () => {
      market = { status: "ready", blocked: [], plugins: [
        listed("popular", { sourceVerified: true, stars: 1200, avatar: "42" }),
        listed("official", { id: "ohmygame/official", beta: true, repository: "https://github.com/WhiteTowerAI/ohmygame-plugins" }),
      ] };
      await act(async () => root.render(<Routed tab="discover" />));
      await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".plugin-card-link")].find((item) => item.textContent?.includes("Market official"))!.click());
      expect(container.querySelector(".plugin-head h1")?.textContent).toContain("Market official");
      expect(container.querySelector('.plugin-head [aria-label="Official"]')).toBeTruthy();
      expect(container.querySelector(".plugin-head")?.textContent).toContain("Beta");
      expect(container.querySelector(".plugins-grid")).toBeNull();
      await click("Plugins");
      expect(cards()).toEqual(["Market official", "Market popular"]);
      await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".plugin-card-link")].find((item) => item.textContent?.includes("Market popular"))!.click());
      await vi.waitFor(() => expect(container.querySelector(".plugin-side .plugin-publisher img")).toBeTruthy());
      expect(container.querySelector(".plugin-side")?.textContent).toContain("Source verified");
    });

    it("finds a plugin by its keywords and what it adds, and searches for a keyword from its page", async () => {
      market = { status: "ready", blocked: [], plugins: [
        listed("agents", { categories: ["agent"], names: ["Gemini CLI"] }),
        listed("flow", { categories: ["provider"], providerKinds: ["language"], keywords: ["aggregator", "LLM"] }),
        listed("router", { categories: ["provider"], providerKinds: ["language"], keywords: ["aggregator"] }),
        listed("pixels", { categories: ["art"] }),
      ] };
      await act(async () => root.render(<Routed tab="discover" />));
      await search("gemini");
      expect(cards()).toEqual(["Market agents"]);
      await search("aggregator");
      expect(cards()).toEqual(["Market flow", "Market router"]);
      await search("");
      await act(async () => [...section("Images & pixel art").querySelectorAll<HTMLButtonElement>(".plugin-card-link")][0]!.click());
      expect(container.querySelector(".plugin-keywords")).toBeNull();
      await click("Plugins");
      await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".plugin-card-link")].find((item) => item.textContent?.includes("Market flow"))!.click());
      expect([...container.querySelectorAll(".plugin-keyword")].map((item) => item.textContent)).toEqual(["aggregator", "LLM"]);
      // A keyword on the page searches for it.
      await act(async () => container.querySelector<HTMLButtonElement>(".plugin-keyword")!.click());
      expect(container.querySelector(".plugin-head")).toBeNull();
      expect(container.querySelector<HTMLInputElement>('[aria-label="Search plugins"]')?.value).toBe("aggregator");
      expect(cards()).toEqual(["Market flow", "Market router"]);
    });

    it("puts each plugin in the sections for what it makes, which a search finds by name in either language", async () => {
      market = { status: "ready", blocked: [], plugins: [
        listed("chat", { categories: ["provider"], providerKinds: ["language"] }),
        listed("studio", { categories: ["provider"], providerKinds: ["language", "image", "video"] }),
        listed("voices", { categories: ["provider"], providerKinds: ["audio"], description: "Speech for characters" }),
        listed("pixels", { categories: ["art"] }),
        listed("look", { categories: ["theme"] }),
      ] };
      await renderCatalog(undefined, "discover");
      const card = (name: string) => [...container.querySelectorAll(".plugin-card")].find((item) => item.textContent?.includes(name))!;
      expect(cards(section("Agents & models"))).toEqual(["Market chat", "Market studio"]);
      expect(cards(section("Images & pixel art"))).toEqual(["Market pixels", "Market studio"]);
      expect(cards(section("Video"))).toEqual(["Market studio"]);
      expect(cards(section("Other"))).toEqual(["Market look"]);
      // What it makes, past one kind, tells a provider apart; a language model is what Agents says already.
      expect(card("Market studio").querySelector(".plugin-card-fact")?.textContent).toBe("Community · @acme · Image · Video");
      expect(card("Market voices").querySelector(".plugin-card-fact")?.textContent).toBe("Community · @acme");
      // The side list counts each section and leaves out the empty ones.
      const rail = () => [...container.querySelectorAll<HTMLButtonElement>(".plugins-rail-item")];
      expect(rail().map((item) => item.textContent)).toEqual([
        "Engines & platforms0", "Agents & models2", "Images & pixel art2", "Sound1", "3D0", "Video1", "Levels & gameplay0", "Testing & publishing0", "Connections0", "Other1",
      ]);
      expect(rail().filter((item) => item.disabled).map((item) => item.firstElementChild?.textContent)).toEqual(["Engines & platforms", "3D", "Levels & gameplay", "Testing & publishing", "Connections"]);
      // A section's name finds what's in it, even when no plugin says that word.
      await search("配音");
      expect(cards()).toEqual(["Market voices"]);
      await search("vid");
      expect([...container.querySelectorAll(".plugins-section")].map((item) => item.getAttribute("aria-label"))).toEqual(["Video"]);
    });

    it("reviews a listed plugin from Get on its page, which a link opens too", async () => {
      market = { status: "ready", blocked: [], plugins: [listed("picked", { longDescription: "Picks things.", categories: ["art"], appliesTo: ["web-game"], asks: ["native"], adds: { skills: 2, panels: 1 },
        publishedAt: "2026-11-01T00:00:00.000Z", createdAt: "2026-06-01T00:00:00.000Z", size: 1_572_864 })] };
      await renderCatalog("acme/picked", "discover");
      await vi.waitFor(() => expect(container.querySelector(".plugin-head h1")?.textContent).toBe("Market picked"));
      const side = container.querySelector('[aria-label="Information"]')!;
      expect(side.querySelector(".plugin-publisher")?.textContent).toBe("@acme");
      expect(side.textContent).toContain("Art");
      expect(side.textContent).toContain("Web Game");
      expect(side.textContent).toContain("First published");
      // Its version, size and when it was updated are there too, as an installed one's page has them.
      expect(side.textContent).toContain("Versionv1.0.0");
      expect(side.textContent).toContain("Size1.5 MB");
      expect(side.textContent).toContain("Updated");
      expect(container.querySelector(".plugin-stats")).toBeNull();
      expect(container.textContent).toContain("Picks things.");
      expect(container.textContent).toContain("Run its own code on this computer");
      expect(container.querySelector(".plugin-store-adds")?.textContent).toContain("Panel1");
      await click("Get");
      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      expect(dialog()?.querySelector(".ui-dialog-title")?.textContent).toMatch(/^Add /);
    });

    it("shows the first plugins of a long section until it's opened", async () => {
      market = { status: "ready", blocked: [], plugins: Array.from({ length: 15 }, (_, index) => listed(`p${String(index).padStart(2, "0")}`, { categories: ["art"] })) };
      await renderCatalog(undefined, "discover");
      expect(cards(section("Images & pixel art"))).toHaveLength(12);
      await click("All 15");
      expect(cards(section("Images & pixel art"))).toHaveLength(15);
      expect(container.textContent).not.toContain("All 15");
      // A search shows all it finds.
      await search("market p1");
      expect(cards()).toHaveLength(5);
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

    it("offers a newer version only for a plugin added from the market", async () => {
      // A GitHub branch updates from GitHub instead; a release from another repository isn't the listed plugin.
      const branch = { ...fromMarket("branch"), origin: { type: "github", repository: "acme/branch", commit: "c".repeat(40) } } satisfies StorePlugin;
      const elsewhere = { ...fromMarket("elsewhere"), origin: { type: "github", repository: "evil/elsewhere", commit: "c".repeat(40), release: "v1.0.0" } } satisfies StorePlugin;
      // npm no longer updates a third party's plugin.
      const npm = { ...fromMarket("npm"), origin: { type: "npm", package: "@acme/npm", version: "1.0.0", registry: "npmjs" } } satisfies StorePlugin;
      store.push(fromMarket("owned"), personal("local", "Installed local", { id: "acme/local" }), branch, elsewhere, npm);
      market = { status: "ready", blocked: [], plugins: ["owned", "local", "branch", "elsewhere", "npm"].map((name) => listed(name, { version: "1.2.0" })) };
      await renderCatalog();
      const update = (name: string) => container.querySelector(`.installed-plugin-list button[aria-label="Update ${name}"]`);
      expect(update("Installed owned")).not.toBeNull();
      for (const name of ["local", "branch", "elsewhere", "npm"]) expect(update(`Installed ${name}`), name).toBeNull();
      expect([...container.querySelectorAll('section[aria-label="Updates"] .installed-plugin-name')].map((name) => name.textContent)).toEqual(["Installed owned"]);
      const installedTab = [...container.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.startsWith("Installed"))!;
      expect(installedTab.querySelector(".ui-tab-dot")?.textContent).toBe("Updates available");
      await renderCatalog("acme/npm");
      expect(container.textContent).toContain("Installed from npm, so it no longer gets updates");
      await renderCatalog("acme/owned");
      await click("Update to 1.2.0");
      expect(document.querySelector(".ui-dialog")).toBeTruthy();
    });

    it("warns about an installed version the maintainers blocked, without switching it off", async () => {
      store.push(fromMarket("owned"));
      market = { status: "ready", plugins: [], blocked: [{ repository: "acme/owned", version: "1.0.0", reason: "steals keys" }] };
      await renderCatalog();
      const card = [...container.querySelectorAll(".installed-plugin-row")].find((item) => item.textContent?.includes("Installed owned"))!;
      expect(card.textContent).toContain("Blocked");
      expect(store.at(-1)!.grants?.enabled).toBe(true);
      await renderCatalog("acme/owned");
      expect(container.textContent).toContain("OhMyGame blocked version 1.0.0: steals keys");
    });

    it("sets where plugins download from in Plugin sources, asking for an address only for a proxy", async () => {
      market = { status: "ready", blocked: [], plugins: [listed("picked")] };
      await renderCatalog(undefined, "discover");
      await click("More actions");
      await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === "Plugin sources")!.click());
      const dialog = () => document.querySelector<HTMLElement>(".ui-dialog")!;
      const trigger = () => dialog().querySelector<HTMLButtonElement>('[aria-label="Download from"]')!;
      await vi.waitFor(() => expect(trigger().textContent).toContain("Automatic"));
      expect(dialog().textContent).toContain("checked against its signature");
      // The default indexes stay folded away.
      expect(dialog().querySelector<HTMLDetailsElement>("details")!.open).toBe(false);
      expect(dialog().querySelector('input[placeholder="https://proxy.example.com/"]')).toBeNull();
      await act(async () => trigger().click());
      // Each choice says what it does.
      expect([...document.querySelectorAll('[role="option"]')].map((item) => item.textContent)).toEqual([
        "AutomaticPicked by region, then the other if it fails", "GitHubStraight from GitHub", "OhMyGame mirrorFaster in mainland China", "Through a proxyThrough your GitHub proxy"]);
      await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.startsWith("Through a proxy"))!.click());
      const address = dialog().querySelector<HTMLInputElement>('input[placeholder="https://proxy.example.com/"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(address, " https://ghproxy.example.com/ ");
        address.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => address.form!.requestSubmit());
      await vi.waitFor(() => expect(marketSettings).toMatchObject({ download: "proxy", proxy: "https://ghproxy.example.com/", extra: [] }));
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
    await act(async () => root.render(<PluginsSettings tab="installed" onTabChange={(tab) => shown.push(tab)} onPluginChange={() => {}} onTryPlugin={async () => {}} />));
    const tabs = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="tablist"][aria-label="Plugins"] [role="tab"]'),
    ];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Discover", "Installed"]);
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[role="tablist"] .plugins-count')).toBeNull();
    tabs[1].focus();
    await act(async () =>
      tabs[1].dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      ),
    );
    expect(document.activeElement).toBe(tabs[0]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(shown).toEqual(["discover"]);
  });

  it("finds a newly added plugin by its skill name", async () => {
    await renderCatalog();
    await search("fresh-skill");
    expect(cards()).toEqual([]);
    await click("More actions");
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
    await vi.waitFor(() => expect(cards()).toEqual(["Fresh"]));
  });
});

describe("plugin types a plugin works with", () => {
  it("names a type the app had as its own by that name, once, and another plugin's by its own id", async () => {
    const { appliesToLabels } = await import("../src/renderer/plugin-catalog.js");
    expect(appliesToLabels(["general", "ohmygame/godot:godot-game", "godot-game", "acme/engine:level", "beta/maps:level"])).toEqual(["General Game", "Godot", "level", "level"]);
  });
});
