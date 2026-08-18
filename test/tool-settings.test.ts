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

    expect(store.get()).toEqual({ installedTools: [], enabledTools: [] });
    await expect(store.update({ installedTools: ["generate-image"], enabledTools: ["generate-image"] })).resolves.toEqual({ installedTools: ["generate-image"], enabledTools: ["generate-image"] });

    const reloaded = new ToolSettingsStore(directory, ["generate-image"]);
    await reloaded.load();
    expect(reloaded.get()).toEqual({ installedTools: ["generate-image"], enabledTools: ["generate-image"] });
  });

  it("rejects unknown, duplicate, and malformed settings", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "open-game-tool-settings-"));
    const store = new ToolSettingsStore(directory, ["generate-image"]);
    await expect(store.update({ installedTools: ["missing"] as never, enabledTools: [] })).rejects.toThrow("Invalid tool settings");
    await expect(store.update({ installedTools: ["generate-image", "generate-image"], enabledTools: [] })).rejects.toThrow("Invalid tool settings");
    await expect(store.update({ installedTools: [], enabledTools: ["generate-image"] })).rejects.toThrow("Enabled tools must be installed");

    await writeFile(path.join(directory, "tool-settings.json"), JSON.stringify({ version: 2, enabledTools: [] }));
    await expect(new ToolSettingsStore(directory, ["generate-image"]).load()).rejects.toThrow("Invalid tool settings");
    expect(JSON.parse(await readFile(path.join(directory, "tool-settings.json"), "utf8"))).toEqual({ version: 2, enabledTools: [] });
  });

  it("migrates v1 enabled tools into installed and enabled state", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "open-game-tool-settings-"));
    await writeFile(path.join(directory, "tool-settings.json"), JSON.stringify({ version: 1, enabledTools: ["generate-image"] }));
    const store = new ToolSettingsStore(directory, ["generate-image"]);
    await store.load();
    expect(store.get()).toEqual({ installedTools: ["generate-image"], enabledTools: ["generate-image"] });
    expect(JSON.parse(await readFile(path.join(directory, "tool-settings.json"), "utf8"))).toEqual({
      version: 2,
      installedTools: ["generate-image"],
      enabledTools: ["generate-image"],
    });
  });

  it("handles concurrent updates without sharing a temporary file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "open-game-tool-settings-"));
    const store = new ToolSettingsStore(directory, ["generate-image"]);

    await expect(Promise.all([
      store.update({ installedTools: ["generate-image"], enabledTools: ["generate-image"] }),
      store.update({ installedTools: ["generate-image"], enabledTools: ["generate-image"] }),
    ])).resolves.toHaveLength(2);
    expect(await readdir(directory)).toEqual(["tool-settings.json"]);
    expect(JSON.parse(await readFile(path.join(directory, "tool-settings.json"), "utf8")))
      .toEqual({ version: 2, installedTools: ["generate-image"], enabledTools: ["generate-image"] });
  });
});
