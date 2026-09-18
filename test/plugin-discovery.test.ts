import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverPlugins } from "../src/daemon/plugin-discovery.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("plugin discovery", () => {
  it.each([
    [".codex-plugin/plugin.json", "codex"],
    [".claude-plugin/plugin.json", "claude"],
  ] as const)("discovers a %s manifest", async (manifestPath, format) => {
    const root = await temporaryDirectory();
    await writeJson(path.join(root, manifestPath), {
      name: "level-design", version: "1.2.0", description: "Design game levels", skills: "./skills/",
      interface: { displayName: "Level Design", defaultPrompt: "Design a platformer level." },
    });
    await writeSkill(path.join(root, "skills", "level-design"), "level-design", "Design levels.");

    const [candidate] = await discoverPlugins(root);

    expect(candidate).toMatchObject({ format, name: "level-design", displayName: "Level Design", skillCount: 1 });
    expect(candidate!.manifest.skills).toBe("./skills/");
    expect(candidate!.manifest.interface?.defaultPrompt).toEqual(["Design a platformer level."]);
  });

  it("discovers Pi packages and conventional Agent Skills", async () => {
    const piRoot = await temporaryDirectory();
    await writeJson(path.join(piRoot, "package.json"), {
      name: "pi-level-tools", version: "2.0.0", description: "Pi level tools",
      pi: { skills: ["./skills/*", "!./skills/internal"] },
    });
    await writeSkill(path.join(piRoot, "skills", "levels"), "levels", "Design levels.");
    await writeSkill(path.join(piRoot, "skills", "internal"), "internal", "Internal tools.");
    const skillRoot = await temporaryDirectory();
    await writeSkill(skillRoot, "game-balance", "Balance a game economy.");

    expect((await discoverPlugins(piRoot))[0]).toMatchObject({
      format: "pi", name: "pi-level-tools", skillCount: 1, manifest: { skills: "./skills/levels" },
    });
    expect((await discoverPlugins(skillRoot))[0]).toMatchObject({
      format: "agent-skills", name: "game-balance", description: "Balance a game economy.", skillCount: 1,
    });
  });

  it("discovers local Codex marketplace entries and counts their Skill files", async () => {
    const root = await temporaryDirectory();
    await writeJson(path.join(root, ".agents", "plugins", "marketplace.json"), {
      name: "game-tools",
      plugins: [{ name: "level-tools", source: { source: "local", path: "./plugins/level-tools" } }],
    });
    await writeJson(path.join(root, "plugins", "level-tools", ".codex-plugin", "plugin.json"), {
      name: "level-tools", description: "Level tools", skills: "./skills/",
    });
    await writeSkill(path.join(root, "plugins", "level-tools", "skills", "layout"), "layout", "Lay out levels.");
    await writeSkill(path.join(root, "plugins", "level-tools", "skills", "balance"), "balance", "Balance levels.");

    const [candidate] = await discoverPlugins(root);

    expect(candidate).toMatchObject({
      format: "codex",
      name: "level-tools",
      skillCount: 2,
      marketplace: { id: "game-tools", displayName: "Game Tools" },
    });
    expect(candidate!.manifest.skills).toBe("./plugins/level-tools/skills");
  });

  it("rejects nested remote marketplace sources explicitly", async () => {
    const root = await temporaryDirectory();
    await writeJson(path.join(root, ".agents", "plugins", "marketplace.json"), {
      name: "remote-tools",
      plugins: [{
        name: "level-tools",
        source: { source: "git-subdir", url: "https://github.com/example/tools.git", path: "./plugins/level-tools" },
      }],
    });

    await expect(discoverPlugins(root)).rejects.toThrow("Marketplace source type is not supported yet: git-subdir");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-discovery-"));
  directories.push(directory);
  return directory;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value));
}

async function writeSkill(directory: string, name: string, description: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
}
