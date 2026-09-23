import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalPluginStore } from "../src/daemon/local-plugins.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("local plugins", () => {
  it("installs a validated copy, updates it from the same source, and removes it", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = path.join(root, "data");
    const source = path.join(root, "character-writer");
    await writePlugin(source, {
      name: "character-writer",
      version: "1.0.0",
      description: "Write game characters",
      skills: "./skills/",
      interface: {
        defaultPrompt: ["Create a game character."],
        projectTypes: ["web-game"],
      },
    });
    const store = new LocalPluginStore(dataDirectory);

    const installed = await store.install(source);

    expect(installed).toMatchObject({
      id: "personal:character-writer",
      displayName: "Character Writer",
      version: "1.0.0",
      marketplace: { id: "personal", displayName: "Personal" },
      source: { type: "directory" },
      installed: true,
      enabled: true,
      skills: [{ id: "skills/writer/SKILL.md", name: "Writer" }],
      defaultPrompts: ["Create a game character."],
      projectTypes: ["web-game"],
    });
    await writePluginManifest(source, {
      name: "character-writer",
      version: "1.1.0",
      description: "Updated character workflows",
      skills: "./skills/",
    });
    expect(await store.read(installed.id)).toMatchObject({ version: "1.0.0" });
    expect(await store.install(source)).toMatchObject({ version: "1.1.0", description: "Updated character workflows" });
    await expect(store.directoryPath(installed.id)).resolves.toBe(source);

    await rm(source, { recursive: true });
    await expect(store.directoryPath(installed.id)).resolves.toContain(path.join("plugins", "installed", "personal", "character-writer", "1.1.0"));

    await store.remove(installed.id);
    expect(await store.list()).toEqual({ plugins: [], errors: [] });
    await expect(store.read(installed.id)).resolves.toBeUndefined();
    await expect(store.directoryPath(installed.id)).resolves.toBeUndefined();
  });

  it("uses root Skill frontmatter instead of the installed version directory", async () => {
    const root = await temporaryDirectory();
    const source = path.join(root, "image-to-threejs");
    await writePluginManifest(source, {
      name: "image-to-threejs",
      version: "1.5.1",
      description: "Create Three.js scenes from images",
      skills: "./SKILL.md",
    });
    await writeFile(path.join(source, "SKILL.md"), [
      "---",
      "name: img2threejs",
      "description: Turn an image into a Three.js scene.",
      "---",
      "",
      "# Image to Three.js",
      "",
    ].join("\n"), "utf8");

    const installed = await new LocalPluginStore(path.join(root, "data")).install(source);

    expect(installed.skills).toEqual([{
      id: "SKILL.md",
      name: "Img2threejs",
      description: "Turn an image into a Three.js scene.",
      enabled: true,
    }]);
  });

  it("rejects missing resources and paths outside the bundle", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = path.join(root, "data");
    const source = path.join(root, "broken-plugin");
    await writePluginManifest(source, {
      name: "broken-plugin",
      version: "1.0.0",
      description: "Broken plugin",
      skills: "./missing/",
    });
    const store = new LocalPluginStore(dataDirectory);

    await expect(store.install(source)).rejects.toThrow("Plugin resource not found: ./missing/");
    await writeFile(path.join(source, ".ohmygame-plugin", "plugin.json"), JSON.stringify({
      name: "broken-plugin",
      version: "1.0.0",
      description: "Broken plugin",
      skills: "./../skills/",
    }));
    await expect(store.install(source)).rejects.toThrow("Plugin manifest is invalid");
  });

  it("rejects versions that are not safe SemVer values", async () => {
    const root = await temporaryDirectory();
    const source = path.join(root, "invalid-version");
    await writePluginManifest(source, {
      name: "invalid-version",
      version: "1/2",
      description: "Invalid version",
    });

    await expect(new LocalPluginStore(path.join(root, "data")).install(source)).rejects.toThrow("Plugin manifest is invalid");
  });

  it("identifies plugins by canonical name rather than display name", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = path.join(root, "data");
    const first = path.join(root, "first-plugin");
    const second = path.join(root, "second-plugin");
    const reserved = path.join(root, "reserved-plugin");
    await writePluginManifest(first, {
      name: "first-plugin", version: "1.0.0", description: "First", interface: { displayName: "Shared Name" },
    });
    await writePluginManifest(second, {
      name: "second-plugin", version: "1.0.0", description: "Second", interface: { displayName: "shared name" },
    });
    await writePluginManifest(reserved, {
      name: "reserved-plugin", version: "1.0.0", description: "Reserved", interface: { displayName: "Godot" },
    });
    const store = new LocalPluginStore(dataDirectory, {
      connections: async () => [],
    });

    await store.install(first);
    await expect(store.install(second)).resolves.toMatchObject({ id: "personal:second-plugin" });
    await expect(store.install(reserved)).resolves.toMatchObject({ id: "personal:reserved-plugin" });
  });

  it("keeps healthy plugins when one installed copy is damaged", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = path.join(root, "data");
    const first = path.join(root, "first-plugin");
    const second = path.join(root, "second-plugin");
    await writePluginManifest(first, { name: "first-plugin", version: "1.0.0", description: "First" });
    await writePluginManifest(second, { name: "second-plugin", version: "1.0.0", description: "Second" });
    const store = new LocalPluginStore(dataDirectory);
    await Promise.all([store.install(first), store.install(second)]);
    await rm(path.join(dataDirectory, "plugins", "installed", "personal", "first-plugin", "1.0.0"), { recursive: true });

    const result = await store.list();

    expect(result.plugins.map((plugin) => plugin.id)).toEqual(["personal:second-plugin"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("first-plugin");
  });

  it("keeps same-named plugins distinct by marketplace and restores their source", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = path.join(root, "data");
    const first = path.join(root, "first-marketplace-plugin");
    const second = path.join(root, "second-marketplace-plugin");
    const conflicting = path.join(root, "conflicting-marketplace-plugin");
    await writePluginManifest(first, { name: "game-tools", version: "1.0.0", description: "First tools" });
    await writePluginManifest(second, { name: "game-tools", version: "1.0.0", description: "Second tools" });
    await writePluginManifest(conflicting, { name: "other-tools", version: "1.0.0", description: "Other tools" });
    const store = new LocalPluginStore(dataDirectory);

    const firstPlugin = await store.install(first, { type: "directory", path: first }, undefined, {
      id: "first-marketplace", displayName: "First Marketplace",
    });
    const secondPlugin = await store.install(second, { type: "directory", path: second }, undefined, {
      id: "second-marketplace", displayName: "Second Marketplace",
    });

    expect(firstPlugin.id).toBe("marketplace:first-marketplace:game-tools");
    expect(secondPlugin.id).toBe("marketplace:second-marketplace:game-tools");
    await expect(new LocalPluginStore(dataDirectory).list()).resolves.toMatchObject({
      plugins: [
        { id: firstPlugin.id, marketplace: { id: "first-marketplace", displayName: "First Marketplace" } },
        { id: secondPlugin.id, marketplace: { id: "second-marketplace", displayName: "Second Marketplace" } },
      ],
      errors: [],
    });
    await expect(store.install(conflicting, { type: "directory", path: conflicting }, undefined, {
      id: "first-marketplace", displayName: "First Marketplace",
    })).rejects.toThrow("Marketplace first-marketplace is already installed from another source");
  });

  it("rejects deeply nested bundles", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = path.join(root, "data");
    const store = new LocalPluginStore(dataDirectory);
    const nested = path.join(root, "deep-plugin");
    await writePluginManifest(nested, { name: "deep-plugin", version: "1.0.0", description: "Too deep" });
    let directory = nested;
    for (let index = 0; index < 66; index += 1) {
      directory = path.join(directory, "nested");
      await mkdir(directory);
    }
    await expect(store.install(nested)).rejects.toThrow("nested too deeply");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-local-plugin-"));
  directories.push(directory);
  return directory;
}

async function writePlugin(source: string, manifest: Record<string, unknown>): Promise<void> {
  await writePluginManifest(source, manifest);
  await mkdir(path.join(source, "skills", "writer"), { recursive: true });
  await writeFile(path.join(source, "skills", "writer", "SKILL.md"), "# Writer\n", "utf8");
}

async function writePluginManifest(source: string, manifest: Record<string, unknown>): Promise<void> {
  await mkdir(path.join(source, ".ohmygame-plugin"), { recursive: true });
  await writeFile(path.join(source, ".ohmygame-plugin", "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
