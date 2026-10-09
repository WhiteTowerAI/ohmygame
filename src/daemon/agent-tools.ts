import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { defineTool, type ToolDefinition as PiToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Model3DAnimationAction, type PlanMode, type PlanState, type ProjectState, type QuestionnaireResult, type RunVideoToolRequest, type ToolId } from "../shared/contracts.js";
import { DEFAULT_ANIMATION_ACTION_IDS, DEFAULT_CHARACTER_HEIGHT_METERS, MAX_ANIMATION_ACTIONS } from "../shared/generation-config.js";
import type { PluginDetail } from "../shared/plugins.js";
import type { ProjectManager } from "./projects.js";
import type { ToolRunner } from "./tools.js";
import { getWorkspaceMedia } from "./workspace.js";
import type { GameRuntimeAdapter, GameUseOpenTarget } from "../shared/playtest.js";
import type { WebSearchExecution, WebSearchInput } from "../shared/web-search.js";
import { createGameUseTool } from "./playtest-tools.js";
import { addPlayableNode } from "./playable-add-node.js";
import { validatePlayableProject } from "./playable-project.js";
import { PLAYABLE_PRESET_IDS, PLAYABLE_PRESETS } from "./playable-presets.js";
import { checkCanvasWorkspace } from "./canvas-check.js";
import type { CanvasStore } from "./canvas-workspace.js";
import { readCanvasAssets } from "./canvas-assets.js";

const PI_TOOL_NAMES: Record<ToolId, string> = {
  "generate-image": "generate_image",
  "image-to-3d": "generate_3d_asset",
  "generate-video": "generate_video",
  "animate-3d": "animate_3d_asset",
};
const PI_BUILTIN_TOOL_NAMES = new Set(["read", "write", "edit", "bash", "grep", "find", "ls", "web_search", "update_plan", "questionnaire", "install_plugin", "generate_canvas_media"]);

export function activePiToolNames(enabledTools: readonly ToolId[], registeredToolNames: readonly string[] = [], webSearchEnabled = true): string[] {
  const ohMyGameToolNames = new Set(Object.values(PI_TOOL_NAMES));
  const extensionTools = registeredToolNames.filter((name) => !ohMyGameToolNames.has(name) && !PI_BUILTIN_TOOL_NAMES.has(name));
  return [...new Set([...extensionTools, "read", "write", "edit", "bash", ...(webSearchEnabled ? ["web_search"] : []), "update_plan", "install_plugin", ...enabledTools.map((id) => PI_TOOL_NAMES[id]), ...(enabledTools.length && registeredToolNames.includes("generate_canvas_media") ? ["generate_canvas_media"] : [])])];
}

export function planningPiToolNames(webSearchEnabled = true): string[] {
  return ["read", "grep", "find", "ls", ...(webSearchEnabled ? ["web_search"] : []), "questionnaire", "update_plan"];
}

export function projectPiToolNames(
  mode: PlanMode,
  enabledTools: readonly ToolId[],
  registeredToolNames: readonly string[] = [],
  webSearchEnabled = true,
): string[] {
  return mode === "planning"
    ? [...planningPiToolNames(webSearchEnabled), ...(registeredToolNames.includes("canvas_check") ? ["canvas_check"] : [])]
    : activePiToolNames(enabledTools, registeredToolNames, webSearchEnabled);
}

export type AskQuestionnaire = (
  toolCallId: string,
  input: {
    questions: Array<{
      id: string;
      prompt: string;
      options: Array<{ value: string; label: string; description?: string; recommended?: boolean }>;
      allowOther?: boolean;
    }>;
  },
  signal?: AbortSignal,
) => Promise<QuestionnaireResult>;

export type InstallPlugin = (sourcePath: string) => Promise<PluginDetail>;
export type SearchWeb = (input: WebSearchInput, signal?: AbortSignal) => Promise<WebSearchExecution>;

const mediaModelParameter = () => Type.Object({
  provider: Type.String({ description: "Model provider ID" }),
  id: Type.String({ description: "Provider model ID" }),
}, { description: "Override the project or global default generation model" });

export function createAgentTools(
  project: ProjectState,
  tools: ToolRunner,
  projects: ProjectManager,
  askQuestionnaire?: AskQuestionnaire,
  installPlugin?: InstallPlugin,
  playtest?: { driver: GameRuntimeAdapter; resolveOpenTarget: () => Promise<GameUseOpenTarget> },
  searchWeb?: SearchWeb,
  canvasStore?: CanvasStore,
): PiToolDefinition[] {
  return [defineTool({
    name: "questionnaire",
    label: "Ask Questions",
    description: "Ask the user up to three high-impact clarifying questions when their answer is necessary to produce a correct plan. Do not ask for information you can discover from the project.",
    parameters: Type.Object({
      questions: Type.Array(Type.Object({
        id: Type.String({ minLength: 1, maxLength: 80, description: "Unique question identifier" }),
        prompt: Type.String({ minLength: 1, maxLength: 500, description: "Question shown to the user" }),
        options: Type.Array(Type.Object({
          value: Type.String({ minLength: 1, maxLength: 200, description: "Value returned for this option" }),
          label: Type.String({ minLength: 1, maxLength: 120, description: "Short option label" }),
          description: Type.Optional(Type.String({ maxLength: 300, description: "Optional explanation" })),
          recommended: Type.Optional(Type.Boolean({ description: "Whether this is the recommended option" })),
        }), { minItems: 2, maxItems: 4 }),
        allowOther: Type.Optional(Type.Boolean({ description: "Allow a custom answer; defaults to true" })),
      }), { minItems: 1, maxItems: 3 }),
    }),
    execute: async (toolCallId, input, signal) => {
      if (!askQuestionnaire) throw new Error("Questionnaire is not available");
      const result = await askQuestionnaire(toolCallId, input, signal);
      if (result.cancelled) {
        return { content: [{ type: "text", text: "The user skipped these questions. Continue with reasonable defaults." }], details: result };
      }
      return {
        content: [{ type: "text", text: result.answers.map((answer) => `${answer.questionId}: ${answer.label}`).join("\n") }],
        details: result,
      };
    },
  }), ...(searchWeb ? [defineTool({
    name: "web_search",
    label: "Search Web",
    description: "Search the public web for current or external information. Use concise queries and cite the returned source URLs in the response.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 1_000, description: "Search query" }),
      numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Number of results; defaults to 8" })),
      livecrawl: Type.Optional(Type.Union([Type.Literal("fallback"), Type.Literal("preferred")], { description: "Whether live crawling is a fallback or preferred" })),
      type: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("fast"), Type.Literal("deep")], { description: "Search depth" })),
      contextMaxCharacters: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 50_000, description: "Maximum returned context characters" })),
    }),
    execute: async (_toolCallId, input, signal) => {
      signal?.throwIfAborted();
      const result = await searchWeb(input, signal);
      return {
        content: [{ type: "text" as const, text: result.content }],
        details: { webSearch: { provider: result.provider, providerName: result.providerName, ...(result.fallbackFrom ? { fallbackFrom: result.fallbackFrom } : {}) } },
      };
    },
  })] : []), defineTool({
    name: "install_plugin",
    label: "Install Plugin",
    description: "Validate and install an OhMyGame plugin directory from the current workspace. Use this after creating or updating a plugin with the plugin-creator skill.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: "Plugin directory relative to the current workspace" }),
    }),
    execute: async (_toolCallId, input, signal) => {
      if (!installPlugin) throw new Error("Plugin installation is not available");
      signal?.throwIfAborted();
      const [workspacePath, sourcePath] = await Promise.all([
        realpath(project.workspacePath),
        realpath(path.resolve(project.workspacePath, input.path)),
      ]);
      const relative = path.relative(workspacePath, sourcePath);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Plugin directory must be inside the current workspace");
      }
      const plugin = await installPlugin(sourcePath);
      const counts = [
        plugin.skills.length ? `${plugin.skills.length} Skill${plugin.skills.length === 1 ? "" : "s"}` : undefined,
        plugin.connections.length ? `${plugin.connections.length} Connection${plugin.connections.length === 1 ? "" : "s"}` : undefined,
      ].filter(Boolean).join(" · ") || "No components";
      return {
        content: [{ type: "text", text: `Created and installed ${plugin.displayName}.\n${counts}\nSource: ${sourcePath}` }],
        details: { plugin: { id: plugin.id, displayName: plugin.displayName, sourcePath } },
      };
    },
  }), defineTool({
    name: "update_plan",
    label: "Update Plan",
    description: "Create or update a concise implementation plan for multi-step work. Use at most one in_progress step.",
    parameters: Type.Object({
      explanation: Type.Optional(Type.String({ maxLength: 2_000, description: "Optional explanation for this plan update" })),
      plan: Type.Array(Type.Object({
        step: Type.String({ minLength: 1, maxLength: 500, description: "Task step" }),
        status: Type.Union([
          Type.Literal("pending"),
          Type.Literal("in_progress"),
          Type.Literal("completed"),
        ]),
      }), { minItems: 1, maxItems: 12, description: "The complete list of plan steps" }),
    }),
    execute: async (_toolCallId, input) => {
      const steps = input.plan.map((item) => ({ step: item.step.trim(), status: item.status }));
      if (steps.some((item) => !item.step)) throw new Error("Plan steps cannot be blank");
      if (steps.filter((item) => item.status === "in_progress").length > 1) {
        throw new Error("A plan can have at most one in_progress step");
      }
      const plan: PlanState = {
        ...(input.explanation?.trim() ? { explanation: input.explanation.trim() } : {}),
        steps,
      };
      const completed = steps.filter((item) => item.status === "completed").length;
      return {
        content: [{ type: "text", text: `Plan updated: ${completed}/${steps.length} steps completed.` }],
        details: { plan },
      };
    },
  }), defineTool({
    name: PI_TOOL_NAMES["generate-image"],
    label: "Generate Image",
    description: "Generate an image and save it into the current project workspace.",
    parameters: Type.Object({
      prompt: Type.String({ description: "A detailed description of the image to generate" }),
      imageModel: Type.Optional(mediaModelParameter()),
      size: Type.Optional(Type.Union([
        Type.Literal("1024x1024"),
        Type.Literal("1536x1024"),
        Type.Literal("1024x1536"),
      ], { description: "Output size" })),
    }),
    execute: async (_toolCallId, input, signal) => {
      signal?.throwIfAborted();
      const run = await tools.run("generate-image", input, signal, project.id);
      try {
        const output = run.files[0];
        if (!output) throw new Error("Image generator returned no output");
        const file = await tools.file(run.id, output.name);
        if (!file) throw new Error("Generated image could not be read");
        signal?.throwIfAborted();
        const extension = output.mediaType === "image/png" ? "png" : output.mediaType === "image/jpeg" ? "jpg" : "webp";
        const fileName = `image-${run.id}.${extension}`;
        const relativePath = await projects.addGeneratedAsset(project.id, fileName, file.bytes, {
          prompt: input.prompt,
          ...(file.assetId ? { libraryAssetId: file.assetId } : {}),
        });
        return {
          content: [{ type: "text", text: `Generated image saved to ${relativePath}` }],
          details: { artifact: { type: "image", path: relativePath, mediaType: output.mediaType } },
        };
      } finally {
        await tools.removeRun(run.id);
      }
    },
  }), defineTool({
    name: PI_TOOL_NAMES["image-to-3d"],
    label: "Generate 3D Asset",
    description: "Turn a PNG or JPEG in the current project into a textured GLB model.",
    parameters: Type.Object({
      imagePath: Type.String({ description: "Path to a PNG or JPEG image in the current project workspace" }),
      model: Type.Optional(mediaModelParameter()),
    }),
    execute: async (_toolCallId, input, signal) => {
      signal?.throwIfAborted();
      const source = await getWorkspaceMedia(project.workspacePath, input.imagePath);
      if (source.contentType !== "image/png" && source.contentType !== "image/jpeg") {
        throw new Error("Image to 3D requires a PNG or JPEG image");
      }
      const run = await tools.run("image-to-3d", {
        ...(input.model ? { model: input.model } : {}),
        images: [{ mediaType: source.contentType, data: (await readFile(source.absolutePath)).toString("base64") }],
      }, signal, project.id);
      try {
        const output = run.files[0];
        if (!output) throw new Error("3D generator returned no output");
        const file = await tools.file(run.id, output.name);
        if (!file) throw new Error("Generated 3D model could not be read");
        signal?.throwIfAborted();
        const sourcePrompt = await projects.generatedAssetPrompt(project.id, input.imagePath);
        const relativePath = await projects.addGeneratedAsset(project.id, `model-${run.id}.glb`, file.bytes, {
          ...(file.assetId ? { libraryAssetId: file.assetId } : {}),
          ...(sourcePrompt ? { prompt: sourcePrompt } : {}),
          ...(file.preview ? {
            preview: {
              bytes: file.preview.bytes,
              extension: file.preview.mediaType === "image/png" ? "png" : "jpg",
            },
          } : {}),
        });
        return {
          content: [{ type: "text", text: `Generated 3D model saved to ${relativePath}` }],
          details: { artifact: { type: "model", path: relativePath, mediaType: output.mediaType } },
        };
      } finally {
        await tools.removeRun(run.id);
      }
    },
  }), defineTool({
    name: PI_TOOL_NAMES["animate-3d"],
    label: "Animate 3D Asset",
    description: "Rig a textured humanoid GLB in the current project and bake preset animations into a new GLB, one named clip per action, ready for a three.js AnimationMixer. Only two-legged humanoid characters facing +Z can be rigged.",
    parameters: Type.Object({
      modelPath: Type.String({ description: "Path to a GLB model in the current project workspace" }),
      actions: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: MAX_ANIMATION_ACTIONS,
        description: "Animation names from the provider library, such as Idle, Casual Walk, Run Fast, Regular Jump, Attack, Hit Reaction, or Dead. Defaults to that set.",
      })),
      heightMeters: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100, description: `Approximate character height in meters; defaults to ${DEFAULT_CHARACTER_HEIGHT_METERS}` })),
    }),
    execute: async (_toolCallId, input, signal) => {
      signal?.throwIfAborted();
      const source = await getWorkspaceMedia(project.workspacePath, input.modelPath);
      if (source.contentType !== "model/gltf-binary") throw new Error("Only GLB models can be animated");
      const library = await tools.animationActions();
      const actions = input.actions
        ? input.actions.map((name) => findAnimationAction(library, name))
        : DEFAULT_ANIMATION_ACTION_IDS.flatMap((id) => library.filter((action) => action.id === id));
      const assetId = await projects.ensureLibraryAsset(project.id, input.modelPath);
      const run = await tools.run("animate-3d", {
        assetId,
        actionIds: [...new Set(actions.map((action) => action.id))],
        ...(input.heightMeters !== undefined ? { heightMeters: input.heightMeters } : {}),
      }, signal);
      try {
        const output = run.files[0];
        if (!output) throw new Error("3D animation returned no output");
        const file = await tools.file(run.id, output.name);
        if (!file) throw new Error("Animated 3D model could not be read");
        signal?.throwIfAborted();
        const relativePath = await projects.addGeneratedAsset(project.id, `model-animated-${run.id}.glb`, file.bytes, {
          ...(file.assetId ? { libraryAssetId: file.assetId } : {}),
        });
        return {
          content: [{ type: "text", text: `Animated 3D model saved to ${relativePath} with clips: ${actions.map((action) => action.name).join(", ")}` }],
          details: { artifact: { type: "model", path: relativePath, mediaType: output.mediaType } },
        };
      } finally {
        await tools.removeRun(run.id);
      }
    },
  }), defineTool({
    name: PI_TOOL_NAMES["generate-video"],
    label: "Generate Video",
    description: "Generate a video from a text prompt, optionally animating a PNG, JPEG, or WebP image from the current project.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Describe the motion and camera movement" }),
      model: Type.Optional(mediaModelParameter()),
      imagePath: Type.Optional(Type.String({ description: "Optional path to a PNG, JPEG, or WebP image in the current project workspace" })),
      duration: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: "Video duration in seconds" })),
      aspectRatio: Type.Optional(Type.Union([Type.Literal("adaptive"), Type.Literal("21:9"), Type.Literal("16:9"), Type.Literal("4:3"), Type.Literal("3:2"), Type.Literal("1:1"), Type.Literal("2:3"), Type.Literal("3:4"), Type.Literal("9:16"), Type.Literal("9:21")], { description: "Video aspect ratio" })),
      resolution: Type.Optional(Type.Union([Type.Literal("480p"), Type.Literal("720p"), Type.Literal("768p"), Type.Literal("1080p"), Type.Literal("1K"), Type.Literal("2K"), Type.Literal("4K")], { description: "Video resolution" })),
    }),
    execute: async (_toolCallId, input, signal) => {
      signal?.throwIfAborted();
      const source = input.imagePath ? await getWorkspaceMedia(project.workspacePath, input.imagePath) : undefined;
      if (source && source.contentType !== "image/png" && source.contentType !== "image/jpeg" && source.contentType !== "image/webp") {
        throw new Error("Video generation requires a PNG, JPEG, or WebP image");
      }
      const assetId = source ? await projects.ensureLibraryAsset(project.id, input.imagePath!) : undefined;
      const request: RunVideoToolRequest = {
        prompt: input.prompt,
        model: input.model,
        duration: input.duration,
        aspectRatio: input.aspectRatio,
        resolution: input.resolution,
        ...(assetId ? { references: [{ type: "image", assetId }] } : {}),
      };
      const run = await tools.run("generate-video", request, signal, project.id);
      try {
        const output = run.files[0];
        if (!output) throw new Error("Video generator returned no output");
        const file = await tools.file(run.id, output.name);
        if (!file) throw new Error("Generated video could not be read");
        signal?.throwIfAborted();
        const relativePath = await projects.addGeneratedAsset(project.id, `video-${run.id}.mp4`, file.bytes, {
          prompt: input.prompt,
          ...(file.assetId ? { libraryAssetId: file.assetId } : {}),
        });
        return {
          content: [{ type: "text", text: `Generated video saved to ${relativePath}` }],
          details: { artifact: { type: "video", path: relativePath, mediaType: output.mediaType } },
        };
      } finally {
        await tools.removeRun(run.id);
      }
    },
  }), ...(project.type === "interactive-story" ? [defineTool({
    name: "playable_add_node",
    label: "Add Node",
    description: [
      "Create a Playable Node from a Preset. Presets are starting points, not Node types: the starter source uses the Project Style and is yours to rewrite.",
      `Presets: ${PLAYABLE_PRESETS.map((preset) => `${preset.id} (${preset.label})`).join(", ")}.`,
      "The Node is added to graph.json with its starter Signals and placed on the canvas. Connect it with an edge afterwards, then edit the written files.",
    ].join("\n"),
    parameters: Type.Object({
      preset: Type.Union(
        PLAYABLE_PRESET_IDS.map((id) => Type.Literal(id)),
        { description: "Preset to start from" },
      ),
      id: Type.String({ minLength: 1, maxLength: 60, description: "Node ID, used as the directory name under nodes/" }),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 120, description: "Node title; defaults to the next Node N" })),
    }),
    execute: async (_toolCallId, input, signal) => {
      signal?.throwIfAborted();
      const result = await addPlayableNode(project.workspacePath, input);
      const signals = result.signals.length ? result.signals.join(", ") : "none";
      return {
        content: [{
          type: "text",
          text: [
            `Added Node "${result.id}" (${result.title}) from the ${result.preset} Preset.`,
            `Files: ${result.files.join(", ")}`,
            `Starter Signals: ${signals}`,
            result.brief,
          ].join("\n"),
        }],
        details: { playableNode: { id: result.id, preset: result.preset, files: result.files, signals: result.signals } },
      };
    },
  }), defineTool({
    name: "playable_check",
    label: "Check Project",
    description: [
      "Validate the Playable Nodes project: graph.json against its schema and references, then compile every Node and the shared modules it imports.",
      "Run it after changing the project and fix every issue it reports. Use mode \"publish\" before the user publishes; it also requires every Signal to be connected and every source file to exist.",
    ].join("\n"),
    parameters: Type.Object({
      mode: Type.Optional(Type.Union([Type.Literal("draft"), Type.Literal("publish")], { description: "Validation strictness; defaults to draft" })),
    }),
    execute: async (_toolCallId, input, signal) => {
      signal?.throwIfAborted();
      const mode = input.mode ?? "draft";
      const result = await validatePlayableProject(project.workspacePath, mode);
      const issues = result.issues.map(({ phase, code, path: issuePath, message, surfaceId }) => ({ phase, code, path: issuePath, message, ...(surfaceId ? { surfaceId } : {}) }));
      const text = result.ok
        ? `The project passes ${mode} validation.`
        : [
          `The project has ${issues.length} ${mode} validation ${issues.length === 1 ? "issue" : "issues"}:`,
          ...issues.map((issue) => `- [${issue.phase}] ${issue.surfaceId ? `${issue.surfaceId} ` : ""}${issue.path}: ${issue.message} (${issue.code})`),
        ].join("\n");
      return { content: [{ type: "text", text }], details: { playableCheck: { mode, ok: result.ok, issues } } };
    },
  })] : []), defineTool({
    name: "canvas_check",
    label: "Check Canvas",
    description: "Validate the canvas workspace files, node/document references and local media paths. Run after editing canvas files and fix every reported issue. This tool only reads files.",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _input, signal) => {
      signal?.throwIfAborted();
      const result = await checkCanvasWorkspace(project.workspacePath);
      return { content: [{ type: "text", text: result.ok ? "Canvas files and references are valid." : result.issues.map((issue) => `${issue.file}: ${issue.message}`).join("\n") }], details: { canvasCheck: result } };
    },
  }), ...(canvasStore ? [defineTool({
    name: "canvas_initialize",
    label: "Initialize Canvas",
    description: "Initialize the canvas file contract and an empty board when the requested design or asset work needs a canvas. Preserves existing boards, documents and assets. Read canvas/AGENTS.md, index.json and schemas/ afterwards. Do not use for casual conversation or planning-only requests.",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _input, signal) => {
      signal?.throwIfAborted();
      const workspace = await canvasStore.workspace(project.id);
      return {
        content: [{ type: "text", text: `Canvas ready. Read canvas/AGENTS.md, canvas/index.json and canvas/schemas/. Boards: ${JSON.stringify(workspace.boards)}.` }],
        details: {},
      };
    },
  }), defineTool({
    name: "generate_canvas_media",
    label: "Generate Canvas Media",
    description: "Generate the saved image, video, 3D or animation node using its current prompt, model and references. A game-creation request includes its needed media unless the user narrows the scope; editing a prompt or reference alone does not request generation. Saves output into the project, updates the node and shares the canvas generation history. Edit ordinary canvas files before calling this tool.",
    parameters: Type.Object({ boardId: Type.String({ minLength: 1, maxLength: 100 }), nodeId: Type.String({ minLength: 1, maxLength: 120 }) }),
    execute: async (_toolCallId, input, signal) => {
      signal?.throwIfAborted();
      const job = await canvasStore.generateNode(project.id, input.boardId, input.nodeId);
      const cancel = () => { void canvasStore.cancel(project.id, job.id).catch(() => {}); };
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      try {
        let current = job;
        while (current.status === "running") {
          signal?.throwIfAborted();
          await new Promise((resolve) => setTimeout(resolve, 250));
          const next = (await canvasStore.jobs(project.id)).find((candidate) => candidate.id === job.id);
          if (!next) throw new Error("Generation job is no longer available");
          current = next;
        }
        signal?.throwIfAborted();
        if (current.status !== "succeeded") throw new Error(current.error || "Generation failed");
        const manifest = await readCanvasAssets(project.workspacePath);
        const paths = current.run?.files.map((file) => file.assetId && manifest.assets[file.assetId]?.path).filter(Boolean) ?? [];
        return { content: [{ type: "text", text: `Generated media for node ${input.nodeId}. Saved: ${paths.join(", ")}. Read relevant image files to inspect the actual result.` }], details: { canvasGeneration: current } };
      } finally { signal?.removeEventListener("abort", cancel); }
    },
  })] : []), ...(playtest?.driver.available && playtest.driver.capabilities.projectTypes.includes(project.type)
    ? [createGameUseTool(playtest.driver, playtest.resolveOpenTarget, { bridge: project.type === "interactive-story" ? "reset" : "full" })]
    : [])];
}

/** Matches an agent-supplied action name to the library, case-insensitively, and suggests close names when it misses. */
function findAnimationAction(library: readonly Model3DAnimationAction[], name: string): Model3DAnimationAction {
  const wanted = name.trim().toLowerCase();
  const exact = library.find((action) => action.name.toLowerCase() === wanted);
  if (exact) return exact;
  const words = wanted.split(/\s+/).filter(Boolean);
  const suggestions = library.filter((action) => words.some((word) => action.name.toLowerCase().includes(word))).slice(0, 8).map((action) => action.name);
  throw new Error(`Unknown animation "${name}".${suggestions.length ? ` Similar names: ${suggestions.join(", ")}.` : ""}`);
}
