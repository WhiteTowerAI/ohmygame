import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getGlobalDispatcher } from "undici/index.js";
import { NetworkSettingsStore } from "../src/daemon/network-settings.js";
import {
  electronProxyConfig,
  prepareDesktopNetwork,
  proxyCredentials,
} from "../src/desktop/network.js";
import { networkBypassList, resolveNetworkProxy } from "../src/daemon/proxy.js";
import { DEFAULT_NETWORK_SETTINGS } from "../src/shared/network-settings.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function directory() {
  const value = await mkdtemp(path.join(tmpdir(), "ohmygame-desktop-network-"));
  directories.push(value);
  return value;
}

describe("desktop network configuration", () => {
  it("matches Node domain and all-hosts bypasses without adding wildcards to IP addresses", () => {
    const proxy = resolveNetworkProxy(DEFAULT_NETWORK_SETTINGS, {
      HTTPS_PROXY: "http://proxy.test:8080",
      NO_PROXY:
        "example.test:8443,*.internal.test,192.0.2.1:8080,[2001:db8::1]",
    });
    expect(electronProxyConfig(proxy).proxyBypassRules?.split(";")).toEqual(
      expect.arrayContaining([
        "example.test:8443",
        "*.example.test:8443",
        "internal.test",
        "*.internal.test",
        "192.0.2.1:8080",
        "[2001:db8::1]",
      ]),
    );
    expect(electronProxyConfig(proxy).proxyBypassRules).not.toContain(
      "*.192.0.2.1",
    );
    expect(
      electronProxyConfig({ ...proxy, noProxy: "*" }).proxyBypassRules,
    ).toBe("*");
  });

  it("detects system proxies in desktop development while retaining their source for the daemon", async () => {
    const environment = { NO_PROXY: "inherited.test" };
    const dispatcher = getGlobalDispatcher();
    const result = await prepareDesktopNetwork({
      dataDirectory: await directory(),
      environment,
      resolveProxy: async () => "PROXY 127.0.0.1:7890",
    });
    expect(result.active).toMatchObject({
      source: "system",
      httpProxy: "http://127.0.0.1:7890",
    });
    expect(result.active.noProxy.split(",")).toContain("inherited.test");
    expect(result.environment).toEqual({
      ...environment,
      OHMYGAME_SYSTEM_PROXY: "PROXY 127.0.0.1:7890",
    });
    expect(environment).not.toHaveProperty("HTTP_PROXY");
    expect(getGlobalDispatcher()).toBe(dispatcher);
    expect(electronProxyConfig(result.active)).toMatchObject({
      mode: "fixed_servers",
      proxyRules: "http=http://127.0.0.1:7890;https=http://127.0.0.1:7890",
    });
  });

  it("uses saved manual and direct modes for desktop requests as well as the daemon", async () => {
    const dataDirectory = await directory();
    const store = new NetworkSettingsStore(dataDirectory);
    await store.update({
      mode: "manual",
      proxyUrl: "http://127.0.0.1:7891",
      noProxy: ".internal.test",
    });
    const options = {
      dataDirectory,
      environment: { HTTP_PROXY: "http://inherited.test:8080" },
      resolveProxy: async () => "PROXY 127.0.0.1:7890",
    };
    const manual = await prepareDesktopNetwork(options);
    expect(manual.active).toMatchObject({
      source: "manual",
      httpProxy: "http://127.0.0.1:7891",
    });
    const config = electronProxyConfig(manual.active);
    expect(config.proxyBypassRules?.split(";")).toEqual(
      expect.arrayContaining([
        "internal.test",
        "*.internal.test",
        "localhost",
        "127.0.0.1",
        "[::1]",
      ]),
    );
    await store.update({ ...DEFAULT_NETWORK_SETTINGS, mode: "direct" });
    const direct = await prepareDesktopNetwork(options);
    expect(direct.active.source).toBe("direct");
    expect(electronProxyConfig(direct.active)).toEqual({ mode: "direct" });
  });

  it("preserves separate HTTP and HTTPS proxies", () => {
    const proxy = resolveNetworkProxy(DEFAULT_NETWORK_SETTINGS, {
      HTTP_PROXY: "http://http.test:8080",
      HTTPS_PROXY: "https://https.test:8443",
    });
    expect(electronProxyConfig(proxy)).toMatchObject({
      proxyRules: "http=http://http.test:8080;https=https://https.test:8443",
    });
    expect(proxy.noProxy).toBe(networkBypassList(""));
  });

  it("supplies inherited credentials only for the configured proxy host and keeps them out of Chromium rules", () => {
    const proxy = resolveNetworkProxy(DEFAULT_NETWORK_SETTINGS, {
      HTTPS_PROXY: "http://user:private%20password@proxy.test:8080",
    });
    expect(electronProxyConfig(proxy).proxyRules).not.toContain("private");
    expect(proxyCredentials(proxy, "proxy.test", 8080)).toEqual({
      username: "user",
      password: "private password",
    });
    expect(proxyCredentials(proxy, "other.test", 8080)).toBeUndefined();
    expect(proxyCredentials(proxy, "proxy.test", 80)).toBeUndefined();
  });
});
