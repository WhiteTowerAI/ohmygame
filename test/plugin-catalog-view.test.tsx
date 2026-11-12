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

/** The page on a tab, Installed unless said; Discover is the page's own first. */
async function renderCatalog(pluginId?: string, tab: "installed" | "discover" | "mine" = "installed") {
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
      "Engines & platforms",
      "Publishing",
      "Art",
      "Workflow",
      "Other",
    ]);
    expect(cards(sections[0])).toEqual(["Cocos Creator", "Unity", "Unreal Engine"]);
    expect(cards(sections[1])).toEqual(["Douyin Mini Games", "WeChat Mini Games"]);
    expect(cards(sections[2])).toEqual(["Aseprite", "Blender", "Image to Three.js", "Tiled"]);
    expect(cards(sections[3])).toEqual(["Game Studio", "Three.js World", "Web Game Studio"]);
    // The person's own are listed with the rest, to switch on and off.
    expect(cards(sections[4])).toEqual(["Alpha", "New tool", "Zebra"]);
    // Each says where it is on, and switches that for every project. One
    // stopped everywhere from its page says so and has no switch.
    expect(sections[3].textContent).toContain("On in every project");
    const unreal = [...sections[0].querySelectorAll(".plugin-card")].find((item) => item.textContent?.includes("Unreal Engine"))!;
    expect(unreal.textContent).toContain("On in chosen projects");
    expect(unreal.textContent).toContain("Disabled");
    expect(unreal.querySelector('[role="switch"]')).toBeNull();
    expect(sections[0].querySelector('[aria-label="Turn Unity on in every project"]')?.getAttribute("aria-checked")).toBe("false");

    // What the person made is also under Mine, a card each, to edit; one added from this computer isn't.
    await click("Mine");
    const mine = container.querySelector('section[aria-label="Your plugins"]')!;
    expect(cards(mine)).toEqual(["Alpha", "Zebra"]);
    expect(mine.querySelector('[role="switch"]')).toBeNull();
    expect(container.querySelector(".plugins-create")?.textContent).toContain("Create a plugin with AI");
  });

  it("narrows to one category, offering only those something is in, under each category a plugin names", async () => {
    store.find((plugin) => plugin.id === "ohmygame/douyin-minigame")!.categories = ["engine", "publishing"];
    await renderCatalog();
    const chips = () => [...container.querySelectorAll<HTMLButtonElement>(".ui-filter-chip")];
    // Only categories something here is in, without counts.
    expect(chips().map((chip) => chip.textContent)).toEqual(["All", "Engines & platforms", "Publishing", "Art", "Workflow", "Other"]);
    await click("Engines & platforms");
    expect(cards()).toEqual(["Cocos Creator", "Douyin Mini Games", "Unity", "Unreal Engine"]);
    expect(container.querySelectorAll(".plugins-section h2")).toHaveLength(0);
    await click("Publishing");
    expect(cards()).toEqual(["Douyin Mini Games", "WeChat Mini Games"]);
    // Picking it again shows everything.
    await click("Publishing");
    expect(cards()).toContain("New tool");
    await click("Other");
    expect(cards()).toEqual(["Alpha", "New tool", "Zebra"]);
  });

  it("expands and collapses an individual group", async () => {
    store.push(...["one", "two", "three", "four", "five", "six"].map((name) => storePlugin(`extra-${name}`, `Extra ${name}`)));
    await renderCatalog();
    const other = () => [...container.querySelectorAll(".plugins-section")].find((section) => section.querySelector("h2")?.textContent?.startsWith("Other"))!;
    expect(cards(other())).toHaveLength(6);
    await click("View all (9)");
    expect(cards(other())).toHaveLength(9);
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
    expect(cards()).toContain("Alpha");
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

    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
    const inDialog = async (label: string) => {
      const button = [...dialog()!.querySelectorAll("button")].find((item) => item.textContent === label)!;
      expect(button, label).toBeTruthy();
      await act(async () => button.click());
    };

    it("opens on Discover, marking what's official and installed, and opens a plugin over the list", async () => {
      store.push(fromNpm("owned"));
      market = { status: "ready", blocked: [], plugins: [
        listed("picked", { featured: true }), listed("popular", { sourceVerified: true, stars: 1200, weeklyDownloads: 3400, repository: "https://github.com/acme/popular" }), listed("owned"),
        listed("official", { id: "ohmygame/official", package: "@ohmygame/official", avatar: "42" }),
        listed("avatar", { sourceVerified: true, avatar: "42", icon: "./icon.png" }),
      ] };
      const opened: Array<string | undefined> = [];
      await act(async () => root.render(<PluginsSettings onPluginChange={(id) => opened.push(id)} onTryPlugin={async () => {}} />));
      expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Discover");
      // A small market is one list, in the recommended order: featured first.
      expect(container.querySelector('section[aria-label="Featured"]')).toBeNull();
      expect(cards(section("All plugins"))).toEqual(["Market picked", "Market popular", "Market owned", "Market official", "Market avatar"]);
      const card = (name: string) => [...section("All plugins").querySelectorAll(".plugin-card")].find((item) => item.textContent?.includes(name))!;
      // A card is one button: it is added from its dialog.
      expect(card("Market popular").querySelectorAll("button")).toHaveLength(1);
      expect(card("Market owned").querySelector(".ui-badge")?.textContent).toBe("Installed");
      expect(card("Market popular").textContent).toContain("3.4K a week");
      // The publisher comes first on the last line, before the version and downloads.
      expect(card("Market popular").querySelector(".plugin-card-foot")?.firstElementChild?.textContent).toBe("@acme");
      expect(card("Market popular").querySelector(".plugin-card-numbers")?.textContent).toContain("v1.0.0");
      // Official is the one mark; a verified source is in the plugin's information instead.
      expect(card("Market official").querySelector('[aria-label="Official"]')).toBeTruthy();
      expect(card("Market popular").querySelector('[aria-label="Official"]')).toBeNull();
      expect(card("Market popular").querySelector('[aria-label="Source verified"]')).toBeNull();
      // Without an icon, a card shows the plugin's first letter, in the same colour each time.
      const letter = card("Market popular").querySelector<HTMLElement>(".plugin-monogram")!;
      expect(letter.textContent).toBe("M");
      expect(letter.style.getPropertyValue("--monogram-hue")).toMatch(/^var\(--hue-[a-z]+\)$/);
      expect(card("Market official").textContent).toContain("OhMyGame");
      // With one, its own icon, read from the package file mirror; a publisher's avatar is only in the dialog.
      await vi.waitFor(() => expect(card("Market avatar").querySelector(".plugin-tile img")).toBeTruthy());
      expect(card("Market official").querySelector(".plugin-tile img")).toBeNull();
      expect(card("Market official").querySelector(".plugin-monogram")?.textContent).toBe("M");
      await act(async () => card("Market avatar").querySelector<HTMLButtonElement>(".plugin-card-link")!.click());
      await vi.waitFor(() => expect(dialog()?.querySelector(".plugin-publisher img")).toBeTruthy());
      await act(async () => dialog()!.querySelector<HTMLButtonElement>(".ui-dialog-close")!.click());
      // A card opens the plugin in a dialog, without leaving Discover.
      await act(async () => card("Market popular").querySelector<HTMLButtonElement>(".plugin-card-link")!.click());
      expect(opened).toEqual([]);
      expect(dialog()?.querySelector(".ui-dialog-title")?.textContent).toBe("Market popular");
      expect(dialog()?.textContent).toContain("Source verified");
      await act(async () => dialog()!.querySelector<HTMLButtonElement>(".ui-dialog-close")!.click());
      expect(dialog()).toBeNull();
      // An installed one offers its own page.
      await act(async () => card("Market owned").querySelector<HTMLButtonElement>(".plugin-card-link")!.click());
      await inDialog("Manage");
      expect(opened).toEqual(["acme/owned"]);
      expect(dialog()).toBeNull();
      await search("popular");
      expect(cards()).toEqual(["Market popular"]);
      expect(section("All plugins").querySelector("h2")?.textContent).toBe("All plugins1");
    });

    it("reviews a listed plugin from Get in its dialog, which a link opens too", async () => {
      market = { status: "ready", blocked: [], plugins: [listed("picked", { longDescription: "Picks things.", categories: ["art"], appliesTo: ["web-game"], asks: ["native"], adds: { skills: 2, panels: 1 },
        publishedAt: "2026-11-01T00:00:00.000Z", createdAt: "2026-06-01T00:00:00.000Z", size: 1_572_864 })] };
      await renderCatalog("acme/picked", "discover");
      await vi.waitFor(() => expect(dialog()?.querySelector(".ui-dialog-title")?.textContent).toBe("Market picked"));
      // Over the list it belongs to.
      expect(cards(section("All plugins"))).toEqual(["Market picked"]);
      const side = dialog()!.querySelector('[aria-label="Information"]')!;
      expect(dialog()!.querySelector(".plugin-publisher")?.textContent).toBe("@acme");
      expect(side.textContent).toContain("Art");
      expect(side.textContent).toContain("Web Game");
      expect(side.textContent).toContain("First published");
      // Its numbers are in one row: version, size and when it was updated.
      const stats = dialog()!.querySelector(".plugin-dialog-stats")!.textContent;
      expect(stats).toContain("Version1.0.0");
      expect(stats).toContain("Size1.5 MB");
      expect(stats).toContain("Updated");
      expect(dialog()!.textContent).toContain("Picks things.");
      expect(dialog()!.textContent).toContain("Run its own code on this computer");
      expect(dialog()!.querySelector(".plugin-store-adds")?.textContent).toContain("Panel1");
      await inDialog("Get");
      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      expect(dialog()?.querySelector(".ui-dialog-title")?.textContent).toMatch(/^Add /);
    });

    const rail = async (label: string) => {
      const item = [...container.querySelectorAll<HTMLButtonElement>(".plugins-rail-item")].find((button) => button.querySelector("span:not(.plugins-rail-check)")?.textContent === label)!;
      expect(item, label).toBeTruthy();
      await act(async () => item.click());
    };
    const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();

    it("shows a large market as an overview of a few rows, with categories and filters at the side", async () => {
      // In the daemon's order: featured, then by score.
      market = { status: "ready", blocked: [], plugins: [
        listed("hit", { featured: true, id: "ohmygame/hit", package: "@ohmygame/hit" }),
        ...[1, 2, 3, 4, 5, 6].map((n) => listed(`top-${n}`, { categories: ["art"], sourceVerified: n < 3 })),
        listed("new-1", { categories: ["audio"], createdAt: daysAgo(5), publishedAt: daysAgo(5) }),
        listed("new-2", { categories: ["audio"], createdAt: daysAgo(10), publishedAt: daysAgo(10) }),
        listed("old", { createdAt: daysAgo(400), publishedAt: daysAgo(1) }),
        ...[1, 2, 3].map((n) => listed(`more-${n}`, { categories: ["theme"] })),
      ] };
      await renderCatalog(undefined, "discover");
      // Each plugin shows once, in the first row that takes it; featured ones aren't recommended again.
      expect([...container.querySelectorAll(".plugins-section h2")].map((title) => title.textContent))
        .toEqual(["Featured", "Recommended", "New", "Recently updated"]);
      expect(cards(section("Featured"))).toEqual(["Market hit"]);
      expect(cards(section("Recommended"))).toEqual([1, 2, 3, 4, 5, 6].map((n) => `Market top-${n}`));
      expect(cards(section("New"))).toEqual(["Market new-1", "Market new-2"]);
      expect(cards(section("Recently updated"))).toEqual(["Market old"]);
      // The side list counts each category, and leaves out those nothing is in.
      const counts = [...container.querySelectorAll(".plugins-rail-item")].map((item) => item.textContent);
      expect(counts).toEqual(["Overview", "All plugins13", "Art6", "Audio2", "Appearance3", "Other2", "Official", "Source verified"]);
      await click("View all 13 plugins");
      expect(cards()).toHaveLength(13);
      await rail("Art");
      expect(section("Art").querySelector("h2")?.textContent).toBe("Art6");
      await pick("Sort", "Name");
      expect(cards()).toEqual([1, 2, 3, 4, 5, 6].map((n) => `Market top-${n}`));
      // Filters narrow the list and the counts beside it.
      await rail("Source verified");
      expect(cards()).toEqual(["Market top-1", "Market top-2"]);
      expect(container.querySelector(".plugins-rail-item[aria-pressed='true']")?.textContent).toBe("Source verified");
      await rail("Overview");
      // A filter shows one list, even from the overview.
      expect(container.querySelector('section[aria-label="Featured"]')).toBeNull();
      await rail("Source verified");
      expect(cards(section("Featured"))).toEqual(["Market hit"]);
    });

    it("shows a long list a page at a time", async () => {
      market = { status: "ready", blocked: [], plugins: Array.from({ length: 30 }, (_, index) => listed(`p${String(index).padStart(2, "0")}`, { categories: ["art"] })) };
      await renderCatalog(undefined, "discover");
      await rail("Art");
      expect(cards()).toHaveLength(24);
      await click("Show more (6 left)");
      expect(cards()).toHaveLength(30);
      expect(container.textContent).not.toContain("Show more");
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
      // Another registry is a source of its own, so npm's package couldn't join it.
      expect(card("Installed other").textContent).not.toContain("Update available");
      // They're listed first, and the tab says so too, with a dot rather than a count.
      expect(cards(section("Updates"))).toEqual(["Installed owned"]);
      const installedTab = [...container.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.startsWith("Installed"))!;
      expect(installedTab.querySelector(".ui-tab-dot")?.textContent).toBe("Updates available");
      // One added from this computer is the person's own, and never updates from the market.
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
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Discover", "Installed", "Mine"]);
    expect(tabs[2].getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[role="tablist"] .plugins-count')).toBeNull();
    tabs[2].focus();
    await act(async () =>
      tabs[2].dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      ),
    );
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(shown).toEqual(["installed"]);
  });

  it("filters installed plugins by what they add, Skills included", async () => {
    await renderCatalog();
    // One filter, offering only what some installed plugin adds.
    const contains = container.querySelector<HTMLButtonElement>('[aria-label="Contains"]')!;
    await act(async () => contains.click());
    expect([...document.querySelectorAll('[role="option"]')].map((option) => option.textContent))
      .toEqual(["Anything", "Skills", "MCP"]);
    await act(async () => contains.click());
    await pick("Contains", "MCP");
    expect(cards()).toEqual(["Unreal Engine", "New tool"]);

    // Skills shows each Skill on its own, and they go on and off with their plugin.
    await pick("Contains", "Skills");
    await vi.waitFor(() => expect(container.textContent).toContain("plan-game"));
    expect(container.textContent).toContain("design-game");
    // The person's own plugins' Skills too.
    expect(container.textContent).toContain("stripes");
    expect(container.querySelector('[aria-label="Disable design-game"]')).toBeNull();
    await search("plan");
    expect(container.textContent).toContain("plan-game");
    expect(container.textContent).not.toContain("design-game");
  });

  it("shows a plugin's skills after adding it", async () => {
    await renderCatalog();
    await pick("Contains", "Skills");
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
