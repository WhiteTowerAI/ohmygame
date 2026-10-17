import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  PLUGIN_ICON_MAX_BYTES,
  PLUGIN_ICON_MAX_DIMENSION,
} from "../shared/plugin-icons.js";
import { isPluginIcon, type PluginIcon } from "../shared/plugins.js";
import { sniffImageType } from "./image-format.js";

// Cache successful decodes by content. Reads still check paths and current bytes.
const validatedIcons = new Set<string>();
const VALIDATED_ICON_CACHE_LIMIT = 128;

export async function validatePluginIconImage(
  bytes: Buffer,
  expected?: string,
) {
  if (!bytes.length || bytes.length > PLUGIN_ICON_MAX_BYTES)
    throw new Error("Plugin icons must be between 1 byte and 1 MB");
  const mediaType = sniffImageType(bytes);
  if (
    (mediaType !== "image/png" && mediaType !== "image/webp") ||
    (expected && mediaType !== expected)
  )
    throw new Error("Choose a PNG or WebP plugin icon");
  const revision = createHash("sha256").update(bytes).digest("hex");
  const { PhotonImage } = await import("@silvia-odwyer/photon-node");
  if (!validatedIcons.has(revision)) {
    let image: InstanceType<typeof PhotonImage> | undefined;
    try {
      image = PhotonImage.new_from_byteslice(bytes);
      if (
        !image.get_width() ||
        !image.get_height() ||
        image.get_width() > PLUGIN_ICON_MAX_DIMENSION ||
        image.get_height() > PLUGIN_ICON_MAX_DIMENSION
      )
        throw new Error("Plugin icons must be at most 2048 × 2048 pixels");
    } catch (cause) {
      throw new Error(
        cause instanceof Error
          ? cause.message
          : "The plugin icon could not be decoded",
      );
    } finally {
      image?.free();
    }
    validatedIcons.add(revision);
    if (validatedIcons.size > VALIDATED_ICON_CACHE_LIMIT)
      validatedIcons.delete(validatedIcons.values().next().value!);
  }
  return { bytes, mediaType, revision };
}

export async function readPluginIconAsset(
  root: string,
  icon: PluginIcon | undefined,
) {
  if (icon?.type !== "asset") return undefined;
  if (!isPluginIcon(icon)) throw new Error("Invalid plugin icon path");
  const packageRoot = await realpath(root);
  let target = packageRoot;
  for (const part of icon.path.slice(2).split("/")) {
    target = path.join(target, part);
    const info = await lstat(target);
    if (info.isSymbolicLink())
      throw new Error("Plugin icons must not contain symbolic links");
  }
  const relative = path.relative(packageRoot, await realpath(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Plugin icon must be inside its package");
  const info = await lstat(target);
  if (!info.isFile() || info.size > PLUGIN_ICON_MAX_BYTES)
    throw new Error("Choose a plugin icon file up to 1 MB");
  return validatePluginIconImage(
    await readFile(target),
    icon.path.endsWith(".png") ? "image/png" : "image/webp",
  );
}

export function registerPluginIconRoutes(
  app: FastifyInstance,
  stores: readonly {
    readIcon(id: string): ReturnType<typeof readPluginIconAsset>;
  }[],
) {
  app.get<{ Params: { pluginId: string } }>(
    "/plugins/:pluginId/icon",
    async (request, reply) => {
      try {
        const images = await Promise.all(
          stores.map((store) => store.readIcon(request.params.pluginId)),
        );
        const image = images.find(Boolean);
        if (!image)
          return reply.code(404).send({ error: "Plugin icon not found" });
        const etag = `"${image.revision}"`;
        reply
          .header("Cache-Control", "private, no-cache")
          .header("ETag", etag)
          .header("X-Content-Type-Options", "nosniff")
          .type(image.mediaType);
        if (
          request.headers["if-none-match"]
            ?.split(",")
            .some((tag) => [etag, `W/${etag}`, "*"].includes(tag.trim()))
        )
          return reply.code(304).send();
        return reply.send(image.bytes);
      } catch {
        return reply.code(404).send({ error: "Plugin icon not found" });
      }
    },
  );
}
