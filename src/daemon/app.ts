import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type { CreateProjectRequest, PromptRequest, RuntimeEvent } from "../shared/contracts.js";
import { RuntimeEventBus } from "../shared/events.js";
import { matchesBearerToken } from "./access.js";
import { AgentManager } from "./agent.js";
import { PreviewManager } from "./preview.js";
import { isRunnableWorkspace, ProjectManager } from "./projects.js";

export interface AppOptions {
  dataDirectory?: string;
  logger?: boolean;
  accessToken?: string;
  allowedOrigins?: string[];
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
  const previews = new PreviewManager(events);
  const agents = new AgentManager(events);
  const app = Fastify({
    logger: options.logger ?? false,
    ajv: { customOptions: { coerceTypes: false } },
  });

  app.addHook("onReady", () => projects.load());

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
  });
  return app;
}
