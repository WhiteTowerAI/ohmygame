import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { BundledPluginStore } from "../src/daemon/bundled-plugins.js";

describe("bundled plugins", () => {
  it("loads beta plugins with their native skills and connections", async () => {
    const store = new BundledPluginStore(path.resolve("plugins"));
    await store.load();
    expect(store.list().filter(plugin => plugin.beta).map(plugin => plugin.name)).toEqual([
      "aseprite", "blender", "cocos-creator", "douyin-minigame", "godot",
      "taptap-maker", "tiled", "unity", "unreal-engine", "wechat-minigame",
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
    expect(store.read("ohmygame:godot")).toMatchObject({
      enabled: true,
      skills: [{ id: "skills/godot-game/SKILL.md" }],
      mcpServers: [{ id: "godot" }],
      configuration: { "godot-path": { default: "godot" } },
    });
    expect(store.read("ohmygame:taptap-maker")).toMatchObject({
      enabled: false,
      skills: [{ id: "skills/taptap-maker/SKILL.md" }],
      mcpServers: [{ id: "taptap-maker" }],
      projectTypes: ["general"],
    });
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
    const store = new BundledPluginStore(path.resolve("plugins"));

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
    const store = new BundledPluginStore(path.resolve("plugins"));
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
    const store = new BundledPluginStore(path.resolve("plugins"));

    await store.load();

    expect(store.read("ohmygame:threejs-world")).toMatchObject({
      displayName: "Three.js World",
      projectTypes: ["web-game"],
      skills: [{ id: "skills/threejs-world/SKILL.md", name: "Threejs World" }],
    });
  });
});
