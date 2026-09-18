import { cp, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalPluginStore } from "../src/daemon/local-plugins.js";
import { installPlugin, validatedGitUrl, type GitRunner } from "../src/daemon/plugin-installer.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("plugin installer", () => {
  it("installs a Git snapshot with its resolved source and enables it by default", async () => {
    const root = await temporaryDirectory();
    const repository = path.join(root, "repository");
    await writePlugin(repository);
    const store = new LocalPluginStore(path.join(root, "data"));
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const git: GitRunner = async (args) => {
      if (args[0] === "clone") {
        const destination = args.at(-1)!;
        await cp(repository, destination, { recursive: true });
        await mkdir(path.join(destination, ".git"));
        return "";
      }
      return `${commit}\n`;
    };

    const installed = await installPlugin(store, { type: "git", url: "https://example.com/tools/test-plugin.git" }, git);

    expect(installed).toMatchObject({
      id: "personal:test-plugin",
      source: { type: "git", url: "https://example.com/tools/test-plugin.git", commit },
      enabled: true,
      skills: [{ enabled: true }],
    });
    const installedPath = await store.installedPath(installed.id);
    await expect(lstat(path.join(installedPath!, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts only credential-free HTTPS Git URLs", () => {
    expect(validatedGitUrl("https://example.com/plugin.git")).toBe("https://example.com/plugin.git");
    expect(validatedGitUrl("https://github.com/example/plugin")).toBe("https://github.com/example/plugin.git");
    expect(validatedGitUrl("https://github.com/example/plugin/blob/main/.claude-plugin/marketplace.json"))
      .toBe("https://github.com/example/plugin.git");
    expect(validatedGitUrl("https://github.com/example/plugin/tree/main/plugins"))
      .toBe("https://github.com/example/plugin.git");
    expect(() => validatedGitUrl("http://example.com/plugin.git")).toThrow("must use HTTPS");
    expect(() => validatedGitUrl("https://user:token@example.com/plugin.git")).toThrow("must not contain credentials");
    expect(() => validatedGitUrl("not a URL")).toThrow("valid Git URL");
  });

  it("rejects relative directory sources", async () => {
    const store = new LocalPluginStore(await temporaryDirectory());
    await expect(installPlugin(store, { type: "directory", path: "./plugin" }))
      .rejects.toThrow("Plugin directory must be an absolute path");
  });

  it("requires a selection for a marketplace with multiple plugins", async () => {
    const root = await temporaryDirectory();
    const repository = path.join(root, "repository");
    await mkdir(path.join(repository, ".claude-plugin"), { recursive: true });
    await writeFile(path.join(repository, ".claude-plugin", "marketplace.json"), JSON.stringify({
      name: "game-skills", plugins: [
        { name: "godot", source: "./", skills: ["./skills/godot/SKILL.md"] },
        { name: "unity", source: "./", skills: ["./skills/unity/SKILL.md"] },
      ],
    }));
    await mkdir(path.join(repository, "skills", "godot"), { recursive: true });
    await mkdir(path.join(repository, "skills", "unity"), { recursive: true });
    await writeFile(path.join(repository, "skills", "godot", "SKILL.md"), "---\nname: godot\ndescription: Build Godot games.\n---\n");
    await writeFile(path.join(repository, "skills", "unity", "SKILL.md"), "---\nname: unity\ndescription: Build Unity games.\n---\n");
    const store = new LocalPluginStore(path.join(root, "data"));
    const git: GitRunner = async (args) => {
      if (args[0] === "clone") {
        const destination = args.at(-1)!;
        await cp(repository, destination, { recursive: true });
        await mkdir(path.join(destination, ".git"));
        return "";
      }
      return "0123456789abcdef0123456789abcdef01234567\n";
    };

    await expect(installPlugin(store, { type: "git", url: "https://example.com/marketplace.git" }, git))
      .rejects.toThrow("Choose a Plugin from this marketplace");
    const installed = await installPlugin(store, {
      type: "git", url: "https://example.com/marketplace.git", candidate: "marketplace:game-skills:godot",
    }, git);
    expect(installed).toMatchObject({
      id: "marketplace:game-skills:godot",
      marketplace: { id: "game-skills", displayName: "Game Skills" },
      enabled: true,
      skills: [{ name: "Godot" }],
    });
    expect(installed.version).toBeUndefined();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-installer-"));
  directories.push(directory);
  return directory;
}

async function writePlugin(root: string): Promise<void> {
  await mkdir(path.join(root, ".ohmygame-plugin"), { recursive: true });
  await mkdir(path.join(root, "skills", "test"), { recursive: true });
  await writeFile(path.join(root, ".ohmygame-plugin", "plugin.json"), JSON.stringify({
    name: "test-plugin",
    version: "1.0.0",
    description: "Test plugin",
    skills: "./skills/",
  }));
  await writeFile(path.join(root, "skills", "test", "SKILL.md"), "# Test\n");
}
