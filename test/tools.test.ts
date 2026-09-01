import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import type { ImageGenerator } from "../src/daemon/openai-image.js";
import { ToolRunner } from "../src/daemon/tools.js";

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("tool runner", () => {
  it("lists the fixed media tools", async () => {
    const app = createApp({ dataDirectory: await temporaryData(), imageGenerator: fakeGenerator() });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/tools" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{
      id: "generate-image",
      name: "Image Generator",
      description: "Generate a game-ready image from a text prompt.",
      category: "images",
      inputKind: "prompt",
      outputKind: "image",
      sizes: ["1024x1024", "1536x1024", "1024x1536"],
      defaultSize: "1024x1024",
    }, {
      id: "image-to-3d",
      name: "Image to 3D",
      description: "Turn a reference image into a textured 3D model.",
      category: "3d",
      inputKind: "image",
      outputKind: "model",
    }, {
      id: "generate-video",
      name: "Video Generator",
      description: "Generate a project-ready video from a text prompt or reference image.",
      category: "video",
      inputKind: "image-prompt",
      outputKind: "video",
      defaultDuration: 6,
      aspectRatios: ["16:9", "9:16", "1:1"],
      resolutions: ["720p", "1080p"],
      durations: [6, 10],
    }]);
  });

  it("runs Image to 3D and persists its GLB output", async () => {
    const dataDirectory = await temporaryData();
    const generate = vi.fn().mockResolvedValue({
      bytes: Buffer.from("glb"),
      mediaType: "model/gltf-binary" as const,
      requestId: "meshy-task-1",
    });
    const app = createApp({
      dataDirectory,
      imageGenerator: fakeGenerator(),
      model3DGenerator: { generate },
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/tools/image-to-3d/runs",
      payload: { image: { mediaType: "image/png", data: "aW1hZ2U=" } },
    });

    expect(response.statusCode).toBe(201);
    expect(generate).toHaveBeenCalledWith({ image: { mediaType: "image/png", data: "aW1hZ2U=" } }, undefined);
    const run = response.json();
    expect(run).toMatchObject({
      toolId: "image-to-3d",
      files: [{ name: "model.glb", mediaType: "model/gltf-binary" }],
    });
    const file = await app.inject({ method: "GET", url: `/tool-runs/${run.id}/files/model.glb` });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload).toEqual(Buffer.from("glb"));
  });

  it("adds a generated 3D result to a project workspace", async () => {
    const dataDirectory = await temporaryData();
    const app = createApp({
      dataDirectory,
      imageGenerator: fakeGenerator(),
      model3DGenerator: { generate: async () => ({ bytes: Buffer.from("glb"), mediaType: "model/gltf-binary" }) },
    });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Game" } })).json();
    const run = (await app.inject({
      method: "POST",
      url: "/tools/image-to-3d/runs",
      payload: { image: { mediaType: "image/jpeg", data: "aW1hZ2U=" } },
    })).json();

    const response = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/tool-results`,
      payload: { runId: run.id, fileName: "model.glb" },
    });

    const expectedPath = `assets/generated/model-${run.id}.glb`;
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ path: expectedPath });
    expect(await readFile(path.join(project.workspacePath, expectedPath), "utf8")).toBe("glb");
    const files = (await app.inject({ method: "GET", url: `/projects/${project.id}/files` })).json();
    expect(files).toContainEqual(expect.objectContaining({
      path: expectedPath,
      previewPath: `.data/asset-previews/model-${run.id}.jpg`,
    }));
    expect(await readFile(path.join(project.workspacePath, ".data", "asset-previews", `model-${run.id}.jpg`), "utf8")).toBe("image");
    const preview = await app.inject({ method: "GET", url: `/projects/${project.id}/files/raw?path=${encodeURIComponent(`.data/asset-previews/model-${run.id}.jpg`)}` });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-type"]).toBe("image/jpeg");
  });

  it("runs the image tool and persists its output outside projects", async () => {
    const dataDirectory = await temporaryData();
    const generate = vi.fn<ImageGenerator["generate"]>().mockResolvedValue({
      bytes: Buffer.from([0, 1, 2, 255]),
      mediaType: "image/webp",
      requestId: "openai-request-1",
    });
    const app = createApp({ dataDirectory, imageGenerator: { generate } });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/tools/generate-image/runs",
      payload: { prompt: "  A forest game background  ", size: "1536x1024" },
    });

    expect(response.statusCode).toBe(201);
    expect(generate).toHaveBeenCalledWith({ prompt: "A forest game background", size: "1536x1024" }, undefined);
    const run = response.json();
    expect(run).toMatchObject({
      toolId: "generate-image",
      files: [{ name: "output.webp", mediaType: "image/webp" }],
    });
    expect(run).not.toHaveProperty("requestId");
    expect(run).not.toHaveProperty("prompt");

    const file = await app.inject({ method: "GET", url: `/tool-runs/${run.id}/files/output.webp` });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toBe("image/webp");
    expect(file.rawPayload).toEqual(Buffer.from([0, 1, 2, 255]));

    const runDirectory = path.join(dataDirectory, "tools", "runs", run.id);
    expect(await readdir(runDirectory)).toEqual(["output.webp", "run.json"]);
    const storedRun = JSON.parse(await readFile(path.join(runDirectory, "run.json"), "utf8"));
    expect(storedRun).toMatchObject({
      version: 1,
      id: run.id,
      prompt: "A forest game background",
    });
    expect(storedRun).not.toHaveProperty("requestId");
  });

  it("adds a generated result to a project workspace", async () => {
    const dataDirectory = await temporaryData();
    const app = createApp({ dataDirectory, imageGenerator: fakeGenerator() });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Game" } })).json();
    const run = (await app.inject({
      method: "POST",
      url: "/tools/generate-image/runs",
      payload: { prompt: "gem" },
    })).json();

    const response = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/tool-results`,
      payload: { runId: run.id, fileName: run.files[0].name },
    });

    const expectedPath = `assets/generated/image-${run.id}.webp`;
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ path: expectedPath });
    expect(await readFile(path.join(project.workspacePath, expectedPath), "utf8")).toBe("image");
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/files` })).json())
      .toContainEqual(expect.objectContaining({ path: expectedPath, prompt: "gem" }));

    const repeated = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/tool-results`,
      payload: { runId: run.id, fileName: run.files[0].name },
    });
    expect(repeated.json()).toEqual({ path: expectedPath });
  });

  it("persists multiple Asset Studio images without project-name collisions", async () => {
    const dataDirectory = await temporaryData();
    let sequence = 0;
    const generate = vi.fn<ImageGenerator["generate"]>().mockImplementation(async () => ({
      bytes: Buffer.from(`image-${++sequence}`),
      mediaType: "image/webp",
    }));
    const app = createApp({ dataDirectory, imageGenerator: { generate } });
    apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Game" } })).json();

    const response = await app.inject({
      method: "POST",
      url: "/tools/generate-image/runs",
      payload: { prompt: "Four icons", resolution: "1K", aspectRatio: "1:1", outputs: 2 },
    });

    expect(response.statusCode).toBe(201);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenCalledWith({ prompt: "Four icons", resolution: "1K", aspectRatio: "1:1" }, undefined);
    const run = response.json();
    expect(run.files).toEqual([
      { name: "output-1.webp", mediaType: "image/webp" },
      { name: "output-2.webp", mediaType: "image/webp" },
    ]);

    for (const file of run.files) {
      const added = await app.inject({
        method: "POST",
        url: `/projects/${project.id}/tool-results`,
        payload: { runId: run.id, fileName: file.name },
      });
      expect(added.statusCode).toBe(201);
      expect(added.json().path).toBe(`assets/generated/image-${run.id}${file.name === "output-1.webp" ? "-1" : "-2"}.webp`);
    }
  });

  it("validates requests and reports missing configuration", async () => {
    const app = createApp({ dataDirectory: await temporaryData() });
    apps.push(app);

    expect((await app.inject({ method: "POST", url: "/tools/missing/runs", payload: { prompt: "image" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/tools/generate-image/runs", payload: { prompt: " " } })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST",
      url: "/tools/image-to-3d/runs",
      payload: { image: { mediaType: "image/webp", data: "aW1hZ2U=" } },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST",
      url: "/tools/generate-image/runs",
      payload: { prompt: "image", size: "800x600" },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST",
      url: "/tools/generate-image/runs",
      payload: { prompt: "image", size: "1024x1024", resolution: "1K", aspectRatio: "1:1" },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST",
      url: "/tools/generate-image/runs",
      payload: { prompt: "image", resolution: "1K" },
    })).statusCode).toBe(400);

    const unconfigured = await app.inject({
      method: "POST",
      url: "/tools/generate-image/runs",
      payload: { prompt: "image" },
    });
    expect(unconfigured.statusCode).toBe(503);
    expect(unconfigured.json()).toEqual({ error: "Image generation is not configured" });
    expect((await app.inject({ method: "GET", url: "/tool-runs/not-a-run/files/output.webp" })).statusCode).toBe(404);
    expect((await app.inject({
      method: "POST",
      url: "/projects/missing/tool-results",
      payload: { runId: "missing", fileName: "output.webp" },
    })).statusCode).toBe(404);
  });

  it("stores the selected image model without storing provider credentials", async () => {
    const app = createApp({
      dataDirectory: await temporaryData(),
      createModelRuntime: async () => imageRuntime(),
      imageFetch: async () => Response.json({ data: [{ id: "gpt-image-2" }] }),
    });
    apps.push(app);

    const before = await app.inject({ method: "GET", url: "/settings/image-generation" });
    const saved = await app.inject({
      method: "PUT",
      url: "/settings/image-generation",
      payload: { model: { provider: "openai", id: "gpt-image-2" } },
    });

    expect(before.json()).toEqual({});
    expect(saved.json()).toEqual({ model: { provider: "openai", id: "gpt-image-2" } });
  });

  it("persists Meshy settings without exposing the key", async () => {
    const app = createApp({
      dataDirectory: await temporaryData(),
      imageGenerator: fakeGenerator(),
      model3DGenerator: {
        generate: async () => ({ bytes: Buffer.from("glb"), mediaType: "model/gltf-binary" }),
      },
    });
    apps.push(app);

    expect((await app.inject({ method: "GET", url: "/settings/model-3d-generation" })).json())
      .toEqual({ apiUrl: "https://api.meshy.ai", hasApiKey: false });
    const saved = await app.inject({
      method: "PUT",
      url: "/settings/model-3d-generation",
      payload: { apiUrl: "https://mesh.example", apiKey: "secret" },
    });
    expect(saved.json()).toEqual({ apiUrl: "https://mesh.example", hasApiKey: true });
    expect(saved.body).not.toContain("secret");
  });

  it("limits tool request bodies", async () => {
    const app = createApp({ dataDirectory: await temporaryData(), imageGenerator: fakeGenerator() });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/tools/image-to-3d/runs",
      payload: { image: { mediaType: "image/png", data: "a".repeat(26 * 1024 * 1024) } },
    });
    expect(response.statusCode).toBe(413);
  });

  it("cancels image generation without persisting a run", async () => {
    const dataDirectory = await temporaryData();
    const generate: ImageGenerator["generate"] = async (_input, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    const runner = new ToolRunner(dataDirectory, { generate });
    await runner.load();
    const controller = new AbortController();

    const run = runner.run("generate-image", { prompt: "A forest" }, controller.signal);
    controller.abort();

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(await readdir(path.join(dataDirectory, "tools", "runs"))).toEqual([]);
  });

});

function temporaryData(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "open-game-tools-"));
}

function fakeGenerator(): ImageGenerator {
  return { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }) };
}

function imageRuntime(): ModelRuntime {
  return {
    getProvider: (provider: string) => provider === "openai" ? { name: "OpenAI", baseUrl: "https://api.openai.com/v1" } : undefined,
    hasConfiguredAuth: (provider: string) => provider === "openai",
    getAuth: async () => ({ auth: { apiKey: "secret" }, source: "test" }),
  } as unknown as ModelRuntime;
}
