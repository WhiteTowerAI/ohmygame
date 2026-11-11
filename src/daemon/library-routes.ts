import { isUtf8 } from "node:buffer";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { CreateLibraryImageRequest, LibraryUploadMediaType } from "../shared/contracts.js";
import { MEDIA_CONTENT_TYPES } from "../shared/media-files.js";
import { AssetLibraryError, isLibraryAssetDerivation, type AssetLibrary } from "./asset-library.js";
import { sniffImageType } from "./image-format.js";
import { ProjectLibraryReferenceError, type ProjectManager } from "./projects.js";
import { workspaceMediaInfo } from "./workspace.js";

const MAX_LIBRARY_IMAGE_BYTES = 10 * 1024 * 1024;

/** The request body that renames an asset, in the Library or in a project. */
export const ASSET_NAME_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: { name: { type: "string", minLength: 1, maxLength: 200 } },
} as const;

/**
 * The Library and the store behind it. The store keeps every shared media file;
 * the Library shows the `saved` ones: uploaded on its page, saved from a project,
 * or recorded from a game. Other uploads are stored for the project that made them.
 */
export function registerLibraryRoutes(app: FastifyInstance, { projects, library }: { projects: ProjectManager; library: AssetLibrary }): void {
  app.get("/library/assets", async (request) => {
    const associations = await projects.libraryAssetAssociations((project, cause) => request.log.warn({ projectId: project.id, err: cause }, "Could not read Library asset usage"));
    return library.list().map((asset) => ({
      ...asset,
      projects: associations.get(asset.id)?.projects ?? [],
      referenceOnly: asset.purpose === "reference" && !associations.get(asset.id)?.hasAssetUsage,
    }));
  });

  app.post<{ Body: CreateLibraryImageRequest }>("/library/assets", {
    bodyLimit: 15 * 1024 * 1024,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["name", "image"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200 },
          purpose: { enum: ["asset", "reference"] },
          image: {
            type: "object",
            additionalProperties: false,
            required: ["mediaType", "data"],
            properties: {
              mediaType: { enum: ["image/png", "image/jpeg", "image/webp"] },
              data: { type: "string", minLength: 1 },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    if (!validBase64(request.body.image.data)) return reply.code(400).send({ error: "Image data is invalid" });
    const contents = Buffer.from(request.body.image.data, "base64");
    if (contents.length === 0 || contents.length > MAX_LIBRARY_IMAGE_BYTES) {
      return reply.code(400).send({ error: "Image must be no larger than 10 MB" });
    }
    if (!isImageOfType(contents, request.body.image.mediaType)) {
      return reply.code(400).send({ error: "Image data does not match its media type" });
    }
    try {
      const extension = request.body.image.mediaType === "image/png" ? ".png"
        : request.body.image.mediaType === "image/jpeg" ? ".jpg"
          : ".webp";
      const name = `${path.parse(path.basename(request.body.name)).name || "image"}${extension}`;
      return reply.code(201).send(await library.add(name, contents, { origin: "uploaded", purpose: request.body.purpose }));
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      return reply.code(cause instanceof AssetLibraryError ? cause.statusCode : 500).send({ error });
    }
  });

  app.post<{ Querystring: { name: string; mediaType: string; duration?: string; purpose?: "asset" | "reference"; saved?: "true"; trimSource?: string; trimStart?: string; trimEnd?: string }; Body: Buffer }>("/library/assets/upload", {
    schema: {
      querystring: {
        type: "object",
        additionalProperties: false,
        required: ["name", "mediaType"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200 },
          mediaType: { type: "string", enum: [...MEDIA_CONTENT_TYPES] },
          duration: { type: "string", pattern: "^(?:0|[1-9]\\d*)(?:\\.\\d+)?$" },
          purpose: { enum: ["asset", "reference"] },
          saved: { type: "string", enum: ["true"] },
          trimSource: { type: "string", minLength: 1, maxLength: 200 },
          trimStart: { type: "string", pattern: "^(?:0|[1-9]\\d*)(?:\\.\\d+)?$" },
          trimEnd: { type: "string", pattern: "^(?:0|[1-9]\\d*)(?:\\.\\d+)?$" },
        },
      },
    },
  }, async (request, reply) => {
    const mediaType = request.query.mediaType as LibraryUploadMediaType;
    const contents = request.body;
    if (!Buffer.isBuffer(contents) || contents.length === 0) return reply.code(400).send({ error: "File is empty" });
    const name = path.basename(request.query.name);
    if (!name || workspaceMediaInfo(name)?.contentType !== mediaType) {
      return reply.code(400).send({ error: "File name does not match its media type" });
    }
    if (!isLibraryMediaOfType(contents, mediaType)) {
      return reply.code(400).send({ error: "File data does not match its media type" });
    }
    const duration = request.query.duration === undefined ? undefined : Number(request.query.duration);
    if (duration !== undefined && (!Number.isFinite(duration) || duration < 0 || mediaType.startsWith("image/"))) {
      return reply.code(400).send({ error: "Invalid media duration" });
    }
    // A video cut from another records where it came from: all three fields, or none.
    const { trimSource, trimStart, trimEnd } = request.query;
    const derivedFrom = trimSource === undefined && trimStart === undefined && trimEnd === undefined
      ? undefined
      : { assetId: trimSource ?? "", trim: { start: Number(trimStart), end: Number(trimEnd) } };
    if (derivedFrom && (!mediaType.startsWith("video/") && !mediaType.startsWith("audio/") || !isLibraryAssetDerivation(derivedFrom) || !library.get(derivedFrom.assetId))) {
      return reply.code(400).send({ error: "Invalid trim source" });
    }
    try {
      return reply.code(201).send(await library.add(name, contents, { origin: "uploaded", purpose: request.query.purpose, saved: request.query.saved === "true", ...(duration !== undefined ? { duration } : {}), ...(derivedFrom ? { derivedFrom } : {}) }));
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      return reply.code(cause instanceof AssetLibraryError ? cause.statusCode : 500).send({ error });
    }
  });

  app.get<{ Params: { assetId: string } }>("/library/assets/:assetId/content", async (request, reply) => {
    try {
      const { asset, absolutePath } = await library.content(request.params.assetId);
      return reply.type(asset.contentType)
        .header("content-length", asset.size)
        .header("cache-control", "private, max-age=31536000, immutable")
        .header("x-content-type-options", "nosniff")
        .send(createReadStream(absolutePath));
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      return reply.code(cause instanceof AssetLibraryError ? cause.statusCode : 500).send({ error });
    }
  });

  app.patch<{ Params: { assetId: string }; Body: { name: string } }>(
    "/library/assets/:assetId",
    { schema: { body: ASSET_NAME_BODY_SCHEMA } },
    async (request, reply) => {
      try {
        return await library.rename(request.params.assetId, request.body.name);
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        return reply.code(cause instanceof AssetLibraryError ? cause.statusCode : 500).send({ error });
      }
    },
  );

  // Removing from the Library never touches a project: what one uses stays stored for it, and only
  // what nothing uses is deleted. When usage can't be read, it is treated as used.
  app.delete<{ Params: { assetId: string } }>("/library/assets/:assetId", async (request, reply) => {
    const id = request.params.assetId;
    try {
      if (!library.get(id)) return reply.code(404).send({ error: "Library asset not found" });
      const used = await projects.referencesLibraryAsset(id).then((references) => references.length > 0, (cause: unknown) => {
        if (!(cause instanceof ProjectLibraryReferenceError)) throw cause;
        request.log.warn({ assetId: id, err: cause }, "Could not read Library asset usage; keeping its file");
        return true;
      });
      if (used) await library.unsave(id);
      else await library.delete(id);
      return reply.code(204).send();
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      return reply.code(cause instanceof AssetLibraryError ? cause.statusCode : 500).send({ error });
    }
  });
}

function isImageOfType(value: Buffer, mediaType: CreateLibraryImageRequest["image"]["mediaType"]): boolean {
  return sniffImageType(value) === mediaType;
}

function isLibraryMediaOfType(value: Buffer, mediaType: LibraryUploadMediaType): boolean {
  if (mediaType === "image/png" || mediaType === "image/jpeg" || mediaType === "image/webp") return isImageOfType(value, mediaType);
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

function validBase64(value: string): boolean {
  return value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}
