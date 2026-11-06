// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginsSettings } from "../src/renderer/plugins.js";
import { PluginBuilderSessions } from "../src/renderer/plugin-builder.js";
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
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let saved: unknown;
let plugins: StorePlugin[];
let removed: string[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.location.hash = "#/plugins";
  plugins = [structuredClone(official), structuredClone(added), structuredClone(made)];
  saved = undefined;
  removed = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const route = new URL(url, "http://localhost").pathname.replace(
        /^\/api/,
        "",
      );
      if (route === "/health") return Response.json({ status: "ok" });
      if (route === "/plugin-store/plugins") return Response.json(plugins);
      if (route === "/plugins/setup-sessions")
        return Response.json([
          {
            id: "workspace",
            pluginId: made.id,
            mode: "edit",
            title: "Edit My Notes",
            status: "idle",
            createdAt: 0,
            updatedAt: 0,
          },
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

function section(name: string) {
  return [...container.querySelectorAll<HTMLElement>(".plugins-section")]
    .find(item => item.querySelector("h2")?.textContent?.startsWith(name))!;
}

describe("Plugin library", () => {
  it("shows beta metadata on the matching card without marking other plugins", async () => {
    plugins[0]!.beta = true;
    await act(async () => root.render(<PluginsSettings onPluginChange={() => {}} onTryPlugin={async () => {}} />));
    const cards = [...container.querySelectorAll(".plugin-card")];
    const betaCard = cards.find(card => card.querySelector(".plugin-card-name")?.textContent === "Studio")!;
    expect(betaCard.querySelector(".ui-badge")?.textContent).toBe("Beta");
    expect(betaCard.querySelector('[aria-label="Turn Studio on in every project"]')).not.toBeNull();
    expect(cards.filter(card => card.querySelector(".ui-badge"))).toEqual([betaCard]);
  });

  it("groups others' plugins by category, and keeps the person's own under Mine", async () => {
    await act(async () =>
      root.render(
        <PluginsSettings
          onPluginChange={() => {}}
          onTryPlugin={async () => {}}
        />,
      ),
    );
    expect(section("Other plugins").textContent).toContain("Studio");
    expect(section("Other plugins").textContent).toContain("Community Review");
    expect(section("Other plugins").textContent).not.toContain("My Notes");
    const toggle = () => container.querySelector<HTMLButtonElement>('[aria-label="Turn Studio on in every project"]')!;
    await act(async () => toggle().click());
    expect(saved).toEqual({ on: false });
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(window.location.hash).toBe("#/plugins");
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent === "Mine")!.click());
    expect(section("Your plugins").querySelectorAll(".plugin-card-name")).toHaveLength(1);
    expect(section("Your plugins").textContent).toContain("My Notes");
    expect(section("Your plugins").textContent).toContain("Create a plugin with AI");
    // The AI workspaces follow the person's plugins.
    expect(container.querySelector('[aria-label="Plugin workspaces"]')?.textContent).toContain("Edit My Notes");
  });

  it("shows AI workspaces as cards and asks before deleting one", async () => {
    await act(async () => root.render(<PluginBuilderSessions />));
    expect(container.querySelector(".plugin-builder-session-card")).not.toBeNull();
    const actions = container.querySelector<HTMLButtonElement>(
      '[aria-label="Actions for Edit My Notes"]',
    )!;
    const chooseDelete = async () => {
      await act(async () => actions.click());
      await act(async () =>
        [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
          .find((element) => element.textContent === "Delete")!
          .click(),
      );
    };
    await chooseDelete();
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog()?.textContent).toContain("Delete “Edit My Notes”?");
    await act(async () =>
      [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === "Cancel")!.click(),
    );
    expect(removed).toEqual([]);
    await chooseDelete();
    await act(async () =>
      [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === "Delete")!.click(),
    );
    expect(removed).toEqual(["/plugins/setup-sessions/workspace"]);
    await vi.waitFor(() =>
      expect(container.textContent).not.toContain("Edit My Notes"),
    );
  });
});
