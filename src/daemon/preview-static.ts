import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".glb": "model/gltf-binary",
};

export async function startStaticPreview(
  directory: string,
  port: number,
): Promise<{ url: string; close(): Promise<void> }> {
  const root = await realpath(directory);
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      if (incoming.method !== "GET" && incoming.method !== "HEAD") {
        outgoing.writeHead(405).end();
        return;
      }
      const requestUrl = new URL(incoming.url ?? "/", "http://localhost");
      const pathname = decodeURIComponent(requestUrl.pathname);
      const parts = pathname.split("/");
      if (
        parts.some((part) => part.startsWith(".") || part === "node_modules")
      ) {
        outgoing.writeHead(403).end();
        return;
      }
      let filename = path.join(root, pathname);
      let redirectDirectory = false;
      try {
        if ((await stat(filename)).isDirectory()) {
          redirectDirectory = !requestUrl.pathname.endsWith("/");
          filename = path.join(filename, "index.html");
        }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        if (
          !path.extname(pathname) &&
          incoming.headers.accept?.includes("text/html")
        )
          filename = path.join(root, "index.html");
      }
      filename = await realpath(filename);
      const relative = path.relative(root, filename);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        outgoing.writeHead(403).end();
        return;
      }
      if (redirectDirectory) {
        outgoing
          .writeHead(301, {
            location: `${requestUrl.pathname}/${requestUrl.search}`,
            "cache-control": "no-store",
          })
          .end();
        return;
      }
      // Media can only seek when the server answers byte ranges.
      const { size } = await stat(filename);
      const range =
        incoming.method === "GET"
          ? byteRange(incoming.headers.range, size)
          : undefined;
      if (range === "unsatisfiable") {
        outgoing.writeHead(416, { "content-range": `bytes */${size}` }).end();
        return;
      }
      outgoing.writeHead(range ? 206 : 200, {
        "content-type":
          MIME[path.extname(filename).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-store",
        "accept-ranges": "bytes",
        "content-length": String(range ? range.end - range.start + 1 : size),
        ...(range ? { "content-range": `bytes ${range.start}-${range.end}/${size}` } : {}),
      });
      if (incoming.method === "HEAD") {
        outgoing.end();
        return;
      }
      const stream = createReadStream(filename, range ?? {});
      stream.on("error", () => outgoing.destroy());
      outgoing.once("close", () => stream.destroy());
      stream.pipe(outgoing);
    })().catch((cause) => {
      if (!outgoing.headersSent)
        outgoing.writeHead(cause instanceof URIError ? 400 : 404);
      outgoing.end("Preview file not found.");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  server.on("error", () => {});
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** One `bytes=` range of a file, as browsers ask for media; anything else gets the whole file. */
function byteRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | undefined {
  const match = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}
