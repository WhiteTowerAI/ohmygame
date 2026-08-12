import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import type { ImageGenerator } from "../src/daemon/openai-image.js";

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
    expect(generate).toHaveBeenCalledWith({ prompt: "A forest game background", size: "1536x1024" });
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
  });
});

function temporaryData(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "open-game-tools-"));
}

function fakeGenerator(): ImageGenerator {
  return { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }) };
}
