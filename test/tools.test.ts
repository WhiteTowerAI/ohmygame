import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import type { ImageGenerator } from "../src/daemon/openai-image.js";
import { ToolRunner } from "../src/daemon/tools.js";

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("tool runner", () => {
  it("lists the fixed image tool", async () => {
    const app = createApp({ dataDirectory: await temporaryData(), imageGenerator: fakeGenerator() });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/tools" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{
      id: "generate-image",
      name: "Image Generator",
      description: "Generate a game-ready image from a text prompt.",
      category: "images",
      sizes: ["1024x1024", "1536x1024", "1024x1536"],
      defaultSize: "1024x1024",
    }]);
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

    const file = await app.inject({ method: "GET", url: `/tool-runs/${run.id}/files/output.webp` });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toBe("image/webp");
    expect(file.rawPayload).toEqual(Buffer.from([0, 1, 2, 255]));

    const runDirectory = path.join(dataDirectory, "tools", "runs", run.id);
    expect(await readdir(runDirectory)).toEqual(["output.webp", "run.json"]);
    expect(JSON.parse(await readFile(path.join(runDirectory, "run.json"), "utf8"))).toMatchObject({
      version: 1,
      id: run.id,
      requestId: "openai-request-1",
    });
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

    const repeated = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/tool-results`,
      payload: { runId: run.id, fileName: run.files[0].name },
    });
    expect(repeated.json()).toEqual({ path: expectedPath });
  });

  it("validates requests and reports missing configuration", async () => {
    const app = createApp({ dataDirectory: await temporaryData(), openAIApiKey: "" });
    apps.push(app);

    expect((await app.inject({ method: "POST", url: "/tools/missing/runs", payload: { prompt: "image" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/tools/generate-image/runs", payload: { prompt: " " } })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST",
      url: "/tools/generate-image/runs",
      payload: { prompt: "image", size: "800x600" },
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

  it("persists the tools enabled for the agent", async () => {
    const dataDirectory = await temporaryData();
    const app = createApp({ dataDirectory, imageGenerator: fakeGenerator() });
    apps.push(app);

    expect((await app.inject({ method: "GET", url: "/tool-settings" })).json()).toEqual({ enabledTools: [] });
    const update = await app.inject({
      method: "PUT",
      url: "/tool-settings",
      payload: { enabledTools: ["generate-image"] },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toEqual({ enabledTools: ["generate-image"] });
    expect((await app.inject({
      method: "PUT",
      url: "/tool-settings",
      payload: { enabledTools: ["missing"] },
    })).statusCode).toBe(400);

    await app.close();
    apps.splice(apps.indexOf(app), 1);
    const restarted = createApp({ dataDirectory, imageGenerator: fakeGenerator() });
    apps.push(restarted);
    expect((await restarted.inject({ method: "GET", url: "/tool-settings" })).json())
      .toEqual({ enabledTools: ["generate-image"] });
  });
});

function temporaryData(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "open-game-tools-"));
}

function fakeGenerator(): ImageGenerator {
  return { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }) };
}
