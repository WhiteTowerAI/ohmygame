import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/**
 * Serves local directories read-only on loopback, each under an unguessable
 * path. Windows and iframes that load these pages cannot send the daemon's
 * access token, so the path is their only credential.
 */
export class LoopbackFileServer {
  readonly #mounts = new Map<string, string>();
  #server: Promise<{ server: Server; port: number }> | undefined;

  /** Serves `directory` and returns the URL of its root, ending in a slash. */
  async mount(directory: string): Promise<{ token: string; url: string }> {
    const token = randomBytes(24).toString("base64url");
    this.#mounts.set(token, directory);
    const { port } = await this.#listen();
    return { token, url: `http://127.0.0.1:${port}/${token}/` };
  }

  unmount(token: string): void {
    this.#mounts.delete(token);
  }

  async close(): Promise<void> {
    const listening = this.#server;
    this.#server = undefined;
    this.#mounts.clear();
    if (!listening) return;
    const { server } = await listening.catch(() => ({ server: undefined }));
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
  }

  #listen(): Promise<{ server: Server; port: number }> {
    this.#server ??= new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.#serve(request.method ?? "GET", request.url ?? "/").then(({ status, type, body }) => {
          response.writeHead(status, {
            "content-type": type,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          response.end(request.method === "HEAD" ? undefined : body);
        });
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
    });
    return this.#server;
  }

  async #serve(method: string, url: string): Promise<{ status: number; type: string; body: Buffer | string }> {
    const notFound = { status: 404, type: "text/plain; charset=utf-8", body: "Not found" };
    if (method !== "GET" && method !== "HEAD") return { status: 405, type: "text/plain; charset=utf-8", body: "Method not allowed" };
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(url, "http://127.0.0.1").pathname);
    } catch {
      return notFound;
    }
    const [, token = "", ...rest] = pathname.split("/");
    const directory = this.#mounts.get(token);
    // A directory URL (".../") serves its index.html.
    const segments = rest.length && rest[rest.length - 1] === "" ? [...rest.slice(0, -1), "index.html"] : rest;
    if (!directory || !segments.length || segments.some((segment) => !segment || segment === "." || segment === "..")) return notFound;
    const file = path.join(directory, ...segments);
    if (path.relative(directory, file).startsWith("..")) return notFound;
    try {
      const body = await readFile(file);
      return { status: 200, type: CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", body };
    } catch {
      return notFound;
    }
  }
}
