import { describe, expect, it, vi } from "vitest";
import { createPinnedLookup, fetchWebPage, pageText, usesConfiguredProxy } from "../src/daemon/web-fetch.js";

describe("reading web pages", () => {
  it("extracts article text, entities and links without scripts or navigation", () => {
    const result = pageText(
      '<title>A &amp; B</title><nav>Menu</nav><main><h1>Guide</h1><p>Use <a href="/docs">the docs</a>.</p><script>throw new Error("no")</script><div hidden>Secret</div><p>Next &lt; step</main>',
      "https://example.com/start",
    );
    expect(result.title).toBe("A & B");
    expect(result.text).toBe(
      "Guide\n\nUse the docs (https://example.com/docs).\n\nNext < step",
    );
  });

  it("follows relative redirects, reports the final URL and bounds text", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "/docs" } }),
      )
      .mockResolvedValueOnce(
        new Response("x".repeat(1_200), {
          headers: { "content-type": "text/plain" },
        }),
      );
    const result = await fetchWebPage(
      "https://example.com/start",
      1_000,
      undefined,
      request,
    );
    expect(result).toMatchObject({
      url: "https://example.com/docs",
      text: "x".repeat(1_000),
      truncated: true,
    });
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      redirect: "manual",
      credentials: "omit",
    });
  });

  it.each([
    "file:///etc/passwd",
    "https://user:password@example.com/",
    "data:text/html,test",
  ])("refuses redirect to %s", async (location) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location } }),
      );
    await expect(
      fetchWebPage("https://example.com", 1_000, undefined, request),
    ).rejects.toThrow("without credentials");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("bounds redirects, rejects binary downloads and checks streamed size", async () => {
    const redirect = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () =>
          new Response(null, { status: 302, headers: { location: "/loop" } }),
      );
    await expect(
      fetchWebPage("https://example.com", 1_000, undefined, redirect),
    ).rejects.toThrow("5 times");
    expect(redirect).toHaveBeenCalledTimes(6);
    const binary = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("data", {
        headers: { "content-type": "application/pdf" },
      }),
    );
    await expect(
      fetchWebPage("https://example.com", 1_000, undefined, binary),
    ).rejects.toThrow("application/pdf");
    const large = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array(2 * 1024 * 1024 + 1), {
        headers: { "content-type": "text/plain" },
      }),
    );
    await expect(
      fetchWebPage("https://example.com", 1_000, undefined, large),
    ).rejects.toThrow("2 MiB");
  });

  it("does not request a page after cancellation", async () => {
    const request = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchWebPage("https://example.com", 1_000, controller.signal, request),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
  });

  it("blocks private, loopback, metadata, DNS-rebound, and redirect SSRF targets", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response("ok", { headers: { "content-type": "text/plain" } }));
    for (const url of [
      "http://localhost/secret",
      "http://api.internal/meta",
      "http://127.0.0.1:8080/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]:8080/",
      "http://[::ffff:7f00:1]/",
    ]) {
      await expect(fetchWebPage(url, 1_000, undefined, request)).rejects.toThrow("private or internal");
    }
    expect(request).not.toHaveBeenCalled();

    await expect(
      fetchWebPage("https://rebind.example/", 1_000, undefined, request, async () => [{ address: "10.0.0.5" }]),
    ).rejects.toThrow("private or internal");

    const redirect = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/meta" } }),
    );
    await expect(
      fetchWebPage("https://public.example/", 1_000, undefined, redirect, async () => [{ address: "93.184.216.34" }]),
    ).rejects.toThrow("private or internal");

    const pinned = createPinnedLookup(new Map([["public.example", [{ address: "93.184.216.34", family: 4 }]]]));
    const resolved = await new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) =>
      pinned("public.example", { family: 4 }, (err, address, family) => resolve({ err, address, family })),
    );
    expect(resolved).toEqual({ err: null, address: "93.184.216.34", family: 4 });
    const unverified = await new Promise<Error | null>((resolve) =>
      pinned("rebound.example", {}, (err) => resolve(err)),
    );
    expect(unverified?.message).toContain("unverified");
  });

  it("matches Undici EnvHttpProxyAgent proxy and NO_PROXY rules", () => {
    expect(usesConfiguredProxy(new URL("https://example.com/"), { HTTPS_PROXY: "http://127.0.0.1:7890" })).toBe(true);
    expect(usesConfiguredProxy(new URL("https://example.com/"), { HTTPS_PROXY: "http://127.0.0.1:7890", https_proxy: "" })).toBe(false);
    expect(usesConfiguredProxy(new URL("https://example.com/"), { HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "*" })).toBe(false);
    expect(usesConfiguredProxy(new URL("https://example.com/"), { HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "other.test", no_proxy: "" })).toBe(true);
    expect(usesConfiguredProxy(new URL("https://example.com/"), { HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "*.example.com" })).toBe(false);
    expect(usesConfiguredProxy(new URL("https://sub.example.com/"), { HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: ".example.com" })).toBe(false);
    expect(usesConfiguredProxy(new URL("https://example.com:443/"), { HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "example.com:443" })).toBe(false);
    expect(usesConfiguredProxy(new URL("https://sub.example.com/"), { HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "other.test sub.example.com:443" })).toBe(false);
    expect(usesConfiguredProxy(new URL("https://sub.example.com:8443/"), { HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "sub.example.com:443" })).toBe(true);
    expect(usesConfiguredProxy(new URL("http://[2001:db8::1]:8080/"), { HTTP_PROXY: "http://127.0.0.1:7890", NO_PROXY: "[2001:db8::1]:8080" })).toBe(false);
  });
});
