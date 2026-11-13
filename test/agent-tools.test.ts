import { createBrowserUseTool } from "../src/daemon/browser-tools.js";
import { indexPluginPackage } from "../src/daemon/plugin-index.js";
import { TEST_GLB } from "./model3d-fixture.js";
import { mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { activePiToolNames, createAgentTools, planningPiToolNames, pluginChangeNote, projectPiToolNames } from "../src/daemon/agent-tools.js";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import type { ImageGenerator } from "../src/daemon/openai-image.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { ToolRunner } from "../src/daemon/tools.js";
import { ToolBridge } from "../src/daemon/agent-runtimes/tool-bridge.js";
import { listWorkspaceFiles } from "../src/daemon/workspace.js";
import type { VideoGenerator } from "../src/daemon/video-generation.js";
import { WEB_GAME_USE_CAPABILITIES, type GameRuntimeAdapter } from "../src/shared/playtest.js";
import { pluginGameCapabilities } from "../src/daemon/plugin-game-runtime.js";
import { createNodeCodebase, createPlayableStarterCodebase } from "../src/daemon/playable-codebase.js";
import sharp from "sharp";

const TEST_VIDEO_MODEL = { provider: "openrouter", id: "example/video-model" } as const;

describe("agent tools", () => {
  it.each(["pi", "bridge"] as const)("always offers custom questionnaire answers through %s, even with an obsolete false flag", async (runtime) => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-question-tool-"));
    const projects = new ProjectManager(dataDirectory);
    await projects.load();
    const project = await projects.create("Game");
    const runner = new ToolRunner(dataDirectory, { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }) });
    await runner.load();
    const answer = { questionId: "platform", value: "Mobile", label: "Mobile", custom: true };
    const ask = vi.fn(async () => ({ cancelled: false, answers: [answer] }));
    const tool = createAgentTools(project, runner, projects, ask).find(({ name }) => name === "questionnaire")!;
    expect(JSON.stringify(tool.parameters)).not.toContain('"allowOther"');
    const question = { id: "platform", prompt: "Which platform?", options: [{ value: "web", label: "Web" }], allowOther: false };
    const signal = new AbortController().signal;
    const input = { questions: [question] };
    const output = runtime === "pi"
      ? await tool.execute("question", input, signal, undefined, {} as never)
      : (await new ToolBridge([tool]).call("questionnaire", input, "question", signal)).result;
    expect(ask).toHaveBeenCalledWith("question", { questions: [{ ...question, allowOther: true }] }, signal);
    expect(output.details).toEqual({ cancelled: false, answers: [answer] });
    expect(output.content).toEqual([{ type: "text", text: "platform: Mobile" }]);
  });

  it("maps enabled product tools to Pi tool names", () => {
    expect(planningPiToolNames()).toEqual(["read", "grep", "find", "ls", "web_fetch", "web_search", "questionnaire", "update_plan"]);
    expect(activePiToolNames([])).toEqual(["read", "write", "edit", "bash", "web_fetch", "web_search", "questionnaire", "update_plan", "install_plugin"]);
    expect(activePiToolNames(["generate-image"])).toEqual([
      "read", "write", "edit", "bash", "web_fetch", "web_search", "questionnaire", "update_plan", "install_plugin", "generate_image",
    ]);
    expect(activePiToolNames(["image-to-3d"])).toEqual([
      "read", "write", "edit", "bash", "web_fetch", "web_search", "questionnaire", "update_plan", "install_plugin", "generate_3d_asset",
    ]);
    expect(activePiToolNames(["generate-video"])).toEqual([
      "read", "write", "edit", "bash", "web_fetch", "web_search", "questionnaire", "update_plan", "install_plugin", "generate_video",
    ]);
    expect(activePiToolNames(["animate-3d"])).toEqual([
      "read", "write", "edit", "bash", "web_fetch", "web_search", "questionnaire", "update_plan", "install_plugin", "animate_3d_asset",
    ]);
    expect(activePiToolNames(
      [],
      ["read", "generate_image", "web_search"],
    )).toEqual(["read", "write", "edit", "bash", "web_fetch", "web_search", "questionnaire", "update_plan", "install_plugin"]);
    expect(projectPiToolNames("planning", ["generate-image"], ["canvas_check", "generate_canvas_media"])).toContain("canvas_check");
    expect(projectPiToolNames("planning", ["generate-image"], ["canvas_check", "generate_canvas_media"])).not.toContain("generate_canvas_media");
    expect(activePiToolNames(["generate-image"], ["canvas_check", "generate_canvas_media"])).toContain("generate_canvas_media");
    expect(activePiToolNames([], ["canvas_check", "generate_canvas_media"])).not.toContain("generate_canvas_media");
    expect(activePiToolNames([], ["canvas_initialize"])).toContain("canvas_initialize");
    expect(projectPiToolNames("planning", [], ["canvas_initialize"])).not.toContain("canvas_initialize");
  });

  it("uses the shared Pi tools for every project type", () => {
    expect(projectPiToolNames(
      "normal",
      ["generate-image", "generate-video"],
      ["read", "mcp", "web_search", "generate_image"],
    )).toEqual(["mcp", "read", "write", "edit", "bash", "web_fetch", "web_search", "questionnaire", "update_plan", "install_plugin", "generate_image", "generate_video"]);
    expect(projectPiToolNames(
      "planning",
      ["generate-image"],
      ["mcp", "questionnaire"],
    )).toEqual(["read", "grep", "find", "ls", "web_fetch", "web_search", "questionnaire", "update_plan"]);
    expect(projectPiToolNames("normal", [], ["web_search"], false)).toEqual([
      "read", "write", "edit", "bash", "web_fetch", "questionnaire", "update_plan", "install_plugin",
    ]);
  });

  it.each(["web-game", "general"] as const)("registers game use for %s only when a matching runtime adapter is available", async (type) => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-agent-playtest-"));
    const projects = new ProjectManager(dataDirectory);
    await projects.load();
    const project = await projects.create("Browser Game", type);
    const runner = new ToolRunner(dataDirectory, { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }) });
    await runner.load();
    const driver: GameRuntimeAdapter = {
      available: true,
      capabilities: WEB_GAME_USE_CAPABILITIES,
      request: async () => ({ operation: "closeAll" }),
      close: () => {},
    };

    expect(createAgentTools(project, runner, projects).some(({ name }) => name === "game_use")).toBe(false);
    const playtest = { driver, resolveOpenTarget: async () => ({ runtime: "web" as const, url: "http://127.0.0.1:43210/" }) };
    if (type === "general") {
      expect(project.webPreviewEnabled).toBe(true);
      expect(createAgentTools(project, runner, projects, undefined, undefined, playtest).some(({ name }) => name === "game_use")).toBe(true);
      await projects.setRunSettings(project.id, { startupDirectory: ".", startupScript: "dev", previewPath: "/", previewViewport: "fit", webPreviewEnabled: false });
      expect(createAgentTools(project, runner, projects, undefined, undefined, playtest).some(({ name }) => name === "game_use")).toBe(false);
      // A native type's plugin runs its game whatever the web preview does; the app only makes its runtime for such a type.
      const plugin = {
        driver: { ...driver, capabilities: pluginGameCapabilities({ operations: ["captureFrame"], maxFrame: 600 }) },
        resolveOpenTarget: async () => ({ runtime: "plugin" as const, provider: "a/b:c", projectPath: project.workspacePath }),
        maxFrame: 600,
      };
      const gameUse = createAgentTools(project, runner, projects, undefined, undefined, plugin).find(({ name }) => name === "game_use");
      expect((gameUse?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties?.frame).toMatchObject({ maximum: 600 });
      await projects.setRunSettings(project.id, { startupDirectory: ".", startupScript: "dev", previewPath: "/", previewViewport: "fit", webPreviewEnabled: true });
    }
    expect(createAgentTools(project, runner, projects, undefined, undefined, playtest).some(({ name }) => name === "game_use")).toBe(true);
  });

  it("returns provider metadata from the built-in web search tool", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-agent-search-"));
    const projects = new ProjectManager(dataDirectory);
    await projects.load();
    const project = await projects.create("Search");
    const runner = new ToolRunner(dataDirectory, { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }) });
    await runner.load();
    const search = createAgentTools(project, runner, projects, undefined, undefined, undefined, async (input, signal) => {
      expect(input.query).toBe("Godot release notes");
      signal?.throwIfAborted();
      return { content: "https://godotengine.org/", provider: "parallel", providerName: "Parallel", fallbackFrom: "exa" };
    }).find(({ name }) => name === "web_search");
    if (!search) throw new Error("Expected web search tool");

    const result = await search.execute("search-1", { query: "Godot release notes" }, undefined, undefined, {} as never);

    expect(result.content).toEqual([{ type: "text", text: "https://godotengine.org/" }]);
    expect(result.details).toEqual({ webSearch: { provider: "parallel", providerName: "Parallel", fallbackFrom: "exa" } });
  });

  it.each([
    { skills: true, count: "1 Skill", next: "applies by itself" },
    { skills: false, count: "1 panel · 1 MCP service", next: "approve what it asks for" },
  ])("reports what it installed and only installs from the current workspace ($count)", async ({ skills, count, next }) => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-agent-tool-"));
    const projects = new ProjectManager(dataDirectory);
    await projects.load();
    const project = await projects.create("Plugin Creator");
    const pluginDirectory = path.join(project.workspacePath, "character-workflow");
    const outsideDirectory = path.join(path.dirname(project.workspacePath), "outside");
    await Promise.all([mkdir(pluginDirectory), mkdir(outsideDirectory)]);
    await symlink(outsideDirectory, path.join(project.workspacePath, "linked-plugin"));
    await mkdir(path.join(pluginDirectory, ".ohmygame-plugin"));
    await writeFile(path.join(pluginDirectory, ".ohmygame-plugin/plugin.json"), JSON.stringify({
      id: "personal/character-workflow", version: "0.1.0", engines: { "ohmygame-api": "^2.0.0" },
      displayName: "Character Workflow", description: "Characters",
      ...(skills
        ? { contributes: { skills: "./skills/" } }
        : { icon: "./icon.svg", capabilities: { network: ["example.com"] }, contributes: {
          panels: [{ id: "main", title: "Characters", area: "right", entry: "./panel/index.html" }],
          mcpServers: [{ id: "api", title: "API", url: "https://example.com/mcp", tools: ["search"] }],
        } }),
    }));
    if (skills) await mkdir(path.join(pluginDirectory, "skills/character"), { recursive: true });
    else {
      await mkdir(path.join(pluginDirectory, "panel"));
      await writeFile(path.join(pluginDirectory, "panel/index.html"), "<!doctype html><title>Characters</title>");
      await writeFile(path.join(pluginDirectory, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24"/></svg>');
    }
    const runner = new ToolRunner(dataDirectory, { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }) });
    await runner.load();
    let installedPath = "";
    const tool = createAgentTools(project, runner, projects, undefined, async (sourcePath) => {
      installedPath = sourcePath;
      const indexed = await indexPluginPackage(sourcePath);
      if (!indexed.ok) throw new Error("Expected a valid package");
      return indexed.entry;
    }).find(({ name }) => name === "install_plugin");
    if (!tool) throw new Error("Expected install plugin tool");

    if (skills) {
      const skillFile = path.join(pluginDirectory, "skills/character/SKILL.md");
      await writeFile(skillFile, "# Character\nCreate a game character.");
      await expect(tool.execute("invalid-skill", { path: "character-workflow" }, undefined, undefined, {} as never)).rejects.toThrow("/contributes/skills/character");
      expect(installedPath).toBe("");
      await writeFile(skillFile, "---\nname: character\ndescription: Create a game character.\n---\n\nUse the project's character brief.");
    }
    const result = await tool.execute("call-plugin", { path: "character-workflow" }, undefined, undefined, {} as never);

    expect(installedPath).toBe(await realpath(pluginDirectory));
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("Created and installed Character Workflow") }]);
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining(count) }]);
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining(next) }]);
    await expect(tool.execute("call-outside", { path: "../outside" }, undefined, undefined, {} as never))
      .rejects.toThrow("inside the current workspace");
    await expect(tool.execute("call-linked", { path: "linked-plugin" }, undefined, undefined, {} as never))
      .rejects.toThrow("inside the current workspace");
  });

  it("leaves installing to the Plugin Builder's preview in its own projects", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-agent-tool-"));
    const projects = new ProjectManager(dataDirectory);
    await projects.load();
    const project = await projects.create("Builder");
    const runner = new ToolRunner(dataDirectory, { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }) });
    await runner.load();
    const install = async () => { throw new Error("Expected no install"); };
    expect(createAgentTools(project, runner, projects, undefined, install).map(({ name }) => name)).toContain("install_plugin");
    expect(createAgentTools({ ...project, type: "plugin" }, runner, projects, undefined, install).map(({ name }) => name)).not.toContain("install_plugin");
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
    expect(await readdir(path.join(dataDirectory, "tools", "runs"))).toEqual([]);
  });

  it("exposes configured image dimensions to the agent and forwards them to the generator", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-agent-tool-"));
    const projects = new ProjectManager(dataDirectory);
    await projects.load();
    const project = await projects.create("Game");
    const generate = vi.fn<ImageGenerator["generate"]>().mockResolvedValue({
      bytes: Buffer.from("generated image"),
      mediaType: "image/png",
    });
    const runner = new ToolRunner(dataDirectory, { generate });
    await runner.load();
    const tool = createAgentTools(project, runner, projects).find(({ name }) => name === "generate_image");
    if (!tool) throw new Error("Expected image tool");

    expect(tool.parameters).toMatchObject({
      properties: {
        resolution: expect.any(Object),
        aspectRatio: expect.any(Object),
      },
    });
    await tool.execute("call-configured", {
      prompt: "A wide fantasy landscape",
      resolution: "2K",
      aspectRatio: "16:9",
    }, undefined, undefined, {} as never);

    expect(generate).toHaveBeenCalledWith({
      prompt: "A wide fantasy landscape",
      resolution: "2K",
      aspectRatio: "16:9",
    }, undefined);
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
        return { bytes: TEST_GLB, mediaType: "model/gltf-binary" };
      },
    });
    await runner.load();
    const tool = createAgentTools(project, runner, projects).find(({ name }) => name === "generate_3d_asset");
    if (!tool) throw new Error("Expected 3D tool");

    const result = await tool.execute("call-1", { imagePath: "assets/generated/source.png" }, undefined, undefined, {} as never);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    const relativePath = text.replace("Generated 3D model saved to ", "");

    expect(relativePath).toMatch(/^assets\/generated\/model-[0-9a-f-]+\.glb$/);
    expect(await readFile(path.join(project.workspacePath, relativePath))).toEqual(TEST_GLB);
    const model = (await listWorkspaceFiles(project.workspacePath)).find((file) => file.path === relativePath);
    expect(model?.previewPath).toMatch(/^\.ohmygame\/asset-previews\/model-[0-9a-f-]+\.png$/);
    expect(await readFile(path.join(project.workspacePath, model?.previewPath ?? ""), "utf8")).toBe("source image");
    expect(result.details).toEqual({ artifact: { type: "model", path: relativePath, mediaType: "model/gltf-binary" } });
    expect(await readdir(path.join(dataDirectory, "tools", "runs"))).toEqual([]);
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
        expect(input.model).toEqual(TEST_VIDEO_MODEL);
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

    const result = await tool.execute("call-1", { prompt: "Slow camera move", model: TEST_VIDEO_MODEL, imagePath: "assets/generated/source.webp", duration: 8 }, undefined, undefined, {} as never);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    const relativePath = text.replace("Generated video saved to ", "");

    expect(relativePath).toMatch(/^assets\/generated\/video-[0-9a-f-]+\.mp4$/);
    expect(await readFile(path.join(project.workspacePath, relativePath), "utf8")).toBe("generated mp4");
    expect(result.details).toEqual({ artifact: { type: "video", path: relativePath, mediaType: "video/mp4" } });
    expect(await readdir(path.join(dataDirectory, "tools", "runs"))).toEqual([]);
  });

  it("generates speech into the current project through the common audio tool", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-agent-audio-"));
    const library = new AssetLibrary(dataDirectory);
    const projects = new ProjectManager(dataDirectory, library);
    await Promise.all([library.load(), projects.load()]);
    const project = await projects.create("Story");
    const model = { provider: "volcengine-tts", id: "seed-tts-2.0" } as const;
    const generate = vi.fn().mockResolvedValue({ bytes: Buffer.from("generated mp3"), mediaType: "audio/mpeg" as const, model });
    const runner = new ToolRunner(dataDirectory, { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }) }, undefined, undefined, library, undefined, {
      catalog: () => ({ models: [], providers: [] }), generate,
    });
    await runner.load();
    const tool = createAgentTools(project, runner, projects).find(({ name }) => name === "generate_audio");
    if (!tool) throw new Error("Expected audio tool");

    const result = await tool.execute("call-speech", { prompt: "Welcome", kind: "speech", voiceId: "narrator", model, format: "mp3", sampleRate: 24_000 }, undefined, undefined, {} as never);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    const relativePath = text.split("\n")[0]!.replace("Generated audio saved to ", "");

    expect(relativePath).toMatch(/^assets\/generated\/speech-[0-9a-f-]+\.mp3$/);
    expect(await readFile(path.join(project.workspacePath, relativePath), "utf8")).toBe("generated mp3");
    expect(result.details).toEqual({ artifact: { type: "audio", path: relativePath, mediaType: "audio/mpeg" } });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Welcome", kind: "speech", voiceId: "narrator", model }), undefined, expect.objectContaining({ begin: expect.any(Function) }));
    expect(await readdir(path.join(dataDirectory, "tools", "runs"))).toEqual([]);
  });
  it("registers standalone image and frame processing tools", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-media-agent-tool-"));
    const library = new AssetLibrary(dataDirectory);
    const projects = new ProjectManager(dataDirectory, library);
    await Promise.all([library.load(), projects.load()]);
    const project = await projects.create("Media Game");
    const runner = new ToolRunner(dataDirectory, { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }) });
    await runner.load();
    const tools = createAgentTools(project, runner, projects);
    expect(tools.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "crop_image", "extract_gif_frames", "compose_gif", "image_grid_split", "video_frame_strip", "video_compose_frames",
    ]));

    const source = await sharp({ create: { width: 4, height: 4, channels: 4, background: "red" } }).png().toBuffer();
    await projects.addGeneratedAsset(project.id, "source.png", source);
    const split = tools.find(({ name }) => name === "image_grid_split");
    if (!split) throw new Error("Expected image_grid_split");
    const splitResult = await split.execute("media-split", { sourcePath: "assets/generated/source.png", columns: 1, rows: 1 }, undefined, undefined, {} as never);
    const splitText = splitResult.content[0]?.type === "text" ? splitResult.content[0].text : "";
    const splitPath = splitText.match(/(assets\/generated\/sprite-sheet-[^ ]+\.zip)/)?.[1];
    expect(splitPath).toBeDefined();
    expect(await readFile(path.join(project.workspacePath, splitPath!))).not.toHaveLength(0);
  });

  it("registers playable_add_node only for Interactive Story and creates the Node", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-agent-playable-"));
    const projects = new ProjectManager(dataDirectory);
    await projects.load();
    const webGame = await projects.create("Browser Game");
    const story = await projects.create("Ash Club", "interactive-story");
    const runner = new ToolRunner(dataDirectory, { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }) });
    await runner.load();
    await createNodeCodebase(
      story.workspacePath,
      createPlayableStarterCodebase("Ash Club", { width: 1280, height: 720 }),
    );

    expect(createAgentTools(webGame, runner, projects).some(({ name }) => name === "playable_add_node")).toBe(false);
    const tool = createAgentTools(story, runner, projects).find(({ name }) => name === "playable_add_node");
    if (!tool) throw new Error("Expected the add Node tool");

    const result = await tool.execute("call-node", { preset: "blank", id: "opening" }, undefined, undefined, {} as never);

    expect(result.details).toEqual({ playableNode: {
      id: "opening",
      preset: "blank",
      files: ["nodes/opening/index.html", "nodes/opening/style.css", "nodes/opening/node.js"],
      signals: ["next"],
    } });
    const graph = JSON.parse(await readFile(path.join(story.workspacePath, "graph.json"), "utf8"));
    expect(graph.nodes.map((node: { id: string }) => node.id)).toEqual(["opening"]);
    expect(graph.entryNodeId).toBe("opening");
    await expect(tool.execute("call-dup", { preset: "blank", id: "opening" }, undefined, undefined, {} as never))
      .rejects.toThrow(/already exists/);
  });

  it("reports playable_check issues for Interactive Story projects", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-agent-playable-check-"));
    const projects = new ProjectManager(dataDirectory);
    await projects.load();
    const webGame = await projects.create("Browser Game");
    const story = await projects.create("Ash Club", "interactive-story");
    const runner = new ToolRunner(dataDirectory, { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }) });
    await runner.load();
    await createNodeCodebase(
      story.workspacePath,
      createPlayableStarterCodebase("Ash Club", { width: 1280, height: 720 }),
    );

    expect(createAgentTools(webGame, runner, projects).some(({ name }) => name === "playable_check")).toBe(false);
    const tool = createAgentTools(story, runner, projects).find(({ name }) => name === "playable_check");
    if (!tool) throw new Error("Expected the check tool");

    const passing = await tool.execute("call-check", {}, undefined, undefined, {} as never);
    expect(passing.details).toEqual({ playableCheck: { mode: "draft", ok: true, issues: [] } });

    const graphPath = path.join(story.workspacePath, "graph.json");
    const graph = JSON.parse(await readFile(graphPath, "utf8"));
    await writeFile(graphPath, JSON.stringify({ ...graph, entryNodeId: "missing" }));
    const failing = await tool.execute("call-check-again", { mode: "publish" }, undefined, undefined, {} as never);
    const text = failing.content[0]?.type === "text" ? failing.content[0].text : "";
    expect(failing.details).toMatchObject({ playableCheck: { mode: "publish", ok: false } });
    expect(text).toMatch(/publish validation issue/);
    expect(text).toContain("missing");
  });
});

describe("image plugin changes", () => {
  it("tells the agent which plugins changed an image's request, and the prompt used", () => {
    expect(pluginChangeNote({})).toBe("");
    expect(pluginChangeNote({ prompt: "a cat, pixel art", pluginChanges: [{ plugin: "acme/style", version: "1.0.0", fields: ["prompt", "aspectRatio"] }] }))
      .toBe("\nPlugins in this project changed the request before it was generated: acme/style 1.0.0 (prompt, aspectRatio). The prompt used was: a cat, pixel art");
    expect(pluginChangeNote({ prompt: "a cat", pluginChanges: [{ plugin: "acme/size", version: "2.0.0", fields: ["size"] }] }))
      .toBe("\nPlugins in this project changed the request before it was generated: acme/size 2.0.0 (size).");
  });
});


describe("browser tool scope", () => {
  it("binds calls to the project and returns screenshot content", async () => {
    const request = vi.fn(async () => ({ state: { projectId: "p1", tabs: [] }, screenshot: { width: 600, height: 500, data: "aW1hZ2U=" } }));
    const tool = createBrowserUseTool("p1", { available: true, request, close() {} });
    const result = await tool.execute("capture", { operation: "capture", tabId: "a" }, undefined, undefined, {} as never);
    expect(request).toHaveBeenCalledWith({ projectId: "p1", operation: "capture", tabId: "a" }, undefined);
    expect(result.content[1]).toEqual({ type: "image", data: "aW1hZ2U=", mimeType: "image/jpeg" });
    await expect(tool.execute("invalid", { operation: "act", tabId: "a", actions: [{ type: "wait", milliseconds: 60_000 }] }, undefined, undefined, {} as never)).rejects.toThrow("Invalid");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps mutating browser actions out of planning and static fetch available", () => {
    expect(projectPiToolNames("planning", [], ["browser_use", "web_fetch"])).not.toContain("browser_use");
    expect(projectPiToolNames("planning", [], ["browser_use", "web_fetch"], false)).toContain("web_fetch");
    expect(projectPiToolNames("normal", [], ["browser_use", "web_fetch"])).toContain("browser_use");
  });
});
