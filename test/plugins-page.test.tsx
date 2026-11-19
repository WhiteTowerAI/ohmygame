// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginAddPreview, PluginMarketListing, PluginSourceUpdate, StorePlugin } from "../src/shared/plugins.js";

let store: StorePlugin[] = [];
let market: PluginMarketListing = { status: "ready", plugins: [], blocked: [] };
let sourceUpdates: PluginSourceUpdate[] = [];
const api = {
  waitForRuntime: vi.fn(async () => {}),
  listStorePlugins: vi.fn(async () => store),
  readPluginMarket: vi.fn(async () => market),
  readPluginUpdates: vi.fn(async () => sourceUpdates),
  readPluginStatus: vi.fn(async () => ({ safeMode: false })),
  inspectAddedPlugin: vi.fn<(source: unknown) => Promise<PluginAddPreview>>(),
  addPlugin: vi.fn(async () => ({ id: "acme/maker", version: "1.1.0" })),
};
vi.doMock(path.resolve("src/renderer/api.ts"), async () => ({
  ...(await vi.importActual(path.resolve("src/renderer/api.ts"))),
  ...api,
}));

const { PluginsSettings } = await import("../src/renderer/plugins.js");

const pluginRow = (id: string, displayName: string, version: string, pkg: string): StorePlugin => ({
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
  origin: { type: "npm", package: pkg, version, registry: "npmjs" },
});

const previewFor = (id: string, displayName: string, pkg: string, version: string, newAsks: string[]): PluginAddPreview => ({
  source: { type: "npm", name: pkg, version, registry: "npmjs", market: true },
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
  origin: { type: "npm", package: pkg, version, registry: "npmjs" },
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

  describe("card updates in Installed", () => {
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
        pluginRow("acme/alpha", "Alpha", "1.0.0", "@acme/alpha"),
        pluginRow("acme/beta", "Beta", "1.0.0", "@acme/beta"),
      ];
      market = {
        status: "ready",
        plugins: [
          { id: "acme/alpha", package: "@acme/alpha", version: "1.1.0", displayName: "Alpha", description: "Alpha plugin.", asks: [], adds: {}, featured: false, sourceVerified: false },
          { id: "acme/beta", package: "@acme/beta", version: "2.0.0", displayName: "Beta", description: "Beta plugin.", asks: ["secrets"], adds: {}, featured: false, sourceVerified: false },
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

    it("updates a single plugin in place when it asks for nothing new and shows its busy state", async () => {
      let finishInspect!: (value: PluginAddPreview) => void;
      api.inspectAddedPlugin.mockImplementationOnce(() => new Promise((resolve) => { finishInspect = resolve; }));
      api.addPlugin.mockImplementationOnce(async () => {
        store = [pluginRow("acme/alpha", "Alpha", "1.1.0", "@acme/alpha"), store[1]!];
        return { id: "acme/alpha", version: "1.1.0" };
      });
      await renderInstalled();

      const updatesSection = () => host.querySelector<HTMLElement>(".plugins-updates")!;
      const alphaButton = () => updatesSection().querySelector<HTMLButtonElement>('button[aria-label="Update Alpha"]');
      const updateAllButton = () => [...updatesSection().querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Update all")!;

      expect(alphaButton()?.title).toBe("Update to 1.1.0");
      expect(host.querySelectorAll('button[aria-label="Update Alpha"]')).toHaveLength(1);
      expect(updatesSection().querySelector('[role="switch"]')).toBeNull();
      expect(host.querySelectorAll('[role="switch"]')).toHaveLength(2);
      await act(async () => alphaButton()!.click());
      expect(alphaButton()?.disabled).toBe(true);
      expect(alphaButton()?.getAttribute("aria-busy")).toBe("true");
      expect(updateAllButton().disabled).toBe(true);

      const preview = previewFor("acme/alpha", "Alpha", "@acme/alpha", "1.1.0", []);
      await act(async () => finishInspect(preview));

      expect(api.addPlugin).toHaveBeenCalledWith(preview.source, preview.digest);
      expect(onPluginChange).not.toHaveBeenCalled();
      expect(alphaButton()).toBeNull();
      expect(updatesSection().querySelector('button[aria-label="Update Beta"]')).not.toBeNull();
    });

    it("opens the review dialog without inspecting twice when a card update asks for new permissions, and stays on the list", async () => {
      const preview = previewFor("acme/beta", "Beta", "@acme/beta", "2.0.0", ["secrets"]);
      api.inspectAddedPlugin.mockResolvedValueOnce(preview);
      api.addPlugin.mockImplementationOnce(async () => {
        store = [store[0]!, pluginRow("acme/beta", "Beta", "2.0.0", "@acme/beta")];
        return { id: "acme/beta", version: "2.0.0" };
      });
      await renderInstalled();

      const betaButton = () => host.querySelector<HTMLButtonElement>('.plugins-updates button[aria-label="Update Beta"]');
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

    it("offers a single update action on a search result when the Updates section is hidden", async () => {
      await renderInstalled();
      const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Alpha");
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });

      expect(host.querySelector(".plugins-updates")).toBeNull();
      expect(updateButton("Beta")).toBeNull();
      expect(updateButton("Alpha")).not.toBeNull();
      expect(host.querySelector('[role="switch"]')).toBeNull();
    });

    it("reserves the review dialog while a card update is inspected, even when opening another plugin", async () => {
      let finishInspect!: (value: PluginAddPreview) => void;
      api.inspectAddedPlugin.mockImplementationOnce(() => new Promise((resolve) => { finishInspect = resolve; }));
      await renderInstalled();
      await act(async () => updateButton("Alpha")!.click());
      expect(updateButton("Beta")?.disabled).toBe(true);

      await renderInstalled("acme/beta");
      expect(button("Update to 2.0.0")?.disabled).toBe(true);
      await act(async () => button("Update to 2.0.0")!.click());
      expect(api.inspectAddedPlugin).toHaveBeenCalledTimes(1);

      await act(async () => finishInspect(previewFor("acme/alpha", "Alpha", "@acme/alpha", "1.1.0", ["secrets"])));
      expect(document.querySelectorAll(".ui-dialog")).toHaveLength(1);
      expect(document.querySelector(".ui-dialog-title")?.textContent).toBe("Update Alpha to 1.1.0?");
      expect(api.addPlugin).not.toHaveBeenCalled();

      await act(async () => document.querySelector<HTMLButtonElement>(".ui-dialog-close")!.click());
      expect(document.querySelector(".ui-dialog")).toBeNull();
      expect(button("Update to 2.0.0")?.disabled).toBe(false);
    });

    it("updates only packages with no new permissions during Update all", async () => {
      const alpha = previewFor("acme/alpha", "Alpha", "@acme/alpha", "1.1.0", []);
      const beta = previewFor("acme/beta", "Beta", "@acme/beta", "2.0.0", ["secrets"]);
      api.inspectAddedPlugin.mockResolvedValueOnce(alpha).mockResolvedValueOnce(beta);
      api.addPlugin.mockImplementationOnce(async () => {
        store = [pluginRow("acme/alpha", "Alpha", "1.1.0", "@acme/alpha"), store[1]!];
        return { id: alpha.id, version: alpha.version };
      });
      await renderInstalled();
      await act(async () => button("Update all")!.click());

      expect(api.inspectAddedPlugin).toHaveBeenCalledTimes(2);
      expect(api.addPlugin).toHaveBeenCalledExactlyOnceWith(alpha.source, alpha.digest);
      expect(updateButton("Alpha")).toBeNull();
      expect(updateButton("Beta")?.disabled).toBe(false);
      expect(document.querySelector(".ui-dialog")).toBeNull();
    });

    it("reports a card update failure cleanly and lets the person retry", async () => {
      api.inspectAddedPlugin.mockRejectedValueOnce(new Error("Registry timed out"));
      await renderInstalled();

      const alphaButton = () => host.querySelector<HTMLButtonElement>('.plugins-updates button[aria-label="Update Alpha"]')!;
      await act(async () => alphaButton().click());

      expect(host.querySelector('[role="alert"]')?.textContent).toContain("Alpha: Registry timed out");
      expect(alphaButton().disabled).toBe(false);
    });
  });
});
