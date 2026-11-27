// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSummary } from "../src/shared/contracts.js";
import type { PluginAddPreview, PluginMarketListing, PluginSourceUpdate, StorePlugin, StorePluginConfiguration } from "../src/shared/plugins.js";

let store: StorePlugin[] = [];
let market: PluginMarketListing = { status: "ready", plugins: [], blocked: [] };
let sourceUpdates: PluginSourceUpdate[] = [];
const api = {
  waitForRuntime: vi.fn(async () => {}),
  listProviders: vi.fn(async (): Promise<ProviderSummary[]> => []),
  readStorePluginConfiguration: vi.fn(async (): Promise<StorePluginConfiguration> => ({})),
  listStorePlugins: vi.fn(async () => store),
  readPluginMarket: vi.fn(async () => market),
  readPluginUpdates: vi.fn(async () => sourceUpdates),
  setStorePluginEveryProject: vi.fn(async (_id: string, _on: boolean) => {}),
  readPluginStatus: vi.fn(async () => ({ safeMode: false })),
  inspectAddedPlugin: vi.fn<(source: unknown) => Promise<PluginAddPreview>>(),
  addPlugin: vi.fn(async () => ({ id: "acme/maker", version: "1.1.0" })),
  readPluginUninstall: vi.fn(async () => ({ last: true, settings: 0, dataBytes: 0, projectFiles: [], projects: [] })),
  uninstallStorePlugin: vi.fn(async (id: string) => { store = store.filter((plugin) => plugin.id !== id); }),
};
vi.doMock(path.resolve("src/renderer/api.ts"), async () => ({
  ...(await vi.importActual(path.resolve("src/renderer/api.ts"))),
  ...api,
}));

const { PluginsSettings } = await import("../src/renderer/plugins.js");

const pluginRow = (id: string, displayName: string, version: string, repository: string): StorePlugin => ({
  id,
  version,
  revision: "a".repeat(64),
  displayName,
  description: `${displayName} plugin.`,
  capabilities: ["network:api.example.com"],
  grants: { enabled: true, allowed: ["network:api.example.com"] },
  bundled: false,
  everyProject: false,
  settings: [],
  examples: [],
  skills: [],
  adds: { projectTypes: [], panels: [], commands: [], mcpServers: [], modelProviders: [], agents: [], tools: 0, skills: 0 },
  origin: { type: "github", repository, commit: "c".repeat(40), release: `v${version}` },
});

const previewFor = (id: string, displayName: string, repository: string, version: string, newAsks: string[]): PluginAddPreview => ({
  source: { type: "market", id, version },
  digest: "d".repeat(64),
  id,
  version,
  displayName,
  description: `${displayName} plugin.`,
  appWide: false,
  asks: ["network:api.example.com", ...newAsks],
  newAsks,
  adds: { projectTypes: [], panels: [], commands: [], mcpServers: [], modelProviders: [], agents: [], tools: 0, skills: 0 },
  settings: false,
  installedVersions: ["1.0.0"],
  origin: { type: "github", repository, commit: "c".repeat(40), release: `v${version}` },
});

describe("PluginsSettings", () => {
  it("renders the plugin catalog", () => {
    const html = renderToStaticMarkup(<PluginsSettings onPluginChange={() => undefined} onTryPlugin={async () => undefined} />);

    expect(html).toContain("<h1>Plugins</h1>");
    expect(html).toContain("Loading plugins");
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tabpanel"');
  });

  it("opens plugin details from the route without rendering catalog controls", () => {
    const html = renderToStaticMarkup(<PluginsSettings pluginId="ohmygame/web-game-studio" onPluginChange={() => undefined} onTryPlugin={async () => undefined} />);

    expect(html).toContain("</span>Plugins</button>");
    expect(html).toContain("Loading plugin");
    expect(html).not.toContain("Search plugins");
  });

  describe("Installed", () => {
    let host: HTMLDivElement;
    let root: Root;
    const onPluginChange = vi.fn();

    beforeEach(() => {
      vi.clearAllMocks();
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
      store = [
        pluginRow("acme/alpha", "Alpha", "1.0.0", "acme/alpha"),
        pluginRow("acme/beta", "Beta", "1.0.0", "acme/beta"),
      ];
      market = {
        status: "ready",
        plugins: [
          { id: "acme/alpha", version: "1.1.0", displayName: "Alpha", description: "Alpha plugin.", asks: [], adds: {}, featured: false, sourceVerified: false, repository: "https://github.com/acme/alpha" },
          { id: "acme/beta", version: "2.0.0", displayName: "Beta", description: "Beta plugin.", asks: ["secrets"], adds: {}, featured: false, sourceVerified: false, repository: "https://github.com/acme/beta" },
        ],
        blocked: [],
      };
      sourceUpdates = [];
    });

    afterEach(async () => {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    });

    const renderInstalled = (pluginId?: string) => act(async () => {
      root.render(<PluginsSettings pluginId={pluginId} tab="installed" onPluginChange={onPluginChange} onTryPlugin={async () => undefined} />);
    });
    const updateButton = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="Update ${name}"]`);
    const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
    const statusButton = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(".ui-filter-chip")].find((item) =>
      item.firstChild?.textContent === label)!;
    const selectStatus = (label: string) => act(async () => statusButton(label).click());
    const renderUpdates = async () => {
      await renderInstalled();
      await selectStatus("Updates");
    };
    const setQuery = (query: string) => act(async () => {
      const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, query);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const cards = () => [...host.querySelectorAll(".installed-plugin-name")].map((card) => card.textContent);

    it("marks every-project plugins in All and keeps the editor open when a row leaves the filter", async () => {
      store = [
        { ...store[0]!, everyProject: true },
        { ...pluginRow("ohmygame/beta", "Beta", "1.0.0", "WhiteTowerAI/ohmygame-plugins"), preinstalled: true },
        { ...pluginRow("acme/gamma", "Gamma", "1.0.0", "acme/gamma"), everyProject: true, grants: { enabled: false, allowed: [] } },
      ];
      api.setStorePluginEveryProject.mockImplementationOnce(async (id, on) => {
        store = store.map((plugin) => plugin.id === id ? { ...plugin, everyProject: on } : plugin);
      });
      await renderInstalled();
      const scopes = () => [...host.querySelectorAll(".installed-plugin-scope")];
      expect(cards()).toEqual(["Alpha", "Beta", "Gamma"]);
      const officialSeals = host.querySelectorAll('.installed-plugin-title [role="img"][aria-label="Official"]');
      expect(officialSeals).toHaveLength(1);
      expect(officialSeals[0]?.previousElementSibling?.textContent).toBe("Beta");
      expect(officialSeals[0]?.closest(".installed-plugin-row")?.querySelector(".installed-plugin-meta")?.textContent).toBe("1.0.0 @ohmygame");
      expect(scopes()).toHaveLength(1);
      expect(scopes()[0]?.closest(".installed-plugin-row")?.querySelector(".installed-plugin-name")?.textContent).toBe("Alpha");
      expect(scopes()[0]?.previousElementSibling?.textContent).toBe("@acme");
      expect(scopes()[0]?.querySelector(".visually-hidden")?.textContent).toBe("On in every project");
      await selectStatus("On in every project");
      expect(statusButton("On in every project").textContent).toBe("On in every project1");
      expect(statusButton("On in every project").getAttribute("aria-pressed")).toBe("true");
      expect(cards()).toEqual(["Alpha"]);
      expect(scopes()).toHaveLength(0);
      const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
      toggle.focus();
      await act(async () => toggle.click());
      expect(api.setStorePluginEveryProject).toHaveBeenCalledExactlyOnceWith("acme/alpha", false);
      expect(cards()).toEqual([]);
      expect(host.querySelector(".installed-plugin-editor h1")?.textContent).toContain("Alpha");
      expect(host.textContent).toContain("No plugins on in every project");
      expect(statusButton("On in every project").textContent).toBe("On in every project0");
      await selectStatus("On in every project");
      expect(statusButton("All").getAttribute("aria-pressed")).toBe("true");
      expect(cards()).toEqual(["Alpha", "Beta", "Gamma"]);
      expect(scopes()).toHaveLength(0);
      expect(host.querySelector('[role="switch"][aria-label="Turn Alpha on in every project"]')?.getAttribute("aria-checked")).toBe("false");
    });

    it("offers a row's update and management on right-click, and uninstalls it there", async () => {
      store = [{ ...store[0]!, everyProject: true }, { ...store[1]!, bundled: true }];
      market = { ...market, plugins: market.plugins.filter((plugin) => plugin.id === "acme/alpha") };
      await renderInstalled("acme/alpha");
      const menuFor = async (name: string) => {
        const row = [...host.querySelectorAll(".installed-plugin-row")].find((item) => item.querySelector(".installed-plugin-name")?.textContent === name)!;
        await act(async () => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
        return [...document.querySelectorAll<HTMLButtonElement>(".ui-popover-menu [role^='menuitem']")];
      };
      // A plugin that comes with OhMyGame, with nothing newer, can't go.
      expect((await menuFor("Beta")).map((item) => item.textContent)).toEqual(["On in every project", "View log"]);
      await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      let items = await menuFor("Alpha");
      expect(items.map((item) => item.textContent)).toEqual(["Update", "On in every project", "View log", "Uninstall"]);
      expect(items[1]!.getAttribute("aria-checked")).toBe("true");
      await act(async () => items[1]!.click());
      expect(api.setStorePluginEveryProject).toHaveBeenCalledWith("acme/alpha", false);
      items = await menuFor("Alpha");
      await act(async () => items.at(-1)!.click());
      const dialog = document.querySelector('[role="dialog"]')!;
      expect(dialog.textContent).toContain("Alpha");
      await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Uninstall")!.click());
      expect(api.uninstallStorePlugin).toHaveBeenCalledWith("acme/alpha", "1.0.0", { keepData: false });
      // Its page was open, so the list comes back.
      expect(onPluginChange).toHaveBeenLastCalledWith();
      await renderInstalled();
      expect(cards()).toEqual(["Beta"]);
    });

    it("keeps each plugin's selected tab and settings draft when switching editors", async () => {
      store[0]!.settings = [{ name: "endpoint", title: "Endpoint", type: "text" }];
      store[0]!.adds.modelProviders = ["Alpha provider"];
      store[1]!.skills = [{ id: "example", name: "Example skill", description: "An example" }];
      await renderInstalled("acme/alpha");
      await act(async () => button("Settings")!.click());
      const endpoint = () => host.querySelector<HTMLInputElement>('.plugin-configuration input[type="text"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(endpoint(), "draft");
        endpoint().dispatchEvent(new Event("input", { bubbles: true }));
      });
      await renderInstalled("acme/beta");
      expect(host.querySelector('.installed-plugin-document:not([style*="display: none"]) h1')?.textContent).toContain("Beta");
      let finishProviderRefresh!: (providers: ProviderSummary[]) => void;
      api.listProviders.mockImplementationOnce(() => new Promise((resolve) => { finishProviderRefresh = resolve; }));
      await renderInstalled("acme/alpha");
      expect(button("Settings")?.getAttribute("aria-selected")).toBe("true");
      expect(endpoint().value).toBe("draft");
      await act(async () => finishProviderRefresh([]));
      await setQuery("Beta");
      expect(cards()).toEqual(["Beta"]);
      expect(endpoint().value).toBe("draft");
    });

    it("updates a single plugin in place when it asks for nothing new and shows its busy state", async () => {
      let finishInspect!: (value: PluginAddPreview) => void;
      api.inspectAddedPlugin.mockImplementationOnce(() => new Promise((resolve) => { finishInspect = resolve; }));
      api.addPlugin.mockImplementationOnce(async () => {
        store = [pluginRow("acme/alpha", "Alpha", "1.1.0", "acme/alpha"), store[1]!];
        return { id: "acme/alpha", version: "1.1.0" };
      });
      await renderUpdates();

      const alphaButton = () => updateButton("Alpha");
      const updateAllButton = () => button("Update all")!;

      expect(alphaButton()?.title).toBe("Update to 1.1.0");
      // The row's update reads as a button, not a bare reload icon.
      expect(alphaButton()?.textContent).toBe("Update");
      expect(statusButton("Updates").textContent).toBe("Updates2");
      expect(cards()).toEqual(["Alpha", "Beta"]);
      expect(host.querySelector(".installed-plugin-list [role=switch]")).toBeNull();
      await act(async () => alphaButton()!.click());
      expect(alphaButton()?.disabled).toBe(true);
      expect(alphaButton()?.getAttribute("aria-busy")).toBe("true");
      expect(updateAllButton().disabled).toBe(true);

      const preview = previewFor("acme/alpha", "Alpha", "acme/alpha", "1.1.0", []);
      await act(async () => finishInspect(preview));

      expect(api.addPlugin).toHaveBeenCalledWith(preview.source, preview.digest);
      expect(onPluginChange).not.toHaveBeenCalled();
      expect(alphaButton()).toBeNull();
      expect(updateButton("Beta")).not.toBeNull();
    });

    it("opens the review dialog without inspecting twice when a card update asks for new permissions, and stays on the list", async () => {
      const preview = previewFor("acme/beta", "Beta", "acme/beta", "2.0.0", ["secrets"]);
      api.inspectAddedPlugin.mockResolvedValueOnce(preview);
      api.addPlugin.mockImplementationOnce(async () => {
        store = [store[0]!, pluginRow("acme/beta", "Beta", "2.0.0", "acme/beta")];
        return { id: "acme/beta", version: "2.0.0" };
      });
      await renderUpdates();

      const betaButton = () => updateButton("Beta");
      await act(async () => betaButton()!.click());

      expect(api.inspectAddedPlugin).toHaveBeenCalledTimes(1);
      expect(api.addPlugin).not.toHaveBeenCalled();
      const dialog = document.querySelector<HTMLElement>(".ui-dialog")!;
      expect(dialog).not.toBeNull();
      expect(document.querySelector(".ui-dialog-title")?.textContent).toBe("Update Beta to 2.0.0?");
      expect(dialog.textContent).toContain("You'll be asked to allow only what's new.");

      const confirm = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Update")!;
      await act(async () => confirm.click());

      expect(api.addPlugin).toHaveBeenCalledWith(preview.source, preview.digest);
      expect(document.querySelector(".ui-dialog")).toBeNull();
      expect(onPluginChange).not.toHaveBeenCalled();
      expect(betaButton()).toBeNull();
    });

    it("offers a single update action without offering to update hidden search results", async () => {
      await renderInstalled();
      await setQuery("Alpha");

      expect(updateButton("Beta")).toBeNull();
      expect(updateButton("Alpha")).not.toBeNull();
      await selectStatus("Updates");
      expect(cards()).toEqual(["Alpha"]);
      expect(updateButton("Alpha")).not.toBeNull();
      expect(button("Update all")).toBeUndefined();
    });

    it("reserves the review dialog while a card update is inspected, even when opening another plugin", async () => {
      let finishInspect!: (value: PluginAddPreview) => void;
      api.inspectAddedPlugin.mockImplementationOnce(() => new Promise((resolve) => { finishInspect = resolve; }));
      await renderUpdates();
      await act(async () => updateButton("Alpha")!.click());
      expect(updateButton("Beta")?.disabled).toBe(true);

      await renderInstalled("acme/beta");
      expect(button("Update to 2.0.0")?.disabled).toBe(true);
      await act(async () => button("Update to 2.0.0")!.click());
      expect(api.inspectAddedPlugin).toHaveBeenCalledTimes(1);

      await act(async () => finishInspect(previewFor("acme/alpha", "Alpha", "acme/alpha", "1.1.0", ["secrets"])));
      expect(document.querySelectorAll(".ui-dialog")).toHaveLength(1);
      expect(document.querySelector(".ui-dialog-title")?.textContent).toBe("Update Alpha to 1.1.0?");
      expect(api.addPlugin).not.toHaveBeenCalled();

      await act(async () => document.querySelector<HTMLButtonElement>(".ui-dialog-close")!.click());
      expect(document.querySelector(".ui-dialog")).toBeNull();
      expect(button("Update to 2.0.0")?.disabled).toBe(false);
    });

    it("updates only packages with no new permissions during Update all", async () => {
      const alpha = previewFor("acme/alpha", "Alpha", "acme/alpha", "1.1.0", []);
      const beta = previewFor("acme/beta", "Beta", "acme/beta", "2.0.0", ["secrets"]);
      api.inspectAddedPlugin.mockResolvedValueOnce(alpha).mockResolvedValueOnce(beta);
      api.addPlugin.mockImplementationOnce(async () => {
        store = [pluginRow("acme/alpha", "Alpha", "1.1.0", "acme/alpha"), store[1]!];
        return { id: alpha.id, version: alpha.version };
      });
      await renderUpdates();
      await act(async () => button("Update all")!.click());

      expect(api.inspectAddedPlugin).toHaveBeenCalledTimes(2);
      expect(api.addPlugin).toHaveBeenCalledExactlyOnceWith(alpha.source, alpha.digest);
      expect(updateButton("Alpha")).toBeNull();
      expect(updateButton("Beta")?.disabled).toBe(false);
      expect(document.querySelector(".ui-dialog")).toBeNull();
    });

    it("reports a card update failure cleanly and lets the person retry", async () => {
      api.inspectAddedPlugin.mockRejectedValueOnce(new Error("Registry timed out"));
      await renderUpdates();

      const alphaButton = () => updateButton("Alpha")!;
      await act(async () => alphaButton().click());

      expect(host.querySelector('[role="alert"]')?.textContent).toContain("Alpha: Registry timed out");
      expect(alphaButton().disabled).toBe(false);
    });
  });
});
