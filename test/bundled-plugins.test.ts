import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readPluginIconAsset } from "../src/daemon/plugin-icons.js";
import { BUNDLED_PLUGINS_OFF, PluginServices } from "../src/daemon/plugin-services.js";
import { isAppWidePlugin } from "../src/shared/plugin-manifest.js";

describe("bundled plugins", () => {
  async function bundled() {
    const services = new PluginServices({
      directory: path.join(await mkdtemp(path.join(tmpdir(), "ohmygame-bundled-")), "store"),
      bundled: path.resolve("plugins-v2"),
      bundledOff: BUNDLED_PLUGINS_OFF,
    });
    await services.ready();
    return services;
  }
  const skillNames = (services: PluginServices, id: string) => services.index.get(id)!.skills.map((skill) => skill.name);
  const names = (services: PluginServices, id: string) => services.index.get(id)!.manifest.appliesTo;

  it("loads beta plugins with their Skills and icons, starting those for one platform off", async () => {
    const services = await bundled();
    try {
      const beta = [...new Set(services.index.entries().filter((entry) => entry.manifest.beta && isAppWidePlugin(entry.manifest)).map((entry) => entry.id))].sort();
      expect(beta).toEqual([
        "ohmygame/aseprite", "ohmygame/blender", "ohmygame/cocos-creator", "ohmygame/douyin-minigame",
        "ohmygame/tiled", "ohmygame/unity", "ohmygame/wechat-minigame",
      ]);
      for (const id of beta) {
        const entry = services.index.get(id)!;
        const image = await readPluginIconAsset(entry.root, { type: "asset", path: entry.manifest.icon! });
        expect(image?.bytes.length, id).toBeGreaterThan(0);
        expect(["image/png", "image/svg+xml"]).toContain(image!.mediaType);
      }
      expect(services.grants.plugin("ohmygame/blender")?.enabled).toBe(true);
      expect(skillNames(services, "ohmygame/blender")).toEqual(["blender-assets"]);
      // Godot and Unreal have their own tools or MCP, so a project turns them on.
      expect(isAppWidePlugin(services.index.get("ohmygame/godot")!.manifest)).toBe(false);
      expect(isAppWidePlugin(services.index.get("ohmygame/unreal-engine")!.manifest)).toBe(false);
      for (const [name, skill] of [
        ["aseprite", "aseprite-assets"],
        ["cocos-creator", "cocos-creator"],
        ["douyin-minigame", "douyin-minigame"],
        ["tiled", "tiled-maps"],
        ["unity", "unity-game"],
        ["wechat-minigame", "wechat-minigame"],
      ] as const) {
        expect(services.grants.plugin(`ohmygame/${name}`)?.enabled, name).toBe(false);
        expect(skillNames(services, `ohmygame/${name}`)).toEqual([skill]);
        expect(names(services, `ohmygame/${name}`)).toEqual(name === "aseprite" || name === "tiled"
          ? ["general", "web-game", "godot-game", "asset-canvas"]
          : ["general"]);
      }
    } finally {
      await services.close();
    }
  });

  it("loads the built-in creation Skills, each suite for its own kind of project", async () => {
    const services = await bundled();
    try {
      expect(names(services, "ohmygame/web-game-studio")).toEqual(["web-game"]);
      expect(skillNames(services, "ohmygame/web-game-studio")).toEqual([
        "game-playtest", "game-ui-frontend", "phaser-2d-game", "react-three-fiber-game", "sprite-pipeline",
        "three-webgl-game", "web-3d-asset-pipeline", "web-game-foundations", "web-game-studio",
      ]);
      expect(names(services, "ohmygame/game-studio")).toEqual(["general", "godot-game", "interactive-story"]);
      expect(skillNames(services, "ohmygame/game-studio")).toEqual(["game-foundations", "game-qa", "game-studio"]);
      expect(services.grants.plugin("ohmygame/game-studio")?.enabled).toBe(true);
      expect(names(services, "ohmygame/threejs-world")).toEqual(["web-game"]);
      expect(skillNames(services, "ohmygame/threejs-world")).toEqual(["threejs-world"]);
    } finally {
      await services.close();
    }
  });
});

describe("packaging a repository's Skills", () => {
  const source = {
    name: "tiles",
    version: "0.2.0",
    description: "Long manifest description",
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

  it("packages a repository's Skills in a new folder", async () => {
    const { packageSkills } = await import("../src/daemon/plugin-conversion.js");
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
    const result = await packageSkills({
      root,
      manifest: { ...source, version: undefined, skills: ["./SKILL.md", "./extras/", "./more/SKILL.md"] } as never,
    }, path.join(directory, "target"), { id: "personal/tiles" });

    expect(result.entry).toMatchObject({ id: "personal/tiles", version: "0.0.0" });
    // What its page shows comes along, and it applies by itself.
    expect(result.entry.manifest).toMatchObject({ beta: true, icon: "./assets/icon.png", appliesTo: ["general", "web-game"] });
    expect(isAppWidePlugin(result.entry.manifest)).toBe(true);
    expect(JSON.parse(await readFile(path.join(directory, "target", "locales", "en.json"), "utf8"))).toMatchObject({ displayName: "Tiles", description: "Make tile maps" });
    expect(result.entry.skills.map((skill) => skill.path)).toEqual([
      "./skills/exporter/SKILL.md", "./skills/map-maker/SKILL.md", "./skills/map-maker-2/SKILL.md",
    ]);
    expect(result.skills).toEqual({
      "SKILL.md": "skills/map-maker/SKILL.md",
      "extras/inner/SKILL.md": "skills/map-maker-2/SKILL.md",
      "more/SKILL.md": "skills/exporter/SKILL.md",
    });
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
    expect(result.notes).toEqual(expect.arrayContaining(['Skill "Map Maker" is named map-maker']));
  });

  it("copies a linked file in no Skill's folder, but no hidden file, and keeps frontmatter valid", async () => {
    const { packageSkills } = await import("../src/daemon/plugin-conversion.js");
    const { readFile, readdir } = await import("node:fs/promises");
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-convert-"));
    const root = path.join(directory, "source");
    await mkdir(path.join(root, "skills", "a"), { recursive: true });
    await mkdir(path.join(root, "shared"), { recursive: true });
    await writeFile(path.join(root, "shared", "notes.md"), "notes");
    await writeFile(path.join(root, ".env"), "SECRET=1");
    await writeFile(path.join(root, "skills", "a", "SKILL.md"), '---\n"name": >-\n  My Skill\ndescription: A\n---\n[notes](../../shared/notes.md) [env](../../.env)\n');
    await packageSkills({ root, manifest: source as never }, path.join(directory, "target"), { id: "personal/tiles" });
    const skill = path.join(directory, "target", "skills", "my-skill");
    expect(await readFile(path.join(skill, "_shared", "shared", "notes.md"), "utf8")).toBe("notes");
    expect(await readdir(path.join(skill, "_shared"))).toEqual(["shared"]);
    expect(await readFile(path.join(skill, "SKILL.md"), "utf8")).toBe('---\n"name": >-\n  my-skill\ndescription: A\n---\n[notes](_shared/shared/notes.md) [env](../../.env)\n');
  });

  it("rewrites every link form once, and keeps the icon inside the package", async () => {
    const { packageSkills } = await import("../src/daemon/plugin-conversion.js");
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
    const result = await packageSkills({
      root,
      manifest: { ...source, skills: "./x/", interface: { ...source.interface, icon: { type: "asset", path: "../source/locales/icon.png" } } } as never,
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
    const { packageSkills } = await import("../src/daemon/plugin-conversion.js");
    const { readFile } = await import("node:fs/promises");
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-convert-"));
    const root = path.join(directory, "source");
    // Skill folder `old` is named `new`, so its icon lands at skills/new/icon.png.
    await mkdir(path.join(root, "skills", "old"), { recursive: true });
    await mkdir(path.join(root, "skills", "new"), { recursive: true });
    await writeFile(path.join(root, "skills", "old", "SKILL.md"), "---\nname: new\ndescription: New\n---\n");
    await writeFile(path.join(root, "skills", "old", "icon.png"), "skill");
    await writeFile(path.join(root, "skills", "new", "icon.png"), "plugin");
    const result = await packageSkills({
      root,
      manifest: { ...source, skills: "./skills/old/SKILL.md", interface: { ...source.interface, icon: { type: "asset", path: "./skills/new/icon.png" } } } as never,
    }, path.join(directory, "target"), { id: "personal/tiles" });
    expect(await readFile(path.join(directory, "target", "skills", "new", "icon.png"), "utf8")).toBe("skill");
    expect(result.entry.manifest.icon).toBe("./icon.png");
    expect(await readFile(path.join(directory, "target", "icon.png"), "utf8")).toBe("plugin");
  });

  it("refuses Skills paths outside the package or through a link", async () => {
    const { packageSkills } = await import("../src/daemon/plugin-conversion.js");
    const { symlink } = await import("node:fs/promises");
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-convert-"));
    const root = path.join(directory, "source");
    await mkdir(path.join(root, "skills", "a"), { recursive: true });
    await writeFile(path.join(root, "skills", "a", "SKILL.md"), "---\nname: a\ndescription: A\n---\n");
    await expect(packageSkills({ root, manifest: { ...source, skills: "../elsewhere" } as never }, path.join(directory, "one"), { id: "personal/tiles" }))
      .rejects.toThrow("outside the package");
    await expect(packageSkills({ root, manifest: source as never }, path.join(root, "converted"), { id: "personal/tiles" }))
      .rejects.toThrow("can't be written inside");
    // A link on the way, to a folder outside the package.
    const outside = path.join(directory, "outside", "private");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "SKILL.md"), "---\nname: private\ndescription: Private\n---\n");
    await symlink(path.dirname(outside), path.join(root, "alias"));
    await expect(packageSkills({ root, manifest: { ...source, skills: "./alias/private/SKILL.md" } as never }, path.join(directory, "three"), { id: "personal/tiles" }))
      .rejects.toThrow("is a link");
    await symlink(path.join(root, "skills", "a"), path.join(root, "skills", "b"));
    await expect(packageSkills({ root, manifest: source as never }, path.join(directory, "two"), { id: "personal/tiles" }))
      .rejects.toThrow("is a link");
  });
});
