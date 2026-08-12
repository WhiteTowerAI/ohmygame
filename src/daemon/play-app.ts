import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { deploymentFilesPath, isDeploymentId } from "./deployments.js";

export function createPlayApp(options: { dataDirectory: string; logger?: boolean }) {
  const app = Fastify({ logger: options.logger ?? false });
  app.get<{ Params: { "*": string } }>("/*", async (request, reply) => {
    const deploymentId = deploymentIdFromHostname(request.hostname);
    const root = deploymentId ? deploymentFilesPath(options.dataDirectory, deploymentId) : undefined;
    if (!root) return reply.code(404).send({ error: "Game not found" });
    const requested = request.params["*"] || "index.html";
    let file = safeFile(root, requested);
    if (!file) return reply.code(404).send({ error: "File not found" });
    if (!await isFile(file) && !path.extname(requested)) file = path.join(root, "index.html");
    if (!await isFile(file)) return reply.code(404).send({ error: "File not found" });
    reply.header("content-type", contentType(file));
    reply.header("x-content-type-options", "nosniff");
    reply.header("cache-control", path.basename(file) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable");
    return reply.send(await readFile(file));
  });
  return app;
}

function deploymentIdFromHostname(hostname: string): string | undefined {
  const candidate = hostname.split(".")[0];
  return isDeploymentId(candidate) ? candidate : undefined;
}

function safeFile(root: string, requested: string): string | undefined {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, requested);
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`) ? resolved : undefined;
}

async function isFile(target: string): Promise<boolean> {
  try {
    await access(target);
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

function contentType(file: string): string {
  const extension = path.extname(file).toLowerCase();
  return ({
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".wasm": "application/wasm",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}
