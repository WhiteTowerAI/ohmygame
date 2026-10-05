import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MeshyProvider } from "../src/daemon/meshy-provider.js";
import { MeshySettingsStore } from "../src/daemon/meshy-settings.js";

const T2 = { provider: "meshy", id: "meshy-t2" };
const MESHY_7_1 = { provider: "meshy", id: "meshy-7.1" };
const IMAGE = { mediaType: "image/png" as const, data: "aW1hZ2U=" };

describe("Meshy provider", () => {
  it("creates, polls, and downloads an image-to-3D task", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ result: "task-1" }))
      .mockResolvedValueOnce(Response.json({ status: "SUCCEEDED", model_urls: { glb: "https://files.example/model.glb" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const provider = new MeshyProvider(() => "meshy-key", request, 0);

    await expect(provider.generate({
      model: T2,
      images: [IMAGE],
      targetPolycount: 8_000,
      texture: true,
      pbr: true,
    })).resolves.toEqual({
      bytes: Buffer.from([1, 2, 3]),
      mediaType: "model/gltf-binary",
      requestId: "task-1",
    });

    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "https://api.meshy.ai/openapi/v1/image-to-3d",
      "https://api.meshy.ai/openapi/v1/image-to-3d/task-1",
      "https://files.example/model.glb",
    ]);
    expect(request.mock.calls[0]?.[1]?.headers).toEqual({
      authorization: "Bearer meshy-key",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      image_url: "data:image/png;base64,aW1hZ2U=",
      model_type: "smart-topology",
      ai_model: "meshy-t2",
      enable_pbr: true,
      should_texture: true,
      target_polycount: 8_000,
    });
  });

  it("keeps polling through a dropped status request", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ result: "task-1" }))
      .mockRejectedValueOnce(new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }))
      .mockResolvedValueOnce(Response.json({ status: "SUCCEEDED", model_urls: { glb: "https://files.example/model.glb" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
    const provider = new MeshyProvider(() => "meshy-key", request, 0);

    await expect(provider.generate({ model: T2, images: [IMAGE], texture: true, pbr: false }))
      .resolves.toMatchObject({ requestId: "task-1" });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("reports why Meshy could not be reached", async () => {
    const request = vi.fn<typeof fetch>()
      .mockRejectedValue(new TypeError("fetch failed", { cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }) }));
    const provider = new MeshyProvider(() => "meshy-key", request, 0);

    await expect(provider.generate({ model: T2, images: [IMAGE], texture: true, pbr: false }))
      .rejects.toMatchObject({ message: "Could not reach Meshy (UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error)", statusCode: 502 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("includes the HTTP status in Meshy errors", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ message: "Not found" }, { status: 404 }));
    const provider = new MeshyProvider(() => "meshy-key", request, 0);

    await expect(provider.generate({ model: T2, images: [IMAGE], texture: true, pbr: false }))
      .rejects.toMatchObject({ message: "Meshy 404: Not found", statusCode: 400 });
  });

  it("sends Meshy 7.1 every view through the multi-image endpoint with remeshing", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ result: "task-7" }))
      .mockResolvedValueOnce(Response.json({ status: "SUCCEEDED", model_urls: { glb: "https://files.example/model.glb" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([7]), { status: 200 }));
    const provider = new MeshyProvider(() => "meshy-key", request, 0);
    const back = { mediaType: "image/jpeg" as const, data: "YmFjaw==" };

    await expect(provider.generate({ model: MESHY_7_1, images: [IMAGE, back], targetPolycount: 100_000, texture: true, pbr: false }))
      .resolves.toMatchObject({ requestId: "task-7" });
    expect(request.mock.calls.map(([url]) => url).slice(0, 2)).toEqual([
      "https://api.meshy.ai/openapi/v1/multi-image-to-3d",
      "https://api.meshy.ai/openapi/v1/multi-image-to-3d/task-7",
    ]);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      image_urls: ["data:image/png;base64,aW1hZ2U=", "data:image/jpeg;base64,YmFjaw=="],
      ai_model: "meshy-7.1",
      should_texture: true,
      enable_pbr: false,
      should_remesh: true,
      topology: "triangle",
      target_polycount: 100_000,
    });
  });

  it("rejects models and view counts Meshy cannot run", async () => {
    const provider = new MeshyProvider(() => "meshy-key", vi.fn<typeof fetch>());
    await expect(provider.generate({ model: MESHY_7_1, images: Array.from({ length: 5 }, () => IMAGE), texture: true, pbr: false }))
      .rejects.toMatchObject({ message: "Meshy 7.1 takes 1 to 4 reference images", statusCode: 400 });
    await expect(provider.generate({ model: { provider: "meshy", id: "meshy-5" }, images: [IMAGE], texture: true, pbr: false }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("requires a configured key and exactly one image", async () => {
    const provider = new MeshyProvider(() => undefined);
    await expect(provider.generate({ model: T2, images: [], texture: true, pbr: false }))
      .rejects.toMatchObject({ message: "Meshy T2 requires exactly one reference image", statusCode: 400 });
    await expect(provider.generate({ model: T2, images: [IMAGE], texture: true, pbr: false }))
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
