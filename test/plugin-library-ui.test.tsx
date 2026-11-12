// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginsSettings } from "../src/renderer/plugins.js";
import type { StorePlugin } from "../src/shared/plugins.js";

const official: StorePlugin = {
  id: "ohmygame/studio",
  version: "1.0.0",
  revision: "a".repeat(64),
  displayName: "Studio",
  description: "Make games",
  capabilities: [],
  grants: { enabled: true, allowed: [] },
  bundled: true,
  everyProject: true,
  examples: [],
  settings: [],
  skills: [],
  adds: { projectTypes: [], panels: [], commands: [], mcpServers: [], modelProviders: [], agents: [], tools: 0, skills: 0 },
};
const added: StorePlugin = { ...official, id: "acme/review", displayName: "Community Review", bundled: false,
  origin: { type: "github", repository: "acme/review", commit: "a".repeat(40) } };
const made: StorePlugin = { ...official, id: "personal/notes", displayName: "My Notes", bundled: false };
const developed: StorePlugin = { ...official, id: "acme/level-tools", displayName: "Level Tools", bundled: false,
  origin: { type: "development", folder: "/work/level-tools" } };
const imported: StorePlugin = { ...official, id: "acme/imported", displayName: "Imported Pack", bundled: false };
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let saved: unknown;
let plugins: StorePlugin[];
let removed: string[];
let sessionsFail: boolean;
let earlierSessions: unknown[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.location.hash = "#/plugins";
  plugins = [structuredClone(official), structuredClone(added), structuredClone(made), structuredClone(developed), structuredClone(imported)];
  saved = undefined;
  removed = [];
  sessionsFail = false;
  earlierSessions = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const route = new URL(url, "http://localhost").pathname.replace(
        /^\/api/,
        "",
      );
      if (route === "/health") return Response.json({ status: "ok" });
      if (route === "/plugin-store/plugins") return Response.json(plugins);
      if (route === "/plugins/setup-sessions" && sessionsFail) return Response.json({ error: "Disk unreadable" }, { status: 500 });
      if (route === "/plugins/setup-sessions")
        return Response.json([
          {
            id: "workspace",
            pluginId: made.id,
            mode: "edit",
            title: "Edit My Notes",
            status: "idle",
            createdAt: 0,
            updatedAt: 2,
          },
          { id: "draft", mode: "create", title: "Tile painter", status: "ready", createdAt: 0, updatedAt: 1 },
          ...earlierSessions,
        ]);
      if (
        route === "/plugins/setup-sessions/workspace" &&
        init.method === "DELETE"
      ) {
        removed.push(route);
        return new Response(null, { status: 204 });
      }
      if (route === `/plugin-store/${official.id}/every-project` && init.method === "PUT") {
        saved = JSON.parse(init.body as string);
        plugins[0] = { ...plugins[0]!, everyProject: false };
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${route}`);
    }),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openMine() {
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent === "Mine")!.click());
}

function section(name: string) {
  return [...container.querySelectorAll<HTMLElement>(".plugins-section")]
    .find(item => item.querySelector("h2")?.textContent?.startsWith(name))!;
}

describe("Plugin library", () => {
  it("shows beta metadata on the matching card without marking other plugins", async () => {
    plugins[0]!.beta = true;
    await act(async () => root.render(<PluginsSettings tab="installed" onPluginChange={() => {}} onTryPlugin={async () => {}} />));
    const cards = [...container.querySelectorAll(".plugin-card")];
    const betaCard = cards.find(card => card.querySelector(".plugin-card-name")?.textContent === "Studio")!;
    expect(betaCard.querySelector(".ui-badge")?.textContent).toBe("Beta");
    expect(betaCard.querySelector('[aria-label="Turn Studio on in every project"]')).not.toBeNull();
    expect(cards.filter(card => [...card.querySelectorAll(".ui-badge")].some(badge => badge.textContent === "Beta"))).toEqual([betaCard]);
  });

  it("groups every plugin by category, the person's own among them", async () => {
    await act(async () =>
      root.render(
        <PluginsSettings
          tab="installed"
          onPluginChange={() => {}}
          onTryPlugin={async () => {}}
        />,
      ),
    );
    expect(section("Other").textContent).toContain("Studio");
    expect(section("Other").textContent).toContain("Community Review");
    // Their own is switched on and off with the rest.
    expect(section("Other").textContent).toContain("My Notes");
    const toggle = () => container.querySelector<HTMLButtonElement>('[aria-label="Turn Studio on in every project"]')!;
    await act(async () => toggle().click());
    expect(saved).toEqual({ on: false });
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(window.location.hash).toBe("#/plugins");
    await openMine();
    expect(container.querySelector(".plugins-create")?.textContent).toContain("Create a plugin with AI");
  });

  it("shows each plugin the person makes as a card under Mine, which opens where it's made", async () => {
    const opened: string[] = [];
    await act(async () => root.render(<PluginsSettings tab="mine" onPluginChange={id => opened.push(id!)} onTryPlugin={async () => {}} />));
    const mine = section("Your plugins");
    const card = (name: string) => [...mine.querySelectorAll<HTMLElement>(".plugin-card")].find(item => item.querySelector(".plugin-card-name")?.textContent === name);
    // A workspace's plugin, a draft not installed yet, and one developed from a folder; not a package added from one.
    expect([...mine.querySelectorAll(".plugin-card-name")].map(name => name.textContent)).toEqual(["My Notes", "Tile painter", "Level Tools"]);
    expect(card("My Notes")!.textContent).toContain("Installed · v1.0.0");
    expect(card("Tile painter")!.textContent).toContain("Draft, not installed");
    expect(card("Level Tools")!.textContent).toContain("In development");
    // Its workspace opens without a dialog; one developed from a folder opens its page.
    await act(async () => card("My Notes")!.querySelector<HTMLButtonElement>(".plugin-card-link")!.click());
    expect(window.location.hash).toBe("#/plugins/builder/workspace");
    await act(async () => card("Level Tools")!.querySelector<HTMLButtonElement>(".plugin-card-link")!.click());
    expect(opened).toEqual([developed.id]);
  });

  it("keeps a plugin's earlier workspaces in its menu, its installed state while searching, and its card when workspaces can't be read", async () => {
    earlierSessions = [{ id: "earlier", pluginId: made.id, mode: "create", title: "My Notes", status: "installed", createdAt: 0, updatedAt: Date.UTC(2026, 0, 5) }];
    await act(async () => root.render(<PluginsSettings tab="mine" onPluginChange={() => {}} onTryPlugin={async () => {}} />));
    // One card for the plugin; its earlier workspace is in the menu.
    expect([...section("Your plugins").querySelectorAll(".plugin-card-name")].map(name => name.textContent)).toEqual(["My Notes", "Tile painter", "Level Tools"]);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Actions for My Notes"]')!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent?.startsWith("Open the workspace from"))!.click());
    expect(window.location.hash).toBe("#/plugins/builder/earlier");

    // A search that names neither leaves the plugin as it is, not a draft.
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search plugins"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "notes");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([...section("Your plugins").querySelectorAll(".plugin-card")].map(card => card.textContent)).toEqual([expect.stringContaining("Installed · v1.0.0")]);

    await act(async () => root.unmount());
    root = createRoot(container);
    sessionsFail = true;
    await act(async () => root.render(<PluginsSettings tab="mine" onPluginChange={() => {}} onTryPlugin={async () => {}} />));
    await vi.waitFor(() => expect(container.textContent).toContain("Disk unreadable"));
    expect([...section("Your plugins").querySelectorAll(".plugin-card-name")].map(name => name.textContent)).toEqual(["Level Tools", "My Notes"]);
  });

  it("asks before deleting a plugin's workspace, and keeps the plugin", async () => {
    await act(async () => root.render(<PluginsSettings tab="mine" onPluginChange={() => {}} onTryPlugin={async () => {}} />));
    const actions = () => container.querySelector<HTMLButtonElement>('[aria-label="Actions for My Notes"]')!;
    const menu = async () => {
      await act(async () => actions().click());
      return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    };
    const chooseDelete = async () => {
      const items = await menu();
      await act(async () => items.find((element) => element.textContent === "Delete workspace")!.click());
    };
    await chooseDelete();
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog()?.textContent).toContain("Delete “My Notes”?");
    expect(dialog()?.textContent).toContain("The installed plugin stays");
    await act(async () =>
      [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === "Cancel")!.click(),
    );
    expect(removed).toEqual([]);
    await chooseDelete();
    await act(async () =>
      [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === "Delete")!.click(),
    );
    expect(removed).toEqual(["/plugins/setup-sessions/workspace"]);
    // The plugin stays, with nothing to delete now.
    const notes = () => [...section("Your plugins").querySelectorAll(".plugin-card")].find(card => card.textContent?.includes("My Notes"));
    await vi.waitFor(() => expect(notes()?.textContent).not.toContain("Edited"));
    expect((await menu()).map(item => item.textContent)).toEqual(["Open plugin"]);
  });
});
