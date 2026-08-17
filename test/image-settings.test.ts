import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApiSettingsStore } from "../src/daemon/api-settings.js";

describe("image settings", () => {
  it("uses environment fallback without exposing the key", async () => {
    const store = new ApiSettingsStore(await temporaryData(), "image-settings.json", "https://api.openai.com/v1", "Image", {
      apiUrl: "https://images.example/v1/",
      apiKey: "environment-secret",
    });
    await store.load();

    expect(store.get()).toEqual({ apiUrl: "https://images.example/v1", hasApiKey: true });
    expect(store.resolve()).toEqual({ apiUrl: "https://images.example/v1", apiKey: "environment-secret" });
  });

  it("persists user settings privately and preserves a saved key on endpoint updates", async () => {
    const dataDirectory = await temporaryData();
    const store = new ApiSettingsStore(dataDirectory, "image-settings.json", "https://api.openai.com/v1", "Image", { apiKey: "fallback" });
    await store.load();

    await store.update({ apiUrl: "https://relay.example/v1", apiKey: "saved-secret" });
    await store.update({ apiUrl: "https://second.example/v1" });

    expect(store.resolve()).toEqual({ apiUrl: "https://second.example/v1", apiKey: "saved-secret" });
    const file = path.join(dataDirectory, "image-settings.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      apiUrl: "https://second.example/v1",
      apiKey: "saved-secret",
    });
  });

  it("rejects invalid endpoints", async () => {
    const store = new ApiSettingsStore(await temporaryData(), "image-settings.json", "https://api.openai.com/v1", "Image");
    await expect(store.update({ apiUrl: "file:///tmp/image" })).rejects.toThrow("not valid");
  });
});

function temporaryData(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "open-game-image-settings-"));
}
