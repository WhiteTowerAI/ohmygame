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
  window.location.hash = "#/settings/plugins";
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

describe("Plugin library", () => {
  it("groups official plugins under Public and user marketplace imports under Personal", async () => {
    await act(async () =>
      root.render(
        <PluginsSettings
          onPluginChange={() => {}}
          onTryPlugin={async () => {}}
        />,
      ),
    );
    expect(
      container.querySelector('[aria-labelledby="public-plugins-title"]')
        ?.textContent,
    ).toContain("Studio");
    expect(
      container.querySelector('[aria-labelledby="public-plugins-title"]')
        ?.textContent,
    ).not.toContain("Community Review");
    expect(
      container.querySelector('[aria-labelledby="personal-plugins-title"]')
        ?.textContent,
    ).toContain("Community Review");
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
    expect(window.location.hash).toBe("#/settings/plugins");
  });

  it("shows compact configuration workspaces with delete in the actions menu", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => root.render(<PluginBuilderSessions />));
    expect(
      container.querySelector(".plugin-builder-session-card"),
    ).not.toBeNull();
    expect(container.querySelector(".plugin-catalog-card")).toBeNull();
    const actions = container.querySelector<HTMLButtonElement>(
      '[aria-label="Actions for Configure Studio"]',
    )!;
    await act(async () => actions.click());
    const remove = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((element) => element.textContent === "Delete")!;
    await act(async () => remove.click());
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("Configure Studio"),
    );
    expect(removed).toEqual([]);
    confirm.mockReturnValue(true);
    await act(async () => actions.click());
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((element) => element.textContent === "Delete")!
        .click(),
    );
    expect(removed).toEqual(["/plugins/setup-sessions/workspace"]);
    await vi.waitFor(() =>
      expect(container.textContent).not.toContain("Configure Studio"),
    );
  });
});
