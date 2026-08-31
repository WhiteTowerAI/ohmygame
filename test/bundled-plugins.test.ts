import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BundledPluginStore } from "../src/daemon/bundled-plugins.js";

describe("bundled plugins", () => {
  it("loads a standard skill-only OpenGame plugin directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "open-game-bundled-plugins-"));
    const plugin = path.join(root, "reference-modeler");
    await mkdir(path.join(plugin, ".opengame-plugin"), { recursive: true });
    await mkdir(path.join(plugin, "skills", "reference-modeler"), { recursive: true });
    await writeFile(path.join(plugin, ".opengame-plugin", "plugin.json"), JSON.stringify({
      name: "reference-modeler",
      version: "0.1.0",
      description: "Rebuild a reference as a model",
      skills: "./skills/",
    }));
    await writeFile(path.join(plugin, "skills", "reference-modeler", "SKILL.md"), "---\nname: reference-modeler\ndescription: Model a reference\n---\n");
    const store = new BundledPluginStore(root);

    await store.load();

    expect(store.list()).toMatchObject([{
      id: "opengame:reference-modeler",
      source: { type: "builtIn" },
      skills: [{ id: "skills/reference-modeler/SKILL.md" }],
      connections: [],
    }]);
    expect(store.installedPath("opengame:reference-modeler")).toBe(plugin);
  });
});
