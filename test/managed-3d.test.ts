import { describe, expect, it, vi } from "vitest";
import { Model3DGenerationError } from "../src/daemon/model3d.js";
import { Managed3DGenerator, type Model3DSource } from "../src/daemon/managed-3d.js";

const image = { mediaType: "image/png" as const, data: "aW1hZ2U=" };

describe("managed 3D adapter", () => {
  it("creates a Meshy T2 task and downloads its authenticated GLB", async () => {
    const request = completedRequest();
    await expect(new Managed3DGenerator(source, request, 0).generate({
      images: [image], targetPolycount: 4_000, texture: true, pbr: true,
    })).resolves.toEqual({ bytes: Buffer.from([1, 2, 3]), mediaType: "model/gltf-binary", requestId: "task_public" });

    expect(body(request)).toEqual({
      model: "meshy-t2",
      input: { type: "image", images: [{ data: "data:image/png;base64,aW1hZ2U=", view: "front" }] },
      geometry: { target_face_count: 4_000, topology: "triangle" },
      material: { enabled: true, pbr: true, texture_resolution: "2k" },
      output: { formats: ["glb"] },
    });
    expect(request).toHaveBeenNthCalledWith(3, "https://api.ohmygame.test/v1/3d/generations/task_public/content", expect.objectContaining({ headers: { authorization: "Bearer secret" } }));
  });

  it("requires Meshy T2 to be available from New API", async () => {
    const unavailable = (): Model3DSource => ({ ...source(), modelIds: [] });
    await expect(new Managed3DGenerator(unavailable, vi.fn()).generate({ images: [image] })).rejects.toEqual(
      new Model3DGenerationError("Meshy T2 is not available through OhMyGame account", 503),
    );
  });

  it("requires exactly one reference image", async () => {
    const generator = new Managed3DGenerator(source, vi.fn());
    await expect(generator.generate({ images: [] })).rejects.toEqual(new Model3DGenerationError("Meshy T2 requires exactly one reference image", 400));
    await expect(generator.generate({ images: [image, image] })).rejects.toEqual(new Model3DGenerationError("Meshy T2 requires exactly one reference image", 400));
  });

  it("never sends the Account credential to an artifact on another origin", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: "task_public", status: "queued" }))
      .mockResolvedValueOnce(Response.json({ id: "task_public", status: "completed", artifacts: [{ kind: "model", format: "glb", content_url: "https://cdn.example/model.glb" }] }));
    await expect(new Managed3DGenerator(source, request, 0).generate({ images: [image] })).rejects.toEqual(new Model3DGenerationError("3D artifact URL is not trusted"));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("surfaces task failures and applies one overall timeout", async () => {
    const failed = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: "task_failed", status: "queued" }))
      .mockResolvedValueOnce(Response.json({ id: "task_failed", status: "failed", error: { message: "3D generation failed" } }));
    await expect(new Managed3DGenerator(source, failed, 0).generate({ images: [image] })).rejects.toEqual(new Model3DGenerationError("3D generation failed", 400));

    const pending = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: "task_pending", status: "queued" }))
      .mockImplementationOnce((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }));
    await expect(new Managed3DGenerator(source, pending, 0, 10).generate({ images: [image] })).rejects.toEqual(new Model3DGenerationError("3D generation timed out", 504));
  });
});

function source(): Model3DSource {
  return { baseUrl: "https://api.ohmygame.test/v1", apiKey: "secret", modelIds: ["meshy-t2"] };
}

function completedRequest() {
  return vi.fn()
    .mockResolvedValueOnce(Response.json({ id: "task_public", status: "queued" }))
    .mockResolvedValueOnce(Response.json({ id: "task_public", status: "completed", artifacts: [{ id: "artifact_public", kind: "model", format: "glb", content_url: "/v1/3d/generations/task_public/content" }] }))
    .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "model/gltf-binary" } }));
}

function body(request: ReturnType<typeof completedRequest>): unknown {
  return JSON.parse(String(request.mock.calls[0]?.[1]?.body));
}
