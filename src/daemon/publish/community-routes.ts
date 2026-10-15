import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PUBLISH_GAME_TITLE_MAX_LENGTH } from "../../shared/publish-v1.js";
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
      return publisher.myGames(token);
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

  app.post<{
    Params: { gameId: string };
    Body: { visitorId: string; accessToken?: string };
  }>(
    "/community/games/:gameId/view",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["visitorId"],
          properties: {
            ...authenticatedBody,
            visitorId: {
              type: "string",
              pattern:
                "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            },
          },
        },
      },
    },
    async (request, reply) =>
      respond(reply, () =>
        publisher.recordView(
          request.params.gameId,
          request.body.visitorId,
          request.body.accessToken,
        ),
      ),
  );

  app.put<{
    Params: { gameId: string };
    Body: { liked: boolean; accessToken: string };
  }>(
    "/community/games/:gameId/like",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["accessToken", "liked"],
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
