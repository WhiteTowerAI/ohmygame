import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ToolSettingsStore } from "../src/daemon/tool-settings.js";

describe("ToolSettingsStore", () => {
  it("defaults to no enabled tools and persists updates", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "open-game-tool-settings-"));
    const store = new ToolSettingsStore(directory, ["generate-image"]);
    await store.load();

    expect(store.get()).toEqual({ enabledTools: [] });
    await expect(store.update(["generate-image"])).resolves.toEqual({ enabledTools: ["generate-image"] });

    const reloaded = new ToolSettingsStore(directory, ["generate-image"]);
    await reloaded.load();
    expect(reloaded.get()).toEqual({ enabledTools: ["generate-image"] });
  });

  it("rejects unknown, duplicate, and malformed settings", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "open-game-tool-settings-"));
    const store = new ToolSettingsStore(directory, ["generate-image"]);
    await expect(store.update(["missing"] as never)).rejects.toThrow("Invalid enabled tools");
    await expect(store.update(["generate-image", "generate-image"])).rejects.toThrow("Invalid enabled tools");

    await writeFile(path.join(directory, "tool-settings.json"), JSON.stringify({ version: 2, enabledTools: [] }));
    await expect(new ToolSettingsStore(directory, ["generate-image"]).load()).rejects.toThrow("Invalid tool settings");
    expect(JSON.parse(await readFile(path.join(directory, "tool-settings.json"), "utf8"))).toEqual({ version: 2, enabledTools: [] });
  });

  it("handles concurrent updates without sharing a temporary file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "open-game-tool-settings-"));
    const store = new ToolSettingsStore(directory, ["generate-image"]);

    await expect(Promise.all([
      store.update(["generate-image"]),
      store.update(["generate-image"]),
    ])).resolves.toHaveLength(2);
    expect(await readdir(directory)).toEqual(["tool-settings.json"]);
    expect(JSON.parse(await readFile(path.join(directory, "tool-settings.json"), "utf8")))
      .toEqual({ version: 1, enabledTools: ["generate-image"] });
  });
});
