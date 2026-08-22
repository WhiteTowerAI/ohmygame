import { readFile } from "node:fs/promises";
import { defineTool, type ToolDefinition as PiToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ProjectState, ToolDefinition, ToolSettings } from "../shared/contracts.js";
import type { ProjectManager } from "./projects.js";
import type { ToolRunner } from "./tools.js";
import { getWorkspaceMedia } from "./workspace.js";

const PI_TOOL_NAMES: Record<ToolDefinition["id"], string> = {
  "generate-image": "generate_image",
  "image-to-3d": "generate_3d_asset",
};

export function activePiToolNames(settings: ToolSettings): string[] {
  return ["read", "write", "edit", "bash", ...settings.enabledTools.map((id) => PI_TOOL_NAMES[id])];
}

export function createAgentTools(
  project: ProjectState,
  tools: ToolRunner,
  projects: ProjectManager,
): PiToolDefinition[] {
  return [defineTool({
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
  })];
}
