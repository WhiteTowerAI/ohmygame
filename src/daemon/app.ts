import { isUtf8 } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { AGENT_REASONING_LEVELS, IMAGE_ASPECT_RATIOS, IMAGE_OUTPUT_COUNTS, IMAGE_RESOLUTIONS, IMAGE_SIZES, TOOL_IDS, VIDEO_ASPECT_RATIOS, VIDEO_RESOLUTIONS, type AgentModelRef, type AgentReasoningLevel, type AnswerQuestionnaireRequest, type AssetCanvasTextGenerationRequest, type ConversationAgentSettings, type ConversationCapabilities, type ConversationDetail, type CreateConversationRequest, type CreateLibraryImageRequest, type CreateProjectRequest, type LibraryUploadMediaType, type MediaModelDefaults, type ModelAuthMethod, type ProjectState, type ProjectType, type PromptImage, type PromptRequest, type PublishProjectRequest, type RenameConversationRequest, type ReviseLastPromptRequest, type RunToolRequest, type RunVideoToolRequest, type RuntimeEvent, type SetConversationModelRequest, type SetConversationReasoningRequest, type UpdateAgentDefaultsRequest } from "../shared/contracts.js";
import { findAgentModel, preferredAgentModel } from "../shared/agent-models.js";
import { groupThreadItems } from "../shared/turns.js";
import { RuntimeEventBus } from "../shared/events.js";
import { EXAMPLE_ID_PATTERN } from "../shared/examples.js";
import { PUBLISH_GAME_TITLE_MAX_LENGTH } from "../shared/publish-v1.js";
import { clampReasoningLevel, parseReasoningLevel, supportedReasoningLevels } from "../shared/reasoning.js";
import { matchesBearerToken } from "./access.js";
import { AgentManager, conversationItems, createPiSession, loadPiSkillCatalog, loadPiSkills, type RuntimeModel, type SessionFactory } from "./agent.js";
import { createAgentTools, projectPiToolNames } from "./agent-tools.js";
import { ConversationManager, type StoredConversation } from "./conversations.js";
import { ConversationImageStore } from "./conversation-images.js";
import { OwnedPlaytestDriver } from "./owned-playtest.js";
import { generateCreativeText, generateDesignDocumentMarkdown, generateDesignTable } from "./text-generation.js";
import type { CanvasDocumentGenerationRequest, CanvasDocumentDetail } from "../shared/canvas-document.js";
import type { CanvasTableDetail, CanvasTableGenerationRequest } from "../shared/canvas-table.js";
import { registerCanvasRoutes } from "./canvas-routes.js";
import { CanvasError, canvasLibraryAssetUsage } from "./canvas-workspace.js";
import { gameDesignReference } from "./game-design-context.js";
import { ArtifactBuilder, PublishError } from "./publish/archive.js";
import { PlayableDraftServer } from "./playable-draft-server.js";
import { promptContextBlock } from "./prompt-context.js";
import { RemotePublisher, RemotePublishError } from "./publish/client.js";
import { LocalPublisher } from "./publish/local.js";
import { LOCAL_DEBUG_ACCESS_TOKEN } from "../shared/local-debug.js";
import { PreviewManager } from "./preview.js";
import { isRunnableWorkspace, previewWorkspaceStatus, ProjectAssetError, ProjectManager, ProjectLibraryReferenceError, ProjectWorkspaceError, resolveStartupDirectory } from "./projects.js";
import { ExampleError, ExampleStore } from "./examples.js";
import { ModelAuthError, ModelAuthManager } from "./model-auth.js";
import { ModelEndpointSettingsStore } from "./model-endpoint-settings.js";
import { normalizeCustomProvider, normalizeCustomProviderModel, ProviderModelSettingsStore } from "./provider-model-settings.js";
import { discoverProviderModels } from "./provider-model-discovery.js";
import { customModelCatalog } from "./custom-model-capabilities.js";
import { CUSTOM_IMAGE_MODEL_APIS, type DiscoverProviderModelsRequest } from "../shared/contracts.js";
import type { Model3DGenerator } from "./model3d.js";
import { MAX_ANIMATION_ACTIONS, MODEL_3D_MAX_POLYCOUNT } from "../shared/generation-config.js";
import { MeshyProvider } from "./meshy-provider.js";
import { MediaProviderKeyStore } from "./media-provider-settings.js";
import { TripoProvider } from "./tripo-provider.js";
import type { ImageGenerator } from "./openai-image.js";
import { ProviderImages } from "./provider-images.js";
import { ProviderModels3D } from "./provider-models3d.js";
import { modelUsageList, modelUsages } from "../shared/custom-models.js";
import { ToolRunner, ToolRunError } from "./tools.js";
import type { VideoGenerator } from "./video-generation.js";
import { ProviderVideos } from "./provider-videos.js";
import { isSeedanceProviderId, SEEDANCE_PROVIDER_IDS, SEEDANCE_PROVIDERS } from "./seedance-models.js";
import { SeedanceSettingsStore } from "./seedance-settings.js";
import { BundledPluginAdapter, LocalPluginAdapter, PluginCatalogService } from "./plugin-catalog.js";
import { BundledPluginStore } from "./bundled-plugins.js";
import { LocalPluginError, LocalPluginStore } from "./local-plugins.js";
import { inspectPluginSource, installPlugin } from "./plugin-installer.js";
import { InvalidPluginSettingsError, PluginSettingsStore } from "./plugin-settings.js";
import { PreinstalledPluginManager } from "./preinstalled-plugins.js";
import { PluginSkillContentError, readPluginSkillContent, resolvePluginSkillFile, resolvePluginSkills } from "./plugin-runtime.js";
import { listMcpServers } from "./pi-agent.js";
import { ConnectionError, ConnectionManager } from "./connections.js";
import type { SaveConnectionRequest } from "../shared/connections.js";
import { hasPluginMentionToken, type InstallPluginRequest, type PluginSettings, type PluginSummary } from "../shared/plugins.js";
import { getWorkspaceMedia, listWorkspaceFiles, locateWorkspaceEntry, readWorkspaceFile, validateWorkspaceFile, workspaceMediaInfo, WorkspaceError } from "./workspace.js";
import { AssetLibrary, AssetLibraryError } from "./asset-library.js";
import { AgentAttachmentError, AgentAttachmentStore, MAX_AGENT_ATTACHMENT_BYTES, MAX_AGENT_ATTACHMENTS_PER_TURN } from "./agent-attachments.js";
import type { GameRuntimeAdapter } from "../shared/playtest.js";
import type { UpdateWebSearchSettings } from "../shared/web-search.js";
import { WebSearchSettingsStore } from "./web-search-settings.js";
import { WebSearchService } from "./web-search.js";
import { buildPlayableProject, validatePlayableProject } from "./playable-project.js";
import {
  createNodeCodebase,
  createPlayableStarterCodebase,
  NodeCodebaseError,
  readNodeCodebase,
  writeNodeCodebase,
} from "./playable-codebase.js";
import type { NodeCodebaseUpdate } from "../shared/playable-codebase.js";
import { addPlayableNode, type AddPlayableNodeRequest } from "./playable-add-node.js";
import { PLAYABLE_PRESETS } from "./playable-presets.js";
import {
  listPlayableThumbnails,
  PlayableThumbnailError,
  readGraphNodeIds,
  readPlayableCover,
  readPlayableThumbnail,
  writePlayableThumbnail,
} from "./playable-thumbnails.js";

export interface AppOptions {
  dataDirectory?: string;
  piAgentDirectory?: string;
  logger?: boolean;
  accessToken?: string;
  allowedOrigins?: string[];
  publishApiUrl?: string;
  publishFetch?: typeof fetch;
  /** Enabled by the development entry point only when product auth is unconfigured. */
  localDebug?: boolean;
  createSession?: SessionFactory;
  imageGenerator?: ImageGenerator;
  imageFetch?: typeof fetch;
  model3DGenerator?: Model3DGenerator;
  model3DFetch?: typeof fetch;
  videoGenerator?: VideoGenerator;
  videoFetch?: typeof fetch;
  modelDiscoveryFetch?: typeof fetch;
  createModelRuntime?: () => Promise<ModelRuntime>;
  bundledPluginsDirectory?: string;
  preinstalledPluginsDirectory?: string;
  interactiveStoryPlayerDirectory?: string;
  /** Examples prepared by scripts/prepare-examples.ts; omitted means no examples. */
  examplesDirectory?: string;
  playtestDriver?: GameRuntimeAdapter;
  webSearchFetch?: typeof fetch;
}

const createProjectSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", maxLength: PUBLISH_GAME_TITLE_MAX_LENGTH },
      type: { type: "string", enum: ["web-game", "godot-game", "interactive-story", "asset-canvas"] },
      exampleId: { type: "string", pattern: EXAMPLE_ID_PATTERN, maxLength: 80 },
      viewport: {
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

const startupDirectorySchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["startupDirectory"],
    properties: { startupDirectory: { type: "string", minLength: 1, maxLength: 1_000 } },
  },
} as const;

const runSettingsSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["startupDirectory", "startupScript", "previewPath", "previewViewport"],
    properties: {
      startupDirectory: { type: "string", minLength: 1, maxLength: 1_000 },
      startupScript: { type: "string", minLength: 1, maxLength: 200 },
      packageManager: { enum: ["npm", "pnpm", "yarn", "bun"] },
      previewPath: { type: "string", maxLength: 1_000 },
      previewViewport: { enum: ["fit", "tablet", "mobile"] },
    },
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

const nullableSecretSchema = { anyOf: [{ type: "string", maxLength: 10_000 }, { type: "null" }] } as const;
const webSearchSettingsSchema = {
  body: {
    type: "object", additionalProperties: false, required: ["enabled", "provider", "fallback"],
    properties: {
      enabled: { type: "boolean" }, provider: { enum: ["auto", "exa", "parallel", "custom"] }, fallback: { type: "boolean" },
      exaApiKey: nullableSecretSchema, parallelApiKey: nullableSecretSchema,
      custom: {
        type: "object", additionalProperties: false, required: ["name", "endpoint", "toolName"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 100 }, endpoint: { type: "string", minLength: 1, maxLength: 2_000 },
          toolName: { type: "string", minLength: 1, maxLength: 200 }, apiKey: nullableSecretSchema,
        },
      },
    },
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
      contexts: {
        type: "array",
        maxItems: 12,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "label", "text"],
          properties: {
            kind: { enum: ["playable-node", "playable-element", "playable-drawing", "playable-asset", "design-document", "canvas-board"] },
            label: { type: "string", minLength: 1, maxLength: 200 },
            text: { type: "string", minLength: 1, maxLength: 16_000 },
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
  "image/png", "image/jpeg", "image/svg+xml", "image/webp",
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
      model: modelRefSchema,
      size: { type: "string", enum: [...IMAGE_SIZES] },
      resolution: { type: "string", enum: [...new Set([...IMAGE_RESOLUTIONS, ...VIDEO_RESOLUTIONS])] },
      aspectRatio: { type: "string", enum: [...new Set([...IMAGE_ASPECT_RATIOS, ...VIDEO_ASPECT_RATIOS])] },
      outputs: { type: "integer", enum: [...IMAGE_OUTPUT_COUNTS] },
      duration: { type: "integer", minimum: 1, maximum: 30 },
      referenceMode: { enum: ["frame", "reference"] },
      targetPolycount: { type: "integer", minimum: 100, maximum: MODEL_3D_MAX_POLYCOUNT },
      texture: { type: "boolean" },
      pbr: { type: "boolean" },
      title: { type: "string", minLength: 1, maxLength: 80 },
      projectId: { type: "string", minLength: 1, maxLength: 200 },
      nodeId: { type: "string", minLength: 1, maxLength: 200 },
      assetId: { type: "string", minLength: 1, maxLength: 100 },
      actionIds: { type: "array", minItems: 1, maxItems: MAX_ANIMATION_ACTIONS, uniqueItems: true, items: { type: "integer", minimum: 0 } },
      heightMeters: { type: "number", exclusiveMinimum: 0, maximum: 100 },
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
        maxItems: 30,
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

const apiKeySettingsSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["apiKey"],
    properties: { apiKey: { type: "string", minLength: 1, maxLength: 10_000 } },
  },
} as const;

const TOOL_RUN_BODY_LIMIT = 25 * 1024 * 1024;

/** The Player build's sandbox page and its script, by the URL the daemon serves each at. */
const PLAYABLE_SANDBOX_FILES = new Map([
  ["/playable-sandbox/playable-sandbox.html", "playable-sandbox.html"],
  ["/playable-sandbox/assets/playable-sandbox.js", "assets/playable-sandbox.js"],
]);

export function createApp(options: AppOptions = {}) {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const dataDirectory = options.dataDirectory ?? path.join(repositoryRoot, ".data");
  const piAgentDirectory = options.piAgentDirectory ?? process.env.PI_CODING_AGENT_DIR ?? path.join(dataDirectory, "pi-agent");
  const conversationImages = new ConversationImageStore(path.join(dataDirectory, "cache", "conversation-images"));
  const events = new RuntimeEventBus(1_000, (event) => conversationImages.event(event));
  const library = new AssetLibrary(dataDirectory);
  const projects = new ProjectManager(dataDirectory, library);
  const attachments = new AgentAttachmentStore();
  const conversations = new ConversationManager(conversationImages);
  const agentPlaytests = new Map<string, OwnedPlaytestDriver>();
  const publishing = new Set<string>();
  const playerDirectory = options.interactiveStoryPlayerDirectory ?? path.join(repositoryRoot, "dist", "player");
  const artifacts = new ArtifactBuilder(library, playerDirectory);
  const playableDrafts = new PlayableDraftServer((project) => artifacts.preparePlayableDraft(project));
  const examples = new ExampleStore(options.examplesDirectory, (workspacePath, exampleId) => artifacts.preparePlayableExample(workspacePath, exampleId));
  const localPublisher = options.localDebug ? new LocalPublisher() : undefined;
  const publisher = localPublisher ?? new RemotePublisher({
    apiUrl: options.publishApiUrl ?? process.env.CLOUD_API_URL ?? process.env.PUBLISH_API_URL ?? "http://127.0.0.1:43130",
    fetch: options.publishFetch,
  });
  const previews = new PreviewManager(events);
  const webSearchSettings = new WebSearchSettingsStore(dataDirectory);
  const meshySettings = new MediaProviderKeyStore(dataDirectory, "meshy", "Meshy");
  const tripoSettings = new MediaProviderKeyStore(dataDirectory, "tripo", "Tripo");
  const native3DProviders = [["meshy", "Meshy", meshySettings], ["tripo", "Tripo", tripoSettings]] as const;
  const seedanceSettings = new SeedanceSettingsStore(dataDirectory);
  const providerModelSettings = new ProviderModelSettingsStore(dataDirectory, piAgentDirectory);
  const webSearch = new WebSearchService(webSearchSettings, options.webSearchFetch);
  const openAIEndpoint = new ModelEndpointSettingsStore(
    dataDirectory,
    "openai-endpoint.json",
    "https://api.openai.com/v1",
    "OpenAI",
  );
  // The custom Base URL is for OpenAI API keys only. A ChatGPT sign-in token must go to OpenAI
  // itself, never through a proxy, so the override is dropped while that credential is stored.
  let openAIEndpointRegistered = false;
  const syncOpenAIEndpoint = async (runtime: ModelRuntime) => {
    const baseUrl = openAIEndpoint.override();
    const signedIn = baseUrl
      ? (await runtime.listCredentials()).some((credential) => credential.providerId === "openai" && credential.type === "oauth")
      : false;
    if (baseUrl && !signedIn) {
      runtime.registerProvider("openai", { baseUrl });
      openAIEndpointRegistered = true;
    } else if (openAIEndpointRegistered) {
      runtime.unregisterProvider("openai");
      openAIEndpointRegistered = false;
    }
  };
  let modelRuntimePromise: Promise<ModelRuntime> | undefined;
  const getModelRuntime = () => modelRuntimePromise ??= (async () => {
    const runtime = await (options.createModelRuntime ?? (() => ModelRuntime.create({
      authPath: path.join(piAgentDirectory, "auth.json"),
      modelsPath: path.join(piAgentDirectory, "models.json"),
    })))();
    await syncOpenAIEndpoint(runtime);
    return runtime;
  })();
  const resolveModels = (runtime: ModelRuntime, models: RuntimeModel[]) => {
    if (!models.some((model) => model.reasoning && providerModelSettings.isCustom(model.provider))) return models;
    const catalog = customModelCatalog(runtime.getModels());
    return models.map((model) => providerModelSettings.resolveModel(model, catalog));
  };
  const resolveModel = (runtime: ModelRuntime, model: RuntimeModel | undefined) => model ? resolveModels(runtime, [model])[0] : undefined;
  const availableModel = async (provider: string, id: string) => {
    if (!providerEnabled(provider)) return undefined;
    const runtime = await getModelRuntime();
    return resolveModel(runtime, (await runtime.getAvailable(provider)).find((model) => model.id === id));
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
  const modelAuth = new ModelAuthManager(getModelRuntime, {
    // Same ID Pi's own CLI uses, persisted in the agent directory's global settings.
    getDeviceId: () => SettingsManager.create(piAgentDirectory, piAgentDirectory).getOrCreateDeviceId(),
    onCredentialsChanged: syncOpenAIEndpoint,
  });
  const providerEnabled = (id: string) => providerModelSettings.isEnabled(id);
  const providerImages = new ProviderImages(getModelRuntime, options.imageFetch, () => seedanceSettings.key("volcengine-ark"), providerEnabled, {
    customProviders: () => providerModelSettings.customProviderCatalog(),
    migrateLegacyModels: (id, models) => providerModelSettings.migrateLegacyImageModels(id, models, async () => { await (await getModelRuntime()).refresh({ allowNetwork: false, providers: [id] }); }),
    defaultModel: () => providerModelSettings.defaultImageModel(),
  });
  const providerVideos = new ProviderVideos(getModelRuntime, options.videoFetch, (providerId) => seedanceSettings.key(providerId), providerEnabled, {
    customProviders: () => providerModelSettings.customProviderCatalog(), defaultModel: () => providerModelSettings.defaultVideoModel(),
  });
  const providerModels3D = new ProviderModels3D(getModelRuntime,
    new MeshyProvider(() => meshySettings.key(), options.model3DFetch, undefined, () => providerEnabled("meshy")),
    () => meshySettings.get().configured, () => providerModelSettings.customProviderCatalog(), providerEnabled,
    options.model3DFetch, () => providerModelSettings.defaultModel3D(), {
      generator: new TripoProvider(() => tripoSettings.key(), options.model3DFetch, undefined, () => providerEnabled("tripo")),
      configured: () => tripoSettings.get().configured,
    });
  const tools = new ToolRunner(
    dataDirectory,
    options.imageGenerator ?? providerImages,
    options.model3DGenerator ?? providerModels3D,
    options.videoGenerator ?? providerVideos,
    library,
    async (toolId, input, projectId) => {
      if (toolId === "animate-3d") return input;
      const project = projectId ? projects.get(projectId) : undefined;
      if (projectId && !project) throw new ToolRunError("Project not found", 404);
      const usage = toolId === "generate-image" ? "image" : toolId === "generate-video" ? "video" : "3d";
      const key = usage === "image" ? "imageModel" : "model";
      const explicit = (input as { imageModel?: AgentModelRef; model?: AgentModelRef })[key];
      const globalDefault = usage === "image" ? providerModelSettings.defaultImageModel()
        : usage === "video" ? providerModelSettings.defaultVideoModel() : providerModelSettings.defaultModel3D();
      let selected = explicit ?? project?.mediaModelDefaults?.[usage] ?? globalDefault;
      const videoCatalog = usage === "video" && !options.videoGenerator ? await providerVideos.catalog() : undefined;
      if (!selected) {
        const injected = usage === "image" ? options.imageGenerator : usage === "video" ? options.videoGenerator : options.model3DGenerator;
        if (injected) return input;
        const catalog = videoCatalog ?? await (usage === "image" ? providerImages : providerModels3D).catalog();
        const first = catalog.models[0];
        if (first) selected = { provider: first.provider, id: first.id };
      }
      if (!selected) throw new ToolRunError(`No ${usage === "3d" ? "3D" : usage} model is available. Connect a provider and choose a default model in Providers or Project settings.`, 503);
      const videoModel = videoCatalog?.models.find((model) => model.provider === selected.provider && model.id === selected.id);
      if (videoModel) {
        const videoInput = input as RunVideoToolRequest;
        return { ...videoInput, model: selected,
          duration: videoInput.duration ?? videoModel.durations[0],
          resolution: videoInput.resolution ?? videoModel.resolutions[0],
          aspectRatio: videoInput.aspectRatio ?? videoModel.aspectRatios[0],
        };
      }
      return { ...input, [key]: { ...selected } };
    },
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
      const selected = await conversations.model(project, conversation);
      if (!selected) throw new Error("Select an available model before sending a prompt.");
      if (!providerEnabled(selected.provider)) throw new Error(`Provider ${selected.provider} is disabled. Enable it in Settings to continue.`);
      const model = resolveModel(modelRuntime, modelRuntime.getModel(selected.provider, selected.id));
      if (!model || !modelRuntime.hasConfiguredAuth(selected.provider)) {
        throw new Error(`The selected model ${selected.provider}/${selected.id} is not available`);
      }
      const playtestKey = `${project.id}:${conversation.summary.id}`;
      let playtest = agentPlaytests.get(playtestKey);
      if (!playtest && options.playtestDriver) {
        playtest = new OwnedPlaytestDriver(options.playtestDriver);
        agentPlaytests.set(playtestKey, playtest);
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
          playtest ? {
            driver: playtest,
            resolveOpenTarget: async () => ({
              runtime: "web",
              url: project.type === "interactive-story"
                ? await playableDrafts.open(project)
                : await previews.ensureStarted(project),
            }),
          } : undefined,
          webSearch.enabled() ? (input, signal) => webSearch.search(conversation.summary.id, input, signal) : undefined,
          canvasStore,
        ),
        modelRuntime,
        model,
        piAgentDirectory,
        () => resolvePluginSkills([bundledPlugins, localPlugins], pluginSettings, project.type),
      );
    }),
    activeToolNames: (project, mode, session) => {
      const registered = session.getAllTools?.().map((tool) => tool.name) ?? [];
      return projectPiToolNames(mode, TOOL_IDS, registered, webSearch.enabled());
    },
    onRunFinished: async (project, conversationId) => {
      await agentPlaytests.get(`${project.id}:${conversationId}`)?.cleanup();
    },
    onRunCompleted: (project) => {
      if (project.preview.status === "ready" || project.preview.status === "starting") return;
      void resolveStartupDirectory(project.workspacePath, project.startupDirectory ?? ".")
        .then(({ absolutePath }) => isRunnableWorkspace(absolutePath, project.startupScript ?? "dev"))
        .then((runnable) => {
          if (runnable) return previews.ensureStarted(project).catch(() => {});
        })
        .catch(() => {});
    },
  });
  const invalidatePluginSessions = () => {
    for (const project of projects.list()) agents.invalidateProjectSessions(project.id);
  };
  const app = Fastify({
    logger: options.logger ?? false,
    ajv: { customOptions: { coerceTypes: false } },
  });
  const canvasStore = registerCanvasRoutes(app, { projects, library, tools });

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
    await Promise.all([library.load(), projects.load(), tools.load(), pluginSettings.load(), bundledPlugins.load(), preinstalledPlugins.load(), webSearchSettings.load(), openAIEndpoint.load(), meshySettings.load(), tripoSettings.load(), seedanceSettings.load(), providerModelSettings.load()]);
    for (const error of await preinstalledPlugins.seed(localPlugins)) app.log.warn(error);
    const examplesWarning = await examples.load();
    if (examplesWarning) app.log.warn(examplesWarning);
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
    if (!options.accessToken || (request.method === "GET" && PLAYABLE_SANDBOX_FILES.has(request.url))) return;
    if (!matchesBearerToken(request.headers.authorization, options.accessToken)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  app.get("/health", async () => ({ status: "ok" }));

  // The page Scenes run in. The desktop app loads its own pages from file://,
  // where a sandboxed frame may not load its script, so the frame comes from
  // here instead. It is the public Player build, so it needs no token.
  for (const [url, file] of PLAYABLE_SANDBOX_FILES) {
    app.get(url, async (_request, reply) => reply
      .type(file.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8")
      .header("cache-control", "no-cache")
      .send(await readFile(path.join(playerDirectory, file))));
  }

  app.get("/settings/connections", async () => connections.list());

  app.get("/settings/web-search", async () => webSearchSettings.get());

  app.put<{ Body: UpdateWebSearchSettings }>("/settings/web-search", { schema: webSearchSettingsSchema }, async (request, reply) => {
    try {
      const settings = await webSearchSettings.update(request.body);
      invalidatePluginSessions();
      return settings;
    } catch (cause) {
      return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  });

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
      if (!plugin.installed) return reply.code(404).send({ error: "Installed plugin not found" });
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

  app.get("/tool-jobs", async () => tools.jobs());

  app.post<{ Params: { toolId: string }; Body: RunToolRequest & { title?: string; projectId?: string; nodeId?: string } }>(
    "/tools/:toolId/jobs",
    { schema: toolRunSchema, bodyLimit: TOOL_RUN_BODY_LIMIT },
    async (request, reply) => {
      try {
        const { title, projectId, nodeId, ...input } = request.body;
        if (Boolean(projectId) !== Boolean(nodeId)) {
          throw new ToolRunError("Project and node context must be provided together", 400);
        }
        if (projectId && !projects.get(projectId)) throw new ToolRunError("Project not found", 404);
        return reply.code(202).send(tools.start(request.params.toolId, input as RunToolRequest, {
          title: title?.trim(),
          ...(projectId && nodeId ? { context: { projectId, nodeId } } : {}),
        }));
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

  app.post<{ Body: CreateProjectRequest }>("/projects", { schema: createProjectSchema }, async (request, reply) => {
    try {
      if (request.body?.exampleId) {
        if (request.body.viewport) {
          return reply.code(400).send({ error: "Examples define their own viewport" });
        }
        const project = await examples.createProject(projects, request.body.exampleId, {
          type: request.body.type,
          name: request.body.name,
          workspacePath: request.body.workspacePath,
        });
        return reply.code(201).send(project);
      }
      if (request.body?.viewport && request.body.type !== "interactive-story") {
        return reply.code(400).send({ error: "A viewport requires an Interactive Story project" });
      }
      const project = await projects.create(request.body?.name, request.body?.type, request.body?.workspacePath);
      if (project.type === "interactive-story") {
        try {
          await createNodeCodebase(
            project.workspacePath,
            createPlayableStarterCodebase(project.name, request.body?.viewport ?? { width: 1280, height: 720 }),
          );
        } catch (cause) {
          await projects.delete(project.id);
          throw cause;
        }
      }
      return reply.code(201).send(project);
    } catch (cause) {
      if (cause instanceof ProjectWorkspaceError || cause instanceof NodeCodebaseError) {
        return reply.code(400).send({ error: cause.message });
      }
      if (cause instanceof ExampleError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
  });

  app.get("/projects", async () => projects.list());

  app.get("/projects/activity", async () => agents.projectActivity());

  app.get("/examples", async () => examples.list());

  app.post<{ Params: { exampleId: string } }>("/examples/:exampleId/play", async (request, reply) => {
    try {
      return { url: await examples.playUrl(request.params.exampleId) };
    } catch (cause) {
      if (cause instanceof ExampleError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
  });

  app.get<{ Params: { exampleId: string } }>("/examples/:exampleId/cover", async (request, reply) => {
    const cover = await examples.cover(request.params.exampleId);
    if (!cover) return reply.code(404).send({ error: "Example not found" });
    reply.header("content-type", "image/webp");
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    return reply.send(cover);
  });

  app.get<{ Params: { projectId: string } }>("/projects/:projectId/playable", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (project.type !== "interactive-story") return reply.code(409).send({ error: "Node Runtime requires an Interactive Story project" });
    try {
      const definition = await buildPlayableProject(project.workspacePath);
      return definition ? { available: true, definition } : { available: false };
    } catch (cause) {
      return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  });

  app.get<{ Params: { projectId: string }; Querystring: { mode?: "draft" | "publish" } }>(
    "/projects/:projectId/playable/validation",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { mode: { enum: ["draft", "publish"] } },
        },
      },
    },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      if (project.type !== "interactive-story") return reply.code(409).send({ error: "Playable validation requires an Interactive Story project" });
      return validatePlayableProject(project.workspacePath, request.query.mode ?? "draft");
    },
  );

  app.get<{ Params: { projectId: string } }>("/projects/:projectId/playable/codebase", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (project.type !== "interactive-story") return reply.code(409).send({ error: "Playable codebases require an Interactive Story project" });
    try {
      return await readNodeCodebase(project.workspacePath);
    } catch (cause) {
      return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  });

  app.put<{ Params: { projectId: string }; Body: NodeCodebaseUpdate }>("/projects/:projectId/playable/codebase", {
    schema: { body: { type: "object" } },
    bodyLimit: 1_000_000,
  }, async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (project.type !== "interactive-story") return reply.code(409).send({ error: "Playable codebases require an Interactive Story project" });
    try {
      await writeNodeCodebase(project.workspacePath, request.body);
    } catch (cause) {
      return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
    try {
      await projects.touch(project.id);
    } catch {
      return reply.code(500).send({ error: "Playable codebase was saved, but project metadata could not be updated" });
    }
    return reply.code(204).send();
  });

  app.get<{ Params: { projectId: string } }>("/projects/:projectId/playable/thumbnails", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    try {
      return { thumbnails: await listPlayableThumbnails(project.workspacePath) };
    } catch (cause) {
      return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  });

  app.get<{ Params: { projectId: string; nodeId: string } }>("/projects/:projectId/playable/thumbnails/:nodeId", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    try {
      const image = await readPlayableThumbnail(project.workspacePath, request.params.nodeId);
      if (!image) return reply.code(404).send({ error: "Thumbnail not found" });
      reply.header("content-type", "image/webp");
      reply.header("cache-control", "no-store");
      reply.header("x-content-type-options", "nosniff");
      return reply.send(image);
    } catch (cause) {
      if (cause instanceof PlayableThumbnailError) return reply.code(400).send({ error: cause.message });
      throw cause;
    }
  });

  app.put<{ Params: { projectId: string; nodeId: string }; Querystring: { hash: string }; Body: Buffer }>("/projects/:projectId/playable/thumbnails/:nodeId", {
    schema: {
      querystring: {
        type: "object",
        additionalProperties: false,
        required: ["hash"],
        properties: { hash: { type: "string", maxLength: 64 } },
      },
    },
  }, async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (project.type !== "interactive-story") return reply.code(409).send({ error: "Node thumbnails require an Interactive Story project" });
    if (!isWebp(request.body)) return reply.code(400).send({ error: "A Node thumbnail must be a WebP image" });
    try {
      const nodeIds = await readGraphNodeIds(project.workspacePath);
      return await writePlayableThumbnail(project.workspacePath, request.params.nodeId, request.query.hash, request.body, nodeIds);
    } catch (cause) {
      if (cause instanceof PlayableThumbnailError) return reply.code(400).send({ error: cause.message });
      throw cause;
    }
  });

  app.get("/playable/presets", async () => ({
    presets: PLAYABLE_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.label,
      summary: preset.summary,
    })),
  }));

  app.post<{ Params: { projectId: string }; Body: AddPlayableNodeRequest }>("/projects/:projectId/playable/nodes", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["preset", "id"],
        properties: {
          preset: { type: "string", maxLength: 60 },
          id: { type: "string", minLength: 1, maxLength: 60 },
          title: { type: "string", maxLength: 120 },
          position: {
            type: "object",
            additionalProperties: false,
            required: ["x", "y"],
            properties: { x: { type: "number" }, y: { type: "number" } },
          },
        },
      },
    },
  }, async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (project.type !== "interactive-story") return reply.code(409).send({ error: "Playable Nodes require an Interactive Story project" });
    let result;
    try {
      result = await addPlayableNode(project.workspacePath, request.body);
    } catch (cause) {
      return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
    try {
      await projects.touch(project.id);
    } catch {
      return reply.code(500).send({ error: "The Node was created, but project metadata could not be updated" });
    }
    return result;
  });

  const textGenerationOptions = {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["instruction"],
        properties: {
          instruction: { type: "string", minLength: 1, maxLength: 12_000 },
          reasoningLevel: { type: "string", enum: AGENT_REASONING_LEVELS },
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
  };

  const generateText = async (request: FastifyRequest<{ Params: { projectId: string; documentId?: string; tableId?: string }; Body: AssetCanvasTextGenerationRequest & { revision?: string } }>, reply: FastifyReply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    let document: CanvasDocumentDetail | undefined;
    let table: CanvasTableDetail | undefined;
    if (request.params.documentId) {
      try { document = await canvasStore.read(project.id, request.params.documentId); }
      catch (cause) { return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
      if (!document) return reply.code(404).send({ error: "Document not found" });
      if (document.revision !== request.body.revision) return reply.code(409).send({ error: "The document changed. Retry with the latest version." });
    }
    if (request.params.tableId) {
      try { table = await canvasStore.table(project.id, request.params.tableId); }
      catch (cause) { return reply.code(cause instanceof CanvasError ? cause.statusCode : 500).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
      if (table.revision !== request.body.revision) return reply.code(409).send({ error: "The table changed. Retry with the latest version." });
    }
    const runtime = await getModelRuntime();
    const settings = SettingsManager.create(project.workspacePath, piAgentDirectory);
    const provider = settings.getDefaultProvider();
    const id = settings.getDefaultModel();
    const selected = request.body.model ?? (provider && id ? { provider, id } : undefined);
    if (!selected) return reply.code(409).send({ error: "No language model is configured" });
    if (!providerEnabled(selected.provider)) return reply.code(409).send({ error: "The selected provider is disabled. Enable it in Settings to continue." });
    const model = resolveModel(runtime, runtime.getModel(selected.provider, selected.id));
    if (!model || !runtime.hasConfiguredAuth(selected.provider)) return reply.code(409).send({ error: "The selected language model is not available" });
    if (request.body.reasoningLevel && !supportedReasoningLevels(model).includes(request.body.reasoningLevel)) {
      return reply.code(400).send({ error: "The selected language model does not support this reasoning level" });
    }
    const reasoningLevel = effectiveReasoningLevel(model, request.body.reasoningLevel, defaultReasoningLevel(project.workspacePath, piAgentDirectory));
    try {
      if (document) {
        const result = await generateDesignDocumentMarkdown(runtime, model, document.document, request.body.instruction, reasoningLevel);
        return { ...result, model: selected, revision: document.revision };
      }
      if (table) {
        const result = await generateDesignTable(runtime, model, table.table, request.body.instruction, reasoningLevel);
        return { ...result, model: selected, revision: table.revision };
      }
      const text = await generateCreativeText(runtime, model, request.body.instruction, reasoningLevel);
      if (!text) return reply.code(502).send({ error: "The language model returned no text" });
      return { text, model: selected };
    } catch (cause) {
      return reply.code(502).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  app.post<{ Params: { projectId: string }; Body: AssetCanvasTextGenerationRequest }>(
    "/projects/:projectId/canvas/text/generate", textGenerationOptions,
    generateText,
  );

  const resourceGenerationOptions = { ...textGenerationOptions, schema: { body: { ...textGenerationOptions.schema.body, required: ["instruction", "revision"], properties: { ...textGenerationOptions.schema.body.properties, revision: { type: "string", minLength: 1, maxLength: 100 } } } } };
  app.post<{ Params: { projectId: string; documentId: string }; Body: CanvasDocumentGenerationRequest }>(
    "/projects/:projectId/canvas/documents/:documentId/generate",
    resourceGenerationOptions,
    generateText,
  );
  app.post<{ Params: { projectId: string; tableId: string }; Body: CanvasTableGenerationRequest }>(
    "/projects/:projectId/canvas/tables/:tableId/generate", resourceGenerationOptions, generateText,
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

  app.put<{ Params: { projectId: string }; Body: { startupDirectory: string } }>(
    "/projects/:projectId/settings/startup-directory",
    { schema: startupDirectorySchema },
    async (request, reply) => {
      try {
        const project = await projects.setStartupDirectory(request.params.projectId, request.body.startupDirectory);
        await previews.stop(project);
        return project;
      } catch (cause) {
        const statusCode = (cause as Error).message.startsWith("Project not found") ? 404 : 400;
        return reply.code(statusCode).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  );

  app.put<{
    Params: { projectId: string };
    Body: { startupDirectory: string; startupScript: string; packageManager?: "npm" | "pnpm" | "yarn" | "bun"; previewPath: string; previewViewport: "fit" | "tablet" | "mobile" };
  }>(
    "/projects/:projectId/settings/run",
    { schema: runSettingsSchema },
    async (request, reply) => {
      const existing = projects.get(request.params.projectId);
      if (!existing) return reply.code(404).send({ error: "Project not found" });
      const restartRequired = existing.startupDirectory !== (request.body.startupDirectory === "." ? undefined : request.body.startupDirectory) ||
        existing.startupScript !== (request.body.startupScript === "dev" ? undefined : request.body.startupScript) ||
        existing.packageManager !== request.body.packageManager;
      try {
        const project = await projects.setRunSettings(request.params.projectId, request.body);
        if (restartRequired) {
          await previews.stop(project);
          // The agent's system prompt names the startup directory, script, and package manager.
          agents.invalidateProjectSessions(project.id);
        }
        return project;
      } catch (cause) {
        return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  );

  app.put<{ Params: { projectId: string }; Body: MediaModelDefaults }>(
    "/projects/:projectId/settings/generation-models",
    { schema: { body: { type: "object", additionalProperties: true, properties: {
      image: modelRefSchema, video: modelRefSchema, "3d": modelRefSchema,
    } } } },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      if (Object.keys(request.body).some((key) => !["image", "video", "3d"].includes(key))) return reply.code(400).send({ error: "Unknown generation model setting" });
      for (const [usage, generator] of [["image", providerImages], ["video", providerVideos], ["3d", providerModels3D]] as const) {
        const ref = request.body[usage];
        const previous = project.mediaModelDefaults?.[usage];
        if (!ref || (ref.provider === previous?.provider && ref.id === previous.id)) continue;
        const catalog = await generator.catalog();
        if (!catalog.models.some((model) => model.provider === ref.provider && model.id === ref.id)) {
          return reply.code(400).send({ error: `The selected ${usage === "3d" ? "3D" : usage} model is not available` });
        }
      }
      return projects.setMediaModelDefaults(project.id, request.body);
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
    conversations.forget(project);
    for (const [key, driver] of agentPlaytests) {
      if (!key.startsWith(`${project.id}:`)) continue;
      await driver.cleanup();
      agentPlaytests.delete(key);
    }
    await conversationImages.removeProject(project.id);
    await canvasStore.cancelProject(project.id);
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

  app.get("/library/assets", async (request) => {
    const associations = await projects.libraryAssetAssociations((project, cause) => request.log.warn({ projectId: project.id, err: cause }, "Could not read Library asset usage"));
    return library.list().map((asset) => ({
      ...asset,
      projects: associations.get(asset.id)?.projects ?? [],
      referenceOnly: asset.purpose === "reference" && !associations.get(asset.id)?.hasAssetUsage,
    }));
  });

  app.post<{ Params: { assetId: string } }>("/library/assets/:assetId/save", async (request, reply) => {
    try {
      return await library.save(request.params.assetId);
    } catch (cause) {
      if (cause instanceof AssetLibraryError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
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
          purpose: { enum: ["asset", "reference"] },
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
      return reply.code(201).send(await library.add(name, contents, { origin: "uploaded", purpose: request.body.purpose }));
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      return reply.code(cause instanceof AssetLibraryError ? cause.statusCode : 500).send({ error });
    }
  });

  app.post<{ Querystring: { name: string; mediaType: string; duration?: string; purpose?: "asset" | "reference" }; Body: Buffer }>("/library/assets/upload", {
    schema: {
      querystring: {
        type: "object",
        additionalProperties: false,
        required: ["name", "mediaType"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200 },
          mediaType: { type: "string", enum: [...LIBRARY_UPLOAD_MEDIA_TYPES] },
          duration: { type: "string", pattern: "^(?:0|[1-9]\\d*)(?:\\.\\d+)?$" },
          purpose: { enum: ["asset", "reference"] },
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
      return reply.code(201).send(await library.add(name, contents, { origin: "uploaded", purpose: request.query.purpose, ...(duration !== undefined ? { duration } : {}) }));
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
      return reply.code(cause instanceof AssetLibraryError ? cause.statusCode : cause instanceof ProjectLibraryReferenceError ? 409 : 500).send({ error });
    }
  });

  app.get<{ Params: { projectId: string } }>("/projects/:projectId", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    return project ?? reply.code(404).send({ error: "Project not found" });
  });

  /** The project's own cover; an Interactive Story without one shows a Scene's thumbnail. */
  const projectCover = async (projectId: string): Promise<Buffer | undefined> => {
    const cover = await projects.cover(projectId);
    const project = projects.get(projectId);
    if (cover || project?.type !== "interactive-story") return cover;
    return readPlayableCover(project.workspacePath);
  };

  app.get<{ Params: { projectId: string } }>("/projects/:projectId/cover", async (request, reply) => {
    if (!projects.get(request.params.projectId)) return reply.code(404).send({ error: "Project not found" });
    const cover = await projectCover(request.params.projectId);
    if (!cover) return reply.code(404).send({ error: "Project cover not found" });
    reply.header("content-type", "image/webp");
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    return reply.send(cover);
  });

  app.get<{ Params: { projectId: string } }>("/projects/:projectId/cover/state", async (request, reply) => {
    if (!projects.get(request.params.projectId)) return reply.code(404).send({ error: "Project not found" });
    reply.header("cache-control", "no-store");
    return projects.coverState(request.params.projectId);
  });

  app.put<{ Params: { projectId: string }; Querystring: { source?: string }; Body: Buffer }>("/projects/:projectId/cover", async (request, reply) => {
    if (!projects.get(request.params.projectId)) return reply.code(404).send({ error: "Project not found" });
    const source = request.query.source ?? "custom";
    if (source !== "auto" && source !== "custom") return reply.code(400).send({ error: "Invalid cover source" });
    if (!isWebp(request.body)) return reply.code(400).send({ error: "Project cover must be a WebP image" });
    await projects.setCover(request.params.projectId, request.body, source);
    return reply.code(204).send();
  });

  app.delete<{ Params: { projectId: string } }>("/projects/:projectId/cover", async (request, reply) => {
    if (!projects.get(request.params.projectId)) return reply.code(404).send({ error: "Project not found" });
    await projects.restoreAutomaticCover(request.params.projectId);
    return reply.code(204).send();
  });

  app.get<{ Params: { projectId: string } }>("/projects/:projectId/files", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    const files = await listWorkspaceFiles(project.workspacePath);
    let usage: Map<string, boolean> | undefined;
    if (files.some((file) => (file.libraryAssetId ? library.get(file.libraryAssetId)?.purpose : file.purpose) === "reference")) {
      try { usage = await canvasLibraryAssetUsage(project.workspacePath); }
      catch (cause) { request.log.warn({ projectId: project.id, err: cause }, "Could not read project asset usage"); }
    }
    return files.map((file) => {
      if (!file.mediaType) return file;
      const asset = file.libraryAssetId ? library.get(file.libraryAssetId) : undefined;
      const origin = file.origin ?? asset?.origin;
      const purpose = asset?.purpose ?? file.purpose ?? "asset";
      return { ...file, origin: !origin || origin === "unknown" ? "workspace" : origin, purpose: purpose === "reference" && usage?.get(file.libraryAssetId ?? "") ? "asset" : purpose };
    });
  });

  app.post<{ Params: { projectId: string }; Body: { parent?: string; name: string; kind: "file" | "folder" } }>("/projects/:projectId/files", {
    schema: { body: { type: "object", additionalProperties: false, required: ["name", "kind"], properties: {
      parent: { type: "string", maxLength: 1000 }, name: { type: "string", minLength: 1, maxLength: 200 }, kind: { enum: ["file", "folder"] },
    } } },
  }, async (request, reply) => {
    try { return reply.code(201).send({ path: await projects.createWorkspaceEntry(request.params.projectId, request.body.parent ?? "", request.body.name, request.body.kind) }); }
    catch (cause) {
      if (cause instanceof ProjectAssetError || cause instanceof CanvasError) return reply.code(cause.statusCode).send({ error: cause.message });
      if (cause instanceof WorkspaceError) return reply.code(400).send({ error: cause.message });
      throw cause;
    }
  });

  app.patch<{ Params: { projectId: string }; Querystring: { path: string }; Body: { name: string } }>("/projects/:projectId/files", { schema: renameAssetSchema }, async (request, reply) => {
    try { return { path: await projects.renameWorkspaceEntry(request.params.projectId, request.query.path, request.body.name) }; }
    catch (cause) {
      if (cause instanceof ProjectAssetError || cause instanceof CanvasError) return reply.code(cause.statusCode).send({ error: cause.message });
      if (cause instanceof WorkspaceError) return reply.code(400).send({ error: cause.message });
      throw cause;
    }
  });

  app.delete<{ Params: { projectId: string }; Querystring: { path: string } }>("/projects/:projectId/files", { schema: { querystring: assetPathQuerySchema } }, async (request, reply) => {
    try { await projects.deleteWorkspaceEntry(request.params.projectId, request.query.path); return reply.code(204).send(); }
    catch (cause) {
      if (cause instanceof ProjectAssetError || cause instanceof CanvasError) return reply.code(cause.statusCode).send({ error: cause.message });
      if (cause instanceof WorkspaceError) return reply.code(400).send({ error: cause.message });
      throw cause;
    }
  });

  app.get<{ Params: { projectId: string }; Querystring: { path: string } }>(
    "/projects/:projectId/files/location",
    { schema: { querystring: assetPathQuerySchema } },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      try {
        return { path: await locateWorkspaceEntry(project.workspacePath, request.query.path) };
      } catch (cause) {
        if (cause instanceof WorkspaceError) return reply.code(400).send({ error: cause.message });
        throw cause;
      }
    },
  );

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

  app.post<{ Params: { projectId: string }; Querystring: { path: string } }>(
    "/projects/:projectId/assets/library",
    { schema: { querystring: assetPathQuerySchema } },
    async (request, reply) => {
      if (!projects.get(request.params.projectId)) return reply.code(404).send({ error: "Project not found" });
      try {
        const assetId = await projects.ensureLibraryAsset(request.params.projectId, request.query.path);
        return reply.code(201).send(await library.save(assetId));
      } catch (cause) {
        if (cause instanceof ProjectAssetError || cause instanceof AssetLibraryError) return reply.code(cause.statusCode).send({ error: cause.message });
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
        const asset = await projects.materializeLibraryAsset(project.id, request.params.assetId);
        await library.save(request.params.assetId);
        return reply.code(201).send(asset);
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
    const available = resolveModels(runtime, (await runtime.getAvailable()).filter((model) => providerEnabled(model.provider)));
    const models = available.filter((model) => providerModelSettings.isVisible(model));
    const hidden = available.filter((model) => !providerModelSettings.isVisible(model));
    const defaultModel = findAgentModel(models, configuredDefaultModel(dataDirectory, piAgentDirectory));
    const summary = (model: RuntimeModel) => ({
      provider: model.provider,
      providerName: runtime.getProvider(model.provider)?.name ?? model.provider,
      id: model.id,
      name: model.name,
      reasoningLevels: supportedReasoningLevels(model),
    });
    return {
      models: models.map(summary),
      ...(hidden.length ? { hiddenModels: hidden.map(summary) } : {}),
      ...(defaultModel ? { defaultModel: { provider: defaultModel.provider, id: defaultModel.id } } : {}),
      defaultReasoningLevel: defaultReasoningLevel(dataDirectory, piAgentDirectory),
    };
  });

  app.put<{ Body: UpdateAgentDefaultsRequest }>("/models/default", async (request, reply) => {
    if (!isUpdateAgentDefaultsRequest(request.body)) {
      return reply.code(400).send({ error: "Invalid agent defaults" });
    }
    if (!providerEnabled(request.body.model.provider)) return reply.code(400).send({ error: "Provider is disabled" });
    const model = await availableModel(request.body.model.provider, request.body.model.id);
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

  const providerSummaries = async () => {
    const piProviders = await modelAuth.providers();
    const customProviders = await providerModelSettings.customProviderCatalog();
    const customModels = new Map(customProviders.map((provider) => [provider.id, provider]));
    const customImageProviders = new Set(customProviders
      .filter((provider) => CUSTOM_IMAGE_MODEL_APIS.some((api) => api === provider.api)).map((provider) => provider.id));
    const providers = piProviders
      .map((provider) => {
        const custom = customModels.get(provider.id);
        return {
          ...provider,
          enabled: providerEnabled(provider.id),
          custom: providerModelSettings.isCustom(provider.id),
          ...(custom?.preset ? { preset: custom.preset } : {}),
          status: provider.configured ? "connected" as const : "not_configured" as const,
          capabilities: custom?.modelConfigurationVersion === 2
            ? [...new Set(custom.models.flatMap(modelUsageList))]
            : provider.id === "openrouter"
            ? ["language", "image", "video"] as const
            : provider.id === "openai" || customImageProviders.has(provider.id) ? ["language", "image"] as const : ["language"] as const,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    const directProviders = [...native3DProviders.map(([id, name, settings]) => ({
      id, name, enabled: providerEnabled(id), custom: false, configured: settings.get().configured,
      status: settings.get().configured ? "connected" as const : "not_configured" as const,
      methods: [{ type: "api_key" as const, label: `${name} API key` }],
      credentialType: "api_key" as const, capabilities: ["3d"] as const,
    })), ...SEEDANCE_PROVIDER_IDS.map((providerId) => {
      const definition = SEEDANCE_PROVIDERS[providerId];
      const configured = seedanceSettings.get(providerId).configured;
      return {
        id: definition.id,
        name: definition.name,
        configured,
        enabled: providerEnabled(providerId),
        custom: false,
        status: configured ? "connected" as const : "not_configured" as const,
        methods: [{ type: "api_key" as const, label: `${definition.name} API key` }],
        credentialType: "api_key" as const,
        capabilities: providerId === "volcengine-ark" ? ["image", "video"] as const : ["video"] as const,
      };
    })];
    return [...providers, ...directProviders].sort((left, right) => left.name.localeCompare(right.name));
  };
  app.get("/settings/providers", providerSummaries);

  app.patch<{ Params: { providerId: string }; Body: { enabled: boolean } }>("/settings/models/providers/:providerId/enabled", {
    schema: { body: { type: "object", additionalProperties: false, required: ["enabled"], properties: { enabled: { type: "boolean" } } } },
  }, async (request, reply) => {
    const provider = (await providerSummaries()).find((item) => item.id === request.params.providerId);
    if (!provider) return reply.code(404).send({ error: "Provider not found" });
    if (!provider.configured) return reply.code(400).send({ error: "Connect the provider before enabling it" });
    await providerModelSettings.setEnabled(provider.id, request.body.enabled);
    return { ...provider, enabled: request.body.enabled };
  });

  const saveCustomProvider = async (value: unknown, id: string) => {
    const runtime = await getModelRuntime();
    const catalog = customModelCatalog(runtime.getModels());
    const settings = normalizeCustomProvider(value, catalog);
    const previous = await providerModelSettings.customProvider(id, catalog);
    if (settings.authentication === "api_key" && !settings.apiKey && (previous?.authentication !== "api_key" || !runtime.hasConfiguredAuth(id))) throw new Error("API key is required");
    try {
      await providerModelSettings.saveCustomProvider(id, settings, async () => {
        await runtime.refresh({ allowNetwork: false, providers: [id] });
        // Compatible local services accept an internal placeholder; users do not need a key.
        const apiKey = settings.authentication === "none" ? "ohmygame-local" : settings.apiKey;
        if (apiKey) await runtime.login(id, "api_key", { signal: new AbortController().signal, notify: () => {}, prompt: async () => apiKey });
      });
    } catch (cause) {
      await runtime.refresh({ allowNetwork: false });
      throw cause;
    }
    for (const project of projects.list()) agents.invalidateProjectSessions(project.id);
    return providerModelSettings.customProvider(id, customModelCatalog(runtime.getModels()));
  };

  app.post<{ Body: DiscoverProviderModelsRequest }>("/settings/models/providers/discover", async (request, reply) => {
    try {
      const runtime = await getModelRuntime();
      const catalog = customModelCatalog(runtime.getModels());
      let connection = request.body;
      if (connection?.providerId !== undefined) {
        if (typeof connection.providerId !== "string" || !providerModelSettings.isCustom(connection.providerId)) return reply.code(404).send({ error: "Custom provider not found" });
        if (connection.authentication === "api_key" && !connection.apiKey?.trim()) {
          const provider = await providerModelSettings.customProvider(connection.providerId, catalog);
          if (provider?.authentication === "api_key") connection = { ...connection, apiKey: (await runtime.getAuth(connection.providerId))?.auth?.apiKey };
        }
      }
      return await discoverProviderModels(connection, options.modelDiscoveryFetch, catalog);
    }
    catch (cause) { return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
  });

  app.post("/settings/models/providers/custom", async (request, reply) => {
    try { return reply.code(201).send(await saveCustomProvider(request.body, `custom-${randomUUID()}`)); }
    catch (cause) { return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
  });
  app.get<{ Params: { providerId: string } }>("/settings/models/providers/:providerId/custom", async (request, reply) => {
    const { providerId } = request.params;
    const settings = await providerModelSettings.customProvider(providerId, customModelCatalog((await getModelRuntime()).getModels()));
    if (!settings) return reply.code(404).send({ error: "Custom provider not found" });
    return settings;
  });
  app.put<{ Params: { providerId: string } }>("/settings/models/providers/:providerId/custom", async (request, reply) => {
    if (!providerModelSettings.isCustom(request.params.providerId)) return reply.code(404).send({ error: "Custom provider not found" });
    try { return await saveCustomProvider(request.body, request.params.providerId); }
    catch (cause) { return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
  });
  const removeProvider = async (providerId: string) => {
    const runtime = await getModelRuntime();
    const native = native3DProviders.find(([id]) => id === providerId);
    const seedance = isSeedanceProviderId(providerId);
    if (!native && !seedance && !runtime.getProvider(providerId)) throw new ModelAuthError("Model provider not found", 404);
    const previousEndpoint = providerId === "openai" ? openAIEndpoint.override() : undefined;
    try {
      await providerModelSettings.removeProviderSettings(providerId, async () => {
        await runtime.refresh({ allowNetwork: false });
        if (previousEndpoint) await openAIEndpoint.update(openAIEndpoint.defaultBaseUrl);
        if (native) await native[2].clear();
        else if (seedance) await seedanceSettings.clear(providerId);
        else await runtime.logout(providerId);
        await syncOpenAIEndpoint(runtime);
      });
    } catch (cause) {
      if (previousEndpoint) await openAIEndpoint.update(previousEndpoint);
      await runtime.refresh({ allowNetwork: false });
      await syncOpenAIEndpoint(runtime);
      throw cause;
    }
    for (const project of projects.list()) agents.invalidateProjectSessions(project.id);
  };
  app.delete<{ Params: { providerId: string } }>("/settings/models/providers/:providerId", async (request, reply) => {
    try {
      await removeProvider(request.params.providerId);
      return reply.code(204).send();
    } catch (cause) {
      if (cause instanceof ModelAuthError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
  });
  app.delete<{ Params: { providerId: string } }>("/settings/models/providers/:providerId/custom", async (request, reply) => {
    if (!providerModelSettings.isCustom(request.params.providerId)) return reply.code(404).send({ error: "Custom provider not found" });
    await removeProvider(request.params.providerId);
    return reply.code(204).send();
  });

  for (const [id, , settings] of native3DProviders) {
    app.get(`/settings/models/providers/${id}`, async () => settings.get());
    app.put<{ Body: { apiKey: string } }>(`/settings/models/providers/${id}`, { schema: apiKeySettingsSchema }, async (request, reply) => {
      try { return await settings.update(request.body.apiKey); }
      catch (cause) { return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
    });
  }

  app.put<{ Params: { providerId: string }; Body: { apiKey: string } }>(
    "/settings/models/providers/:providerId/seedance-key",
    { schema: apiKeySettingsSchema },
    async (request, reply) => {
      if (!isSeedanceProviderId(request.params.providerId)) return reply.code(404).send({ error: "Seedance provider not found" });
      try { return await seedanceSettings.update(request.params.providerId, request.body.apiKey); }
      catch (cause) { return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
    },
  );
  app.delete<{ Params: { providerId: string } }>("/settings/models/providers/:providerId/seedance-key", async (request, reply) => {
    if (!isSeedanceProviderId(request.params.providerId)) return reply.code(404).send({ error: "Seedance provider not found" });
    await seedanceSettings.clear(request.params.providerId);
    return reply.code(204).send();
  });

  app.get("/settings/models/providers/openai/endpoint", async () => openAIEndpoint.get());

  const providerModels = async (runtime: ModelRuntime, providerId: string) => {
    const catalog = providerModelSettings.isCustom(providerId) ? customModelCatalog(runtime.getModels()) : new Map();
    const models = runtime.getModels(providerId).map((model) => providerModelSettings.resolveModel(model, catalog));
    const customProvider = await providerModelSettings.customProvider(providerId, catalog);
    const custom = customProvider?.models ?? await providerModelSettings.customModels(providerId);
    return {
      models: customProvider ? customProvider.models.map((model) => ({
        provider: providerId, providerName: customProvider.name, id: model.id, name: model.name,
        reasoningLevels: modelUsages(model).language ? supportedReasoningLevels(models.find((candidate) => candidate.id === model.id) ?? model) : [],
        visible: providerModelSettings.isVisible({ provider: providerId, id: model.id }), custom: true, capabilities: modelUsageList(model),
      })) : models.map((model) => ({
        provider: model.provider, providerName: runtime.getProvider(providerId)?.name ?? providerId,
        id: model.id, name: model.name, reasoningLevels: supportedReasoningLevels(model),
        visible: providerModelSettings.isVisible(model), custom: custom.some((item) => item.id === model.id),
      })),
      defaultApi: customProvider?.api ?? models[0]?.api ?? "openai-completions",
      defaultBaseUrl: runtime.getProvider(providerId)?.baseUrl ?? models[0]?.baseUrl,
      canAddCustomModel: runtime.hasConfiguredAuth(providerId) && !runtime.isUsingOAuth(providerId),
    };
  };

  app.get<{ Params: { providerId: string } }>("/settings/models/providers/:providerId/models", async (request, reply) => {
    const runtime = await getModelRuntime();
    if (!runtime.getProvider(request.params.providerId)) return reply.code(404).send({ error: "Provider not found" });
    return providerModels(runtime, request.params.providerId);
  });

  app.put<{ Params: { providerId: string }; Body: { ids: string[]; visible: boolean } }>("/settings/models/providers/:providerId/models/visibility", {
    schema: { body: { type: "object", additionalProperties: false, required: ["ids", "visible"], properties: { ids: { type: "array", minItems: 1, maxItems: 10_000, items: { type: "string", minLength: 1, maxLength: 200 } }, visible: { type: "boolean" } } } },
  }, async (request, reply) => {
    const runtime = await getModelRuntime();
    const { providerId } = request.params;
    if (!runtime.getProvider(providerId)) return reply.code(404).send({ error: "Provider not found" });
    const custom = await providerModelSettings.customProvider(providerId);
    const known = new Set(custom ? custom.models.map((model) => model.id) : runtime.getModels(providerId).map((model) => model.id));
    if (request.body.ids.some((id) => !known.has(id))) return reply.code(400).send({ error: "Model not found" });
    if (request.body.visible && custom?.models.some((model) => request.body.ids.includes(model.id) && !modelUsageList(model).length)) return reply.code(400).send({ error: "Assign a use to the model before enabling it" });
    await providerModelSettings.setVisibility(providerId, request.body.ids, request.body.visible);
    return providerModels(runtime, providerId);
  });

  app.post<{ Params: { providerId: string } }>("/settings/models/providers/:providerId/models/custom", async (request, reply) => {
    const runtime = await getModelRuntime();
    const { providerId } = request.params;
    if (!runtime.getProvider(providerId)) return reply.code(404).send({ error: "Provider not found" });
    try {
      const settings = await providerModels(runtime, providerId);
      if (!settings.canAddCustomModel) return reply.code(400).send({ error: "Custom models require an API key connection" });
      const model = normalizeCustomProviderModel(request.body, settings.defaultApi, settings.defaultBaseUrl, customModelCatalog(runtime.getModels()));
      if (runtime.getModel(providerId, model.id)) return reply.code(409).send({ error: "A model with this ID already exists" });
      await providerModelSettings.addCustomModel(providerId, model);
      await providerModelSettings.setVisibility(providerId, [model.id], true);
      await runtime.refresh({ allowNetwork: false, providers: [providerId] });
      return reply.code(201).send(await providerModels(runtime, providerId));
    } catch (cause) { return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
  });

  app.delete<{ Params: { providerId: string; modelId: string } }>("/settings/models/providers/:providerId/models/custom/:modelId", async (request, reply) => {
    const runtime = await getModelRuntime();
    const { providerId, modelId } = request.params;
    if (!runtime.getProvider(providerId)) return reply.code(404).send({ error: "Provider not found" });
    try {
      await providerModelSettings.removeCustomModel(providerId, modelId);
      await runtime.refresh({ allowNetwork: false, providers: [providerId] });
      return providerModels(runtime, providerId);
    } catch (cause) { return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
  });

  app.put<{ Body: { baseUrl: string } }>(
    "/settings/models/providers/openai/endpoint",
    { schema: modelEndpointSchema },
    async (request, reply) => {
      try {
        const runtime = await getModelRuntime();
        const settings = await openAIEndpoint.update(request.body.baseUrl);
        await syncOpenAIEndpoint(runtime);
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

  app.get("/image-models", async () => providerImages.models());
  app.get("/video-models", async () => providerVideos.models());
  for (const [path, usage, generator] of [
    ["image-models", "image", providerImages], ["video-models", "video", providerVideos], ["model3d-models", "3d", providerModels3D],
  ] as const) {
    app.get(`/${path}/catalog`, async () => generator.catalog());
    app.put<{ Body: AgentModelRef }>(`/${path}/default`, async (request, reply) => {
      if (!isAgentModelRef(request.body)) return reply.code(400).send({ error: "Invalid media model" });
      const catalog = await generator.catalog();
      if (!catalog.models.some((model) => model.provider === request.body.provider && model.id === request.body.id)) return reply.code(400).send({ error: "Media model is not available" });
      await providerModelSettings.setDefaultMediaModel(usage, request.body);
      return reply.code(204).send();
    });
    app.delete(`/${path}/default`, async (_request, reply) => {
      await providerModelSettings.setDefaultMediaModel(usage);
      return reply.code(204).send();
    });
  }
  app.get("/model3d-animations", async (_request, reply) => {
    if (!meshySettings.get().configured || !providerEnabled("meshy")) return [];
    try {
      return await tools.animationActions();
    } catch (cause) {
      if (cause instanceof ToolRunError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
  });

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
        selectedModel = await availableModel(requestedModel.provider, requestedModel.id);
      } else {
        const runtime = await getModelRuntime();
        selectedModel = preferredAgentModel(
          resolveModels(runtime, (await runtime.getAvailable()).filter((model) => providerEnabled(model.provider) && providerModelSettings.isVisible(model))),
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

  app.get<{ Params: { projectId: string; imageId: string } }>("/projects/:projectId/conversation-images/:imageId", async (request, reply) => {
    if (!projects.get(request.params.projectId)) return reply.code(404).send({ error: "Project not found" });
    const image = await conversationImages.read(request.params.projectId, request.params.imageId);
    if (!image) return reply.code(404).send({ error: "Image not found" });
    return reply.header("content-type", image.mediaType)
      .header("cache-control", "private, max-age=86400, immutable").send(image.data);
  });

  app.get<{ Params: { projectId: string; conversationId: string }; Querystring: { reset?: string } }>(
    "/projects/:projectId/conversations/:conversationId",
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const conversation = await conversations.get(project, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      const modelRef = await conversations.model(project, conversation);
      const planState = await conversations.planState(project, conversation);
      agents.restorePlanState(conversation, planState);
      const runtime = modelRef ? await getModelRuntime() : undefined;
      const model = runtime && modelRef ? resolveModel(runtime, runtime.getModel(modelRef.provider, modelRef.id)) : undefined;
      const settings = {
        ...(modelRef ? { model: modelRef } : {}),
        ...(model ? {
          reasoningLevel: effectiveReasoningLevel(
            model,
            await conversations.reasoningLevel(project, conversation),
            defaultReasoningLevel(project.workspacePath, piAgentDirectory),
          ),
        } : {}),
      };
      const branch = (await conversations.view(project, conversation)).getBranch();
      // Capture live state and its cursor together after all asynchronous reads.
      const currentRun = agents.activeStart(project.id, conversation.summary.id);
      const activeItems = agents.activeItems(project.id, conversation.summary.id);
      const activePlanState = agents.planState(conversation);
      const loadedItems = [
        ...conversationItems(currentRun ? branch.filter((entry) => entry.timestamp < currentRun.timestamp) : branch, !currentRun),
        // A reset must be a complete snapshot. Replaying from the active turn's
        // start is unsafe once a chat produces more events than the replay buffer.
        ...(currentRun ? activeItems : []),
      ].map((item) => conversationImages.item(project.id, item));
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
        pendingPrompts: agents.pendingPrompts(project.id, conversation.summary.id).map((prompt) => ({
          ...prompt, images: prompt.images.map((image) => conversationImages.project(project.id, image)),
        })),
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
      const model = await availableModel(request.body.provider, request.body.id);
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
            await conversations.reasoningLevel(project, conversation),
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
      const modelRef = await conversations.model(project, conversation);
      if (!modelRef) return reply.code(409).send({ error: "Select a model before changing reasoning" });
      const model = await availableModel(modelRef.provider, modelRef.id);
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

  app.post<{ Params: { projectId: string }; Querystring: { reuse?: string } }>("/projects/:projectId/preview", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    const reuse = request.query.reuse === "1";
    if (reuse && project.type !== "web-game") return reply.code(409).send({ error: "Play requires a Web Game project." });
    if (!reuse || (project.preview.status !== "ready" && project.preview.status !== "starting")) {
      try {
        const startup = await resolveStartupDirectory(project.workspacePath, project.startupDirectory ?? ".");
        const workspace = await previewWorkspaceStatus(startup.absolutePath, project.startupScript ?? "dev");
        if (!workspace.runnable) return reply.code(409).send({ error: workspace.error ?? "Workspace is not runnable yet" });
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
      }
    }
    const url = await (reuse ? previews.ensureStarted(project) : previews.start(project));
    return { url, title: project.name };
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
      const selectedModel = await conversations.model(project, conversation);
      if (selectedModel && !providerEnabled(selectedModel.provider)) return reply.code(409).send({ error: "The selected provider is disabled. Enable it in Settings to continue." });
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
      const contexts = (request.body.contexts ?? []).filter((context) => context.kind !== "design-document");
      if (request.body.contexts?.some((context) => context.kind === "design-document")) {
        try {
          const documentPath = references.find((reference) => /^canvas\/documents\/[a-zA-Z0-9_-]{1,100}\.md$/.test(reference.path))?.path;
          const detail = await canvasStore.read(project.id, documentPath?.split("/").at(-1)?.slice(0, -3));
          if (!detail) throw new CanvasError("This project does not have a game design document yet", 404);
          contexts.push(gameDesignReference(detail));
          const source = `canvas/documents/${detail.document.id}.md`;
          if (!references.some((reference) => reference.path === source)) references.push({ type: "workspace-file", path: source });
        } catch (cause) {
          return reply.code(cause instanceof CanvasError ? cause.statusCode : 500).send({ error: cause instanceof Error ? cause.message : String(cause) });
        }
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
          `${attachments.promptContext(project, resolvedAttachments)}${promptContextBlock(contexts)}`,
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
      const selectedModel = await conversations.model(project, conversation);
      if (selectedModel && !providerEnabled(selectedModel.provider)) return reply.code(409).send({ error: "The selected provider is disabled. Enable it in Settings to continue." });
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
      const selectedModel = await conversations.model(project, conversation);
      if (selectedModel && !providerEnabled(selectedModel.provider)) return reply.code(409).send({ error: "The selected provider is disabled. Enable it in Settings to continue." });
      agents.restorePlanState(conversation, await conversations.planState(project, conversation));
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
      agents.restorePlanState(conversation, await conversations.planState(project, conversation));
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
      agents.restorePlanState(conversation, await conversations.planState(project, conversation));
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
      const selectedModel = await conversations.model(project, conversation);
      if (selectedModel && !providerEnabled(selectedModel.provider)) return reply.code(409).send({ error: "The selected provider is disabled. Enable it in Settings to continue." });
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
      if (!localPublisher && request.body.accessToken === LOCAL_DEBUG_ACCESS_TOKEN) {
        return reply.code(401).send({ error: "Local debug sign-in is unavailable outside local development" });
      }
      if (agents.isProjectBusy(project.id)) {
        return reply.code(409).send({ error: "Wait for the agent to finish before publishing" });
      }
      if (publishing.has(project.id)) return reply.code(409).send({ error: "Project is already being published" });
      publishing.add(project.id);
      events.publish(project.id, "publish.started", {});
      try {
        const result = await publisher.publish(
          project,
          await artifacts.create(project, await projectCover(project.id)),
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

  app.post<{ Params: { projectId: string } }>("/projects/:projectId/interactive-story/build", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (project.type !== "interactive-story") return reply.code(409).send({ error: "Build requires an Interactive Story project" });
    if (agents.isProjectBusy(project.id)) return reply.code(409).send({ error: "Wait for the agent to finish before building" });
    if (publishing.has(project.id)) return reply.code(409).send({ error: "Project is already being published" });
    try {
      const artifact = await artifacts.buildInteractiveStory(project);
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
      reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
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
    await canvasStore.close();
    tools.close();
    modelAuth.close();
    await agents.close();
    await Promise.allSettled([...agentPlaytests.values()].map((driver) => driver.cleanup()));
    options.playtestDriver?.close();
    await conversationImages.flush();
    await previews.stopAll();
    await artifacts.close();
    await playableDrafts.close();
    await examples.close();
    await localPublisher?.close();
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
  if (mediaType === "image/svg+xml") {
    if (!isUtf8(value)) return false;
    const start = value.subarray(0, 64 * 1024).toString("utf8").replace(/^\uFEFF/, "");
    return /^(?:\s|<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!doctype\s+svg(?:\s[^>]*)?>)*<svg(?:\s|\/?>)/i.test(start);
  }
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
  const asset = await library.add(`${stem}${extension}`, contents, { origin: "uploaded", purpose: "reference", sourceKey: `conversation-image:${image.mediaType}:${digest}` });
  await projects.materializeLibraryAsset(projectId, asset.id);
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
