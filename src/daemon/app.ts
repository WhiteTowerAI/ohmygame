import { PluginIntegrationHost } from "./plugin-integration.js";
import { matchesPluginProject, requireIntegrationPlugin, registerPluginIntegrationRoutes, projectPreviewTool } from "./plugin-integration-routes.js";
import { CodexImageProvider } from "./agent-runtimes/codex-image-provider.js";
import { inspectPreviewConfiguration } from "./preview-configuration.js";
import { CheckpointStore } from "./checkpoints.js";
import { ProjectWrites } from "./project-writes.js";
import { registerCheckpointRoutes } from "./checkpoint-routes.js";
import { registerStoryWebRoutes } from "./story-web-routes.js";
import { readWorkspaceNotice, readWorkspaceVersion } from "./workspace-notice.js";
import { withCanvasLock } from "./canvas-workspace.js";
import { validatePreviewSettings } from "../shared/preview-settings.js";
import { previewPageUrl } from "../shared/preview-page.js";
import { PluginSetupManager, registerPluginSetupRoutes } from "./plugin-setup.js";
import { registerPluginIconRoutes } from "./plugin-icons.js";
import { PluginCapabilities } from "./plugin-capabilities.js";
import { registerPluginCapabilityRoutes } from "./plugin-capability-routes.js";
import { sniffImageType } from "./image-format.js";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { OnboardingStore } from "./onboarding.js";
import type { UpdateOnboardingRequest } from "../shared/onboarding.js";
import path from "node:path";
import { isWebStory } from "./story-web-project.js";
import { fileURLToPath } from "node:url";
import { ModelRuntime, SettingsManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import Fastify, { LogController, type FastifyReply, type FastifyRequest } from "fastify";
import { daemonLoggerOptions, logFailedRequests } from "./request-log.js";
import { ActivityLog } from "./activity-log.js";
import { diagnosticSection, registerDiagnosticsRoutes } from "./diagnostics.js";
import { AGENT_REASONING_LEVELS, IMAGE_ASPECT_RATIOS, IMAGE_MAX_REFERENCE_IMAGES, IMAGE_OUTPUT_COUNTS, IMAGE_RESOLUTIONS, IMAGE_SIZES, PROJECT_TYPE_IDS, PREVIEW_VIEWPORTS, TOOL_IDS, VIDEO_ASPECT_RATIOS, VIDEO_RESOLUTIONS, type AgentModelRef, type AgentReasoningLevel, type AnswerQuestionnaireRequest, type AssetCanvasTextGenerationRequest, type ConversationAgentSettings, type ConversationCapabilities, type ConversationDetail, type CreateConversationRequest, type CreateProjectRequest, type MediaModelDefaults, type ProjectRunSettings, type ProjectState, type ProjectType, type PromptImage, type PromptRequest, type PublishProjectRequest, type RenameConversationRequest, type ReviseLastPromptRequest, type RunToolRequest, type RunVideoToolRequest, type RuntimeEvent, type SetConversationModelRequest, type SetConversationReasoningRequest, type UpdateAgentDefaultsRequest } from "../shared/contracts.js";
import { findAgentModel, preferredAgentModel } from "../shared/agent-models.js";
import { isWebRuntimeProjectType, pluginProjectType, supportsWebPreview, webPreviewSettingsChanged } from "../shared/project-runtime.js";
import { groupThreadItems } from "../shared/turns.js";
import { RuntimeEventBus } from "../shared/events.js";
import { EXAMPLE_ID_PATTERN } from "../shared/examples.js";
import { PUBLISH_GAME_TITLE_MAX_LENGTH } from "../shared/publish-v1.js";
import { clampReasoningLevel, parseReasoningLevel, supportedReasoningLevels } from "../shared/reasoning.js";
import { matchesBearerToken } from "./access.js";
import { AgentManager, conversationItems, createPiSession, loadPiSkillCatalog, loadPiSkills, type RuntimeModel, type SessionFactory } from "./agent.js";
import { CHECKPOINT_UNDONE_ENTRY, TURN_END_ENTRY, referencedSnapshots } from "./checkpoint-extension.js";
import { createAgentTools, projectPiToolNames } from "./agent-tools.js";
import { AgentRuntimeService } from "./agent-runtimes/service.js";
import { neverTouchPaths } from "./agent-runtimes/policy.js";
import { skillFolders } from "./agent-runtimes/skills.js";
import { appendSystemPromptForProject } from "./agent-prompts.js";
import { ACCOUNT_RUNTIME_IDS, isAccountRuntimeId, isAccountProfileIds, isAgentRuntimeId, nativeEffort, type AgentRuntimeId, type AnswerApprovalRequest } from "../shared/agent-runtimes.js";
import { ConversationManager, sessionDirectory, type StoredConversation } from "./conversations.js";
import { ConversationImageStore } from "./conversation-images.js";
import { OwnedPlaytestDriver } from "./owned-playtest.js";
import { createGameUseTool } from "./playtest-tools.js";
import { ExternalMcpService } from "./external-mcp.js";
import { ExternalAgentClients } from "./external-agent-clients.js";
import { runCli } from "./agent-runtimes/discovery.js";
import { generateCreativeText, generateDesignDocumentMarkdown, generateDesignTable, generateProjectName } from "./text-generation.js";
import { ProjectNaming, type ProjectNameGenerator } from "./project-naming.js";
import { resolveCanvasTextReferences } from "./canvas-text-references.js";
import type { CanvasDocumentGenerationRequest, CanvasDocumentDetail } from "../shared/canvas-document.js";
import type { CanvasTableDetail, CanvasTableGenerationRequest } from "../shared/canvas-table.js";
import { registerCanvasRoutes } from "./canvas-routes.js";
import { registerAgentRuntimeRoutes } from "./agent-runtime-routes.js";
import { ASSET_NAME_BODY_SCHEMA, registerLibraryRoutes } from "./library-routes.js";
import { registerProviderSettingsRoutes } from "./provider-settings-routes.js";
import { CanvasError, canvasLibraryAssetUsage } from "./canvas-workspace.js";
import { gameDesignReference } from "./game-design-context.js";
import { ArtifactBuilder, PublishError } from "./publish/archive.js";
import { promptContextBlock } from "./prompt-context.js";
import { RemotePublisher, RemotePublishError } from "./publish/client.js";
import { registerCommunityRoutes } from "./publish/community-routes.js";
import { LocalPublisher } from "./publish/local.js";
import { LOCAL_DEBUG_ACCESS_TOKEN } from "../shared/local-debug.js";
import { PreviewManager, PreviewCancelledError } from "./preview.js";
import { ProjectAssetError, ProjectManager, ProjectWorkspaceError } from "./projects.js";
import { ExampleError, ExampleStore } from "./examples.js";
import { ModelCatalogRefresh } from "./model-catalog-refresh.js";
import { ModelAuthError, ModelAuthManager } from "./model-auth.js";
import { ModelEndpointSettingsStore } from "./model-endpoint-settings.js";
import { OpenAIImageSettingsStore } from "./openai-image-settings.js";
import { openAIImageConnection, registerOpenAIImageRoutes } from "./openai-image-routes.js";
import { NetworkSettingsService } from "./network-settings.js";
import type { NetworkSettings } from "../shared/network-settings.js";
import { migrateAzureProviderId } from "./azure-provider-migration.js";
import { ProviderModelSettingsStore } from "./provider-model-settings.js";
import { customModelCatalog } from "./custom-model-capabilities.js";
import { CUSTOM_IMAGE_MODEL_APIS } from "../shared/contracts.js";
import { Model3DGenerationError, type Model3DGenerator } from "./model3d.js";
import { CloudModelsClient } from "./cloud-models.js";
import { MAX_ANIMATION_ACTIONS, MODEL_3D_MAX_POLYCOUNT } from "../shared/generation-config.js";
import { MeshyProvider } from "./meshy-provider.js";
import { MediaProviderKeyStore } from "./media-provider-settings.js";
import { TripoProvider } from "./tripo-provider.js";
import { Hyper3DProvider } from "./hyper3d-provider.js";
import type { ImageGenerator } from "./openai-image.js";
import { ProviderImages } from "./provider-images.js";
import { ProviderModels3D } from "./provider-models3d.js";
import { modelUsageList } from "../shared/custom-models.js";
import { ToolRunner, ToolRunError } from "./tools.js";
import type { VideoGenerator } from "./video-generation.js";
import { ProviderVideos } from "./provider-videos.js";
import { ProviderAudio, type AudioGenerator } from "./audio-generation.js";
import { VolcengineTtsProvider } from "./volcengine-tts-provider.js";
import { VolcengineTtsSettingsStore } from "./volcengine-tts-settings.js";
import { VolcengineSeedAudioProvider } from "./volcengine-seed-audio-provider.js";
import { VolcengineSeedAudioSettingsStore } from "./volcengine-seed-audio-settings.js";
import { AUDIO_OUTPUT_FORMATS, AUDIO_SAMPLE_RATES, AUDIO_VOICE_ID_MAX_LENGTH, AUDIO_VOICE_ID_PATTERN, DOUBAO_SEED_AUDIO_PROVIDER_NAME, DOUBAO_SPEECH_PROVIDER_NAME, availableAudioOperations, type AudioOperation } from "../shared/audio.js";
import { SEEDANCE_PROVIDER_IDS, SEEDANCE_PROVIDERS } from "./seedance-models.js";
import { SeedanceSettingsStore } from "./seedance-settings.js";
import { MINIMAX_PROVIDER_IDS, MINIMAX_PROVIDERS } from "./minimax-models.js";
import { MinimaxSettingsStore } from "./minimax-settings.js";
import { BundledPluginAdapter, LocalPluginAdapter, PluginCatalogService, pluginSummary } from "./plugin-catalog.js";
import { BundledPluginStore } from "./bundled-plugins.js";
import { LocalPluginError, LocalPluginStore } from "./local-plugins.js";
import { inspectPluginSource, installPlugin } from "./plugin-installer.js";
import { InvalidPluginSettingsError, PluginSettingsStore } from "./plugin-settings.js";
import { PreinstalledPluginManager } from "./preinstalled-plugins.js";
import { registerPluginPortabilityRoutes } from "./plugin-portability.js";
import { PluginSkillContentError, pluginSkillFolders, readPluginSkillContent, resolvePluginSkillFile, resolvePluginSkills } from "./plugin-runtime.js";
import { LegacyMcpConfiguration } from "./legacy-mcp.js";
import { hasPluginMentionToken, pluginMentionToken, type InstallPluginRequest, type PluginSettings, type PluginSummary, type PluginDetail } from "../shared/plugins.js";
import { getWorkspaceMedia, listWorkspaceFiles, locateWorkspaceEntry, readWorkspaceFile, validateWorkspaceFile, WorkspaceError } from "./workspace.js";
import { listWorkspaceGitChanges, readWorkspaceGitFile } from "./workspace-git.js";
import { AssetLibrary, AssetLibraryError } from "./asset-library.js";
import { exportProjectArchive, importProjectArchive, ProjectArchiveError } from "./project-archive.js";
import { MAX_PROJECT_COVER_BYTES } from "./project-covers.js";
import { PROJECT_ARCHIVE_CONTENT_TYPE, PROJECT_ARCHIVE_MAX_BYTES } from "../shared/project-archive.js";
import { AgentAttachmentError, AgentAttachmentStore, MAX_AGENT_ATTACHMENT_BYTES, MAX_AGENT_ATTACHMENTS_PER_TURN } from "./agent-attachments.js";
import { WEB_GAME_USE_CAPABILITIES, type GameRuntimeAdapter, type GameUseOpenTarget } from "../shared/playtest.js";
import { EXTERNAL_AGENT_CLIENT_IDS, EXTERNAL_MCP_PATH, EXTERNAL_MCP_ROOTS_HEADER, type ExternalAgentClientId, type ExternalAgentSettings, type ExternalMcpLauncher, type UpdateExternalAgentSettings } from "../shared/external-mcp.js";
import type { UpdateWebSearchSettings } from "../shared/web-search.js";
import { WebSearchSettingsStore } from "./web-search-settings.js";
import { WebSearchService } from "./web-search.js";
import { buildPlayableProject, validatePlayableProject } from "./playable-project.js";
import {
  createNodeCodebase,
  createPlayableStarterCodebase,
  NodeCodebaseConflictError,
  NodeCodebaseError,
  openNodeCodebaseDetail,
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
  cloudApiUrl?: string;
  cloudFetch?: typeof fetch;
  dataDirectory?: string;
  piAgentDirectory?: string;
  logger?: boolean;
  /** Where the desktop app writes the logs a diagnostics export includes. */
  logDirectory?: string;
  accessToken?: string;
  allowedOrigins?: string[];
  publishApiUrl?: string;
  publishFetch?: typeof fetch;
  /** Enabled by the development entry point only when product auth is unconfigured. */
  localDebug?: boolean;
  createSession?: SessionFactory;
  generateProjectName?: ProjectNameGenerator;
  imageGenerator?: ImageGenerator;
  imageFetch?: typeof fetch;
  model3DGenerator?: Model3DGenerator;
  model3DFetch?: typeof fetch;
  videoGenerator?: VideoGenerator;
  videoFetch?: typeof fetch;
  audioGenerator?: AudioGenerator;
  audioFetch?: typeof fetch;
  modelDiscoveryFetch?: typeof fetch;
  createModelRuntime?: () => Promise<ModelRuntime>;
  bundledPluginsDirectory?: string;
  preinstalledPluginsDirectory?: string;
  /** Examples prepared by scripts/prepare-examples.ts; omitted means no examples. */
  examplesDirectory?: string;
  playtestDriver?: GameRuntimeAdapter;
  webSearchFetch?: typeof fetch;
  networkSettings?: NetworkSettingsService;
  /** How Claude Code and Codex start the `ohmygame-mcp` launcher; the desktop app provides it. */
  externalMcpLauncher?: ExternalMcpLauncher;
  /** The Skill copied to connected clients; defaults to the repository's. */
  externalAgentSkillDirectory?: string;
  /** Runs a client CLI's `mcp` commands; tests replace it. */
  runExternalAgentCli?: typeof runCli;
}

const createProjectSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", maxLength: PUBLISH_GAME_TITLE_MAX_LENGTH },
      type: { type: "string", enum: PROJECT_TYPE_IDS },
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
      pluginId: { type: "string", minLength: 1, maxLength: 512 },
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
      previewViewport: { enum: PREVIEW_VIEWPORTS },
      webPreviewEnabled: { type: "boolean" },
      previewAutoStart: { type: "boolean" },
      previewMode: { enum: ["auto", "script", "static", "command"] },
      previewCommand: { type: "string", maxLength: 2_000 },
      previewArguments: { type: "array", maxItems: 20, items: { type: "string", maxLength: 500 } },
      previewPort: { type: "integer", minimum: 1024, maximum: 65535 },
      previewIdleMinutes: { type: "integer", minimum: 0, maximum: 60 },
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
  body: ASSET_NAME_BODY_SCHEMA,
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
            kind: { enum: ["playable-node", "playable-element", "playable-drawing", "playable-asset", "playable-moment", "design-document", "canvas-board"] },
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

const AGENT_RUNTIME_BRIDGE_PATH = "/agent-runtime-bridge/mcp";

/** Lists game_use for external agents when the daemon runs without the desktop app. */
const UNAVAILABLE_GAME_RUNTIME: GameRuntimeAdapter = {
  available: false,
  capabilities: { ...WEB_GAME_USE_CAPABILITIES, projectTypes: [] },
  request: async () => { throw new Error("Game use is not available in this environment"); },
  close: () => {},
};

const externalAgentSettingsSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["enabled"],
    properties: { enabled: { type: "boolean" } },
  },
} as const;

const answerApprovalSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["decision"],
    properties: { decision: { enum: ["allow", "allow-session", "deny"] } },
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
const agentDefaultsSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["model"],
    properties: { model: modelRefSchema, reasoningLevel: { enum: AGENT_REASONING_LEVELS }, nativeReasoningLevel: { type: "string", minLength: 1, maxLength: 100 } },
  },
} as const;
const setConversationReasoningSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["level"],
    properties: { level: { type: "string", minLength: 1, maxLength: 100 } },
  },
} as const;
const MAX_LIBRARY_UPLOAD_BYTES = 200 * 1024 * 1024;
/** A prompt rechecks a plugin connection, such as an account login, at most this often. */
const PLUGIN_CONNECTION_MAX_AGE_MS = 10 * 60_000;

const toolRunSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      prompt: { type: "string", minLength: 1, maxLength: 32_000 },
      text: { type: "string", minLength: 1, maxLength: 10_000 },
      imageModel: modelRefSchema,
      model: modelRefSchema,
      size: { type: "string", enum: [...IMAGE_SIZES] },
      resolution: { type: "string", enum: [...new Set([...IMAGE_RESOLUTIONS, ...VIDEO_RESOLUTIONS])] },
      aspectRatio: { type: "string", enum: [...new Set([...IMAGE_ASPECT_RATIOS, ...VIDEO_ASPECT_RATIOS])] },
      outputs: { type: "integer", enum: [...IMAGE_OUTPUT_COUNTS] },
      duration: { type: "integer", minimum: 1, maximum: 30 },
      durationSeconds: { type: "number", minimum: 0.1, maximum: 600 },
      voiceId: { type: "string", minLength: 1, maxLength: AUDIO_VOICE_ID_MAX_LENGTH, pattern: AUDIO_VOICE_ID_PATTERN },
      language: { type: "string", minLength: 1, maxLength: 40 },
      style: { type: "string", minLength: 1, maxLength: 2_000 },
      speed: { type: "number", minimum: -50, maximum: 100 },
      loop: { type: "boolean" },
      instrumental: { type: "boolean" },
      lyrics: { type: "string", maxLength: 20_000 },
      negativePrompt: { type: "string", maxLength: 4_000 },
      referenceAssetId: { type: "string", minLength: 1, maxLength: 100 },
      output: {
        type: "object",
        additionalProperties: false,
        properties: {
          format: { enum: [...AUDIO_OUTPUT_FORMATS], description: "Must be supported by the selected model; Doubao Speech supports mp3 only." },
          sampleRate: { type: "integer", enum: [...AUDIO_SAMPLE_RATES] },
          channels: { type: "integer", enum: [1, 2] },
        },
      },
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
        maxItems: IMAGE_MAX_REFERENCE_IMAGES,
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

const TOOL_RUN_BODY_LIMIT = 25 * 1024 * 1024;
/** Why a story made before web stories cannot play, build, or publish yet. */
const NEEDS_UPGRADE = "This story was made before stories played as their own web page. Ask the user to open it in the Story editor, which upgrades it, then try again.";
const CHECKPOINT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function createApp(options: AppOptions = {}) {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const dataDirectory = options.dataDirectory ?? path.join(repositoryRoot, ".data");
  const piAgentDirectory = options.piAgentDirectory ?? process.env.PI_CODING_AGENT_DIR ?? path.join(dataDirectory, "pi-agent");
  const conversationImages = new ConversationImageStore(path.join(dataDirectory, "cache", "conversation-images"));
  const events = new RuntimeEventBus(1_000, (event) => conversationImages.event(event));
  const library = new AssetLibrary(dataDirectory);
  const projects = new ProjectManager(dataDirectory, library);
  const attachments = new AgentAttachmentStore();
  const conversations = new ConversationManager(conversationImages, (runtime, id) => agentRuntimes.settings.resolveProfileId(runtime, id));
  const agentPlaytests = new Map<string, OwnedPlaytestDriver>();
  const publishing = new Set<string>();
  const artifacts = new ArtifactBuilder();
  const examples = new ExampleStore(options.examplesDirectory);
  const localPublisher = options.localDebug ? new LocalPublisher() : undefined;
  const cloudModels = new CloudModelsClient(options.cloudApiUrl ?? options.publishApiUrl ?? process.env.CLOUD_API_URL ?? process.env.PUBLISH_API_URL ?? "http://127.0.0.1:43130", options.cloudFetch);
  const publisher = localPublisher ?? new RemotePublisher({
    apiUrl: options.publishApiUrl ?? process.env.CLOUD_API_URL ?? process.env.PUBLISH_API_URL ?? "http://127.0.0.1:43130",
    fetch: options.publishFetch,
    visitorTokenFile: path.join(dataDirectory, "community-visitor.json"),
  });
  const previews = new PreviewManager(events);
  const checkpoints = new CheckpointStore();
  const projectWrites = new ProjectWrites();
  const webSearchSettings = new WebSearchSettingsStore(dataDirectory);
  const onboarding = new OnboardingStore(dataDirectory);
  const networkSettings = options.networkSettings ?? new NetworkSettingsService(dataDirectory);
  const meshySettings = new MediaProviderKeyStore(dataDirectory, "meshy", "Meshy");
  const tripoSettings = new MediaProviderKeyStore(dataDirectory, "tripo", "Tripo");
  const hyper3dSettings = new MediaProviderKeyStore(dataDirectory, "hyper3d", "Hyper3D");
  const native3DProviders = [["meshy", "Meshy", meshySettings], ["tripo", "Tripo", tripoSettings], ["hyper3d", "Hyper3D", hyper3dSettings]] as const;
  const seedanceSettings = new SeedanceSettingsStore(dataDirectory);
  const minimaxSettings = new MinimaxSettingsStore(dataDirectory);
  const volcengineTtsSettings = new VolcengineTtsSettingsStore(dataDirectory);
  const volcengineSeedAudioSettings = new VolcengineSeedAudioSettingsStore(dataDirectory);
  const providerModelSettings = new ProviderModelSettingsStore(dataDirectory, piAgentDirectory);
  // Coding agents reach OhMyGame's tools over loopback only when they cannot take them over their own pipe.
  const agentRuntimes = new AgentRuntimeService(dataDirectory, () => {
    const address = app.server.address();
    return address && typeof address === "object" ? `http://127.0.0.1:${address.port}` : undefined;
  });
  /** Whether a model's provider is on: a Pi provider in Providers & Models, or a coding agent turned on there. */
  const modelProviderEnabled = (provider: string) => isAgentRuntimeId(provider) ? agentRuntimes.settings.get(provider).enabled : providerEnabled(provider);
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
  const catalogRefresh = new ModelCatalogRefresh((id) => providerEnabled(id) && !providerModelSettings.isCustom(id));
  let modelRuntimePromise: Promise<ModelRuntime> | undefined;
  const getModelRuntime = () => modelRuntimePromise ??= (async () => {
    const runtime = await (options.createModelRuntime ?? (() => ModelRuntime.create({
      authPath: path.join(piAgentDirectory, "auth.json"),
      modelsPath: path.join(piAgentDirectory, "models.json"),
    })))();
    await syncOpenAIEndpoint(runtime);
    catalogRefresh.schedule(runtime);
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
    events.publish(project.id, "project.renamed", { project: { ...project } });
  };
  const projectNaming = new ProjectNaming(projects, options.generateProjectName ?? (async (prompt, model, signal) => {
    if (!model) return undefined;
    const selected = await availableModel(model.provider, model.id);
    if (!selected || signal.aborted) return undefined;
    const runtime = await getModelRuntime();
    return generateProjectName(runtime, selected, prompt, signal);
  }), publishProjectRenamed);
  const openAIImages = new OpenAIImageSettingsStore(dataDirectory);
  const imageConnection = openAIImageConnection(openAIImages, getModelRuntime);
  const modelAuth = new ModelAuthManager(getModelRuntime, {
    // Same ID Pi's own CLI uses, persisted in the agent directory's global settings.
    getDeviceId: () => SettingsManager.create(piAgentDirectory, piAgentDirectory).getOrCreateDeviceId(),
    onCredentialsChanged: async (runtime, providerId) => {
      await syncOpenAIEndpoint(runtime);
      catalogRefresh.invalidate(providerId);
      void catalogRefresh.refresh(runtime, providerId, true).catch(() => {});
    },
  });
  const providerEnabled = (id: string) => id === "hyper3d" || id === "cloud-hyper3d"
    ? providerModelSettings.isEnabled("hyper3d") && providerModelSettings.isEnabled("cloud-hyper3d")
    : providerModelSettings.isEnabled(id);
  const codexImages = new CodexImageProvider(path.join(dataDirectory, "agent-runtimes"), (recheck) => agentRuntimes.codexImageConnection(recheck));
  const providerImages = new ProviderImages(getModelRuntime, options.imageFetch, () => seedanceSettings.key("volcengine-ark"), providerEnabled, {
    codexImages,
    openAIConnection: () => imageConnection.resolve(),
    customProviders: () => providerModelSettings.customProviderCatalog(),
    migrateLegacyModels: (id, models) => providerModelSettings.migrateLegacyImageModels(id, models, async () => { await (await getModelRuntime()).refresh({ allowNetwork: false, providers: [id] }); }),
    defaultModel: () => providerModelSettings.defaultImageModel(),
  });
  const providerVideos = new ProviderVideos(getModelRuntime, options.videoFetch, (providerId) => seedanceSettings.key(providerId), providerEnabled, {
    customProviders: () => providerModelSettings.customProviderCatalog(), defaultModel: () => providerModelSettings.defaultVideoModel(),
    minimaxApiKey: (providerId) => minimaxSettings.key(providerId),
  });
  const providerModels3D = new ProviderModels3D({
    runtime: getModelRuntime,
    meshy: { generator: new MeshyProvider(() => meshySettings.key(), options.model3DFetch, undefined, () => providerEnabled("meshy")), configured: () => meshySettings.get().configured },
    tripo: { generator: new TripoProvider(() => tripoSettings.key(), options.model3DFetch, undefined, () => providerEnabled("tripo")), configured: () => tripoSettings.get().configured },
    hyper3d: { generator: new Hyper3DProvider(() => hyper3dSettings.key(), options.model3DFetch, undefined, () => providerEnabled("hyper3d")), configured: () => hyper3dSettings.get().configured },
    customProviders: () => providerModelSettings.customProviderCatalog(),
    nativeModels: (id) => providerModelSettings.models3D(id), isVisible: (model) => providerModelSettings.isVisible(model),
    isEnabled: providerEnabled, request: options.model3DFetch, defaultModel: () => providerModelSettings.defaultModel3D(), cloud: cloudModels,
  });
  const volcengineTtsProvider = new VolcengineTtsProvider(
    () => volcengineTtsSettings.key(),
    options.audioFetch,
    undefined,
    () => providerEnabled("volcengine-tts"),
    () => volcengineTtsSettings.defaultVoiceId(),
  );
  const volcengineSeedAudioProvider = new VolcengineSeedAudioProvider(
    () => volcengineSeedAudioSettings.key(),
    options.audioFetch,
    undefined,
    () => providerEnabled("volcengine-seed-audio"),
  );
  const providerAudio = new ProviderAudio([volcengineTtsProvider, volcengineSeedAudioProvider]);
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
      const audioOperation: AudioOperation | undefined = toolId === "generate-speech" ? "speech"
        : toolId === "generate-sound-effect" ? "sound-effect"
          : toolId === "generate-music" ? "music" : undefined;
      if (audioOperation) {
        const explicit = (input as { model?: AgentModelRef }).model;
        const selected = providerAudio.resolveModel(audioOperation, explicit);
        if (!selected) {
          if (options.audioGenerator) return input;
          throw new ToolRunError(`No ${audioOperation === "sound-effect" ? "sound effect" : audioOperation} model is available. Connect an audio provider first.`, 503);
        }
        return { ...input, model: { provider: selected.provider, id: selected.id } };
      }
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
        const processing3D = usage === "3d" && "operation" in input && (input.operation === "retexture" || input.operation === "remesh");
        const catalog = processing3D ? { models: (await providerModels3D.operationModels()).filter((model) => model.operations?.includes(input.operation!)) } : videoCatalog ?? await (usage === "image" ? providerImages : providerModels3D).catalog();
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
    options.audioGenerator ?? providerAudio,
  );
  const pluginSettings = new PluginSettingsStore(dataDirectory);
  const legacyMcp = new LegacyMcpConfiguration(piAgentDirectory);
  const bundledPlugins = new BundledPluginStore(options.bundledPluginsDirectory ?? path.join(repositoryRoot, "plugins"));
  const preinstalledPlugins = new PreinstalledPluginManager(
    options.preinstalledPluginsDirectory,
    dataDirectory,
  );
  const localPlugins = new LocalPluginStore(dataDirectory);
  const pluginCapabilities = new PluginCapabilities(dataDirectory, piAgentDirectory, [bundledPlugins, localPlugins], localPlugins, pluginSettings);
  const summarizePlugin = (plugin: PluginDetail): PluginSummary => ({
    ...pluginSummary(plugin),
    mcpServerCount: plugin.mcpServers?.length ?? 0,
    configurationStatus: pluginCapabilities.configuration.view(plugin).missing.length ? "needs-configuration" : "ready",
  });
  const plugins = new PluginCatalogService([
    new BundledPluginAdapter(bundledPlugins, summarizePlugin),
    new LocalPluginAdapter(localPlugins, summarizePlugin),
  ], pluginSettings, (plugin) => preinstalledPlugins.decorate(plugin));
  const withPluginCapabilities = async (plugin: Awaited<ReturnType<typeof plugins.read>>) => plugin ? pluginCapabilities.decorate(plugin) : plugin;
  const pluginIntegrations = new PluginIntegrationHost(pluginCapabilities, (project) => project ? agents.invalidateProjectSessions(project.id) : invalidatePluginSessions(), (project, operation) => projectWrites.exclusive(project.id, async () => {
    if (agents.isProjectBusy(project.id)) throw new Error("Wait for the agent to finish before connecting the project");
    if (await checkpoints.unfinished(project)) throw new Error("Recover the interrupted file restore before connecting the project");
    return operation();
  }));
  let agents: AgentManager;
  const snapshotWorkspace = (project: ProjectState) => projectWrites.snapshot(project.id, async () => {
    if (!projects.get(project.id)) throw new Error("Project not found");
    if (await checkpoints.unfinished(project)) throw new Error("Recover the interrupted file restore before continuing.");
    await canvasStore.waitForProject(project.id);
    return withCanvasLock(project.workspacePath, () => checkpoints.snapshot(project));
  });
  // At most once a day, after a run, the snapshots that no conversation names any more are removed. Removing the
  // project, Undo and Restore hold the workspace exclusively; a prune whose turn comes then is left for later.
  const pruneCheckpoints = async (project: ProjectState) => {
    const idle = () => !!projects.get(project.id) && !agents.isProjectBusy(project.id) && !projectWrites.isMutating(project.id);
    if (!idle()) return;
    try {
      await checkpoints.prune(project, () => referencedSnapshots(sessionDirectory(project)), {
        interval: CHECKPOINT_PRUNE_INTERVAL_MS,
        proceed: idle,
      });
    } catch (err) {
      app.log.warn({ err, projectId: project.id }, "Could not prune checkpoints");
    }
  };
  /** OhMyGame's own tools for a conversation, the same for Pi and for a coding agent. */
  const projectAgentTools = (project: ProjectState, conversation: StoredConversation) => {
    const playtestKey = `${project.id}:${conversation.summary.id}`;
    let playtest = agentPlaytests.get(playtestKey);
    if (!playtest && options.playtestDriver) {
      playtest = new OwnedPlaytestDriver(options.playtestDriver);
      agentPlaytests.set(playtestKey, playtest);
    }
    return [...createAgentTools(
      project,
      tools,
      projects,
      (toolCallId, input, signal) => agents.askQuestionnaire(project.id, conversation.summary.id, toolCallId, input, signal),
      async (sourcePath) => {
        const installed = await localPlugins.install(sourcePath);
        invalidatePluginSessions();
        return await plugins.read(installed.id) ?? installed;
      },
      playtest ? { driver: playtest, resolveOpenTarget: () => playtestTarget(project) } : undefined,
      webSearch.enabled() ? (input, signal) => webSearch.search(conversation.summary.id, input, signal) : undefined,
      canvasStore,
    ), ...(project.integration?.preview === "external" ? [projectPreviewTool(project, plugins, pluginIntegrations)] : [])];
  };
  const playtestTarget = async (project: ProjectState): Promise<GameUseOpenTarget> => {
    // A story plays its own page, which one made before web stories has once the editor upgrades it.
    if (project.type === "interactive-story" && !await isWebStory(project.workspacePath))
      throw new Error(NEEDS_UPGRADE);
    return { runtime: "web", url: previewPageUrl(await previews.ensureStarted(project, false), "playtest") };
  };
  /** OhMyGame's tools for agents outside the app; playtest windows belong to their MCP session. */
  const externalMcp = new ExternalMcpService({
    dataDirectory,
    projects: () => projects.list(),
    tools: (project, sessionId) => {
      const playtestKey = `${project.id}:external:${sessionId}`;
      let playtest = agentPlaytests.get(playtestKey);
      if (!playtest && options.playtestDriver) {
        playtest = new OwnedPlaytestDriver(options.playtestDriver);
        agentPlaytests.set(playtestKey, playtest);
      }
      return createAgentTools(
        project, tools, projects, undefined, undefined,
        playtest ? { driver: playtest, resolveOpenTarget: () => playtestTarget(project) } : undefined,
        undefined, canvasStore,
      );
    },
    catalog: () => {
      // Only the schemas are read. A story project has every project tool, and the
      // full game_use input is listed; a story's own game_use accepts a subset.
      const placeholder: ProjectState = { id: "", name: "", type: "interactive-story", updatedAt: "", workspacePath: "", preview: { status: "stopped" } };
      return [
        ...createAgentTools(placeholder, tools, projects, undefined, undefined, undefined, undefined, canvasStore),
        createGameUseTool(options.playtestDriver ?? UNAVAILABLE_GAME_RUNTIME, () => playtestTarget(placeholder)),
      ];
    },
    release: async (projectId, sessionId) => {
      const key = `${projectId}:external:${sessionId}`;
      await agentPlaytests.get(key)?.cleanup();
      agentPlaytests.delete(key);
    },
  });
  const externalClients = new ExternalAgentClients({
    dataDirectory,
    ...(options.externalMcpLauncher ? { launcher: options.externalMcpLauncher } : {}),
    skillDirectory: options.externalAgentSkillDirectory ?? path.join(repositoryRoot, "integrations", "skills", "ohmygame-studio"),
    resolve: (runtime) => agentRuntimes.cli(runtime),
    run: options.runExternalAgentCli ?? runCli,
  });
  const externalAgentSettings = async (): Promise<ExternalAgentSettings> => ({
    enabled: externalMcp.enabled,
    ...(externalClients.launcher ? { launcher: externalClients.launcher } : {}),
    clients: await externalClients.states(),
  });
  /** A conversation run by a coding agent CLI, kept in the same session file and checkpoints as Pi's. */
  const createNativeSession = async (project: ProjectState, conversation: StoredConversation, runtime: AgentRuntimeId, modelId: string) => {
    const resolvePlugins = () => resolvePluginSkills([bundledPlugins, localPlugins], pluginSettings, project.type);
    const [pluginSkills, ownSkills, catalog, effectiveMcp, reasoningLevel] = await Promise.all([
      resolvePlugins(),
      skillFolders(path.join(piAgentDirectory, "skills")),
      loadPiSkills(project.workspacePath, piAgentDirectory, resolvePlugins).catch(() => []),
      pluginCapabilities.effective(project.type),
      conversations.nativeReasoningLevel(project, conversation, { provider: runtime, id: modelId }),
    ]);
    const profileId = isAccountRuntimeId(runtime) ? await conversations.accountProfileId(project, conversation, runtime) : undefined;
    const model = await agentRuntimes.model(runtime, modelId, profileId);
    const effort = nativeEffort(model, reasoningLevel);
    return agentRuntimes.createSession({
      runtime,
      ...(profileId ? { profileId } : {}),
      model: modelId,
      ...(effort ? { reasoningLevel: effort } : {}),
      ...(model?.contextWindow ? { contextWindow: model.contextWindow } : {}),
      workspacePath: project.workspacePath,
      sessionManager: conversations.open(project, conversation),
      tools: projectAgentTools(project, conversation),
      saveGeneratedImage: (fileName, bytes, prompt) => projects.addGeneratedAsset(project.id, fileName, bytes, { prompt }),
      pluginMcp: { config: effectiveMcp, host: pluginCapabilities.host, agentDir: piAgentDirectory },
      skillDirectories: [...pluginSkillFolders(pluginSkills), ...ownSkills],
      instructions: appendSystemPromptForProject(project).join("\n\n"),
      policy: {
        workspacePath: project.workspacePath,
        neverTouch: [...neverTouchPaths(dataDirectory, piAgentDirectory, projects.list().filter((other) => other.id !== project.id).map((other) => other.workspacePath)), ...ACCOUNT_RUNTIME_IDS.flatMap((runtime) => agentRuntimes.settings.profiles(runtime)).flatMap((profile) => profile.configDirectory ? [profile.configDirectory] : [])],
      },
      snapshotBeforeMessage: () => snapshotWorkspace(project),
      turnNotice: () => readWorkspaceNotice(project),
      requestApproval: (details, toolCallId, signal) => agents.askApproval(project.id, conversation.summary.id, toolCallId, details, signal),
      skills: () => catalog,
    });
  };
  agents = new AgentManager(events, {
    errorDiagnostics: () => {
      const route = networkSettings.get().active;
      return { network: { source: route.source, ...(route.httpsProxy ? { proxyUrl: route.httpsProxy } : {}) } };
    },
    ...(options.createSession ? {} : {
      loadSkills: (project) => loadPiSkills(
        project.workspacePath,
        piAgentDirectory,
        () => resolvePluginSkills([bundledPlugins, localPlugins], pluginSettings, project.type),
      ),
    }),
    createSession: options.createSession ?? (async (project, conversation) => {
      const selected = await conversations.model(project, conversation);
      if (!selected) throw new Error("Select an available model before sending a prompt.");
      if (isAgentRuntimeId(selected.provider)) return createNativeSession(project, conversation, selected.provider, selected.id);
      const modelRuntime = await getModelRuntime();
      if (!providerEnabled(selected.provider)) throw new Error(`Provider ${selected.provider} is disabled. Enable it in Settings to continue.`);
      const model = resolveModel(modelRuntime, modelRuntime.getModel(selected.provider, selected.id));
      if (!model || !modelRuntime.hasConfiguredAuth(selected.provider)) {
        throw new Error(`The selected model ${selected.provider}/${selected.id} is not available`);
      }
      const effectiveMcp = await pluginCapabilities.effective(project.type);
      return createPiSession(
        project,
        conversations.open(project, conversation),
        projectAgentTools(project, conversation),
        modelRuntime,
        model,
        piAgentDirectory,
        () => resolvePluginSkills([bundledPlugins, localPlugins], pluginSettings, project.type),
        Object.keys(effectiveMcp.mcpServers).length ? { factory: await pluginCapabilities.host.extension(effectiveMcp), host: pluginCapabilities.host } : undefined,
        (provider) => providerModelSettings.responsesTransport(provider),
        () => snapshotWorkspace(project),
      );
    }),
    activeToolNames: (project, mode, session) => {
      const registered = session.getAllTools?.().map((tool) => tool.name) ?? [];
      const audioOperations = availableAudioOperations(providerAudio.catalog().models);
      const enabledTools = TOOL_IDS.filter((toolId) => toolId === "generate-speech" ? audioOperations.has("speech")
        : toolId === "generate-sound-effect" ? audioOperations.has("sound-effect")
          : toolId === "generate-music" ? audioOperations.has("music") : true);
      return projectPiToolNames(mode, enabledTools, registered, webSearch.enabled());
    },
    onRunFinished: async (project, conversationId) => {
      await agentPlaytests.get(`${project.id}:${conversationId}`)?.cleanup();
    },
    checkpoints: {
      snapshot: snapshotWorkspace,
      changed: (project, from, to) => checkpoints.summarize(project, from, to),
    },
    onRunCompleted: (project) => {
      void previews.automatic(project, true).catch(() => {});
      void pruneCheckpoints(project);
    },
  });
  const invalidatePluginSessions = () => {
    for (const project of projects.list()) agents.invalidateProjectSessions(project.id);
  };
  const app = Fastify({
    logger: options.logger ? daemonLoggerOptions() : false,
    logController: new LogController({ disableRequestLogging: true }),
    // First-run plugin extraction can exceed Fastify's default 10s on Windows.
    pluginTimeout: 60_000,
    ajv: { customOptions: { coerceTypes: false } },
  });
  if (options.logger) {
    logFailedRequests(app);
    const activity = new ActivityLog(app.log);
    tools.setLogger(app.log);
    events.subscribeAll((event) => activity.event(event));
  }
  projectWrites.install(app);
  const canvasStore = registerCanvasRoutes(app, { projects, library, tools });
  // Selecting or clearing an integration changes the project's preview, tools and prompt.
  const changeProjectIntegration = async (project: ProjectState, change: () => Promise<ProjectState>): Promise<ProjectState> => {
    if (agents.isProjectBusy(project.id)) throw new LocalPluginError("Wait for the agent to finish before changing the project integration", 409);
    const updated = await change();
    if (!supportsWebPreview(updated)) await previews.stop(updated, "settings");
    agents.invalidateProjectSessions(updated.id);
    events.publish(updated.id, "project.updated", { project: structuredClone(updated) });
    return updated;
  };
  const selectProjectIntegration = (project: ProjectState, plugin: PluginDetail) => changeProjectIntegration(project,
    () => projects.setIntegration(project.id, { pluginId: plugin.id, preview: plugin.integration!.preview }));
  const clearProjectIntegration = (project: ProjectState) => changeProjectIntegration(project, async () => {
    const { pluginId } = project.integration!;
    const running = pluginIntegrations.state(pluginId, project.id)?.result?.preview?.status === "running";
    await pluginIntegrations.forget(pluginId, project.id);
    // Its controls leave with the integration, so stop a native preview it started.
    const plugin = running ? await plugins.read(pluginId) : undefined;
    if (plugin?.enabled) await pluginIntegrations.execute(plugin, "preview-stop", project).catch(() => {});
    return projects.clearIntegration(project.id);
  });
  registerPluginIntegrationRoutes(app, { host: pluginIntegrations, plugins, projects, select: selectProjectIntegration, clear: clearProjectIntegration });
  registerPluginCapabilityRoutes(app, { capabilities: pluginCapabilities, plugins, invalidate: invalidatePluginSessions });
  const pluginSetup = new PluginSetupManager(dataDirectory, piAgentDirectory, pluginCapabilities, plugins, localPlugins, invalidatePluginSessions, async ref => {
    const runtime = await getModelRuntime();
    const model = await availableModel(ref.provider, ref.id);
    if (!model) throw new Error("Select an available model in Providers & Models");
    return { runtime, model };
  });
  registerPluginSetupRoutes(app, pluginSetup);
  registerPluginIconRoutes(app, [bundledPlugins, localPlugins]);
  registerPluginPortabilityRoutes(app, { local: localPlugins, plugins, capabilities: pluginCapabilities, settings: pluginSettings, invalidate: invalidatePluginSessions });

  app.addContentTypeParser("image/webp", { parseAs: "buffer", bodyLimit: MAX_PROJECT_COVER_BYTES }, (_request, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAX_LIBRARY_UPLOAD_BYTES }, (_request, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser("application/vnd.ohmygame.attachment", { bodyLimit: MAX_AGENT_ATTACHMENT_BYTES }, (_request, payload, done) => {
    done(null, payload);
  });
  // Project archives stream to disk; importProjectArchive also counts the bytes of uploads without a length.
  app.addContentTypeParser(PROJECT_ARCHIVE_CONTENT_TYPE, { bodyLimit: PROJECT_ARCHIVE_MAX_BYTES }, (_request, payload, done) => {
    done(null, payload);
  });

  // Damaged or newer image settings fall back to the default connection instead of blocking startup.
  const loadOpenAIImages = () => openAIImages.load().catch((err) => app.log.warn({ err }, "Could not load OpenAI image settings"));
  app.addHook("onReady", async () => {
    await networkSettings.load();
    // Runs before any model lookup so saved Azure sign-ins resolve under Pi's current provider ID.
    await migrateAzureProviderId(piAgentDirectory, dataDirectory).catch((err) => app.log.warn({ err }, "Could not migrate Azure provider settings"));
    // A damaged welcome preference must not prevent projects from opening.
    await onboarding.load().catch((err) => app.log.warn({ err }, "Could not load onboarding state"));
    await Promise.all([library.load(), projects.load((projectDirectory, cause) => {
      app.log.warn({ err: cause, projectDirectory }, "Could not load project; skipped during startup");
    }), tools.load(), pluginSettings.load(), pluginCapabilities.configuration.load(), bundledPlugins.load(), preinstalledPlugins.load(), webSearchSettings.load(), openAIEndpoint.load(), loadOpenAIImages(), meshySettings.load(), tripoSettings.load(), hyper3dSettings.load(), seedanceSettings.load(), minimaxSettings.load(), volcengineTtsSettings.load(), volcengineSeedAudioSettings.load(), providerModelSettings.load(), externalMcp.load(), externalClients.load(), agentRuntimes.load().catch((err) => app.log.warn({ err }, "Could not load coding agent settings"))]);
    await Promise.all(projects.list().map(async (project) => { projectWrites.initialize(project.id, await readWorkspaceVersion(project)); }));
    for (const error of await preinstalledPlugins.seed(localPlugins)) app.log.warn(error);
    // Updates the Skill and launcher path in connected clients without holding up startup.
    void externalClients.refresh();
    const examplesWarning = await examples.load();
    if (examplesWarning) app.log.warn(examplesWarning);
    await localPlugins.list();
    await pluginCapabilities.migrate(legacyMcp);
  });

  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-headers", "authorization, content-type, last-event-id, x-workspace-version, x-publish-access-token");
      reply.header("access-control-expose-headers", "x-workspace-version");
      reply.header("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      reply.header("vary", "Origin");
    }
    if (request.method === "OPTIONS") return reply.code(204).send();
    if (!options.accessToken) return;
    // A coding agent's tool calls carry their session's own token, never the app's; the route checks it.
    if (request.url === AGENT_RUNTIME_BRIDGE_PATH) return;
    // External agents carry the token published in endpoint.json; the route checks it.
    if (request.url === EXTERNAL_MCP_PATH) return;
    if (!matchesBearerToken(request.headers.authorization, options.accessToken)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  app.get("/health", async () => ({ status: "ok" }));

  registerCheckpointRoutes(app, {
    store: checkpoints,
    snapshot: snapshotWorkspace, writes: projectWrites, projects, conversations, agents, previews, events,
    busy: (id) => publishing.has(id) || canvasStore.isProjectBusy(id) || tools.jobs().some((job) => job.context?.projectId === id && job.status === "running"),
  });
  registerStoryWebRoutes(app, {
    projects, agents, writes: projectWrites, checkpoints, snapshot: snapshotWorkspace, library, events,
    busy: (id) => publishing.has(id) || canvasStore.isProjectBusy(id) || tools.jobs().some((job) => job.context?.projectId === id && job.status === "running"),
  });

  const networkSettingsSchema = {
    body: {
      type: "object", additionalProperties: false, required: ["mode", "proxyUrl", "noProxy"],
      properties: {
        mode: { type: "string", enum: ["auto", "manual", "direct"] },
        proxyUrl: { type: "string", maxLength: 2_000 },
        noProxy: { type: "string", maxLength: 4_000 },
      },
    },
  };
  app.get("/settings/network", async () => networkSettings.get());
  app.put<{ Body: NetworkSettings }>("/settings/network", { schema: networkSettingsSchema }, async (request, reply) => {
    try { return await networkSettings.update(request.body); }
    catch (cause) { return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
  });
  app.post("/settings/network/detect", async (_request, reply) => {
    try { return await networkSettings.detect(); }
    catch { return reply.code(502).send({ error: "Could not detect the system proxy. Check your system network settings." }); }
  });
  app.post<{ Body: NetworkSettings }>("/settings/network/test", { schema: networkSettingsSchema }, async (request, reply) => {
    try { return await networkSettings.test(request.body); }
    catch (cause) { return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
  });

  app.get("/settings/web-search", async () => webSearchSettings.get());

  app.get("/settings/external-agents", externalAgentSettings);
  app.put<{ Body: UpdateExternalAgentSettings }>("/settings/external-agents", { schema: externalAgentSettingsSchema }, async (request) => {
    await externalMcp.setEnabled(request.body.enabled);
    return externalAgentSettings();
  });
  app.put<{ Params: { client: string } }>("/settings/external-agents/clients/:client", async (request, reply) => {
    if (!isExternalAgentClientId(request.params.client)) return reply.code(404).send({ error: "Unknown agent" });
    try { await externalClients.connect(request.params.client); }
    catch (cause) { return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
    return externalAgentSettings();
  });
  app.delete<{ Params: { client: string } }>("/settings/external-agents/clients/:client", async (request, reply) => {
    if (!isExternalAgentClientId(request.params.client)) return reply.code(404).send({ error: "Unknown agent" });
    try { await externalClients.disconnect(request.params.client); }
    catch (cause) { return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
    return externalAgentSettings();
  });

  app.put<{ Body: UpdateWebSearchSettings }>("/settings/web-search", { schema: webSearchSettingsSchema }, async (request, reply) => {
    try {
      const settings = await webSearchSettings.update(request.body);
      invalidatePluginSessions();
      return settings;
    } catch (cause) {
      return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
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

  app.get("/plugins", async () => {
    const catalog = await plugins.list();
    return catalog;
  });

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
    const plugin = await withPluginCapabilities(await plugins.read(request.params.pluginId));
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
      if (!request.body.enabled) await pluginIntegrations.forget(plugin.id);
      invalidatePluginSessions();
      return withPluginCapabilities(await plugins.read(plugin.id));
    } catch (cause) {
      if (cause instanceof InvalidPluginSettingsError) return reply.code(400).send({ error: cause.message });
      throw cause;
    }
  });

  app.delete<{ Params: { pluginId: string } }>("/plugins/:pluginId", async (request, reply) => {
    const plugin = await localPlugins.read(request.params.pluginId);
    if (!plugin) return reply.code(404).send({ error: "Installed plugin not found" });
    try {
      await pluginIntegrations.forget(plugin.id);
      await preinstalledPlugins.markRemoved(plugin);
      await localPlugins.remove(request.params.pluginId);
      await rm(pluginCapabilities.dataPath(plugin.id), { recursive: true, force: true });
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
        if (request.body.pluginId) return reply.code(400).send({ error: "Examples define their own project integration" });
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
      // A registered workspace is reopened unchanged; connecting it to a plugin is
      // an explicit step in its connection panel.
      const existing = request.body?.workspacePath ? await projects.findByWorkspace(request.body.workspacePath) : undefined;
      if (existing) return reply.code(200).send(existing);
      let plugin = request.body?.pluginId ? await requireIntegrationPlugin(plugins, request.body.pluginId) : undefined;
      if (!plugin && request.body?.workspacePath) {
        const matches = [];
        for (const summary of (await plugins.list()).plugins) {
          if (summary.enabled && await matchesPluginProject(summary, request.body.workspacePath)) matches.push(summary);
        }
        if (matches.length > 1) throw new LocalPluginError("Several plugins recognize this workspace. Select one explicitly.", 409);
        if (matches[0]) plugin = await requireIntegrationPlugin(plugins, matches[0].id);
      }
      const type = plugin && !request.body?.pluginId ? pluginProjectType(request.body?.type ?? "web-game", [plugin]) : request.body?.type ?? plugin?.projectTypes?.[0] ?? "web-game";
      if (!type) throw new LocalPluginError("Select a compatible project type", 400);
      if (plugin?.projectTypes?.length && !plugin.projectTypes.includes(type)) throw new LocalPluginError("Plugin does not support the selected project type", 400);
      const integration = plugin ? { pluginId: plugin.id, preview: plugin.integration!.preview } : undefined;
      const project = await projects.create(request.body?.name, type, request.body?.workspacePath, integration);
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
      if (cause instanceof ExampleError || cause instanceof LocalPluginError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
  });

  app.get("/projects", async () => projects.list());

  const projectActivity = () => ({
    activity: agents.projectActivity(),
    names: projects.list().map(({ id, name, nameSource }) => ({ id, name, nameSource })),
  });

  app.get("/projects/activity", async () => projectActivity());

  // Event streams stay open until the client leaves, so app.close() would wait on them. Closing ends each stream
  // and releases its subscription and heartbeat before the server stops.
  const eventStreams = new Set<() => void>();
  const openEventStream = (request: FastifyRequest, reply: FastifyReply) => {
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value);
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    reply.raw.write(": connected\n\n");
    /** Keeps the stream alive until either side closes it, then calls release. */
    return (release: () => void) => {
      const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
      const close = () => {
        if (!eventStreams.delete(close)) return;
        clearInterval(heartbeat);
        release();
        reply.raw.end();
      };
      eventStreams.add(close);
      request.raw.once("close", close);
    };
  };
  app.addHook("preClose", async () => { for (const close of [...eventStreams]) close(); });

  // Project lists follow activity here instead of polling for it. The snapshot is sent when it changes: runtime events
  // prompt a check, and a short in-memory check also catches changes that publish no event, such as a cancel starting.
  app.get("/projects/activity/events", async (request, reply) => {
    const keepOpen = openEventStream(request, reply);
    let sent = "";
    let scheduled: NodeJS.Timeout | undefined;
    const send = () => {
      scheduled = undefined;
      const snapshot = JSON.stringify(projectActivity());
      if (snapshot === sent) return;
      sent = snapshot;
      reply.raw.write(`event: activity\ndata: ${snapshot}\n\n`);
    };
    send();
    const unsubscribe = events.subscribeAll(() => { scheduled ??= setTimeout(send, 50); });
    const check = setInterval(send, 1_000);
    keepOpen(() => {
      unsubscribe();
      clearTimeout(scheduled);
      clearInterval(check);
    });
  });

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
      if (!definition) return { available: false };
      // A web story carries its own runtime and plays as a page.
      const web = await isWebStory(project.workspacePath);
      return { available: true, definition, ...(web ? { web: true } : {}) };
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
      return await openNodeCodebaseDetail(project.workspacePath);
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
    if (typeof request.body.revision !== "string") return reply.code(400).send({ error: "Playable codebase updates require the revision they were made from" });
    let revision: string;
    try {
      revision = await writeNodeCodebase(project.workspacePath, request.body);
    } catch (cause) {
      return reply.code(cause instanceof NodeCodebaseConflictError ? 409 : 400).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
    try {
      await projects.touch(project.id);
    } catch {
      return reply.code(500).send({ error: "Playable codebase was saved, but project metadata could not be updated" });
    }
    return { revision };
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
      return reply.code(cause instanceof NodeCodebaseConflictError ? 409 : 400).send({ error: cause instanceof Error ? cause.message : String(cause) });
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
          referenceSource: {
            type: "object", additionalProperties: false, required: ["boardId", "nodeId"],
            properties: {
              boardId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,100}$" },
              nodeId: { type: "string", minLength: 1, maxLength: 120 },
            },
          },
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
      const references = request.body.referenceSource ? await resolveCanvasTextReferences(project.workspacePath, request.body.referenceSource, request.params.documentId) : [];
      if (document) {
        const result = await generateDesignDocumentMarkdown(runtime, model, document.document, request.body.instruction, reasoningLevel, references);
        return { ...result, model: selected, revision: document.revision };
      }
      if (table) {
        const result = await generateDesignTable(runtime, model, table.table, request.body.instruction, reasoningLevel);
        return { ...result, model: selected, revision: table.revision };
      }
      const text = await generateCreativeText(runtime, model, request.body.instruction, reasoningLevel, references);
      if (!text) return reply.code(502).send({ error: "The language model returned no text" });
      return { text, model: selected };
    } catch (cause) {
      return reply.code(cause instanceof CanvasError ? cause.statusCode : 502).send({ error: cause instanceof Error ? cause.message : String(cause) });
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

  const syncRunSettings = async (before: ProjectState, project: ProjectState) => {
    if (webPreviewSettingsChanged(before, project)) {
      const running = before.preview.status === "ready" || before.preview.status === "starting";
      await previews.stop(project, "settings");
      await projects.refreshPreviewReadiness(project.id);
      // Preview capability and run settings affect both agent tools and its prompt.
      agents.invalidateProjectSessions(project.id);
      if (running && supportsWebPreview(project) && project.preview.status !== "waiting") void previews.start(project, false, false).catch(() => {});
    }
    void previews.automatic(project).catch(() => {});
    events.publish(project.id, "project.updated", { project: structuredClone(project) });
    return project;
  };

  app.put<{ Params: { projectId: string }; Body: { startupDirectory: string } }>(
    "/projects/:projectId/settings/startup-directory",
    { schema: startupDirectorySchema },
    async (request, reply) => {
      const existing = projects.get(request.params.projectId);
      if (!existing) return reply.code(404).send({ error: "Project not found" });
      const before = { ...existing };
      try {
        const project = await projects.setStartupDirectory(request.params.projectId, request.body.startupDirectory);
        return await syncRunSettings(before, project);
      } catch (cause) {
        const statusCode = (cause as Error).message.startsWith("Project not found") ? 404 : 400;
        return reply.code(statusCode).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  );

  app.put<{
    Params: { projectId: string };
    Body: ProjectRunSettings;
  }>(
    "/projects/:projectId/settings/run",
    { schema: runSettingsSchema },
    async (request, reply) => {
      const existing = projects.get(request.params.projectId);
      if (!existing) return reply.code(404).send({ error: "Project not found" });
      const before = { ...existing };
      try {
        const project = await projects.setRunSettings(request.params.projectId, request.body);
        return await syncRunSettings(before, project);
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

  app.post<{ Querystring: { name?: string }; Body: unknown }>("/projects/import", {
    schema: { querystring: { type: "object", additionalProperties: false, properties: { name: { type: "string", maxLength: 255 } } } },
  }, async (request, reply) => {
    // Other content types arrive parsed, for example as JSON objects, which are not archives.
    const body = request.body;
    const upload = Buffer.isBuffer(body) ? body
      : body && typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function" ? body as AsyncIterable<Buffer | string>
        : undefined;
    if (!upload) return reply.code(400).send({ error: "Choose a project archive to import." });
    try {
      return reply.code(201).send(await importProjectArchive(projects, upload, { name: request.query.name }));
    } catch (cause) {
      if (cause instanceof ProjectArchiveError) return reply.code(cause.statusCode).send({ error: cause.message });
      if (cause instanceof ProjectWorkspaceError) return reply.code(400).send({ error: cause.message });
      throw cause;
    }
  });

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
    // A project reads as idle from the end of a run, a little before its turn is closed; what is asked of it then waits.
    await agents.turnsClosed(project.id);
    if (agents.isProjectBusy(project.id)) return reply.code(409).send({ error: "Wait for the agent to finish before deleting this project" });
    if (project.integration) await pluginIntegrations.forget(project.integration.pluginId, project.id);
    return projectWrites.exclusive(project.id, async () => {
    await previews.forget(project);
    agents.forgetProject(project.id);
    conversations.forget(project);
    for (const [key, driver] of agentPlaytests) {
      if (!key.startsWith(`${project.id}:`)) continue;
      await driver.cleanup();
      agentPlaytests.delete(key);
    }
    await conversationImages.removeProject(project.id);
    await canvasStore.cancelProject(project.id);
    await canvasStore.waitForProject(project.id);
    // A snapshot that is still being taken writes into the folder that is about to be removed.
    await checkpoints.settled(project);
    await projects.delete(project.id);
    return reply.code(204).send();
    });
  });

  registerCommunityRoutes(app, publisher, projects);

  registerLibraryRoutes(app, { projects, library });

  app.get<{ Params: { projectId: string } }>("/projects/:projectId", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    return project ?? reply.code(404).send({ error: "Project not found" });
  });

  /** The project's own cover; an Interactive Story without one shows a Scene's thumbnail. */
  const projectCover = async (projectId: string): Promise<Buffer | undefined> => {
    const cover = await projects.cover(projectId);
    const project = projects.get(projectId);
    if (cover || project?.type !== "interactive-story") return cover;
    if ((await projects.coverState(projectId)).mode === "custom") return undefined;
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

  app.put<{ Params: { projectId: string }; Body: { mode?: string } }>("/projects/:projectId/cover/state", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    const mode = request.body?.mode;
    if (mode !== "auto" && mode !== "custom") return reply.code(400).send({ error: "Invalid cover mode" });
    const fallback = mode === "custom" && project.type === "interactive-story"
      ? await readPlayableCover(project.workspacePath) : undefined;
    await projects.setCoverMode(project.id, mode, fallback);
    return reply.code(204).send();
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
    await projects.setCoverMode(request.params.projectId, "auto");
    return reply.code(204).send();
  });

  app.get<{ Params: { projectId: string } }>("/projects/:projectId/git/changes", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    return listWorkspaceGitChanges(project.workspacePath);
  });

  app.get<{ Params: { projectId: string }; Querystring: { path: string } }>(
    "/projects/:projectId/git/file",
    { schema: { querystring: assetPathQuerySchema } },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      try { return await readWorkspaceGitFile(project.workspacePath, request.query.path); }
      catch (cause) {
        if (cause instanceof WorkspaceError) return reply.code(cause.code === "ENOENT" ? 404 : 400).send({ error: cause.message });
        throw cause;
      }
    },
  );

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

  app.get<{ Querystring: { runtimes?: string; profiles?: string } }>("/models", async (request, reply) => {
    let profiles: unknown = {};
    try { profiles = request.query.profiles ? JSON.parse(request.query.profiles) : {}; } catch { return reply.code(400).send({ error: "Invalid account profile selections" }); }
    if (!isAccountProfileIds(profiles)) return reply.code(400).send({ error: "Invalid account profile selections" });
    for (const runtime of ACCOUNT_RUNTIME_IDS) if (profiles[runtime]) profiles[runtime] = agentRuntimes.settings.resolveProfileId(runtime, profiles[runtime]);
    const runtime = await getModelRuntime();
    const loadingProviders = catalogRefresh.schedule(runtime);
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
    // Conversations also list coding agents' models; canvas text and other one-off generation use Pi's only.
    const agents = request.query.runtimes === "1" ? await agentRuntimes.models(profiles) : { models: [], loading: [] };
    const nativeDefaults = request.query.runtimes === "1" ? agentRuntimes.settings.defaultModel() : undefined;
    const nativeDefault = nativeDefaults ? findAgentModel(agents.models, nativeDefaults.model) : undefined;
    return {
      models: [...models.map(summary), ...agents.models],
      ...(loadingProviders.length ? { loadingProviders } : {}),
      ...(agents.loading.length ? { loadingRuntimes: agents.loading } : {}),
      ...(hidden.length ? { hiddenModels: hidden.map(summary) } : {}),
      ...(nativeDefault ? { defaultModel: { provider: nativeDefault.provider, id: nativeDefault.id }, ...(nativeDefaults?.nativeReasoningLevel ? { defaultNativeReasoningLevel: nativeDefaults.nativeReasoningLevel } : {}) } : defaultModel ? { defaultModel: { provider: defaultModel.provider, id: defaultModel.id } } : {}),
      defaultReasoningLevel: defaultReasoningLevel(dataDirectory, piAgentDirectory),
    };
  });

  app.put<{ Body: UpdateAgentDefaultsRequest }>("/models/default", { schema: agentDefaultsSchema }, async (request, reply) => {
    if (isAgentRuntimeId(request.body.model.provider)) {
      if (request.body.reasoningLevel !== undefined) return reply.code(400).send({ error: "Use nativeReasoningLevel for a coding agent's model" });
      const native = await agentRuntimes.model(request.body.model.provider, request.body.model.id);
      if (!native) return reply.code(400).send({ error: "Model is not available" });
      const level = request.body.nativeReasoningLevel;
      if (level && !native.nativeReasoningLevels?.includes(level)) return reply.code(400).send({ error: "Reasoning level is not available for this model" });
      await agentRuntimes.settings.setDefaultModel({ model: { provider: request.body.model.provider, id: native.id }, ...(level ? { nativeReasoningLevel: level } : {}) });
      return reply.code(204).send();
    }
    if (request.body.nativeReasoningLevel !== undefined) return reply.code(400).send({ error: "Native reasoning is only available for coding agents" });
    if (request.body.reasoningLevel === undefined) return reply.code(400).send({ error: "Invalid agent defaults" });
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
    await agentRuntimes.settings.setDefaultModel(undefined);
    return reply.code(204).send();
  });

  const providerSummaries = async () => {
    const [piProviders, customProviders] = await Promise.all([
      modelAuth.providers(),
      providerModelSettings.customProviderCatalog(),
    ]);
    const customModels = new Map(customProviders.map((provider) => [provider.id, provider]));
    const customImageProviders = new Set(customProviders
      .filter((provider) => CUSTOM_IMAGE_MODEL_APIS.some((api) => api === provider.api)).map((provider) => provider.id));
    const image = openAIImages.get();
    const providers = piProviders
      .map((provider) => {
        const custom = customModels.get(provider.id);
        const imageConfigured = provider.id === "openai" && (image.mode === "separate" ? image.configured : image.mode === "connection" && provider.configured && provider.credentialType !== "oauth");
        const configured = provider.configured || imageConfigured;
        return {
          ...provider,
          configured,
          ...(provider.id === "openai" ? { languageConfigured: provider.configured, imageConfigured } : {}),
          enabled: providerEnabled(provider.id),
          custom: providerModelSettings.isCustom(provider.id),
          ...(custom?.preset ? { preset: custom.preset } : {}),
          status: configured ? "connected" as const : "not_configured" as const,
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
    }), ...MINIMAX_PROVIDER_IDS.map((providerId) => {
      const definition = MINIMAX_PROVIDERS[providerId];
      const configured = minimaxSettings.get(providerId).configured;
      return {
        id: definition.id,
        name: definition.name,
        configured,
        enabled: providerEnabled(providerId),
        custom: false,
        status: configured ? "connected" as const : "not_configured" as const,
        methods: [{ type: "api_key" as const, label: `${definition.name} API key` }],
        credentialType: "api_key" as const,
        capabilities: ["video"] as const,
      };
    }), {
      id: "volcengine-tts",
      name: DOUBAO_SPEECH_PROVIDER_NAME,
      configured: volcengineTtsSettings.get().configured,
      enabled: providerEnabled("volcengine-tts"),
      custom: false,
      status: volcengineTtsSettings.get().configured ? "connected" as const : "not_configured" as const,
      methods: [{ type: "api_key" as const, label: `${DOUBAO_SPEECH_PROVIDER_NAME} API key` }],
      credentialType: "api_key" as const,
      capabilities: ["audio"] as const,
    }, {
      id: "volcengine-seed-audio",
      name: DOUBAO_SEED_AUDIO_PROVIDER_NAME,
      configured: volcengineSeedAudioSettings.get().configured,
      enabled: providerEnabled("volcengine-seed-audio"),
      custom: false,
      status: volcengineSeedAudioSettings.get().configured ? "connected" as const : "not_configured" as const,
      methods: [{ type: "api_key" as const, label: `${DOUBAO_SEED_AUDIO_PROVIDER_NAME} API key` }],
      credentialType: "api_key" as const,
      capabilities: ["audio"] as const,
    }];
    // Cloud quota/catalog verification can take tens of seconds. Refresh it in
    // the background and serve the last known snapshot so opening Settings does
    // not wait on the cloud service.
    void cloudModels.refresh();
    const codex = codexImages.summarySnapshot(providerEnabled("codex-cli"));
    return [...providers, ...directProviders, codex, ...cloudModels.providersSnapshot(providerEnabled)].sort((left, right) => left.name.localeCompare(right.name));
  };
  app.get("/settings/providers", providerSummaries);
  registerDiagnosticsRoutes(app, {
    logDirectory: options.logDirectory,
    summary: async () => {
      const [providers, agents, installed, projectTypes] = await Promise.all([
        diagnosticSection(async () => (await providerSummaries()).filter((provider) => provider.configured)
          .map(({ id, enabled, custom, capabilities }) => ({ id, enabled: enabled !== false, custom: custom === true, capabilities }))),
        diagnosticSection(async () => (await agentRuntimes.statuses())
          .map(({ id, enabled, installed, version, auth }) => ({ id, enabled, installed, ...(version ? { version } : {}), auth: auth.status }))),
        diagnosticSection(async () => (await plugins.list()).plugins.filter((plugin) => plugin.installed)
          .map(({ id, version, enabled, beta }) => ({ id, ...(version ? { version } : {}), enabled, ...(beta ? { beta } : {}) }))),
        diagnosticSection(() => {
          const counts: Record<string, number> = {};
          for (const project of projects.list()) counts[project.type] = (counts[project.type] ?? 0) + 1;
          return counts;
        }),
      ]);
      return { providers, agents, plugins: installed, projects: projectTypes };
    },
  });
  app.post("/settings/models/providers/codex-cli/images/recheck", async () => codexImages.recheck(providerEnabled("codex-cli")));
  registerOpenAIImageRoutes(app, openAIImages, imageConnection, options.modelDiscoveryFetch);
  app.get("/settings/onboarding", async () => {
    if (!onboarding.initialized) {
      const existingSetup = projects.list().length > 0 || (await providerSummaries())
        .some((provider) => ("languageConfigured" in provider ? provider.languageConfigured ?? provider.configured : provider.configured) && provider.capabilities.some((capability) => capability === "language"));
      // Installations from before onboarding have no flag. Preserve their normal startup.
      await onboarding.initialize(existingSetup
        ? { status: "completed", step: "connect" }
        : { status: "pending", step: "welcome" });
    }
    return onboarding.get();
  });
  app.put<{ Body: UpdateOnboardingRequest }>("/settings/onboarding", {
    schema: { body: {
      type: "object", additionalProperties: false, required: ["status", "step"],
      properties: { status: { enum: ["pending", "completed", "skipped"] }, step: { enum: ["welcome", "connect", "media"] } },
    } },
  }, async (request, reply) => {
    if (request.body.status === "completed") {
      const runtime = await getModelRuntime();
      const available = resolveModels(runtime, (await runtime.getAvailable()).filter((model) => providerEnabled(model.provider)))
        .filter((model) => providerModelSettings.isVisible(model));
      if (!available.length && !(await agentRuntimes.models()).models.length)
        return reply.code(409).send({ error: "Connect a language model before completing setup." });
    }
    return onboarding.update(request.body);
  });
  app.put<{ Body: { accessToken: string; userId: string } | null }>("/cloud/session", {
    schema: { body: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, required: ["accessToken", "userId"], properties: {
      accessToken: { type: "string", minLength: 1, maxLength: 16_384 }, userId: { type: "string", minLength: 1, maxLength: 128 },
    } }] } },
  }, async (request, reply) => {
    // Update identity immediately; cloud verification runs when catalogs are requested.
    void cloudModels.setSession(options.localDebug ? null : request.body);
    return reply.code(204).send();
  });
  app.get("/cloud/quotas", async () => cloudModels.quotas());
  app.get("/cloud/jobs", async (_request, reply) => {
    try { return await cloudModels.jobs(); }
    catch (cause) { if (cause instanceof Model3DGenerationError) return reply.code(cause.statusCode).send({ error: cause.message }); throw cause; }
  });
  app.get<{ Params: { id: string } }>("/cloud/jobs/:id/result", async (request, reply) => {
    try { return reply.type("model/gltf-binary").send(await cloudModels.result(request.params.id)); }
    catch (cause) { if (cause instanceof Model3DGenerationError) return reply.code(cause.statusCode).send({ error: cause.message }); throw cause; }
  });

  registerProviderSettingsRoutes(app, {
    providerSummaries,
    providerModelSettings,
    catalogRefresh,
    getModelRuntime,
    projects,
    agents,
    modelDiscoveryFetch: options.modelDiscoveryFetch,
    native3DProviders,
    openAIEndpoint,
    seedanceSettings,
    minimaxSettings,
    volcengineTtsSettings,
    volcengineSeedAudioSettings,
    syncOpenAIEndpoint,
    openAIImages,
    volcengineTtsProvider,
    cloudModels,
    modelAuth,
  });

  app.get("/image-models", async () => providerImages.models());
  app.get("/video-models", async () => providerVideos.models());
  app.get("/audio-models/catalog", async () => providerAudio.catalog());
  for (const [path, usage, generator] of [
    ["image-models", "image", providerImages], ["video-models", "video", providerVideos], ["model3d-models", "3d", providerModels3D],
  ] as const) {
    app.get(`/${path}/catalog`, async () => generator.catalog());
    app.put<{ Body: AgentModelRef }>(`/${path}/default`, { schema: { body: modelRefSchema } }, async (request, reply) => {
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
  app.get("/model3d-operations", async () => providerModels3D.operationModels());
  app.get<{ Querystring: { provider?: string; id?: string; rigModel?: string; rigType?: string } }>("/model3d-animations", async (request, reply) => {
    const { provider, id, rigModel, rigType } = request.query;
    if ((provider && !id) || (!provider && id)) return reply.code(400).send({ error: "Specify provider and model ID together" });
    try {
      return await tools.animationActions(provider && id ? { provider, id } : undefined, {
        ...(rigModel ? { rigModel: rigModel as import("../shared/contracts.js").Model3DOptions["rigModel"] } : {}),
        ...(rigType ? { rigType: rigType as import("../shared/contracts.js").Model3DOptions["rigType"] } : {}),
      });
    } catch (cause) {
      if (cause instanceof ToolRunError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
  });
  app.get<{ Querystring: { provider: string; id: string } }>("/model3d-balance", { schema: { querystring: modelRefSchema } }, async (request, reply) => {
    try { return await providerModels3D.balance(request.query); }
    catch (cause) { if (cause instanceof Error && "statusCode" in cause) return reply.code(Number(cause.statusCode)).send({ error: cause.message }); throw cause; }
  });

  app.post<{ Params: { projectId: string }; Body: CreateConversationRequest }>(
    "/projects/:projectId/conversations",
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      // A new conversation may be created with no body at all, which a body schema would refuse.
      if (!isCreateConversationRequest(request.body)) {
        return reply.code(400).send({ error: "Invalid conversation request" });
      }
      const defaults = agentRuntimes.settings.defaultModel();
      const defaultModel = !request.body?.model && defaults ? await agentRuntimes.model(defaults.model.provider, defaults.model.id) : undefined;
      const requestedModel = request.body?.model ?? (defaultModel ? defaults?.model : undefined);
      if (requestedModel && isAgentRuntimeId(requestedModel.provider)) {
        const agentModel = await agentRuntimes.model(requestedModel.provider, requestedModel.id);
        if (!agentModel) return reply.code(400).send({ error: "Model is not available" });
        if (request.body?.reasoningLevel !== undefined) return reply.code(400).send({ error: "Use nativeReasoningLevel for a coding agent's model" });
        const matchingDefaults = defaults?.model.provider === agentModel.provider && defaults.model.id === agentModel.id;
        const nativeLevel = request.body?.nativeReasoningLevel ?? (matchingDefaults ? defaults?.nativeReasoningLevel : undefined);
        if (nativeLevel && !agentModel.nativeReasoningLevels?.includes(nativeLevel)) {
          return reply.code(400).send({ error: "Reasoning level is not available for this model" });
        }
        const conversation = await conversations.create(project, { provider: agentModel.provider, id: agentModel.id });
        if (isAccountRuntimeId(agentModel.provider)) conversations.setAccountProfile(project, conversation, agentModel.provider, agentRuntimes.settings.get(agentModel.provider).defaultProfileId ?? "system");
        if (nativeLevel) conversations.setNativeReasoningLevel(project, conversation, agentModel, nativeLevel);
        return reply.code(201).send(conversation.summary);
      }
      if (request.body?.nativeReasoningLevel !== undefined) return reply.code(400).send({ error: "Native reasoning is only available for coding agents" });
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

  app.post<{ Params: { projectId: string; conversationId: string }; Body: { entryId: string } }>(
    "/projects/:projectId/conversations/:conversationId/branch",
    { schema: { body: { type: "object", additionalProperties: false, required: ["entryId"], properties: { entryId: { type: "string", minLength: 1, maxLength: 128 } } } } },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const conversation = await conversations.get(project, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      try {
        const branched = await conversations.branch(project, conversation, request.body.entryId);
        return reply.code(201).send(branched.summary);
      } catch (cause) {
        return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
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
      const agentRuntime = modelRef && isAgentRuntimeId(modelRef.provider) ? modelRef.provider : undefined;
      const accountProfiles = await conversations.accountProfiles(project, conversation);
      const runtime = modelRef && !agentRuntime ? await getModelRuntime() : undefined;
      const model = runtime && modelRef ? resolveModel(runtime, runtime.getModel(modelRef.provider, modelRef.id)) : undefined;
      // A coding agent's models load from its CLI; a slow one leaves the level to the picker rather than delay the conversation.
      const agentModel = agentRuntime && modelRef ? await Promise.race([agentRuntimes.model(agentRuntime, modelRef.id, isAccountRuntimeId(agentRuntime) ? accountProfiles[agentRuntime] ?? "system" : undefined), new Promise<undefined>((resolve) => setTimeout(resolve, 2_000))]) : undefined;
      const storedLevel = model || agentModel ? await conversations.reasoningLevel(project, conversation) : undefined;
      const fallbackLevel = defaultReasoningLevel(project.workspacePath, piAgentDirectory);
      const nativeStoredLevel = agentRuntime && modelRef ? await conversations.nativeReasoningLevel(project, conversation, modelRef) : undefined;
      // Slow discovery must not erase a persisted choice in the initial UI state.
      const nativeLevel = agentModel ? nativeEffort(agentModel, nativeStoredLevel) : nativeStoredLevel;
      const settings = {
        ...(Object.values(accountProfiles).some((id) => id !== "system") ? { accountProfiles } : {}),
        ...(modelRef ? { model: modelRef } : {}),
        ...(model ? { reasoningLevel: effectiveReasoningLevel(model, storedLevel, fallbackLevel) } : {}),
        ...(nativeLevel ? { nativeReasoningLevel: nativeLevel } : {}),
      };
      // Cache reads revalidate after earlier readers settle. Retry only when a
      // run or a delayed turn end changed during this read, so the response's
      // event cursor cannot skip checkpoint metadata missing from its branch.
      let branch: SessionEntry[];
      let run = agents.activeStart(project.id, conversation.summary.id);
      let ends = agents.turnEndsRecorded(project.id, conversation.summary.id);
      for (;;) {
        branch = (await conversations.view(project, conversation)).getBranch();
        const now = agents.activeStart(project.id, conversation.summary.id);
        const endsNow = agents.turnEndsRecorded(project.id, conversation.summary.id);
        if ((!run || run.id === now?.id) && ends === endsNow) break;
        run = now;
        ends = endsNow;
      }
      // Capture live state and its cursor together after all asynchronous reads.
      const currentRun = agents.activeStart(project.id, conversation.summary.id);
      const activeItems = agents.activeItems(project.id, conversation.summary.id);
      const activePlanState = agents.planState(conversation);
      // The end of an earlier turn is kept whatever its time: it is written when a run is over, in the very
      // millisecond in which a message that waited for that starts the next run.
      const before = (entry: SessionEntry) => !currentRun || entry.timestamp < currentRun.timestamp || (entry.type === "custom" && (entry.customType === TURN_END_ENTRY || entry.customType === CHECKPOINT_UNDONE_ENTRY));
      const loadedItems = [
        ...conversationItems(branch.filter(before), !currentRun),
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

  app.put<{ Params: { projectId: string; conversationId: string }; Body: { runtime: string; profileId: string } }>(
    "/projects/:projectId/conversations/:conversationId/account-profile",
    { schema: { body: { type: "object", additionalProperties: false, required: ["runtime", "profileId"], properties: { runtime: { enum: ACCOUNT_RUNTIME_IDS }, profileId: { type: "string", minLength: 1, maxLength: 80 } } } } },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const conversation = await conversations.get(project, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      const { runtime, profileId } = request.body;
      if (!isAccountRuntimeId(runtime) || !agentRuntimes.settings.profiles(runtime).some((profile) => profile.id === profileId)) return reply.code(400).send({ error: "Account configuration not found" });
      // Choosing the current account keeps its native context.
      if (await conversations.accountProfileId(project, conversation, runtime) === profileId) return { runtime, profileId };
      // Another account may not offer the chat's model; move to one it does rather than fail the next message.
      const modelRef = await conversations.model(project, conversation);
      const offered = modelRef?.provider === runtime ? await agentRuntimes.offeredModels(runtime, profileId) : undefined;
      const preferred = agentRuntimes.settings.defaultModel()?.model;
      const model = offered && !offered.some((candidate) => candidate.id === modelRef!.id)
        ? offered.find((candidate) => preferred?.provider === runtime && candidate.id === preferred.id) ?? offered[0]
        : undefined;
      const replacement = model && { model, ref: { provider: runtime, id: model.id } satisfies AgentModelRef };
      try {
        await agents.replaceSession(project.id, conversation.summary.id, () => {
          if (replacement) conversations.setModel(project, conversation, replacement.ref);
          conversations.setAccountProfile(project, conversation, runtime, profileId);
        });
        if (!replacement) return { runtime, profileId };
        if (conversation.summary.messageCount > 0) {
          const itemId = randomUUID();
          events.publish(project.id, "conversation.model.changed", {
            item: { id: itemId, turnId: itemId, type: "modelChange", model: replacement.ref, name: replacement.model.name },
          }, { conversationId: conversation.summary.id, turnId: itemId });
        }
        const effort = nativeEffort(replacement.model, await conversations.nativeReasoningLevel(project, conversation, replacement.ref));
        return { runtime, profileId, model: replacement.ref, ...(effort ? { nativeReasoningLevel: effort } : {}) };
      } catch (cause) {
        return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
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
        plugins: enabledPluginMentions(catalog.plugins, project.type),
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
      const accountProfiles = await conversations.accountProfiles(project, conversation);
      const agentModel = isAgentRuntimeId(request.body.provider) ? await agentRuntimes.model(request.body.provider, request.body.id, isAccountRuntimeId(request.body.provider) ? accountProfiles[request.body.provider] ?? "system" : undefined) : undefined;
      const model = agentModel ? undefined : await availableModel(request.body.provider, request.body.id);
      if (!model && !agentModel) return reply.code(400).send({ error: "Model is not available" });
      try {
        const persist = () => conversations.setModel(project, conversation, request.body);
        // A session runs one agent: moving to or from a coding agent starts the next message in a new session.
        const current = agents.sessionRuntime(project.id, conversation.summary.id);
        if (agentModel || current) await agents.replaceSession(project.id, conversation.summary.id, persist);
        else await agents.setModel(project.id, conversation.summary.id, model!, persist);
        if (conversation.summary.messageCount > 0) {
          const itemId = randomUUID();
          events.publish(project.id, "conversation.model.changed", {
            item: {
              id: itemId,
              turnId: itemId,
              type: "modelChange",
              model: request.body,
              name: agentModel?.name ?? model!.name,
            },
          }, { conversationId: conversation.summary.id, turnId: itemId });
        }
        if (agentModel) {
          const effort = nativeEffort(agentModel, await conversations.nativeReasoningLevel(project, conversation, agentModel));
          return { ...(Object.values(accountProfiles).some((id) => id !== "system") ? { accountProfiles } : {}), model: request.body, ...(effort ? { nativeReasoningLevel: effort } : {}) } satisfies ConversationAgentSettings;
        }
        const levels = supportedReasoningLevels(model!);
        const stored = await conversations.reasoningLevel(project, conversation);
        const fallback = defaultReasoningLevel(project.workspacePath, piAgentDirectory);
        return {
          ...(Object.values(accountProfiles).some((id) => id !== "system") ? { accountProfiles } : {}),
          model: request.body,
          ...(levels.length ? { reasoningLevel: clampReasoningLevel(stored ?? fallback, levels) } : {}),
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
      if (isAgentRuntimeId(modelRef.provider)) {
        const model = await agentRuntimes.model(modelRef.provider, modelRef.id, isAccountRuntimeId(modelRef.provider) ? await conversations.accountProfileId(project, conversation, modelRef.provider) : undefined);
        if (!model?.nativeReasoningLevels?.includes(request.body.level)) return reply.code(400).send({ error: "Reasoning level is not available for this model" });
        try {
          await agents.replaceSession(project.id, conversation.summary.id, () => conversations.setNativeReasoningLevel(project, conversation, model, request.body.level));
          return { level: request.body.level };
        } catch (cause) { return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
      }
      const model = await availableModel(modelRef.provider, modelRef.id);
      const level = parseReasoningLevel(request.body.level);
      if (!model || !level || !supportedReasoningLevels(model).includes(level)) return reply.code(400).send({ error: "Reasoning level is not available for this model" });
      try {
        const active = await agents.setReasoningLevel(project.id, conversation.summary.id, level, () => {
          conversations.setReasoningLevel(project, conversation, level);
        });
        return { level: active ?? level };
      } catch (cause) {
        return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  );

  app.post<{ Params: { projectId: string }; Body: ProjectRunSettings }>("/projects/:projectId/preview/inspect", { schema: runSettingsSchema }, async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    try { validatePreviewSettings(request.body); } catch (cause) { return reply.code(400).send({ error: (cause as Error).message }); }
    return inspectPreviewConfiguration({ ...project, ...request.body, packageManager: request.body.packageManager });
  });
  app.delete<{ Params: { projectId: string } }>("/projects/:projectId/preview", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    await previews.stop(project);
    return { preview: project.preview };
  });
  app.put<{ Params: { projectId: string; leaseId: string }; Body: { automatic?: boolean; paused?: boolean } }>(
    "/projects/:projectId/preview/leases/:leaseId",
    { schema: { params: { type: "object", required: ["projectId", "leaseId"], properties: { projectId: { type: "string" }, leaseId: { type: "string", pattern: "^[a-zA-Z0-9-]{1,100}$" } } }, body: { type: "object", additionalProperties: false, properties: { automatic: { type: "boolean" }, paused: { type: "boolean" } } } } },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      previews.acquire(project, `editor:${request.params.leaseId}`, request.body.automatic, request.body.paused);
      return { preview: project.preview };
    },
  );
  app.delete<{ Params: { projectId: string; leaseId: string } }>("/projects/:projectId/preview/leases/:leaseId", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    previews.release(project, `editor:${request.params.leaseId}`);
    return reply.code(204).send();
  });

  app.post<{ Params: { projectId: string }; Querystring: { reuse?: string; reinstall?: string } }>("/projects/:projectId/preview", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    const reuse = request.query.reuse === "1";
    // A web story plays its own page through the preview.
    if (reuse && !isWebRuntimeProjectType(project.type) && project.type !== "interactive-story") return reply.code(409).send({ error: "Play requires a Web Game or General Game project." });
    try {
      const url = await (reuse ? previews.ensureStarted(project) : previews.start(project, request.query.reinstall === "1"));
      return { url, title: project.name };
    } catch (cause) {
      if (cause instanceof PreviewCancelledError) return reply.code(409).send({ error: cause.message, code: "PREVIEW_CANCELLED" });
      if (cause instanceof ProjectWorkspaceError) return reply.code(409).send({ error: cause.message });
      return reply.code(503).send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
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
      if (selectedModel && !modelProviderEnabled(selectedModel.provider)) return reply.code(409).send({ error: "The selected provider is disabled. Enable it in Settings to continue." });
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
      try {
        const catalog = mentions.length ? await plugins.list() : undefined;
        for (const mention of mentions) {
          const plugin = catalog!.plugins.find(item => item.name === mention.name && item.marketplace.id === mention.marketplaceId);
          if (plugin?.projectTypes?.length && !plugin.projectTypes.includes(project.type)) throw new LocalPluginError("A referenced plugin requires a different project type", 409);
          if (plugin?.integration && project.integration?.pluginId !== plugin.id) throw new LocalPluginError("Connect this plugin to the project before sending a prompt", 409);
        }
        if (project.integration) {
          const plugin = await requireIntegrationPlugin(plugins, project.integration.pluginId, project);
          if (plugin.integration!.projectFiles?.length && !await matchesPluginProject(plugin, project.workspacePath)) throw new LocalPluginError("Connect the project in its plugin setup before sending a prompt", 409);
          let status = pluginIntegrations.state(plugin.id, project.id);
          if (status?.running && ["prepare", "connect", "bind"].includes(status.action)) throw new LocalPluginError("Wait for plugin setup to finish", 409);
          // Recheck an old connection when idle. A failed recheck keeps the last
          // result, so an unreachable service does not block local work.
          if (!status?.result?.connection || (!status.running && Date.now() - (status.connectionCheckedAt ?? 0) > PLUGIN_CONNECTION_MAX_AGE_MS)) {
            await pluginIntegrations.execute(plugin, "status", project).catch(() => {});
            status = pluginIntegrations.state(plugin.id, project.id);
          }
          if (status?.result?.connection?.status !== "ready" || !status.result.project) throw new LocalPluginError("Complete the project's plugin connection before sending a prompt", 409);
        }
      } catch (cause) {
        if (cause instanceof LocalPluginError) return reply.code(cause.statusCode).send({ error: cause.message });
        throw cause;
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
        // Another chat may have finished inference while its final checkpoint is still closing.
        await agents.turnsClosed(project.id);
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
      const namingPrompt = mentions.reduce((prompt, mention) => prompt.replaceAll(pluginMentionToken(mention), " "), request.body.prompt);
      projectNaming.start(project, namingPrompt, selectedModel);
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
      if (selectedModel && !modelProviderEnabled(selectedModel.provider)) return reply.code(409).send({ error: "The selected provider is disabled. Enable it in Settings to continue." });
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
        const provider = (await conversations.model(project, conversation))?.provider;
        const native = isAgentRuntimeId(provider);
        // Displaying native usage must not create a session or probe the selected account.
        const usage = await agents.contextUsage(project, conversation, { loadSession: !native });
        const limits = native ? agentRuntimes.cachedLimits(provider, isAccountRuntimeId(provider) ? await conversations.accountProfileId(project, conversation, provider) : undefined) : undefined;
        return { contextUsage: usage ?? (limits?.length ? { tokens: null, contextWindow: 0, percent: null, limits } : undefined) };
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
      if (selectedModel && !modelProviderEnabled(selectedModel.provider)) return reply.code(409).send({ error: "The selected provider is disabled. Enable it in Settings to continue." });
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

  app.post<{ Params: { projectId: string; conversationId: string; requestId: string }; Body: AnswerApprovalRequest }>(
    "/projects/:projectId/conversations/:conversationId/approvals/:requestId",
    { schema: answerApprovalSchema },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const conversation = await conversations.get(project, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      try {
        agents.answerApproval(project.id, conversation.summary.id, request.params.requestId, request.body.decision);
        return reply.code(204).send();
      } catch (cause) {
        return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  );

  registerAgentRuntimeRoutes(app, { agentRuntimes, projects, agents });

  app.post(AGENT_RUNTIME_BRIDGE_PATH, { bodyLimit: 8 * 1024 * 1024 }, async (request, reply) => {
    const answer = await agentRuntimes.handleBridgeRequest(request.headers.authorization, request.body);
    if (answer.body === undefined) return reply.code(answer.status).send();
    return reply.code(answer.status).type("application/json").send(answer.body);
  });
  // Streamable HTTP clients may open an event stream; this server has nothing to push.
  app.get(AGENT_RUNTIME_BRIDGE_PATH, async (_request, reply) => reply.code(405).header("allow", "POST").send());
  app.delete(AGENT_RUNTIME_BRIDGE_PATH, async (_request, reply) => reply.code(405).header("allow", "POST").send());

  app.post(EXTERNAL_MCP_PATH, { bodyLimit: 8 * 1024 * 1024 }, async (request, reply) => {
    // A client that disconnects stops its quick tools; generation jobs keep running.
    const abort = new AbortController();
    reply.raw.once("close", () => { if (!reply.raw.writableFinished) abort.abort(); });
    const answer = await externalMcp.handle({
      authorization: request.headers.authorization,
      sessionId: firstHeader(request.headers["mcp-session-id"]),
      roots: firstHeader(request.headers[EXTERNAL_MCP_ROOTS_HEADER]),
      body: request.body,
      signal: abort.signal,
    });
    reply.code(answer.status).headers(answer.headers ?? {});
    return answer.body === undefined ? reply.send() : reply.type("application/json").send(answer.body);
  });
  // Nothing is pushed to external agents, so there is no event stream to open.
  app.get(EXTERNAL_MCP_PATH, async (_request, reply) => reply.code(405).header("allow", "POST, DELETE").send());
  app.delete(EXTERNAL_MCP_PATH, async (request, reply) =>
    reply.code(await externalMcp.end(request.headers.authorization, firstHeader(request.headers["mcp-session-id"]))).send());

  app.post<{ Params: { projectId: string; conversationId: string }; Body: ReviseLastPromptRequest }>(
    "/projects/:projectId/conversations/:conversationId/revise-last",
    { schema: reviseLastPromptSchema },
    async (request, reply) => {
      const project = projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const conversation = await conversations.get(project, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      const selectedModel = await conversations.model(project, conversation);
      if (selectedModel && !modelProviderEnabled(selectedModel.provider)) return reply.code(409).send({ error: "The selected provider is disabled. Enable it in Settings to continue." });
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
      if (project.integration) return reply.code(409).send({ error: "This project uses plugin publishing. Follow its plugin's publishing workflow." });
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

  app.post<{ Params: { projectId: string } }>("/projects/:projectId/export", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (agents.isProjectBusy(project.id)) return reply.code(409).send({ error: "Wait for the agent to finish before exporting" });
    try {
      const [cover, coverState] = await Promise.all([projects.cover(project.id), projects.coverState(project.id)]);
      const archive = await exportProjectArchive(project, { library, ...(cover ? { cover: { contents: cover, mode: coverState.mode } } : {}) });
      return reply
        .header("content-type", "application/zip")
        .header("content-disposition", `attachment; filename="${encodeURIComponent(project.name)}.zip"`)
        .send(archive);
    } catch (cause) {
      if (cause instanceof ProjectArchiveError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
  });

  app.get<{ Params: { projectId: string }; Querystring: { cursor?: string } }>("/projects/:projectId/events", async (request, reply) => {
    const project = projects.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    const cursor = Number(request.query.cursor ?? request.headers["last-event-id"] ?? 0) || 0;
    if (!events.canReplay(project.id, cursor)) {
      return reply.code(409).send({ error: "Event cursor expired" });
    }
    const keepOpen = openEventStream(request, reply);
    const send = (event: RuntimeEvent) => {
      reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    for (const event of events.since(project.id, cursor)) send(event);
    keepOpen(events.subscribe(project.id, send));
  });

  app.get<{ Params: { operationId: string }; Querystring: { cursor?: string } }>("/settings/model-auth/:operationId/events", async (request, reply) => {
    const cursor = Number(request.query.cursor ?? request.headers["last-event-id"] ?? 0) || 0;
    try {
      const history = modelAuth.eventsSince(request.params.operationId, cursor);
      const keepOpen = openEventStream(request, reply);
      const send = (event: ReturnType<typeof modelAuth.eventsSince>[number]) => {
        reply.raw.write(`id: ${event.id}\nevent: model-auth\ndata: ${JSON.stringify(event)}\n\n`);
        if (event.type === "completed" || event.type === "cancelled" || event.type === "error") reply.raw.end();
      };
      for (const event of history) {
        send(event);
        if (reply.raw.writableEnded) return;
      }
      keepOpen(modelAuth.subscribe(request.params.operationId, send));
    } catch (cause) {
      if (cause instanceof ModelAuthError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
  });

  app.addHook("onListen", async () => {
    const address = app.server.address();
    if (address && typeof address === "object") await externalMcp.listening(`http://127.0.0.1:${address.port}${EXTERNAL_MCP_PATH}`);
  });

  app.addHook("onClose", async () => {
    catalogRefresh.close();
    await pluginIntegrations.close();
    await externalMcp.close();
    codexImages.close();
    await projectNaming.close();
    await pluginCapabilities.host.close();
    await cloudModels.setSession(null);
    await canvasStore.close();
    await tools.close();
    modelAuth.close();
    await agents.close();
    await agentRuntimes.close();
    await Promise.allSettled([...agentPlaytests.values()].map((driver) => driver.cleanup()));
    options.playtestDriver?.close();
    await conversationImages.flush();
    await previews.stopAll();
    await artifacts.close();
    await examples.close();
    await localPublisher?.close();
  });
  return app;
}

function isExternalAgentClientId(value: string): value is ExternalAgentClientId {
  return (EXTERNAL_AGENT_CLIENT_IDS as readonly string[]).includes(value);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** A project only offers plugins its prompts accept; the home composer offers all. */
function enabledPluginMentions(plugins: readonly PluginSummary[], projectType?: ProjectType): ConversationCapabilities["plugins"] {
  return plugins
    .filter((plugin) => plugin.enabled && (!projectType || !plugin.projectTypes?.length || plugin.projectTypes.includes(projectType)))
    .map(({ id, name, displayName, description, marketplace, icon, iconRevision, projectTypes, integration }) => ({
      id,
      name,
      displayName,
      description,
      icon, iconRevision,
      projectTypes, integration,
      marketplaceId: marketplace.id,
      marketplaceDisplayName: marketplace.displayName,
    }));
}

function isWebp(value: unknown): value is Buffer {
  return Buffer.isBuffer(value) && sniffImageType(value) === "image/webp";
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
  if (Object.keys(body).some((key) => key !== "model" && key !== "reasoningLevel" && key !== "nativeReasoningLevel")) return false;
  if (body.nativeReasoningLevel !== undefined && (typeof body.nativeReasoningLevel !== "string" || !body.nativeReasoningLevel || body.nativeReasoningLevel.length > 100)) return false;
  if (body.reasoningLevel !== undefined && !AGENT_REASONING_LEVELS.includes(body.reasoningLevel as AgentReasoningLevel)) return false;
  if (body.model === undefined) return true;
  return isAgentModelRef(body.model);
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
