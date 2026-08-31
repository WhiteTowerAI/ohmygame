import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginDetail } from "../src/shared/plugins.js";
import type { LocalPluginStore } from "../src/daemon/local-plugins.js";
import { enabledConnectionIds, resolvePluginSkillPaths } from "../src/daemon/plugin-runtime.js";
import { PluginSettingsStore } from "../src/daemon/plugin-settings.js";

describe("plugin runtime", () => {
  it("loads only enabled plugin skills", async () => {
    const plugin = localPlugin();
    const settings = await settingsStore();
    await settings.update(plugin, { enabled: true, components: { "skill:skills/review/SKILL.md": false } });
    const local = {
      list: async () => ({ plugins: [plugin], errors: [] }),
      installedPath: async () => "/managed/plugin/0.1.0",
    } as unknown as LocalPluginStore;

    const skillPaths = await resolvePluginSkillPaths(local, settings);

    expect(skillPaths).toEqual([]);
  });

  it("deduplicates connections required by multiple enabled plugins", async () => {
    const settings = await settingsStore();
    const first = localPlugin();
    const second = { ...localPlugin(), id: "local:second", name: "second" };

    expect([...enabledConnectionIds([first, second], settings)]).toEqual(["opengame-godot"]);
    await settings.update(first, { enabled: false, components: { "skill:skills/review/SKILL.md": true, "connection:opengame-godot": true } });
    expect([...enabledConnectionIds([first, second], settings)]).toEqual(["opengame-godot"]);
  });
});

async function settingsStore(): Promise<PluginSettingsStore> {
  const store = new PluginSettingsStore(await mkdtemp(path.join(tmpdir(), "open-game-plugin-runtime-")));
  await store.load();
  return store;
}

function localPlugin(): PluginDetail {
  return {
    id: "local:test", name: "test", displayName: "Test", description: "Test plugin", version: "0.1.0",
    marketplace: { id: "personal", displayName: "Personal" }, source: { type: "local" }, installed: true, enabled: true,
    skills: [{ id: "skills/review/SKILL.md", name: "Review", enabled: true }],
    connections: [{ id: "opengame-godot", name: "Godot", enabled: true }],
  };
}
