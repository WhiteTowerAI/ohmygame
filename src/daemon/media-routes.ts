import { isUtf8 } from "node:buffer";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { MediaAsset, LibrarySourceSearchRequest, LibraryUploadMediaType } from "../shared/contracts.js";
import { AssetSourceError, type LibrarySources, type SourceItemToAdd } from "./library-sources.js";
import { ASSET_SOURCE_MEDIA } from "../shared/plugin-manifest.js";
import { MEDIA_CONTENT_TYPES } from "../shared/media-files.js";
import { sniffImageType } from "./image-format.js";
import { ProjectAssetError, type ProjectManager } from "./projects.js";
import { getWorkspaceMedia, workspaceMediaInfo, WorkspaceError } from "./workspace.js";

/** The request body that renames an asset in a project. */
export const ASSET_NAME_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: { name: { type: "string", minLength: 1, maxLength: 200 } },
} as const;

/** Media added to a project from this computer, and plugins' asset sources. */
export function registerMediaRoutes(app: FastifyInstance, { projects, sources, addFromSource }: {
  projects: ProjectManager;
  sources: LibrarySources;
  /** Downloads a source's result into a project's media, with its credit. */
  addFromSource: (projectId: string, source: string, item: SourceItemToAdd, signal: AbortSignal) => Promise<{ path: string; name: string }>;
}): void {
  app.post<{ Params: { projectId: string }; Querystring: { name: string; mediaType: string }; Body: Buffer }>("/projects/:projectId/media", {
    schema: {
      querystring: {
        type: "object",
        additionalProperties: false,
        required: ["name", "mediaType"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200 },
          mediaType: { type: "string", enum: [...MEDIA_CONTENT_TYPES] },
        },
      },
    },
  }, async (request, reply) => {
    if (!projects.get(request.params.projectId)) return reply.code(404).send({ error: "Project not found" });
    const contents = request.body;
    if (!Buffer.isBuffer(contents) || contents.length === 0) return reply.code(400).send({ error: "File is empty" });
    const file = readMediaFile(request.query.name, contents, request.query.mediaType as LibraryUploadMediaType);
    if (!file.ok) return reply.code(400).send({ error: file.error });
    try {
      return reply.code(201).send({ path: await projects.addMedia(request.params.projectId, file.name, { bytes: contents }) });
    } catch (cause) {
      return reply.code(cause instanceof ProjectAssetError ? cause.statusCode : 500).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  });

  app.post<{ Params: { projectId: string }; Body: { projectId: string; path: string } }>("/projects/:projectId/media/copy", {
    schema: { body: { type: "object", additionalProperties: false, required: ["projectId", "path"], properties: { projectId: { type: "string", minLength: 1, maxLength: 200 }, path: { type: "string", minLength: 1, maxLength: 1000 } } } },
  }, async (request, reply) => {
    const from = projects.get(request.body.projectId);
    if (!projects.get(request.params.projectId) || !from) return reply.code(404).send({ error: "Project not found" });
    try {
      const media = await getWorkspaceMedia(from.workspacePath, request.body.path);
      return reply.code(201).send({ path: await projects.addMedia(request.params.projectId, path.basename(media.relativePath), { file: media.absolutePath }) });
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      if (cause instanceof WorkspaceError) return reply.code(cause.code === "ENOENT" ? 404 : 400).send({ error });
      return reply.code(cause instanceof ProjectAssetError ? cause.statusCode : 500).send({ error });
    }
  });

  // Plugins' sources, shown as tabs in a project's Assets: their searches, and adding a result to the project.
  app.get<{ Querystring: { locale?: string } }>("/asset-sources", async (request) => (
    sources.list(request.query.locale === "zh-CN" ? "zh-CN" : "en")
  ));

  app.post<{ Body: LibrarySourceSearchRequest }>("/asset-sources/search", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["source", "query"],
        properties: {
          source: { type: "string", minLength: 1, maxLength: 300 },
          query: { type: "string", maxLength: 200 },
          media: { enum: [...ASSET_SOURCE_MEDIA] },
          cursor: { type: "string", minLength: 1, maxLength: 2000 },
          collection: { type: "string", minLength: 1, maxLength: 64 },
        },
      },
    },
  }, async (request, reply) => sourceCall(reply, (signal) => sources.search(request.body, signal)));

  app.post<{ Params: { projectId: string }; Body: { source: string; id: string; mediaType: MediaAsset["mediaType"]; author?: string; license?: string; url?: string } }>("/projects/:projectId/assets/source", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["source", "id", "mediaType"],
        properties: {
          source: { type: "string", minLength: 1, maxLength: 300 },
          id: { type: "string", minLength: 1, maxLength: 500 },
          mediaType: { enum: [...ASSET_SOURCE_MEDIA] },
          // The credit the result showed, kept when the source's fetch gives none.
          author: { type: "string", minLength: 1, maxLength: 200 },
          license: { type: "string", minLength: 1, maxLength: 200 },
          url: { type: "string", pattern: "^https://", maxLength: 2000 },
        },
      },
    },
  }, async (request, reply) => {
    if (!projects.get(request.params.projectId)) return reply.code(404).send({ error: "Project not found" });
    const { source, ...item } = request.body;
    return sourceCall(reply, (signal) => addFromSource(request.params.projectId, source, item, signal), 201);
  });
}

/** Runs a source's call, stopping it when the page goes away first. */
async function sourceCall<T>(reply: FastifyReply, call: (signal: AbortSignal) => Promise<T>, statusCode = 200) {
  const controller = new AbortController();
  const stop = () => { if (!reply.raw.writableFinished) controller.abort(); };
  reply.raw.once("close", stop);
  try {
    return reply.code(statusCode).send(await call(controller.signal));
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    const code = cause instanceof AssetSourceError ? cause.statusCode : 500;
    return reply.code(code).send({ error });
  } finally {
    reply.raw.off("close", stop);
  }
}

/**
 * A media file by its name, and its data: the type its name says,
 * or `mediaType` when the caller says which it is. The name loses any folders.
 */
export function readMediaFile(fileName: string, contents: Buffer, mediaType?: LibraryUploadMediaType):
  { ok: true; name: string; contentType: LibraryUploadMediaType } | { ok: false; error: string } {
  const name = path.basename(fileName.trim());
  const contentType = name ? workspaceMediaInfo(name)?.contentType : undefined;
  if (!contentType || (mediaType && contentType !== mediaType))
    return { ok: false, error: mediaType ? "File name does not match its media type" : "Add images, audio, video or 3D models, named with their type, such as ricochet.png" };
  if (!isMediaOfType(contents, contentType)) return { ok: false, error: mediaType ? "File data does not match its media type" : `The file's data isn't the ${contentType} its name says` };
  return { ok: true, name, contentType };
}

/** Whether a file's data, or its first 64 KB, is the media type it claims. */
export function isMediaOfType(value: Buffer, mediaType: LibraryUploadMediaType): boolean {
  if (mediaType === "image/png" || mediaType === "image/jpeg" || mediaType === "image/webp") return sniffImageType(value) === mediaType;
  if (mediaType === "image/svg+xml") {
    if (!isUtf8(value)) return false;
    const start = value.subarray(0, 64 * 1024).toString("utf8").replace(/^\uFEFF/, "");
    return /^(?:\s|<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!doctype\s+svg(?:\s[^>]*)?>)*<svg(?:\s|\/?>)/i.test(start);
  }
  if (mediaType === "audio/wav") {
    return value.length >= 12 && value.subarray(0, 4).toString("ascii") === "RIFF" && value.subarray(8, 12).toString("ascii") === "WAVE";
  }
  if (mediaType === "audio/mpeg") {
    return value.length >= 3 && (value.subarray(0, 3).toString("ascii") === "ID3" || (value[0] === 0xff && (value[1]! & 0xe0) === 0xe0));
  }
  if (mediaType === "video/webm") {
    return value.length >= 4 && value[0] === 0x1a && value[1] === 0x45 && value[2] === 0xdf && value[3] === 0xa3;
  }
  if (mediaType === "image/gif") return /^GIF8[79]a$/.test(value.subarray(0, 6).toString("ascii"));
  if (mediaType === "audio/ogg") return value.subarray(0, 4).toString("ascii") === "OggS";
  if (mediaType === "model/gltf-binary") return value.length >= 12 && value.subarray(0, 4).toString("ascii") === "glTF" && value.readUInt32LE(4) === 2;
  if (value.length < 8 || value.subarray(4, 8).toString("ascii") !== "ftyp") return false;
  // The ftyp box holds a major brand, a version, then compatible brands; AVIF images carry avif or avis.
  const boxEnd = Math.min(value.readUInt32BE(0), value.length);
  const brands = new Set([value.subarray(8, 12).toString("ascii")]);
  for (let offset = 16; offset + 4 <= boxEnd; offset += 4) brands.add(value.subarray(offset, offset + 4).toString("ascii"));
  const avif = brands.has("avif") || brands.has("avis");
  return mediaType === "image/avif" ? avif : !avif;
}
