import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import Fastify from "fastify";
import { AGENT_REASONING_LEVELS, IMAGE_ASPECT_RATIOS, IMAGE_OUTPUT_COUNTS, IMAGE_RESOLUTIONS, IMAGE_SIZES, MODEL_3D_POSES, MODEL_3D_QUALITIES, MODEL_3D_TEXTURE_RESOLUTIONS, VIDEO_ASPECT_RATIOS, VIDEO_RESOLUTIONS, type AddToolResultRequest, type AgentReasoningLevel, type AnswerQuestionnaireRequest, type ConversationAgentSettings, type ConversationCapabilities, type ConversationDetail, type CreateConversationRequest, type CreateProjectRequest, type ImportAssetRequest, type ModelAuthMethod, type ProjectState, type PromptRequest, type PublishAssetRequest, type PublishProjectRequest, type RenameConversationRequest, type ReviseLastPromptRequest, type RunToolRequest, type RuntimeEvent, type SetConversationModelRequest, type SetConversationReasoningRequest, type StoryDocument, type UpdateImageGenerationSettings, type UpdateModel3DGenerationSettings } from "../shared/contracts.js";
import { groupThreadItems } from "../shared/turns.js";
import { RuntimeEventBus } from "../shared/events.js";
import { isDefaultProjectName } from "../shared/project-names.js";
import { PUBLISH_ARTIFACT_MAX_BYTES, PUBLISH_ASSET_TITLE_MAX_LENGTH, PUBLISH_GAME_TITLE_MAX_LENGTH } from "../shared/publish-v1.js";
import { clampReasoningLevel, parseReasoningLevel } from "../shared/reasoning.js";
import { matchesBearerToken } from "./access.js";
import { AgentManager, createPiSession, loadConversation, loadPiSkillCatalog, loadPiSkills, type RuntimeModel, type SessionFactory } from "./agent.js";
import { activePiToolNames, createAgentTools, planningPiToolNames } from "./agent-tools.js";
import { ConversationManager, type StoredConversation } from "./conversations.js";
import { generateConversationTitle, generateProjectTitle, type TitleGenerator } from "./title-generation.js";
import { ArtifactBuilder, PublishError, createPluginArchive } from "./publish/archive.js";
import { RemotePublisher, RemotePublishError } from "./publish/client.js";
import { PreviewManager } from "./preview.js";
import { PortalClient } from "./portal-client.js";
import { PortalConnection } from "./portal-connection.js";
import { isRunnableWorkspace, ProjectAssetError, ProjectManager } from "./projects.js";
import { ApiSettingsStore } from "./api-settings.js";
import { ImageSettingsStore } from "./image-settings.js";
import { ModelAuthError, ModelAuthManager } from "./model-auth.js";
import { ModelEndpointSettingsStore } from "./model-endpoint-settings.js";
import { Meshy3DGenerator, type Model3DGenerator } from "./meshy-3d.js";
import type { ImageGenerator } from "./openai-image.js";
import { ProviderImages } from "./provider-images.js";
import { ToolRunner, ToolRunError } from "./tools.js";
import { PortalVideoGenerator, type VideoGenerator } from "./minimax-video.js";
import { BundledPluginAdapter, LocalPluginAdapter, PluginCatalogService, RemotePluginAdapter } from "./plugin-catalog.js";
import { BundledPluginStore } from "./bundled-plugins.js";
import { LocalPluginError, LocalPluginStore } from "./local-plugins.js";
import { inspectPluginSource, installCatalogPlugin, installPlugin } from "./plugin-installer.js";
import { InvalidPluginSettingsError, PluginSettingsStore } from "./plugin-settings.js";
import { PluginSkillContentError, readPluginSkillContent, resolvePluginSkillFile, resolvePluginSkills } from "./plugin-runtime.js";
import { listMcpServers } from "./pi-agent.js";
import { ConnectionError, ConnectionManager } from "./connections.js";
import { AssetTemplateError, AssetTemplateStore } from "./asset-templates.js";
import { isAssetTemplateDefinition, type CreateAssetTemplateRequest } from "../shared/asset-templates.js";
import type { SaveConnectionRequest } from "../shared/connections.js";
import { PLUGIN_MANIFEST_PATH, hasPluginMentionToken, isPluginManifest, type InstallPluginRequest, type PluginSettings, type PluginSummary } from "../shared/plugins.js";
import { getWorkspaceMedia, listWorkspaceFiles, readWorkspaceFile, validateWorkspaceFile, workspaceMediaInfo, WorkspaceError } from "./workspace.js";

export interface AppOptions {
  dataDirectory?: string;
  piAgentDirectory?: string;
  logger?: boolean;
  accessToken?: string;
  allowedOrigins?: string[];
  publishApiUrl?: string;
  publishFetch?: typeof fetch;
  portalUrl?: string;
  portalFetch?: typeof fetch;
  createSession?: SessionFactory;
  imageGenerator?: ImageGenerator;
  imageFetch?: typeof fetch;
  model3DGenerator?: Model3DGenerator;
  videoGenerator?: VideoGenerator;
  meshyApiKey?: string;
  meshyApiUrl?: string;
  createModelRuntime?: () => Promise<ModelRuntime>;
  generateConversationTitle?: TitleGenerator;
  generateProjectTitle?: TitleGenerator;
  bundledPluginsDirectory?: string;
}

const createProjectSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", maxLength: PUBLISH_GAME_TITLE_MAX_LENGTH },
      type: { type: "string", enum: ["web-game", "godot-game", "interactive-drama"] },
    },
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

const assetPathQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: { path: { type: "string", minLength: 1, maxLength: 1_000 } },
} as const;

const renameAssetSchema = {
  querystring: assetPathQuerySchema,
  body: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: { name: { type: "string", minLength: 1, maxLength: 200 } },
  },
} as const;

const connectionTransportSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "command", "args"],
      properties: {
        type: { const: "stdio" },
        command: { type: "string", minLength: 1 },
        args: { type: "array", items: { type: "string" } },
        env: { type: "object", additionalProperties: { type: "string" } },
        cwd: { type: "string", minLength: 1 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "url"],
      properties: {
        type: { const: "http" },
        url: { type: "string", minLength: 1 },
        headers: { type: "object", additionalProperties: { type: "string" } },
      },
    },
  ],
} as const;

const saveConnectionSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["id", "transport"],
    properties: {
      id: { type: "string", minLength: 1 },
      transport: connectionTransportSchema,
    },
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

const publishAssetSchema = {
  querystring: assetPathQuerySchema,
  body: publishProjectSchema.body,
} as const;

const importAssetSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["assetId"],
    properties: { assetId: { type: "string", minLength: 1, maxLength: 200 } },
  },
} as const;

const promptSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: {
      prompt: { type: "string" },
      mode: { enum: ["normal", "planning"] },
      mentions: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "displayName", "marketplaceId"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            displayName: { type: "string", minLength: 1, maxLength: 200 },
            marketplaceId: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
      },
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

const answerQuestionnaireSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["requestId"],
    properties: {
      requestId: { type: "string", minLength: 1 },
      cancelled: { type: "boolean" },
      answers: {
        type: "array",
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["questionId", "value"],
          properties: {
            questionId: { type: "string", minLength: 1, maxLength: 80 },
            value: { type: "string", minLength: 1, maxLength: 2_000 },
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
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      prompt: { type: "string", minLength: 1, maxLength: 32_000 },
      size: { type: "string", enum: [...IMAGE_SIZES] },
      resolution: { type: "string", enum: [...new Set([...IMAGE_RESOLUTIONS, ...VIDEO_RESOLUTIONS])] },
      aspectRatio: { type: "string", enum: [...new Set([...IMAGE_ASPECT_RATIOS, ...VIDEO_ASPECT_RATIOS])] },
      outputs: { type: "integer", enum: [...IMAGE_OUTPUT_COUNTS] },
      duration: { type: "integer", minimum: 4, maximum: 15 },
      model: { type: "string", enum: ["meshy-7"] },
      quality: { type: "string", enum: [...MODEL_3D_QUALITIES] },
      texture: { type: "boolean" },
      textureResolution: { type: "string", enum: [...MODEL_3D_TEXTURE_RESOLUTIONS] },
      pbr: { type: "boolean" },
      pose: { type: "string", enum: [...MODEL_3D_POSES] },
      image: {
        type: "object",
        additionalProperties: false,
        required: ["mediaType", "data"],
        properties: {
          mediaType: { enum: ["image/png", "image/jpeg", "image/webp"] },
          data: { type: "string", minLength: 1 },
        },
      },
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
    required: ["model"],
    properties: {
      model: {
        type: "object",
        additionalProperties: false,
        required: ["provider", "id"],
        properties: {
          provider: { type: "string", minLength: 1, maxLength: 100 },
          id: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
    },
  },
} as const;

const apiSettingsSchema = {
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
  const piAgentDirectory = options.piAgentDirectory ?? process.env.PI_CODING_AGENT_DIR ?? path.join(dataDirectory, "pi-agent");
  const events = new RuntimeEventBus();
  const projects = new ProjectManager(dataDirectory);
  const conversations = new ConversationManager();
  const projectsBeingNamed = new Set<string>();
  const publishing = new Set<string>();
  const artifacts = new ArtifactBuilder();
  const publisher = new RemotePublisher({
    apiUrl: options.publishApiUrl ?? process.env.PUBLISH_API_URL ?? "http://127.0.0.1:43130",
    fetch: options.publishFetch,
  });
  const assetTemplates = new AssetTemplateStore(dataDirectory);
  const previews = new PreviewManager(events);
  const imageSettings = new ImageSettingsStore(dataDirectory);
  const model3DSettings = new ApiSettingsStore(dataDirectory, "model-3d-settings.json", "https://api.meshy.ai", "3D", {
    apiKey: options.meshyApiKey ?? process.env.MESHY_API_KEY,
    apiUrl: options.meshyApiUrl ?? process.env.MESHY_API_URL,
  });
  const openAIEndpoint = new ModelEndpointSettingsStore(
    dataDirectory,
    "openai-endpoint.json",
    "https://api.openai.com/v1",
    "OpenAI",
  );
  let modelRuntimePromise: Promise<ModelRuntime> | undefined;
  const getModelRuntime = () => modelRuntimePromise ??= (async () => {
    const runtime = await (options.createModelRuntime ?? (() => ModelRuntime.create({
      authPath: path.join(piAgentDirectory, "auth.json"),
      modelsPath: path.join(piAgentDirectory, "models.json"),
    })))();
    const baseUrl = openAIEndpoint.override();
    if (baseUrl) runtime.registerProvider("openai", { baseUrl });
    return runtime;
  })();
  const generateConversationName = options.generateConversationTitle ?? (async (model, prompt) =>
    generateConversationTitle(await getModelRuntime(), model, prompt));
  const generateProjectName = options.generateProjectTitle ?? (async (model, prompt) =>
    generateProjectTitle(await getModelRuntime(), model, prompt));
  const conversationModel = (project: ProjectState, conversation: StoredConversation) => {
    const selected = conversations.model(project, conversation);
    if (selected) return selected;
    const settings = SettingsManager.create(project.workspacePath, piAgentDirectory);
    const provider = settings.getDefaultProvider();
    const id = settings.getDefaultModel();
    return provider && id ? { provider, id } : undefined;
  };
  const publishConversationRenamed = (conversation: StoredConversation["summary"]) => {
    events.publish(
      conversation.projectId,
      "conversation.renamed",
      { conversation },
      { conversationId: conversation.id },
    );
  };
  const publishProjectRenamed = (project: ProjectState) => {
    events.publish(project.id, "project.renamed", { project });
  };
  const modelAuth = new ModelAuthManager(getModelRuntime);
  const portal = new PortalConnection(
    getModelRuntime,
    new PortalClient(options.portalUrl ?? process.env.OPEN_GAME_PORTAL_URL ?? "https://portal.open-game.ai", options.portalFetch),
  );
  const providerImages = new ProviderImages(getModelRuntime, portal, () => imageSettings.get().model, options.imageFetch);
  const tools = new ToolRunner(
    dataDirectory,
    options.imageGenerator ?? providerImages,
    options.model3DGenerator ?? new Meshy3DGenerator(() => model3DSettings.resolve()),
    options.videoGenerator ?? new PortalVideoGenerator(() => portal.videoSource(), options.portalFetch),
  );
  const pluginSettings = new PluginSettingsStore(dataDirectory);
  const connections = new ConnectionManager(piAgentDirectory);
  const bundledPlugins = new BundledPluginStore(options.bundledPluginsDirectory ?? path.join(repositoryRoot, "plugins"));
  const mcpServers = { list: () => listMcpServers(piAgentDirectory) };
  const localPlugins = new LocalPluginStore(dataDirectory, {
    connections: async () => (await mcpServers.list()).map((server) => server.id),
  });
  const plugins = new PluginCatalogService([
    new BundledPluginAdapter(bundledPlugins),
    new LocalPluginAdapter(localPlugins),
    new RemotePluginAdapter(publisher),
  ], pluginSettings);
  const withConnectionStatus = async (plugin: Awaited<ReturnType<typeof plugins.read>>) => {
    if (!plugin) return plugin;
    const configured = new Map((await connections.list()).map((connection) => [connection.id, connection.enabled]));
    return {
      ...plugin,
      connections: plugin.connections.map((connection) => {
        const enabled = configured.get(connection.id);
        return {
          ...connection,
          enabled: enabled ?? false,
          status: enabled === undefined ? "not-configured" as const : enabled ? "enabled" as const : "disabled" as const,
        };
      }),
    };
  };
  let agents: AgentManager;
  agents = new AgentManager(events, {
    ...(options.createSession ? {} : {
      loadSkills: (project) => loadPiSkills(
        project.workspacePath,
        piAgentDirectory,
        () => resolvePluginSkills([bundledPlugins, localPlugins], pluginSettings),
      ),
    }),
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
        createAgentTools(
          project,
          tools,
          projects,
          (toolCallId, input, signal) => agents.askQuestionnaire(project.id, conversation.summary.id, toolCallId, input, signal),
          async (sourcePath) => {
            const installed = await localPlugins.install(sourcePath);
            invalidatePluginSessions();
            return await plugins.read(installed.id) ?? installed;
          },
        ),
        modelRuntime,
        model,
        piAgentDirectory,
        () => resolvePluginSkills([bundledPlugins, localPlugins], pluginSettings),
      );
    }),
    activeToolNames: (project, mode, session) => {
      const registered = session.getAllTools?.().map((tool) => tool.name) ?? [];
      if (mode === "planning") return planningPiToolNames();
      return activePiToolNames(tools.list().map((tool) => tool.id), registered);
    },
    onRunCompleted: (project) => {
      if (project.preview.status === "ready" || project.preview.status === "starting") return;
      void isRunnableWorkspace(project.workspacePath).then((runnable) => {
        if (runnable) return previews.start(project).catch(() => {});
      });
    },
  });
  const invalidatePluginSessions = () => {
    for (const project of projects.list()) agents.invalidateProjectSessions(project.id);
  };
  const app = Fastify({
    logger: options.logger ?? false,
    ajv: { customOptions: { coerceTypes: false } },
  });

  app.addContentTypeParser("image/webp", { parseAs: "buffer", bodyLimit: MAX_PROJECT_COVER_BYTES }, (_request, body, done) => {
    done(null, body);
  });

  app.addHook("onReady", async () => {
    await Promise.all([projects.load(), tools.load(), pluginSettings.load(), bundledPlugins.load(), imageSettings.load(), model3DSettings.load(), openAIEndpoint.load()]);
    await localPlugins.list();
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

  app.get("/settings/connections", async () => connections.list());

  app.post<{ Body: SaveConnectionRequest }>("/settings/connections", { schema: saveConnectionSchema }, async (request, reply) => {
    try {
      const connection = await connections.save(request.body);
      invalidatePluginSessions();
      return reply.code(201).send(connection);
    } catch (cause) {
      if (cause instanceof ConnectionError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
  });

  app.put<{ Params: { connectionId: string }; Body: SaveConnectionRequest }>("/settings/connections/:connectionId", { schema: saveConnectionSchema }, async (request, reply) => {
    try {
      const connection = await connections.save(request.body, request.params.connectionId);
      invalidatePluginSessions();
      return connection;
    } catch (cause) {
      if (cause instanceof ConnectionError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
  });

  app.patch<{ Params: { connectionId: string }; Body: { enabled: boolean } }>("/settings/connections/:connectionId/enabled", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["enabled"],
        properties: { enabled: { type: "boolean" } },
      },
    },
  }, async (request, reply) => {
    try {
      await connections.setEnabled(request.params.connectionId, request.body.enabled);
      invalidatePluginSessions();
      return reply.code(204).send();
    } catch (cause) {
      if (cause instanceof ConnectionError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
  });

  app.delete<{ Params: { connectionId: string } }>("/settings/connections/:connectionId", async (request, reply) => {
    try {
      await connections.remove(request.params.connectionId);
      invalidatePluginSessions();
      return reply.code(204).send();
    } catch (cause) {
      if (cause instanceof ConnectionError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
  });

  app.post("/plugins/authoring-session", async (_request, reply) => {
    const project = await projects.create("New Plugin", "web-game");
    const conversation = await conversations.create(project);
    return reply.code(201).send({ projectId: project.id, conversationId: conversation.summary.id });
  });

  const pluginInstallRequestSchema = {
    body: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "path"],
          properties: { type: { const: "directory" }, path: { type: "string", minLength: 1 }, candidate: { type: "string" } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "url"],
          properties: { type: { const: "git" }, url: { type: "string", minLength: 1 }, candidate: { type: "string" } },
        },
      ],
    },
  } as const;

  app.post<{ Body: InstallPluginRequest }>("/plugins/install", { schema: pluginInstallRequestSchema }, async (request, reply) => {
    try {
      const installed = await installPlugin(localPlugins, request.body);
      invalidatePluginSessions();
      return reply.code(201).send(pluginSettings.decorate(installed));
    } catch (cause) {
      if (cause instanceof LocalPluginError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
  });

  app.post<{ Params: { pluginId: string } }>("/plugins/:pluginId/install", async (request, reply) => {
    try {
      const available = await plugins.read(request.params.pluginId);
      if (!available || available.source.type !== "catalog") return reply.code(404).send({ error: "Catalog Plugin not found" });
      const remote = await publisher.explorePlugin(available.source.pluginId);
      const archive = await publisher.pluginContent(remote.id, remote.releaseId);
      const sha256 = createHash("sha256").update(archive).digest("hex");
      if (archive.length !== remote.artifactBytes || sha256 !== remote.artifactSha256) {
        return reply.code(502).send({ error: "Downloaded Plugin failed integrity verification" });
      }
      const installed = await installCatalogPlugin(localPlugins, {
        pluginId: remote.id, releaseId: remote.releaseId, manifest: remote.manifest, archive,
      });
      invalidatePluginSessions();
      return reply.code(201).send(pluginSettings.decorate(installed));
    } catch (cause) {
      const statusCode = cause instanceof LocalPluginError ? cause.statusCode
        : cause instanceof RemotePublishError ? cause.statusCode
        : 502;
      return reply.code(statusCode).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  });

  app.post<{ Params: { pluginId: string }; Body: { accessToken: string } }>("/plugins/:pluginId/publish", {
    schema: { body: publishProjectSchema.body },
  }, async (request, reply) => {
    const plugin = await localPlugins.read(request.params.pluginId);
    const source = plugin ? await localPlugins.installedPath(plugin.id) : undefined;
    if (!plugin || !source) return reply.code(404).send({ error: "Installed local Plugin not found" });
    try {
      const manifestValue = JSON.parse(await readFile(path.join(source, PLUGIN_MANIFEST_PATH), "utf8")) as unknown;
      if (!isPluginManifest(manifestValue)) return reply.code(400).send({ error: "Plugin manifest is invalid" });
      const result = await publisher.publishPlugin({
        name: manifestValue.name,
        manifest: manifestValue,
        archive: await createPluginArchive(source),
      }, request.body.accessToken);
      return reply.code(201).send(result);
    } catch (cause) {
      const statusCode = cause instanceof PublishError ? cause.statusCode
        : cause instanceof RemotePublishError ? cause.statusCode
        : 502;
      return reply.code(statusCode).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  });

  app.post<{ Body: InstallPluginRequest }>("/plugins/inspect", { schema: pluginInstallRequestSchema }, async (request, reply) => {
    try {
      const candidates = (await inspectPluginSource(request.body)).map(({ manifest: _manifest, ...candidate }) => candidate);
      return { candidates };
    } catch (cause) {
      if (cause instanceof LocalPluginError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
  });

  app.get("/plugins", async () => plugins.list());

  app.get("/composer/capabilities", async () => {
    const [catalog, skills] = await Promise.all([
      plugins.list(),
      loadPiSkillCatalog(
        path.join(dataDirectory, "home-composer"),
        piAgentDirectory,
        () => resolvePluginSkills([bundledPlugins, localPlugins], pluginSettings),
      ),
    ]);
    return {
      plugins: enabledPluginMentions(catalog.plugins),
      skills,
    } satisfies ConversationCapabilities;
  });

  app.get<{ Params: { pluginId: string } }>("/plugins/:pluginId", async (request, reply) => {
    const plugin = await withConnectionStatus(await plugins.read(request.params.pluginId));
    return plugin ?? reply.code(404).send({ error: "Plugin not found" });
  });

  const pluginSkillQuerySchema = {
    schema: {
      querystring: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: { id: { type: "string", minLength: 1, maxLength: 1_000 } },
      },
    },
  } as const;

  app.get<{ Params: { pluginId: string }; Querystring: { id: string } }>("/plugins/:pluginId/skill-content", pluginSkillQuerySchema, async (request, reply) => {
    const plugin = await plugins.read(request.params.pluginId);
    if (!plugin?.installed) return reply.code(404).send({ error: "Installed plugin not found" });
    try {
      const content = await readPluginSkillContent(plugin, request.query.id, [bundledPlugins, localPlugins]);
      return content === undefined
        ? reply.code(404).send({ error: "Plugin Skill not found" })
        : { id: request.query.id, content };
    } catch (cause) {
      if (cause instanceof PluginSkillContentError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
  });

  app.get<{ Params: { pluginId: string }; Querystring: { id: string } }>("/plugins/:pluginId/skill-file", pluginSkillQuerySchema, async (request, reply) => {
    const plugin = await plugins.read(request.params.pluginId);
    if (!plugin?.installed) return reply.code(404).send({ error: "Installed plugin not found" });
    const filePath = await resolvePluginSkillFile(plugin, request.query.id, [bundledPlugins, localPlugins]);
    return filePath ? { path: filePath } : reply.code(404).send({ error: "Plugin Skill not found" });
  });

  app.get<{ Params: { pluginId: string } }>("/plugins/:pluginId/directory", async (request, reply) => {
    const directoryPath = await localPlugins.directoryPath(request.params.pluginId);
    return directoryPath ? { path: directoryPath } : reply.code(404).send({ error: "Local plugin not found" });
  });

  app.put<{ Params: { pluginId: string }; Body: PluginSettings }>("/plugins/:pluginId/settings", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["enabled", "components"],
        properties: {
          enabled: { type: "boolean" },
          components: { type: "object", additionalProperties: { type: "boolean" } },
        },
      },
    },
  }, async (request, reply) => {
    const plugin = await plugins.read(request.params.pluginId);
    if (!plugin || !plugin.installed) return reply.code(404).send({ error: "Installed plugin not found" });
    try {
      await pluginSettings.update(plugin, request.body);
      invalidatePluginSessions();
      return withConnectionStatus(await plugins.read(plugin.id));
    } catch (cause) {
      if (cause instanceof InvalidPluginSettingsError) return reply.code(400).send({ error: cause.message });
      throw cause;
    }
  });

  app.delete<{ Params: { pluginId: string } }>("/plugins/:pluginId", async (request, reply) => {
    const plugin = await localPlugins.read(request.params.pluginId);
    if (!plugin) return reply.code(404).send({ error: "Installed plugin not found" });
    try {
      await localPlugins.remove(request.params.pluginId);
      await pluginSettings.remove(request.params.pluginId).catch((cause) => {
        app.log.warn({ err: cause, pluginId: request.params.pluginId }, "Could not remove stale plugin settings");
      });
      invalidatePluginSessions();
      return reply.code(204).send();
    } catch (cause) {
      if (cause instanceof LocalPluginError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
  });

  app.get("/tools", async () => tools.list());

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
      const extension = path.extname(request.body.fileName).toLowerCase();
      const prefix = extension === ".glb" ? "model" : extension === ".mp4" || extension === ".webm" ? "video" : "image";
      const outputSuffix = request.body.fileName.match(/^output(-[1-4])?\./)?.[1] ?? "";
      const fileName = `${prefix}-${request.body.runId}${outputSuffix}${extension}`;
      return reply.code(201).send({
        path: await projects.addGeneratedAsset(project.id, fileName, file.bytes, {
          ...(file.prompt ? { prompt: file.prompt } : {}),
          ...(file.preview ? {
            preview: {
              bytes: file.preview.bytes,
              extension: file.preview.mediaType === "image/png" ? "png" : "jpg",
            },
          } : {}),
        }),
      });
    },
  );

  app.post<{ Body: CreateProjectRequest }>("/projects", { schema: createProjectSchema }, async (request, reply) => {
    const project = await projects.create(request.body?.name, request.body?.type);
    return reply.code(201).send(project);
  });

  app.get("/projects", async () => projects.list());

  app.get<{ Params: { projectId: string } }>("/projects/:projectId/story", async (request, reply) => {
    try {
      return await projects.story(request.params.projectId);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return reply.code(message.startsWith("Project not found") ? 404 : 400).send({ error: message });
    }
  });

  app.put<{ Params: { projectId: string }; Body: StoryDocument }>("/projects/:projectId/story", {
    schema: { body: { type: "object" } },
    bodyLimit: 1_000_000,
  }, async (request, reply) => {
    try {
      await projects.setStory(request.params.projectId, request.body);
      return reply.code(204).send();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return reply.code(message.startsWith("Project not found") ? 404 : 400).send({ error: message });
    }
  });

  app.patch<{ Params: { projectId: string }; Body: { name: string } }>(
    "/projects/:projectId",
    { schema: renameProjectSchema },
    async (request, reply) => {
      try {
        const project = await projects.rename(request.params.projectId, request.body.name);
        publishProjectRenamed(project);
        return project;
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

  app.get("/explore/assets", async (_request, reply) => {
    try {
      return await publisher.exploreAssets();
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      return reply.code(cause instanceof RemotePublishError ? cause.statusCode : 502).send({ error });
    }
  });

  app.get("/asset-templates", async (_request, reply) => {
    try {
      return await assetTemplates.list();
    } catch (cause) {
      const statusCode = cause instanceof AssetTemplateError ? cause.statusCode : 500;
      return reply.code(statusCode).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  });

  app.post<{ Body: CreateAssetTemplateRequest }>("/asset-templates", async (request, reply) => {
    try {
      if (!isAssetTemplateDefinition(request.body)) throw new AssetTemplateError("Asset template is invalid");
      return reply.code(201).send(await assetTemplates.create(request.body));
    } catch (cause) {
      const statusCode = cause instanceof AssetTemplateError ? cause.statusCode : 500;
      return reply.code(statusCode).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  });

  app.post<{ Params: { templateId: string }; Body: PublishProjectRequest }>(
    "/asset-templates/:templateId/publish",
    { schema: { body: publishProjectSchema.body } },
    async (request, reply) => {
      try {
        const template = await assetTemplates.read(request.params.templateId);
        if (!template) return reply.code(404).send({ error: "Asset template not found" });
        const { id: _id, source: _source, createdAt: _createdAt, publication, ...definition } = template;
        const result = await publisher.publishTemplate({
          localId: template.id,
          templateId: publication?.templateId,
          definition,
        }, request.body.accessToken);
        await assetTemplates.setPublication(template.id, {
          templateId: result.template.id,
          releaseId: result.release.id,
          publishedAt: result.release.publishedAt,
        });
        return reply.code(201).send(result);
      } catch (cause) {
        const statusCode = cause instanceof AssetTemplateError ? cause.statusCode
          : cause instanceof RemotePublishError ? cause.statusCode
          : 502;
        return reply.code(statusCode).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  );

  app.get("/explore/templates", async (_request, reply) => {
    try {
      return (await publisher.exploreTemplates()).map((template) => ({ ...template, source: "catalog" as const }));
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      return reply.code(cause instanceof RemotePublishError ? cause.statusCode : 502).send({ error });
    }
  });

  app.get<{ Params: { assetId: string } }>("/explore/assets/:assetId/content", async (request, reply) => {
    try {
      const asset = await publisher.exploreAsset(request.params.assetId);
      const contents = await publisher.assetContent(asset.id, asset.releaseId);
      return reply.type(asset.contentType)
        .header("content-length", contents.length)
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .send(contents);
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

  app.patch<{ Params: { projectId: string }; Querystring: { path: string }; Body: { name: string } }>(
    "/projects/:projectId/assets",
    { schema: renameAssetSchema },
    async (request, reply) => {
      if (!projects.get(request.params.projectId)) return reply.code(404).send({ error: "Project not found" });
      try {
        return { path: await projects.renameAsset(request.params.projectId, request.query.path, request.body.name) };
      } catch (cause) {
        if (cause instanceof ProjectAssetError) return reply.code(cause.statusCode).send({ error: cause.message });
        if (cause instanceof WorkspaceError) return reply.code(400).send({ error: cause.message });
        throw cause;
      }
    },
  );

  app.delete<{ Params: { projectId: string }; Querystring: { path: string } }>(
    "/projects/:projectId/assets",
    { schema: { querystring: assetPathQuerySchema } },
    async (request, reply) => {
      if (!projects.get(request.params.projectId)) return reply.code(404).send({ error: "Project not found" });
      try {
        await projects.deleteAsset(request.params.projectId, request.query.path);
        return reply.code(204).send();
      } catch (cause) {
        if (cause instanceof WorkspaceError) return reply.code(400).send({ error: cause.message });
        throw cause;
      }
    },
  );

  app.post<{ Params: { projectId: string }; Querystring: { path: string }; Body: PublishAssetRequest }>(
    "/projects/:projectId/assets/publish",
    { schema: publishAssetSchema },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      try {
        const media = await getWorkspaceMedia(project.workspacePath, request.query.path);
        if (media.size > PUBLISH_ARTIFACT_MAX_BYTES) return reply.code(413).send({ error: "Asset is too large to share" });
        const publication = await projects.assetPublication(project.id, media.relativePath);
        const prompt = await projects.generatedAssetPrompt(project.id, media.relativePath);
        const result = await publisher.publishAsset({
          projectId: project.id,
          path: media.relativePath,
          title: (prompt?.trim() || path.parse(media.relativePath).name).slice(0, PUBLISH_ASSET_TITLE_MAX_LENGTH),
          mediaType: media.mediaType,
          fileName: path.basename(media.relativePath),
          contentType: media.contentType,
          contents: await readFile(media.absolutePath),
          ...(publication ? { assetId: publication.assetId } : {}),
        }, request.body.accessToken);
        await projects.setAssetPublication(project.id, media.relativePath, {
          assetId: result.asset.id,
          releaseId: result.release.id,
          publishedAt: result.release.publishedAt,
        });
        return reply.code(201).send(result);
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        const statusCode = cause instanceof WorkspaceError ? 400
          : cause instanceof RemotePublishError ? cause.statusCode
          : 502;
        return reply.code(statusCode).send({ error });
      }
    },
  );

  app.post<{ Params: { projectId: string }; Body: ImportAssetRequest }>(
    "/projects/:projectId/assets/import",
    { schema: importAssetSchema },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      try {
        const asset = await publisher.exploreAsset(request.body.assetId);
        const media = workspaceMediaInfo(asset.fileName);
        if (!media || media.mediaType !== asset.mediaType || media.contentType !== asset.contentType) {
          return reply.code(502).send({ error: "Remote asset metadata is invalid" });
        }
        const contents = await publisher.assetContent(asset.id, asset.releaseId);
        const sha256 = createHash("sha256").update(contents).digest("hex");
        if (contents.length !== asset.artifactBytes || sha256 !== asset.artifactSha256) {
          return reply.code(502).send({ error: "Downloaded asset failed integrity verification" });
        }
        return reply.code(201).send({ path: await projects.importAsset(project.id, asset.fileName, contents) });
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        const statusCode = cause instanceof ProjectAssetError ? cause.statusCode
          : cause instanceof RemotePublishError ? cause.statusCode
          : 502;
        return reply.code(statusCode).send({ error });
      }
    },
  );

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
    const piSettings = SettingsManager.create(dataDirectory, piAgentDirectory);
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
        .map((provider) => ({
          ...provider,
          kind: "pi" as const,
          status: provider.configured ? "connected" as const : "not_configured" as const,
          capabilities: provider.id === "openai" ? ["language", "image"] as const : ["language"] as const,
        })),
      {
        id: "opengame",
        name: "OpenGame Portal",
        configured: portalStatus === "connected",
        kind: "portal" as const,
        status: portalStatus,
        capabilities: ["language", "image", "video"] as const,
        methods: [],
        ...(portalState.error ? { error: portalState.error } : {}),
      },
      {
        id: "meshy",
        name: "Meshy",
        configured: model3d.hasApiKey,
        kind: "custom" as const,
        status: toolStatus(model3d.hasApiKey),
        capabilities: ["3d"] as const,
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

  app.get("/image-models", async () => providerImages.models());

  app.put<{ Body: UpdateImageGenerationSettings }>(
    "/settings/image-generation",
    { schema: imageSettingsSchema },
    async (request, reply) => {
      try {
        const models = await providerImages.models();
        const requested = request.body.model;
        if (!models.some((model) => model.provider === requested.provider && model.id === requested.id)) {
          return reply.code(400).send({ error: "Image model is not available" });
        }
        return await imageSettings.update(requested);
      } catch (cause) {
        return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  );

  app.get("/settings/model-3d-generation", async () => model3DSettings.get());

  app.put<{ Body: UpdateModel3DGenerationSettings }>(
    "/settings/model-3d-generation",
    { schema: apiSettingsSchema },
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
      return reply.code(201).send(conversation.summary);
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
      const planState = conversations.planState(project, conversation);
      agents.restorePlanState(conversation, planState);
      const activePlanState = agents.planState(conversation);
      const model = modelRef ? (await getModelRuntime()).getModel(modelRef.provider, modelRef.id) : undefined;
      const settings = {
        ...(modelRef ? { model: modelRef } : {}),
        ...(model ? {
          reasoningLevel: effectiveReasoningLevel(
            model,
            conversations.reasoningLevel(project, conversation),
            defaultReasoningLevel(project.workspacePath, piAgentDirectory),
          ),
        } : {}),
      };
      const currentRun = agents.activeStart(project.id, conversation.summary.id);
      const activeItems = agents.activeItems(project.id, conversation.summary.id);
      const restoreActiveItems = Boolean(activeItems.find((item) => item.type === "userMessage")?.images?.length);
      const loadedItems = [
        ...loadConversation(
          project.workspacePath,
          conversation.sessionPath,
          currentRun?.timestamp,
          !currentRun,
        ),
        ...(restoreActiveItems ? activeItems : []),
      ];
      return {
        conversation: conversation.summary,
        agent: agents.agentState(conversation),
        settings,
        plan: activePlanState,
        turns: groupThreadItems(
          conversation.summary.id,
          loadedItems,
          agents.activeTurnId(project.id, conversation.summary.id),
        ),
        cursor: !currentRun ? events.cursor() : restoreActiveItems ? currentRun.id : currentRun.id - 1,
        pendingPrompts: agents.pendingPrompts(project.id, conversation.summary.id),
      } satisfies ConversationDetail;
    },
  );

  app.get<{ Params: { projectId: string; conversationId: string } }>(
    "/projects/:projectId/conversations/:conversationId/capabilities",
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const conversation = await conversations.get(project, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      const [catalog, skills] = await Promise.all([
        plugins.list(),
        agents.skills(project, conversation),
      ]);
      return {
        plugins: enabledPluginMentions(catalog.plugins),
        skills,
      } satisfies ConversationCapabilities;
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
        if (conversation) publishConversationRenamed(conversation);
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
            defaultReasoningLevel(project.workspacePath, piAgentDirectory),
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
      let mentions;
      try {
        mentions = await plugins.validateMentions(request.body.mentions ?? []);
        if (mentions.some((mention) => !hasPluginMentionToken(request.body.prompt, mention))) {
          return reply.code(400).send({ error: "Plugin mention is missing from the prompt" });
        }
      } catch (cause) {
        return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
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
        turn = agents.prompt(project, conversation, request.body.prompt, references, request.body.images ?? [], request.body.mode ?? "normal", mentions);
        if (turn.queued) await turn.result;
      } catch (cause) {
        return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
      const provisional = conversations.setInitialTitle(project, conversation.summary.id, request.body.prompt);
      if (provisional) publishConversationRenamed(provisional);
      const expectedProjectName = isDefaultProjectName(project) && !projectsBeingNamed.has(project.id)
        ? project.name
        : undefined;
      if (provisional || expectedProjectName) {
        const model = conversationModel(project, conversation);
        if (model) {
          if (expectedProjectName) projectsBeingNamed.add(project.id);
          void (async () => {
            await turn.result?.catch(() => undefined);
            if (provisional) {
              try {
                const title = await generateConversationName(model, request.body.prompt);
                if (title) {
                  const updated = await conversations.renameIfCurrent(
                    project,
                    conversation.summary.id,
                    provisional.title,
                    title,
                  );
                  if (updated) publishConversationRenamed(updated);
                }
              } catch (cause) {
                request.log.debug({ err: cause }, "conversation title generation failed");
              }
            }
            if (!expectedProjectName) return;
            try {
              const name = await generateProjectName(model, request.body.prompt);
              if (!name) return;
              const updated = await projects.renameIfCurrent(project.id, expectedProjectName, name);
              if (updated) publishProjectRenamed(updated);
            } catch (cause) {
              request.log.debug({ err: cause }, "project title generation failed");
            } finally {
              projectsBeingNamed.delete(project.id);
            }
          })();
        }
      }
      return reply.code(202).send({ turnId: turn.turnId, queued: turn.queued });
    },
  );

  app.post<{ Params: { projectId: string; conversationId: string }; Body: { instructions?: string } }>(
    "/projects/:projectId/conversations/:conversationId/compact",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: { instructions: { type: "string", maxLength: 4_000 } },
        },
      },
    },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const conversation = await conversations.get(project, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      try {
        const turn = await agents.compact(project, conversation, request.body?.instructions?.trim() || undefined);
        await turn.result;
        return reply.code(204).send();
      } catch (cause) {
        return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  );

  app.get<{ Params: { projectId: string; conversationId: string } }>(
    "/projects/:projectId/conversations/:conversationId/context-usage",
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const conversation = await conversations.get(project, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      try {
        return { contextUsage: await agents.contextUsage(project, conversation) };
      } catch (cause) {
        return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  );

  app.post<{ Params: { projectId: string; conversationId: string } }>(
    "/projects/:projectId/conversations/:conversationId/plan/approve",
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const conversation = await conversations.get(project, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      agents.restorePlanState(conversation, conversations.planState(project, conversation));
      try {
        const turn = await agents.approvePlan(project, conversation);
        return reply.code(202).send({ turnId: turn.turnId, queued: false });
      } catch (cause) {
        return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  );

  app.delete<{ Params: { projectId: string; conversationId: string } }>(
    "/projects/:projectId/conversations/:conversationId/plan",
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const conversation = await conversations.get(project, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      agents.restorePlanState(conversation, conversations.planState(project, conversation));
      try {
        await agents.cancelPlan(project, conversation);
        return reply.code(204).send();
      } catch (cause) {
        return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  );

  app.post<{ Params: { projectId: string; conversationId: string } }>(
    "/projects/:projectId/conversations/:conversationId/plan/refine",
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const conversation = await conversations.get(project, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      agents.restorePlanState(conversation, conversations.planState(project, conversation));
      try {
        await agents.refinePlan(project, conversation);
        return reply.code(204).send();
      } catch (cause) {
        return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  );

  app.post<{ Params: { projectId: string; conversationId: string }; Body: AnswerQuestionnaireRequest }>(
    "/projects/:projectId/conversations/:conversationId/questionnaire",
    { schema: answerQuestionnaireSchema },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const conversation = await conversations.get(project, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      try {
        agents.answerQuestionnaire(
          project.id,
          conversation.summary.id,
          request.body.requestId,
          request.body.answers,
          request.body.cancelled,
        );
        return reply.code(204).send();
      } catch (cause) {
        return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
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

function enabledPluginMentions(plugins: readonly PluginSummary[]): ConversationCapabilities["plugins"] {
  return plugins
    .filter((plugin) => plugin.enabled)
    .map(({ id, name, displayName, description, marketplace }) => ({
      id,
      name,
      displayName,
      description,
      marketplaceId: marketplace.id,
      marketplaceDisplayName: marketplace.displayName,
    }));
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

function defaultReasoningLevel(cwd: string, agentDir: string): AgentReasoningLevel {
  return parseReasoningLevel(SettingsManager.create(cwd, agentDir).getDefaultThinkingLevel()) ?? "medium";
}
