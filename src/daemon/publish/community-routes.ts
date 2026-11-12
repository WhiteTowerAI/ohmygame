import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { GAME_NAME_MAX_LENGTH, PUBLISH_GAME_TITLE_MAX_LENGTH } from "../../shared/publish-v1.js";
import type { ProjectManager } from "../projects.js";
import { RemotePublisher, RemotePublishError } from "./client.js";
import type { LocalPublisher } from "./local.js";

export function registerCommunityRoutes(
  app: FastifyInstance,
  publisher: RemotePublisher | LocalPublisher,
  projects: ProjectManager,
) {
  const authenticatedBody = {
    accessToken: { type: "string", minLength: 1 },
  } as const;

  async function respond(
    reply: FastifyReply,
    operation: () => Promise<unknown>,
  ) {
    try {
      return await operation();
    } catch (cause) {
      return reply
        .code(cause instanceof RemotePublishError ? cause.statusCode : 502)
        .send({
          error: cause instanceof Error ? cause.message : String(cause),
          // Lets the app explain a refused name in the person's language.
          ...(cause instanceof RemotePublishError && cause.code
            ? { code: cause.code }
            : {}),
        });
    }
  }

  app.get<{
    Querystring: { metrics?: string; limit?: string; excludeGameId?: string };
  }>(
    "/community/games",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            metrics: { type: "string" },
            limit: { type: "string", pattern: "^([1-9]|[1-4][0-9]|50)$" },
            excludeGameId: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) =>
      respond(reply, () =>
        publisher.community(
          request.query.metrics === "true",
          cloudToken(request),
          {
            limit:
              request.query.limit === undefined
                ? undefined
                : Number(request.query.limit),
            excludeGameId: request.query.excludeGameId,
          },
        ),
      ),
  );

  app.get<{ Params: { gameId: string }; Querystring: { metrics?: string } }>(
    "/community/games/:gameId",
    async (request, reply) =>
      respond(reply, () =>
        publisher.communityGame(
          request.params.gameId,
          request.query.metrics === "true",
          cloudToken(request),
        ),
      ),
  );

  app.get<{ Params: { authorId: string } }>(
    "/community/authors/:authorId",
    async (request, reply) =>
      respond(reply, () =>
        publisher.profile(request.params.authorId, cloudToken(request)),
      ),
  );

  app.get("/community/me/games", async (request, reply) =>
    respond(reply, async () => {
      const token = requiredToken(request);
      const profile = await publisher.myGames(token);
      // Publications saved before the Cloud named games, or before a rename elsewhere, catch up.
      for (const game of profile.games) {
        if (!game.name) continue;
        for (const project of projects.list()) {
          const publication = project.publication;
          if (publication?.gameId !== game.id || (publication.name === game.name && publication.pageUrl === game.pageUrl)) continue;
          await projects.renamePublication(project.id, { gameId: game.id, name: game.name, pageUrl: game.pageUrl });
        }
      }
      return profile;
    }),
  );

  app.get<{ Params: { gameId: string; deploymentId: string } }>(
    "/community/games/:gameId/deployments/:deploymentId/cover",
    async (request, reply) =>
      respond(reply, async () => {
        const cover = await publisher.communityGameCover(
          request.params.gameId,
          request.params.deploymentId,
          cloudToken(request),
        );
        reply
          .header("content-type", "image/webp")
          .header(
            "cache-control",
            cloudToken(request)
              ? "private, no-store"
              : "private, max-age=31536000, immutable",
          )
          .header("x-content-type-options", "nosniff");
        return reply.send(cover);
      }),
  );

  app.put<{
    Params: { gameId: string };
    Body: { liked: boolean; accessToken?: string };
  }>(
    "/community/games/:gameId/like",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["liked"],
          properties: { ...authenticatedBody, liked: { type: "boolean" } },
        },
      },
    },
    async (request, reply) =>
      respond(reply, () =>
        publisher.setLike(
          request.params.gameId,
          request.body.accessToken,
          request.body.liked,
        ),
      ),
  );

  app.delete<{
    Params: { gameId: string };
    Body: { accessToken: string };
  }>(
    "/community/games/:gameId",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["accessToken"],
          properties: authenticatedBody,
        },
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        await publisher.unpublish(
          request.params.gameId,
          request.body.accessToken,
        );
        for (const project of projects.list()) {
          if (project.publication?.gameId === request.params.gameId)
            await projects.setPublication(project.id, undefined);
        }
        return reply.code(204).send();
      }),
  );

  app.put<{
    Params: { gameId: string };
    Body: { title: string; description?: string; accessToken: string };
  }>(
    "/community/games/:gameId",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["accessToken", "title"],
          properties: {
            ...authenticatedBody,
            title: {
              type: "string",
              minLength: 1,
              maxLength: PUBLISH_GAME_TITLE_MAX_LENGTH,
            },
            description: { type: "string", maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const title = request.body.title.trim();
        if (!title)
          return reply.code(400).send({ error: "Title cannot be empty" });
        const description = request.body.description?.trim() ?? "";
        await publisher.updateCommunityGame(
          request.params.gameId,
          request.body.accessToken,
          { title, description },
        );
        for (const project of projects.list()) {
          if (project.publication?.gameId === request.params.gameId) {
            await projects.setPublication(project.id, {
              ...project.publication,
              title,
              description,
            });
          }
        }
        return { title, description };
      }),
  );

  app.put<{
    Params: { gameId: string };
    Body: { name: string; accessToken: string };
  }>(
    "/community/games/:gameId/name",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["accessToken", "name"],
          properties: {
            ...authenticatedBody,
            name: { type: "string", minLength: 1, maxLength: GAME_NAME_MAX_LENGTH * 2 },
          },
        },
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        const game = await publisher.setGameName(
          request.params.gameId,
          request.body.accessToken,
          request.body.name,
        );
        // Merged when each project saves, so a publish finishing meanwhile keeps its deployment.
        for (const project of projects.list()) {
          if (project.publication?.gameId === request.params.gameId) {
            await projects.renamePublication(project.id, { gameId: game.id, name: game.name, pageUrl: game.pageUrl });
          }
        }
        return { name: game.name, pageUrl: game.pageUrl };
      }),
  );

  app.get<{ Params: { name: string }; Querystring: { gameId: string } }>(
    "/community/game-names/:name",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["gameId"],
          properties: { gameId: { type: "string", minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (request, reply) =>
      respond(reply, () =>
        publisher.gameNameAvailability(
          request.params.name,
          request.query.gameId,
          requiredToken(request),
        ),
      ),
  );
}

function cloudToken(request: FastifyRequest): string | undefined {
  const token = request.headers["x-publish-access-token"];
  return typeof token === "string" && token ? token : undefined;
}

function requiredToken(request: FastifyRequest): string {
  const token = cloudToken(request);
  if (!token) throw new RemotePublishError("Sign in to manage your games", 401);
  return token;
}
