import { mkdir, mkdtemp, readFile, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { activePiToolNames, createAgentTools, planningPiToolNames, projectPiToolNames } from "../src/daemon/agent-tools.js";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import type { ImageGenerator } from "../src/daemon/openai-image.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { ToolRunner } from "../src/daemon/tools.js";
import { listWorkspaceFiles } from "../src/daemon/workspace.js";
import type { VideoGenerator } from "../src/daemon/seedance-video.js";

describe("agent tools", () => {
  it("maps enabled product tools to Pi tool names", () => {
    expect(planningPiToolNames()).toEqual(["read", "grep", "find", "ls", "questionnaire", "update_plan"]);
    expect(activePiToolNames([])).toEqual(["read", "write", "edit", "bash", "update_plan", "install_plugin"]);
    expect(activePiToolNames(["generate-image"])).toEqual([
      "read", "write", "edit", "bash", "update_plan", "install_plugin", "generate_image",
    ]);
    expect(activePiToolNames(["image-to-3d"])).toEqual([
      "read", "write", "edit", "bash", "update_plan", "install_plugin", "generate_3d_asset",
    ]);
    expect(activePiToolNames(["generate-video"])).toEqual([
      "read", "write", "edit", "bash", "update_plan", "install_plugin", "generate_video",
    ]);
    expect(activePiToolNames(
      [],
      ["read", "generate_image", "web_search"],
    )).toEqual(["web_search", "read", "write", "edit", "bash", "update_plan", "install_plugin"]);
  });

  it("keeps Interactive Drama on Pi's built-in file tools", () => {
    expect(projectPiToolNames(
      "interactive-drama",
      "normal",
      ["generate-image", "generate-video"],
      ["read", "mcp", "web_search", "generate_image"],
    )).toEqual(["read", "write", "edit", "bash", "grep", "find", "ls"]);
    expect(projectPiToolNames(
      "interactive-drama",
      "planning",
      ["generate-image"],
      ["mcp", "questionnaire"],
    )).toEqual(["read", "grep", "find", "ls"]);
  });

  it("installs a plugin only from inside the current workspace", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-agent-tool-"));
    const projects = new ProjectManager(dataDirectory);
    await projects.load();
    const project = await projects.create("Plugin Creator");
    const pluginDirectory = path.join(project.workspacePath, "character-workflow");
    const outsideDirectory = path.join(path.dirname(project.workspacePath), "outside");
    await Promise.all([mkdir(pluginDirectory), mkdir(outsideDirectory)]);
    await symlink(outsideDirectory, path.join(project.workspacePath, "linked-plugin"));
    const runner = new ToolRunner(dataDirectory, { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }) });
    await runner.load();
    let installedPath = "";
    const plugin = {
      id: "personal:character-workflow", name: "character-workflow", displayName: "Character Workflow", description: "Characters", version: "0.1.0",
      marketplace: { id: "personal", displayName: "Personal" }, source: { type: "directory" as const }, installed: true, enabled: true,
      skills: [{ id: "skills/character/SKILL.md", name: "Character", enabled: true }], connections: [],
    };
    const tool = createAgentTools(project, runner, projects, undefined, async (sourcePath) => {
      installedPath = sourcePath;
      return plugin;
    }).find(({ name }) => name === "install_plugin");
    if (!tool) throw new Error("Expected install plugin tool");

    const result = await tool.execute("call-plugin", { path: "character-workflow" }, undefined, undefined, {} as never);

    expect(installedPath).toBe(await realpath(pluginDirectory));
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("Created and installed Character Workflow") }]);
    await expect(tool.execute("call-outside", { path: "../outside" }, undefined, undefined, {} as never))
      .rejects.toThrow("inside the current workspace");
    await expect(tool.execute("call-linked", { path: "linked-plugin" }, undefined, undefined, {} as never))
      .rejects.toThrow("inside the current workspace");
  });

  it("generates an image into the current project workspace", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-agent-tool-"));
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
    const tool = createAgentTools(project, runner, projects).find(({ name }) => name === "generate_image");
    if (!tool) throw new Error("Expected image tool");

    const result = await tool.execute("call-1", { prompt: "A forest", size: "1536x1024" }, controller.signal, undefined, {} as never);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    const relativePath = text.replace("Generated image saved to ", "");

    expect(tool.name).toBe("generate_image");
    expect(relativePath).toMatch(/^assets\/generated\/image-[0-9a-f-]+\.webp$/);
    expect(result.details).toEqual({ artifact: { type: "image", path: relativePath, mediaType: "image/webp" } });
    expect(await readFile(path.join(project.workspacePath, relativePath), "utf8")).toBe("generated image");
  });

  it("publishes a validated structured plan", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-agent-tool-"));
    const projects = new ProjectManager(dataDirectory);
    await projects.load();
    const project = await projects.create("Game");
    const runner = new ToolRunner(dataDirectory, { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }) });
    await runner.load();
    const tool = createAgentTools(project, runner, projects).find(({ name }) => name === "update_plan");
    if (!tool) throw new Error("Expected plan tool");

    const result = await tool.execute("call-plan", {
      explanation: " Starting implementation ",
      plan: [
        { step: " Inspect files ", status: "completed" },
        { step: "Implement change", status: "in_progress" },
      ],
    }, undefined, undefined, {} as never);

    expect(result.details).toEqual({ plan: {
      explanation: "Starting implementation",
      steps: [
        { step: "Inspect files", status: "completed" },
        { step: "Implement change", status: "in_progress" },
      ],
    } });
    expect(result.content).toEqual([{ type: "text", text: "Plan updated: 1/2 steps completed." }]);

    await expect(tool.execute("call-invalid", {
      plan: [
        { step: "First", status: "in_progress" },
        { step: "Second", status: "in_progress" },
      ],
    }, undefined, undefined, {} as never)).rejects.toThrow("at most one in_progress");
  });

  it("generates a 3D model from a project image", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-agent-tool-"));
    const projects = new ProjectManager(dataDirectory);
    await projects.load();
    const project = await projects.create("Game");
    await projects.addGeneratedAsset(project.id, "source.png", Buffer.from("source image"));
    const runner = new ToolRunner(dataDirectory, {
      generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }),
    }, {
      generate: async ({ images }) => {
        expect(images).toEqual([{ mediaType: "image/png", data: Buffer.from("source image").toString("base64") }]);
        return { bytes: Buffer.from("generated glb"), mediaType: "model/gltf-binary" };
      },
    });
    await runner.load();
    const tool = createAgentTools(project, runner, projects).find(({ name }) => name === "generate_3d_asset");
    if (!tool) throw new Error("Expected 3D tool");

    const result = await tool.execute("call-1", { imagePath: "assets/generated/source.png" }, undefined, undefined, {} as never);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    const relativePath = text.replace("Generated 3D model saved to ", "");

    expect(relativePath).toMatch(/^assets\/generated\/model-[0-9a-f-]+\.glb$/);
    expect(await readFile(path.join(project.workspacePath, relativePath), "utf8")).toBe("generated glb");
    const model = (await listWorkspaceFiles(project.workspacePath)).find((file) => file.path === relativePath);
    expect(model?.previewPath).toMatch(/^\.data\/asset-previews\/model-[0-9a-f-]+\.png$/);
    expect(await readFile(path.join(project.workspacePath, model?.previewPath ?? ""), "utf8")).toBe("source image");
    expect(result.details).toEqual({ artifact: { type: "model", path: relativePath, mediaType: "model/gltf-binary" } });
  });

  it("generates a video from a project image", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-agent-tool-"));
    const library = new AssetLibrary(dataDirectory);
    const projects = new ProjectManager(dataDirectory, library);
    await Promise.all([library.load(), projects.load()]);
    const project = await projects.create("Game");
    await projects.addGeneratedAsset(project.id, "source.webp", Buffer.from("source image"));
    const videoGenerator: VideoGenerator = {
      generate: async (input) => {
        expect(input.prompt).toBe("Slow camera move");
        expect(input.duration).toBe(8);
        expect(input.references).toHaveLength(1);
        expect(input.references?.[0]?.type).toBe("image");
        return { bytes: Buffer.from("generated mp4"), mediaType: "video/mp4" };
      },
    };
    const runner = new ToolRunner(dataDirectory, { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }) }, undefined, videoGenerator, library);
    await runner.load();
    const tool = createAgentTools(project, runner, projects).find(({ name }) => name === "generate_video");
    if (!tool) throw new Error("Expected video tool");

    const result = await tool.execute("call-1", { prompt: "Slow camera move", imagePath: "assets/generated/source.webp", duration: 8 }, undefined, undefined, {} as never);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    const relativePath = text.replace("Generated video saved to ", "");

    expect(relativePath).toMatch(/^assets\/generated\/video-[0-9a-f-]+\.mp4$/);
    expect(await readFile(path.join(project.workspacePath, relativePath), "utf8")).toBe("generated mp4");
    expect(result.details).toEqual({ artifact: { type: "video", path: relativePath, mediaType: "video/mp4" } });
  });
});
