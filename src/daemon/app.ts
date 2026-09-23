import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import Fastify, { type FastifyReply } from "fastify";
import { AGENT_REASONING_LEVELS, IMAGE_ASPECT_RATIOS, IMAGE_OUTPUT_COUNTS, IMAGE_RESOLUTIONS, IMAGE_SIZES, MODEL_3D_MODELS, MODEL_3D_POSES, MODEL_3D_QUALITIES, MODEL_3D_TEXTURE_RESOLUTIONS, VIDEO_ASPECT_RATIOS, VIDEO_RESOLUTIONS, type AddToolResultRequest, type AgentModelRef, type AgentReasoningLevel, type AnswerQuestionnaireRequest, type ConversationAgentSettings, type ConversationCapabilities, type ConversationDetail, type CreateConversationRequest, type CreateLibraryImageRequest, type CreateProjectRequest, type LibraryUploadMediaType, type ModelAuthMethod, type ProjectState, type PromptImage, type PromptRequest, type PublishProjectRequest, type RenameConversationRequest, type ReviseLastPromptRequest, type RunToolRequest, type RuntimeEvent, type SetConversationModelRequest, type SetConversationReasoningRequest, type StoryDocument, type StoryTextGenerationRequest, type UpdateAgentDefaultsRequest, type UpdateImageGenerationSettings } from "../shared/contracts.js";
import { findAgentModel, preferredAgentModel } from "../shared/agent-models.js";
import { groupThreadItems } from "../shared/turns.js";
import { RuntimeEventBus } from "../shared/events.js";
import { INTERACTIVE_DRAMA_STARTER } from "../shared/interactive-drama-starter.js";
import { createStoryDocument } from "../shared/story.js";
import { PUBLISH_GAME_TITLE_MAX_LENGTH, type CommunitySubjectType, type PublishPluginOrigin } from "../shared/publish-v1.js";
import { clampReasoningLevel, parseReasoningLevel } from "../shared/reasoning.js";
import { matchesBearerToken } from "./access.js";
import { AgentManager, createPiSession, loadConversation, loadPiSkillCatalog, loadPiSkills, type RuntimeModel, type SessionFactory } from "./agent.js";
import { createAgentTools, projectPiToolNames } from "./agent-tools.js";
import { ConversationManager, type StoredConversation } from "./conversations.js";
import { generateCreativeText } from "./text-generation.js";
import { ArtifactBuilder, PublishError, createPluginArchive } from "./publish/archive.js";
import { RemotePublisher, RemotePublishError } from "./publish/client.js";
import { PreviewManager } from "./preview.js";
import { AccountServiceClient } from "./account-service-client.js";
import { AccountConnection } from "./account-connection.js";
import { isRunnableWorkspace, previewWorkspaceStatus, ProjectAssetError, ProjectManager, ProjectStoryReferenceError, ProjectWorkspaceError } from "./projects.js";
import { ImageSettingsStore } from "./image-settings.js";
import { createInteractiveDramaStarterProject } from "./interactive-drama-starter.js";
import { ModelAuthError, ModelAuthManager } from "./model-auth.js";
import { ModelEndpointSettingsStore } from "./model-endpoint-settings.js";
import type { Model3DGenerator } from "./model3d.js";
import { Managed3DGenerator } from "./managed-3d.js";
import type { ImageGenerator } from "./openai-image.js";
import { ProviderImages } from "./provider-images.js";
import { ToolRunner, ToolRunError } from "./tools.js";
import { ManagedVideoGenerator, type VideoGenerator } from "./seedance-video.js";
import { BundledPluginAdapter, LocalPluginAdapter, PluginCatalogService, RemotePluginAdapter } from "./plugin-catalog.js";
import { BundledPluginStore } from "./bundled-plugins.js";
import { LocalPluginError, LocalPluginStore, type InstalledPluginBundle } from "./local-plugins.js";
import { inspectPluginSource, installCatalogPlugin, installPlugin } from "./plugin-installer.js";
import { InvalidPluginSettingsError, PluginSettingsStore } from "./plugin-settings.js";
import { PreinstalledPluginManager } from "./preinstalled-plugins.js";
import { PluginSkillContentError, readPluginSkillContent, resolvePluginSkillFile, resolvePluginSkills } from "./plugin-runtime.js";
import { listMcpServers } from "./pi-agent.js";
import { ConnectionError, ConnectionManager } from "./connections.js";
import { AssetTemplateError, AssetTemplateStore } from "./asset-templates.js";
import { AssetStudioDraftStore } from "./asset-studio-draft.js";
import type { AssetStudioDraft } from "../shared/asset-studio-draft.js";
import { isAssetTemplateDefinition, type CreateAssetTemplateRequest } from "../shared/asset-templates.js";
import type { SaveConnectionRequest } from "../shared/connections.js";
import { hasPluginMentionToken, isPluginVersion, type InstallPluginRequest, type PluginSettings, type PluginSummary } from "../shared/plugins.js";
import { getWorkspaceMedia, listWorkspaceFiles, readWorkspaceFile, validateWorkspaceFile, workspaceMediaInfo, WorkspaceError } from "./workspace.js";
import { AssetLibrary, AssetLibraryError } from "./asset-library.js";
import { AgentAttachmentError, AgentAttachmentStore, MAX_AGENT_ATTACHMENT_BYTES, MAX_AGENT_ATTACHMENTS_PER_TURN } from "./agent-attachments.js";
import type { PlaytestDriver } from "../shared/playtest.js";

export interface AppOptions {
  dataDirectory?: string;
  piAgentDirectory?: string;
  logger?: boolean;
  accessToken?: string;
  allowedOrigins?: string[];
  publishApiUrl?: string;
  publishFetch?: typeof fetch;
  accountServiceUrl?: string;
  accountServiceFetch?: typeof fetch;
  createSession?: SessionFactory;
  imageGenerator?: ImageGenerator;
  imageFetch?: typeof fetch;
  model3DGenerator?: Model3DGenerator;
  videoGenerator?: VideoGenerator;
  createModelRuntime?: () => Promise<ModelRuntime>;
  bundledPluginsDirectory?: string;
  preinstalledPluginsDirectory?: string;
  interactiveDramaPlayerDirectory?: string;
  interactiveDramaExamplesDirectory?: string;
  playtestDriver?: PlaytestDriver;
}

async function accountReply<T>(
  reply: FastifyReply,
  operation: () => Promise<T>,
): Promise<T | FastifyReply> {
  try {
    return await operation();
  } catch {
    return reply.code(502).send({ error: "OhMyGame account service is temporarily unavailable" });
  }
}

const createProjectSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", maxLength: PUBLISH_GAME_TITLE_MAX_LENGTH },
      type: { type: "string", enum: ["web-game", "godot-game", "interactive-drama"] },
      templateId: { type: "string", enum: [INTERACTIVE_DRAMA_STARTER.id] },
      storyViewport: {
        type: "object",
        additionalProperties: false,
        required: ["width", "height"],
        properties: {
          width: { type: "integer", minimum: 320, maximum: 4096 },
          height: { type: "integer", minimum: 320, maximum: 4096 },
        },
      },
      workspacePath: { type: "string", minLength: 1, maxLength: 4096 },
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

const publishAccessTokenBody = {
  type: "object",
  additionalProperties: false,
  required: ["accessToken"],
  properties: { accessToken: { type: "string", minLength: 1, maxLength: 10_000 } },
} as const;

const publicationStatusBody = {
  type: "object",
  additionalProperties: false,
  required: ["accessToken", "status"],
  properties: {
    accessToken: { type: "string", minLength: 1, maxLength: 10_000 },
    status: { enum: ["listed", "unlisted"] },
  },
} as const;

const communitySubjectParams = {
  type: "object",
  additionalProperties: false,
  required: ["type", "id"],
  properties: {
    type: { enum: ["game", "plugin", "template"] },
    id: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;

const communityLikeBody = {
  type: "object",
  additionalProperties: false,
  required: ["accessToken", "liked"],
  properties: {
    accessToken: { type: "string", minLength: 1, maxLength: 10_000 },
    liked: { type: "boolean" },
  },
} as const;

const publishProjectSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["accessToken", "title"],
    properties: {
      accessToken: { type: "string", minLength: 1, maxLength: 10_000 },
      title: { type: "string", minLength: 1, maxLength: 200 },
      description: { type: "string", maxLength: 2_000 },
    },
  },
} as const;

const publishPluginSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["accessToken"],
    properties: {
      accessToken: { type: "string", minLength: 1, maxLength: 10_000 },
      version: { type: "string", minLength: 1, maxLength: 256 },
    },
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
            name: { type: "string", minLength: 1, maxLength: 255 },
          },
        },
      },
      attachments: {
        type: "array",
        maxItems: MAX_AGENT_ATTACHMENTS_PER_TURN,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "batchId"],
          properties: {
            id: { type: "string", pattern: "^[a-fA-F0-9-]{36}$" },
            batchId: { type: "string", pattern: "^[a-fA-F0-9-]{36}$" },
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
const MAX_LIBRARY_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_LIBRARY_UPLOAD_BYTES = 200 * 1024 * 1024;
const LIBRARY_UPLOAD_MEDIA_TYPES = new Set<LibraryUploadMediaType>([
  "image/png", "image/jpeg", "image/webp",
  "video/mp4", "video/quicktime", "video/webm",
  "audio/mpeg", "audio/wav",
]);

const toolRunSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      prompt: { type: "string", minLength: 1, maxLength: 32_000 },
      imageModel: modelRefSchema,
      size: { type: "string", enum: [...IMAGE_SIZES] },
      resolution: { type: "string", enum: [...new Set([...IMAGE_RESOLUTIONS, ...VIDEO_RESOLUTIONS])] },
      aspectRatio: { type: "string", enum: [...new Set([...IMAGE_ASPECT_RATIOS, ...VIDEO_ASPECT_RATIOS])] },
      outputs: { type: "integer", enum: [...IMAGE_OUTPUT_COUNTS] },
      duration: { type: "integer", minimum: 4, maximum: 15 },
      model: { type: "string", enum: [...MODEL_3D_MODELS] },
      quality: { type: "string", enum: [...MODEL_3D_QUALITIES] },
      targetPolycount: { type: "integer", minimum: 100, maximum: 15_000 },
      texture: { type: "boolean" },
      textureResolution: { type: "string", enum: [...MODEL_3D_TEXTURE_RESOLUTIONS] },
      pbr: { type: "boolean" },
      pose: { type: "string", enum: [...MODEL_3D_POSES] },
      imageEnhancement: { type: "boolean" },
      title: { type: "string", minLength: 1, maxLength: 80 },
      image: {
        type: "object",
        additionalProperties: false,
        required: ["mediaType", "data"],
        properties: {
          mediaType: { enum: ["image/png", "image/jpeg", "image/webp"] },
          data: { type: "string", minLength: 1 },
        },
      },
      images: {
        type: "array",
        maxItems: 14,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["mediaType", "data"],
          properties: {
            mediaType: { enum: ["image/png", "image/jpeg", "image/webp"] },
            data: { type: "string", minLength: 1 },
          },
        },
      },
      references: {
        type: "array",
        maxItems: 15,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["type", "assetId"],
          properties: {
            type: { enum: ["image", "video", "audio"] },
            assetId: { type: "string", minLength: 1, maxLength: 100 },
          },
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

const accountConnectionSchema = {
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

const TOOL_RUN_BODY_LIMIT = 25 * 1024 * 1024;

export function createApp(options: AppOptions = {}) {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const dataDirectory = options.dataDirectory ?? path.join(repositoryRoot, ".data");
  const piAgentDirectory = options.piAgentDirectory ?? process.env.PI_CODING_AGENT_DIR ?? path.join(dataDirectory, "pi-agent");
  const events = new RuntimeEventBus();
  const library = new AssetLibrary(dataDirectory);
  const projects = new ProjectManager(dataDirectory, library);
  const attachments = new AgentAttachmentStore();
  const conversations = new ConversationManager();
  const publishing = new Set<string>();
  const artifacts = new ArtifactBuilder(library, options.interactiveDramaPlayerDirectory ?? path.join(repositoryRoot, "dist", "player"));
  const interactiveDramaExamplesDirectory = options.interactiveDramaExamplesDirectory ?? path.join(repositoryRoot, "examples", "interactive-drama");
  const publisher = new RemotePublisher({
    apiUrl: options.publishApiUrl ?? process.env.CLOUD_API_URL ?? process.env.PUBLISH_API_URL ?? "http://127.0.0.1:43130",
    fetch: options.publishFetch,
  });
  const assetTemplates = new AssetTemplateStore(dataDirectory);
  const assetStudioDraft = new AssetStudioDraftStore(dataDirectory);
  const previews = new PreviewManager(events);
  const imageSettings = new ImageSettingsStore(dataDirectory);
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
  const accountServiceClient = new AccountServiceClient(
    options.accountServiceUrl ?? process.env.CLOUD_API_URL ?? process.env.ACCOUNT_SERVICE_URL ?? "https://cloud.ohmygame.ai",
    options.accountServiceFetch,
  );
  const accountConnection = new AccountConnection(
    getModelRuntime,
    accountServiceClient,
  );
  const providerImages = new ProviderImages(getModelRuntime, accountConnection, () => imageSettings.get().model, options.imageFetch);
  const tools = new ToolRunner(
    dataDirectory,
    options.imageGenerator ?? providerImages,
    options.model3DGenerator ?? new Managed3DGenerator(() => accountConnection.model3DSource(), options.accountServiceFetch),
    options.videoGenerator ?? new ManagedVideoGenerator(() => accountConnection.videoSource(), options.accountServiceFetch),
    library,
  );
  const pluginSettings = new PluginSettingsStore(dataDirectory);
  const connections = new ConnectionManager(piAgentDirectory);
  const bundledPlugins = new BundledPluginStore(options.bundledPluginsDirectory ?? path.join(repositoryRoot, "plugins"));
  const preinstalledPlugins = new PreinstalledPluginManager(
    options.preinstalledPluginsDirectory,
    dataDirectory,
  );
  const mcpServers = { list: () => listMcpServers(piAgentDirectory) };
  const localPlugins = new LocalPluginStore(dataDirectory, {
    connections: async () => (await mcpServers.list()).map((server) => server.id),
  });
  const plugins = new PluginCatalogService([
    new BundledPluginAdapter(bundledPlugins),
    new LocalPluginAdapter(localPlugins),
    new RemotePluginAdapter(publisher),
  ], pluginSettings, (plugin) => preinstalledPlugins.decorate(plugin));
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
        () => resolvePluginSkills([bundledPlugins, localPlugins], pluginSettings, project.type),
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
        project,
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
          options.playtestDriver ? {
            driver: options.playtestDriver,
            ensurePreview: async () => project.preview.status === "ready" && project.preview.url
              ? project.preview.url
              : previews.start(project),
          } : undefined,
        ),
        modelRuntime,
        model,
        piAgentDirectory,
        () => resolvePluginSkills([bundledPlugins, localPlugins], pluginSettings, project.type),
      );
    }),
    activeToolNames: (project, mode, session) => {
      const registered = session.getAllTools?.().map((tool) => tool.name) ?? [];
      return projectPiToolNames(mode, tools.list().map((tool) => tool.id), registered);
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
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAX_LIBRARY_UPLOAD_BYTES }, (_request, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser("application/vnd.ohmygame.attachment", { bodyLimit: MAX_AGENT_ATTACHMENT_BYTES }, (_request, payload, done) => {
    done(null, payload);
  });

  app.addHook("onReady", async () => {
    await Promise.all([library.load(), projects.load(), tools.load(), pluginSettings.load(), bundledPlugins.load(), preinstalledPlugins.load(), imageSettings.load(), openAIEndpoint.load(), assetStudioDraft.load()]);
    for (const error of await preinstalledPlugins.seed(localPlugins)) app.log.warn(error);
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
      const catalog = available?.catalog ?? (available?.source.type === "catalog" ? available.source : undefined);
      if (!available || !catalog) return reply.code(404).send({ error: "Catalog Plugin not found" });
      const remote = await publisher.explorePlugin(catalog.pluginId);
      const archive = await publisher.pluginContent(remote.id, remote.releaseId);
      const sha256 = createHash("sha256").update(archive).digest("hex");
      if (archive.length !== remote.artifactBytes || sha256 !== remote.artifactSha256) {
        return reply.code(502).send({ error: "Downloaded Plugin failed integrity verification" });
      }
      const installed = await installCatalogPlugin(localPlugins, {
        pluginId: remote.id, releaseId: remote.releaseId, manifest: remote.manifest, archive,
        ...(available.installed ? { replaceId: available.id } : {}),
      });
      invalidatePluginSessions();
      return reply.code(201).send(await plugins.read(installed.id) ?? pluginSettings.decorate(installed));
    } catch (cause) {
      const statusCode = cause instanceof LocalPluginError ? cause.statusCode
        : cause instanceof RemotePublishError ? cause.statusCode
        : 502;
      return reply.code(statusCode).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  });

  app.post<{ Params: { pluginId: string }; Body: { accessToken: string; version?: string } }>("/plugins/:pluginId/publish", {
    schema: publishPluginSchema,
  }, async (request, reply) => {
    try {
      const bundle = await localPlugins.installedBundle(request.params.pluginId);
      if (!bundle) return reply.code(404).send({ error: "Installed local Plugin not found" });
      const plugin = await localPlugins.read(request.params.pluginId);
      if (!plugin) return reply.code(404).send({ error: "Installed local Plugin not found" });
      const version = bundle.manifest.version ?? request.body.version?.trim();
      if (!version || !isPluginVersion(version)) {
        return reply.code(400).send({ error: "A semantic version such as 0.1.0 is required to share this Plugin" });
      }
      const manifest = { ...bundle.manifest, version };
      const result = await publisher.publishPlugin({
        name: manifest.name,
        manifest,
        skills: plugin.skills.map(({ id, name, description }) => ({ id, name, description })),
        archive: await createPluginArchive(bundle.path),
        origin: publishOrigin(bundle),
      }, request.body.accessToken);
      await localPlugins.linkCatalog(request.params.pluginId, {
        pluginId: result.plugin.id,
        releaseId: result.release.id,
      });
      return reply.code(201).send(result);
    } catch (cause) {
      const statusCode = cause instanceof PublishError ? cause.statusCode
        : cause instanceof RemotePublishError ? cause.statusCode
        : 502;
      return reply.code(statusCode).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  });

  app.post<{ Params: { pluginId: string }; Body: { accessToken: string } }>("/plugins/:pluginId/publication", {
    schema: { body: publishAccessTokenBody },
  }, async (request, reply) => {
    try {
      const plugin = await plugins.read(request.params.pluginId);
      const catalog = plugin?.catalog ?? (plugin?.source.type === "catalog" ? plugin.source : undefined);
      if (!plugin?.installed || !catalog) return null;
      return await publisher.pluginPublication(catalog.pluginId, request.body.accessToken) ?? null;
    } catch (cause) {
      const statusCode = cause instanceof RemotePublishError ? cause.statusCode : 502;
      return reply.code(statusCode).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  });

  app.put<{ Params: { pluginId: string }; Body: { accessToken: string; status: "listed" | "unlisted" } }>("/plugins/:pluginId/publication", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["accessToken", "status"],
        properties: {
          accessToken: { type: "string", minLength: 1 },
          status: { type: "string", enum: ["listed", "unlisted"] },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const plugin = await plugins.read(request.params.pluginId);
      const catalog = plugin?.catalog ?? (plugin?.source.type === "catalog" ? plugin.source : undefined);
      if (!plugin?.installed || !catalog) return reply.code(404).send({ error: "Plugin publication not found" });
      return await publisher.setPluginListing(catalog.pluginId, request.body.status, request.body.accessToken);
    } catch (cause) {
      const statusCode = cause instanceof RemotePublishError ? cause.statusCode : 502;
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
    if (!plugin) return reply.code(404).send({ error: "Plugin not found" });
    try {
      if (!plugin.installed && plugin.source.type === "catalog") {
        return await publisher.pluginSkillContent(plugin.source.pluginId, plugin.source.releaseId, request.query.id);
      }
      if (!plugin.installed) return reply.code(404).send({ error: "Installed plugin not found" });
      const content = await readPluginSkillContent(plugin, request.query.id, [bundledPlugins, localPlugins]);
      return content === undefined
        ? reply.code(404).send({ error: "Plugin Skill not found" })
        : { id: request.query.id, content };
    } catch (cause) {
      if (cause instanceof PluginSkillContentError) return reply.code(cause.statusCode).send({ error: cause.message });
      if (cause instanceof RemotePublishError) return reply.code(cause.statusCode).send({ error: cause.message });
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
      await preinstalledPlugins.markRemoved(plugin);
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

  app.get("/asset-studio/draft", async () => assetStudioDraft.get() ?? null);

  app.put<{ Body: AssetStudioDraft }>("/asset-studio/draft", async (request, reply) => {
    try {
      return await assetStudioDraft.update(request.body);
    } catch (cause) {
      return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  });

  app.get("/tool-runs", async () => tools.recentRuns());

  app.get("/tool-jobs", async () => tools.jobs());

  app.post<{ Params: { toolId: string }; Body: RunToolRequest & { title?: string } }>(
    "/tools/:toolId/jobs",
    { schema: toolRunSchema, bodyLimit: TOOL_RUN_BODY_LIMIT },
    async (request, reply) => {
      try {
        const { title, ...input } = request.body;
        return reply.code(202).send(tools.start(request.params.toolId, input as RunToolRequest, { title: title?.trim() }));
      } catch (cause) {
        if (cause instanceof ToolRunError) return reply.code(cause.statusCode).send({ error: cause.message });
        throw cause;
      }
    },
  );

  app.post<{ Params: { jobId: string } }>("/tool-jobs/:jobId/cancel", async (request, reply) => {
    try {
      return reply.send(tools.cancelJob(request.params.jobId));
    } catch (cause) {
      if (cause instanceof ToolRunError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
  });

  app.post<{ Params: { jobId: string } }>("/tool-jobs/:jobId/retry", async (request, reply) => {
    try {
      return reply.code(202).send(tools.retryJob(request.params.jobId));
    } catch (cause) {
      if (cause instanceof ToolRunError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
  });

  app.post<{ Params: { toolId: string }; Body: RunToolRequest & { title?: string } }>(
    "/tools/:toolId/runs",
    { schema: toolRunSchema, bodyLimit: TOOL_RUN_BODY_LIMIT },
    async (request, reply) => {
      try {
        const { title, ...input } = request.body;
        return reply.code(201).send(await tools.run(request.params.toolId, input as RunToolRequest, undefined, { title: title?.trim() }));
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
          ...(file.assetId ? { libraryAssetId: file.assetId } : {}),
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
    try {
      if (request.body?.templateId && request.body.type !== "interactive-drama") {
        return reply.code(400).send({ error: "Project templates require a matching project type" });
      }
      if (request.body?.storyViewport && request.body.type !== "interactive-drama") {
        return reply.code(400).send({ error: "Story viewport requires an Interactive Drama project" });
      }
      if (request.body?.storyViewport && request.body.templateId) {
        return reply.code(400).send({ error: "Interactive Drama templates define their own story viewport" });
      }
      if (request.body?.templateId === INTERACTIVE_DRAMA_STARTER.id) {
        const project = await createInteractiveDramaStarterProject(
          interactiveDramaExamplesDirectory,
          projects,
          request.body.name,
          request.body.workspacePath,
        );
        return reply.code(201).send(project);
      }
      const project = await projects.create(request.body?.name, request.body?.type, request.body?.workspacePath);
      if (project.type === "interactive-drama" && request.body?.storyViewport) {
        const story = createStoryDocument();
        story.player.viewport = request.body.storyViewport;
        await projects.setStory(project.id, story);
      }
      return reply.code(201).send(project);
    } catch (cause) {
      if (cause instanceof ProjectWorkspaceError) return reply.code(400).send({ error: cause.message });
      throw cause;
    }
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

  app.post<{ Params: { projectId: string }; Body: StoryTextGenerationRequest }>(
    "/projects/:projectId/story/text/generate",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["instruction"],
          properties: {
            instruction: { type: "string", minLength: 1, maxLength: 12_000 },
            model: {
              type: "object",
              additionalProperties: false,
              required: ["provider", "id"],
              properties: { provider: { type: "string", minLength: 1, maxLength: 100 }, id: { type: "string", minLength: 1, maxLength: 200 } },
            },
          },
        },
      },
      bodyLimit: 32_000,
    },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      if (project.type !== "interactive-drama") {
        return reply.code(400).send({ error: "Story documents require an Interactive Drama project" });
      }
      const runtime = await getModelRuntime();
      const settings = SettingsManager.create(project.workspacePath, piAgentDirectory);
      const provider = settings.getDefaultProvider();
      const id = settings.getDefaultModel();
      const selected = request.body.model ?? (provider && id ? { provider, id } : undefined);
      if (!selected) return reply.code(409).send({ error: "No language model is configured" });
      const model = runtime.getModel(selected.provider, selected.id);
      if (!model || !runtime.hasConfiguredAuth(selected.provider)) return reply.code(409).send({ error: "The selected language model is not available" });
      try {
        const text = await generateCreativeText(runtime, selected, request.body.instruction);
        if (!text) return reply.code(502).send({ error: "The language model returned no text" });
        return { text, model: selected };
      } catch (cause) {
        return reply.code(502).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  );

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

  app.post<{ Params: { type: CommunitySubjectType; id: string }; Body: { accessToken: string } }>(
    "/community/:type/:id/viewer",
    { schema: { params: communitySubjectParams, body: publishAccessTokenBody } },
    async (request, reply) => {
      try {
        return await publisher.communityViewerState(request.params.type, request.params.id, request.body.accessToken);
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        return reply.code(cause instanceof RemotePublishError ? cause.statusCode : 502).send({ error });
      }
    },
  );

  app.put<{ Params: { type: CommunitySubjectType; id: string }; Body: { accessToken: string; liked: boolean } }>(
    "/community/:type/:id/like",
    { schema: { params: communitySubjectParams, body: communityLikeBody } },
    async (request, reply) => {
      try {
        return await publisher.setCommunityLike(request.params.type, request.params.id, request.body.liked, request.body.accessToken);
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        return reply.code(cause instanceof RemotePublishError ? cause.statusCode : 502).send({ error });
      }
    },
  );

  app.post<{ Params: { type: CommunitySubjectType; id: string }; Body: { accessToken: string } }>(
    "/community/:type/:id/use",
    { schema: { params: communitySubjectParams, body: publishAccessTokenBody } },
    async (request, reply) => {
      try {
        return await publisher.recordCommunityUse(request.params.type, request.params.id, request.body.accessToken);
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        return reply.code(cause instanceof RemotePublishError ? cause.statusCode : 502).send({ error });
      }
    },
  );

  app.get<{ Params: { gameId: string } }>("/community/games/:gameId", async (request, reply) => {
    try {
      return await publisher.communityGame(request.params.gameId);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      return reply.code(cause instanceof RemotePublishError ? cause.statusCode : 502).send({ error });
    }
  });

  app.get<{ Params: { gameId: string; deploymentId: string } }>(
    "/community/games/:gameId/deployments/:deploymentId/cover",
    async (request, reply) => {
      try {
        const cover = await publisher.communityGameCover(request.params.gameId, request.params.deploymentId);
        reply.header("content-type", "image/webp");
        reply.header("cache-control", "private, max-age=31536000, immutable");
        reply.header("x-content-type-options", "nosniff");
        return reply.send(cover);
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        return reply.code(cause instanceof RemotePublishError ? cause.statusCode : 502).send({ error });
      }
    },
  );

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

  app.get<{ Params: { templateId: string } }>("/asset-templates/:templateId/cover", async (request, reply) => {
    const cover = await assetTemplates.cover(request.params.templateId);
    if (!cover) return reply.code(404).send({ error: "Asset template cover not found" });
    return reply.type("image/webp").header("cache-control", "no-store").header("x-content-type-options", "nosniff").send(cover);
  });

  app.put<{ Params: { templateId: string }; Body: Buffer }>("/asset-templates/:templateId/cover", async (request, reply) => {
    try {
      if (!isWebp(request.body)) return reply.code(400).send({ error: "Asset template cover must be a WebP image" });
      return await assetTemplates.setCover(request.params.templateId, request.body);
    } catch (cause) {
      const statusCode = cause instanceof AssetTemplateError ? cause.statusCode : 500;
      return reply.code(statusCode).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  });

  app.post<{ Params: { templateId: string }; Body: { accessToken: string } }>(
    "/asset-templates/:templateId/publish",
    { schema: { body: publishAccessTokenBody } },
    async (request, reply) => {
      try {
        const template = await assetTemplates.read(request.params.templateId);
        if (!template) return reply.code(404).send({ error: "Asset template not found" });
        const { id: _id, source: _source, createdAt: _createdAt, publication, hasCover: _hasCover, ...definition } = template;
        const result = await publisher.publishTemplate({
          localId: template.id,
          templateId: publication?.templateId,
          definition,
          cover: await assetTemplates.cover(template.id),
        }, request.body.accessToken);
        await assetTemplates.setPublication(template.id, {
          templateId: result.template.id,
          releaseId: result.release.id,
          publishedAt: result.release.publishedAt,
          status: "listed",
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

  app.put<{ Params: { templateId: string }; Body: { accessToken: string; status: "listed" | "unlisted" } }>(
    "/asset-templates/:templateId/publication",
    { schema: { body: publicationStatusBody } },
    async (request, reply) => {
      try {
        const template = await assetTemplates.read(request.params.templateId);
        if (!template?.publication) return reply.code(404).send({ error: "Published Asset template not found" });
        const listing = await publisher.setTemplateListing(template.publication.templateId, request.body.status, request.body.accessToken);
        return assetTemplates.setPublication(template.id, { ...template.publication, status: listing.status });
      } catch (cause) {
        const statusCode = cause instanceof AssetTemplateError ? cause.statusCode
          : cause instanceof RemotePublishError ? cause.statusCode
          : 502;
        return reply.code(statusCode).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  );

  app.delete<{ Params: { templateId: string } }>("/asset-templates/:templateId", async (request, reply) => {
    try {
      await assetTemplates.delete(request.params.templateId);
      return reply.code(204).send();
    } catch (cause) {
      if (cause instanceof AssetTemplateError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
  });

  app.get("/explore/templates", async (_request, reply) => {
    try {
      return (await publisher.exploreTemplates()).map((template) => ({ ...template, source: "catalog" as const }));
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      return reply.code(cause instanceof RemotePublishError ? cause.statusCode : 502).send({ error });
    }
  });

  app.get<{ Params: { templateId: string; releaseId: string } }>("/explore/templates/:templateId/releases/:releaseId/cover", async (request, reply) => {
    try {
      const cover = await publisher.templateCover(request.params.templateId, request.params.releaseId);
      return reply.type("image/webp").header("cache-control", "private, max-age=31536000, immutable").header("x-content-type-options", "nosniff").send(cover);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      return reply.code(cause instanceof RemotePublishError ? cause.statusCode : 502).send({ error });
    }
  });

  app.get("/library/assets", async () => {
    await projects.syncLibraryAssets();
    return library.list();
  });

  app.post<{ Body: CreateLibraryImageRequest }>("/library/assets", {
    bodyLimit: 15 * 1024 * 1024,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["name", "image"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200 },
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
    },
  }, async (request, reply) => {
    if (!validBase64(request.body.image.data)) return reply.code(400).send({ error: "Image data is invalid" });
    const contents = Buffer.from(request.body.image.data, "base64");
    if (contents.length === 0 || contents.length > MAX_LIBRARY_IMAGE_BYTES) {
      return reply.code(400).send({ error: "Image must be no larger than 10 MB" });
    }
    if (!isImageOfType(contents, request.body.image.mediaType)) {
      return reply.code(400).send({ error: "Image data does not match its media type" });
    }
    try {
      const extension = request.body.image.mediaType === "image/png" ? ".png"
        : request.body.image.mediaType === "image/jpeg" ? ".jpg"
          : ".webp";
      const name = `${path.parse(path.basename(request.body.name)).name || "image"}${extension}`;
      return reply.code(201).send(await library.add(name, contents));
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      return reply.code(cause instanceof AssetLibraryError ? cause.statusCode : 500).send({ error });
    }
  });

  app.post<{ Querystring: { name: string; mediaType: string; duration?: string }; Body: Buffer }>("/library/assets/upload", {
    schema: {
      querystring: {
        type: "object",
        additionalProperties: false,
        required: ["name", "mediaType"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200 },
          mediaType: { type: "string", enum: [...LIBRARY_UPLOAD_MEDIA_TYPES] },
          duration: { type: "string", pattern: "^(?:0|[1-9]\\d*)(?:\\.\\d+)?$" },
        },
      },
    },
  }, async (request, reply) => {
    const mediaType = request.query.mediaType as LibraryUploadMediaType;
    const contents = request.body;
    if (!Buffer.isBuffer(contents) || contents.length === 0) return reply.code(400).send({ error: "File is empty" });
    const name = path.basename(request.query.name);
    if (!name || workspaceMediaInfo(name)?.contentType !== mediaType) {
      return reply.code(400).send({ error: "File name does not match its media type" });
    }
    if (!isLibraryMediaOfType(contents, mediaType)) {
      return reply.code(400).send({ error: "File data does not match its media type" });
    }
    const duration = request.query.duration === undefined ? undefined : Number(request.query.duration);
    if (duration !== undefined && (!Number.isFinite(duration) || duration < 0 || mediaType.startsWith("image/"))) {
      return reply.code(400).send({ error: "Invalid media duration" });
    }
    try {
      return reply.code(201).send(await library.add(name, contents, { ...(duration !== undefined ? { duration } : {}) }));
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      return reply.code(cause instanceof AssetLibraryError ? cause.statusCode : 500).send({ error });
    }
  });

  app.get<{ Params: { assetId: string } }>("/library/assets/:assetId/content", async (request, reply) => {
    try {
      const { asset, absolutePath } = await library.content(request.params.assetId);
      return reply.type(asset.contentType)
        .header("content-length", asset.size)
        .header("cache-control", "private, max-age=31536000, immutable")
        .header("x-content-type-options", "nosniff")
        .send(createReadStream(absolutePath));
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      return reply.code(cause instanceof AssetLibraryError ? cause.statusCode : 500).send({ error });
    }
  });

  app.patch<{ Params: { assetId: string }; Body: { name: string } }>(
    "/library/assets/:assetId",
    { schema: { body: renameAssetSchema.body } },
    async (request, reply) => {
      try {
        return await library.rename(request.params.assetId, request.body.name);
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        return reply.code(cause instanceof AssetLibraryError ? cause.statusCode : 500).send({ error });
      }
    },
  );

  app.get<{ Params: { assetId: string } }>("/library/assets/:assetId/references", async (request, reply) => {
    if (!library.get(request.params.assetId)) return reply.code(404).send({ error: "Library asset not found" });
    return (await projects.referencesLibraryAsset(request.params.assetId)).map(({ id, name, type }) => ({ id, name, type }));
  });

  app.delete<{ Params: { assetId: string }; Querystring: { force?: string } }>("/library/assets/:assetId", {
    schema: {
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: { force: { type: "string", enum: ["true"] } },
      },
    },
  }, async (request, reply) => {
    try {
      const references = await projects.referencesLibraryAsset(request.params.assetId);
      if (references.length && request.query.force !== "true") return reply.code(409).send({ error: `Asset is used by ${references.length} project${references.length === 1 ? "" : "s"}` });
      if (request.query.force === "true") await projects.removeLibraryAssetReferences(request.params.assetId);
      await library.delete(request.params.assetId);
      return reply.code(204).send();
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      return reply.code(cause instanceof AssetLibraryError ? cause.statusCode : cause instanceof ProjectStoryReferenceError ? 409 : 500).send({ error });
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

  app.post<{ Params: { projectId: string; assetId: string } }>(
    "/projects/:projectId/library-assets/:assetId",
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      try {
        return reply.code(201).send(await projects.materializeLibraryAsset(project.id, request.params.assetId));
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        const statusCode = cause instanceof ProjectAssetError || cause instanceof AssetLibraryError ? cause.statusCode : 500;
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
    const defaultModel = findAgentModel(models, configuredDefaultModel(dataDirectory, piAgentDirectory));
    return {
      models: models.map((model) => ({
        provider: model.provider,
        providerName: runtime.getProvider(model.provider)?.name ?? model.provider,
        id: model.id,
        name: model.name,
        reasoningLevels: supportedReasoningLevels(model),
      })),
      ...(defaultModel ? { defaultModel: { provider: defaultModel.provider, id: defaultModel.id } } : {}),
      defaultReasoningLevel: defaultReasoningLevel(dataDirectory, piAgentDirectory),
    };
  });

  app.put<{ Body: UpdateAgentDefaultsRequest }>("/models/default", async (request, reply) => {
    if (!isUpdateAgentDefaultsRequest(request.body)) {
      return reply.code(400).send({ error: "Invalid agent defaults" });
    }
    const runtime = await getModelRuntime();
    const model = (await runtime.getAvailable(request.body.model.provider))
      .find((candidate) => candidate.id === request.body.model.id);
    if (!model) return reply.code(400).send({ error: "Model is not available" });
    if (!supportedReasoningLevels(model).includes(request.body.reasoningLevel)) {
      return reply.code(400).send({ error: "Reasoning level is not available for this model" });
    }
    const settings = SettingsManager.create(dataDirectory, piAgentDirectory);
    settings.setDefaultModelAndProvider(model.provider, model.id);
    settings.setDefaultThinkingLevel(request.body.reasoningLevel);
    await settings.flush();
    const failure = settings.drainErrors()[0];
    if (failure) throw failure.error;
    return reply.code(204).send();
  });

  app.get("/account/connection", async () => accountConnection.get());

  app.get("/account/plans", async (_request, reply) =>
    accountReply(reply, () => accountServiceClient.plans()),
  );
  app.post<{ Body: { accessToken: string } }>(
    "/account/subscription",
    { schema: accountConnectionSchema },
    async (request, reply) =>
      accountReply(reply, () => accountServiceClient.subscription(request.body.accessToken)),
  );
  app.post<{ Querystring: { page?: string }; Body: { accessToken: string } }>(
    "/account/usage",
    {
      schema: {
        ...accountConnectionSchema,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            page: {
              type: "string",
              pattern: "^(?:[1-9][0-9]{0,3}|10000)$",
              default: "1",
            },
          },
        },
      },
    },
    async (request, reply) =>
      accountReply(reply, () =>
        accountServiceClient.usage(request.body.accessToken, Number(request.query.page ?? "1")),
      ),
  );
  app.post<{ Body: { accessToken: string; planId: number } }>(
    "/account/checkout",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["accessToken", "planId"],
          properties: {
            accessToken: { type: "string", minLength: 1, maxLength: 10_000 },
            planId: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          },
        },
      },
    },
    async (request, reply) =>
      accountReply(reply, () =>
        accountServiceClient.checkout(request.body.accessToken, request.body.planId),
      ),
  );
  app.post<{ Body: { accessToken: string } }>(
    "/account/manage",
    { schema: accountConnectionSchema },
    async (request, reply) =>
      accountReply(reply, () => accountServiceClient.manageSubscription(request.body.accessToken)),
  );

  app.put<{ Body: { accessToken: string } }>(
    "/account/connection",
    { schema: accountConnectionSchema },
    async (request, reply) => {
      const state = await accountConnection.connect(request.body.accessToken);
      if (state.status === "error") return reply.code(502).send({ error: state.error });
      return state;
    },
  );

  app.delete("/account/connection", async (_request, reply) => {
    await accountConnection.disconnect();
    return reply.code(204).send();
  });

  app.get("/settings/providers", async () => {
    const piProviders = await modelAuth.providers();
    const accountState = accountConnection.get();
    const accountStatus = accountState.status === "connected"
      ? "connected"
      : accountState.status === "connecting"
        ? "connecting"
        : accountState.status === "error" ? "error" : "not_configured";
    return [
      ...piProviders
        .filter((provider) => provider.id !== "ohmygame")
        .map((provider) => ({
          ...provider,
          kind: "pi" as const,
          status: provider.configured ? "connected" as const : "not_configured" as const,
          capabilities: provider.id === "openai" ? ["language", "image"] as const : ["language"] as const,
        })),
      {
        id: "ohmygame",
        name: "OhMyGame",
        configured: accountStatus === "connected",
        kind: "account" as const,
        status: accountStatus,
        capabilities: ["language", "image", "video", "3d"] as const,
        methods: [],
        ...(accountState.error ? { error: accountState.error } : {}),
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

  app.post<{ Params: { projectId: string }; Body: CreateConversationRequest }>(
    "/projects/:projectId/conversations",
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      if (!isCreateConversationRequest(request.body)) {
        return reply.code(400).send({ error: "Invalid conversation request" });
      }
      const requestedModel = request.body?.model;
      let selectedModel: RuntimeModel | undefined;
      if (requestedModel) {
        selectedModel = await availableModel(getModelRuntime, requestedModel.provider, requestedModel.id);
      } else {
        const runtime = await getModelRuntime();
        selectedModel = preferredAgentModel(
          await runtime.getAvailable(),
          undefined,
          configuredDefaultModel(dataDirectory, piAgentDirectory),
        );
      }
      if (requestedModel && !selectedModel) {
        return reply.code(400).send({ error: "Model is not available" });
      }
      if (request.body?.reasoningLevel && selectedModel && !supportedReasoningLevels(selectedModel).includes(request.body.reasoningLevel)) {
        return reply.code(400).send({ error: "Reasoning level is not available for this model" });
      }
      const model = selectedModel ? { provider: selectedModel.provider, id: selectedModel.id } : undefined;
      const reasoningLevel = request.body?.reasoningLevel ?? (!requestedModel && selectedModel
        ? effectiveReasoningLevel(selectedModel, undefined, defaultReasoningLevel(dataDirectory, piAgentDirectory))
        : undefined);
      const conversation = await conversations.create(project, model, reasoningLevel);
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
      const loadedItems = [
        ...loadConversation(
          project,
          conversation.sessionPath,
          currentRun?.timestamp,
          !currentRun,
        ),
        // A reset must be a complete snapshot. Replaying from the active turn's
        // start is unsafe once a chat produces more events than the replay buffer.
        ...(currentRun ? activeItems : []),
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
        cursor: events.cursor(),
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
        if (conversation.summary.messageCount > 0) {
          const itemId = randomUUID();
          events.publish(project.id, "conversation.model.changed", {
            item: {
              id: itemId,
              turnId: itemId,
              type: "modelChange",
              model: request.body,
              name: model.name,
            },
          }, { conversationId: conversation.summary.id, turnId: itemId });
        }
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
    const previewWorkspace = await previewWorkspaceStatus(project.workspacePath);
    if (!previewWorkspace.runnable) {
      return reply.code(409).send({ error: previewWorkspace.error ?? "Workspace is not runnable yet" });
    }
    return { url: await previews.start(project) };
  });

  app.post<{ Params: { projectId: string }; Querystring: { batchId: string; name: string; relativePath?: string }; Body: AsyncIterable<Buffer | string> }>(
    "/projects/:projectId/attachments",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["batchId", "name"],
          properties: {
            batchId: { type: "string", pattern: "^[a-fA-F0-9-]{36}$" },
            name: { type: "string", minLength: 1, maxLength: 255 },
            relativePath: { type: "string", minLength: 1, maxLength: 1_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      try {
        return reply.code(201).send(await attachments.store(project, {
          batchId: request.query.batchId,
          name: request.query.name,
          relativePath: request.query.relativePath,
          contents: request.body,
        }));
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        return reply.code(cause instanceof AgentAttachmentError ? cause.statusCode : 500).send({ error });
      }
    },
  );

  app.post<{ Params: { projectId: string; conversationId: string }; Body: PromptRequest }>(
    "/projects/:projectId/conversations/:conversationId/turns",
    { schema: promptSchema, bodyLimit: Number.MAX_SAFE_INTEGER },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const conversation = await conversations.get(project, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      if (!request.body?.prompt?.trim() && !request.body?.images?.length && !request.body?.attachments?.length) return reply.code(400).send({ error: "Prompt or attachment is required" });
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
      let resolvedAttachments;
      try {
        resolvedAttachments = await Promise.all((request.body.attachments ?? []).map((attachment) => attachments.resolve(project, attachment)));
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        return reply.code(cause instanceof AgentAttachmentError ? cause.statusCode : 400).send({ error });
      }
      let attachmentImages: PromptImage[];
      try {
        attachmentImages = (await Promise.all(resolvedAttachments.map((attachment) => attachments.promptImage(attachment))))
          .flatMap((image) => image ? [image] : []);
      } catch (cause) {
        return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
      try {
        await Promise.all([...(request.body.images ?? []), ...attachmentImages].map((image, index) => (
          addConversationImageToProject(library, projects, project.id, image, index)
        )));
      } catch (cause) {
        const statusCode = cause instanceof AssetLibraryError ? cause.statusCode : 400;
        return reply.code(statusCode).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
      await projects.touch(project.id);
      let turn;
      try {
        turn = agents.prompt(
          project,
          conversation,
          request.body.prompt,
          references,
          [...(request.body.images ?? []), ...attachmentImages],
          request.body.mode ?? "normal",
          mentions,
          undefined,
          attachments.promptContext(project, resolvedAttachments),
          attachments.conversationAttachments(resolvedAttachments),
        );
      } catch (cause) {
        return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
      try {
        await attachments.claim(project, resolvedAttachments);
      } catch (cause) {
        request.log.warn({ err: cause }, "failed to retain agent attachments");
      }
      if (turn.queued) {
        try {
          await turn.result;
        } catch (cause) {
          return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) });
        }
      }
      const titled = conversations.setInitialTitle(project, conversation.summary.id, request.body.prompt);
      if (titled) publishConversationRenamed(titled);
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
        const result = await publisher.publish(
          project,
          await artifacts.create(project, await projects.cover(project.id)),
          request.body.accessToken,
          { title: request.body.title.trim(), description: request.body.description?.trim() },
        );
        await projects.setPublication(project.id, {
          gameId: result.game.id,
          deploymentId: result.game.deploymentId,
          playUrl: result.game.playUrl,
          publishedAt: result.game.publishedAt,
          title: result.game.title,
          description: result.game.description,
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

  app.post<{ Params: { projectId: string } }>("/projects/:projectId/interactive-drama/build", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (project.type !== "interactive-drama") return reply.code(409).send({ error: "Build requires an Interactive Drama project" });
    if (agents.isProjectBusy(project.id)) return reply.code(409).send({ error: "Wait for the agent to finish before building" });
    if (publishing.has(project.id)) return reply.code(409).send({ error: "Project is already being published" });
    try {
      const artifact = await artifacts.buildInteractiveDrama(project);
      return reply
        .header("content-type", "application/zip")
        .header("content-disposition", `attachment; filename="${encodeURIComponent(project.name)}.zip"`)
        .send(artifact);
    } catch (cause) {
      const statusCode = cause instanceof PublishError ? cause.statusCode : 500;
      return reply.code(statusCode).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  });

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
    options.playtestDriver?.close();
    tools.close();
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

function isImageOfType(value: Buffer, mediaType: CreateLibraryImageRequest["image"]["mediaType"]): boolean {
  if (mediaType === "image/webp") return isWebp(value);
  if (mediaType === "image/png") {
    return value.length >= 8 && value.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff;
}

function isLibraryMediaOfType(value: Buffer, mediaType: LibraryUploadMediaType): boolean {
  if (mediaType === "image/png" || mediaType === "image/jpeg" || mediaType === "image/webp") return isImageOfType(value, mediaType);
  if (mediaType === "audio/wav") {
    return value.length >= 12 && value.subarray(0, 4).toString("ascii") === "RIFF" && value.subarray(8, 12).toString("ascii") === "WAVE";
  }
  if (mediaType === "audio/mpeg") {
    return value.length >= 3 && (value.subarray(0, 3).toString("ascii") === "ID3" || (value[0] === 0xff && (value[1]! & 0xe0) === 0xe0));
  }
  if (mediaType === "video/webm") {
    return value.length >= 4 && value[0] === 0x1a && value[1] === 0x45 && value[2] === 0xdf && value[3] === 0xa3;
  }
  return value.length >= 8 && value.subarray(4, 8).toString("ascii") === "ftyp";
}

function validBase64(value: string): boolean {
  return value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

async function addConversationImageToProject(
  library: AssetLibrary,
  projects: ProjectManager,
  projectId: string,
  image: PromptImage,
  index: number,
): Promise<void> {
  const contents = Buffer.from(image.data, "base64");
  const extension = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
  }[image.mediaType];
  const originalName = path.basename(image.name ?? `Image ${index + 1}`);
  const stem = path.basename(originalName, path.extname(originalName)).trim() || `Image ${index + 1}`;
  const digest = createHash("sha256").update(contents).digest("hex");
  const asset = await library.add(`${stem}${extension}`, contents, { sourceKey: `conversation-image:${image.mediaType}:${digest}` });
  await projects.materializeLibraryAsset(projectId, asset.id);
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
  return isAgentModelRef(body.model);
}

function isUpdateAgentDefaultsRequest(value: unknown): value is UpdateAgentDefaultsRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).every((key) => key === "model" || key === "reasoningLevel") &&
    isAgentModelRef(body.model) && AGENT_REASONING_LEVELS.includes(body.reasoningLevel as AgentReasoningLevel);
}

function isAgentModelRef(value: unknown): value is AgentModelRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as Record<string, unknown>;
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

function configuredDefaultModel(cwd: string, agentDir: string): AgentModelRef | undefined {
  const settings = SettingsManager.create(cwd, agentDir);
  const provider = settings.getDefaultProvider();
  const id = settings.getDefaultModel();
  return provider && id ? { provider, id } : undefined;
}

function publishOrigin(bundle: InstalledPluginBundle): PublishPluginOrigin | undefined {
  const repository = bundle.provenance.type === "git" ? githubRepository(bundle.provenance.url) : undefined;
  if (!["personal", "ohmygame"].includes(bundle.marketplace.id)) {
    return { type: "claude-marketplace", marketplace: bundle.marketplace.displayName, ...(repository ? { repository } : {}) };
  }
  if (bundle.provenance.type === "git" && repository) return { type: "github", repository, commit: bundle.provenance.commit };
  return undefined;
}

function githubRepository(value: string): string | undefined {
  const url = new URL(value);
  if (url.hostname.toLowerCase() !== "github.com") return undefined;
  const repository = url.pathname.replace(/^\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  return repository.split("/").length >= 2 ? repository : undefined;
}
