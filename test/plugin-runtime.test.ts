import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pluginSkillFolders } from "../src/daemon/plugin-runtime.js";
import { stageSkills } from "../src/daemon/agent-runtimes/skills.js";
import { BUNDLED_PLUGINS_OFF, PluginServices } from "../src/daemon/plugin-services.js";

describe("plugin runtime", () => {
  async function bundled() {
    const services = new PluginServices({
      directory: path.join(await mkdtemp(path.join(tmpdir(), "ohmygame-runtime-")), "store"),
      bundled: path.resolve("plugins"),
      bundledOff: BUNDLED_PLUGINS_OFF,
    });
    await services.ready();
    return services;
  }

  it("only exposes a beta plugin's skills once the person turns it on in every project", async () => {
    const services = await bundled();
    const before = await services.everyProjectSkills({ type: "general" });
    expect(before.some(skill => skill.pluginDisplayName === "Unity")).toBe(false);
    expect(before.some(skill => skill.pluginDisplayName === "Blender")).toBe(true);

    await services.setEveryProject("ohmygame/unity", true);
    const unitySkills = (await services.everyProjectSkills({ type: "general" }))
      .filter(skill => skill.pluginDisplayName === "Unity")
      .map(skill => path.basename(path.dirname(skill.path)))
      .sort();
    expect(unitySkills).toEqual(["unity-game"]);
    expect((await services.everyProjectSkills({ type: "godot-game" })).some(skill => skill.pluginDisplayName === "Unity")).toBe(false);
    await services.setEveryProject("ohmygame/unity", false);
    expect(await services.everyProjectSkills({ type: "general" })).toEqual(before);
    await services.close();
  });

  it("stages plugin Skills on in every project for coding agent CLIs", async () => {
    const services = await bundled();
    await services.setEveryProject("ohmygame/unity", true);
    const skills = await services.everyProjectSkills({ type: "general" });
    const target = await mkdtemp(path.join(tmpdir(), "ohmygame-staged-skills-"));
    const staged = await stageSkills(pluginSkillFolders(skills), target);
    expect(staged).toHaveLength(skills.length);
    expect(staged).toEqual(expect.arrayContaining(["unity-game", "game-studio", "blender-assets"]));
    await services.close();
  });

  it("keeps Game Studio isolated from Web Game skills and honors its switch", async () => {
    const services = await bundled();
    const webBefore = await services.everyProjectSkills({ type: "web-game" });
    const general = await services.everyProjectSkills({ type: "general" });
    expect(general.filter((skill) => skill.pluginDisplayName === "Game Studio")).toHaveLength(3);
    expect(general.some((skill) => skill.pluginDisplayName === "Web Game Studio")).toBe(false);
    expect(webBefore.filter((skill) => skill.pluginDisplayName === "Web Game Studio")).toHaveLength(10);
    expect(webBefore.some((skill) => skill.pluginDisplayName === "Game Studio")).toBe(false);

    await services.setEveryProject("ohmygame/game-studio", false);
    expect(await services.everyProjectSkills({ type: "general" })).toEqual(general.filter((skill) => skill.pluginDisplayName !== "Game Studio"));
    expect(await services.everyProjectSkills({ type: "web-game" })).toEqual(webBefore);
    await services.close();
  });
});
