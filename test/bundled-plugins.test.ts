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
      "tiled", "unity", "wechat-minigame",
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
    // Godot and Unreal are format 2 plugins with their own tools or MCP, turned on per project.
    expect(store.read("ohmygame:godot")).toBeUndefined();
    expect(store.read("ohmygame:unreal-engine")).toBeUndefined();
    for (const [name, skill] of [
      ["aseprite", "aseprite-assets"],
      ["cocos-creator", "cocos-creator"],
      ["douyin-minigame", "douyin-minigame"],
      ["tiled", "tiled-maps"],
      ["unity", "unity-game"],
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
      expect(plugin.mcpServers).toEqual([]);
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

  it("converts any format 1 package's Skills into a new format 2 package", async () => {
    const { convertFormat1Package } = await import("../src/daemon/plugin-conversion.js");
    const { readFile, readdir } = await import("node:fs/promises");
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-convert-"));
    const root = path.join(directory, "source");
    const write = async (relative: string, content: string) => {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), content);
    };
    // A root Skill with its own folders and one nested inside it, a Skill
    // named like another, one without a description, and a shared file.
    await write("SKILL.md", "---\nname: Map Maker\ndescription: Makes maps\n---\nRead [the guide](docs/guide.md), [shared notes](../source/shared/notes.md#tiles) and [the inner one](extras/inner/SKILL.md).\n");
    await write("docs/guide.md", "guide");
    await write(".git/config", "private");
    await write("extras/inner/SKILL.md", "---\nname: map-maker\ndescription: Also makes maps\n---\nInner\n");
    await write("more/SKILL.md", "---\nname: Exporter\ndescription:\n---\nSee [notes](../shared/notes.md).\n");
    await write("shared/notes.md", "notes");
    await write("assets/icon.png", "png");
    const result = await convertFormat1Package({
      root,
      manifest: { ...format1, version: undefined, skills: ["./SKILL.md", "./extras/", "./more/SKILL.md"], mcpServers: "./mcp.json" } as never,
    }, path.join(directory, "target"), { id: "personal/tiles" });

    expect(result.entry).toMatchObject({ id: "personal/tiles", version: "0.0.0" });
    expect(result.entry.skills.map((skill) => skill.path)).toEqual([
      "./skills/exporter/SKILL.md", "./skills/map-maker/SKILL.md", "./skills/map-maker-2/SKILL.md",
    ]);
    expect(result.skills).toEqual({
      "SKILL.md": "skills/map-maker/SKILL.md",
      "extras/inner/SKILL.md": "skills/map-maker-2/SKILL.md",
      "more/SKILL.md": "skills/exporter/SKILL.md",
    });
    expect(result.left).toEqual(["mcpServers"]);
    const target = path.join(directory, "target");
    const root2 = path.join(target, "skills", "map-maker");
    // Skills nested in the root Skill and hidden files stay out of its copy;
    // its links no longer name the old folder, and one into the nested Skill follows it.
    expect((await readdir(root2)).sort()).toEqual(["SKILL.md", "assets", "docs", "extras", "shared"]);
    expect(await readdir(path.join(root2, "extras"))).toEqual([]);
    expect(await readFile(path.join(root2, "SKILL.md"), "utf8")).toBe(
      "---\nname: map-maker\ndescription: Makes maps\n---\nRead [the guide](docs/guide.md), [shared notes](shared/notes.md#tiles) and [the inner one](../map-maker-2/SKILL.md).\n",
    );
    // A file in another Skill's folder is linked there.
    const exporter = await readFile(path.join(target, "skills", "exporter", "SKILL.md"), "utf8");
    expect(exporter).toBe("---\nname: exporter\ndescription: Long manifest description\n---\nSee [notes](../map-maker/shared/notes.md).\n");
    expect(await readFile(path.join(target, "assets", "icon.png"), "utf8")).toBe("png");
    expect(result.notes).toEqual(expect.arrayContaining(["mcpServers is not part of the converted package", 'Skill "Map Maker" is named map-maker']));
  });

  it("copies a linked file in no Skill's folder, but no hidden file, and keeps frontmatter valid", async () => {
    const { convertFormat1Package } = await import("../src/daemon/plugin-conversion.js");
    const { readFile, readdir } = await import("node:fs/promises");
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-convert-"));
    const root = path.join(directory, "source");
    await mkdir(path.join(root, "skills", "a"), { recursive: true });
    await mkdir(path.join(root, "shared"), { recursive: true });
    await writeFile(path.join(root, "shared", "notes.md"), "notes");
    await writeFile(path.join(root, ".env"), "SECRET=1");
    await writeFile(path.join(root, "skills", "a", "SKILL.md"), '---\n"name": >-\n  My Skill\ndescription: A\n---\n[notes](../../shared/notes.md) [env](../../.env)\n');
    await convertFormat1Package({ root, manifest: format1 as never }, path.join(directory, "target"), { id: "personal/tiles" });
    const skill = path.join(directory, "target", "skills", "my-skill");
    expect(await readFile(path.join(skill, "_shared", "shared", "notes.md"), "utf8")).toBe("notes");
    expect(await readdir(path.join(skill, "_shared"))).toEqual(["shared"]);
    expect(await readFile(path.join(skill, "SKILL.md"), "utf8")).toBe('---\n"name": >-\n  my-skill\ndescription: A\n---\n[notes](_shared/shared/notes.md) [env](../../.env)\n');
  });

  it("rewrites every link form once, and keeps the icon inside the package", async () => {
    const { convertFormat1Package } = await import("../src/daemon/plugin-conversion.js");
    const { readFile, readdir } = await import("node:fs/promises");
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-convert-"));
    const root = path.join(directory, "source");
    const write = async (relative: string, content: string) => {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), content);
    };
    // Folder b becomes Skill c, and folder c becomes Skill d.
    await write("x/b/SKILL.md", "---\nname: c\ndescription: B\n---\n");
    await write("x/c/SKILL.md", "---\nname: d\ndescription: C\n---\n");
    await write("x/a/SKILL.md", [
      "---", "name: a", "description: A", "---",
      "[B](../b/SKILL.md) and [C](../c/SKILL.md 'C') and [guide][guide] and [mine](<../../docs/my guide.md>) and [v2](../../docs/guide(v2).md) and [v3](../../docs/guide%23v3.md#top) and [escaped](../../docs/guide\\(v2\\).md) and [next][next] and [R&D](../../docs/R&amp;D.md) and [done](../../docs/100%-done.md)",
      "",
      "Write links like `[guide](../../docs/guide.md)`:",
      "",
      "~~~md",
      "[guide](../../docs/guide.md)",
      "~~~~",
      "",
      "[after](../../docs/guide.md)",
      "",
      "[guide]: ../../docs/guide.md",
      "[next]:",
      "  ../../docs/guide.md",
      "",
    ].join("\n"));
    await write("docs/guide.md", "guide");
    await write("docs/my guide.md", "my guide");
    await write("docs/guide(v2).md", "v2");
    await write("docs/guide#v3.md", "v3");
    await write("docs/R&D.md", "rd");
    await write("docs/100%-done.md", "done");
    // The Skill's own `_shared/` file isn't overwritten by a linked copy.
    await write("x/a/_shared/docs/guide.md", "own");
    await write("locales/icon.png", "png");
    await mkdir(path.join(directory, "out"));
    const result = await convertFormat1Package({
      root,
      manifest: { ...format1, skills: "./x/", interface: { ...format1.interface, icon: { type: "asset", path: "../source/locales/icon.png" } } } as never,
    }, path.join(directory, "out", "result"), { id: "personal/tiles" });
    expect(await readFile(path.join(directory, "out", "result", "skills", "a", "SKILL.md"), "utf8")).toBe([
      "---", "name: a", "description: A", "---",
      "[B](../c/SKILL.md) and [C](../d/SKILL.md 'C') and [guide][guide] and [mine](<_shared-2/docs/my%20guide.md>) and [v2](_shared-2/docs/guide(v2).md) and [v3](_shared-2/docs/guide%23v3.md#top) and [escaped](_shared-2/docs/guide(v2).md) and [next][next] and [R&D](_shared-2/docs/R%26D.md) and [done](_shared-2/docs/100%25-done.md)",
      "",
      "Write links like `[guide](../../docs/guide.md)`:",
      "",
      "~~~md",
      "[guide](../../docs/guide.md)",
      "~~~~",
      "",
      "[after](_shared-2/docs/guide.md)",
      "",
      "[guide]: _shared-2/docs/guide.md",
      "[next]:",
      "  _shared-2/docs/guide.md",
      "",
    ].join("\n"));
    const skill = path.join(directory, "out", "result", "skills", "a");
    expect(await readFile(path.join(skill, "_shared", "docs", "guide.md"), "utf8")).toBe("own");
    expect(await readFile(path.join(skill, "_shared-2", "docs", "guide.md"), "utf8")).toBe("guide");
    expect(await readFile(path.join(skill, "_shared-2", "docs", "guide#v3.md"), "utf8")).toBe("v3");
    expect(result.entry.manifest.icon).toBe("./locales/icon.png");
    expect(await readdir(path.join(directory, "out"))).toEqual(["result"]);
  });

  it("puts the icon beside the manifest folder when a Skill's file took its path", async () => {
    const { convertFormat1Package } = await import("../src/daemon/plugin-conversion.js");
    const { readFile } = await import("node:fs/promises");
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-convert-"));
    const root = path.join(directory, "source");
    // Skill folder `old` is named `new`, so its icon lands at skills/new/icon.png.
    await mkdir(path.join(root, "skills", "old"), { recursive: true });
    await mkdir(path.join(root, "skills", "new"), { recursive: true });
    await writeFile(path.join(root, "skills", "old", "SKILL.md"), "---\nname: new\ndescription: New\n---\n");
    await writeFile(path.join(root, "skills", "old", "icon.png"), "skill");
    await writeFile(path.join(root, "skills", "new", "icon.png"), "plugin");
    const result = await convertFormat1Package({
      root,
      manifest: { ...format1, skills: "./skills/old/SKILL.md", interface: { ...format1.interface, icon: { type: "asset", path: "./skills/new/icon.png" } } } as never,
    }, path.join(directory, "target"), { id: "personal/tiles" });
    expect(await readFile(path.join(directory, "target", "skills", "new", "icon.png"), "utf8")).toBe("skill");
    expect(result.entry.manifest.icon).toBe("./icon.png");
    expect(await readFile(path.join(directory, "target", "icon.png"), "utf8")).toBe("plugin");
  });

  it("refuses Skills paths outside the package or through a link", async () => {
    const { convertFormat1Package } = await import("../src/daemon/plugin-conversion.js");
    const { symlink } = await import("node:fs/promises");
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-convert-"));
    const root = path.join(directory, "source");
    await mkdir(path.join(root, "skills", "a"), { recursive: true });
    await writeFile(path.join(root, "skills", "a", "SKILL.md"), "---\nname: a\ndescription: A\n---\n");
    await expect(convertFormat1Package({ root, manifest: { ...format1, skills: "../elsewhere" } as never }, path.join(directory, "one"), { id: "personal/tiles" }))
      .rejects.toThrow("outside the package");
    await expect(convertFormat1Package({ root, manifest: format1 as never }, path.join(root, "converted"), { id: "personal/tiles" }))
      .rejects.toThrow("can't be written inside");
    // A link on the way, to a folder outside the package.
    const outside = path.join(directory, "outside", "private");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "SKILL.md"), "---\nname: private\ndescription: Private\n---\n");
    await symlink(path.dirname(outside), path.join(root, "alias"));
    await expect(convertFormat1Package({ root, manifest: { ...format1, skills: "./alias/private/SKILL.md" } as never }, path.join(directory, "three"), { id: "personal/tiles" }))
      .rejects.toThrow("is a link");
    await symlink(path.join(root, "skills", "a"), path.join(root, "skills", "b"));
    await expect(convertFormat1Package({ root, manifest: format1 as never }, path.join(directory, "two"), { id: "personal/tiles" }))
      .rejects.toThrow("is a link");
  });
});
