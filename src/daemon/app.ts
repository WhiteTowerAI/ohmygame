import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import Fastify from "fastify";
import { AGENT_REASONING_LEVELS, IMAGE_SIZES, type AddToolResultRequest, type AgentReasoningLevel, type ConversationAgentSettings, type CreateConversationRequest, type CreateProjectRequest, type ModelAuthMethod, type PromptRequest, type PublishProjectRequest, type RenameConversationRequest, type ReviseLastPromptRequest, type RunToolRequest, type RuntimeEvent, type SetConversationModelRequest, type SetConversationReasoningRequest, type ToolSettings, type UpdateImageGenerationSettings, type UpdateModel3DGenerationSettings } from "../shared/contracts.js";
import { RuntimeEventBus } from "../shared/events.js";
import { PUBLISH_GAME_TITLE_MAX_LENGTH } from "../shared/publish-v1.js";
import { clampReasoningLevel, parseReasoningLevel } from "../shared/reasoning.js";
import { matchesBearerToken } from "./access.js";
import { AgentManager, createPiSession, loadConversation, type RuntimeModel, type SessionFactory } from "./agent.js";
import { activePiToolNames, createAgentTools } from "./agent-tools.js";
import { ConversationManager } from "./conversations.js";
import { ArtifactBuilder, PublishError } from "./publish/archive.js";
import { RemotePublisher, RemotePublishError } from "./publish/client.js";
import { PreviewManager } from "./preview.js";
import { PortalClient } from "./portal-client.js";
import { PortalConnection } from "./portal-connection.js";
import { isRunnableWorkspace, ProjectManager } from "./projects.js";
import { ApiSettingsStore } from "./api-settings.js";
import { ModelAuthError, ModelAuthManager } from "./model-auth.js";
import { ModelEndpointSettingsStore } from "./model-endpoint-settings.js";
import { Meshy3DGenerator, type Model3DGenerator } from "./meshy-3d.js";
import { ConfiguredImageGenerator, type ImageGenerator } from "./openai-image.js";
import { ToolRunner, ToolRunError } from "./tools.js";
import { InvalidToolSettingsError, ToolSettingsStore } from "./tool-settings.js";
import { getWorkspaceMedia, listWorkspaceFiles, readWorkspaceFile, validateWorkspaceFile, WorkspaceError } from "./workspace.js";

export interface AppOptions {
  dataDirectory?: string;
  logger?: boolean;
  accessToken?: string;
  allowedOrigins?: string[];
  publishApiUrl?: string;
  publishFetch?: typeof fetch;
  portalUrl?: string;
  portalFetch?: typeof fetch;
  createSession?: SessionFactory;
  imageGenerator?: ImageGenerator;
  imageApiKey?: string;
  imageApiUrl?: string;
  model3DGenerator?: Model3DGenerator;
  meshyApiKey?: string;
  meshyApiUrl?: string;
  createModelRuntime?: () => Promise<ModelRuntime>;
}

const createProjectSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: { name: { type: "string", maxLength: PUBLISH_GAME_TITLE_MAX_LENGTH } },
  },
} as const;

const renameProjectSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: { name: { type: "string", minLength: 1, maxLength: PUBLISH_GAME_TITLE_MAX_LENGTH } },
  },
} as const;

const publishProjectSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["accessToken"],
    properties: { accessToken: { type: "string", minLength: 1, maxLength: 10_000 } },
  },
} as const;

const promptSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: {
      prompt: { type: "string" },
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
      images: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["mediaType", "data"],
          properties: {
            mediaType: { enum: ["image/png", "image/jpeg", "image/webp", "image/gif"] },
            data: { type: "string", minLength: 1 },
          },
        },
      },
    },
  },
} as const;

const reviseLastPromptSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: { prompt: { type: "string", minLength: 1 } },
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
const setConversationReasoningSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["level"],
    properties: { level: { enum: AGENT_REASONING_LEVELS } },
  },
} as const;
const MAX_PROJECT_COVER_BYTES = 5 * 1024 * 1024;

const toolRunSchema = {
  body: {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["prompt"],
        properties: {
          prompt: { type: "string", minLength: 1, maxLength: 32_000 },
          size: { type: "string", enum: [...IMAGE_SIZES] },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["image"],
        properties: {
          image: {
            type: "object",
            additionalProperties: false,
            required: ["mediaType", "data"],
            properties: {
              mediaType: { enum: ["image/png", "image/jpeg"] },
              data: { type: "string", minLength: 1 },
            },
          },
        },
      },
    ],
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
    required: ["installedTools", "enabledTools"],
    properties: {
      installedTools: {
        type: "array",
        uniqueItems: true,
        items: { type: "string", enum: ["generate-image", "image-to-3d"] },
      },
      enabledTools: {
        type: "array",
        uniqueItems: true,
        items: { type: "string", enum: ["generate-image", "image-to-3d"] },
      },
    },
  },
} as const;

const modelAuthLoginSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["method"],
    properties: { method: { enum: ["api_key", "oauth"] } },
  },
} as const;

const modelAuthResponseSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["promptId", "value"],
    properties: {
      promptId: { type: "string", minLength: 1, maxLength: 100 },
      value: { type: "string", maxLength: 100_000 },
    },
  },
} as const;

const modelEndpointSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["baseUrl"],
    properties: { baseUrl: { type: "string", minLength: 1, maxLength: 2_000 } },
  },
} as const;

const portalConnectionSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["accessToken"],
    properties: { accessToken: { type: "string", minLength: 1, maxLength: 10_000 } },
  },
} as const;

const imageSettingsSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["apiUrl"],
    properties: {
      apiUrl: { type: "string", minLength: 1, maxLength: 2_000 },
      apiKey: { type: "string", maxLength: 100_000 },
    },
  },
} as const;

const TOOL_RUN_BODY_LIMIT = 25 * 1024 * 1024;

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
    fetch: options.publishFetch,
  });
  const previews = new PreviewManager(events);
  const imageSettings = new ApiSettingsStore(dataDirectory, "image-settings.json", "https://api.openai.com/v1", "Image", {
    apiKey: options.imageApiKey ?? process.env.IMAGE_API_KEY,
    apiUrl: options.imageApiUrl ?? process.env.IMAGE_API_URL,
  });
  const model3DSettings = new ApiSettingsStore(dataDirectory, "model-3d-settings.json", "https://api.meshy.ai", "3D", {
    apiKey: options.meshyApiKey ?? process.env.MESHY_API_KEY,
    apiUrl: options.meshyApiUrl ?? process.env.MESHY_API_URL,
  });
  const tools = new ToolRunner(
    dataDirectory,
    options.imageGenerator ?? new ConfiguredImageGenerator(() => imageSettings.resolve()),
    options.model3DGenerator ?? new Meshy3DGenerator(() => model3DSettings.resolve()),
  );
  const toolSettings = new ToolSettingsStore(dataDirectory, tools.list().map((tool) => tool.id));
  const openAIEndpoint = new ModelEndpointSettingsStore(
    dataDirectory,
    "openai-endpoint.json",
    "https://api.openai.com/v1",
    "OpenAI",
  );
  let modelRuntimePromise: Promise<ModelRuntime> | undefined;
  const getModelRuntime = () => modelRuntimePromise ??= (async () => {
    const runtime = await (options.createModelRuntime ?? (() => ModelRuntime.create()))();
    const baseUrl = openAIEndpoint.override();
    if (baseUrl) runtime.registerProvider("openai", { baseUrl });
    return runtime;
  })();
  const modelAuth = new ModelAuthManager(getModelRuntime);
  const portal = new PortalConnection(
    getModelRuntime,
    new PortalClient(options.portalUrl ?? process.env.OPEN_GAME_PORTAL_URL ?? "https://portal.open-game.ai", options.portalFetch),
  );
  const agents = new AgentManager(events, {
    createSession: options.createSession ?? (async (project, conversation) => {
      const modelRuntime = await getModelRuntime();
      const selected = conversations.model(project, conversation);
      const model = selected ? modelRuntime.getModel(selected.provider, selected.id) : undefined;
      if (selected && (!model || !modelRuntime.hasConfiguredAuth(selected.provider))) {
        throw new Error(`The selected model ${selected.provider}/${selected.id} is not available`);
      }
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

  app.addContentTypeParser("image/webp", { parseAs: "buffer", bodyLimit: MAX_PROJECT_COVER_BYTES }, (_request, body, done) => {
    done(null, body);
  });

  app.addHook("onReady", async () => {
    await Promise.all([projects.load(), tools.load(), toolSettings.load(), imageSettings.load(), model3DSettings.load(), openAIEndpoint.load()]);
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

  app.put<{ Body: ToolSettings }>("/tool-settings", { schema: toolSettingsSchema }, async (request, reply) => {
    try {
      return await toolSettings.update(request.body);
    } catch (cause) {
      if (cause instanceof InvalidToolSettingsError) return reply.code(400).send({ error: cause.message });
      throw cause;
    }
  });

  app.post<{ Params: { toolId: string }; Body: RunToolRequest }>(
    "/tools/:toolId/runs",
    { schema: toolRunSchema, bodyLimit: TOOL_RUN_BODY_LIMIT },
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
      const prefix = path.extname(request.body.fileName).toLowerCase() === ".glb" ? "model" : "image";
      const fileName = `${prefix}-${request.body.runId}${path.extname(request.body.fileName).toLowerCase()}`;
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

  app.patch<{ Params: { projectId: string }; Body: { name: string } }>(
    "/projects/:projectId",
    { schema: renameProjectSchema },
    async (request, reply) => {
      try {
        return await projects.rename(request.params.projectId, request.body.name);
      } catch (cause) {
        return reply.code((cause as Error).message.startsWith("Project not found") ? 404 : 400).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  );

  app.post<{ Params: { projectId: string } }>("/projects/:projectId/duplicate", async (request, reply) => {
    try {
      return reply.code(201).send(await projects.duplicate(request.params.projectId));
    } catch (cause) {
      return reply.code((cause as Error).message.startsWith("Project not found") ? 404 : 400).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  });

  app.delete<{ Params: { projectId: string } }>("/projects/:projectId", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (agents.isProjectBusy(project.id)) return reply.code(409).send({ error: "Wait for the agent to finish before deleting this project" });
    await previews.stop(project);
    agents.forgetProject(project.id);
    await projects.delete(project.id);
    return reply.code(204).send();
  });

  app.get("/community/games", async (_request, reply) => {
    try {
      return await publisher.community();
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      return reply.code(cause instanceof RemotePublishError ? cause.statusCode : 502).send({ error });
    }
  });

  app.get<{ Params: { gameId: string } }>("/community/games/:gameId", async (request, reply) => {
    try {
      return await publisher.communityGame(request.params.gameId);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      return reply.code(cause instanceof RemotePublishError ? cause.statusCode : 502).send({ error });
    }
  });

  app.get<{ Params: { projectId: string } }>("/projects/:projectId", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    return project ?? reply.code(404).send({ error: "Project not found" });
  });

  app.get<{ Params: { projectId: string } }>("/projects/:projectId/cover", async (request, reply) => {
    if (!projects.get(request.params.projectId)) return reply.code(404).send({ error: "Project not found" });
    const cover = await projects.cover(request.params.projectId);
    if (!cover) return reply.code(404).send({ error: "Project cover not found" });
    reply.header("content-type", "image/webp");
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    return reply.send(cover);
  });

  app.put<{ Params: { projectId: string }; Body: Buffer }>("/projects/:projectId/cover", async (request, reply) => {
    if (!projects.get(request.params.projectId)) return reply.code(404).send({ error: "Project not found" });
    if (!isWebp(request.body)) return reply.code(400).send({ error: "Project cover must be a WebP image" });
    await projects.setCover(request.params.projectId, request.body);
    return reply.code(204).send();
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
    const runtime = await getModelRuntime();
    const models = await runtime.getAvailable();
    const piSettings = SettingsManager.create(dataDirectory, getAgentDir());
    const defaultProvider = piSettings.getDefaultProvider();
    const defaultId = piSettings.getDefaultModel();
    const defaultModel = models.find(({ provider, id }) => provider === defaultProvider && id === defaultId);
    return {
      models: models.map((model) => ({
        provider: model.provider,
        providerName: runtime.getProvider(model.provider)?.name ?? model.provider,
        id: model.id,
        name: model.name,
        reasoningLevels: supportedReasoningLevels(model),
      })),
      ...(defaultModel ? { defaultModel: { provider: defaultModel.provider, id: defaultModel.id } } : {}),
      defaultReasoningLevel: parseReasoningLevel(piSettings.getDefaultThinkingLevel()) ?? "medium",
    };
  });

  app.get("/portal/connection", async () => portal.get());

  app.put<{ Body: { accessToken: string } }>(
    "/portal/connection",
    { schema: portalConnectionSchema },
    async (request, reply) => {
      const state = await portal.connect(request.body.accessToken);
      if (state.status === "error") return reply.code(502).send({ error: state.error });
      return state;
    },
  );

  app.delete("/portal/connection", async (_request, reply) => {
    await portal.disconnect();
    return reply.code(204).send();
  });

  app.get("/settings/providers", async () => {
    const piProviders = await modelAuth.providers();
    const portalState = portal.get();
    const image = await imageSettings.get();
    const model3d = await model3DSettings.get();
    const portalStatus = portalState.status === "connected"
      ? "connected"
      : portalState.status === "connecting"
        ? "connecting"
        : portalState.status === "error" ? "error" : "not_configured";
    const toolStatus = (configured: boolean) => configured ? "connected" as const : "not_configured" as const;
    return [
      ...piProviders
        .filter((provider) => provider.id !== "opengame")
        .map((provider) => ({ ...provider, kind: "pi" as const, status: provider.configured ? "connected" as const : "not_configured" as const })),
      {
        id: "opengame",
        name: "OpenGame Portal",
        configured: portalStatus === "connected",
        kind: "portal" as const,
        status: portalStatus,
        methods: [],
        ...(portalState.error ? { error: portalState.error } : {}),
      },
      {
        id: "image-generation",
        name: "Image generation",
        configured: image.hasApiKey,
        kind: "tool" as const,
        status: toolStatus(image.hasApiKey),
        methods: [{ type: "api_key" as const, label: "API key" }],
      },
      {
        id: "meshy",
        name: "Meshy",
        configured: model3d.hasApiKey,
        kind: "tool" as const,
        status: toolStatus(model3d.hasApiKey),
        methods: [{ type: "api_key" as const, label: "API key" }],
      },
    ].sort((left, right) => left.name.localeCompare(right.name));
  });

  app.get("/settings/models/providers/openai/endpoint", async () => openAIEndpoint.get());

  app.put<{ Body: { baseUrl: string } }>(
    "/settings/models/providers/openai/endpoint",
    { schema: modelEndpointSchema },
    async (request, reply) => {
      try {
        const runtime = await getModelRuntime();
        const settings = await openAIEndpoint.update(request.body.baseUrl);
        const baseUrl = openAIEndpoint.override();
        if (baseUrl) runtime.registerProvider("openai", { baseUrl });
        else runtime.unregisterProvider("openai");
        return settings;
      } catch (cause) {
        return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  );

  app.post<{ Params: { providerId: string }; Body: { method: ModelAuthMethod } }>(
    "/settings/models/providers/:providerId/login",
    { schema: modelAuthLoginSchema },
    async (request, reply) => {
      try {
        return reply.code(202).send({ operationId: await modelAuth.start(request.params.providerId, request.body.method) });
      } catch (cause) {
        if (cause instanceof ModelAuthError) return reply.code(cause.statusCode).send({ error: cause.message });
        throw cause;
      }
    },
  );

  app.post<{ Params: { operationId: string }; Body: { promptId: string; value: string } }>(
    "/settings/model-auth/:operationId/respond",
    { schema: modelAuthResponseSchema },
    async (request, reply) => {
      try {
        modelAuth.respond(request.params.operationId, request.body.promptId, request.body.value);
        return reply.code(204).send();
      } catch (cause) {
        if (cause instanceof ModelAuthError) return reply.code(cause.statusCode).send({ error: cause.message });
        throw cause;
      }
    },
  );

  app.delete<{ Params: { operationId: string } }>("/settings/model-auth/:operationId", async (request, reply) => {
    try {
      modelAuth.cancel(request.params.operationId);
      return reply.code(204).send();
    } catch (cause) {
      if (cause instanceof ModelAuthError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
  });

  app.delete<{ Params: { providerId: string } }>("/settings/models/providers/:providerId/credential", async (request, reply) => {
    try {
      await modelAuth.logout(request.params.providerId);
      return reply.code(204).send();
    } catch (cause) {
      if (cause instanceof ModelAuthError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
  });

  app.get("/settings/image-generation", async () => imageSettings.get());

  app.put<{ Body: UpdateImageGenerationSettings }>(
    "/settings/image-generation",
    { schema: imageSettingsSchema },
    async (request, reply) => {
      try {
        return await imageSettings.update(request.body);
      } catch (cause) {
        return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  );

  app.get("/settings/model-3d-generation", async () => model3DSettings.get());

  app.put<{ Body: UpdateModel3DGenerationSettings }>(
    "/settings/model-3d-generation",
    { schema: imageSettingsSchema },
    async (request, reply) => {
      try {
        return await model3DSettings.update(request.body);
      } catch (cause) {
        return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  );

  app.post<{ Params: { projectId: string }; Body: CreateConversationRequest }>(
    "/projects/:projectId/conversations",
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      if (!isCreateConversationRequest(request.body)) {
        return reply.code(400).send({ error: "Invalid conversation request" });
      }
      const model = request.body?.model;
      const selectedModel = model ? await availableModel(getModelRuntime, model.provider, model.id) : undefined;
      if (model && !selectedModel) {
        return reply.code(400).send({ error: "Model is not available" });
      }
      if (request.body?.reasoningLevel && selectedModel && !supportedReasoningLevels(selectedModel).includes(request.body.reasoningLevel)) {
        return reply.code(400).send({ error: "Reasoning level is not available for this model" });
      }
      const conversation = await conversations.create(project, model, request.body?.reasoningLevel);
      return reply.code(201).send({
        ...agents.state(conversation, model),
        ...(selectedModel ? {
          reasoningLevel: effectiveReasoningLevel(selectedModel, request.body?.reasoningLevel, defaultReasoningLevel(project.workspacePath)),
        } : {}),
      });
    },
  );

  app.get<{ Params: { projectId: string; conversationId: string }; Querystring: { reset?: string } }>(
    "/projects/:projectId/conversations/:conversationId",
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const conversation = await conversations.get(project, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      const modelRef = conversations.model(project, conversation);
      const model = modelRef ? (await getModelRuntime()).getModel(modelRef.provider, modelRef.id) : undefined;
      const state = {
        ...agents.state(conversation, modelRef),
        ...(model ? {
          reasoningLevel: effectiveReasoningLevel(
            model,
            conversations.reasoningLevel(project, conversation),
            defaultReasoningLevel(project.workspacePath),
          ),
        } : {}),
      };
      const currentRun = agents.activeStart(project.id, conversation.summary.id);
      const activeItem = agents.activeItem(project.id, conversation.summary.id);
      const restoreActiveItem = Boolean(activeItem?.images?.length);
      return {
        conversation: state,
        items: [
          ...loadConversation(
            project.workspacePath,
            conversation.sessionPath,
            currentRun?.timestamp,
            !currentRun,
          ),
          ...(restoreActiveItem && activeItem ? [activeItem] : []),
        ],
        cursor: !currentRun ? events.cursor() : restoreActiveItem ? currentRun.id : currentRun.id - 1,
        activeTurn: agents.activeTurn(project.id, conversation.summary.id),
        pendingPrompts: agents.pendingPrompts(project.id, conversation.summary.id),
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
        return {
          model: request.body,
          reasoningLevel: effectiveReasoningLevel(
            model,
            conversations.reasoningLevel(project, conversation),
            defaultReasoningLevel(project.workspacePath),
          ),
        } satisfies ConversationAgentSettings;
      } catch (cause) {
        return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  );

  app.put<{ Params: { projectId: string; conversationId: string }; Body: SetConversationReasoningRequest }>(
    "/projects/:projectId/conversations/:conversationId/reasoning",
    { schema: setConversationReasoningSchema },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const conversation = await conversations.get(project, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      const modelRef = conversations.model(project, conversation);
      if (!modelRef) return reply.code(409).send({ error: "Select a model before changing reasoning" });
      const model = await availableModel(getModelRuntime, modelRef.provider, modelRef.id);
      if (!model) return reply.code(400).send({ error: "Model is not available" });
      const levels = supportedReasoningLevels(model);
      if (!levels.includes(request.body.level)) {
        return reply.code(400).send({ error: "Reasoning level is not available for this model" });
      }
      try {
        const active = await agents.setReasoningLevel(project.id, conversation.summary.id, request.body.level, () => {
          conversations.setReasoningLevel(project, conversation, request.body.level);
        });
        return { level: active ?? request.body.level };
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
    { schema: promptSchema, bodyLimit: Number.MAX_SAFE_INTEGER },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const conversation = await conversations.get(project, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      if (!request.body?.prompt?.trim() && !request.body?.images?.length) return reply.code(400).send({ error: "Prompt or image is required" });
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
      await projects.touch(project.id);
      let turn;
      try {
        turn = agents.prompt(project, conversation, request.body.prompt, references, request.body.images ?? []);
        if (turn.queued) await turn.result;
      } catch (cause) {
        return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
      conversations.setInitialTitle(project.id, conversation.summary.id, request.body.prompt);
      return reply.code(202).send({ turnId: turn.turnId, queued: turn.queued });
    },
  );

  app.post<{ Params: { projectId: string; conversationId: string }; Body: ReviseLastPromptRequest }>(
    "/projects/:projectId/conversations/:conversationId/revise-last",
    { schema: reviseLastPromptSchema },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const conversation = await conversations.get(project, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      if (!request.body.prompt.trim()) return reply.code(400).send({ error: "Prompt is required" });
      try {
        const turn = await agents.reviseLast(project, conversation, request.body.prompt, async (reference) => ({
          type: reference.type,
          path: await validateWorkspaceFile(project.workspacePath, reference.path),
        }));
        await projects.touch(project.id);
        return reply.code(202).send({ turnId: turn.turnId, queued: false });
      } catch (cause) {
        if (cause instanceof WorkspaceError) return reply.code(400).send({ error: cause.message });
        return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  );

  app.delete<{ Params: { projectId: string; conversationId: string; turnId: string } }>(
    "/projects/:projectId/conversations/:conversationId/queue/:turnId",
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const conversation = await conversations.get(project, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      try {
        if (!(await agents.removePending(project.id, conversation.summary.id, request.params.turnId))) {
          return reply.code(409).send({ error: "Queued message has already started" });
        }
      } catch (cause) {
        return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { projectId: string; conversationId: string; turnId: string } }>(
    "/projects/:projectId/conversations/:conversationId/queue/:turnId/steer",
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const conversation = await conversations.get(project, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      try {
        if (!(await agents.steerPending(project.id, conversation.summary.id, request.params.turnId))) {
          return reply.code(409).send({ error: "Queued message has already started" });
        }
      } catch (cause) {
        return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) });
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

  app.post<{ Params: { projectId: string }; Body: PublishProjectRequest }>(
    "/projects/:projectId/publish",
    { schema: publishProjectSchema },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      if (agents.isProjectBusy(project.id)) {
        return reply.code(409).send({ error: "Wait for the agent to finish before publishing" });
      }
      if (publishing.has(project.id)) return reply.code(409).send({ error: "Project is already being published" });
      publishing.add(project.id);
      events.publish(project.id, "publish.started", {});
      try {
        const result = await publisher.publish(project, await artifacts.create(project), request.body.accessToken);
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
    },
  );

  app.get<{ Params: { projectId: string }; Querystring: { cursor?: string } }>("/projects/:projectId/events", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    const cursor = Number(request.query.cursor ?? request.headers["last-event-id"] ?? 0) || 0;
    if (!events.canReplay(project.id, cursor)) {
      return reply.code(409).send({ error: "Event cursor expired" });
    }
    const headers = reply.getHeaders();
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined) reply.raw.setHeader(name, value);
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    reply.raw.write(": connected\n\n");
    const send = (event: RuntimeEvent) => {
      const images = agents.eventImages(event.projectId, event.conversationId, event.turnId);
      const hydrated = images?.length && (event.type === "agent.started" || event.type === "prompt.queued")
        ? { ...event, data: { ...event.data, images } }
        : event;
      reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(hydrated)}\n\n`);
    };
    for (const event of events.since(project.id, cursor)) send(event);
    const unsubscribe = events.subscribe(project.id, send);
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
    request.raw.once("close", () => { clearInterval(heartbeat); unsubscribe(); });
  });

  app.get<{ Params: { operationId: string }; Querystring: { cursor?: string } }>("/settings/model-auth/:operationId/events", async (request, reply) => {
    const cursor = Number(request.query.cursor ?? request.headers["last-event-id"] ?? 0) || 0;
    try {
      const history = modelAuth.eventsSince(request.params.operationId, cursor);
      const headers = reply.getHeaders();
      for (const [name, value] of Object.entries(headers)) {
        if (value !== undefined) reply.raw.setHeader(name, value);
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      reply.raw.write(": connected\n\n");
      const send = (event: ReturnType<typeof modelAuth.eventsSince>[number]) => {
        reply.raw.write(`id: ${event.id}\nevent: model-auth\ndata: ${JSON.stringify(event)}\n\n`);
        if (event.type === "completed" || event.type === "cancelled" || event.type === "error") reply.raw.end();
      };
      for (const event of history) {
        send(event);
        if (reply.raw.writableEnded) return;
      }
      const unsubscribe = modelAuth.subscribe(request.params.operationId, send);
      const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
      request.raw.once("close", () => { clearInterval(heartbeat); unsubscribe(); });
    } catch (cause) {
      if (cause instanceof ModelAuthError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
  });

  app.addHook("onClose", async () => {
    modelAuth.close();
    await agents.close();
    await previews.stopAll();
    await artifacts.close();
  });
  return app;
}

function isWebp(value: unknown): value is Buffer {
  return Buffer.isBuffer(value) && value.length >= 12 &&
    value.subarray(0, 4).toString("ascii") === "RIFF" &&
    value.subarray(8, 12).toString("ascii") === "WEBP";
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
  if (Object.keys(body).some((key) => key !== "model" && key !== "reasoningLevel")) return false;
  if (body.reasoningLevel !== undefined && !AGENT_REASONING_LEVELS.includes(body.reasoningLevel as AgentReasoningLevel)) return false;
  if (body.model === undefined) return true;
  if (!body.model || typeof body.model !== "object" || Array.isArray(body.model)) return false;
  const model = body.model as Record<string, unknown>;
  return Object.keys(model).every((key) => key === "provider" || key === "id") &&
    typeof model.provider === "string" && model.provider.length > 0 && model.provider.length <= 100 &&
    typeof model.id === "string" && model.id.length > 0 && model.id.length <= 200;
}

function supportedReasoningLevels(model: RuntimeModel): AgentReasoningLevel[] {
  if (!model.reasoning) return ["off"];
  return AGENT_REASONING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level !== "xhigh" && level !== "max" || mapped !== undefined;
  });
}

function effectiveReasoningLevel(
  model: RuntimeModel,
  requested: AgentReasoningLevel | undefined,
  fallback: AgentReasoningLevel,
): AgentReasoningLevel {
  return clampReasoningLevel(requested ?? fallback, supportedReasoningLevels(model));
}

function defaultReasoningLevel(cwd: string): AgentReasoningLevel {
  return parseReasoningLevel(SettingsManager.create(cwd, getAgentDir()).getDefaultThinkingLevel()) ?? "medium";
}
