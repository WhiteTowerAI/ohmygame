import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WebSearchSettingsStore } from "../src/daemon/web-search-settings.js";

describe("web search settings", () => {
  it("defaults to automatic public search with fallback", async () => {
    const store = new WebSearchSettingsStore(await temporaryData());
    await store.load();

    expect(store.get()).toEqual({
      enabled: true,
      provider: "auto",
      fallback: true,
      exaApiKeyConfigured: false,
      parallelApiKeyConfigured: false,
    });
  });

  it("persists secrets privately without returning them", async () => {
    const dataDirectory = await temporaryData();
    const store = new WebSearchSettingsStore(dataDirectory);
    await store.load();

    await expect(
      store.update({
        enabled: true,
        provider: "custom",
        fallback: false,
        exaApiKey: "exa-secret",
        parallelApiKey: "parallel-secret",
        custom: {
          name: "Internal Search",
          endpoint: "https://search.example.com/mcp",
          toolName: "search",
          apiKey: "custom-secret",
        },
      }),
    ).resolves.toEqual({
      enabled: true,
      provider: "custom",
      fallback: false,
      exaApiKeyConfigured: true,
      parallelApiKeyConfigured: true,
      custom: {
        name: "Internal Search",
        endpoint: "https://search.example.com/mcp",
        toolName: "search",
        apiKeyConfigured: true,
      },
    });

    const file = path.join(dataDirectory, "web-search-settings.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toContain("custom-secret");

    await store.update({
      enabled: true,
      provider: "custom",
      fallback: false,
      exaApiKey: null,
      custom: {
        name: "Internal Search",
        endpoint: "https://search.example.com/mcp",
        toolName: "search",
      },
    });
    expect(store.runtime().exaApiKey).toBeUndefined();
    expect(store.runtime().parallelApiKey).toBe("parallel-secret");
    expect(store.runtime().custom?.apiKey).toBe("custom-secret");
  });

  it("requires a valid custom provider", async () => {
    const store = new WebSearchSettingsStore(await temporaryData());
    await store.load();

    await expect(
      store.update({ enabled: true, provider: "custom", fallback: false }),
    ).rejects.toThrow("configuration is required");
    await expect(
      store.update({
        enabled: true,
        provider: "custom",
        fallback: false,
        custom: {
          name: "Search",
          endpoint: "file:///tmp/search",
          toolName: "search",
        },
      }),
    ).rejects.toThrow("not valid");
  });
});

function temporaryData(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "ohmygame-web-search-settings-"));
}
