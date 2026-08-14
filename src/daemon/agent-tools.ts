import { defineTool, type ToolDefinition as PiToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ProjectState, ToolDefinition, ToolSettings } from "../shared/contracts.js";
import type { ProjectManager } from "./projects.js";
import type { ToolRunner } from "./tools.js";

const PI_TOOL_NAMES: Record<ToolDefinition["id"], string> = {
  "generate-image": "generate_image",
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
      const fileName = `image-${run.id}.webp`;
      const relativePath = await projects.addGeneratedAsset(project.id, fileName, file.bytes);
      return {
        content: [{ type: "text", text: `Generated image saved to ${relativePath}` }],
        details: { path: relativePath },
      };
    },
  })];
}
