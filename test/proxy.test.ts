import { describe, expect, it } from "vitest";
import { applyNetworkProxyEnvironment, networkBypassList, normalizeProxyUrl, proxyUrlsFromEnvironment, resolveNetworkProxy } from "../src/daemon/proxy.js";
import { DEFAULT_NETWORK_SETTINGS } from "../src/shared/network-settings.js";

describe("normalizeProxyUrl", () => {
  it("accepts URLs with http:// scheme", () => {
    expect(normalizeProxyUrl("http://127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
  });

  it("accepts URLs with https:// scheme", () => {
    expect(normalizeProxyUrl("https://proxy.example:8443")).toBe("https://proxy.example:8443");
  });

  it("adds http:// scheme when URL is missing a protocol", () => {
    expect(normalizeProxyUrl("127.0.0.1:3067")).toBe("http://127.0.0.1:3067");
  });

  it("rejects completely invalid URLs", () => {
    expect(() => normalizeProxyUrl("not a url at all :// broken")).toThrow("Enter a valid HTTP or HTTPS proxy URL");
  });
});

describe("proxyUrlsFromEnvironment", () => {
  it("does nothing without an HTTP proxy", () => {
    expect(proxyUrlsFromEnvironment({})).toBeUndefined();
  });

  it("accepts lowercase proxy variables", () => {
    expect(proxyUrlsFromEnvironment({
      http_proxy: "http://127.0.0.1:7890",
      https_proxy: "http://127.0.0.1:7890",
      no_proxy: "example.test",
    })).toEqual({
      httpProxy: "http://127.0.0.1:7890",
      httpsProxy: "http://127.0.0.1:7890",
    });
  });

  it("prefers uppercase proxy variables", () => {
    expect(proxyUrlsFromEnvironment({
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
  it("honors DIRECT before later fallback proxies", () => {
    expect(resolveNetworkProxy(DEFAULT_NETWORK_SETTINGS, {}, "DIRECT; PROXY 127.0.0.1:7890").source).toBe("direct");
  });
  it("uses the first supported proxy", () => {
    expect(resolveNetworkProxy(DEFAULT_NETWORK_SETTINGS, {}, "SOCKS5 127.0.0.1:1080; PROXY 127.0.0.1:7890; DIRECT"))
      .toMatchObject({ source: "system", httpProxy: "http://127.0.0.1:7890" });
    expect(resolveNetworkProxy(DEFAULT_NETWORK_SETTINGS, {}, "HTTPS proxy.example:443; DIRECT"))
      .toMatchObject({ source: "system", httpsProxy: "https://proxy.example" });
  });
});

describe("application network policy", () => {
  const automatic = { mode: "auto" as const, proxyUrl: "", noProxy: "internal.test" };

  it("preserves the all-hosts NO_PROXY wildcard when adding mandatory local bypasses", () => {
    expect(resolveNetworkProxy(automatic, { HTTP_PROXY: "http://proxy.test:8080", NO_PROXY: "*" }).noProxy).toBe("*");
  });

  it("prefers explicit application modes, then environment, then system", () => {
    const environment = { HTTPS_PROXY: "http://environment.test:8080", NO_PROXY: "env.test" };
    expect(resolveNetworkProxy({ ...automatic, mode: "manual", proxyUrl: "http://127.0.0.1:7890/" }, environment, "PROXY system.test:7890"))
      .toMatchObject({ source: "manual", httpProxy: "http://127.0.0.1:7890", noProxy: networkBypassList("internal.test") });
    expect(resolveNetworkProxy({ ...automatic, mode: "direct" }, environment, "PROXY system.test:7890"))
      .toEqual({ source: "direct", noProxy: networkBypassList("internal.test") });
    const inherited = resolveNetworkProxy(automatic, environment, "PROXY system.test:7890");
    expect(inherited).toMatchObject({ source: "environment", httpsProxy: "http://environment.test:8080" });
    expect(inherited.noProxy).toBe(networkBypassList("env.test,internal.test"));
    expect(resolveNetworkProxy(automatic, {}, "PROXY system.test:7890"))
      .toMatchObject({ source: "system", httpProxy: "http://system.test:7890" });
  });

  it("normalizes SDK and child process variables and clears inherited proxies for direct mode", () => {
    const environment = { http_proxy: "http://old.test", HTTPS_PROXY: "http://other.test", ALL_PROXY: "socks5://old.test:1080" };
    applyNetworkProxyEnvironment(environment, resolveNetworkProxy({ ...automatic, mode: "manual", proxyUrl: "http://127.0.0.1:7890" }, {}, undefined));
    expect(environment).toMatchObject({ HTTP_PROXY: "http://127.0.0.1:7890", http_proxy: "http://127.0.0.1:7890", HTTPS_PROXY: "http://127.0.0.1:7890", https_proxy: "http://127.0.0.1:7890" });
    expect(environment).not.toHaveProperty("ALL_PROXY");
    applyNetworkProxyEnvironment(environment, resolveNetworkProxy({ ...automatic, mode: "direct" }, {}, undefined));
    expect(environment).not.toHaveProperty("HTTP_PROXY");
    expect(environment).not.toHaveProperty("http_proxy");
    expect(environment).not.toHaveProperty("HTTPS_PROXY");
  });

  it("explains unsupported SOCKS and ALL_PROXY configurations", () => {
    expect(resolveNetworkProxy(automatic, {}, "SOCKS5 127.0.0.1:1080")).toMatchObject({ source: "direct", warning: expect.stringContaining("SOCKS") });
    expect(resolveNetworkProxy(automatic, { ALL_PROXY: "socks5://127.0.0.1:1080" })).toMatchObject({ source: "direct", warning: expect.stringContaining("ALL_PROXY") });
  });
});
