import { access, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { ImageGenerationError, type ImageGenerator } from "../src/daemon/openai-image.js";
import { ToolRunner } from "../src/daemon/tools.js";
import { VIDEO_MODELS } from "../src/shared/contracts.js";

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("tool runner", () => {
  it("runs Image to 3D and persists its GLB output", async () => {
    const dataDirectory = await temporaryData();
    const generate = vi.fn().mockResolvedValue({
      bytes: Buffer.from("glb"),
      mediaType: "model/gltf-binary" as const,
      requestId: "meshy-task-1",
    });
    const runner = new ToolRunner(dataDirectory, fakeGenerator(), { generate });
    await runner.load();
    const run = await runner.run("image-to-3d", {
      images: [{ mediaType: "image/png", data: "ZnJvbnQ=" }],
      targetPolycount: 8_000,
      texture: true,
      pbr: true,
    });

    expect(generate).toHaveBeenCalledWith({
      images: [
        { mediaType: "image/png", data: "ZnJvbnQ=" },
      ],
      targetPolycount: 8_000,
      texture: true,
      pbr: true,
    }, undefined);
    expect(run).toMatchObject({
      toolId: "image-to-3d",
      files: [{ name: "model.glb", mediaType: "model/gltf-binary" }],
    });
    expect(await readFile(path.join(dataDirectory, "tools", "runs", run.id, "model.glb"))).toEqual(Buffer.from("glb"));
  });

  it("runs 3D generation with a target poly count", async () => {
    const generate = vi.fn().mockResolvedValue({
      bytes: Buffer.from("glb"),
      mediaType: "model/gltf-binary" as const,
    });
    const runner = new ToolRunner(await temporaryData(), fakeGenerator(), { generate });
    await runner.load();
    await runner.run("image-to-3d", {
      images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
      targetPolycount: 4_000,
      texture: false,
    });

    expect(generate).toHaveBeenCalledWith({
      images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
      targetPolycount: 4_000,
      texture: false,
    }, undefined);
  });

  it("runs the selected Seedance model with typed Library references", async () => {
    const generate = vi.fn().mockResolvedValue({
      bytes: Buffer.from("video"),
      mediaType: "video/mp4" as const,
      requestId: "seedance-task-1",
    });
    const dataDirectory = await temporaryData();
    const library = new AssetLibrary(dataDirectory);
    await library.load();
    const image = await library.add("frame.png", Buffer.from("image"));
    const video = await library.add("motion.mp4", Buffer.from("video"));
    const audio = await library.add("music.mp3", Buffer.from("audio"));
    const runner = new ToolRunner(dataDirectory, fakeGenerator(), undefined, { generate }, library);
    await runner.load();

    const run = await runner.run("generate-video", {
      prompt: "  A spaceship crossing a nebula  ",
      model: VIDEO_MODELS[1].id,
      references: [
        { type: "image", assetId: image.id },
        { type: "video", assetId: video.id },
        { type: "audio", assetId: audio.id },
      ],
      duration: 6,
      aspectRatio: "16:9",
      resolution: "720p",
    });

    expect(generate).toHaveBeenCalledWith({
      prompt: "A spaceship crossing a nebula",
      model: VIDEO_MODELS[1].id,
      references: [
        expect.objectContaining({ type: "image", name: "frame.png", mediaType: "image/png" }),
        expect.objectContaining({ type: "video", name: "motion.mp4", mediaType: "video/mp4" }),
        expect.objectContaining({ type: "audio", name: "music.mp3", mediaType: "audio/mpeg" }),
      ],
      duration: 6,
      aspectRatio: "16:9",
      resolution: "720p",
    }, undefined);
    expect(run).toMatchObject({
      toolId: "generate-video",
      files: [{ name: "output.mp4", mediaType: "video/mp4", assetId: expect.any(String) }],
    });
  });

  it("rejects out-of-range Seedance reference durations recorded in Library", async () => {
    const generate = vi.fn();
    const dataDirectory = await temporaryData();
    const library = new AssetLibrary(dataDirectory);
    await library.load();
    const video = await library.add("short.mp4", Buffer.from("video"), { duration: 1.5 });
    const runner = new ToolRunner(dataDirectory, fakeGenerator(), undefined, { generate }, library);
    await runner.load();

    await expect(runner.run("generate-video", { prompt: "Animate", references: [{ type: "video", assetId: video.id }] }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("2 to 15 seconds") });
    expect(generate).not.toHaveBeenCalled();
  });

  it("runs the image tool and persists its output outside projects", async () => {
    const dataDirectory = await temporaryData();
    const generate = vi.fn<ImageGenerator["generate"]>().mockResolvedValue({
      bytes: Buffer.from([0, 1, 2, 255]),
      mediaType: "image/webp",
      requestId: "openai-request-1",
    });
    const runner = new ToolRunner(dataDirectory, { generate });
    await runner.load();
    const run = await runner.run("generate-image", { prompt: "  A forest game background  ", size: "1536x1024" });

    expect(generate).toHaveBeenCalledWith({ prompt: "A forest game background", size: "1536x1024" }, undefined);
    expect(run).toMatchObject({
      toolId: "generate-image",
      files: [{ name: "output.webp", mediaType: "image/webp" }],
    });
    expect(run).not.toHaveProperty("requestId");
    expect(run).not.toHaveProperty("prompt");

    const runDirectory = path.join(dataDirectory, "tools", "runs", run.id);
    expect(await readdir(runDirectory)).toEqual(["output.webp", "run.json"]);
    expect(await readFile(path.join(runDirectory, "output.webp"))).toEqual(Buffer.from([0, 1, 2, 255]));
    const storedRun = JSON.parse(await readFile(path.join(runDirectory, "run.json"), "utf8"));
    expect(storedRun).toMatchObject({
      version: 1,
      id: run.id,
    });
    expect(storedRun).not.toHaveProperty("prompt");
    expect(storedRun).not.toHaveProperty("requestId");
  });

  it("generates multiple configured images", async () => {
    const dataDirectory = await temporaryData();
    let sequence = 0;
    const generate = vi.fn<ImageGenerator["generate"]>().mockImplementation(async () => ({
      bytes: Buffer.from(`image-${++sequence}`),
      mediaType: "image/webp",
    }));
    const runner = new ToolRunner(dataDirectory, { generate });
    await runner.load();
    const run = await runner.run("generate-image", { prompt: "Four icons", resolution: "1K", aspectRatio: "1:1", outputs: 2 });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenCalledWith({ prompt: "Four icons", resolution: "1K", aspectRatio: "1:1" }, undefined);
    expect(run.files).toEqual([
      { name: "output-1.webp", mediaType: "image/webp" },
      { name: "output-2.webp", mediaType: "image/webp" },
    ]);

    expect(await readdir(path.join(dataDirectory, "tools", "runs", run.id))).toEqual(["output-1.webp", "output-2.webp", "run.json"]);
  });

  it("validates requests and reports missing configuration", async () => {
    const runner = new ToolRunner(await temporaryData(), fakeGenerator());
    await runner.load();

    await expect(runner.run("missing", { prompt: "image" })).rejects.toMatchObject({ statusCode: 404 });
    const invalid: Array<[string, unknown]> = [
      ["generate-image", { prompt: " " }],
      ["image-to-3d", { images: [{ mediaType: "image/webp", data: "aW1hZ2U=" }] }],
      ["image-to-3d", { prompt: "model", images: [{ mediaType: "image/png", data: "aW1hZ2U=" }] }],
      ["image-to-3d", { prompt: "model" }],
      ["image-to-3d", { images: [] }],
      ["image-to-3d", { targetPolycount: 4_000 }],
      ["image-to-3d", { images: Array.from({ length: 2 }, () => ({ mediaType: "image/png", data: "aW1hZ2U=" })) }],
      ["generate-image", { prompt: "image", size: "800x600" }],
      ["generate-image", { prompt: "image", size: "1024x1024", resolution: "1K", aspectRatio: "1:1" }],
      ["generate-image", { prompt: "image", resolution: "1K" }],
    ];
    for (const [toolId, input] of invalid) {
      await expect(runner.run(toolId, input as never)).rejects.toMatchObject({ statusCode: 400 });
    }

    const unconfigured = new ToolRunner(await temporaryData(), {
      generate: async () => { throw new ImageGenerationError("Image generation is not configured", 503); },
    });
    await unconfigured.load();
    await expect(unconfigured.run("generate-image", { prompt: "image" }))
      .rejects.toMatchObject({ statusCode: 503, message: "Image generation is not configured" });
  });

  it("limits tool request bodies", async () => {
    const app = createApp({ dataDirectory: await temporaryData(), imageGenerator: fakeGenerator() });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/tools/image-to-3d/jobs",
      payload: { images: [{ mediaType: "image/png", data: "a".repeat(26 * 1024 * 1024) }] },
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

  it("reads files from direct runs for Agent tools", async () => {
    const dataDirectory = await temporaryData();
    const runner = new ToolRunner(dataDirectory, fakeGenerator());
    await runner.load();

    const run = await runner.run("generate-image", { prompt: "A forest" });
    await expect(runner.file(run.id, "output.webp")).resolves.toEqual({
      bytes: Buffer.from("image"),
      mediaType: "image/webp",
    });
    await expect(runner.file("not-a-run", "output.webp")).resolves.toBeUndefined();
    await expect(runner.file(run.id, "../output.webp")).resolves.toBeUndefined();
    await runner.removeRun(run.id);
    await expect(runner.file(run.id, "output.webp")).resolves.toBeUndefined();
  });

  it("runs media generations as concurrent background jobs", async () => {
    const pending: Array<(value: { bytes: Buffer; mediaType: "image/webp" }) => void> = [];
    const generate: ImageGenerator["generate"] = async () => new Promise((resolve) => pending.push(resolve));
    const dataDirectory = await temporaryData();
    const app = createApp({ dataDirectory, imageGenerator: { generate } });
    apps.push(app);

    const first = await app.inject({ method: "POST", url: "/tools/generate-image/jobs", payload: { prompt: "First image", projectId: "project-1", nodeId: "node-1" } });
    const second = await app.inject({ method: "POST", url: "/tools/generate-image/jobs", payload: { prompt: "Second image" } });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(pending).toHaveLength(2);
    expect((await app.inject({ method: "GET", url: "/tool-jobs" })).json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: second.json().id, status: "running", title: "Second image" }),
      expect.objectContaining({ id: first.json().id, status: "running", title: "First image", context: { projectId: "project-1", nodeId: "node-1" } }),
    ]));

    pending[0]!({ bytes: Buffer.from("first"), mediaType: "image/webp" });
    pending[1]!({ bytes: Buffer.from("second"), mediaType: "image/webp" });
    await vi.waitFor(async () => {
      const jobs = (await app.inject({ method: "GET", url: "/tool-jobs" })).json();
      expect(jobs.every((job: { status: string }) => job.status === "succeeded")).toBe(true);
    });
    const completed = (await app.inject({ method: "GET", url: "/tool-jobs" })).json();
    expect(completed).toHaveLength(2);
    expect(completed.every((job: { run?: unknown }) => Boolean(job.run))).toBe(true);
    for (const job of completed) {
      await expect(access(path.join(dataDirectory, "tools", "runs", job.run.id))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("requires Canvas job context to include both project and node", async () => {
    const app = createApp({ dataDirectory: await temporaryData(), imageGenerator: fakeGenerator() });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/tools/generate-image/jobs",
      payload: { prompt: "Image", projectId: "project-1" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Project and node context must be provided together" });
  });

  it("cancels and retries a background generation job", async () => {
    let attempt = 0;
    const generate: ImageGenerator["generate"] = async (_input, signal) => {
      attempt += 1;
      if (attempt > 1) return { bytes: Buffer.from("retried"), mediaType: "image/webp" };
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    };
    const app = createApp({ dataDirectory: await temporaryData(), imageGenerator: { generate } });
    apps.push(app);
    const created = await app.inject({ method: "POST", url: "/tools/generate-image/jobs", payload: { prompt: "Retry me" } });

    const cancelled = await app.inject({ method: "POST", url: `/tool-jobs/${created.json().id}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe("cancelled");
    await vi.waitFor(async () => {
      const [job] = (await app.inject({ method: "GET", url: "/tool-jobs" })).json();
      expect(job.status).toBe("cancelled");
    });
    const retried = await app.inject({ method: "POST", url: `/tool-jobs/${created.json().id}/retry` });
    expect(retried.statusCode).toBe(202);
    await vi.waitFor(async () => {
      const jobs = (await app.inject({ method: "GET", url: "/tool-jobs" })).json();
      expect(jobs.find((job: { id: string }) => job.id === retried.json().id)?.status).toBe("succeeded");
      expect(jobs.some((job: { id: string }) => job.id === created.json().id)).toBe(false);
    });
  });

  it("keeps only recent completed background jobs", async () => {
    const app = createApp({ dataDirectory: await temporaryData(), imageGenerator: fakeGenerator() });
    apps.push(app);

    await Promise.all(Array.from({ length: 21 }, (_, index) => app.inject({
      method: "POST",
      url: "/tools/generate-image/jobs",
      payload: { prompt: `Image ${index}` },
    })));
    await vi.waitFor(async () => {
      const jobs = (await app.inject({ method: "GET", url: "/tool-jobs" })).json();
      expect(jobs).toHaveLength(20);
      expect(jobs.every((job: { status: string }) => job.status === "succeeded")).toBe(true);
    });
  });

});

function temporaryData(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "ohmygame-tools-"));
}

function fakeGenerator(): ImageGenerator {
  return { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }) };
}
