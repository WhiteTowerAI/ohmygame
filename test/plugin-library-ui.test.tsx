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
const DRAFT = "00000000-0000-4000-8000-0000000d4af7";
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let saved: unknown;
let plugins: StorePlugin[];
let removed: string[];
let sessionsFail: boolean;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.location.hash = "#/plugins";
  plugins = [structuredClone(official), structuredClone(added), structuredClone(made), structuredClone(developed), structuredClone(imported)];
  saved = undefined;
  removed = [];
  sessionsFail = false;
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
          { id: DRAFT, mode: "create", title: "Tile painter", status: "ready", createdAt: 0, updatedAt: 1 },
        ]);
      if (route === `/plugins/setup-sessions/${DRAFT}/draft`) return Response.json({
        files: [], errors: [],
        plugin: { id: "_draft/x", version: "0.1.0", displayName: "Tile painter", description: "Paints tiles.", examples: [], appWide: false, asks: [],
          skills: [{ id: "paint", name: "Paint tiles", description: "" }], mcpServers: [], settings: false,
          adds: { projectTypes: [], panels: [], commands: [], mcpServers: [], modelProviders: [], agents: [], skills: 1, tools: 0 } },
      });
      if (
        route === `/plugins/setup-sessions/${DRAFT}` &&
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

/** Installed's groups, by heading, with the names in each. */
function groups() {
  return [...container.querySelectorAll<HTMLElement>(".installed-plugin-group")].map(group => [
    group.querySelector("h2")?.textContent,
    [...group.querySelectorAll(".installed-plugin-name")].map(name => name.textContent),
  ]);
}

function row(name: string) {
  return [...container.querySelectorAll<HTMLElement>(".installed-plugin-row")].find(item => item.querySelector(".installed-plugin-name")?.textContent === name)!;
}

describe("Plugin library", () => {
  it("shows beta metadata in the selected plugin's details", async () => {
    plugins[0]!.beta = true;
    await act(async () => root.render(<PluginsSettings tab="installed" pluginId={plugins[0]!.id} onPluginChange={() => {}} onTryPlugin={async () => {}} />));
    expect(container.querySelector(".installed-plugin-editor h1 .ui-badge")?.textContent).toBe("Beta");
    expect(container.querySelector(".installed-plugin-list .ui-badge")).toBeNull();
  });

  it("lists every plugin, the person's own among them", async () => {
    await act(async () =>
      root.render(
        <PluginsSettings
          tab="installed" pluginId={plugins[0]!.id}
          onPluginChange={() => {}}
          onTryPlugin={async () => {}}
        />,
      ),
    );
    expect(container.querySelector(".installed-plugin-inventory")!.textContent).toContain("Studio");
    expect(container.querySelector(".installed-plugin-inventory")!.textContent).toContain("Community Review");
    // Their own is switched on and off with the rest.
    expect(container.querySelector(".installed-plugin-inventory")!.textContent).toContain("My Notes");
    const toggle = () => container.querySelector<HTMLButtonElement>('[aria-label="Turn Studio on in every project"]')!;
    await act(async () => toggle().click());
    expect(saved).toEqual({ on: false });
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(window.location.hash).toBe("#/plugins");
    // Making one starts from the header's Add menu, on either tab.
    expect([...container.querySelectorAll(".plugins-toolbar button")].map(button => button.textContent)).toContain("Add");
  });

  it("lists what the person makes first, a draft opening its page beside the list", async () => {
    const opened: string[] = [];
    await act(async () => root.render(<PluginsSettings tab="installed" onPluginChange={id => opened.push(id!)} onTryPlugin={async () => {}} />));
    // Their own and one developed from a folder, then a draft not installed yet; not a package added from a folder.
    expect(groups()).toEqual([
      ["Made by you", ["Level Tools", "My Notes", "Tile painter"]],
      ["Others", ["Community Review", "Imported Pack", "Studio"]],
    ]);
    expect(row("Tile painter").textContent).toContain("Draft, not installed");
    expect(row("My Notes").textContent).not.toContain("@personal");
    // An installed one and the draft both open their page beside the list.
    await act(async () => row("My Notes").querySelector<HTMLButtonElement>(".installed-plugin-open")!.click());
    await act(async () => row("Tile painter").querySelector<HTMLButtonElement>(".installed-plugin-open")!.click());
    expect(opened).toEqual([made.id, `_draft/${DRAFT}`]);
    await act(async () => root.render(<PluginsSettings tab="installed" pluginId={`_draft/${DRAFT}`} onPluginChange={() => {}} onTryPlugin={async () => {}} />));
    await vi.waitFor(() => expect(container.querySelector(".installed-plugin-editor")!.textContent).toContain("Paint tiles"));
    expect(row("Tile painter").querySelector("[aria-current]")).not.toBeNull();
    // Pages opened before stay mounted but hidden; the draft's comes last.
    expect([...container.querySelectorAll(".installed-plugin-editor h1")].at(-1)?.textContent).toBe("Tile painter");
    // Its next step is back into the Builder.
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".installed-plugin-editor button")].find(button => button.textContent === "Keep making")!.click());
    expect(window.location.hash).toBe(`#/plugins/builder/${DRAFT}`);
  });

  it("finds drafts by name, and lists the plugins when workspaces can't be read", async () => {
    await act(async () => root.render(<PluginsSettings tab="installed" onPluginChange={() => {}} onTryPlugin={async () => {}} />));
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search plugins"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "tile");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // One group needs no heading.
    expect(groups()).toEqual([[undefined, ["Tile painter"]]]);

    await act(async () => root.unmount());
    root = createRoot(container);
    sessionsFail = true;
    await act(async () => root.render(<PluginsSettings tab="installed" onPluginChange={() => {}} onTryPlugin={async () => {}} />));
    await vi.waitFor(() => expect(container.textContent).toContain("Disk unreadable"));
    expect(groups()[0]).toEqual(["Made by you", ["Level Tools", "My Notes"]]);
  });

  it("asks before deleting a draft's workspace", async () => {
    await act(async () => root.render(<PluginsSettings tab="installed" onPluginChange={() => {}} onTryPlugin={async () => {}} />));
    const chooseDelete = async () => {
      await act(async () => row("Tile painter").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
      const items = [...document.querySelectorAll<HTMLButtonElement>(".ui-popover-menu [role^='menuitem']")];
      expect(items.map(item => item.textContent)).toEqual(["Delete workspace"]);
      await act(async () => items[0]!.click());
    };
    await chooseDelete();
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog()?.textContent).toContain("Delete “Tile painter”?");
    await act(async () =>
      [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === "Cancel")!.click(),
    );
    expect(removed).toEqual([]);
    await chooseDelete();
    await act(async () =>
      [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === "Delete")!.click(),
    );
    expect(removed).toEqual([`/plugins/setup-sessions/${DRAFT}`]);
    await vi.waitFor(() => expect(groups()[0]).toEqual(["Made by you", ["Level Tools", "My Notes"]]));
  });
});
