import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { PUBLISH_GAME_TITLE_MAX_LENGTH } from "../shared/publish-v1.js";
import type {
  CreatePublishDeploymentMetadata,
  CreatePublishGameRequest,
  PublishApiError,
  PublishCommunityGame,
  PublishDeployment,
  PublishGame,
  SetPublishListingRequest,
} from "../shared/publish-v1.js";
import { ArtifactError, ArtifactStore, contentType, DEFAULT_ARTIFACT_LIMITS, type ArtifactLimits } from "./artifacts.js";
import { bearerToken, hashPublisherToken } from "./auth.js";
import { deploymentUrl, gameUrl, playTarget } from "./urls.js";
import { PublishStore, type StoredCommunityGame, type StoredDeployment, type StoredGame } from "./store.js";

export interface PublishAppOptions {
  dataDirectory: string;
  playOrigin?: string;
  publisher?: { id: string; token: string };
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

const listingBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: { status: { type: "string", enum: ["listed", "unlisted"] } },
} as const;

export function createPublishApp(options: PublishAppOptions) {
  const playOrigin = options.playOrigin ?? "http://localhost:43130";
  const store = new PublishStore(options.dataDirectory);
  const artifacts = new ArtifactStore(options.dataDirectory, options.artifactLimits);
  const app = Fastify({ logger: options.logger ?? false, ajv: { customOptions: { coerceTypes: false } } });

  void app.register(multipart, {
    limits: {
      fields: 1,
      files: 1,
      parts: 2,
      fileSize: options.artifactLimits?.compressedBytes ?? DEFAULT_ARTIFACT_LIMITS.compressedBytes,
    },
  });

  if (options.publisher) {
    store.ensurePublisher(options.publisher.id, hashPublisherToken(options.publisher.token), new Date().toISOString());
  }

  app.addHook("onReady", () => artifacts.load(store.deploymentIds()));
  app.addHook("onClose", async () => store.close());
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    if (request.method === "GET" && request.url.startsWith("/v1/community/")) {
      reply.header("access-control-allow-origin", "*");
    }
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
      return sendError(reply, request, 400, "validation_failed", validation.message ?? "Request validation failed");
    }
    if (error instanceof ArtifactError) {
      return sendError(reply, request, error.code === "artifact_too_large" ? 413 : 400, error.code, error.message);
    }
    if (["FST_REQ_FILE_TOO_LARGE", "FST_PARTS_LIMIT", "FST_FILES_LIMIT", "FST_FIELDS_LIMIT"]
      .includes((error as { code?: string }).code ?? "")) {
      return sendError(reply, request, 413, "artifact_too_large", "Artifact is too large");
    }
    request.log.error(error);
    return sendError(reply, request, 500, "internal_error", "Internal server error");
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.post<{ Body: CreatePublishGameRequest }>(
    "/v1/games",
    { schema: { body: gameBodySchema } },
    async (request, reply) => {
      const publisherId = authenticate(request, reply, store);
      if (!publisherId) return;
      const key = idempotencyKey(request, reply);
      if (!key) return;
      const title = request.body.title.trim();
      if (!title) return sendError(reply, request, 400, "validation_failed", "title must not be empty");
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
    const publisherId = authenticate(request, reply, store);
    if (!publisherId) return;
    const game = store.game(publisherId, request.params.gameId);
    return game
      ? publicGame(game, playOrigin)
      : sendError(reply, request, 404, "not_found", "Game not found");
  });

  app.post<{ Params: { gameId: string } }>("/v1/games/:gameId/deployments", async (request, reply) => {
    const publisherId = authenticate(request, reply, store);
    if (!publisherId) return;
    const game = store.game(publisherId, request.params.gameId);
    if (!game) return sendError(reply, request, 404, "not_found", "Game not found");
    const key = idempotencyKey(request, reply);
    if (!key) return;
    if (!request.isMultipart()) return sendError(reply, request, 400, "validation_failed", "Expected multipart/form-data");

    const uploadId = randomUUID();
    const zipPath = artifacts.temporaryZip(uploadId);
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
        await artifacts.install(zipPath, deployment.id);
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
      const publisherId = authenticate(request, reply, store);
      if (!publisherId) return;
      const listing = store.setListing(publisherId, request.params.gameId, request.body.status, new Date().toISOString());
      if (listing === "not_ready") {
        return sendError(reply, request, 409, "conflict", "Game must be published before it can be listed");
      }
      return listing ?? sendError(reply, request, 404, "not_found", "Game not found");
    },
  );

  app.get("/v1/community/games", async () => {
    return store.communityGames().map((game) => publicCommunityGame(game, playOrigin));
  });

  app.get<{ Params: { gameId: string } }>("/v1/community/games/:gameId", async (request, reply) => {
    const game = store.communityGame(request.params.gameId);
    return game
      ? publicCommunityGame(game, playOrigin)
      : sendError(reply, request, 404, "not_found", "Community game not found");
  });

  app.get("/*", async (request, reply) => {
    return sendError(reply, request, 404, "not_found", "Not found");
  });

  return app;
}

function authenticate(request: FastifyRequest, reply: FastifyReply, store: PublishStore): string | undefined {
  const token = bearerToken(request.headers.authorization);
  const publisherId = token ? store.publisherForTokenHash(hashPublisherToken(token)) : undefined;
  if (publisherId) return publisherId;
  sendError(reply, request, 401, "authentication_required", "Authentication required");
  return undefined;
}

function idempotencyKey(request: FastifyRequest, reply: FastifyReply): string | undefined {
  const value = request.headers["idempotency-key"];
  if (typeof value === "string" && value.length >= 1 && value.length <= 200) return value;
  sendError(reply, request, 400, "validation_failed", "Idempotency-Key header is required");
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
  return sendError(reply, request, 409, reservation.kind === "pending" ? "conflict" : "idempotency_conflict", message);
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
  if (!deployment || !(await artifacts.exists(deployment.id))) {
    return sendError(reply, request, 404, "not_found", "Game not found");
  }
  const file = await artifacts.file(deployment.id, request.url);
  if (!file) return sendError(reply, request, 404, "not_found", "File not found");
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

function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  statusCode: number,
  code: PublishApiError["error"]["code"],
  message: string,
) {
  return reply.code(statusCode).send({ error: { code, message, requestId: request.id } } satisfies PublishApiError);
}
