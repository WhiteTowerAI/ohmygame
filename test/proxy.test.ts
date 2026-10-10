import { describe, expect, it } from "vitest";
import { configureNetworkProxy, getConfiguredNetworkProxy, proxyOptionsFromEnvironment } from "../src/daemon/proxy.js";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { applySystemProxy, proxyUrlFromElectron } from "../src/desktop/system-proxy.js";

describe("proxyOptionsFromEnvironment", () => {
  it("reports the applied startup proxy even when environment values later change", async () => {
    const previousDispatcher = getGlobalDispatcher();
    const environment = { HTTPS_PROXY: "http://startup.test:7890" };
    let configuredDispatcher: ReturnType<typeof getGlobalDispatcher> | undefined;
    try {
      expect(configureNetworkProxy(environment)).toBe(true);
      configuredDispatcher = getGlobalDispatcher();
      environment.HTTPS_PROXY = "http://changed.test:7890";
      const snapshot = getConfiguredNetworkProxy()!;
      expect(snapshot.httpsProxy).toBe("http://startup.test:7890");
      snapshot.httpsProxy = "http://mutated.test:7890";
      expect(configureNetworkProxy({})).toBe(false);
      expect(getConfiguredNetworkProxy()?.httpsProxy).toBe("http://startup.test:7890");
    } finally {
      setGlobalDispatcher(previousDispatcher);
      await configuredDispatcher?.close?.();
    }
  });

  it("does nothing without an HTTP proxy", () => {
    expect(proxyOptionsFromEnvironment({})).toBeUndefined();
  });

  it("accepts lowercase proxy variables and always bypasses local services", () => {
    expect(proxyOptionsFromEnvironment({
      http_proxy: "http://127.0.0.1:7890",
      https_proxy: "http://127.0.0.1:7890",
      no_proxy: "example.test",
    })).toEqual({
      httpProxy: "http://127.0.0.1:7890",
      httpsProxy: "http://127.0.0.1:7890",
      noProxy: "example.test,127.0.0.1,localhost,.localhost",
    });
  });

  it("prefers uppercase proxy variables", () => {
    expect(proxyOptionsFromEnvironment({
      HTTP_PROXY: "http://upper-http.test",
      http_proxy: "http://lower-http.test",
      HTTPS_PROXY: "http://upper-https.test",
    })).toMatchObject({
      httpProxy: "http://upper-http.test",
      httpsProxy: "http://upper-https.test",
    });
  });
});

describe("Electron system proxy", () => {
  it("uses the first supported proxy", () => {
    expect(proxyUrlFromElectron("SOCKS5 127.0.0.1:1080; PROXY 127.0.0.1:7890; DIRECT"))
      .toBe("http://127.0.0.1:7890");
    expect(proxyUrlFromElectron("HTTPS proxy.example:443; DIRECT"))
      .toBe("https://proxy.example");
  });

  it("passes the system proxy to the daemon environment", async () => {
    const environment: NodeJS.ProcessEnv = {};
    await applySystemProxy(environment, async () => "PROXY 127.0.0.1:7890; DIRECT");
    expect(environment).toMatchObject({
      HTTP_PROXY: "http://127.0.0.1:7890",
      HTTPS_PROXY: "http://127.0.0.1:7890",
    });
  });

  it("preserves an explicit proxy environment", async () => {
    const environment = { HTTPS_PROXY: "http://explicit.test:8080" };
    await applySystemProxy(environment, async () => "PROXY 127.0.0.1:7890");
    expect(environment).toEqual({ HTTPS_PROXY: "http://explicit.test:8080" });
  });
});
