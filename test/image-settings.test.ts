import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ImageSettingsStore } from "../src/daemon/image-settings.js";

describe("image settings", () => {
  it("persists the selected provider and model privately", async () => {
    const dataDirectory = await temporaryData();
    const store = new ImageSettingsStore(dataDirectory);
    await store.load();

    await expect(store.update({ provider: "opengame", id: "gpt-image-2" })).resolves.toEqual({
      model: { provider: "opengame", id: "gpt-image-2" },
    });

    const file = path.join(dataDirectory, "image-settings.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 2,
      model: { provider: "opengame", id: "gpt-image-2" },
    });
  });

  it("ignores the previous standalone API configuration", async () => {
    const dataDirectory = await temporaryData();
    await writeFile(path.join(dataDirectory, "image-settings.json"), JSON.stringify({
      version: 1,
      apiUrl: "https://images.example/v1",
      apiKey: "legacy-secret",
    }));
    const store = new ImageSettingsStore(dataDirectory);

    await store.load();

    expect(store.get()).toEqual({});
  });
});

function temporaryData(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "open-game-image-settings-"));
}
