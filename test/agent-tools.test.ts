import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { activePiToolNames, createAgentTools } from "../src/daemon/agent-tools.js";
import type { ImageGenerator } from "../src/daemon/openai-image.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { ToolRunner } from "../src/daemon/tools.js";

describe("agent tools", () => {
  it("maps enabled product tools to Pi tool names", () => {
    expect(activePiToolNames({ enabledTools: [] })).toEqual(["read", "write", "edit", "bash"]);
    expect(activePiToolNames({ enabledTools: ["generate-image"] })).toEqual([
      "read", "write", "edit", "bash", "generate_image",
    ]);
  });

  it("generates an image into the current project workspace", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-agent-tool-"));
    const projects = new ProjectManager(dataDirectory);
    await projects.load();
    const project = await projects.create("Game");
    const controller = new AbortController();
    const imageGenerator: ImageGenerator = {
      generate: async (_input, signal) => {
        expect(signal).toBe(controller.signal);
        return { bytes: Buffer.from("generated image"), mediaType: "image/webp" };
      },
    };
    const runner = new ToolRunner(dataDirectory, imageGenerator);
    await runner.load();
    const tool = createAgentTools(project, runner, projects)[0];
    if (!tool) throw new Error("Expected image tool");

    const result = await tool.execute("call-1", { prompt: "A forest", size: "1536x1024" }, controller.signal, undefined, {} as never);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    const relativePath = text.replace("Generated image saved to ", "");

    expect(tool.name).toBe("generate_image");
    expect(relativePath).toMatch(/^assets\/generated\/image-[0-9a-f-]+\.webp$/);
    expect(await readFile(path.join(project.workspacePath, relativePath), "utf8")).toBe("generated image");
  });
});
