import { describe, expect, it, vi } from "vitest";
import { Model3DGenerationError } from "../src/daemon/model3d.js";
import { Portal3DGenerator, type Model3DSource } from "../src/daemon/portal-3d.js";

describe("Portal 3D adapter", () => {
  it("creates a Meshy T2 task and downloads its authenticated GLB", async () => {
    const request = completedRequest();
    const generator = new Portal3DGenerator(source, request, 0);

    await expect(generator.generate({
      images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
      model: "meshy-t2",
      targetPolycount: 4_000,
      texture: true,
      pbr: true,
    })).resolves.toEqual({
      bytes: Buffer.from([1, 2, 3]),
      mediaType: "model/gltf-binary",
      requestId: "task_public",
    });

    expect(body(request)).toEqual({
      model: "meshy-t2",
      input: {
        type: "image",
        images: [{ data: "data:image/png;base64,aW1hZ2U=", view: "front" }],
      },
      geometry: { target_face_count: 4_000, topology: "triangle" },
      material: { enabled: true, pbr: true, texture_resolution: "2k" },
      output: { formats: ["glb"] },
    });
    expect(request).toHaveBeenNthCalledWith(
      3,
      "https://api.open-game.test/v1/3d/generations/task_public/content",
      expect.objectContaining({ headers: { authorization: "Bearer secret" } }),
    );
  });

  it("maps Meshy 7 text generation to one public New API task", async () => {
    const request = completedRequest();
    await new Portal3DGenerator(source, request, 0).generate({
      prompt: "  A wooden knight  ",
      model: "meshy-7",
      quality: "ultra",
      texture: true,
      textureResolution: "4K",
      pbr: true,
      pose: "t-pose",
    });

    expect(body(request)).toEqual({
      model: "meshy-7",
      quality: "ultra",
      input: { type: "text", prompt: "A wooden knight" },
      geometry: { pose: "t-pose" },
      material: { enabled: true, pbr: true, texture_resolution: "4k" },
      output: { formats: ["glb"] },
    });
  });

  it("maps 1-4 Meshy 7 views to image and images inputs", async () => {
    const request = completedRequest();
    await new Portal3DGenerator(source, request, 0).generate({
      model: "meshy-7",
      images: [
        { mediaType: "image/png", data: "ZnJvbnQ=" },
        { mediaType: "image/jpeg", data: "bGVmdA==" },
        { mediaType: "image/png", data: "YmFjaw==" },
        { mediaType: "image/jpeg", data: "cmlnaHQ=" },
      ],
      imageEnhancement: false,
      texture: false,
    });

    expect(body(request)).toMatchObject({
      model: "meshy-7",
      input: {
        type: "images",
        image_enhancement: false,
        images: [
          { data: "data:image/png;base64,ZnJvbnQ=", view: "front" },
          { data: "data:image/jpeg;base64,bGVmdA==", view: "left" },
          { data: "data:image/png;base64,YmFjaw==", view: "back" },
          { data: "data:image/jpeg;base64,cmlnaHQ=", view: "right" },
        ],
      },
      material: { enabled: false, pbr: false, texture_resolution: "2k" },
    });
  });

  it("requires the selected model to be available from New API", async () => {
    const t2Only = (): Model3DSource => ({ ...source(), modelIds: ["meshy-t2"] });
    await expect(new Portal3DGenerator(t2Only, vi.fn()).generate({
      prompt: "A chest",
      model: "meshy-7",
    })).rejects.toEqual(
      new Model3DGenerationError("Meshy 7 is not available through OpenGame Portal", 503),
    );
  });

  it("rejects model-specific invalid inputs before submitting", async () => {
    const generator = new Portal3DGenerator(source, vi.fn());
    await expect(generator.generate({
      prompt: "A chest",
      model: "meshy-t2",
    })).rejects.toEqual(
      new Model3DGenerationError("Meshy T2 requires exactly one reference image", 400),
    );
    await expect(generator.generate({
      model: "meshy-t2",
      images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
      quality: "ultra",
    })).rejects.toEqual(
      new Model3DGenerationError("Meshy T2 does not support quality modes", 400),
    );
  });

  it("never sends the Portal credential to an artifact on another origin", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: "task_public", status: "queued" }))
      .mockResolvedValueOnce(Response.json({
        id: "task_public",
        status: "completed",
        artifacts: [{ kind: "model", format: "glb", content_url: "https://cdn.example/model.glb" }],
      }));
    await expect(new Portal3DGenerator(source, request, 0).generate({
      prompt: "A chest",
    })).rejects.toEqual(new Model3DGenerationError("3D artifact URL is not trusted"));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("surfaces task failures and applies one overall timeout", async () => {
    const failed = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: "task_failed", status: "queued" }))
      .mockResolvedValueOnce(Response.json({
        id: "task_failed",
        status: "failed",
        error: { message: "3D generation failed" },
      }));
    await expect(new Portal3DGenerator(source, failed, 0).generate({
      prompt: "A chest",
    })).rejects.toEqual(new Model3DGenerationError("3D generation failed", 400));

    const pending = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: "task_pending", status: "queued" }))
      .mockImplementationOnce((_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }));
    await expect(new Portal3DGenerator(source, pending, 0, 10).generate({
      prompt: "A chest",
    })).rejects.toEqual(new Model3DGenerationError("3D generation timed out", 504));
  });
});

function source(): Model3DSource {
  return {
    baseUrl: "https://api.open-game.test/v1",
    apiKey: "secret",
    modelIds: ["meshy-7", "meshy-t2"],
  };
}

function completedRequest() {
  return vi.fn()
    .mockResolvedValueOnce(Response.json({ id: "task_public", status: "queued" }))
    .mockResolvedValueOnce(Response.json({
      id: "task_public",
      status: "completed",
      artifacts: [{
        id: "artifact_public",
        kind: "model",
        format: "glb",
        content_url: "/v1/3d/generations/task_public/content",
      }],
    }))
    .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "model/gltf-binary" },
    }));
}

function body(request: ReturnType<typeof completedRequest>): unknown {
  return JSON.parse(String(request.mock.calls[0]?.[1]?.body));
}
