import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("web search settings API", () => {
  it("returns defaults and redacts saved credentials", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-search-api-")),
    });
    apps.push(app);

    const defaults = await app.inject({
      method: "GET",
      url: "/settings/web-search",
    });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json()).toMatchObject({
      enabled: true,
      provider: "auto",
      fallback: true,
    });

    const updated = await app.inject({
      method: "PUT",
      url: "/settings/web-search",
      payload: {
        enabled: true,
        provider: "parallel",
        fallback: false,
        parallelApiKey: "private-key",
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({
      enabled: true,
      provider: "parallel",
      fallback: false,
      exaApiKeyConfigured: false,
      parallelApiKeyConfigured: true,
    });
    expect(updated.body).not.toContain("private-key");
  });

  it("rejects invalid custom MCP configuration", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-search-api-")),
    });
    apps.push(app);

    const response = await app.inject({
      method: "PUT",
      url: "/settings/web-search",
      payload: {
        enabled: true,
        provider: "custom",
        fallback: false,
        custom: {
          name: "Local",
          endpoint: "file:///tmp/search",
          toolName: "search",
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "Custom MCP endpoint is not valid",
    });
  });
});
