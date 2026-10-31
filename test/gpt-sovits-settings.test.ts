import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GptSovitsSettingsStore, normalizeGptSovitsBaseUrl } from "../src/daemon/gpt-sovits-settings.js";

describe("GPT-SoVITS base URL normalization", () => {
  it("accepts host URLs and strips trailing slashes", () => {
    expect(normalizeGptSovitsBaseUrl("http://192.0.2.10:9880/")).toBe("http://192.0.2.10:9880");
    expect(normalizeGptSovitsBaseUrl(" https://gw.example.com/tts/ ")).toBe("https://gw.example.com/tts");
  });

  it("rejects non-http values and URLs with query or fragment", () => {
    expect(() => normalizeGptSovitsBaseUrl("ftp://gateway:9880")).toThrow();
    expect(() => normalizeGptSovitsBaseUrl("not a url")).toThrow();
    expect(() => normalizeGptSovitsBaseUrl("http://gateway:9880?token=1")).toThrow();
    expect(() => normalizeGptSovitsBaseUrl("http://gateway:9880#section")).toThrow();
  });
});

describe("GPT-SoVITS settings store", () => {
  it("round-trips connection settings without exposing the token", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-gpt-sovits-"));
    const store = new GptSovitsSettingsStore(directory);
    await store.load();

    expect(store.get()).toEqual({ configured: false, tokenConfigured: false });
    expect(store.baseUrl()).toBeUndefined();

    await store.update({ baseUrl: "http://192.0.2.10:9880/", token: "secret-token" });
    expect(store.get()).toEqual({ configured: true, tokenConfigured: true, baseUrl: "http://192.0.2.10:9880" });
    expect(store.token()).toBe("secret-token");
    expect(JSON.stringify(store.get())).not.toContain("secret-token");

    await store.update({ defaultVoiceId: "gsv-0123456789" });
    expect(store.get()).toEqual({
      configured: true,
      tokenConfigured: true,
      baseUrl: "http://192.0.2.10:9880",
      defaultVoiceId: "gsv-0123456789",
    });

    // Persisted shape survives a reload and never validates malformed voice ids.
    const reloaded = new GptSovitsSettingsStore(directory);
    await reloaded.load();
    expect(reloaded.baseUrl()).toBe("http://192.0.2.10:9880");
    expect(reloaded.defaultVoiceId()).toBe("gsv-0123456789");
    await expect(store.update({ defaultVoiceId: "illegal id!" })).rejects.toThrow();
    await expect(store.update({ baseUrl: "http://gateway:9880?x=1" })).rejects.toThrow();
    await expect(store.update({ token: "带空格 token" })).rejects.toThrow();

    await store.clear();
    expect(store.get()).toEqual({ configured: false, tokenConfigured: false });
    expect(store.token()).toBeUndefined();
  });
});
