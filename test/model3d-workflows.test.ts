import { ProjectManager } from "../src/daemon/projects.js";
import { CanvasStore } from "../src/daemon/canvas-workspace.js";
import { readCanvasAssets } from "../src/daemon/canvas-assets.js";
import { mkdir, mkdtemp, readdir, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { MeshyProvider } from "../src/daemon/meshy-provider.js";
import { TripoProvider } from "../src/daemon/tripo-provider.js";
import { Hyper3DProvider } from "../src/daemon/hyper3d-provider.js";
import { ProviderModels3D } from "../src/daemon/provider-models3d.js";
import { model3DJournal } from "../src/daemon/model3d-journal.js";
import { inspectModel3D, modelFacingPositiveZ } from "../src/daemon/model3d-inspect.js";
import { ToolRunner } from "../src/daemon/tools.js";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { MODEL_3D_PRESETS } from "../src/shared/model3d-presets.js";
import { normalizeModelUsages } from "../src/shared/custom-models.js";
import { normalizeCustomProviderModel } from "../src/daemon/provider-model-settings.js";
import type { CustomProviderDetails } from "../src/shared/contracts.js";
import { MODEL3D_CONNECTION_ID } from "../src/shared/model3d-operations.js";
import { resolveModel3DConnection } from "../src/shared/generation-config.js";
import { TEST_GLB, model3DFixture } from "./model3d-fixture.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function directory() { const value = await mkdtemp(path.join(tmpdir(), "ohmygame-3d-workflows-")); directories.push(value); return value; }
const meshyModel = { provider: "meshy", id: "meshy-t2" }, tripoModel = { provider: "tripo", id: "P1-20260311" };
const image = { mediaType: "image/png" as const, data: "aW1hZ2U=" };
const artifact = "https://files.test/result.glb";

function meshyService() {
  let taskNumber = 0;
  return vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === artifact) return new Response(new Uint8Array(TEST_GLB));
    if (String(url).endsWith("/animations/library")) return Response.json([{ action_id: 0, name: "Idle" }]);
    if (String(url).endsWith("/balance")) return Response.json({ balance: 123 });
    if (init?.method === "POST") return Response.json({ result: `meshy-${++taskNumber}` });
    return Response.json({ id: String(url).split("/").at(-1), expires_at: Date.now() + 72 * 60 * 60_000,
      status: "SUCCEEDED", model_urls: { glb: artifact }, result: { animation_glb_url: artifact } });
  });
}
function tripoService(bytes = TEST_GLB, rigType = "biped") {
  let taskNumber = 0, uploadNumber = 0;
  const endpoints = new Map<string, string>();
  return vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url);
    if (target === artifact) return new Response(new Uint8Array(bytes));
    if (target.endsWith("/files")) return Response.json({ code: 0, data: { file_token: `file-${++uploadNumber}` } });
    if (target.endsWith("/account/balance")) return Response.json({ code: 0, data: { balance: 80, frozen: 10 } });
    if (init?.method === "POST") { const id = `task-${++taskNumber}`; endpoints.set(id, target); return Response.json({ code: 0, data: { task_id: id } }); }
    const id = target.split("/").at(-1)!;
    return Response.json({ code: 0, data: { status: "success", output: endpoints.get(id)?.endsWith("rig-check") ? { riggable: true, rig_type: rigType } : { model_url: artifact } } });
  });
}
function hyperService() {
  return vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url);
    if (target === artifact) return new Response(new Uint8Array(TEST_GLB));
    if (target.endsWith("rodin") || target.endsWith("rodin_texture_only")) return Response.json({ uuid: "rodin-task", jobs: { subscription_key: "private-subscription" }, error: [] });
    if (target.endsWith("status")) return Response.json({ jobs: [{ status: "Done" }] });
    if (target.endsWith("check_balance")) return Response.json({ balance: 4.5 });
    return Response.json({ list: [{ name: "model.glb", url: artifact }] });
  });
}
const posts = (request: ReturnType<typeof meshyService>) => request.mock.calls.filter(([, init]) => init?.method === "POST");

describe("3D operation contracts", () => {
  it("uses recoverable Meshy v2 preview/refine stages and keeps compatible relay auth off downloads", async () => {
    const request = meshyService(), location = await directory();
    const provider = new MeshyProvider(() => undefined, request, 0, () => true, { baseUrl: "http://relay.test/openapi/v1", authentication: "none", headers: { "x-relay": "yes" }, settings: MODEL_3D_PRESETS.meshy[0]!.settings });
    await provider.generate({ model: { provider: "relay", id: "meshy-t2" }, images: [], operation: "text", prompt: "A knight", execution: await model3DJournal(location, "text") });
    expect(posts(request)).toHaveLength(2);
    expect(posts(request).map(([url]) => url)).toEqual(["http://relay.test/openapi/v2/text-to-3d", "http://relay.test/openapi/v2/text-to-3d"]);
    expect(JSON.parse(String(posts(request)[0]![1]!.body))).toMatchObject({ mode: "preview", model_type: "smart-topology", prompt: "A knight" });
    expect(JSON.parse(String(posts(request)[1]![1]!.body))).toMatchObject({ mode: "refine", preview_task_id: "meshy-1" });
    expect(new Headers(posts(request)[0]![1]!.headers).has("authorization")).toBe(false);
    expect(request.mock.calls.at(-1)![1]!.headers).toBeUndefined();
  });
  it("routes Meshy relay libraries and rig status through the configured endpoint", async () => {
    const request = meshyService();
    const provider = new MeshyProvider(() => "relay-key", request, 0, () => true, { baseUrl: "https://relay.test/v1" });
    expect(await provider.animations()).toMatchObject([{ id: 0, name: "Idle" }]);
    await provider.animate({ model: TEST_GLB, actionIds: [0] });
    expect(request.mock.calls.filter(([url]) => String(url) !== artifact).every(([url]) => String(url).startsWith("https://relay.test/v1/"))).toBe(true);
  });
  it("generates Tripo text without uploading images and uses a separate texture model version", async () => {
    const request = tripoService(), provider = new TripoProvider(() => "key", request, 0);
    await provider.generate({ model: tripoModel, operation: "text", prompt: "A stone tower", images: [] });
    expect(posts(request)[0]![0]).toBe("https://openapi.tripo3d.ai/v3/generation/text-to-model");
    request.mockClear();
    await provider.generate({ model: tripoModel, operation: "retexture", source: TEST_GLB, prompt: "Mossy stone", images: [], options: { textureModel: "v3.5-20260815", textureQuality: "fast" } });
    const body = JSON.parse(String(request.mock.calls.find(([url]) => String(url).endsWith("/models/texture"))![1]!.body));
    expect(body).toMatchObject({ model: "v3.5-20260815", input: expect.stringMatching(/^file-/), texture_prompt: { text: "Mossy stone" }, texture_quality: "fast" });
  });
  it("bakes multiple Tripo clips after rig-check and refuses Meshy IDs before uploading", async () => {
    const bytes = await model3DFixture({ rigged: true, clips: ["Idle", "Walk"] }), request = tripoService(bytes);
    const provider = new TripoProvider(() => "key", request, 0);
    await expect(provider.animate({ model: TEST_GLB, actionIds: [0] })).rejects.toThrow("selected Tripo rig");
    expect(request).not.toHaveBeenCalled();
    const result = await provider.animate({ model: TEST_GLB, actionIds: ["preset:biped:idle", "preset:biped:walk"], options: { animateInPlace: true } });
    expect((await inspectModel3D(result.bytes)).animations).toEqual(["Idle", "Walk"]);
    const retarget = JSON.parse(String(request.mock.calls.find(([url]) => String(url).endsWith("/animations/retarget"))![1]!.body));
    expect(retarget).toMatchObject({ out_format: "glb", bake_animation: true, export_with_geometry: true, animate_in_place: true });
    expect(posts(request).map(([url]) => String(url).split("/v3/")[1])).toEqual(["files", "animations/rig-check", "animations/rig", "animations/retarget"]);
  });
  it("uses creature version/type presets and stops when rig-check finds another rig type", async () => {
    const request = tripoService(TEST_GLB, "quadruped"), provider = new TripoProvider(() => "key", request, 0);
    const options = { rigModel: "v2.5-20260210" as const, rigType: "quadruped" as const };
    expect(await provider.animations(undefined, undefined, options)).toMatchObject([{ id: "preset:quadruped:walk" }]);
    await provider.animate({ model: TEST_GLB, actionIds: ["preset:quadruped:walk"], options });
    request.mockClear();
    await expect(provider.animate({ model: TEST_GLB, actionIds: ["preset:biped:idle"] })).rejects.toThrow("quadruped");
    expect(request.mock.calls.some(([url]) => String(url).endsWith("/animations/rig"))).toBe(false);
  });
  it("sends the required singular Hyper3D image/model fields and text prompts without images", async () => {
    const request = hyperService(), provider = new Hyper3DProvider(() => "key", request, 0), model = { provider: "hyper3d", id: MODEL_3D_PRESETS.hyper3d[0]!.id };
    await provider.generate({ model, operation: "retexture", images: [image], source: TEST_GLB, prompt: "Gold", pbr: true });
    const form = posts(request)[0]![1]!.body as FormData;
    expect(form.get("image")).toBeInstanceOf(Blob); expect(form.get("model")).toBeInstanceOf(Blob);
    expect(form.get("material")).toBe("PBR"); expect(form.get("prompt")).toBe("Gold");
    expect(form.has("images") || form.has("tier") || form.has("quality_override")).toBe(false);
    request.mockClear();
    await provider.generate({ model, operation: "text", images: [], prompt: "A tree" });
    expect((posts(request)[0]![1]!.body as FormData).get("prompt")).toBe("A tree");
    request.mockClear();
    await expect(provider.generate({ model, operation: "retexture", images: [], source: TEST_GLB, prompt: "Gold" })).rejects.toThrow("one reference image");
    expect(request).not.toHaveBeenCalled();
  });
  it("uses remesh operation versions and triangle GLB output constraints", async () => {
    const meshy = meshyService(), tripo = tripoService();
    await new MeshyProvider(() => "key", meshy, 0).generate({ model: meshyModel, operation: "remesh", source: TEST_GLB, images: [], targetPolycount: 1000 });
    await new TripoProvider(() => "key", tripo, 0).generate({ model: tripoModel, operation: "remesh", source: TEST_GLB, images: [], targetPolycount: 300_000 });
    expect(JSON.parse(String(posts(meshy)[0]![1]!.body))).toMatchObject({ topology: "triangle", target_formats: ["glb"] });
    expect(JSON.parse(String(posts(tripo).at(-1)![1]!.body))).toMatchObject({ model: "v3.0", face_limit: 300_000, quad: false, bake: true });
    await new MeshyProvider(() => "key", meshy, 0).generate({ model: meshyModel, operation: "remesh", source: TEST_GLB, images: [] });
    await new TripoProvider(() => "key", tripo, 0).generate({ model: tripoModel, operation: "remesh", source: TEST_GLB, images: [] });
    expect(JSON.parse(String(posts(meshy).at(-1)![1]!.body))).toMatchObject({ target_polycount: 30_000 });
    expect(JSON.parse(String(posts(tripo).at(-1)![1]!.body))).toMatchObject({ face_limit: 30_000 });
  });
  it("queries the three own-key balances", async () => {
    expect(await new MeshyProvider(() => "key", meshyService(), 0).accountBalance()).toEqual({ balance: 123 });
    expect(await new TripoProvider(() => "key", tripoService(), 0).accountBalance()).toEqual({ balance: 80, frozen: 10 });
    expect(await new Hyper3DProvider(() => "key", hyperService(), 0).accountBalance()).toEqual({ balance: 4.5 });
  });
});

describe("durable 3D tasks and asset preflight", () => {
  it.each(["meshy", "tripo", "hyper3d"] as const)("resumes %s downloads after recreating the journal without new paid submissions", async (protocol) => {
    const location = await directory();
    const request = protocol === "meshy" ? meshyService() : protocol === "tripo" ? tripoService() : hyperService();
    const original = request.getMockImplementation()!; let failed = false;
    request.mockImplementation(async (url, init) => { if (String(url) === artifact && !failed) { failed = true; return new Response("offline", { status: 503 }); } return original(url, init); });
    const provider = protocol === "meshy" ? new MeshyProvider(() => "key", request, 0) : protocol === "tripo" ? new TripoProvider(() => "key", request, 0) : new Hyper3DProvider(() => "key", request, 0);
    const model = { provider: protocol, id: MODEL_3D_PRESETS[protocol][0]!.id }, input = { model, images: [image] };
    await expect(provider.generate({ ...input, execution: await model3DJournal(location, "recovery") })).rejects.toThrow("download failed");
    const before = posts(request).filter(([url]) => !String(url).endsWith("/status") && !String(url).endsWith("/download")).length;
    const result = await provider.generate({ ...input, execution: await model3DJournal(location, "recovery") });
    expect(result.bytes).toEqual(TEST_GLB);
    expect(posts(request).filter(([url]) => !String(url).endsWith("/status") && !String(url).endsWith("/download"))).toHaveLength(before);
    const content = await readFile(path.join(location, "recovery.json"), "utf8");
    expect(content).not.toContain('"key"');
    expect((await stat(path.join(location, "recovery.json"))).mode & 0o777).toBe(0o600);
  });
  it("blocks an ambiguous submission and a changed connection instead of paying again", async () => {
    const location = await directory(), request = vi.fn<typeof fetch>().mockRejectedValue(new Error("lost POST response"));
    const input = { model: meshyModel, images: [image] };
    await expect(new MeshyProvider(() => "key", request, 0).generate({ ...input, execution: await model3DJournal(location, "ambiguous") })).rejects.toThrow("Could not reach");
    await expect(new MeshyProvider(() => "key", request, 0).generate({ ...input, execution: await model3DJournal(location, "ambiguous") })).rejects.toThrow("could not be confirmed");
    await expect(new MeshyProvider(() => "changed-key", request, 0).generate({ ...input, execution: await model3DJournal(location, "ambiguous") })).rejects.toThrow("connection or input changed");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("keeps a submitted rig and every animation batch across a failed download", async () => {
    const location = await directory(), bytes = await model3DFixture({ rigged: true, clips: ["Idle"] });
    const request = meshyService(), original = request.getMockImplementation()!; let fail = true;
    request.mockImplementation(async (url, init) => String(url) === artifact ? fail ? new Response("offline", { status: 503 }) : new Response(new Uint8Array(bytes)) : original(url, init));
    const input = { model: TEST_GLB, actionIds: [0] };
    await expect(new MeshyProvider(() => "key", request, 0).animate({ ...input, execution: await model3DJournal(location, "animation") })).rejects.toThrow("download failed");
    fail = false;
    expect((await new MeshyProvider(() => "key", request, 0).animate({ ...input, execution: await model3DJournal(location, "animation") })).bytes).toEqual(bytes);
    expect(posts(request)).toHaveLength(2);
  });
  it("preserves geometry, skin and clip channels when rotating Tripo +X to Meshy +Z", async () => {
    const source = await model3DFixture({ rigged: true, clips: ["Walk"] });
    const bytes = await modelFacingPositiveZ(source, "+X"), document = await new NodeIO().readBinary(bytes);
    expect(await inspectModel3D(bytes)).toMatchObject({ triangles: 1, textured: true, rigged: true, animations: ["Walk"] });
    const direction = document.getRoot().listNodes().find((node) => node.getName() === "Forward axis +Z")!.getRotation();
    expect(direction[1]).toBeCloseTo(-Math.SQRT1_2);
    expect(document.getRoot().listAnimations()[0]!.listChannels()[0]!.getTargetNode()?.getName()).toBe("Root");
    await expect(inspectModel3D(Buffer.from("not a model"))).rejects.toThrow("Invalid GLB");
  });
  it("preserves shared root membership in every scene during axis normalization", async () => {
    const io = new NodeIO(), document = await io.readBinary(await model3DFixture({ rigged: true, clips: ["Walk"] }));
    const [character, joint] = document.getRoot().listScenes()[0]!.listChildren();
    document.createScene("Shared character").addChild(character!).addChild(joint!);
    document.createScene("Character only").addChild(character!);
    const result = await io.readBinary(await modelFacingPositiveZ(Buffer.from(await io.writeBinary(document)), "+X"));
    const scenes = result.getRoot().listScenes();
    expect(scenes.map((scene) => scene.listChildren().map((parent) => parent.listChildren()[0]!.getName()))).toEqual([
      ["Character", "Root"], ["Character", "Root"], ["Character"],
    ]);
    expect(scenes[0]!.listChildren()[0]).toBe(scenes[1]!.listChildren()[0]);
    expect(scenes[0]!.listChildren()[0]).toBe(scenes[2]!.listChildren()[0]);
    expect(result.getRoot().listAnimations()[0]!.listChannels()[0]!.getTargetNode()).toBe(scenes[1]!.listChildren()[1]!.listChildren()[0]);
  });
  it("rejects untextured Meshy sources before spending and persists model metadata", async () => {
    const location = await directory(), library = new AssetLibrary(location); await library.load();
    const source = await library.add("model.glb", await model3DFixture({ textured: false }));
    const animate = vi.fn(), runner = new ToolRunner(location, { generate: vi.fn() }, { generate: vi.fn(), animate }, undefined, library); await runner.load();
    await expect(runner.run("animate-3d", { assetId: source.id, actionIds: [0] })).rejects.toThrow("textured model");
    expect(animate).not.toHaveBeenCalled();
  });
  it("reloads standalone job history and resumes the paid task on retry", async () => {
    const location = await directory(), library = new AssetLibrary(location); await library.load();
    const request = meshyService(), original = request.getMockImplementation()!; let failing = true;
    request.mockImplementation(async (url, init) => String(url).includes("/image-to-3d/meshy-") && failing ? Promise.reject(new Error("offline")) : original(url, init));
    const makeRunner = () => new ToolRunner(location, { generate: vi.fn() }, new MeshyProvider(() => "key", request, 0), undefined, library);
    const runner = makeRunner(); await runner.load(); const job = runner.start("image-to-3d", { model: meshyModel, images: [image] });
    await vi.waitFor(() => expect(runner.jobs()[0]?.status).toBe("failed")); await runner.close();
    const restarted = makeRunner(); await restarted.load(); failing = false; restarted.retryJob(job.id);
    await vi.waitFor(() => expect(restarted.jobs()[0]?.status).toBe("succeeded"));
    expect(posts(request)).toHaveLength(1);
    expect(restarted.jobs()[0]).not.toHaveProperty("recoveryId");
    expect(library.list()[0]).toMatchObject({ model3d: { triangles: 1, textured: true, forwardAxis: "+Z", provider: "meshy", operation: "image" } });
    await restarted.close();
  });
});

describe("3D jobs and persistence failures", () => {
  it("reuses a rig across tool jobs and journals the reused rig for recovery after restart", async () => {
    const location = await directory(), library = new AssetLibrary(location); await library.load();
    const source = await library.add("hero.glb", TEST_GLB);
    const request = meshyService(), service = request.getMockImplementation()!;
    let failDownload = false;
    request.mockImplementation(async (url, init) => String(url) === artifact && failDownload
      ? new Response("offline", { status: 503 }) : service(url, init));
    const makeRunner = () => new ToolRunner(location, { generate: vi.fn() }, new MeshyProvider(() => "key", request, 0), undefined, library);
    const runner = makeRunner(); await runner.load();
    await runner.run("animate-3d", { assetId: source.id, actionIds: [0], heightMeters: 1.6 });
    failDownload = true;
    const second = runner.start("animate-3d", { assetId: source.id, actionIds: [30], heightMeters: 1.6 });
    await vi.waitFor(() => expect(runner.jobs()[0]?.status).toBe("failed")); await runner.close();
    const restarted = makeRunner(); await restarted.load(); failDownload = false; restarted.retryJob(second.id);
    await vi.waitFor(() => expect(restarted.jobs()[0]?.status).toBe("succeeded")); await restarted.close();
    expect(posts(request).filter(([url]) => String(url).endsWith("/rigging"))).toHaveLength(1);
    const animationBodies = posts(request).filter(([url]) => String(url).endsWith("/animations")).map(([, init]) => JSON.parse(String(init!.body)));
    expect(animationBodies).toEqual([{ rig_task_id: "meshy-1", action_ids: [0] }, { rig_task_id: "meshy-1", action_ids: [30] }]);
  });
  it("reports history write failures without submitting generation and can retry after storage recovers", async () => {
    const location = await directory(), generate = vi.fn().mockResolvedValue({ bytes: Buffer.from("image"), mediaType: "image/png" });
    const runner = new ToolRunner(location, { generate }); await runner.load();
    const file = path.join(location, "tools", "jobs.json"); await mkdir(file);
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const job = runner.start("generate-image", { prompt: "Icon" });
      await vi.waitFor(() => { expect(runner.jobs()[0]?.status).toBe("failed"); expect(report).toHaveBeenCalled(); });
      expect(generate).not.toHaveBeenCalled();
      expect((await readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      await rm(file, { recursive: true }); runner.retryJob(job.id);
      await vi.waitFor(() => expect(runner.jobs()[0]?.status).toBe("succeeded"));
      expect(generate).toHaveBeenCalledTimes(1);
    } finally { await runner.close(); report.mockRestore(); }
  });
  it("handles cancellation and shutdown when generation history becomes unwritable", async () => {
    const location = await directory();
    const generate = vi.fn((_input: unknown, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })));
    const runner = new ToolRunner(location, { generate }); await runner.load();
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const job = runner.start("generate-image", { prompt: "Icon" });
      await vi.waitFor(() => expect(generate).toHaveBeenCalled());
      const file = path.join(location, "tools", "jobs.json"); await rm(file); await mkdir(file);
      expect(runner.cancelJob(job.id).status).toBe("cancelled");
      await vi.waitFor(() => expect(report).toHaveBeenCalled());
      await expect(runner.close()).resolves.toBeUndefined();
    } finally { await runner.close(); report.mockRestore(); }
  });
});

describe("operation capability discovery", () => {
  it.each(["meshy", "tripo", "hyper3d"] as const)("processes GLBs through the %s connection independently of geometry versions and face counts", async (provider) => {
    const location = await directory(), library = new AssetLibrary(location); await library.load();
    const source = await library.add("source.glb", TEST_GLB);
    const request = provider === "meshy" ? meshyService() : provider === "tripo" ? tripoService() : hyperService();
    const models = new ProviderModels3D({ runtime: async () => { throw new Error("Native processing needs no custom runtime"); },
      meshy: { generator: new MeshyProvider(() => "key", request, 0), configured: () => provider === "meshy" },
      tripo: { generator: new TripoProvider(() => "key", request, 0), configured: () => provider === "tripo" },
      hyper3d: { generator: new Hyper3DProvider(() => "key", request, 0), configured: () => provider === "hyper3d" },
      customProviders: async () => [], nativeModels: (id) => [...MODEL_3D_PRESETS[id]],
      isEnabled: () => true, isVisible: () => false, defaultModel: () => undefined });
    const runner = new ToolRunner(location, { generate: vi.fn() }, models, undefined, library); await runner.load();
    for (const id of [MODEL3D_CONNECTION_ID, MODEL_3D_PRESETS[provider].at(-1)!.id]) {
      const run = await runner.run("image-to-3d", { model: { provider, id }, operation: "retexture", sourceAssetId: source.id,
        images: provider === "hyper3d" ? [image] : [], ...(provider === "hyper3d" ? {} : { prompt: "Stone" }), targetPolycount: 1_200_000 });
      expect(library.get(run.files[0]!.assetId!)?.model3d).toMatchObject({ provider, operation: "retexture" });
    }
    await runner.close();
  });
  it("keeps animation available with hidden generation models and requires custom opt-in", async () => {
    const location = await directory(), runtime = await ModelRuntime.create({ authPath: path.join(location, "auth.json"), modelsPath: path.join(location, "models.json"), modelsStorePath: path.join(location, "catalog.json"), allowModelNetwork: false });
    const request = meshyService();
    const providers = new ProviderModels3D({ runtime: async () => runtime,
      meshy: { generator: new MeshyProvider(() => "key", request, 0), configured: () => true },
      tripo: { generator: new TripoProvider(() => "key", tripoService(), 0), configured: () => true },
      hyper3d: { generator: new Hyper3DProvider(() => "key", hyperService(), 0), configured: () => true },
      customProviders: async () => [], nativeModels: (provider) => [...MODEL_3D_PRESETS[provider]], isEnabled: () => true, isVisible: () => false, defaultModel: () => undefined });
    expect((await providers.catalog()).models).toHaveLength(0);
    const connections = await providers.operationModels();
    expect(connections.map(({ provider, id }) => ({ provider, id }))).toEqual([
      { provider: "meshy", id: MODEL3D_CONNECTION_ID }, { provider: "tripo", id: MODEL3D_CONNECTION_ID }, { provider: "hyper3d", id: MODEL3D_CONNECTION_ID },
    ]);
    for (const provider of ["meshy", "tripo", "hyper3d"] as const) {
      for (const definition of MODEL_3D_PRESETS[provider]) {
        const ref = { provider, id: definition.id };
        expect(resolveModel3DConnection(ref, connections)).toMatchObject({ provider, id: MODEL3D_CONNECTION_ID });
        expect(await providers.resolveOperationModel(ref, "retexture")).toMatchObject({ provider, id: MODEL3D_CONNECTION_ID });
      }
    }
    expect(await providers.resolveOperationModel({ provider: "meshy", id: MODEL3D_CONNECTION_ID }, "image")).toBeUndefined();
    expect(await providers.animations()).toMatchObject([{ id: 0, name: "Idle" }]);
    expect((await providers.animations(undefined, tripoModel))[0]!.id).toMatch(/^preset:biped:/);
    expect(await providers.resolveOperationModel(tripoModel, "animate")).toBeDefined();
    expect(await providers.resolveOperationModel({ provider: "hyper3d", id: MODEL3D_CONNECTION_ID }, "animate")).toBeUndefined();
    expect(await providers.balance(meshyModel)).toEqual({ balance: 123 });
    const settings = MODEL_3D_PRESETS.tripo[0]!.settings;
    expect(normalizeModelUsages({ "3d": { ...settings, operations: ["text", "animate", "retexture"] } })?.["3d"]?.operations).toContain("animate");
    expect(() => normalizeModelUsages({ "3d": { ...MODEL_3D_PRESETS.hyper3d[0]!.settings, operations: ["animate"] } })).toThrow();
  });
  it("reuses custom Meshy adapters and invalidates rigs when connection auth, headers or endpoints change", async () => {
    let key = "first-key", header = "first-header";
    const runtime = { hasConfiguredAuth: () => true, getAuth: async () => ({ auth: { apiKey: key, headers: { "x-studio": header } } }) } as unknown as ModelRuntime;
    const settings = { ...MODEL_3D_PRESETS.meshy[0]!.settings, operations: ["animate" as const] };
    const custom: CustomProviderDetails = { id: "studio", name: "Studio", baseUrl: "https://studio.test/v1", authentication: "api_key", api: "openai-completions",
      hiddenModelIds: ["connection"], models: [normalizeCustomProviderModel({ id: "connection", name: "Geometry", usages: { "3d": settings } }, "openai-completions", "https://studio.test/v1")] };
    const request = meshyService();
    const providers = new ProviderModels3D({ runtime: async () => runtime,
      meshy: { generator: new MeshyProvider(() => "key", request, 0), configured: () => false },
      customProviders: async () => [custom], nativeModels: (provider) => [...MODEL_3D_PRESETS[provider]],
      isEnabled: () => true, isVisible: () => false, defaultModel: () => undefined, request });
    const location = await directory(), providerModel = { provider: custom.id, id: "connection" };
    const animate = async (id: string) => providers.animate({ model: TEST_GLB, providerModel, actionIds: [0], execution: await model3DJournal(location, id) });
    await animate("first"); await animate("second");
    const rigs = () => posts(request).filter(([url]) => String(url).endsWith("/rigging"));
    expect(rigs()).toHaveLength(1);
    key = "second-key"; await animate("changed-key");
    header = "second-header"; await animate("changed-header");
    custom.baseUrl = "https://other-studio.test/v1"; await animate("changed-endpoint");
    expect(rigs()).toHaveLength(4);
    expect(rigs().at(-1)![0]).toBe("https://other-studio.test/v1/rigging");
    expect(await providers.resolveOperationModel({ provider: custom.id, id: "missing" }, "animate")).toBeUndefined();
    custom.models[0]!.usages!["3d"]!.operations = [];
    await expect(animate("disabled-operation")).rejects.toThrow("unavailable");
    expect(rigs()).toHaveLength(4);
  });
});

describe("canvas 3D recovery", () => {
  it("shares confirmed Meshy stages when a copied project retries while the original is polling", async () => {
    const location = await directory(), library = new AssetLibrary(location), projects = new ProjectManager(location, library);
    const request = meshyService(), respond = request.getMockImplementation()!;
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    let originalPolling = false, previewPolls = 0;
    request.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/text-to-3d/meshy-1") && ++previewPolls === 1) {
        originalPolling = true;
        await blocked;
      }
      return respond(url, init);
    });
    const tools = new ToolRunner(location, { generate: vi.fn() }, new MeshyProvider(() => "key", request, 0), undefined, library);
    const store = new CanvasStore(projects, library, tools);
    const phases = () => posts(request).map(([, init]) => JSON.parse(String(init!.body)).mode);
    try {
      await Promise.all([library.load(), projects.load(), tools.load()]);
      const source = await projects.create("Source", "asset-canvas");
      const boardId = (await store.workspace(source.id)).boards[0]!.id;
      const board = await store.board(source.id, boardId);
      board.board.nodes.push({ id: "model", type: "model-3d", position: { x: 0, y: 0 }, data: { operation: "text", prompt: "Tower", images: [], model: meshyModel, targetPolycount: 1000, texture: true, pbr: false } });
      board.board.editorLayout.nodes.model = { x: 0, y: 0 };
      await store.saveBoard(source.id, board.board, board.revision);
      const original = await store.generateNode(source.id, boardId, "model");
      await vi.waitFor(() => expect(originalPolling).toBe(true));
      const copy = await projects.duplicate(source.id);
      expect((await store.jobs(copy.id))[0]?.status).toBe("cancelled");
      const sourceHistory = JSON.parse(await readFile(path.join(source.workspacePath, "canvas/jobs.json"), "utf8"));
      const copyHistory = JSON.parse(await readFile(path.join(copy.workspacePath, "canvas/jobs.json"), "utf8"));
      expect(copyHistory[0].recoveryId).toBe(sourceHistory[0].recoveryId);
      await store.retry(copy.id, original.id);
      await vi.waitFor(async () => expect((await store.jobs(copy.id))[0]?.status).toBe("succeeded"));
      expect(phases()).toEqual(["preview", "refine"]);
      unblock();
      await vi.waitFor(async () => expect((await store.jobs(source.id))[0]?.status).toBe("succeeded"));
      expect(phases()).toEqual(["preview", "refine"]);
    } finally {
      unblock();
      await store.close(); await tools.close();
    }
  });

  it("resumes the original retexture task after reopening the canvas and preserves asset axis metadata", async () => {
    const location = await directory(), library = new AssetLibrary(location), projects = new ProjectManager(location, library);
    const request = meshyService(), original = request.getMockImplementation()!; let failed = true;
    request.mockImplementation(async (url, init) => String(url).includes("/retexture/meshy-") && failed ? Promise.reject(new Error("offline")) : original(url, init));
    const tools = new ToolRunner(location, { generate: vi.fn() }, new MeshyProvider(() => "key", request, 0), undefined, library);
    await Promise.all([library.load(), projects.load(), tools.load()]);
    const project = await projects.create("3D workflow", "asset-canvas"), store = new CanvasStore(projects, library, tools);
    const workspace = await store.workspace(project.id), boardId = workspace.boards[0]!.id;
    const source = await library.add("source.glb", TEST_GLB, { model3d: { triangles: 1, textured: true, rigged: false, animations: [], forwardAxis: "+X" } });
    const board = await store.board(project.id, boardId);
    board.board.nodes.push({ id: "texture", type: "model-3d", position: { x: 0, y: 0 }, data: { operation: "retexture", prompt: "Gold", source: { type: "library", assetId: source.id }, model: meshyModel, images: [], targetPolycount: 4000, texture: true, pbr: false } });
    board.board.editorLayout.nodes.texture = { x: 0, y: 0 };
    await store.saveBoard(project.id, board.board, board.revision);
    const job = await store.generateNode(project.id, boardId, "texture");
    await vi.waitFor(async () => expect((await store.jobs(project.id))[0]?.status).toBe("failed"));
    await store.close(); await tools.close(); failed = false;
    const restartedTools = new ToolRunner(location, { generate: vi.fn() }, new MeshyProvider(() => "key", request, 0), undefined, library); await restartedTools.load();
    const reopened = new CanvasStore(projects, library, restartedTools); await reopened.retry(project.id, job.id);
    await vi.waitFor(async () => expect((await reopened.jobs(project.id))[0]?.status).toBe("succeeded"));
    expect(posts(request)).toHaveLength(1);
    const output = (await reopened.board(project.id, boardId)).board.nodes.find((node) => node.id === "texture")!;
    expect("assetId" in output.data && output.data.assetId).toBeTruthy();
    const manifest = await readCanvasAssets(project.workspacePath);
    expect(Object.values(manifest.assets).some((asset) => asset.model3d?.operation === "retexture" && asset.model3d?.forwardAxis === "+X")).toBe(true);
    expect((await reopened.jobs(project.id))[0]).not.toHaveProperty("recoveryId");
    await reopened.close(); await restartedTools.close();
  });
});
