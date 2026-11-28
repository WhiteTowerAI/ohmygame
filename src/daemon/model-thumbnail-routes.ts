import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { sniffImageType } from "./image-format.js";
import type { ProjectManager } from "./projects.js";
import { getWorkspaceMedia, WorkspaceError } from "./workspace.js";

const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_ENTRIES = 256;
type Query = {
  project?: string;
  path?: string;
  size: "small" | "large";
  version?: string;
};

/** Disposable rendered frames. The project preview may be the artist's input image. */
export function registerModelThumbnailRoutes(
  app: FastifyInstance,
  directory: string,
  projects: ProjectManager,
) {
  let writes = Promise.resolve();
  async function version(query: Query) {
    let source: string[];
    if (query.project && query.path) {
      const project = projects.get(query.project);
      if (!project) throw new WorkspaceError("Project not found", "ENOENT");
      const file = await getWorkspaceMedia(project.workspacePath, query.path);
      if (file.mediaType !== "model")
        throw new WorkspaceError("Expected a 3D model");
      const info = await stat(file.absolutePath, { bigint: true });
      source = [
        project.id,
        file.absolutePath,
        String(info.size),
        String(info.mtimeNs),
        String(info.ctimeNs),
        String(info.ino),
      ];
    } else throw new WorkspaceError("Expected one model source");
    return createHash("sha256").update(JSON.stringify(source)).digest("hex");
  }

  app.route<{ Querystring: Query; Body: Buffer }>({
    method: ["GET", "PUT"],
    url: "/model-thumbnails",
    bodyLimit: MAX_IMAGE_BYTES,
    schema: {
      querystring: {
        type: "object",
        required: ["size"],
        properties: {
          project: { type: "string" },
          path: { type: "string" },
          size: { enum: ["small", "large"] },
          version: { type: "string", pattern: "^[a-f0-9]{64}$" },
        },
      },
    },
    async handler(request, reply) {
      reply.header("cache-control", "no-store");
      const query = request.query;
      try {
        const current = await version(query);
        const file = (size: string) =>
          path.join(directory, current + "-" + size + ".png");
        if (request.method === "GET") {
          for (const size of query.size === "small"
            ? ["large", "small"]
            : ["large"]) {
            try {
              const png = await readFile(file(size));
              return reply
                .type("image/png")
                .header("access-control-expose-headers", "etag")
                .header("etag", '"' + current + '"')
                .send(png);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
          }
          return { version: current };
        }
        if (query.version !== current)
          return reply.code(409).send({ error: "Model has changed" });
        const image = request.body;
        if (
          !Buffer.isBuffer(image) ||
          image.length < 33 ||
          sniffImageType(image) !== "image/png" ||
          image.toString("ascii", 12, 16) !== "IHDR" ||
          [image.readUInt32BE(16), image.readUInt32BE(20)].some(
            (side) => side < 1 || side > 4096,
          )
        ) {
          return reply.code(400).send({ error: "Expected a PNG thumbnail" });
        }
        const save = writes.then(async () => {
          await mkdir(directory, { recursive: true });
          // Versioned destinations keep even a late write from replacing a newer frame.
          const destination = file(query.size);
          const temporary = destination + "." + randomUUID() + ".tmp";
          try {
            await writeFile(temporary, image, { flag: "wx" });
            await rename(temporary, destination);
          } finally {
            await rm(temporary, { force: true });
          }
          const files = (await readdir(directory)).filter((name) =>
            name.endsWith(".png"),
          );
          if (files.length > MAX_ENTRIES) {
            const entries = await Promise.all(
              files.map(async (name) => ({
                name,
                time: (await stat(path.join(directory, name))).mtimeMs,
              })),
            );
            entries.sort((a, b) => a.time - b.time);
            await Promise.all(
              entries
                .slice(0, entries.length - MAX_ENTRIES)
                .map((entry) =>
                  rm(path.join(directory, entry.name), { force: true }),
                ),
            );
          }
        });
        writes = save.catch(() => {});
        await save;
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof WorkspaceError) {
          const status = error.code === "ENOENT" ? 404 : 400;
          return reply.code(status).send({ error: error.message });
        }
        throw error;
      }
    },
  });
}
