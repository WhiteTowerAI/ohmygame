import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { BUNDLED_PLUGINS_OFF, BundledPluginStore } from "../src/daemon/bundled-plugins.js";

describe("bundled plugins", () => {
  it("loads beta plugins with their native skills and connections", async () => {
    const store = new BundledPluginStore(path.resolve("plugins"), { formatTwoDirectory: path.resolve("plugins-v2"), off: BUNDLED_PLUGINS_OFF });
    await store.load();
    expect(store.list().filter(plugin => plugin.beta).map(plugin => plugin.name)).toEqual([
      "aseprite", "blender", "cocos-creator", "douyin-minigame",
      "tiled", "unity", "unreal-engine", "wechat-minigame",
    ]);
    for (const plugin of store.list().filter(plugin => plugin.beta)) {
      expect(plugin.icon?.type, plugin.name).toBe("asset");
      const image = await store.readIcon(plugin.id);
      expect(image, plugin.name).toBeDefined();
      expect(image!.bytes.length).toBeGreaterThan(0);
      expect(["image/png", "image/svg+xml"]).toContain(image!.mediaType);
    }
    expect(store.read("ohmygame:blender")).toMatchObject({
      enabled: true,
      skills: [{ id: "skills/blender-assets/SKILL.md" }],
      mcpServers: [],
    });
    // Godot is a format 2 plugin with its own tools, turned on per project.
    expect(store.read("ohmygame:godot")).toBeUndefined();
    for (const [name, skill] of [
      ["aseprite", "aseprite-assets"],
      ["cocos-creator", "cocos-creator"],
      ["douyin-minigame", "douyin-minigame"],
      ["tiled", "tiled-maps"],
      ["unity", "unity-game"],
      ["unreal-engine", "unreal-game"],
      ["wechat-minigame", "wechat-minigame"],
    ]) {
      const plugin = store.read(`ohmygame:${name}`)!;
      expect(plugin).toMatchObject({
        enabled: false,
        beta: true,
        skills: [{ id: `skills/${skill}/SKILL.md` }],
        projectTypes: name === "aseprite" || name === "tiled"
          ? ["general", "web-game", "godot-game", "asset-canvas"]
          : ["general"],
      });
      expect(plugin.mcpServers?.map(server => server.id)).toEqual(name === "unreal-engine" ? ["unreal"] : []);
    }
  });

  it("shows a bundled format 2 plugin that only adds Skills, and leaves out one that asks for more", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ohmygame-bundled-format-2-"));
    const write = async (name: string, manifest: object) => {
      const plugin = path.join(root, name);
      await mkdir(path.join(plugin, ".ohmygame-plugin"), { recursive: true });
      await mkdir(path.join(plugin, "skills", name), { recursive: true });
      await mkdir(path.join(plugin, "locales"), { recursive: true });
      await writeFile(path.join(plugin, ".ohmygame-plugin", "plugin.json"), JSON.stringify({
        id: `ohmygame/${name}`, version: "1.0.0", engines: { "ohmygame-api": "^2.0.0" },
        displayName: "%name%", description: "%description%", contributes: { skills: "./skills/" }, ...manifest,
      }));
      await writeFile(path.join(plugin, "locales", "en.json"), JSON.stringify({ name: `${name} title`, description: "Does things", example: "Try this" }));
      await writeFile(path.join(plugin, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: A skill\n---\n`);
      return plugin;
    };
    const tiles = await write("tiles", { beta: true, examples: ["%example%"], appliesTo: ["general", "ohmygame/godot:godot-game"] });
    await write("runner", { capabilities: { processes: ["node"] } });
    // Only plugin types: the catalog can't say so, so it isn't shown.
    await write("maker-help", { appliesTo: ["ohmygame/taptap-maker:maker"] });
    await write("broken", { engines: { "ohmygame-api": "^9.0.0" }, displayName: "%missing%" });
    const errors: unknown[] = [];
    const store = new BundledPluginStore(path.join(root, "none"), { formatTwoDirectory: root, off: ["ohmygame/tiles"], onError: (error) => errors.push(error) });

    await store.load();

    expect(store.list()).toMatchObject([{
      id: "ohmygame:tiles",
      name: "tiles",
      displayName: "tiles title",
      description: "Does things",
      beta: true,
      enabled: false,
      defaultPrompts: ["Try this"],
      projectTypes: ["general"],
      source: { type: "builtIn" },
      skills: [{ id: "skills/tiles/SKILL.md" }],
    }]);
    expect(store.installedPath("ohmygame:tiles")).toBe(tiles);
    expect(errors).toHaveLength(1);
  });

  it("loads a standard skill-only OhMyGame plugin directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ohmygame-bundled-plugins-"));
    const plugin = path.join(root, "reference-modeler");
    await mkdir(path.join(plugin, ".ohmygame-plugin"), { recursive: true });
    await mkdir(path.join(plugin, "skills", "reference-modeler"), { recursive: true });
    const icon = await sharp({ create: { width: 2, height: 2, channels: 4, background: "red" } }).png().toBuffer();
    await writeFile(path.join(plugin, "icon.png"), icon);
    await writeFile(path.join(plugin, ".ohmygame-plugin", "plugin.json"), JSON.stringify({
      name: "reference-modeler",
      version: "0.1.0",
      description: "Rebuild a reference as a model",
      skills: "./skills/",
      interface: { longDescription: "A detailed modeling workflow.", icon: { type: "asset", path: "./icon.png" } },
    }));
    await writeFile(path.join(plugin, "skills", "reference-modeler", "SKILL.md"), "---\nname: reference-modeler\ndescription: Model a reference\n---\n");
    const store = new BundledPluginStore(root);

    await store.load();

    expect(store.list()).toMatchObject([{
      id: "ohmygame:reference-modeler",
      source: { type: "builtIn" },
      longDescription: "A detailed modeling workflow.",
      skills: [{ id: "skills/reference-modeler/SKILL.md" }],
      connections: [],
    }]);
    expect(store.installedPath("ohmygame:reference-modeler")).toBe(plugin);
    expect((await store.readIcon("ohmygame:reference-modeler"))?.bytes).toEqual(icon);
    expect(await store.readIcon("ohmygame:missing")).toBeUndefined();
  });

  it("loads the built-in Web Game Studio skill suite", async () => {
    const store = new BundledPluginStore(path.resolve("plugins"), { formatTwoDirectory: path.resolve("plugins-v2"), off: BUNDLED_PLUGINS_OFF });

    await store.load();

    expect(store.read("ohmygame:web-game-studio")).toMatchObject({
      displayName: "Web Game Studio",
      projectTypes: ["web-game"],
      skills: [
        { name: "Game Playtest" },
        { name: "Game Ui Frontend" },
        { name: "Phaser 2d Game" },
        { name: "React Three Fiber Game" },
        { name: "Sprite Pipeline" },
        { name: "Three Webgl Game" },
        { name: "Web 3d Asset Pipeline" },
        { name: "Web Game Foundations" },
        { name: "Web Game Studio" },
      ],
    });
  });

  it("loads Game Studio independently of the Web Game Studio suite", async () => {
    const store = new BundledPluginStore(path.resolve("plugins"), { formatTwoDirectory: path.resolve("plugins-v2"), off: BUNDLED_PLUGINS_OFF });
    await store.load();

    expect(store.read("ohmygame:game-studio")).toMatchObject({
      displayName: "Game Studio",
      enabled: true,
      projectTypes: ["general", "godot-game", "interactive-story"],
      skills: [
        { id: "skills/game-foundations/SKILL.md", name: "Game Foundations" },
        { id: "skills/game-qa/SKILL.md", name: "Game Qa" },
        { id: "skills/game-studio/SKILL.md", name: "Game Studio" },
      ],
      connections: [],
    });
  });

  it("loads the built-in Three.js World skill", async () => {
    const store = new BundledPluginStore(path.resolve("plugins"), { formatTwoDirectory: path.resolve("plugins-v2"), off: BUNDLED_PLUGINS_OFF });

    await store.load();

    expect(store.read("ohmygame:threejs-world")).toMatchObject({
      displayName: "Three.js World",
      projectTypes: ["web-game"],
      skills: [{ id: "skills/threejs-world/SKILL.md", name: "Threejs World" }],
    });
  });
});

describe("format 1 to format 2 conversion", () => {
  const format1 = {
    name: "tiles",
    version: "0.2.0",
    description: "Long manifest description",
    enabledByDefault: false,
    skills: "./skills/",
    interface: {
      beta: true,
      displayName: "Tiles",
      shortDescription: "Make tile maps",
      longDescription: "Make tile maps and export them.",
      icon: { type: "asset" as const, path: "./assets/icon.png" },
      defaultPrompt: ["Make a map", "Export the map"],
      projectTypes: ["general", "web-game"] as ("general" | "web-game")[],
    },
  };

  it("keeps what the catalog shows when a plugin goes to format 2 and back", async () => {
    const { catalogManifest, convertFormat1Manifest } = await import("../src/daemon/plugin-conversion.js");
    const converted = convertFormat1Manifest(format1 as never, { publisher: "ohmygame", categories: ["art"] });
    expect(converted.manifest).toMatchObject({ id: "ohmygame/tiles", version: "0.2.0", beta: true, icon: "./assets/icon.png", appliesTo: ["general", "web-game"], categories: ["art"], contributes: { skills: "./skills/" } });
    const back = catalogManifest({ manifest: converted.manifest as never, strings: { en: converted.strings } }, { enabledByDefault: false });
    expect(back).toEqual({
      name: "tiles",
      version: "0.2.0",
      description: "Make tile maps",
      skills: "./skills/",
      enabledByDefault: false,
      interface: { ...format1.interface },
    });
  });

  it("refuses a plugin that adds more than Skills", async () => {
    const { convertFormat1Manifest } = await import("../src/daemon/plugin-conversion.js");
    expect(() => convertFormat1Manifest({ ...format1, mcpServers: "./mcp.json" } as never, { publisher: "ohmygame" })).toThrow("only plugins that add Skills convert");
  });
});
