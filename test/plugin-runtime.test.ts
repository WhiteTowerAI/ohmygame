import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginDetail } from "../src/shared/plugins.js";
import type { LocalPluginStore } from "../src/daemon/local-plugins.js";
import { resolvePluginSkillPaths, resolvePluginSkills } from "../src/daemon/plugin-runtime.js";
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

    const skillPaths = await resolvePluginSkillPaths([local], settings);

    expect(skillPaths).toEqual([]);
  });

  it("preserves Plugin provenance for enabled skills", async () => {
    const plugin = localPlugin();
    const settings = await settingsStore();
    const local = {
      list: async () => ({ plugins: [plugin], errors: [] }),
      installedPath: async () => "/managed/plugin/0.1.0",
    } as unknown as LocalPluginStore;

    await expect(resolvePluginSkills([local], settings)).resolves.toEqual([{
      path: "/managed/plugin/0.1.0/skills/review/SKILL.md",
      pluginDisplayName: "Test",
      marketplaceDisplayName: "Personal",
    }]);
  });
});

async function settingsStore(): Promise<PluginSettingsStore> {
  const store = new PluginSettingsStore(await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-runtime-")));
  await store.load();
  return store;
}

function localPlugin(): PluginDetail {
  return {
    id: "personal:test", name: "test", displayName: "Test", description: "Test plugin", version: "0.1.0",
    marketplace: { id: "personal", displayName: "Personal" }, source: { type: "directory" }, installed: true, enabled: true,
    skills: [{ id: "skills/review/SKILL.md", name: "Review", enabled: true }],
    connections: [{ id: "ohmygame-godot", name: "Godot", enabled: true }],
  };
}
