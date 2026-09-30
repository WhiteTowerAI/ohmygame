import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { ProjectState } from "../shared/contracts.js";

/** Drafts kept at once; the oldest is removed when an agent opens another. */
const MAX_DRAFTS = 4;

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
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/**
 * Serves Playable drafts to agent playtests. Each draft is a Published Player
 * build of the project's current sources, served on loopback under an
 * unguessable path: the playtest window cannot send the daemon's access
 * token, so the path is its only credential.
 */
export class PlayableDraftServer {
  readonly #drafts = new Map<string, string>();
  #server: Promise<{ server: Server; port: number }> | undefined;

  constructor(private readonly prepare: (project: ProjectState) => Promise<string>) {}

  /** Builds the project's draft and returns the URL of its Player. */
  async open(project: ProjectState): Promise<string> {
    const directory = await this.prepare(project);
    const token = randomBytes(24).toString("base64url");
    this.#drafts.set(token, directory);
    for (const [oldToken, oldDirectory] of [...this.#drafts].slice(0, -MAX_DRAFTS)) {
      this.#drafts.delete(oldToken);
      await rm(oldDirectory, { recursive: true, force: true });
    }
    const { port } = await this.#listen();
    return `http://127.0.0.1:${port}/${token}/index.html`;
  }

  async close(): Promise<void> {
    const listening = this.#server;
    this.#server = undefined;
    const directories = [...this.#drafts.values()];
    this.#drafts.clear();
    if (listening) {
      const { server } = await listening.catch(() => ({ server: undefined }));
      server?.closeAllConnections();
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
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
    const [, token = "", ...segments] = pathname.split("/");
    const directory = this.#drafts.get(token);
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
