import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { isAssetTemplateDefinition } from "../shared/asset-templates.js";
import { PLUGIN_ARCHIVE_ALLOWED_HIDDEN_DIRECTORIES, PLUGIN_ARCHIVE_MAX_BYTES, PLUGIN_ARCHIVE_MAX_ENTRIES, PLUGIN_MANIFEST_PATH, PLUGIN_SKILL_CONTENT_MAX_BYTES, isNewerPluginVersion, isPluginManifest, type PluginManifest } from "../shared/plugins.js";
import { PUBLISH_ASSET_TITLE_MAX_LENGTH, PUBLISH_GAME_TITLE_MAX_LENGTH } from "../shared/publish-v1.js";
import type {
  CreatePublishAssetReleaseMetadata,
  CreatePublishAssetReleaseResult,
  CreatePublishAssetRequest,
  CreatePublishPluginReleaseMetadata,
  CreatePublishPluginReleaseResult,
  CreatePublishPluginRequest,
  CreatePublishTemplateReleaseRequest,
  CreatePublishTemplateReleaseResult,
  CreatePublishTemplateRequest,
  CreatePublishDeploymentMetadata,
  CreatePublishGameRequest,
  PublishAsset,
  PublishAssetRelease,
  PublishExploreAsset,
  PublishCommunityGame,
  PublishDeployment,
  PublishGame,
  PublishExplorePlugin,
  PublishExploreTemplate,
  SetPublishListingRequest,
} from "../shared/publish-v1.js";
import { ArtifactError, ArtifactStore, contentType, DEFAULT_ARTIFACT_LIMITS, type ArtifactLimits } from "./artifacts.js";
import { requirePublisher, type PublisherTokenVerifier } from "./auth.js";
import { sendPublishError } from "./http.js";
import { listingBodySchema } from "./listings.js";
import { deploymentUrl, gameUrl, playTarget } from "./urls.js";
import { PublishStore, type StoredAsset, type StoredAssetRelease, type StoredCommunityGame, type StoredDeployment, type StoredExploreAsset, type StoredExplorePlugin, type StoredExploreTemplate, type StoredGame, type StoredPlugin, type StoredPluginRelease, type StoredTemplate, type StoredTemplateRelease } from "./store.js";

const PLAY_ROUTE_PREFIX = "/__play";

export interface PublishAppOptions {
  dataDirectory: string;
  playOrigin?: string;
  verifyPublisherToken: PublisherTokenVerifier;
  artifactLimits?: ArtifactLimits;
  logger?: boolean;
}

const gameBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: PUBLISH_GAME_TITLE_MAX_LENGTH },
    description: { type: "string", maxLength: 2_000 },
  },
} as const;

const assetBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "mediaType"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: PUBLISH_ASSET_TITLE_MAX_LENGTH },
    description: { type: "string", maxLength: 2_000 },
    mediaType: { type: "string", enum: ["image", "video", "audio", "model"] },
  },
} as const;

const pluginBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: { name: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" } },
} as const;

const templateBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: { name: { type: "string", minLength: 1, maxLength: 80 } },
} as const;

const templateReleaseBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["definition"],
  properties: { definition: { type: "object" } },
} as const;

export function createPublishApp(options: PublishAppOptions) {
  const playOrigin = options.playOrigin ?? "http://localhost:43130";
  const store = new PublishStore(options.dataDirectory);
  const artifacts = new ArtifactStore(options.dataDirectory, options.artifactLimits);
  const app = Fastify({
    logger: options.logger ?? false,
    ajv: { customOptions: { coerceTypes: false } },
    rewriteUrl: (request) => {
      if ((request.method === "GET" || request.method === "HEAD") && playTarget(request.headers.host, playOrigin)) {
        return `${PLAY_ROUTE_PREFIX}${request.url}`;
      }
      return request.url ?? "/";
    },
  });
  const authenticatePublisher = (request: FastifyRequest, reply: FastifyReply) => requirePublisher(
    request,
    reply,
    options.verifyPublisherToken,
    (publisherId, createdAt) => store.ensurePublisher(publisherId, createdAt),
  );

  void app.register(multipart, {
    limits: {
      fields: 1,
      files: 1,
      parts: 2,
      fileSize: options.artifactLimits?.compressedBytes ?? DEFAULT_ARTIFACT_LIMITS.compressedBytes,
    },
  });

  app.addHook("onReady", () => artifacts.load(new Set([
    ...store.deploymentIds(), ...store.assetReleaseIds(), ...store.pluginReleaseIds(),
  ])));
  app.addHook("onClose", async () => store.close());
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    const target = playTarget(request.headers.host, playOrigin);
    if (!target) return;
    if (request.method !== "GET" && request.method !== "HEAD") {
      return reply.code(405).header("allow", "GET, HEAD").send();
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const validation = error as { validation?: unknown; message?: string };
    if (validation.validation) {
      return sendPublishError(reply, request, 400, "validation_failed", validation.message ?? "Request validation failed");
    }
    if (error instanceof ArtifactError) {
      return sendPublishError(reply, request, error.code === "artifact_too_large" ? 413 : 400, error.code, error.message);
    }
    if (["FST_REQ_FILE_TOO_LARGE", "FST_PARTS_LIMIT", "FST_FILES_LIMIT", "FST_FIELDS_LIMIT"]
      .includes((error as { code?: string }).code ?? "")) {
      return sendPublishError(reply, request, 413, "artifact_too_large", "Artifact is too large");
    }
    request.log.error(error);
    return sendPublishError(reply, request, 500, "internal_error", "Internal server error");
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.post<{ Body: CreatePublishGameRequest }>(
    "/v1/games",
    { schema: { body: gameBodySchema } },
    async (request, reply) => {
      const publisherId = await authenticatePublisher(request, reply);
      if (!publisherId) return;
      const key = idempotencyKey(request, reply);
      if (!key) return;
      const title = request.body.title.trim();
      if (!title) return sendPublishError(reply, request, 400, "validation_failed", "title must not be empty");
      const description = request.body.description?.trim() ?? "";
      const route = "/v1/games";
      const hash = requestHash({ title, description });
      const reservation = store.reserveIdempotency(publisherId, "POST", route, key, hash, new Date().toISOString());
      const replay = handleReservation(
        reservation,
        request,
        reply,
        (body) => withCurrentUrls(body as Omit<PublishGame, "playUrl">, playOrigin),
      );
      if (replay !== false) return replay;

      const now = new Date().toISOString();
      const id = randomUUID();
      const expected: PublishGame = {
        id,
        publisherId,
        title,
        description,
        playUrl: gameUrl(playOrigin, id),
        currentDeploymentId: null,
        createdAt: now,
        updatedAt: now,
      };
      try {
        store.createGame(id, publisherId, title, description, now, {
          method: "POST", route, key, statusCode: 201, body: withoutGameUrl(expected),
        });
        return reply.code(201).send(expected);
      } catch (error) {
        store.releaseIdempotency(publisherId, "POST", route, key);
        throw error;
      }
    },
  );

  app.get<{ Params: { gameId: string } }>("/v1/games/:gameId", async (request, reply) => {
    const publisherId = await authenticatePublisher(request, reply);
    if (!publisherId) return;
    const game = store.game(publisherId, request.params.gameId);
    return game
      ? publicGame(game, playOrigin)
      : sendPublishError(reply, request, 404, "not_found", "Game not found");
  });

  app.post<{ Params: { gameId: string } }>("/v1/games/:gameId/deployments", async (request, reply) => {
    const publisherId = await authenticatePublisher(request, reply);
    if (!publisherId) return;
    const game = store.game(publisherId, request.params.gameId);
    if (!game) return sendPublishError(reply, request, 404, "not_found", "Game not found");
    const key = idempotencyKey(request, reply);
    if (!key) return;
    if (!request.isMultipart()) return sendPublishError(reply, request, 400, "validation_failed", "Expected multipart/form-data");

    const uploadId = randomUUID();
    const zipPath = artifacts.temporaryFile(uploadId, ".zip");
    let metadata: CreatePublishDeploymentMetadata | undefined;
    let received: { sha256: string; bytes: number } | undefined;
    try {
      for await (const part of request.parts()) {
        if (part.type === "field") {
          if (part.fieldname !== "metadata" || metadata) throw new ArtifactError("Expected one metadata field");
          metadata = deploymentMetadata(part.value);
        } else {
          if (part.fieldname !== "artifact" || received) {
            part.file.resume();
            throw new ArtifactError("Expected one artifact file");
          }
          if (part.mimetype !== "application/zip" && part.mimetype !== "application/x-zip-compressed") {
            part.file.resume();
            throw new ArtifactError("Artifact must be an application/zip file");
          }
          received = await artifacts.receive(part.file, zipPath);
        }
      }
      if (!metadata || !received) throw new ArtifactError("Deployment requires metadata and artifact parts");
      if (metadata.artifactSha256 !== received.sha256 || metadata.artifactBytes !== received.bytes) {
        throw new ArtifactError("Artifact digest or byte length does not match metadata");
      }

      const route = "/v1/games/:gameId/deployments";
      const reservation = store.reserveIdempotency(
        publisherId,
        "POST",
        route,
        key,
        requestHash({ gameId: game.id, ...metadata }),
        new Date().toISOString(),
      );
      const replay = handleReservation(
        reservation,
        request,
        reply,
        (body) => withCurrentResultUrls(body, playOrigin),
      );
      if (replay !== false) {
        await rm(zipPath, { force: true });
        return replay;
      }

      const deployment: StoredDeployment = {
        id: randomUUID(),
        gameId: game.id,
        artifactSha256: metadata.artifactSha256,
        publishedAt: new Date().toISOString(),
      };
      try {
        await artifacts.installArchive(zipPath, deployment.id, { requiredFiles: ["index.html"] });
        const expectedDeployment = publicDeployment(deployment, playOrigin);
        const expectedGame = publicGame(
          { ...game, currentDeploymentId: deployment.id, updatedAt: deployment.publishedAt },
          playOrigin,
        );
        const body = { deployment: expectedDeployment, game: expectedGame };
        store.activateDeployment(publisherId, deployment, {
          method: "POST", route, key, statusCode: 201, body: withoutResultUrls(body),
        });
        return reply.code(201).send(body);
      } catch (error) {
        await artifacts.remove(deployment.id);
        store.releaseIdempotency(publisherId, "POST", route, key);
        throw error;
      }
    } catch (error) {
      await rm(zipPath, { force: true });
      throw error;
    }
  });

  app.put<{ Params: { gameId: string }; Body: SetPublishListingRequest }>(
    "/v1/games/:gameId/listing",
    { schema: { body: listingBodySchema } },
    async (request, reply) => {
      const publisherId = await authenticatePublisher(request, reply);
      if (!publisherId) return;
      const listing = store.setListing(publisherId, request.params.gameId, request.body.status, new Date().toISOString());
      if (listing === "not_ready") {
        return sendPublishError(reply, request, 409, "conflict", "Game must be published before it can be listed");
      }
      return listing ?? sendPublishError(reply, request, 404, "not_found", "Game not found");
    },
  );

  app.get("/v1/community/games", async () => {
    return store.communityGames().map((game) => publicCommunityGame(game, playOrigin));
  });

  app.get<{ Params: { gameId: string } }>("/v1/community/games/:gameId", async (request, reply) => {
    const game = store.communityGame(request.params.gameId);
    return game
      ? publicCommunityGame(game, playOrigin)
      : sendPublishError(reply, request, 404, "not_found", "Community game not found");
  });

  app.post<{ Body: CreatePublishAssetRequest }>(
    "/v1/assets",
    { schema: { body: assetBodySchema } },
    async (request, reply) => {
      const publisherId = await authenticatePublisher(request, reply);
      if (!publisherId) return;
      const key = idempotencyKey(request, reply);
      if (!key) return;
      const title = request.body.title.trim();
      if (!title) return sendPublishError(reply, request, 400, "validation_failed", "title must not be empty");
      const description = request.body.description?.trim() ?? "";
      const route = "/v1/assets";
      const reservation = store.reserveIdempotency(
        publisherId,
        "POST",
        route,
        key,
        requestHash({ title, description, mediaType: request.body.mediaType }),
        new Date().toISOString(),
      );
      const replay = handleReservation(reservation, request, reply, (body) => body);
      if (replay !== false) return replay;
      const now = new Date().toISOString();
      const asset: StoredAsset = {
        id: randomUUID(), publisherId, title, description, mediaType: request.body.mediaType,
        currentReleaseId: null, createdAt: now, updatedAt: now,
      };
      try {
        store.createAsset(asset, { method: "POST", route, key, statusCode: 201, body: asset });
        return reply.code(201).send(asset);
      } catch (error) {
        store.releaseIdempotency(publisherId, "POST", route, key);
        throw error;
      }
    },
  );

  app.get<{ Params: { assetId: string } }>("/v1/assets/:assetId", async (request, reply) => {
    const publisherId = await authenticatePublisher(request, reply);
    if (!publisherId) return;
    return store.asset(publisherId, request.params.assetId)
      ?? sendPublishError(reply, request, 404, "not_found", "Asset not found");
  });

  app.post<{ Params: { assetId: string } }>("/v1/assets/:assetId/releases", async (request, reply) => {
    const publisherId = await authenticatePublisher(request, reply);
    if (!publisherId) return;
    const asset = store.asset(publisherId, request.params.assetId);
    if (!asset) return sendPublishError(reply, request, 404, "not_found", "Asset not found");
    const key = idempotencyKey(request, reply);
    if (!key) return;
    if (!request.isMultipart()) return sendPublishError(reply, request, 400, "validation_failed", "Expected multipart/form-data");

    const uploadId = randomUUID();
    const uploadPath = artifacts.temporaryFile(uploadId, ".upload");
    let metadata: CreatePublishAssetReleaseMetadata | undefined;
    let received: { sha256: string; bytes: number; contentType: string } | undefined;
    try {
      for await (const part of request.parts()) {
        if (part.type === "field") {
          if (part.fieldname !== "metadata" || metadata) throw new ArtifactError("Expected one metadata field");
          metadata = assetReleaseMetadata(part.value, asset.mediaType);
        } else {
          if (part.fieldname !== "artifact" || received) {
            part.file.resume();
            throw new ArtifactError("Expected one artifact file");
          }
          received = { ...await artifacts.receive(part.file, uploadPath), contentType: part.mimetype.toLowerCase() };
        }
      }
      if (!metadata || !received) throw new ArtifactError("Asset release requires metadata and artifact parts");
      if (metadata.artifactSha256 !== received.sha256 || metadata.artifactBytes !== received.bytes) {
        throw new ArtifactError("Artifact digest or byte length does not match metadata");
      }
      if (metadata.contentType !== received.contentType) throw new ArtifactError("Artifact content type does not match metadata");
      const route = "/v1/assets/:assetId/releases";
      const reservation = store.reserveIdempotency(
        publisherId, "POST", route, key,
        requestHash({ assetId: asset.id, ...metadata }), new Date().toISOString(),
      );
      const replay = handleReservation(reservation, request, reply, (body) => body);
      if (replay !== false) {
        await rm(uploadPath, { force: true });
        return replay;
      }
      const release: StoredAssetRelease = {
        id: randomUUID(), assetId: asset.id, artifactSha256: metadata.artifactSha256,
        artifactBytes: metadata.artifactBytes, fileName: metadata.fileName,
        contentType: metadata.contentType, publishedAt: new Date().toISOString(),
      };
      try {
        await artifacts.installFile(uploadPath, release.id, release.fileName);
        const currentAsset = { ...asset, currentReleaseId: release.id, updatedAt: release.publishedAt };
        const body: CreatePublishAssetReleaseResult = { asset: currentAsset, release };
        store.activateAssetRelease(publisherId, release, { method: "POST", route, key, statusCode: 201, body });
        return reply.code(201).send(body);
      } catch (error) {
        await artifacts.remove(release.id);
        store.releaseIdempotency(publisherId, "POST", route, key);
        throw error;
      }
    } catch (error) {
      await rm(uploadPath, { force: true });
      throw error;
    }
  });

  app.put<{ Params: { assetId: string }; Body: SetPublishListingRequest }>(
    "/v1/assets/:assetId/listing",
    { schema: { body: listingBodySchema } },
    async (request, reply) => {
      const publisherId = await authenticatePublisher(request, reply);
      if (!publisherId) return;
      const listing = store.setAssetListing(publisherId, request.params.assetId, request.body.status, new Date().toISOString());
      if (listing === "not_ready") return sendPublishError(reply, request, 409, "conflict", "Asset must have a release before it can be listed");
      return listing ?? sendPublishError(reply, request, 404, "not_found", "Asset not found");
    },
  );

  app.get("/v1/explore/assets", async () => store.exploreAssets().map(publicExploreAsset));

  app.get<{ Params: { assetId: string } }>("/v1/explore/assets/:assetId", async (request, reply) => {
    const asset = store.exploreAsset(request.params.assetId);
    return asset ? publicExploreAsset(asset) : sendPublishError(reply, request, 404, "not_found", "Asset not found");
  });

  app.get<{ Params: { assetId: string; releaseId: string } }>("/v1/explore/assets/:assetId/releases/:releaseId/content", async (request, reply) => {
    const asset = store.exploreAssetRelease(request.params.assetId, request.params.releaseId);
    if (!asset) return sendPublishError(reply, request, 404, "not_found", "Asset release not found");
    const file = await artifacts.file(asset.id, asset.fileName);
    if (!file) return sendPublishError(reply, request, 404, "not_found", "Asset content not found");
    reply.header("content-type", asset.contentType);
    reply.header("content-length", asset.artifactBytes);
    reply.header("etag", `\"${asset.artifactSha256}\"`);
    reply.header("cache-control", "public, max-age=31536000, immutable");
    reply.header("x-content-type-options", "nosniff");
    return reply.send(createReadStream(file));
  });

  app.post<{ Body: CreatePublishPluginRequest }>(
    "/v1/plugins",
    { schema: { body: pluginBodySchema } },
    async (request, reply) => {
      const publisherId = await authenticatePublisher(request, reply);
      if (!publisherId) return;
      const key = idempotencyKey(request, reply);
      if (!key) return;
      const existing = store.pluginByName(request.body.name);
      if (existing && existing.publisherId !== publisherId) {
        return sendPublishError(reply, request, 409, "conflict", "Plugin name is already in use");
      }
      const route = "/v1/plugins";
      const reservation = store.reserveIdempotency(
        publisherId, "POST", route, key, requestHash(request.body), new Date().toISOString(),
      );
      const replay = handleReservation(reservation, request, reply, (body) => body);
      if (replay !== false) return replay;
      const now = new Date().toISOString();
      const plugin: StoredPlugin = {
        id: randomUUID(), publisherId, name: request.body.name,
        currentReleaseId: null, createdAt: now, updatedAt: now,
      };
      try {
        store.createPlugin(plugin, { method: "POST", route, key, statusCode: 201, body: plugin });
        return reply.code(201).send(plugin);
      } catch (error) {
        store.releaseIdempotency(publisherId, "POST", route, key);
        throw error;
      }
    },
  );

  app.get<{ Params: { pluginId: string } }>("/v1/plugins/:pluginId", async (request, reply) => {
    const publisherId = await authenticatePublisher(request, reply);
    if (!publisherId) return;
    return store.plugin(publisherId, request.params.pluginId)
      ?? sendPublishError(reply, request, 404, "not_found", "Plugin not found");
  });

  app.post<{ Params: { pluginId: string } }>("/v1/plugins/:pluginId/releases", async (request, reply) => {
    const publisherId = await authenticatePublisher(request, reply);
    if (!publisherId) return;
    const plugin = store.plugin(publisherId, request.params.pluginId);
    if (!plugin) return sendPublishError(reply, request, 404, "not_found", "Plugin not found");
    const key = idempotencyKey(request, reply);
    if (!key) return;
    if (!request.isMultipart()) return sendPublishError(reply, request, 400, "validation_failed", "Expected multipart/form-data");

    const uploadPath = artifacts.temporaryFile(randomUUID(), ".zip");
    let metadata: CreatePublishPluginReleaseMetadata | undefined;
    let received: { sha256: string; bytes: number } | undefined;
    try {
      for await (const part of request.parts()) {
        if (part.type === "field") {
          if (part.fieldname !== "metadata" || metadata) throw new ArtifactError("Expected one metadata field");
          metadata = pluginReleaseMetadata(part.value, plugin.name);
        } else {
          if (part.fieldname !== "artifact" || received) {
            part.file.resume();
            throw new ArtifactError("Expected one artifact file");
          }
          if (part.mimetype !== "application/zip" && part.mimetype !== "application/x-zip-compressed") {
            part.file.resume();
            throw new ArtifactError("Plugin artifact must be an application/zip file");
          }
          received = await artifacts.receive(part.file, uploadPath);
        }
      }
      if (!metadata || !received) throw new ArtifactError("Plugin release requires metadata and artifact parts");
      if (metadata.artifactSha256 !== received.sha256 || metadata.artifactBytes !== received.bytes) {
        throw new ArtifactError("Artifact digest or byte length does not match metadata");
      }
      const route = "/v1/plugins/:pluginId/releases";
      const reservation = store.reserveIdempotency(
        publisherId, "POST", route, key,
        requestHash({ pluginId: plugin.id, ...metadata }), new Date().toISOString(),
      );
      const replay = handleReservation(reservation, request, reply, (body) => body);
      if (replay !== false) return replay;
      if (store.pluginVersion(plugin.id, metadata.manifest.version)) {
        store.releaseIdempotency(publisherId, "POST", route, key);
        return sendPublishError(reply, request, 409, "conflict", "Plugin version is already published");
      }
      const current = store.currentPluginRelease(publisherId, plugin.id);
      if (current && !isNewerPluginVersion(metadata.manifest.version, current.version)) {
        store.releaseIdempotency(publisherId, "POST", route, key);
        return sendPublishError(reply, request, 409, "conflict", "Plugin version must be newer than the current release");
      }
      const release: StoredPluginRelease = {
        id: randomUUID(), pluginId: plugin.id, version: metadata.manifest.version,
        artifactSha256: metadata.artifactSha256, artifactBytes: metadata.artifactBytes,
        manifest: metadata.manifest, skills: metadata.skills, publishedAt: new Date().toISOString(),
      };
      try {
        await artifacts.installArchive(uploadPath, release.id, {
          allowedHiddenDirectories: PLUGIN_ARCHIVE_ALLOWED_HIDDEN_DIRECTORIES,
          archiveFileName: "plugin.zip",
          limits: {
            expandedBytes: Math.min(PLUGIN_ARCHIVE_MAX_BYTES, options.artifactLimits?.expandedBytes ?? Infinity),
            fileBytes: Math.min(PLUGIN_ARCHIVE_MAX_BYTES, options.artifactLimits?.fileBytes ?? Infinity),
            files: Math.min(PLUGIN_ARCHIVE_MAX_ENTRIES, options.artifactLimits?.files ?? Infinity),
          },
        });
        await validatePluginArtifact(artifacts, release.id, metadata.manifest, metadata.skills);
        const body: CreatePublishPluginReleaseResult = {
          plugin: { ...plugin, currentReleaseId: release.id, updatedAt: release.publishedAt }, release,
        };
        store.activatePluginRelease(publisherId, release, { method: "POST", route, key, statusCode: 201, body });
        return reply.code(201).send(body);
      } catch (error) {
        await artifacts.remove(release.id);
        store.releaseIdempotency(publisherId, "POST", route, key);
        throw error;
      }
    } finally {
      await rm(uploadPath, { force: true });
    }
  });

  app.put<{ Params: { pluginId: string }; Body: SetPublishListingRequest }>(
    "/v1/plugins/:pluginId/listing",
    { schema: { body: listingBodySchema } },
    async (request, reply) => {
      const publisherId = await authenticatePublisher(request, reply);
      if (!publisherId) return;
      const listing = store.setPluginListing(publisherId, request.params.pluginId, request.body.status, new Date().toISOString());
      if (listing === "not_ready") return sendPublishError(reply, request, 409, "conflict", "Plugin must have a release before it can be listed");
      return listing ?? sendPublishError(reply, request, 404, "not_found", "Plugin not found");
    },
  );

  app.get("/v1/explore/plugins", async () => store.explorePlugins().map(publicExplorePlugin));

  app.get<{ Params: { pluginId: string } }>("/v1/explore/plugins/:pluginId", async (request, reply) => {
    const plugin = store.explorePlugin(request.params.pluginId);
    return plugin ? publicExplorePlugin(plugin) : sendPublishError(reply, request, 404, "not_found", "Plugin not found");
  });

  app.get<{ Params: { pluginId: string; releaseId: string } }>("/v1/explore/plugins/:pluginId/releases/:releaseId/content", async (request, reply) => {
    const release = store.explorePluginRelease(request.params.pluginId, request.params.releaseId);
    if (!release) return sendPublishError(reply, request, 404, "not_found", "Plugin release not found");
    const file = await artifacts.file(release.id, "plugin.zip");
    if (!file) return sendPublishError(reply, request, 404, "not_found", "Plugin content not found");
    reply.header("content-type", "application/zip");
    reply.header("content-length", release.artifactBytes);
    reply.header("etag", `\"${release.artifactSha256}\"`);
    reply.header("cache-control", "public, max-age=31536000, immutable");
    reply.header("x-content-type-options", "nosniff");
    return reply.send(createReadStream(file));
  });

  app.get<{ Params: { pluginId: string; releaseId: string }; Querystring: { id: string } }>(
    "/v1/explore/plugins/:pluginId/releases/:releaseId/skill-content",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: { type: "string", minLength: 1, maxLength: 500 } },
        },
      },
    },
    async (request, reply) => {
      const release = store.explorePluginRelease(request.params.pluginId, request.params.releaseId);
      if (!release) return sendPublishError(reply, request, 404, "not_found", "Plugin release not found");
      if (!release.skills.some((skill) => skill.id === request.query.id)) {
        return sendPublishError(reply, request, 404, "not_found", "Plugin Skill not found");
      }
      const file = await artifacts.internalFile(release.id, request.query.id);
      if (!file) return sendPublishError(reply, request, 404, "not_found", "Plugin Skill not found");
      if ((await stat(file)).size > PLUGIN_SKILL_CONTENT_MAX_BYTES) {
        return sendPublishError(reply, request, 413, "artifact_too_large", "Skill content is larger than 512 KB");
      }
      reply.header("cache-control", "public, max-age=31536000, immutable");
      return { id: request.query.id, content: await readFile(file, "utf8") };
    },
  );

  app.post<{ Body: CreatePublishTemplateRequest }>(
    "/v1/templates",
    { schema: { body: templateBodySchema } },
    async (request, reply) => {
      const publisherId = await authenticatePublisher(request, reply);
      if (!publisherId) return;
      const key = idempotencyKey(request, reply);
      if (!key) return;
      const name = request.body.name.trim();
      if (!name) return sendPublishError(reply, request, 400, "validation_failed", "name must not be empty");
      const route = "/v1/templates";
      const reservation = store.reserveIdempotency(
        publisherId, "POST", route, key, requestHash({ name }), new Date().toISOString(),
      );
      const replay = handleReservation(reservation, request, reply, (body) => body);
      if (replay !== false) return replay;
      const now = new Date().toISOString();
      const template: StoredTemplate = {
        id: randomUUID(), publisherId, name, currentReleaseId: null, createdAt: now, updatedAt: now,
      };
      try {
        store.createTemplate(template, { method: "POST", route, key, statusCode: 201, body: template });
        return reply.code(201).send(template);
      } catch (error) {
        store.releaseIdempotency(publisherId, "POST", route, key);
        throw error;
      }
    },
  );

  app.get<{ Params: { templateId: string } }>("/v1/templates/:templateId", async (request, reply) => {
    const publisherId = await authenticatePublisher(request, reply);
    if (!publisherId) return;
    return store.template(publisherId, request.params.templateId)
      ?? sendPublishError(reply, request, 404, "not_found", "Template not found");
  });

  app.post<{ Params: { templateId: string }; Body: CreatePublishTemplateReleaseRequest }>(
    "/v1/templates/:templateId/releases",
    { schema: { body: templateReleaseBodySchema } },
    async (request, reply) => {
      const publisherId = await authenticatePublisher(request, reply);
      if (!publisherId) return;
      const template = store.template(publisherId, request.params.templateId);
      if (!template) return sendPublishError(reply, request, 404, "not_found", "Template not found");
      if (!isAssetTemplateDefinition(request.body.definition)) {
        return sendPublishError(reply, request, 400, "validation_failed", "Template definition is invalid");
      }
      const key = idempotencyKey(request, reply);
      if (!key) return;
      const route = "/v1/templates/:templateId/releases";
      const reservation = store.reserveIdempotency(
        publisherId, "POST", route, key,
        requestHash({ templateId: template.id, definition: request.body.definition }), new Date().toISOString(),
      );
      const replay = handleReservation(reservation, request, reply, (body) => body);
      if (replay !== false) return replay;
      const release: StoredTemplateRelease = {
        id: randomUUID(), templateId: template.id, definition: request.body.definition,
        publishedAt: new Date().toISOString(),
      };
      try {
        const body: CreatePublishTemplateReleaseResult = {
          template: { ...template, name: release.definition.name, currentReleaseId: release.id, updatedAt: release.publishedAt },
          release,
        };
        store.activateTemplateRelease(publisherId, release, { method: "POST", route, key, statusCode: 201, body });
        return reply.code(201).send(body);
      } catch (error) {
        store.releaseIdempotency(publisherId, "POST", route, key);
        throw error;
      }
    },
  );

  app.put<{ Params: { templateId: string }; Body: SetPublishListingRequest }>(
    "/v1/templates/:templateId/listing",
    { schema: { body: listingBodySchema } },
    async (request, reply) => {
      const publisherId = await authenticatePublisher(request, reply);
      if (!publisherId) return;
      const listing = store.setTemplateListing(publisherId, request.params.templateId, request.body.status, new Date().toISOString());
      if (listing === "not_ready") return sendPublishError(reply, request, 409, "conflict", "Template must have a release before it can be listed");
      return listing ?? sendPublishError(reply, request, 404, "not_found", "Template not found");
    },
  );

  app.get("/v1/explore/templates", async () => store.exploreTemplates().map(publicExploreTemplate));

  app.get<{ Params: { templateId: string } }>("/v1/explore/templates/:templateId", async (request, reply) => {
    const template = store.exploreTemplate(request.params.templateId);
    return template ? publicExploreTemplate(template) : sendPublishError(reply, request, 404, "not_found", "Template not found");
  });

  app.route({
    method: ["GET", "HEAD"],
    url: `${PLAY_ROUTE_PREFIX}/*`,
    handler: async (request, reply) => {
      const target = playTarget(request.headers.host, playOrigin);
      if (!target) return sendPublishError(reply, request, 404, "not_found", "Not found");
      return serveGame(request, reply, target, store, artifacts);
    },
  });

  app.get("/*", async (request, reply) => {
    return sendPublishError(reply, request, 404, "not_found", "Not found");
  });

  return app;
}

function idempotencyKey(request: FastifyRequest, reply: FastifyReply): string | undefined {
  const value = request.headers["idempotency-key"];
  if (typeof value === "string" && value.length >= 1 && value.length <= 200) return value;
  sendPublishError(reply, request, 400, "validation_failed", "Idempotency-Key header is required");
  return undefined;
}

function handleReservation(
  reservation: ReturnType<PublishStore["reserveIdempotency"]>,
  request: FastifyRequest,
  reply: FastifyReply,
  replayBody: (body: unknown) => unknown,
): false | unknown {
  if (reservation.kind === "new") return false;
  if (reservation.kind === "replay") return reply.code(reservation.statusCode).send(replayBody(reservation.body));
  const message = reservation.kind === "pending"
    ? "A request with this idempotency key is still running"
    : "Idempotency key was already used with another request";
  return sendPublishError(reply, request, 409, reservation.kind === "pending" ? "conflict" : "idempotency_conflict", message);
}

function deploymentMetadata(value: unknown): CreatePublishDeploymentMetadata {
  let input: unknown = value;
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { throw new ArtifactError("metadata must be valid JSON"); }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ArtifactError("metadata must be an object");
  const metadata = input as Record<string, unknown>;
  if (!/^[a-f0-9]{64}$/.test(String(metadata.artifactSha256 ?? ""))) {
    throw new ArtifactError("artifactSha256 must be a lowercase SHA-256 digest");
  }
  if (!Number.isSafeInteger(metadata.artifactBytes) || Number(metadata.artifactBytes) < 1) {
    throw new ArtifactError("artifactBytes must be a positive safe integer");
  }
  return { artifactSha256: String(metadata.artifactSha256), artifactBytes: Number(metadata.artifactBytes) };
}

const ASSET_CONTENT_TYPES = {
  image: new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]),
  video: new Set(["video/mp4", "video/webm"]),
  audio: new Set(["audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav"]),
  model: new Set(["model/gltf-binary"]),
} as const;

const ASSET_EXTENSIONS: Record<string, readonly string[]> = {
  "image/avif": [".avif"], "image/gif": [".gif"], "image/jpeg": [".jpeg", ".jpg"],
  "image/png": [".png"], "image/webp": [".webp"], "video/mp4": [".mp4"],
  "video/webm": [".webm"], "audio/mp4": [".m4a"], "audio/mpeg": [".mp3"],
  "audio/ogg": [".ogg"], "audio/wav": [".wav"], "model/gltf-binary": [".glb"],
};

function assetReleaseMetadata(value: unknown, mediaType: PublishAsset["mediaType"]): CreatePublishAssetReleaseMetadata {
  let input: unknown = value;
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { throw new ArtifactError("metadata must be valid JSON"); }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ArtifactError("metadata must be an object");
  const metadata = input as Record<string, unknown>;
  const artifactSha256 = String(metadata.artifactSha256 ?? "");
  const artifactBytes = Number(metadata.artifactBytes);
  const fileName = String(metadata.fileName ?? "");
  const declaredContentType = String(metadata.contentType ?? "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(artifactSha256)) throw new ArtifactError("artifactSha256 must be a lowercase SHA-256 digest");
  if (!Number.isSafeInteger(artifactBytes) || artifactBytes < 1) throw new ArtifactError("artifactBytes must be a positive safe integer");
  if (path.basename(fileName) !== fileName || !/^[a-zA-Z0-9][a-zA-Z0-9._ -]*$/.test(fileName)) throw new ArtifactError("fileName is invalid");
  if (!(ASSET_CONTENT_TYPES[mediaType] as ReadonlySet<string>).has(declaredContentType)) {
    throw new ArtifactError(`contentType is not valid for ${mediaType}`);
  }
  if (!ASSET_EXTENSIONS[declaredContentType]?.includes(path.extname(fileName).toLowerCase())) {
    throw new ArtifactError("fileName extension does not match contentType");
  }
  return { artifactSha256, artifactBytes, fileName, contentType: declaredContentType };
}

function pluginReleaseMetadata(value: unknown, pluginName: string): CreatePublishPluginReleaseMetadata {
  let input: unknown = value;
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { throw new ArtifactError("metadata must be valid JSON"); }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ArtifactError("metadata must be an object");
  const record = input as Record<string, unknown>;
  const artifactSha256 = String(record.artifactSha256 ?? "");
  const artifactBytes = Number(record.artifactBytes);
  if (!/^[a-f0-9]{64}$/.test(artifactSha256)) throw new ArtifactError("artifactSha256 must be a lowercase SHA-256 digest");
  if (!Number.isSafeInteger(artifactBytes) || artifactBytes < 1) throw new ArtifactError("artifactBytes must be a positive safe integer");
  if (!isPluginManifest(record.manifest) || record.manifest.name !== pluginName) throw new ArtifactError("Plugin manifest is invalid");
  if (!Array.isArray(record.skills) || record.skills.length > 5_000) throw new ArtifactError("Plugin skills are invalid");
  const skills = record.skills.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ArtifactError("Plugin skill is invalid");
    const skill = value as Record<string, unknown>;
    if (Object.keys(skill).some((key) => !["id", "name", "description"].includes(key))) throw new ArtifactError("Plugin skill is invalid");
    const id = typeof skill.id === "string" ? skill.id.trim() : "";
    const name = typeof skill.name === "string" ? skill.name.trim() : "";
    const description = typeof skill.description === "string" ? skill.description.trim() : undefined;
    const idSegments = id.split("/");
    if (!id || id.length > 500 || id.includes("\\") || id.startsWith("/") ||
      idSegments.some((segment) => !segment || segment === "." || segment === "..") || idSegments.at(-1) !== "SKILL.md" ||
      !name || name.length > 200 || (description?.length ?? 0) > 2_000) {
      throw new ArtifactError("Plugin skill is invalid");
    }
    return { id, name, ...(description ? { description } : {}) };
  });
  return { artifactSha256, artifactBytes, manifest: record.manifest, skills };
}

async function validatePluginArtifact(
  artifacts: ArtifactStore,
  releaseId: string,
  manifest: PluginManifest,
  skills: CreatePublishPluginReleaseMetadata["skills"],
): Promise<void> {
  const skillPaths = Array.isArray(manifest.skills) ? manifest.skills : manifest.skills ? [manifest.skills] : [];
  for (const skillPath of skillPaths) {
    if (!await artifacts.exists(releaseId, skillPath.slice(2))) {
      throw new ArtifactError(`Plugin artifact is missing declared Skill path ${skillPath}`);
    }
  }
  for (const skill of skills) {
    if (!await artifacts.exists(releaseId, skill.id)) {
      throw new ArtifactError(`Plugin artifact is missing published Skill ${skill.id}`);
    }
  }

  const manifestPath = await artifacts.internalFile(releaseId, PLUGIN_MANIFEST_PATH);
  if (!manifestPath) return;
  let archivedManifest: unknown;
  try {
    archivedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new ArtifactError("Plugin manifest is not valid JSON");
  }
  if (!isPluginManifest(archivedManifest) || !isDeepStrictEqual(archivedManifest, manifest)) {
    throw new ArtifactError("Plugin manifest does not match release metadata");
  }
}

function publicExploreAsset(asset: StoredExploreAsset): PublishExploreAsset {
  return {
    id: asset.assetId, title: asset.title, description: asset.description, mediaType: asset.mediaType,
    releaseId: asset.id, artifactSha256: asset.artifactSha256, artifactBytes: asset.artifactBytes,
    fileName: asset.fileName, contentType: asset.contentType, publishedAt: asset.publishedAt,
  };
}

function publicExplorePlugin(plugin: StoredExplorePlugin): PublishExplorePlugin {
  return {
    id: plugin.pluginId, name: plugin.name, version: plugin.version, releaseId: plugin.id,
    artifactSha256: plugin.artifactSha256, artifactBytes: plugin.artifactBytes,
    manifest: plugin.manifest, skills: plugin.skills, publishedAt: plugin.publishedAt,
  };
}

function publicExploreTemplate(template: StoredExploreTemplate): PublishExploreTemplate {
  return {
    ...template.definition,
    id: template.templateId,
    releaseId: template.id,
    publishedAt: template.publishedAt,
  };
}

function publicGame(game: StoredGame, playOrigin: string): PublishGame {
  return { ...game, playUrl: gameUrl(playOrigin, game.id) };
}

function publicDeployment(deployment: StoredDeployment, playOrigin: string): PublishDeployment {
  return { ...deployment, versionUrl: deploymentUrl(playOrigin, deployment.id) };
}

function publicCommunityGame(game: StoredCommunityGame, playOrigin: string): PublishCommunityGame {
  return { ...game, playUrl: gameUrl(playOrigin, game.id) };
}

async function serveGame(
  request: FastifyRequest,
  reply: FastifyReply,
  target: NonNullable<ReturnType<typeof playTarget>>,
  store: PublishStore,
  artifacts: ArtifactStore,
) {
  const deployment = target.kind === "deployment"
    ? store.deployment(target.id)
    : store.currentDeployment(target.id);
  if (!deployment || !(await artifacts.exists(deployment.id, "index.html"))) {
    return sendPublishError(reply, request, 404, "not_found", "Game not found");
  }
  const file = await artifacts.file(deployment.id, request.originalUrl, { defaultDocument: "index.html" });
  if (!file) return sendPublishError(reply, request, 404, "not_found", "File not found");
  reply.header("content-type", contentType(file));
  reply.header("x-content-type-options", "nosniff");
  reply.header("cache-control", target.kind === "deployment" ? "public, max-age=31536000, immutable" : "no-cache");
  return reply.send(createReadStream(file));
}

function withoutGameUrl(game: PublishGame): Omit<PublishGame, "playUrl"> {
  const { playUrl: _, ...stored } = game;
  return stored;
}

function withCurrentUrls(game: Omit<PublishGame, "playUrl">, playOrigin: string): PublishGame {
  return { ...game, playUrl: gameUrl(playOrigin, game.id) };
}

function withoutResultUrls(value: { deployment: PublishDeployment; game: PublishGame }) {
  const { versionUrl: _, ...deployment } = value.deployment;
  return { deployment, game: withoutGameUrl(value.game) };
}

function withCurrentResultUrls(value: unknown, playOrigin: string) {
  const result = value as {
    deployment: Omit<PublishDeployment, "versionUrl">;
    game: Omit<PublishGame, "playUrl">;
  };
  return {
    deployment: { ...result.deployment, versionUrl: deploymentUrl(playOrigin, result.deployment.id) },
    game: withCurrentUrls(result.game, playOrigin),
  };
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
