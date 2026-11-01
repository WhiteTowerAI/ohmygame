// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginDetail, PluginSummary, StorePlugin } from "../src/shared/plugins.js";
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

let container: HTMLDivElement, root: ReturnType<typeof createRoot>;
let catalog: PluginSummary[];
let store: StorePlugin[];
let skills: Record<string, PluginDetail["skills"]>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  catalog = [
    plugin("new-tool", "New tool"),
    plugin("zebra", "Zebra", true, true),
    plugin("alpha", "Alpha", false, true),
  ].reverse();
  Object.assign(catalog.find((item) => item.id === "ohmygame:new-tool")!, {
    projectTypes: ["web-game"], skillCount: 1, mcpServerCount: 1,
  });
  const off = { grants: { enabled: false, allowed: [] } };
  store = [
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
  skills = {
    "ohmygame:new-tool": [{ id: "skills/plan/SKILL.md", name: "plan-game", description: "Plan a game", enabled: true }],
    "personal:alpha": [{ id: "skills/publish/SKILL.md", name: "publish-wechat", enabled: true }],
    "personal:zebra": [{ id: "skills/stripes/SKILL.md", name: "stripes", enabled: false }],
  };
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
      if (init.method === "PUT" && route.startsWith("/plugin-store/") && route.endsWith("/enabled")) {
        const id = route.slice("/plugin-store/".length, -"/enabled".length);
        store.find((plugin) => plugin.id === id)!.grants = { enabled: JSON.parse(String(init.body)).enabled, allowed: [] };
        return new Response(null, { status: 204 });
      }
      if (route === "/plugins")
        return Response.json({ plugins: catalog, errors: [] });
      if (init.method === "PUT" && route.endsWith("/settings")) {
        const id = decodeURIComponent(
          route.slice("/plugins/".length, -"/settings".length),
        );
        const item = catalog.find((plugin) => plugin.id === id)!;
        const settings = JSON.parse(String(init.body));
        item.enabled = settings.enabled;
        skills[id] = (skills[id] ?? []).map((skill) => ({
          ...skill,
          enabled: settings.components[`skill:${skill.id}`] ?? skill.enabled,
        }));
        return Response.json({ ...item, skills: skills[id], connections: [] });
      }
      if (!init.method && route.startsWith("/plugins/")) {
        const item = catalog.find(
          (plugin) => plugin.id === decodeURIComponent(route.slice("/plugins/".length)),
        )!;
        return Response.json({ ...item, skills: skills[item.id] ?? [], connections: [] });
      }
      if (init.method === "POST" && route === "/plugins/inspect")
        return Response.json({ candidates: [{ key: "fresh", name: "fresh", displayName: "Fresh" }] });
      if (init.method === "POST" && route === "/plugins/install") {
        const fresh = plugin("fresh", "Fresh", true, true);
        catalog.push(fresh);
        skills[fresh.id] = [{ id: "skills/fresh/SKILL.md", name: "fresh-skill", enabled: true }];
        return Response.json({ ...fresh, skills: skills[fresh.id], connections: [] });
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
  return [...parent.querySelectorAll(".plugin-card-name")].map(
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
    catalog.push(...["one", "two", "three", "four", "five", "six"].map((name) => plugin(`extra-${name}`, `Extra ${name}`)));
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
      expect.arrayContaining(["Browse plugins", "Create with AI…", "Install from Git…"]),
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
        .find((item) => item.textContent?.startsWith("Install from Git"))!
        .click(),
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector(".ui-dialog-title")?.textContent).toBe(
      "Install from Git",
    );
  });

  it("switches tabs with the arrow keys and filters Browse by source and project type", async () => {
    await renderCatalog();
    const tabs = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Installed15", "Browse", "Skills"]);
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

  it("lists every plugin's skills and switches them through their plugin", async () => {
    await renderCatalog();
    await click("Skills");
    await vi.waitFor(() => expect(container.textContent).toContain("plan-game"));
    const sections = [...container.querySelectorAll(".plugins-section")];
    expect(sections.map((section) => section.querySelector("h2")?.textContent)).toEqual([
      "From plugins 2",
      "Personal 2",
    ]);
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Skills4");
    // A format 2 plugin's Skills go on and off with it.
    expect(container.textContent).toContain("design-game");
    expect(container.querySelector('[aria-label="Disable design-game"]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('[aria-label="Search skills"]')).not.toBeNull();
    // A disabled plugin's skills cannot be switched on their own.
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Disable publish-wechat"]')?.disabled).toBe(true);
    await click("Disable plan-game");
    expect(skills["ohmygame:new-tool"]![0]!.enabled).toBe(false);
    expect(container.querySelector('[aria-label="Enable plan-game"]')?.getAttribute("aria-checked")).toBe("false");
    await search("stripes", "Search skills");
    expect(container.textContent).not.toContain("plan-game");
    expect(container.textContent).toContain("stripes");
  });

  it("shows a plugin's skills after installing it from Git", async () => {
    await renderCatalog();
    await click("Skills");
    await vi.waitFor(() => expect(container.textContent).toContain("plan-game"));
    await click("Add");
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((item) => item.textContent?.startsWith("Install from Git"))!
        .click(),
    );
    const url = document.querySelector<HTMLInputElement>('.ui-dialog input[type="url"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(url, "https://example.com/fresh.git");
      url.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => url.form!.requestSubmit());
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
