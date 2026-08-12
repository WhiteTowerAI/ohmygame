import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type { CreateProjectRequest, PromptRequest, RuntimeEvent } from "../shared/contracts.js";
import { RuntimeEventBus } from "../shared/events.js";
import { matchesBearerToken } from "./access.js";
import { AgentManager } from "./agent.js";
import { CommunityStore } from "./community.js";
import { DeploymentManager, PublishError } from "./deployments.js";
import { PreviewManager } from "./preview.js";
import { isRunnableWorkspace, ProjectManager } from "./projects.js";

export interface AppOptions {
  dataDirectory?: string;
  logger?: boolean;
  accessToken?: string;
  allowedOrigins?: string[];
  playOrigin?: string;
  verifyPlayUrl?: (url: string) => Promise<void>;
}

const createProjectSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: { name: { type: "string", maxLength: 200 } },
  },
} as const;

const promptSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: { prompt: { type: "string", minLength: 1 } },
  },
} as const;

export function createApp(options: AppOptions = {}) {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const dataDirectory = options.dataDirectory ?? path.join(repositoryRoot, ".data");
  const events = new RuntimeEventBus();
  const projects = new ProjectManager(dataDirectory);
  const playOrigin = options.playOrigin ?? "http://localhost:43111";
  const community = new CommunityStore(dataDirectory, playOrigin);
  const deployments = new DeploymentManager(dataDirectory, playOrigin);
  const previews = new PreviewManager(events);
  const agents = new AgentManager(events);
  const app = Fastify({
    logger: options.logger ?? false,
    ajv: { customOptions: { coerceTypes: false } },
  });

  app.addHook("onReady", async () => {
    await Promise.all([projects.load(), community.load(), deployments.load()]);
    for (const game of community.list()) {
      projects.setPublication(game.projectId, {
        gameId: game.id,
        deploymentId: game.deploymentId,
        playUrl: game.playUrl,
        publishedAt: game.publishedAt,
      });
    }
  });

  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-headers", "authorization, content-type, last-event-id");
      reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
      reply.header("vary", "Origin");
    }
    if (request.method === "OPTIONS") return reply.code(204).send();
    if (!options.accessToken) return;
    if (!matchesBearerToken(request.headers.authorization, options.accessToken)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.post<{ Body: CreateProjectRequest }>("/projects", { schema: createProjectSchema }, async (request, reply) => {
    const project = await projects.create(request.body?.name);
    return reply.code(201).send(project);
  });

  app.get("/projects", async () => projects.list());

  app.get("/community/games", async () => community.list());

  app.get<{ Params: { projectId: string } }>("/projects/:projectId", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    return project ?? reply.code(404).send({ error: "Project not found" });
  });

  app.post<{ Params: { projectId: string } }>("/projects/:projectId/preview", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (!(await isRunnableWorkspace(project.workspacePath))) {
      return reply.code(409).send({ error: "Workspace is not runnable yet" });
    }
    return { url: await previews.start(project) };
  });

  app.post<{ Params: { projectId: string }; Body: PromptRequest }>("/projects/:projectId/prompts", { schema: promptSchema }, async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (!request.body?.prompt?.trim()) return reply.code(400).send({ error: "Prompt must not be empty" });
    if (project.agent.status === "running" || project.agent.status === "cancelling") {
      return reply.code(409).send({ error: "Agent is already running" });
    }
    void agents.prompt(project, request.body.prompt).then(async (result) => {
      if (
        result !== "completed" ||
        project.preview.status === "ready" ||
        project.preview.status === "starting" ||
        !(await isRunnableWorkspace(project.workspacePath))
      ) return;
      await previews.start(project).catch(() => {});
    }).catch(() => {});
    return reply.code(202).send({ accepted: true });
  });

  app.post<{ Params: { projectId: string } }>("/projects/:projectId/cancel", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    await agents.cancel(project);
    return reply.code(202).send({ accepted: true });
  });

  app.post<{ Params: { projectId: string } }>("/projects/:projectId/publish", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (project.agent.status === "running" || project.agent.status === "cancelling") {
      return reply.code(409).send({ error: "Wait for the agent to finish before publishing" });
    }
    events.publish(project.id, "publish.started", {});
    let deployment: Awaited<ReturnType<typeof deployments.create>> | undefined;
    let committed = false;
    try {
      deployment = await deployments.create(project);
      await (options.verifyPlayUrl ?? verifyPlayUrl)(deployment.playUrl);
      const game = await community.publish(project, deployment);
      committed = true;
      projects.setPublication(project.id, {
        gameId: game.id,
        deploymentId: game.deploymentId,
        playUrl: game.playUrl,
        publishedAt: game.publishedAt,
      });
      events.publish(project.id, "publish.completed", { game });
      return reply.code(201).send({ deployment, game });
    } catch (cause) {
      if (deployment && !committed) await deployments.remove(deployment.id).catch(() => {});
      const error = cause instanceof Error ? cause.message : String(cause);
      events.publish(project.id, "publish.error", { error });
      return reply.code(cause instanceof PublishError ? cause.statusCode : 502).send({ error });
    }
  });

  app.get<{ Params: { projectId: string }; Querystring: { cursor?: string } }>("/projects/:projectId/events", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    const cursor = Number(request.query.cursor ?? request.headers["last-event-id"] ?? 0) || 0;
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (event: RuntimeEvent) => reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    for (const event of events.since(project.id, cursor)) send(event);
    const unsubscribe = events.subscribe(project.id, send);
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
    request.raw.once("close", () => { clearInterval(heartbeat); unsubscribe(); });
  });

  app.addHook("onClose", async () => {
    await agents.close();
    await previews.stopAll();
    await deployments.close();
  });
  return app;
}

async function verifyPlayUrl(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Published game could not be reached");
}
