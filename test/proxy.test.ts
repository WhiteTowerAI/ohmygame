import { describe, expect, it } from "vitest";
import { proxyOptionsFromEnvironment } from "../src/daemon/proxy.js";

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
});
