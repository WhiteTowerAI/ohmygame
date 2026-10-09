import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeIO, Document } from "@gltf-transform/core";
import { describe, expect, it, vi } from "vitest";
import { MeshyProvider } from "../src/daemon/meshy-provider.js";
import { MediaProviderKeyStore } from "../src/daemon/media-provider-settings.js";

const T2 = { provider: "meshy", id: "meshy-t2" };
const MESHY_7_1 = { provider: "meshy", id: "meshy-7.1" };
const IMAGE = { mediaType: "image/png" as const, data: "aW1hZ2U=" };
const RIG_STATUS = { id: "rig-1", status: "SUCCEEDED", expires_at: Date.now() + 72 * 60 * 60_000 };

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

  it("rigs a model, then bakes the chosen actions into one animated GLB", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ result: "rig-1" }))
      .mockResolvedValueOnce(Response.json({ status: "SUCCEEDED", result: { rigged_character_glb_url: "https://files.example/rigged.glb" } }))
      .mockResolvedValueOnce(Response.json({ result: "anim-1" }))
      .mockResolvedValueOnce(Response.json({ status: "SUCCEEDED", result: { animation_glb_url: "https://files.example/animated.glb" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([9]), { status: 200 }));
    const provider = new MeshyProvider(() => "meshy-key", request, 0);

    await expect(provider.animate({ model: Buffer.from("glb"), actionIds: [0, 30], heightMeters: 1.6 }))
      .resolves.toEqual({ bytes: Buffer.from([9]), mediaType: "model/gltf-binary", requestId: "anim-1" });
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "https://api.meshy.ai/openapi/v1/rigging",
      "https://api.meshy.ai/openapi/v1/rigging/rig-1",
      "https://api.meshy.ai/openapi/v1/animations",
      "https://api.meshy.ai/openapi/v1/animations/anim-1",
      "https://files.example/animated.glb",
    ]);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({ model_url: "data:model/gltf-binary;base64,Z2xi", height_meters: 1.6 });
    expect(JSON.parse(String(request.mock.calls[2]?.[1]?.body))).toEqual({ rig_task_id: "rig-1", action_ids: [0, 30] });
  });

  it("splits large action sets across requests on one rig and merges their clips", async () => {
    const actionIds = Array.from({ length: 12 }, (_, index) => index);
    const files: Record<string, Buffer> = {
      "https://files.example/a.glb": await animatedGlb(["Idle", "Walk"]),
      "https://files.example/b.glb": await animatedGlb(["Idle", "Run"]),
    };
    const created: unknown[] = [];
    const request = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target in files) return new Response(new Uint8Array(files[target]!), { status: 200 });
      if (target.endsWith("/rigging")) return Response.json({ result: "rig-1" });
      if (target.endsWith("/rigging/rig-1")) return Response.json(RIG_STATUS);
      if (target.endsWith("/animations")) {
        created.push(JSON.parse(String(init?.body)));
        return Response.json({ result: `anim-${created.length}` });
      }
      const batch = target.endsWith("/anim-1") ? "a" : "b";
      return Response.json({ status: "SUCCEEDED", result: { animation_glb_url: `https://files.example/${batch}.glb` } });
    });
    const provider = new MeshyProvider(() => "meshy-key", request, 0);

    const result = await provider.animate({ model: Buffer.from("glb"), actionIds });

    expect(created).toEqual([
      { rig_task_id: "rig-1", action_ids: actionIds.slice(0, 10) },
      { rig_task_id: "rig-1", action_ids: actionIds.slice(10) },
    ]);
    expect(result.requestId).toBe("anim-1,anim-2");
    const merged = (await new NodeIO().readBinary(result.bytes)).getRoot();
    expect(merged.listAnimations().map((animation) => animation.getName())).toEqual(["Idle", "Walk", "Idle_2", "Run"]);
    expect(merged.listNodes()).toHaveLength(1);
    expect(merged.listAnimations().flatMap((animation) => animation.listChannels()).every((channel) => channel.getTargetNode() === merged.listNodes()[0])).toBe(true);
  });

  it("reuses a still-available rig when the same model is animated again", async () => {
    const request = vi.fn<typeof fetch>(async (url) => {
      const target = String(url);
      if (target.endsWith("/rigging")) return Response.json({ result: "rig-1" });
      if (target.endsWith("/rigging/rig-1")) return Response.json(RIG_STATUS);
      if (target.endsWith("/animations")) return Response.json({ result: "anim-1" });
      if (target.endsWith("/animations/anim-1")) return Response.json({ status: "SUCCEEDED", result: { animation_glb_url: "https://files.example/animated.glb" } });
      return new Response(new Uint8Array([9]), { status: 200 });
    });
    const provider = new MeshyProvider(() => "meshy-key", request, 0);

    await provider.animate({ model: Buffer.from("glb"), actionIds: [0], heightMeters: 1.6 });
    await provider.animate({ model: Buffer.from("glb"), actionIds: [30], heightMeters: 1.6 });
    await provider.animate({ model: Buffer.from("glb"), actionIds: [30], heightMeters: 1.8 });

    const rigCreations = request.mock.calls.filter(([url]) => String(url).endsWith("/rigging"));
    expect(rigCreations).toHaveLength(2);
    expect(request.mock.calls.filter(([url]) => String(url).endsWith("/rigging/rig-1"))).toHaveLength(3);
  });

  it("rigs again when Meshy no longer has the cached rig", async () => {
    let rigs = 0;
    let forgotten = false;
    const request = vi.fn<typeof fetch>(async (url) => {
      const target = String(url);
      if (target.endsWith("/rigging")) return Response.json({ result: `rig-${++rigs}` });
      // Meshy answers a task it no longer has with another task of the account.
      if (target.endsWith("/rigging/rig-1") && forgotten) return Response.json({ ...RIG_STATUS, id: "anim-1" });
      if (target.includes("/rigging/")) return Response.json({ ...RIG_STATUS, id: target.split("/").pop() });
      if (target.endsWith("/animations")) return Response.json({ result: "anim-1" });
      if (target.endsWith("/animations/anim-1")) return Response.json({ status: "SUCCEEDED", result: { animation_glb_url: "https://files.example/animated.glb" } });
      return new Response(new Uint8Array([9]), { status: 200 });
    });
    const provider = new MeshyProvider(() => "meshy-key", request, 0);

    await provider.animate({ model: Buffer.from("glb"), actionIds: [0] });
    forgotten = true;
    await provider.animate({ model: Buffer.from("glb"), actionIds: [0] });

    const animationBodies = request.mock.calls.filter(([url]) => String(url).endsWith("/animations")).map(([, init]) => JSON.parse(String(init?.body)));
    expect(animationBodies.map((body) => body.rig_task_id)).toEqual(["rig-1", "rig-2"]);
  });

  it("reports why Meshy could not rig a model", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ result: "rig-1" }))
      .mockResolvedValueOnce(Response.json({ status: "FAILED", task_error: { message: "Pose estimation failed" } }));
    const provider = new MeshyProvider(() => "meshy-key", request, 0);

    await expect(provider.animate({ model: Buffer.from("glb"), actionIds: [0] }))
      .rejects.toMatchObject({ message: "Pose estimation failed", statusCode: 400 });
  });

  it("lists the animation library", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json([
      { action_id: 0, name: "Idle", category: "DailyActions", sub_category: "Idle", preview_url: "https://cdn.example/idle.gif" },
      { action_id: "bad", name: "Broken" },
    ]));
    const provider = new MeshyProvider(() => "meshy-key", request, 0);

    await expect(provider.animations()).resolves.toEqual([
      { id: 0, name: "Idle", category: "DailyActions", subCategory: "Idle", previewUrl: "https://cdn.example/idle.gif" },
    ]);
    expect(request.mock.calls[0]?.[0]).toBe("https://api.meshy.ai/openapi/v1/animations/library");
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
    const settings = new MediaProviderKeyStore(directory, "meshy", "Meshy");
    await settings.load();
    expect(settings.get()).toEqual({ configured: false });

    await expect(settings.update("  meshy-key  ")).resolves.toEqual({ configured: true });
    expect(settings.key()).toBe("meshy-key");
    expect(JSON.parse(await readFile(path.join(directory, "meshy.json"), "utf8"))).toEqual({ version: 1, apiKey: "meshy-key" });

    const restored = new MediaProviderKeyStore(directory, "meshy", "Meshy");
    await restored.load();
    expect(restored.key()).toBe("meshy-key");
    await restored.clear();
    expect(restored.get()).toEqual({ configured: false });
  });
});

/** A one-bone GLB with a translation clip per name, standing in for Meshy's animation output. */
async function animatedGlb(clips: string[]): Promise<Buffer> {
  const document = new Document();
  const buffer = document.createBuffer();
  const bone = document.createNode("Hips");
  document.createScene().addChild(bone);
  for (const name of clips) {
    const sampler = document.createAnimationSampler()
      .setInput(document.createAccessor().setType("SCALAR").setArray(new Float32Array([0, 1])).setBuffer(buffer))
      .setOutput(document.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 0, 0, 1, 0])).setBuffer(buffer));
    document.createAnimation(name).addSampler(sampler)
      .addChannel(document.createAnimationChannel().setTargetNode(bone).setTargetPath("translation").setSampler(sampler));
  }
  return Buffer.from(await new NodeIO().writeBinary(document));
}
