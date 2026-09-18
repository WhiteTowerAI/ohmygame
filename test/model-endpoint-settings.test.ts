import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ModelEndpointSettingsStore } from "../src/daemon/model-endpoint-settings.js";

describe("model endpoint settings", () => {
  it("uses the official endpoint until a custom endpoint is saved", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-model-endpoint-"));
    const store = new ModelEndpointSettingsStore(dataDirectory, "openai-endpoint.json", "https://api.openai.com/v1", "OpenAI");
    await store.load();

    expect(store.get()).toEqual({ baseUrl: "https://api.openai.com/v1" });
    expect(store.override()).toBeUndefined();

    await store.update("https://relay.example/v1/");

    expect(store.override()).toBe("https://relay.example/v1");
    expect(JSON.parse(await readFile(path.join(dataDirectory, "openai-endpoint.json"), "utf8"))).toEqual({
      version: 1,
      baseUrl: "https://relay.example/v1",
    });
    expect((await stat(path.join(dataDirectory, "openai-endpoint.json"))).mode & 0o777).toBe(0o600);
  });

  it("removes the override when the official endpoint is restored", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-model-endpoint-"));
    const store = new ModelEndpointSettingsStore(dataDirectory, "openai-endpoint.json", "https://api.openai.com/v1", "OpenAI");
    await store.update("https://relay.example/v1");

    await store.update("https://api.openai.com/v1/");

    expect(store.override()).toBeUndefined();
    await expect(readFile(path.join(dataDirectory, "openai-endpoint.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects invalid endpoints", async () => {
    const store = new ModelEndpointSettingsStore(await mkdtemp(path.join(tmpdir(), "ohmygame-model-endpoint-")), "openai-endpoint.json", "https://api.openai.com/v1", "OpenAI");
    await expect(store.update("file:///tmp/openai")).rejects.toThrow("not valid");
  });
});
