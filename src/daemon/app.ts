import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import Fastify from "fastify";
import { IMAGE_SIZES, type AddToolResultRequest, type CreateConversationRequest, type CreateProjectRequest, type PromptRequest, type RemovePendingPromptRequest, type RenameConversationRequest, type RunImageToolRequest, type RuntimeEvent, type SetConversationModelRequest, type ToolSettings } from "../shared/contracts.js";
import { RuntimeEventBus } from "../shared/events.js";
import { PUBLISH_GAME_TITLE_MAX_LENGTH } from "../shared/publish-v1.js";
import { matchesBearerToken } from "./access.js";
import { AgentManager, createPiSession, loadConversation, type SessionFactory } from "./agent.js";
import { activePiToolNames, createAgentTools } from "./agent-tools.js";
import { ConversationManager } from "./conversations.js";
import { ArtifactBuilder, PublishError } from "./publish/archive.js";
import { RemotePublisher, RemotePublishError } from "./publish/client.js";
import { PreviewManager } from "./preview.js";
import { isRunnableWorkspace, ProjectManager } from "./projects.js";
import { OpenAIImageGenerator, type ImageGenerator } from "./openai-image.js";
import { ToolRunner, ToolRunError } from "./tools.js";
import { ToolSettingsStore } from "./tool-settings.js";
import { getWorkspaceMedia, listWorkspaceFiles, readWorkspaceFile, validateWorkspaceFile, WorkspaceError } from "./workspace.js";

export interface AppOptions {
  dataDirectory?: string;
  logger?: boolean;
  accessToken?: string;
  allowedOrigins?: string[];
  publishApiUrl?: string;
  publishToken?: string;
  publishFetch?: typeof fetch;
  createSession?: SessionFactory;
  imageGenerator?: ImageGenerator;
  imageApiKey?: string;
  imageApiUrl?: string;
  createModelRuntime?: () => Promise<ModelRuntime>;
}

const createProjectSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: { name: { type: "string", maxLength: PUBLISH_GAME_TITLE_MAX_LENGTH } },
  },
} as const;

const promptSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: {
      prompt: { type: "string", minLength: 1 },
      references: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["type", "path"],
          properties: {
            type: { const: "workspace-file" },
            path: { type: "string", minLength: 1, maxLength: 1_000 },
          },
        },
      },
    },
  },
} as const;

const renameConversationSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: { title: { type: "string", minLength: 1, maxLength: 80 } },
  },
} as const;

const modelRefSchema = {
  type: "object",
  additionalProperties: false,
  required: ["provider", "id"],
  properties: {
    provider: { type: "string", minLength: 1, maxLength: 100 },
    id: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;

const setConversationModelSchema = { body: modelRefSchema } as const;

const removePendingPromptSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["turnId"],
    properties: { turnId: { type: "string", minLength: 1 } },
  },
} as const;

const toolRunSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: {
      prompt: { type: "string", minLength: 1, maxLength: 32_000 },
      size: { type: "string", enum: [...IMAGE_SIZES] },
    },
  },
} as const;

const addToolResultSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["runId", "fileName"],
    properties: {
      runId: { type: "string", minLength: 1, maxLength: 100 },
      fileName: { type: "string", minLength: 1, maxLength: 200 },
    },
  },
} as const;

const toolSettingsSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["enabledTools"],
    properties: {
      enabledTools: {
        type: "array",
        uniqueItems: true,
        items: { type: "string", enum: ["generate-image"] },
      },
    },
  },
} as const;

export function createApp(options: AppOptions = {}) {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const dataDirectory = options.dataDirectory ?? path.join(repositoryRoot, ".data");
  const events = new RuntimeEventBus();
  const projects = new ProjectManager(dataDirectory);
  const conversations = new ConversationManager();
  const publishing = new Set<string>();
  const artifacts = new ArtifactBuilder();
  const publisher = new RemotePublisher({
    apiUrl: options.publishApiUrl ?? process.env.PUBLISH_API_URL ?? "http://127.0.0.1:43130",
    token: options.publishToken ?? process.env.PUBLISH_TOKEN,
    fetch: options.publishFetch,
  });
  const previews = new PreviewManager(events);
  const tools = new ToolRunner(
    dataDirectory,
    options.imageGenerator ?? new OpenAIImageGenerator(
      options.imageApiKey ?? process.env.IMAGE_API_KEY,
      options.imageApiUrl ?? process.env.IMAGE_API_URL,
    ),
  );
  const toolSettings = new ToolSettingsStore(dataDirectory, tools.list().map((tool) => tool.id));
  let modelRuntimePromise: Promise<ModelRuntime> | undefined;
  const getModelRuntime = () => modelRuntimePromise ??= (options.createModelRuntime ?? (() => ModelRuntime.create()))();
  const agents = new AgentManager(events, {
    createSession: options.createSession ?? (async (project, conversation) => {
      const modelRuntime = await getModelRuntime();
      const selected = conversations.model(project, conversation);
      const model = selected && modelRuntime.hasConfiguredAuth(selected.provider)
        ? modelRuntime.getModel(selected.provider, selected.id)
        : undefined;
      return createPiSession(
        project.workspacePath,
        conversations.open(project, conversation),
        createAgentTools(project, tools, projects),
        modelRuntime,
        model,
      );
    }),
    activeToolNames: () => activePiToolNames(toolSettings.get()),
    onRunCompleted: (project) => {
      if (project.preview.status === "ready" || project.preview.status === "starting") return;
      void isRunnableWorkspace(project.workspacePath).then((runnable) => {
        if (runnable) return previews.start(project).catch(() => {});
      });
    },
  });
  const app = Fastify({
    logger: options.logger ?? false,
    ajv: { customOptions: { coerceTypes: false } },
  });

  app.addHook("onReady", async () => {
    await Promise.all([projects.load(), tools.load(), toolSettings.load()]);
  });

  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-headers", "authorization, content-type, last-event-id");
      reply.header("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      reply.header("vary", "Origin");
    }
    if (request.method === "OPTIONS") return reply.code(204).send();
    if (!options.accessToken) return;
    if (!matchesBearerToken(request.headers.authorization, options.accessToken)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/tools", async () => tools.list());

  app.get("/tool-settings", async () => toolSettings.get());

  app.put<{ Body: ToolSettings }>("/tool-settings", { schema: toolSettingsSchema }, async (request) => {
    return toolSettings.update(request.body.enabledTools);
  });

  app.post<{ Params: { toolId: string }; Body: RunImageToolRequest }>(
    "/tools/:toolId/runs",
    { schema: toolRunSchema },
    async (request, reply) => {
      try {
        return reply.code(201).send(await tools.run(request.params.toolId, request.body));
      } catch (cause) {
        if (cause instanceof ToolRunError) return reply.code(cause.statusCode).send({ error: cause.message });
        throw cause;
      }
    },
  );

  app.get<{ Params: { runId: string; fileName: string } }>(
    "/tool-runs/:runId/files/:fileName",
    async (request, reply) => {
      const file = await tools.file(request.params.runId, request.params.fileName);
      if (!file) return reply.code(404).send({ error: "Tool output not found" });
      reply.header("content-type", file.mediaType);
      reply.header("x-content-type-options", "nosniff");
      reply.header("cache-control", "private, max-age=31536000, immutable");
      return reply.send(file.bytes);
    },
  );

  app.post<{ Params: { projectId: string }; Body: AddToolResultRequest }>(
    "/projects/:projectId/tool-results",
    { schema: addToolResultSchema },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const file = await tools.file(request.body.runId, request.body.fileName);
      if (!file) return reply.code(404).send({ error: "Tool output not found" });
      const fileName = `image-${request.body.runId}${path.extname(request.body.fileName).toLowerCase()}`;
      return reply.code(201).send({
        path: await projects.addGeneratedAsset(project.id, fileName, file.bytes),
      });
    },
  );

  app.post<{ Body: CreateProjectRequest }>("/projects", { schema: createProjectSchema }, async (request, reply) => {
    const project = await projects.create(request.body?.name);
    return reply.code(201).send(project);
  });

  app.get("/projects", async () => projects.list());

  app.get("/community/games", async (_request, reply) => {
    try {
      return await publisher.community();
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      return reply.code(cause instanceof RemotePublishError ? cause.statusCode : 502).send({ error });
    }
  });

  app.get<{ Params: { projectId: string } }>("/projects/:projectId", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    return project ?? reply.code(404).send({ error: "Project not found" });
  });

  app.get<{ Params: { projectId: string } }>("/projects/:projectId/files", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    return listWorkspaceFiles(project.workspacePath);
  });

  app.get<{ Params: { projectId: string }; Querystring: { path?: string } }>(
    "/projects/:projectId/files/content",
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      if (!request.query.path) return reply.code(400).send({ error: "File path is required" });
      try {
        return await readWorkspaceFile(project.workspacePath, request.query.path);
      } catch (cause) {
        if (cause instanceof WorkspaceError) return reply.code(400).send({ error: cause.message });
        throw cause;
      }
    },
  );

  app.get<{ Params: { projectId: string }; Querystring: { path?: string } }>(
    "/projects/:projectId/files/raw",
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      if (!request.query.path) return reply.code(400).send({ error: "File path is required" });
      try {
        const media = await getWorkspaceMedia(project.workspacePath, request.query.path);
        return reply
          .type(media.contentType)
          .header("content-length", media.size)
          .header("cache-control", "no-store")
          .header("x-content-type-options", "nosniff")
          .send(createReadStream(media.absolutePath));
      } catch (cause) {
        if (cause instanceof WorkspaceError) return reply.code(400).send({ error: cause.message });
        throw cause;
      }
    },
  );

  app.get<{ Params: { projectId: string } }>("/projects/:projectId/conversations", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    return conversations.list(project);
  });

  app.get("/models", async () => {
    const models = await (await getModelRuntime()).getAvailable();
    const piSettings = SettingsManager.create(dataDirectory, getAgentDir());
    const defaultProvider = piSettings.getDefaultProvider();
    const defaultId = piSettings.getDefaultModel();
    const defaultModel = models.find(({ provider, id }) => provider === defaultProvider && id === defaultId);
    return {
      models: models.map(({ provider, id, name }) => ({ provider, id, name })),
      ...(defaultModel ? { defaultModel: { provider: defaultModel.provider, id: defaultModel.id } } : {}),
    };
  });

  app.post<{ Params: { projectId: string }; Body: CreateConversationRequest }>(
    "/projects/:projectId/conversations",
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      if (!isCreateConversationRequest(request.body)) {
        return reply.code(400).send({ error: "Invalid conversation request" });
      }
      const model = request.body?.model;
      if (model && !(await availableModel(getModelRuntime, model.provider, model.id))) {
        return reply.code(400).send({ error: "Model is not available" });
      }
      const conversation = await conversations.create(project, model);
      return reply.code(201).send(agents.state(conversation, model));
    },
  );

  app.get<{ Params: { projectId: string; conversationId: string }; Querystring: { reset?: string } }>(
    "/projects/:projectId/conversations/:conversationId",
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const conversation = await conversations.get(project, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      const state = agents.state(conversation, conversations.model(project, conversation));
      const reset = request.query.reset === "1";
      const currentRun = state.agent.status === "running" || state.agent.status === "cancelling"
        ? events.since(project.id).findLast((event) =>
          event.type === "agent.started" && event.conversationId === conversation.summary.id)
        : undefined;
      return {
        conversation: state,
        items: loadConversation(
          project.workspacePath,
          conversation.sessionPath,
          reset ? undefined : currentRun?.timestamp,
          !currentRun,
        ),
        cursor: reset || !currentRun ? events.cursor() : currentRun.id - 1,
        activeTurn: agents.activeTurn(project.id),
        pendingPrompt: agents.pendingPrompt(project.id, conversation.summary.id),
      };
    },
  );

  app.patch<{ Params: { projectId: string; conversationId: string }; Body: RenameConversationRequest }>(
    "/projects/:projectId/conversations/:conversationId",
    { schema: renameConversationSchema },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      try {
        const conversation = await conversations.rename(project, request.params.conversationId, request.body.title);
        return conversation ?? reply.code(404).send({ error: "Conversation not found" });
      } catch (cause) {
        return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  );

  app.put<{ Params: { projectId: string; conversationId: string }; Body: SetConversationModelRequest }>(
    "/projects/:projectId/conversations/:conversationId/model",
    { schema: setConversationModelSchema },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const conversation = await conversations.get(project, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      const model = await availableModel(getModelRuntime, request.body.provider, request.body.id);
      if (!model) return reply.code(400).send({ error: "Model is not available" });
      try {
        await agents.setModel(project.id, conversation.summary.id, model, () => {
          conversations.setModel(project, conversation, request.body);
        });
        return request.body;
      } catch (cause) {
        return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  );

  app.post<{ Params: { projectId: string } }>("/projects/:projectId/preview", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (!(await isRunnableWorkspace(project.workspacePath))) {
      return reply.code(409).send({ error: "Workspace is not runnable yet" });
    }
    return { url: await previews.start(project) };
  });

  app.post<{ Params: { projectId: string; conversationId: string }; Body: PromptRequest }>(
    "/projects/:projectId/conversations/:conversationId/turns",
    { schema: promptSchema },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const conversation = await conversations.get(project, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      if (!request.body?.prompt?.trim()) return reply.code(400).send({ error: "Prompt must not be empty" });
      let references;
      try {
        references = await Promise.all((request.body.references ?? []).map(async (reference) => ({
          type: reference.type,
          path: await validateWorkspaceFile(project.workspacePath, reference.path),
        })));
      } catch (cause) {
        if (cause instanceof WorkspaceError) return reply.code(400).send({ error: cause.message });
        throw cause;
      }
      let turn;
      try {
        turn = agents.prompt(project, conversation, request.body.prompt, references);
      } catch (cause) {
        return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
      conversations.setInitialTitle(project.id, conversation.summary.id, request.body.prompt);
      return reply.code(202).send({ turnId: turn.turnId, queued: turn.queued });
    },
  );

  app.delete<{ Params: { projectId: string; conversationId: string }; Body: RemovePendingPromptRequest }>(
    "/projects/:projectId/conversations/:conversationId/pending-prompt",
    { schema: removePendingPromptSchema },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const conversation = await conversations.get(project, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      if (!agents.removePending(project.id, conversation.summary.id, request.body.turnId)) {
        return reply.code(409).send({ error: "Pending prompt has already changed" });
      }
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { projectId: string; conversationId: string; turnId: string } }>(
    "/projects/:projectId/conversations/:conversationId/turns/:turnId/cancel",
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const conversation = await conversations.get(project, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      await agents.cancel(project.id, conversation.summary.id, request.params.turnId);
      return reply.code(202).send({ accepted: true });
    },
  );

  app.post<{ Params: { projectId: string } }>("/projects/:projectId/publish", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (agents.isProjectBusy(project.id)) {
      return reply.code(409).send({ error: "Wait for the agent to finish before publishing" });
    }
    if (publishing.has(project.id)) return reply.code(409).send({ error: "Project is already being published" });
    publishing.add(project.id);
    events.publish(project.id, "publish.started", {});
    try {
      const result = await publisher.publish(project, await artifacts.create(project));
      await projects.setPublication(project.id, {
        gameId: result.game.id,
        deploymentId: result.game.deploymentId,
        playUrl: result.game.playUrl,
        publishedAt: result.game.publishedAt,
      });
      events.publish(project.id, "publish.completed", { game: result.game });
      return reply.code(201).send(result);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      events.publish(project.id, "publish.error", { error });
      const statusCode = cause instanceof PublishError || cause instanceof RemotePublishError ? cause.statusCode : 502;
      return reply.code(statusCode).send({ error });
    } finally {
      publishing.delete(project.id);
    }
  });

  app.get<{ Params: { projectId: string }; Querystring: { cursor?: string } }>("/projects/:projectId/events", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    const cursor = Number(request.query.cursor ?? request.headers["last-event-id"] ?? 0) || 0;
    if (!events.canReplay(project.id, cursor)) {
      return reply.code(409).send({ error: "Event cursor expired" });
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    reply.raw.write(": connected\n\n");
    const send = (event: RuntimeEvent) => reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    for (const event of events.since(project.id, cursor)) send(event);
    const unsubscribe = events.subscribe(project.id, send);
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
    request.raw.once("close", () => { clearInterval(heartbeat); unsubscribe(); });
  });

  app.addHook("onClose", async () => {
    await agents.close();
    await previews.stopAll();
    await artifacts.close();
  });
  return app;
}

async function availableModel(
  getRuntime: () => Promise<ModelRuntime>,
  provider: string,
  id: string,
) {
  const runtime = await getRuntime();
  const models = await runtime.getAvailable(provider);
  return models.find((model) => model.id === id);
}

function isCreateConversationRequest(value: unknown): value is CreateConversationRequest | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "model")) return false;
  if (body.model === undefined) return true;
  if (!body.model || typeof body.model !== "object" || Array.isArray(body.model)) return false;
  const model = body.model as Record<string, unknown>;
  return Object.keys(model).every((key) => key === "provider" || key === "id") &&
    typeof model.provider === "string" && model.provider.length > 0 && model.provider.length <= 100 &&
    typeof model.id === "string" && model.id.length > 0 && model.id.length <= 200;
}
