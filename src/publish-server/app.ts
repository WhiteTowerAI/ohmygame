import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { PUBLISH_ASSET_TITLE_MAX_LENGTH, PUBLISH_GAME_TITLE_MAX_LENGTH } from "../shared/publish-v1.js";
import type {
  CreatePublishAssetReleaseMetadata,
  CreatePublishAssetReleaseResult,
  CreatePublishAssetRequest,
  CreatePublishDeploymentMetadata,
  CreatePublishGameRequest,
  PublishAsset,
  PublishAssetRelease,
  PublishExploreAsset,
  PublishCommunityGame,
  PublishDeployment,
  PublishGame,
  SetPublishListingRequest,
} from "../shared/publish-v1.js";
import { ArtifactError, ArtifactStore, contentType, DEFAULT_ARTIFACT_LIMITS, type ArtifactLimits } from "./artifacts.js";
import { requirePublisher, type PublisherTokenVerifier } from "./auth.js";
import { sendPublishError } from "./http.js";
import { listingBodySchema } from "./listings.js";
import { deploymentUrl, gameUrl, playTarget } from "./urls.js";
import { PublishStore, type StoredAsset, type StoredAssetRelease, type StoredCommunityGame, type StoredDeployment, type StoredExploreAsset, type StoredGame } from "./store.js";

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

export function createPublishApp(options: PublishAppOptions) {
  const playOrigin = options.playOrigin ?? "http://localhost:43130";
  const store = new PublishStore(options.dataDirectory);
  const artifacts = new ArtifactStore(options.dataDirectory, options.artifactLimits);
  const app = Fastify({ logger: options.logger ?? false, ajv: { customOptions: { coerceTypes: false } } });
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

  app.addHook("onReady", () => artifacts.load(new Set([...store.deploymentIds(), ...store.assetReleaseIds()])));
  app.addHook("onClose", async () => store.close());
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    const target = playTarget(request.headers.host, playOrigin);
    if (!target) return;
    if (request.method !== "GET" && request.method !== "HEAD") {
      return reply.code(405).header("allow", "GET, HEAD").send();
    }
    return serveGame(request, reply, target, store, artifacts);
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

function publicExploreAsset(asset: StoredExploreAsset): PublishExploreAsset {
  return {
    id: asset.assetId, title: asset.title, description: asset.description, mediaType: asset.mediaType,
    releaseId: asset.id, artifactSha256: asset.artifactSha256, artifactBytes: asset.artifactBytes,
    fileName: asset.fileName, contentType: asset.contentType, publishedAt: asset.publishedAt,
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
  const file = await artifacts.file(deployment.id, request.url, { defaultDocument: "index.html" });
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
