import { describe, expect, it, vi } from "vitest";
import { fetchWebPage, pageText } from "../src/daemon/web-fetch.js";

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
});
