import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BuiltInPluginAdapter, LocalPluginAdapter, PluginCatalogService, godotPlugin } from "../src/daemon/plugin-catalog.js";
import { PluginSettingsStore } from "../src/daemon/plugin-settings.js";
import type { PluginDetail } from "../src/shared/plugins.js";

describe("plugin catalog", () => {
  it("combines built-in and personal plugins behind one catalog", async () => {
    const personal = localPlugin();
    const settings = new PluginSettingsStore(await mkdtemp(path.join(tmpdir(), "open-game-plugin-catalog-")));
    await settings.load();
    const catalog = new PluginCatalogService([
      new BuiltInPluginAdapter(async () => true),
      new LocalPluginAdapter({ list: async () => ({ plugins: [personal], errors: [] }), read: async (id) => id === personal.id ? personal : undefined }),
    ], settings);

    const result = await catalog.list();

    expect(result.plugins.map((plugin) => plugin.id)).toEqual([
      "opengame:godot",
      "opengame:plugin-starter",
      "local:character-workflow",
    ]);
    expect(result.errors).toEqual([]);
    await expect(catalog.read("opengame:godot")).resolves.toEqual(godotPlugin(true));
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
});

function localPlugin(): PluginDetail {
  return {
    id: "local:character-workflow",
    name: "character-workflow",
    displayName: "Character Workflow",
    description: "Create consistent characters",
    version: "0.1.0",
    marketplace: { id: "personal", displayName: "Personal" },
    source: { type: "local" },
    installed: true,
    enabled: true,
    skills: [{ id: "skills/character/SKILL.md", name: "Character", enabled: true }],
    connections: [],
  };
}
