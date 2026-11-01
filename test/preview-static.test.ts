import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startStaticPreview } from "../src/daemon/preview-static.js";
import { PluginIndex } from "../src/daemon/plugin-index.js";
import { PluginPageStorage } from "../src/daemon/plugin-page-storage.js";
import { startPluginUiServer } from "../src/daemon/plugin-ui-server.js";
import { pluginFrameNavigationAllowed, pluginUiRefusal, readPluginUiRequest } from "../src/shared/plugin-ui-protocol.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function directory(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), "ohmygame-static-preview-"));
  cleanups.push(() => rm(value, { recursive: true, force: true }));
  return value;
}

async function preview(root: string): Promise<string> {
  const server = await startStaticPreview(root, 0);
  cleanups.push(() => server.close());
  return server.url;
}

describe("static preview directory URLs", () => {
  it.each(["GET", "HEAD"])(
    "redirects %s to a trailing slash while preserving escaped paths and queries",
    async (method) => {
      const root = await directory();
      const nested = path.join(root, "level one");
      await mkdir(nested);
      const html = '<script type="module" src="./game.js"></script>';
      await writeFile(path.join(nested, "index.html"), html);
      await writeFile(
        path.join(nested, "game.js"),
        "export const ready = true;",
      );
      const url = `${await preview(root)}/level%20one?level=2&label=a%2Fb`;

      const redirect = await fetch(url, { method, redirect: "manual" });
      expect(redirect.status).toBe(301);
      expect(redirect.headers.get("location")).toBe(
        "/level%20one/?level=2&label=a%2Fb",
      );
      expect(redirect.headers.get("cache-control")).toBe("no-store");
      expect(await redirect.text()).toBe("");

      const response = await fetch(url, { method });
      expect(response.status).toBe(200);
      const resolvedUrl = new URL(response.url);
      expect(resolvedUrl.pathname).toBe("/level%20one/");
      expect(resolvedUrl.search).toBe("?level=2&label=a%2Fb");
      expect(await response.text()).toBe(method === "HEAD" ? "" : html);
      const script = await fetch(new URL("./game.js", resolvedUrl));
      expect(script.status).toBe(200);
      expect(await script.text()).toBe("export const ready = true;");
    },
  );

  it.each(["GET", "HEAD"])(
    "checks %s paths and resolved indexes before redirecting",
    async (method) => {
      const root = await directory();
      const outside = await directory();
      await writeFile(path.join(outside, "index.html"), "outside");
      await symlink(
        outside,
        path.join(root, "external"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const indexed = path.join(root, "index-escape");
      await mkdir(indexed);
      // Windows junctions exercise index containment without symlink privileges.
      await symlink(
        process.platform === "win32"
          ? outside
          : path.join(outside, "index.html"),
        path.join(indexed, "index.html"),
        process.platform === "win32" ? "junction" : "file",
      );
      for (const name of [".private", "node_modules"]) {
        await mkdir(path.join(root, name));
        await writeFile(path.join(root, name, "index.html"), "blocked");
      }
      const url = await preview(root);

      for (const name of [
        ".private",
        "node_modules",
        "external",
        "index-escape",
      ]) {
        const response = await fetch(`${url}/${name}`, {
          method,
          redirect: "manual",
        });
        expect(response.status).toBe(403);
        expect(response.headers.has("location")).toBe(false);
        await response.text();
      }
    },
  );

  it.each(["GET", "HEAD"])(
    "returns 404 for %s directories without an index before redirecting",
    async (method) => {
      const root = await directory();
      await writeFile(path.join(root, "index.html"), "home");
      await mkdir(path.join(root, "empty"));
      const url = await preview(root);

      const response = await fetch(`${url}/empty?level=2`, {
        method,
        headers: { accept: "text/html" },
        redirect: "manual",
      });
      expect(response.status).toBe(404);
      expect(response.headers.has("location")).toBe(false);
      expect(await response.text()).toBe(
        method === "HEAD" ? "" : "Preview file not found.",
      );
    },
  );

  it.each(["GET", "HEAD"])(
    "serves %s files, canonical directories and application routes without redirects",
    async (method) => {
      const root = await directory();
      await writeFile(path.join(root, "index.html"), "home");
      await mkdir(path.join(root, "levels"));
      await writeFile(path.join(root, "levels", "index.html"), "home");
      const url = await preview(root);

      for (const pathname of [
        "/",
        "/index.html",
        "/levels/",
        "/levels/index.html",
        "/play?level=2",
      ]) {
        const response = await fetch(`${url}${pathname}`, {
          method,
          headers: { accept: "text/html" },
          redirect: "manual",
        });
        expect(response.status).toBe(200);
        expect(response.headers.has("location")).toBe(false);
        expect(await response.text()).toBe(method === "HEAD" ? "" : "home");
      }
    },
  );
});

describe("static preview file types", () => {
  it.each([
    ["main.JS", "text/javascript", "export const ready = true;"],
    ["helper.mJs", "text/javascript", "export const value = 42;"],
    ["game.WASM", "application/wasm", "wasm fixture"],
    ["style.CsS", "text/css", "body { margin: 0; }"],
    ["lower.js", "text/javascript", "export const lower = true;"],
    ["data.UNKNOWN", "application/octet-stream", "unknown fixture"],
  ])(
    "serves %s with its media type on GET and HEAD",
    async (filename, type, contents) => {
      const root = await directory();
      await writeFile(path.join(root, filename), contents);
      const url = `${await preview(root)}/${filename}`;

      for (const method of ["GET", "HEAD"]) {
        const response = await fetch(url, { method });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(type);
        expect(response.headers.get("content-length")).toBe(
          String(Buffer.byteLength(contents)),
        );
        expect(await response.text()).toBe(method === "HEAD" ? "" : contents);
      }
    },
  );
});

describe("static preview byte ranges", () => {
  it.each([
    ["0123456789", "bytes=2-5"],
    ["0123456789", "bytes=10-"],
    ["", "bytes=0-"],
  ])("ignores Range on HEAD for %j with %s", async (contents, range) => {
    const root = await directory();
    await writeFile(path.join(root, "clip.mp4"), contents);
    const url = `${await preview(root)}/clip.mp4`;

    const response = await fetch(url, { method: "HEAD", headers: { range } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(
      String(Buffer.byteLength(contents)),
    );
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.has("content-range")).toBe(false);
    expect(await response.text()).toBe("");
  });

  it("answers byte ranges, so media can seek", async () => {
    const root = await directory();
    await writeFile(path.join(root, "clip.mp4"), "0123456789");
    const url = `${await preview(root)}/clip.mp4`;

    const whole = await fetch(url);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(whole.headers.get("content-length")).toBe("10");
    expect(await whole.text()).toBe("0123456789");

    const middle = await fetch(url, { headers: { range: "bytes=2-5" } });
    expect(middle.status).toBe(206);
    expect(middle.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(middle.headers.get("content-type")).toBe("video/mp4");
    expect(await middle.text()).toBe("2345");

    const open = await fetch(url, { headers: { range: "bytes=7-" } });
    expect(await open.text()).toBe("789");
    const suffix = await fetch(url, { headers: { range: "bytes=-3" } });
    expect(suffix.headers.get("content-range")).toBe("bytes 7-9/10");
    expect(await suffix.text()).toBe("789");
    const clamped = await fetch(url, { headers: { range: "bytes=8-99" } });
    expect(await clamped.text()).toBe("89");

    const outside = await fetch(url, { headers: { range: "bytes=10-" } });
    expect(outside.status).toBe(416);
    expect(outside.headers.get("content-range")).toBe("bytes */10");
    // Several ranges at once are not needed by media; the whole file answers them.
    const several = await fetch(url, { headers: { range: "bytes=0-1,4-5" } });
    expect(several.status).toBe(200);
    expect(await several.text()).toBe("0123456789");
  });
});

describe("plugin pages", () => {
  async function pluginPackage() {
    const root = path.join(await directory(), "panel");
    await mkdir(path.join(root, ".ohmygame-plugin"), { recursive: true });
    await mkdir(path.join(root, "ui"), { recursive: true });
    await mkdir(path.join(root, "assets"), { recursive: true });
    await mkdir(path.join(root, "native"), { recursive: true });
    await writeFile(path.join(root, "ui/panel.html"), "<p>panel</p>");
    await writeFile(path.join(root, "ui/panel.js"), "export {}");
    await writeFile(path.join(root, "assets/icon.svg"), "<svg/>");
    await writeFile(path.join(root, "native/index.mjs"), "export function activate() {}");
    await writeFile(
      path.join(root, ".ohmygame-plugin/plugin.json"),
      JSON.stringify({
        id: "acme/panel",
        version: "1.0.0",
        engines: { "ohmygame-api": "^2.0.0" },
        displayName: "Panel",
        description: "A panel.",
        icon: "./assets/icon.svg",
        entrypoints: { native: "./native/index.mjs" },
        capabilities: { native: true },
        contributes: {
          panels: [{ id: "main", title: "Main", area: "right", entry: "./ui/panel.html" }],
        },
      }),
    );
    return root;
  }

  it("serves only declared pages and assets, with a strict policy", async () => {
    const index = new PluginIndex(path.join(await directory(), "index.json"));
    const root = await pluginPackage();
    const added = await index.add(root);
    expect(added.ok ? [] : added.issues).toEqual([]);
    // The index refuses links; one added after install is still never served.
    const outside = path.join(await directory(), "secret.txt");
    await writeFile(outside, "secret");
    await symlink(outside, path.join(root, "ui/linked.txt"));
    // So is a linked folder partway along a path.
    await symlink(path.join(root, "native"), path.join(root, "ui/alias"));
    const sdk = await directory();
    await writeFile(path.join(sdk, "index.js"), "export function connect() {}");
    await writeFile(path.join(sdk, "plugin-ui.css"), ":root {}");
    const server = await startPluginUiServer({ index, sdkDirectory: sdk, frameAncestors: ["http://localhost:5173"] });
    cleanups.push(() => server.close());

    const page = server.panelUrl("acme/panel", "1.0.0", "main")!;
    expect(page).toBe(`${server.url}/acme/panel/1.0.0/ui/panel.html`);
    expect(server.panelUrl("acme/panel", "1.0.0", "other")).toBeUndefined();
    const response = await fetch(page);
    expect(await response.text()).toBe("<p>panel</p>");
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toContain(`script-src ${server.url}/acme/panel/1.0.0/ ${server.url}/_ohmygame/`);
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors http://localhost:5173");
    expect(csp).not.toContain("unsafe-eval");
    // Pages have an opaque origin, so their module scripts need CORS.
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect((await fetch(`${server.url}/acme/panel/1.0.0/ui/panel.js`)).status).toBe(200);
    expect((await fetch(`${server.url}/acme/panel/1.0.0/assets/icon.svg`)).status).toBe(200);
    expect(await (await fetch(`${server.url}/_ohmygame/plugin-ui.js`)).text()).toContain("connect");
    for (const refused of [
      "/acme/panel/1.0.0/native/index.mjs",
      "/acme/panel/1.0.0/.ohmygame-plugin/plugin.json",
      "/acme/panel/1.0.0/ui/linked.txt",
      "/acme/panel/1.0.0/ui/alias/index.mjs",
      "/acme/panel/1.0.0/ui/%2e%2e/native/index.mjs",
      "/acme/panel/2.0.0/ui/panel.html",
      "/_ohmygame/index.js",
    ])
      expect((await fetch(`${server.url}${refused}`)).status, refused).toBe(404);
  });

  it("checks what a page asks for", async () => {
    expect(readPluginUiRequest({ id: 1, method: "storage.set", params: { key: "a", value: 1 } }).ok).toBe(true);
    expect(readPluginUiRequest({ id: 2, method: "fs.read" })).toMatchObject({ ok: false, id: 2 });
    expect(readPluginUiRequest({ id: 3, method: "storage.get", params: { key: "../x" } })).toMatchObject({ ok: false, id: 3 });
    expect(readPluginUiRequest({ id: 4, method: "command.run", params: { command: "Run Now" } }).ok).toBe(false);
    expect(readPluginUiRequest({ id: 6, method: "command.run", params: { command: "rename", input: { name: "map" } } })).toMatchObject({
      ok: true,
      request: { params: { input: { name: "map" } } },
    });
    expect(readPluginUiRequest({ method: "theme.get" })).toEqual({ ok: false, error: "no id" });
    expect(readPluginUiRequest({ id: 5, method: "storage.set", params: { key: "a", value: "x".repeat(300_000) } }).ok).toBe(false);
    expect(pluginUiRefusal("composer.fill", {})).toContain("composer capability");
    expect(pluginUiRefusal("composer.fill", { composer: true })).toBeUndefined();
    expect(pluginUiRefusal("project.info", {})).toBeUndefined();
    // A frame showing a plugin page stays within that plugin version's files.
    const ui = "http://127.0.0.1:9000";
    const from = `${ui}/acme/panel/1.0.0/ui/panel.html`;
    expect(pluginFrameNavigationAllowed(from, `${ui}/acme/panel/1.0.0/ui/other.html`, ui)).toBe(true);
    expect(pluginFrameNavigationAllowed(from, `${ui}/acme/other/1.0.0/ui/panel.html`, ui)).toBe(false);
    expect(pluginFrameNavigationAllowed(from, `${ui}/acme/panel/1.0.1/ui/panel.html`, ui)).toBe(false);
    expect(pluginFrameNavigationAllowed(from, "https://example.com/?data=x", ui)).toBe(false);
    expect(pluginFrameNavigationAllowed(from, "about:blank", ui)).toBe(false);
    expect(pluginFrameNavigationAllowed("http://127.0.0.1:5173/game", "https://example.com", ui)).toBe(true);
  });

  it("keeps a page's storage per plugin and project, within its limit", async () => {
    const storagePath = await directory();
    const project = { id: "p", workspacePath: path.join(storagePath, "workspace"), storagePath };
    const storage = new PluginPageStorage();
    await storage.set(project, "acme/panel", "zoom", 2);
    expect(await storage.get(project, "acme/panel", "zoom")).toBe(2);
    expect(await storage.get(project, "acme/other", "zoom")).toBeNull();
    await expect(storage.set(project, "acme/panel", "big", "x".repeat(1024 * 1024))).rejects.toThrow("at most");
    expect(await storage.get(project, "acme/panel", "zoom")).toBe(2);
    await storage.set(project, "acme/panel", "zoom", null);
    expect(await storage.get(project, "acme/panel", "zoom")).toBeNull();
  });
});
