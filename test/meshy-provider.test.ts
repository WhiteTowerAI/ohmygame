import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MeshyProvider } from "../src/daemon/meshy-provider.js";
import { MeshySettingsStore } from "../src/daemon/meshy-settings.js";

describe("Meshy provider", () => {
  it("creates, polls, and downloads an image-to-3D task", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ result: "task-1" }))
      .mockResolvedValueOnce(Response.json({ status: "SUCCEEDED", model_urls: { glb: "https://files.example/model.glb" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const provider = new MeshyProvider(() => "meshy-key", request, 0);

    await expect(provider.generate({
      images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
      targetPolycount: 8_000,
      texture: true,
      pbr: true,
    })).resolves.toEqual({
      bytes: Buffer.from([1, 2, 3]),
      mediaType: "model/gltf-binary",
      requestId: "task-1",
    });

    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "https://api.meshy.ai/openapi/v2/image-to-3d",
      "https://api.meshy.ai/openapi/v2/image-to-3d/task-1",
      "https://files.example/model.glb",
    ]);
    expect(request.mock.calls[0]?.[1]?.headers).toEqual({
      authorization: "Bearer meshy-key",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      image_url: "data:image/png;base64,aW1hZ2U=",
      enable_pbr: true,
      should_texture: true,
      topology: "triangle",
      target_polycount: 8_000,
    });
  });

  it("requires a configured key and exactly one image", async () => {
    const provider = new MeshyProvider(() => undefined);
    await expect(provider.generate({ images: [], texture: true, pbr: false }))
      .rejects.toMatchObject({ message: "Meshy T2 requires exactly one reference image", statusCode: 400 });
    await expect(provider.generate({ images: [{ mediaType: "image/png", data: "aW1hZ2U=" }], texture: true, pbr: false }))
      .rejects.toMatchObject({ message: "Meshy API key is not configured", statusCode: 503 });
  });
});

describe("Meshy settings", () => {
  it("persists and clears the API key", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-meshy-"));
    const settings = new MeshySettingsStore(directory);
    await settings.load();
    expect(settings.get()).toEqual({ configured: false });

    await expect(settings.update("  meshy-key  ")).resolves.toEqual({ configured: true });
    expect(settings.key()).toBe("meshy-key");
    expect(JSON.parse(await readFile(path.join(directory, "meshy.json"), "utf8"))).toEqual({ version: 1, apiKey: "meshy-key" });

    const restored = new MeshySettingsStore(directory);
    await restored.load();
    expect(restored.key()).toBe("meshy-key");
    await restored.clear();
    expect(restored.get()).toEqual({ configured: false });
  });
});
