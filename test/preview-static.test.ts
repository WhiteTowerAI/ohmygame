import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startStaticPreview } from "../src/daemon/preview-static.js";

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
