import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NetworkSettingsService,
  NetworkSettingsStore,
  normalizeNetworkSettings,
} from "../src/daemon/network-settings.js";
import {
  DEFAULT_NETWORK_SETTINGS,
  NETWORK_TEST_URL,
} from "../src/shared/network-settings.js";
import { getGlobalDispatcher } from "undici/index.js";

const directories: string[] = [];
async function directory() {
  const value = await mkdtemp(path.join(tmpdir(), "ohmygame-network-"));
  directories.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((value) => rm(value, { recursive: true, force: true })),
  );
});

describe("network settings", () => {
  it("persists normalized settings privately and applies them on the next startup", async () => {
    const dataDirectory = await directory();
    const service = new NetworkSettingsService(dataDirectory);
    await service.load();
    expect(service.get()).toMatchObject({
      settings: DEFAULT_NETWORK_SETTINGS,
      active: { source: "direct" },
      requiresRestart: false,
    });
    const saved = await service.update({
      mode: "manual",
      proxyUrl: " http://127.0.0.1:7890/ ",
      noProxy: " internal.test, internal.test ",
    });
    expect(saved).toMatchObject({
      settings: {
        mode: "manual",
        proxyUrl: "http://127.0.0.1:7890",
        noProxy: "internal.test",
      },
      active: { source: "direct" },
      detected: { source: "manual" },
      requiresRestart: true,
    });
    expect((await stat(service.store.filePath)).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(await readFile(service.store.filePath, "utf8")),
    ).toMatchObject({ version: 1, mode: "manual" });
    const restarted = new NetworkSettingsService(dataDirectory);
    await restarted.load();
    expect(restarted.get()).toMatchObject({
      active: { source: "manual", httpsProxy: "http://127.0.0.1:7890" },
      requiresRestart: false,
    });
    await service.update(DEFAULT_NETWORK_SETTINGS);
    expect(service.get().requiresRestart).toBe(false);
  });

  it("keeps the original environment and active policy when detecting a changed system proxy", async () => {
    const environment = {};
    const service = new NetworkSettingsService(await directory(), {
      environment,
      initialSystemProxy: "DIRECT",
      resolveSystemProxy: async () => "PROXY 127.0.0.1:7890",
    });
    await service.load();
    Object.assign(environment, { HTTP_PROXY: "http://mutated.test:8080" });
    const refreshed = await service.detect();
    expect(refreshed).toMatchObject({
      active: { source: "direct" },
      detected: { source: "system", httpsProxy: "http://127.0.0.1:7890" },
      requiresRestart: true,
    });
  });

  it("requires a restart only when the effective proxy or bypass list changes", async () => {
    const service = new NetworkSettingsService(await directory(), {
      environment: { HTTPS_PROXY: "http://127.0.0.1:7890" },
    });
    await service.load();
    expect(
      (
        await service.update({
          mode: "auto",
          proxyUrl: "http://127.0.0.1:7891",
          noProxy: "",
        })
      ).requiresRestart,
    ).toBe(false);
    expect(
      (
        await service.update({
          mode: "manual",
          proxyUrl: "http://127.0.0.1:7890",
          noProxy: "",
        })
      ).requiresRestart,
    ).toBe(false);
    expect(
      (
        await service.update({
          mode: "manual",
          proxyUrl: "http://127.0.0.1:7890",
          noProxy: "internal.test",
        })
      ).requiresRestart,
    ).toBe(true);
    expect(
      (await service.update({ mode: "direct", proxyUrl: "", noProxy: "" }))
        .requiresRestart,
    ).toBe(true);
  });

  it("tests an unsaved configuration without changing global requests or storing it", async () => {
    const request = vi.fn(async () => ({ status: 401 }));
    const service = new NetworkSettingsService(await directory(), { request });
    await service.load();
    const dispatcher = getGlobalDispatcher();
    const result = await service.test({
      mode: "manual",
      proxyUrl: "http://127.0.0.1:7890",
      noProxy: "",
    });
    expect(result).toMatchObject({
      reachable: true,
      target: NETWORK_TEST_URL,
      statusCode: 401,
      route: { source: "manual" },
    });
    expect(request).toHaveBeenCalledWith(NETWORK_TEST_URL, expect.anything());
    expect(getGlobalDispatcher()).toBe(dispatcher);
    expect(service.get()).toMatchObject({
      settings: DEFAULT_NETWORK_SETTINGS,
      active: { source: "direct" },
      requiresRestart: false,
    });
    await expect(readFile(service.store.filePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports a proxy connection refusal without exposing transport details", async () => {
    const service = new NetworkSettingsService(await directory(), {
      request: async () => {
        throw new Error("private transport data", {
          cause: { code: "ECONNREFUSED" },
        });
      },
    });
    await service.load();
    const result = await service.test(DEFAULT_NETWORK_SETTINGS);
    expect(result).toMatchObject({
      reachable: false,
      error: expect.stringContaining("refused"),
    });
    expect(JSON.stringify(result)).not.toContain("private transport data");
  });

  it("refreshes system detection only for automatic tests and honors environment precedence", async () => {
    const resolveSystemProxy = vi.fn(async () => "PROXY 127.0.0.1:7890");
    const dataDirectory = await directory();
    const options = {
      initialSystemProxy: "DIRECT",
      resolveSystemProxy,
      request: async () => ({ status: 401 }),
    };
    const service = new NetworkSettingsService(dataDirectory, options);
    await service.load();
    const state = service.get();
    const dispatcher = getGlobalDispatcher();
    expect(await service.test(DEFAULT_NETWORK_SETTINGS)).toMatchObject({
      route: { source: "system", httpsProxy: "http://127.0.0.1:7890" },
    });
    expect(resolveSystemProxy).toHaveBeenCalledTimes(1);
    expect(service.get()).toEqual(state);
    expect(getGlobalDispatcher()).toBe(dispatcher);
    const inherited = new NetworkSettingsService(dataDirectory, {
      ...options,
      environment: { HTTPS_PROXY: "http://inherited.test:8080" },
    });
    await inherited.load();
    expect(await inherited.test(DEFAULT_NETWORK_SETTINGS)).toMatchObject({
      route: {
        source: "environment",
        httpsProxy: "http://inherited.test:8080",
      },
    });
    expect(resolveSystemProxy).toHaveBeenCalledTimes(1);
  });

  it("preserves authenticated environment proxies while redacting their credentials from settings and diagnostics", async () => {
    const service = new NetworkSettingsService(await directory(), {
      environment: {
        HTTPS_PROXY: "http://user:private-password@proxy.test:8080",
      },
      request: async () => ({ status: 401 }),
    });
    await service.load();
    expect(service.runtime().httpsProxy).toBe(
      "http://user:private-password@proxy.test:8080",
    );
    expect(service.get().active.httpsProxy).toBe("http://proxy.test:8080");
    expect(JSON.stringify(service.get())).not.toContain("private-password");
    expect(
      JSON.stringify(await service.test(DEFAULT_NETWORK_SETTINGS)),
    ).not.toContain("private-password");
  });

  it("allows choosing Direct after entering an invalid manual proxy draft", () => {
    expect(
      normalizeNetworkSettings({
        mode: "direct",
        proxyUrl: "socks5://127.0.0.1:1080",
        noProxy: "",
      }),
    ).toEqual({ mode: "direct", proxyUrl: "", noProxy: "" });
  });

  it.each([
    "socks5://127.0.0.1:1080",
    "file:///tmp/proxy",
    "http://user:secret@proxy.test",
    "http://proxy.test/v1",
    "http://proxy.test?key=secret",
    "",
  ])("rejects invalid or unsupported proxy URL %s", async (proxyUrl) => {
    const store = new NetworkSettingsStore(await directory());
    await expect(
      store.update({ mode: "manual", proxyUrl, noProxy: "" }),
    ).rejects.toThrow();
    expect(store.get()).toEqual(DEFAULT_NETWORK_SETTINGS);
  });

  it("rejects bypass syntax that would change Electron proxy rules", () => {
    expect(() =>
      normalizeNetworkSettings({
        mode: "auto",
        proxyUrl: "",
        noProxy: "example.test;<-loopback>",
      }),
    ).toThrow("commas");
  });
});
