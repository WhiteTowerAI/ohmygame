import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BundledPluginStore } from "../src/daemon/bundled-plugins.js";

describe("bundled plugins", () => {
  it("loads a standard skill-only OhMyGame plugin directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ohmygame-bundled-plugins-"));
    const plugin = path.join(root, "reference-modeler");
    await mkdir(path.join(plugin, ".ohmygame-plugin"), { recursive: true });
    await mkdir(path.join(plugin, "skills", "reference-modeler"), { recursive: true });
    await writeFile(path.join(plugin, ".ohmygame-plugin", "plugin.json"), JSON.stringify({
      name: "reference-modeler",
      version: "0.1.0",
      description: "Rebuild a reference as a model",
      skills: "./skills/",
      interface: { longDescription: "A detailed modeling workflow." },
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
});
