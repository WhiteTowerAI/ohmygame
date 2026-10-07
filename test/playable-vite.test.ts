import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer | undefined;
let cacheDirectory: string | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true });
  cacheDirectory = undefined;
});

describe("Playable sandbox development server", () => {
  it("serves an untransformed document and executable IIFE", async () => {
    // This server must not invalidate a running renderer's optimized dependencies.
    cacheDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-vite-test-"));
    server = await createServer({
      configFile: path.resolve("vite.config.ts"),
      cacheDir: cacheDirectory,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    await server.listen();
    const address = server.httpServer?.address() as AddressInfo | null;
    expect(address).not.toBeNull();
    const origin = `http://127.0.0.1:${address!.port}`;

    const [htmlResponse, scriptResponse] = await Promise.all([
      fetch(`${origin}/playable-sandbox.html`),
      fetch(`${origin}/assets/playable-sandbox.js`),
    ]);
    const [html, javascript] = await Promise.all([
      htmlResponse.text(),
      scriptResponse.text(),
    ]);

    expect(htmlResponse.ok).toBe(true);
    expect(html).toContain('sandbox-csp="true"');
    expect(html).not.toContain("/@vite/client");
    expect(scriptResponse.headers.get("content-type")).toContain(
      "text/javascript",
    );
    expect(javascript).toMatch(/^"use strict";\n\(\(\) => \{/);
    expect(javascript).not.toContain("<!doctype html>");
  });
});
