import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { godotPlugin } from "../src/daemon/plugin-catalog.js";
import { InvalidPluginSettingsError, PluginSettingsStore } from "../src/daemon/plugin-settings.js";

describe("plugin settings", () => {
  it("persists the plugin switch separately from component switches", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "open-game-plugin-settings-"));
    const plugin = godotPlugin();
    const store = new PluginSettingsStore(directory);
    await store.load();

    await store.update(plugin, { enabled: false, components: { "connection:opengame-godot": true } });

    const reloaded = new PluginSettingsStore(directory);
    await reloaded.load();
    expect(reloaded.decorate(plugin)).toMatchObject({
      enabled: false,
      connections: [{ id: "opengame-godot", enabled: true }],
    });
  });

  it("migrates legacy MCP settings at the persistence boundary", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "open-game-plugin-settings-"));
    await writeFile(path.join(directory, "plugin-settings.json"), JSON.stringify({
      version: 1,
      plugins: {
        "opengame:godot": {
          enabled: true,
          components: { "mcpServer:opengame-godot": false, "app:godot": true },
        },
      },
    }));
    const store = new PluginSettingsStore(directory);

    await store.load();

    expect(store.decorate(godotPlugin())).toMatchObject({
      enabled: true,
      connections: [{ id: "opengame-godot", enabled: false }],
    });
  });

  it("rejects component keys that do not belong to the plugin", async () => {
    const store = new PluginSettingsStore(await mkdtemp(path.join(tmpdir(), "open-game-plugin-settings-")));
    await store.load();
    await expect(store.update(godotPlugin(), {
      enabled: true,
      components: { "connection:unknown": false },
    })).rejects.toBeInstanceOf(InvalidPluginSettingsError);
  });

  it("keeps memory unchanged when persistence fails", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "open-game-plugin-settings-"));
    const blockedDirectory = path.join(directory, "not-a-directory");
    await writeFile(blockedDirectory, "blocked");
    const plugin = godotPlugin();
    const store = new PluginSettingsStore(blockedDirectory);

    await expect(store.update(plugin, {
      enabled: false,
      components: { "connection:opengame-godot": false },
    })).rejects.toThrow();
    expect(store.decorate(plugin)).toMatchObject({ enabled: true, connections: [{ enabled: true }] });
  });
});
