import { readFile } from "node:fs/promises";
import { defineTool, type ToolDefinition as PiToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PlanState, ProjectState, QuestionnaireResult, ToolDefinition, ToolSettings } from "../shared/contracts.js";
import type { ProjectManager } from "./projects.js";
import type { ToolRunner } from "./tools.js";
import { getWorkspaceMedia } from "./workspace.js";

const PI_TOOL_NAMES: Record<ToolDefinition["id"], string> = {
  "generate-image": "generate_image",
  "image-to-3d": "generate_3d_asset",
  "generate-video": "generate_video",
};
const PI_BUILTIN_TOOL_NAMES = new Set(["read", "write", "edit", "bash", "grep", "find", "ls", "update_plan", "questionnaire"]);

export function activePiToolNames(settings: ToolSettings, registeredToolNames: readonly string[] = []): string[] {
  const openGameToolNames = new Set(Object.values(PI_TOOL_NAMES));
  const extensionTools = registeredToolNames.filter((name) => !openGameToolNames.has(name) && !PI_BUILTIN_TOOL_NAMES.has(name));
  return [...new Set([...extensionTools, "read", "write", "edit", "bash", "update_plan", ...settings.enabledTools.map((id) => PI_TOOL_NAMES[id])])];
}

export function planningPiToolNames(): string[] {
  return ["read", "grep", "find", "ls", "questionnaire", "update_plan"];
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

export function createAgentTools(
  project: ProjectState,
  tools: ToolRunner,
  projects: ProjectManager,
  askQuestionnaire?: AskQuestionnaire,
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
      size: Type.Optional(Type.Union([
        Type.Literal("1024x1024"),
        Type.Literal("1536x1024"),
        Type.Literal("1024x1536"),
      ], { description: "Output size" })),
    }),
    execute: async (_toolCallId, input, signal) => {
      signal?.throwIfAborted();
      const run = await tools.run("generate-image", input, signal);
      const output = run.files[0];
      if (!output) throw new Error("Image generator returned no output");
      const file = await tools.file(run.id, output.name);
      if (!file) throw new Error("Generated image could not be read");
      signal?.throwIfAborted();
      const extension = output.mediaType === "image/png" ? "png" : output.mediaType === "image/jpeg" ? "jpg" : "webp";
      const fileName = `image-${run.id}.${extension}`;
      const relativePath = await projects.addGeneratedAsset(project.id, fileName, file.bytes);
      return {
        content: [{ type: "text", text: `Generated image saved to ${relativePath}` }],
        details: { artifact: { type: "image", path: relativePath, mediaType: output.mediaType } },
      };
    },
  }), defineTool({
    name: PI_TOOL_NAMES["image-to-3d"],
    label: "Generate 3D Asset",
    description: "Turn a PNG or JPEG in the current project into a textured GLB model.",
    parameters: Type.Object({
      imagePath: Type.String({ description: "Path to a PNG or JPEG image in the current project workspace" }),
    }),
    execute: async (_toolCallId, input, signal) => {
      signal?.throwIfAborted();
      const source = await getWorkspaceMedia(project.workspacePath, input.imagePath);
      if (source.contentType !== "image/png" && source.contentType !== "image/jpeg") {
        throw new Error("Image to 3D requires a PNG or JPEG image");
      }
      const run = await tools.run("image-to-3d", {
        image: { mediaType: source.contentType, data: (await readFile(source.absolutePath)).toString("base64") },
      }, signal);
      const output = run.files[0];
      if (!output) throw new Error("3D generator returned no output");
      const file = await tools.file(run.id, output.name);
      if (!file) throw new Error("Generated 3D model could not be read");
      signal?.throwIfAborted();
      const relativePath = await projects.addGeneratedAsset(project.id, `model-${run.id}.glb`, file.bytes);
      return {
        content: [{ type: "text", text: `Generated 3D model saved to ${relativePath}` }],
        details: { artifact: { type: "model", path: relativePath, mediaType: output.mediaType } },
      };
    },
  }), defineTool({
    name: PI_TOOL_NAMES["generate-video"],
    label: "Generate Video",
    description: "Generate a video from a text prompt, optionally animating a PNG or JPEG from the current project.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Describe the motion and camera movement" }),
      imagePath: Type.Optional(Type.String({ description: "Optional path to a PNG or JPEG image in the current project workspace" })),
      duration: Type.Optional(Type.Integer({ minimum: 1, maximum: 15, description: "Video duration in seconds" })),
      aspectRatio: Type.Optional(Type.Union([Type.Literal("16:9"), Type.Literal("9:16"), Type.Literal("1:1")], { description: "Video aspect ratio" })),
      resolution: Type.Optional(Type.Union([Type.Literal("720p"), Type.Literal("1080p")], { description: "Video resolution" })),
    }),
    execute: async (_toolCallId, input, signal) => {
      signal?.throwIfAborted();
      const source = input.imagePath ? await getWorkspaceMedia(project.workspacePath, input.imagePath) : undefined;
      if (source && source.contentType !== "image/png" && source.contentType !== "image/jpeg") throw new Error("Video generation requires a PNG or JPEG image");
      const run = await tools.run("generate-video", {
        prompt: input.prompt,
        duration: input.duration,
        aspectRatio: input.aspectRatio,
        resolution: input.resolution,
        ...(source ? { image: { mediaType: source.contentType, data: (await readFile(source.absolutePath)).toString("base64") } } : {}),
      }, signal);
      const output = run.files[0];
      if (!output) throw new Error("Video generator returned no output");
      const file = await tools.file(run.id, output.name);
      if (!file) throw new Error("Generated video could not be read");
      signal?.throwIfAborted();
      const relativePath = await projects.addGeneratedAsset(project.id, `video-${run.id}.mp4`, file.bytes);
      return {
        content: [{ type: "text", text: `Generated video saved to ${relativePath}` }],
        details: { artifact: { type: "video", path: relativePath, mediaType: output.mediaType } },
      };
    },
  })];
}
