import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { NetworkSettingsService } from "../src/daemon/network-settings.js";
import {
  DEFAULT_NETWORK_SETTINGS,
  NETWORK_TEST_URL,
} from "../src/shared/network-settings.js";

const apps: ReturnType<typeof createApp>[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function setup(accessToken?: string) {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-network-api-"),
  );
  directories.push(dataDirectory);
  const networkSettings = new NetworkSettingsService(dataDirectory, {
    initialSystemProxy: "DIRECT",
    resolveSystemProxy: async () => "PROXY 127.0.0.1:7890",
    request: async () => ({ status: 401 }),
  });
  const app = createApp({ dataDirectory, networkSettings, accessToken });
  apps.push(app);
  return app;
}

describe("network settings API", () => {
  it("saves configuration, detects the system proxy, and tests drafts while keeping the active connection", async () => {
    const app = await setup();
    const get = await app.inject({ method: "GET", url: "/settings/network" });
    expect(get.json()).toMatchObject({
      settings: DEFAULT_NETWORK_SETTINGS,
      active: { source: "direct" },
      requiresRestart: false,
    });
    const detect = await app.inject({
      method: "POST",
      url: "/settings/network/detect",
    });
    expect(detect.json()).toMatchObject({
      active: { source: "direct" },
      detected: { source: "system" },
      requiresRestart: true,
    });
    const draft = {
      mode: "manual",
      proxyUrl: "http://127.0.0.1:7891",
      noProxy: "",
    };
    const test = await app.inject({
      method: "POST",
      url: "/settings/network/test",
      payload: draft,
    });
    expect(test.statusCode).toBe(200);
    expect(test.json()).toMatchObject({
      reachable: true,
      statusCode: 401,
      route: { source: "manual" },
    });
    expect(
      (await app.inject({ method: "GET", url: "/settings/network" })).json()
        .settings,
    ).toEqual(DEFAULT_NETWORK_SETTINGS);
    const saved = await app.inject({
      method: "PUT",
      url: "/settings/network",
      payload: draft,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      settings: draft,
      active: { source: "direct" },
      requiresRestart: true,
    });
  });

  it("protects configuration and diagnostics with the daemon token", async () => {
    const app = await setup("private-token");
    for (const [method, url] of [
      ["GET", "/settings/network"],
      ["PUT", "/settings/network"],
      ["POST", "/settings/network/test"],
      ["POST", "/settings/network/detect"],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        ...(method !== "GET" ? { payload: DEFAULT_NETWORK_SETTINGS } : {}),
      });
      expect(response.statusCode).toBe(401);
    }
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/settings/network",
          headers: { authorization: "Bearer private-token" },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("rejects unsupported settings and keeps the diagnostic destination fixed", async () => {
    const app = await setup();
    for (const payload of [
      { mode: "manual", proxyUrl: "socks5://127.0.0.1:1080", noProxy: "" },
      { ...DEFAULT_NETWORK_SETTINGS, mode: "unknown" },
    ])
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/settings/network/test",
            payload,
          })
        ).statusCode,
      ).toBe(400);
    const response = await app.inject({
      method: "POST",
      url: "/settings/network/test",
      payload: { ...DEFAULT_NETWORK_SETTINGS, target: "https://other.test" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().target).toBe(NETWORK_TEST_URL);
  });
});
