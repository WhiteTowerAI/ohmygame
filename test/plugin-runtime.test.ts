import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginDetail } from "../src/shared/plugins.js";
import type { LocalPluginStore } from "../src/daemon/local-plugins.js";
import { pluginSkillFolders, resolvePluginSkillPaths, resolvePluginSkills } from "../src/daemon/plugin-runtime.js";
import { stageSkills } from "../src/daemon/agent-runtimes/skills.js";
import { PluginSettingsStore } from "../src/daemon/plugin-settings.js";
import { BUNDLED_PLUGINS_OFF, PluginServices } from "../src/daemon/plugin-services.js";

describe("plugin runtime", () => {
  async function bundled() {
    const services = new PluginServices({
      directory: path.join(await mkdtemp(path.join(tmpdir(), "ohmygame-runtime-")), "store"),
      bundled: path.resolve("plugins-v2"),
      bundledOff: BUNDLED_PLUGINS_OFF,
    });
    await services.ready();
    return services;
  }

  it("only exposes a plugin's skills after the user enables it", async () => {
    const services = await bundled();
    const before = await services.appWideSkills({ type: "general" });
    expect(before.some(skill => skill.pluginDisplayName === "Unity")).toBe(false);
    expect(before.some(skill => skill.pluginDisplayName === "Blender")).toBe(true);

    await services.setEnabled("ohmygame/unity", true);
    const unitySkills = (await services.appWideSkills({ type: "general" }))
      .filter(skill => skill.pluginDisplayName === "Unity")
      .map(skill => path.basename(path.dirname(skill.path)))
      .sort();
    expect(unitySkills).toEqual(["unity-game"]);
    expect((await services.appWideSkills({ type: "godot-game" })).some(skill => skill.pluginDisplayName === "Unity")).toBe(false);
    await services.setEnabled("ohmygame/unity", false);
    expect(await services.appWideSkills({ type: "general" })).toEqual(before);
    await services.close();
  });

  it("stages enabled plugin Skills for coding agent CLIs", async () => {
    const services = await bundled();
    await services.setEnabled("ohmygame/unity", true);
    const skills = await services.appWideSkills({ type: "general" });
    const target = await mkdtemp(path.join(tmpdir(), "ohmygame-staged-skills-"));
    const staged = await stageSkills(pluginSkillFolders(skills), target);
    expect(staged).toHaveLength(skills.length);
    expect(staged).toEqual(expect.arrayContaining(["unity-game", "game-studio", "blender-assets"]));
    await services.close();
  });

  it("keeps Game Studio isolated from Web Game skills and honors its switch", async () => {
    const services = await bundled();
    const webBefore = await services.appWideSkills({ type: "web-game" });
    const general = await services.appWideSkills({ type: "general" });
    expect(general.filter((skill) => skill.pluginDisplayName === "Game Studio")).toHaveLength(3);
    expect(general.some((skill) => skill.pluginDisplayName === "Web Game Studio")).toBe(false);
    expect(webBefore.filter((skill) => skill.pluginDisplayName === "Web Game Studio")).toHaveLength(9);
    expect(webBefore.some((skill) => skill.pluginDisplayName === "Game Studio")).toBe(false);

    await services.setEnabled("ohmygame/game-studio", false);
    expect(await services.appWideSkills({ type: "general" })).toEqual(general.filter((skill) => skill.pluginDisplayName !== "Game Studio"));
    expect(await services.appWideSkills({ type: "web-game" })).toEqual(webBefore);
    await services.close();
  });

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
      path: path.join("/managed/plugin/0.1.0", "skills/review/SKILL.md"),
      pluginDisplayName: "Test",
      marketplaceDisplayName: "Personal",
    }]);
  });

  it("loads project-scoped skills only for compatible project types", async () => {
    const plugin = { ...localPlugin(), projectTypes: ["web-game" as const] };
    const settings = await settingsStore();
    const local = {
      list: async () => ({ plugins: [plugin], errors: [] }),
      installedPath: async () => "/managed/plugin/0.1.0",
    } as unknown as LocalPluginStore;

    await expect(resolvePluginSkills([local], settings, "web-game")).resolves.toHaveLength(1);
    await expect(resolvePluginSkills([local], settings, "godot-game")).resolves.toEqual([]);
    await expect(resolvePluginSkills([local], settings, "interactive-story")).resolves.toEqual([]);
    await expect(resolvePluginSkills([local], settings)).resolves.toHaveLength(1);
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
