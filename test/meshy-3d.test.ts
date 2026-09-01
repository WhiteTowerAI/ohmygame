import { describe, expect, it, vi } from "vitest";
import { Meshy3DGenerator, Model3DGenerationError } from "../src/daemon/meshy-3d.js";

describe("Meshy 3D generation", () => {
  it("creates a textured task, polls it, and downloads the GLB", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ result: "task-1" }))
      .mockResolvedValueOnce(Response.json({ status: "IN_PROGRESS" }))
      .mockResolvedValueOnce(Response.json({ status: "SUCCEEDED", model_urls: { glb: "https://cdn.example/model.glb" } }))
      .mockResolvedValueOnce(new Response("glb"));
    const generator = new Meshy3DGenerator(() => ({ apiKey: "secret", apiUrl: "https://api.meshy.ai" }), request, 0);

    const result = await generator.generate({
      image: { mediaType: "image/png", data: "aW1hZ2U=" },
      model: "meshy-7",
      quality: "ultra",
      texture: true,
      textureResolution: "4K",
      pbr: true,
      pose: "a-pose",
    });

    expect(result.bytes.toString()).toBe("glb");
    expect(result.mediaType).toBe("model/gltf-binary");
    expect(result.requestId).toBe("task-1");
    expect(request).toHaveBeenNthCalledWith(1, "https://api.meshy.ai/openapi/v1/image-to-3d", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        image_url: "data:image/png;base64,aW1hZ2U=",
        ai_model: "meshy-7",
        model_type: "standard",
        ultra_mode: true,
        should_texture: true,
        texture_resolution: "4k",
        enable_pbr: true,
        pose_mode: "a-pose",
        image_enhancement: true,
        should_remesh: false,
        target_formats: ["glb"],
      }),
    }));
    expect(request).toHaveBeenNthCalledWith(4, "https://cdn.example/model.glb", expect.objectContaining({}));
  });

  it("creates and refines a textured Text to 3D model", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ result: "preview-1" }))
      .mockResolvedValueOnce(Response.json({ status: "SUCCEEDED", model_urls: { glb: "https://cdn.example/preview.glb" } }))
      .mockResolvedValueOnce(Response.json({ result: "refine-1" }))
      .mockResolvedValueOnce(Response.json({ status: "SUCCEEDED", model_urls: { glb: "https://cdn.example/refined.glb" } }))
      .mockResolvedValueOnce(new Response("refined glb"));
    const generator = new Meshy3DGenerator(() => ({ apiKey: "secret", apiUrl: "https://api.meshy.ai" }), request, 0);

    const result = await generator.generate({
      prompt: "A wooden treasure chest",
      model: "meshy-7",
      quality: "ultra",
      texture: true,
      textureResolution: "8K",
      pbr: true,
      pose: "auto",
    });

    expect(result.bytes.toString()).toBe("refined glb");
    expect(result.requestId).toBe("refine-1");
    expect(request).toHaveBeenNthCalledWith(1, "https://api.meshy.ai/openapi/v2/text-to-3d", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        mode: "preview",
        prompt: "A wooden treasure chest",
        ai_model: "meshy-7",
        model_type: "standard",
        ultra_mode: true,
        pose_mode: "",
        should_remesh: false,
        target_formats: ["glb"],
      }),
    }));
    expect(request).toHaveBeenNthCalledWith(3, "https://api.meshy.ai/openapi/v2/text-to-3d", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        mode: "refine",
        preview_task_id: "preview-1",
        ai_model: "meshy-7",
        enable_pbr: true,
        texture_resolution: "8k",
        target_formats: ["glb"],
      }),
    }));
    expect(request).toHaveBeenNthCalledWith(5, "https://cdn.example/refined.glb", expect.objectContaining({}));
  });

  it("reports missing configuration and provider failures", async () => {
    await expect(new Meshy3DGenerator(() => ({ apiKey: "", apiUrl: "https://api.meshy.ai" })).generate({
      image: { mediaType: "image/jpeg", data: "aW1hZ2U=" },
    })).rejects.toMatchObject({ message: "3D generation is not configured", statusCode: 503 });

    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ result: "task-1" }))
      .mockResolvedValueOnce(Response.json({ status: "FAILED", task_error: { message: "Could not make mesh" } }));
    await expect(new Meshy3DGenerator(() => ({ apiKey: "secret", apiUrl: "https://api.meshy.ai" }), request, 0).generate({
      image: { mediaType: "image/png", data: "aW1hZ2U=" },
    })).rejects.toEqual(new Model3DGenerationError("Could not make mesh", 400));
  });

  it("reports a stable timeout while polling", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ result: "task-1" }))
      .mockResolvedValue(Response.json({ status: "IN_PROGRESS" }));
    const generator = new Meshy3DGenerator(
      () => ({ apiKey: "secret", apiUrl: "https://api.meshy.ai" }),
      request,
      20,
      1,
    );

    await expect(generator.generate({ image: { mediaType: "image/png", data: "aW1hZ2U=" } }))
      .rejects.toEqual(new Model3DGenerationError("3D generation timed out", 504));
  });

  it("rejects oversized GLB downloads", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ result: "task-1" }))
      .mockResolvedValueOnce(Response.json({ status: "SUCCEEDED", model_urls: { glb: "https://cdn.example/model.glb" } }))
      .mockResolvedValueOnce(new Response("", { headers: { "content-length": String(101 * 1024 * 1024) } }));
    const generator = new Meshy3DGenerator(() => ({ apiKey: "secret", apiUrl: "https://api.meshy.ai" }), request, 0);

    await expect(generator.generate({ image: { mediaType: "image/png", data: "aW1hZ2U=" } }))
      .rejects.toThrow("larger than 100 MB");
  });

  it("uses updated settings without rebuilding the generator", async () => {
    let configuration = { apiKey: "first", apiUrl: "https://first.example" };
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ result: "task-1" }))
      .mockResolvedValueOnce(Response.json({ status: "SUCCEEDED", model_urls: { glb: "https://cdn.example/one.glb" } }))
      .mockResolvedValueOnce(new Response("one"))
      .mockResolvedValueOnce(Response.json({ result: "task-2" }))
      .mockResolvedValueOnce(Response.json({ status: "SUCCEEDED", model_urls: { glb: "https://cdn.example/two.glb" } }))
      .mockResolvedValueOnce(new Response("two"));
    const generator = new Meshy3DGenerator(() => configuration, request, 0);

    await generator.generate({ image: { mediaType: "image/png", data: "aW1hZ2U=" } });
    configuration = { apiKey: "second", apiUrl: "https://second.example" };
    await generator.generate({ image: { mediaType: "image/png", data: "aW1hZ2U=" } });

    expect(request.mock.calls[0]?.[0]).toBe("https://first.example/openapi/v1/image-to-3d");
    expect(request.mock.calls[3]?.[0]).toBe("https://second.example/openapi/v1/image-to-3d");
    expect((request.mock.calls[3]?.[1] as RequestInit).headers).toMatchObject({ authorization: "Bearer second" });
  });
});
