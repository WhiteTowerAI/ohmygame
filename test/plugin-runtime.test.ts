import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginDetail } from "../src/shared/plugins.js";
import type { LocalPluginStore } from "../src/daemon/local-plugins.js";
import { pluginSkillFolders, resolvePluginSkillPaths, resolvePluginSkills } from "../src/daemon/plugin-runtime.js";
import { stageSkills } from "../src/daemon/agent-runtimes/skills.js";
import { PluginSettingsStore } from "../src/daemon/plugin-settings.js";
import { BundledPluginStore } from "../src/daemon/bundled-plugins.js";

describe("plugin runtime", () => {
  it("only exposes Maker skills after the user enables the plugin", async () => {
    const store = new BundledPluginStore(path.resolve("plugins"));
    await store.load();
    const settings = await settingsStore();
    const before = await resolvePluginSkills([store], settings, "general");
    expect(before.some(skill => skill.pluginDisplayName === "TapTap Maker")).toBe(false);
    expect(before.some(skill => skill.pluginDisplayName === "Blender")).toBe(true);

    const maker = store.read("ohmygame:taptap-maker")!;
    await settings.update(maker, { enabled: true, components: {} });
    const makerSkills = (await resolvePluginSkills([store], settings, "general"))
      .filter(skill => skill.pluginDisplayName === "TapTap Maker")
      .map(skill => path.basename(path.dirname(skill.path)))
      .sort();
    expect(makerSkills).toEqual(["taptap-maker", "taptap-release"]);
    expect((await resolvePluginSkills([store], settings, "godot-game")).some(skill => skill.pluginDisplayName === "TapTap Maker")).toBe(false);
    await settings.update(maker, { enabled: false, components: {} });
    expect(await resolvePluginSkills([store], settings, "general")).toEqual(before);
  });

  it("stages enabled plugin Skills for coding agent CLIs", async () => {
    const store = new BundledPluginStore(path.resolve("plugins"));
    await store.load();
    const settings = await settingsStore();
    await settings.update(store.read("ohmygame:taptap-maker")!, { enabled: true, components: {} });
    const skills = await resolvePluginSkills([store], settings, "general");
    const target = await mkdtemp(path.join(tmpdir(), "ohmygame-staged-skills-"));
    const staged = await stageSkills(pluginSkillFolders(skills), target);
    expect(staged).toHaveLength(skills.length);
    expect(staged).toEqual(expect.arrayContaining(["taptap-maker", "taptap-release", "game-studio", "blender-assets"]));
  });

  it("keeps Game Studio isolated from Web Game skills and honors its disabled setting", async () => {
    const store = new BundledPluginStore(path.resolve("plugins"));
    await store.load();
    const settings = await settingsStore();
    const webBefore = await resolvePluginSkills([store], settings, "web-game");
    const general = await resolvePluginSkills([store], settings, "general");
    expect(general.filter((skill) => skill.pluginDisplayName === "Game Studio")).toHaveLength(3);
    expect(general.some((skill) => skill.pluginDisplayName === "Web Game Studio")).toBe(false);
    expect(webBefore.filter((skill) => skill.pluginDisplayName === "Web Game Studio")).toHaveLength(9);
    expect(webBefore.some((skill) => skill.pluginDisplayName === "Game Studio")).toBe(false);

    const plugin = store.read("ohmygame:game-studio")!;
    await settings.update(plugin, { ...settings.resolve(plugin), enabled: false });
    expect(await resolvePluginSkills([store], settings, "general")).toEqual(general.filter((skill) => skill.pluginDisplayName !== "Game Studio"));
    expect(await resolvePluginSkills([store], settings, "web-game")).toEqual(webBefore);
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
