import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
const automaticSettings = { ...DEFAULT_NETWORK_SETTINGS, mode: "auto" as const };
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
  it("starts directly without inheriting environment or system proxies when no settings were saved", async () => {
    const resolveSystemProxy = vi.fn(async () => "PROXY system.test:7890");
    const service = new NetworkSettingsService(await directory(), {
      environment: { HTTPS_PROXY: "http://environment.test:8080", NO_PROXY: "env.test" },
      initialSystemProxy: "PROXY system.test:7890",
      resolveSystemProxy,
      request: async () => ({ status: 401 }),
    });
    await service.load();
    expect(service.get()).toMatchObject({
      settings: { mode: "direct", proxyUrl: "", noProxy: "" },
      active: { source: "direct" },
      detected: { source: "direct" },
      requiresRestart: false,
    });
    expect(service.runtime().httpsProxy).toBeUndefined();
    expect(service.runtime().noProxy).not.toContain("env.test");
    expect(await service.test(DEFAULT_NETWORK_SETTINGS)).toMatchObject({ route: { source: "direct" } });
    expect(resolveSystemProxy).not.toHaveBeenCalled();
  });

  it.each(["auto", "manual", "direct"] as const)("retains a saved %s configuration without rewriting it", async (mode) => {
    const dataDirectory = await directory();
    const store = new NetworkSettingsStore(dataDirectory);
    const settings = { mode, proxyUrl: "http://manual.test:7890", noProxy: "internal.test" };
    await store.update(settings);
    const original = await readFile(store.filePath, "utf8");
    const service = new NetworkSettingsService(dataDirectory, {
      environment: { HTTPS_PROXY: "http://environment.test:8080" },
    });
    await service.load();
    expect(service.get().settings).toEqual(settings);
    expect(service.get().active.source).toBe(mode === "auto" ? "environment" : mode);
    expect(await readFile(store.filePath, "utf8")).toBe(original);
  });

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
    await service.store.update(automaticSettings);
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
    await service.store.update(automaticSettings);
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
    expect(JSON.parse(await readFile(service.store.filePath, "utf8"))).toEqual({
      version: 1,
      ...DEFAULT_NETWORK_SETTINGS,
    });
  });

  it("starts new installations Direct and keeps Automatic for earlier ones without saved settings", async () => {
    const fresh = new NetworkSettingsStore(await directory());
    await fresh.load();
    expect(fresh.get().mode).toBe("direct");

    for (const entry of ["projects", "pi-agent"]) {
      const dataDirectory = await directory();
      await mkdir(path.join(dataDirectory, entry));
      const existing = new NetworkSettingsStore(dataDirectory);
      await existing.load();
      expect(existing.get().mode).toBe("auto");
    }
    const upgraded = await directory();
    await writeFile(path.join(upgraded, "onboarding.json"), "{}");
    const store = new NetworkSettingsStore(upgraded);
    await store.load();
    expect(store.get().mode).toBe("auto");

    // The choice is saved, so data created later does not change it.
    const freshDirectory = path.dirname(fresh.filePath);
    await mkdir(path.join(freshDirectory, "projects"));
    const reloaded = new NetworkSettingsStore(freshDirectory);
    await reloaded.load();
    expect(reloaded.get().mode).toBe("direct");
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
    expect(await service.test(automaticSettings)).toMatchObject({
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
    expect(await inherited.test(automaticSettings)).toMatchObject({
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
    await service.store.update(automaticSettings);
    await service.load();
    expect(service.runtime().httpsProxy).toBe(
      "http://user:private-password@proxy.test:8080",
    );
    expect(service.get().active.httpsProxy).toBe("http://proxy.test:8080");
    expect(JSON.stringify(service.get())).not.toContain("private-password");
    expect(
      JSON.stringify(await service.test(automaticSettings)),
    ).not.toContain("private-password");
  });

  it("resolves a newly saved automatic connection while keeping the active direct connection", async () => {
    const resolveSystemProxy = vi.fn(async () => "PROXY 127.0.0.1:7890");
    const service = new NetworkSettingsService(await directory(), {
      initialSystemProxy: "DIRECT",
      resolveSystemProxy,
    });
    await service.load();
    expect(await service.update(automaticSettings)).toMatchObject({
      settings: automaticSettings,
      active: { source: "direct" },
      detected: { source: "system", httpsProxy: "http://127.0.0.1:7890" },
      requiresRestart: true,
    });
    expect(resolveSystemProxy).toHaveBeenCalledOnce();
  });

  it("saves Automatic bypass edits without re-detecting the system proxy", async () => {
    const resolveSystemProxy = vi.fn(async () => {
      throw new Error("System detection unavailable");
    });
    const dataDirectory = await directory();
    const service = new NetworkSettingsService(dataDirectory, {
      initialSystemProxy: "PROXY 127.0.0.1:7890",
      resolveSystemProxy,
    });
    await service.store.update(automaticSettings);
    await service.load();
    const settings = { ...automaticSettings, noProxy: "internal.test" };
    expect(await service.update(settings)).toMatchObject({
      settings,
      detected: { source: "system", httpsProxy: "http://127.0.0.1:7890" },
      requiresRestart: true,
    });
    expect(resolveSystemProxy).not.toHaveBeenCalled();
    const restarted = new NetworkSettingsStore(dataDirectory);
    await restarted.load();
    expect(restarted.get()).toEqual(settings);
  });

  it.each(["direct", "manual", "environment"] as const)(
    "skips unused system detection for a %s connection",
    async (source) => {
      const resolveSystemProxy = vi.fn(async () => {
        throw new Error("System detection unavailable");
      });
      const service = new NetworkSettingsService(await directory(), {
        resolveSystemProxy,
        environment: source === "environment" ? { HTTPS_PROXY: "http://env.test:8080" } : {},
      });
      await service.load();
      const settings = {
        ...DEFAULT_NETWORK_SETTINGS,
        mode: source === "environment" ? "auto" as const : source,
        proxyUrl: source === "manual" ? "http://manual.test:7890" : "",
      };
      const state = await service.update(settings);
      expect(state.detected.source).toBe(source);
      expect(await service.detect()).toEqual(state);
      expect(resolveSystemProxy).not.toHaveBeenCalled();
    },
  );

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
