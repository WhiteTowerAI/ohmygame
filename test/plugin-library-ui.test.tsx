// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginsSettings } from "../src/renderer/plugins.js";
import { PluginBuilderSessions } from "../src/renderer/plugin-builder.js";
import type { PluginDetail } from "../src/shared/plugins.js";

const official: PluginDetail = {
  id: "ohmygame:studio",
  name: "studio",
  displayName: "Studio",
  description: "Make games",
  source: { type: "builtIn" },
  marketplace: { id: "ohmygame", displayName: "OhMyGame" },
  installed: true,
  enabled: true,
  skills: [
    { id: "skills/studio/SKILL.md", name: "Studio skill", enabled: false },
  ],
  connections: [],
};
const imported: PluginDetail = {
  ...official,
  id: "marketplace:community:review",
  name: "review",
  displayName: "Community Review",
  source: {
    type: "git",
    url: "https://github.com/example/review",
    commit: "a".repeat(40),
  },
  marketplace: { id: "community", displayName: "Community" },
};
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let saved: unknown;
let plugins: PluginDetail[];
let removed: string[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.location.hash = "#/plugins";
  plugins = [structuredClone(official), structuredClone(imported)];
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
      if (route === "/plugins") return Response.json({ plugins, errors: [] });
      if (route === "/plugins/setup-sessions")
        return Response.json([
          {
            id: "workspace",
            pluginId: official.id,
            mode: "configure",
            title: "Configure Studio",
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
      if (
        route === `/plugins/${encodeURIComponent(official.id)}/settings` &&
        init.method === "PUT"
      ) {
        saved = JSON.parse(init.body as string);
        plugins[0] = { ...plugins[0]!, enabled: false };
        return Response.json(plugins[0]);
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
    expect(betaCard.querySelector('[aria-label="Disable Studio"]')).not.toBeNull();
    expect(section("Personal").querySelector(".ui-badge")).toBeNull();
  });

  it("groups official plugins by category and user marketplace imports under Personal", async () => {
    await act(async () =>
      root.render(
        <PluginsSettings
          onPluginChange={() => {}}
          onTryPlugin={async () => {}}
        />,
      ),
    );
    expect(section("Other plugins").textContent).toContain("Studio");
    expect(section("Other plugins").textContent).not.toContain("Community Review");
    expect(section("Personal").querySelectorAll(".plugin-card-name")).toHaveLength(1);
    expect(section("Personal").textContent).toContain("Community Review");
    // The AI workspaces follow the Personal plugins.
    expect(container.querySelector('[aria-label="Plugin workspaces"]')?.textContent).toContain("Configure Studio");
    const toggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Disable Studio"]',
    )!;
    await act(async () => toggle.click());
    expect(saved).toEqual({ enabled: false, components: {} });
    expect(
      container
        .querySelector('[aria-label="Enable Studio"]')
        ?.getAttribute("aria-checked"),
    ).toBe("false");
    expect(plugins[0]!.skills[0]!.enabled).toBe(false);
    expect(window.location.hash).toBe("#/plugins");
  });

  it("shows AI workspaces as cards and asks before deleting one", async () => {
    await act(async () => root.render(<PluginBuilderSessions />));
    expect(container.querySelector(".plugin-builder-session-card")).not.toBeNull();
    const actions = container.querySelector<HTMLButtonElement>(
      '[aria-label="Actions for Configure Studio"]',
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
    expect(dialog()?.textContent).toContain("Delete “Configure Studio”?");
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
      expect(container.textContent).not.toContain("Configure Studio"),
    );
  });
});
