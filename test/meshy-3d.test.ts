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
      images: [
        { mediaType: "image/png", data: "ZnJvbnQ=" },
        { mediaType: "image/jpeg", data: "cmlnaHQ=" },
        { mediaType: "image/png", data: "YmFjaw==" },
        { mediaType: "image/jpeg", data: "bGVmdA==" },
      ],
      model: "meshy-7",
      quality: "ultra",
      texture: true,
      textureResolution: "4K",
      pbr: true,
      pose: "a-pose",
      imageEnhancement: false,
    });

    expect(result.bytes.toString()).toBe("glb");
    expect(result.mediaType).toBe("model/gltf-binary");
    expect(result.requestId).toBe("task-1");
    expect(request).toHaveBeenNthCalledWith(1, "https://api.meshy.ai/openapi/v1/multi-image-to-3d", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        image_urls: [
          "data:image/png;base64,ZnJvbnQ=",
          "data:image/jpeg;base64,cmlnaHQ=",
          "data:image/png;base64,YmFjaw==",
          "data:image/jpeg;base64,bGVmdA==",
        ],
        ai_model: "meshy-7",
        ultra_mode: true,
        should_texture: true,
        texture_resolution: "4k",
        enable_pbr: true,
        pose_mode: "a-pose",
        image_enhancement: false,
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
        enable_pbr: false,
        texture_resolution: "2k",
        target_formats: ["glb"],
      }),
    }));
    expect(request).toHaveBeenNthCalledWith(5, "https://cdn.example/refined.glb", expect.objectContaining({}));
  });

  it("creates a single-image Meshy T2 task with smart topology", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ result: "task-t2" }))
      .mockResolvedValueOnce(Response.json({ status: "SUCCEEDED", model_urls: { glb: "https://cdn.example/t2.glb" } }))
      .mockResolvedValueOnce(new Response("t2 glb"));
    const generator = new Meshy3DGenerator(() => ({ apiKey: "secret", apiUrl: "https://api.meshy.ai" }), request, 0);

    await generator.generate({
      images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
      model: "meshy-t2",
      targetPolycount: 4_500,
      texture: true,
      pose: "t-pose",
    });

    expect(request).toHaveBeenNthCalledWith(1, "https://api.meshy.ai/openapi/v1/image-to-3d", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        image_url: "data:image/png;base64,aW1hZ2U=",
        model_type: "smart-topology",
        ai_model: "meshy-t2",
        target_polycount: 4_500,
        should_texture: true,
        texture_resolution: "2k",
        enable_pbr: false,
        pose_mode: "t-pose",
        target_formats: ["glb"],
      }),
    }));
  });

  it("inherits Meshy T2 when refining a Text to 3D task", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ result: "preview-t2" }))
      .mockResolvedValueOnce(Response.json({ status: "SUCCEEDED", model_urls: { glb: "https://cdn.example/preview.glb" } }))
      .mockResolvedValueOnce(Response.json({ result: "refine-t2" }))
      .mockResolvedValueOnce(Response.json({ status: "SUCCEEDED", model_urls: { glb: "https://cdn.example/refined.glb" } }))
      .mockResolvedValueOnce(new Response("refined t2 glb"));
    const generator = new Meshy3DGenerator(() => ({ apiKey: "secret", apiUrl: "https://api.meshy.ai" }), request, 0);

    await generator.generate({ prompt: "A low-poly treasure chest", model: "meshy-t2", targetPolycount: 3_000 });

    expect(JSON.parse(String((request.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      mode: "preview",
      prompt: "A low-poly treasure chest",
      model_type: "smart-topology",
      ai_model: "meshy-t2",
      target_polycount: 3_000,
      pose_mode: "",
      target_formats: ["glb"],
    });
    expect(JSON.parse(String((request.mock.calls[2]?.[1] as RequestInit).body))).toEqual({
      mode: "refine",
      preview_task_id: "preview-t2",
      enable_pbr: false,
      texture_resolution: "2k",
      target_formats: ["glb"],
    });
  });

  it("reports missing configuration and provider failures", async () => {
    await expect(new Meshy3DGenerator(() => ({ apiKey: "", apiUrl: "https://api.meshy.ai" })).generate({
      images: [{ mediaType: "image/jpeg", data: "aW1hZ2U=" }],
    })).rejects.toMatchObject({ message: "3D generation is not configured", statusCode: 503 });

    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ result: "task-1" }))
      .mockResolvedValueOnce(Response.json({ status: "FAILED", task_error: { message: "Could not make mesh" } }));
    await expect(new Meshy3DGenerator(() => ({ apiKey: "secret", apiUrl: "https://api.meshy.ai" }), request, 0).generate({
      images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
    })).rejects.toEqual(new Model3DGenerationError("Could not make mesh", 400));
  });

  it("requires between one and four reference images", async () => {
    const generator = new Meshy3DGenerator(() => ({ apiKey: "secret", apiUrl: "https://api.meshy.ai" }));

    await expect(generator.generate({ images: [] }))
      .rejects.toEqual(new Model3DGenerationError("Meshy requires 1 to 4 reference images", 400));
    await expect(generator.generate({
      images: Array.from({ length: 5 }, () => ({ mediaType: "image/png" as const, data: "aW1hZ2U=" })),
    })).rejects.toEqual(new Model3DGenerationError("Meshy requires 1 to 4 reference images", 400));
  });

  it("rejects unsupported Meshy T2 options", async () => {
    const generator = new Meshy3DGenerator(() => ({ apiKey: "secret", apiUrl: "https://api.meshy.ai" }));

    await expect(generator.generate({
      images: [
        { mediaType: "image/png", data: "ZnJvbnQ=" },
        { mediaType: "image/png", data: "YmFjaw==" },
      ],
      model: "meshy-t2",
    })).rejects.toThrow("exactly one reference image");
    await expect(generator.generate({
      images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
      model: "meshy-t2",
      imageEnhancement: true,
    })).rejects.toThrow("does not support image enhancement");
    await expect(generator.generate({ prompt: "model", model: "meshy-t2", quality: "ultra" }))
      .rejects.toThrow("does not support quality modes");
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

    await expect(generator.generate({ images: [{ mediaType: "image/png", data: "aW1hZ2U=" }] }))
      .rejects.toEqual(new Model3DGenerationError("3D generation timed out", 504));
  });

  it("rejects oversized GLB downloads", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ result: "task-1" }))
      .mockResolvedValueOnce(Response.json({ status: "SUCCEEDED", model_urls: { glb: "https://cdn.example/model.glb" } }))
      .mockResolvedValueOnce(new Response("", { headers: { "content-length": String(101 * 1024 * 1024) } }));
    const generator = new Meshy3DGenerator(() => ({ apiKey: "secret", apiUrl: "https://api.meshy.ai" }), request, 0);

    await expect(generator.generate({ images: [{ mediaType: "image/png", data: "aW1hZ2U=" }] }))
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

    await generator.generate({ images: [{ mediaType: "image/png", data: "aW1hZ2U=" }] });
    configuration = { apiKey: "second", apiUrl: "https://second.example" };
    await generator.generate({ images: [{ mediaType: "image/png", data: "aW1hZ2U=" }] });

    expect(request.mock.calls[0]?.[0]).toBe("https://first.example/openapi/v1/multi-image-to-3d");
    expect(JSON.parse(String((request.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({
      enable_pbr: false,
      texture_resolution: "2k",
    });
    expect(request.mock.calls[3]?.[0]).toBe("https://second.example/openapi/v1/multi-image-to-3d");
    expect((request.mock.calls[3]?.[1] as RequestInit).headers).toMatchObject({ authorization: "Bearer second" });
  });
});
