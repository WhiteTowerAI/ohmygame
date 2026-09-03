import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalPluginAdapter, PluginCatalogService, type PluginCatalogAdapter } from "../src/daemon/plugin-catalog.js";
import { PluginSettingsStore } from "../src/daemon/plugin-settings.js";
import type { PluginDetail } from "../src/shared/plugins.js";

describe("plugin catalog", () => {
  it("exposes personal plugins behind the catalog", async () => {
    const personal = localPlugin();
    const settings = new PluginSettingsStore(await mkdtemp(path.join(tmpdir(), "open-game-plugin-catalog-")));
    await settings.load();
    const catalog = new PluginCatalogService([
      new LocalPluginAdapter({ list: async () => ({ plugins: [personal], errors: [] }), read: async (id) => id === personal.id ? personal : undefined }),
    ], settings);

    const result = await catalog.list();

    expect(result.plugins.map((plugin) => plugin.id)).toEqual([
      "personal:character-workflow",
    ]);
    expect(result.errors).toEqual([]);
  });

  it("validates mentions against installed enabled plugins", async () => {
    const plugin = localPlugin();
    const settings = new PluginSettingsStore(await mkdtemp(path.join(tmpdir(), "open-game-plugin-catalog-")));
    await settings.load();
    const catalog = new PluginCatalogService([
      new LocalPluginAdapter({ list: async () => ({ plugins: [plugin], errors: [] }), read: async () => plugin }),
    ], settings);

    await expect(catalog.validateMentions([{ name: plugin.name, displayName: plugin.displayName, marketplaceId: "personal" }]))
      .resolves.toEqual([{ name: plugin.name, displayName: plugin.displayName, marketplaceId: "personal" }]);
    await expect(catalog.validateMentions([{ name: "missing", displayName: "Missing", marketplaceId: "personal" }]))
      .rejects.toThrow("not installed");
  });

  it("keeps healthy catalog entries when an adapter reports a damaged plugin", async () => {
    const plugin = localPlugin();
    const settings = new PluginSettingsStore(await mkdtemp(path.join(tmpdir(), "open-game-plugin-catalog-")));
    await settings.load();
    const catalog = new PluginCatalogService([
      new LocalPluginAdapter({
        list: async () => ({ plugins: [plugin], errors: ["Could not load local plugin damaged"] }),
        read: async () => plugin,
      }),
    ], settings);

    await expect(catalog.list()).resolves.toMatchObject({
      plugins: [{ id: plugin.id }],
      errors: [{ marketplaceId: "personal", message: "Could not load local plugin damaged" }],
    });
  });

  it("preserves a catalog read failure when no adapter finds the Plugin", async () => {
    const settings = new PluginSettingsStore(await mkdtemp(path.join(tmpdir(), "open-game-plugin-catalog-")));
    await settings.load();
    const failure = new Error("Catalog unavailable");
    const catalog = new PluginCatalogService([
      adapter({ read: async () => { throw failure; } }),
    ], settings);

    await expect(catalog.read("opengame:missing")).rejects.toBe(failure);
  });

  it("keeps an installed Plugin available when another adapter fails", async () => {
    const plugin = localPlugin();
    const settings = new PluginSettingsStore(await mkdtemp(path.join(tmpdir(), "open-game-plugin-catalog-")));
    await settings.load();
    const catalog = new PluginCatalogService([
      adapter({ read: async () => plugin }),
      adapter({ read: async () => { throw new Error("Catalog unavailable"); } }),
    ], settings);

    await expect(catalog.read(plugin.id)).resolves.toMatchObject({ id: plugin.id, installed: true });
  });

  it("does not apply Catalog update metadata to a bundled Plugin", async () => {
    const bundled: PluginDetail = {
      ...localPlugin(),
      id: "opengame:godot",
      name: "godot",
      marketplace: { id: "opengame", displayName: "OpenGame" },
      source: { type: "builtIn" },
    };
    const remote = {
      ...bundled,
      version: "9.0.0",
      source: { type: "catalog" as const, pluginId: "remote-godot", releaseId: "release-1" },
      installed: false,
      enabled: false,
      skills: [],
      connections: [],
    };
    const settings = new PluginSettingsStore(await mkdtemp(path.join(tmpdir(), "open-game-plugin-catalog-")));
    await settings.load();
    const catalog = new PluginCatalogService([
      adapter({ plugins: [bundled] }),
      adapter({ plugins: [remote] }),
    ], settings);

    const plugin = (await catalog.list()).plugins[0]!;
    expect(plugin.source).toEqual({ type: "builtIn" });
    expect(plugin.latestVersion).toBeUndefined();
    expect(plugin.updateAvailable).toBeUndefined();
  });
});

function adapter(overrides: {
  plugins?: PluginDetail[];
  read?: PluginCatalogAdapter["read"];
}): PluginCatalogAdapter {
  return {
    marketplace: { id: "test", displayName: "Test" },
    list: async () => ({ plugins: overrides.plugins ?? [] }),
    read: overrides.read ?? (async () => undefined),
  };
}

function localPlugin(): PluginDetail {
  return {
    id: "personal:character-workflow",
    name: "character-workflow",
    displayName: "Character Workflow",
    description: "Create consistent characters",
    version: "0.1.0",
    marketplace: { id: "personal", displayName: "Personal" },
    source: { type: "directory" },
    installed: true,
    enabled: true,
    skills: [{ id: "skills/character/SKILL.md", name: "Character", enabled: true }],
    connections: [],
  };
}
