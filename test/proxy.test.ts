import { describe, expect, it } from "vitest";
import { configureNetworkProxy, proxyOptionsFromEnvironment } from "../src/daemon/proxy.js";
import { applySystemProxy, proxyUrlFromElectron } from "../src/desktop/system-proxy.js";

describe("proxyOptionsFromEnvironment", () => {
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

  it("adds http:// scheme when proxy URL is missing a protocol", () => {
    expect(proxyOptionsFromEnvironment({
      HTTP_PROXY: "127.0.0.1:3067",
      HTTPS_PROXY: "127.0.0.1:3067",
    })).toEqual({
      httpProxy: "http://127.0.0.1:3067",
      httpsProxy: "http://127.0.0.1:3067",
      noProxy: "127.0.0.1,localhost,.localhost",
    });
  });

  it("preserves https:// scheme when already present", () => {
    expect(proxyOptionsFromEnvironment({
      HTTP_PROXY: "https://proxy.example:8443",
    })).toMatchObject({
      httpProxy: "https://proxy.example:8443",
    });
  });
});

describe("configureNetworkProxy", () => {
  it("returns false and does not throw for an unparseable proxy URL", () => {
    // After normalizeProxyUrl prepends http://, the value still contains
    // characters that make EnvHttpProxyAgent reject it during construction.
    expect(() => configureNetworkProxy({
      HTTP_PROXY: "http://[invalid",
      HTTPS_PROXY: "http://[invalid",
    })).not.toThrow();
    expect(configureNetworkProxy({
      HTTP_PROXY: "http://[invalid",
      HTTPS_PROXY: "http://[invalid",
    })).toBe(false);
  });

  it("returns true and configures dispatcher for a valid proxy", () => {
    expect(configureNetworkProxy({
      HTTP_PROXY: "http://127.0.0.1:7890",
      HTTPS_PROXY: "http://127.0.0.1:7890",
    })).toBe(true);
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
