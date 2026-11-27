import { mkdir, mkdtemp, readdir, rm, readFile, stat, writeFile } from "node:fs/promises";
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
import { NativeModel3DRecovery } from "../src/daemon/model3d-native-recovery.js";
import type { CommittedModel3DMigration } from "../src/daemon/model3d-settings-transaction.js";
import { Model3DGenerationError } from "../src/daemon/model3d.js";
import { inspectModel3D, modelFacingPositiveZ } from "../src/daemon/model3d-inspect.js";
import { mergeAnimationClips } from "../src/daemon/merge-animations.js";
import { ToolRunner } from "../src/daemon/tools.js";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { MODEL_3D_PRESETS } from "../src/shared/model3d-presets.js";
import { model3DModel, normalizeModelUsages } from "../src/shared/custom-models.js";
import { normalizeCustomProviderModel } from "../src/daemon/provider-model-settings.js";
import type { CustomProviderDetails } from "../src/shared/contracts.js";
import { MODEL3D_CONNECTION_ID } from "../src/shared/model3d-operations.js";
import { resolveModel3DConnection } from "../src/shared/generation-config.js";
import { TEST_GLB, model3DFixture } from "./model3d-fixture.js";

describe("animation skeleton compatibility", () => {
  it.each(["transform", "parent", "duplicate-name", "bind-pose"])("rejects clips with incompatible %s despite matching bone names", async variant => {
    const first = await model3DFixture({ rigged: true, clips: ["Idle"] });
    const io = new NodeIO(), second = await io.readBinary(await model3DFixture({ rigged: true, clips: ["Walk"] }));
    const root = second.getRoot(), joint = root.listNodes().find(node => node.getName() === "Root")!;
    if (variant === "transform") joint.setTranslation([0, 2, 0]);
    if (variant === "parent") root.listScenes()[0]!.addChild(second.createNode("Different parent").addChild(joint));
    if (variant === "duplicate-name") root.listScenes()[0]!.addChild(second.createNode("Root"));
    if (variant === "bind-pose") root.listSkins()[0]!.setInverseBindMatrices(second.createAccessor().setType("MAT4").setArray(new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,5,0,0,1])).setBuffer(root.listBuffers()[0]!));
    await expect(mergeAnimationClips([first, Buffer.from(await io.writeBinary(second))])).rejects.toThrow("incompatible skeleton");
  });
});

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function directory() { const value = await mkdtemp(path.join(tmpdir(), "ohmygame-3d-workflows-")); directories.push(value); return value; }
const meshyModel = { provider: "meshy", id: "meshy-t2" }, tripoModel = { provider: "tripo", id: "P1-20260311" };
const image = { mediaType: "image/png" as const, data: "aW1hZ2U=" };
const artifact = "https://files.test/result.glb";

const migration = (source: "meshy" | "tripo" | "hyper3d"): CommittedModel3DMigration => ({
  references: { source, target: `plugin.ohmygame.${source}.${source}`, models: MODEL_3D_PRESETS[source].map(({ id }) => ({ id, operations: ["text", "image"] })) },
  recovery: { models: MODEL_3D_PRESETS[source].map(({ id, settings }) => ({ id, settings: structuredClone(settings) })), processing: { id: "connection", settings: structuredClone(MODEL_3D_PRESETS[source][0]!.settings) } },
});


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
  return vi.fn<typeof fetch>(async (url) => {
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
  it.each(["image", "text"] as const)("generates Meshy T2.5 from %s with its own face limits", async (operation) => {
    const request = meshyService(), provider = new MeshyProvider(() => "key", request, 0);
    const input = { model: { provider: "meshy", id: "meshy-t2.5" }, operation, images: operation === "image" ? [image] : [], prompt: operation === "text" ? "A knight" : undefined, texture: false };
    await provider.generate(input);
    expect(posts(request)[0]![0]).toBe(`https://api.meshy.ai/openapi/${operation === "text" ? "v2/text" : "v1/image"}-to-3d`);
    expect(JSON.parse(String(posts(request)[0]![1]!.body))).toMatchObject({ ai_model: "meshy-t2.5", model_type: "smart-topology", target_polycount: 15_000 });
    await provider.generate({ ...input, targetPolycount: 30_000 });
    expect(JSON.parse(String(posts(request).at(-1)![1]!.body))).toMatchObject({ target_polycount: 30_000 });
    request.mockClear();
    await expect(provider.generate({ ...input, targetPolycount: 30_001 })).rejects.toThrow("100 and 30000");
    await expect(provider.generate({ ...input, operation: "image", images: [image, image] })).rejects.toThrow("exactly one reference image");
    expect(request).not.toHaveBeenCalled();
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
  it.each(["v2.5-20260210", "v3.0-20260909"] as const)("uses %s creature presets and stops when rig-check finds another rig type", async (rigModel) => {
    const request = tripoService(TEST_GLB, "quadruped"), provider = new TripoProvider(() => "key", request, 0);
    const options = { rigModel, rigType: "quadruped" as const };
    expect(await provider.animations(undefined, undefined, options)).toMatchObject([{ id: "preset:quadruped:walk" }]);
    await provider.animate({ model: TEST_GLB, actionIds: ["preset:quadruped:walk"], options });
    request.mockClear();
    await expect(provider.animate({ model: TEST_GLB, actionIds: ["preset:biped:idle"] })).rejects.toThrow("quadruped");
    expect(request.mock.calls.some(([url]) => String(url).endsWith("/animations/rig"))).toBe(false);
  });
  it("runs Tripo v3 humanoid presets through the tool and rejects legacy action IDs before upload", async () => {
    const location = await directory(), library = new AssetLibrary(location); await library.load();
    const source = await library.add("hero.glb", TEST_GLB), request = tripoService();
    const provider = new TripoProvider(() => "key", request, 0);
    const providers = new ProviderModels3D({ runtime: async () => { throw new Error("Native animation needs no custom runtime"); },
      meshy: { generator: new MeshyProvider(() => undefined), configured: () => false },
      tripo: { generator: provider, configured: () => true }, customProviders: async () => [],
      nativeModels: (id) => [...MODEL_3D_PRESETS[id]], isEnabled: () => true, isVisible: () => true, defaultModel: () => undefined });
    const runner = new ToolRunner(location, { generate: vi.fn() }, providers, undefined, library); await runner.load();
    const options = { rigModel: "v3.0-20260909" as const, rigType: "biped" as const };
    try {
      expect(await provider.animations(undefined, undefined, options)).toContainEqual(expect.objectContaining({ id: "preset:walk" }));
      await runner.run("animate-3d", { assetId: source.id, model: tripoModel, actionIds: ["preset:idle", "preset:walk"], options });
      const rig = request.mock.calls.find(([url]) => String(url).endsWith("/animations/rig"))!;
      expect(JSON.parse(String(rig[1]!.body))).toMatchObject({ model: options.rigModel, rig_type: "biped", spec: "tripo", out_format: "glb" });
      const retarget = request.mock.calls.find(([url]) => String(url).endsWith("/animations/retarget"))!;
      expect(JSON.parse(String(retarget[1]!.body))).toMatchObject({ animations: ["preset:idle", "preset:walk"] });
      request.mockClear();
      await expect(provider.animate({ model: TEST_GLB, actionIds: ["preset:biped:walk"], options })).rejects.toThrow("selected Tripo rig");
      expect(request).not.toHaveBeenCalled();
    } finally { await runner.close(); }
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
    await new TripoProvider(() => "key", tripo, 0).generate({ model: tripoModel, operation: "remesh", source: TEST_GLB, images: [], targetPolycount: 20_000 });
    expect(JSON.parse(String(posts(meshy)[0]![1]!.body))).toMatchObject({ topology: "triangle", target_formats: ["glb"] });
    expect(JSON.parse(String(posts(tripo).at(-1)![1]!.body))).toMatchObject({ model: "v3.0", face_limit: 20_000, quad: false, bake: true });
    await new MeshyProvider(() => "key", meshy, 0).generate({ model: meshyModel, operation: "remesh", source: TEST_GLB, images: [] });
    await new TripoProvider(() => "key", tripo, 0).generate({ model: tripoModel, operation: "remesh", source: TEST_GLB, images: [] });
    expect(JSON.parse(String(posts(meshy).at(-1)![1]!.body))).toMatchObject({ target_polycount: 30_000 });
    expect(JSON.parse(String(posts(tripo).at(-1)![1]!.body))).toMatchObject({ face_limit: 4_000 });
    await new TripoProvider(() => "key", tripo, 0).generate({ model: tripoModel, operation: "remesh", source: TEST_GLB, images: [], targetPolycount: 500 });
    expect(JSON.parse(String(posts(tripo).at(-1)![1]!.body))).toMatchObject({ face_limit: 500 });
    tripo.mockClear();
    for (const targetPolycount of [499, 20_001, 30_000]) {
      await expect(new TripoProvider(() => "key", tripo, 0).generate({ model: tripoModel, operation: "remesh", source: TEST_GLB, images: [], targetPolycount })).rejects.toThrow("500 and 20000");
    }
    expect(tripo).not.toHaveBeenCalled();
  });
  it("queries the three own-key balances", async () => {
    expect(await new MeshyProvider(() => "key", meshyService(), 0).accountBalance()).toEqual({ balance: 123 });
    expect(await new TripoProvider(() => "key", tripoService(), 0).accountBalance()).toEqual({ balance: 80, frozen: 10 });
    expect(await new Hyper3DProvider(() => "key", hyperService(), 0).accountBalance()).toEqual({ balance: 4.5 });
  });
});

describe("durable 3D tasks and asset preflight", () => {
  it.each(["meshy", "tripo", "hyper3d"] as const)("routes fresh %s selections to the plugin while preserving native retries", async (source) => {
    const location = await directory(), record = migration(source);
    const original = { provider: source, id: record.references.models[0]!.id };
    const selected = { ...model3DModel(source, source, MODEL_3D_PRESETS[source][0]!), provider: record.references.target };
    const generate = vi.fn().mockResolvedValue({ bytes: TEST_GLB, mediaType: "model/gltf-binary" });
    const request = vi.fn<typeof fetch>(), authorize = vi.fn().mockResolvedValue("key");
    const recovery = new NativeModel3DRecovery(location, [record], authorize, request);
    const runner = new ToolRunner(location, { generate: vi.fn() }, { generate, resolveOperationModel: async () => selected }, undefined, undefined, undefined, undefined, { model3D: [record.references] }, recovery);
    const input = { model: original, images: [image] };
    try {
      await runner.run("image-to-3d", input);
      expect(generate).toHaveBeenCalledWith(expect.objectContaining({ model: { provider: record.references.target, id: original.id } }), undefined);
      expect(authorize).not.toHaveBeenCalled();
      const retry = await runner.prepare("image-to-3d", input, undefined, { hooksApplied: true });
      expect(retry).toEqual(input);
      await expect(runner.runPrepared("image-to-3d", retry, undefined, { recoveryId: "missing-original" })).rejects.toThrow("original 3D task stage is missing");
      expect(generate).toHaveBeenCalledTimes(1); expect(request).not.toHaveBeenCalled();
    } finally { await runner.close(); }
  });

  it("maps implicit fresh animation and its action catalog but retains an implicit saved owner", async () => {
    const record = migration("meshy"); record.references.processing = { id: "connection", operations: ["animate"] };
    const animations = vi.fn().mockResolvedValue([{ id: 0, name: "Idle" }]);
    const runner = new ToolRunner(await directory(), { generate: vi.fn() }, { generate: vi.fn(), animations }, undefined, undefined, undefined, undefined, { model3D: [record.references] });
    const input = { assetId: "character", actionIds: [0] }, model = { provider: record.references.target, id: "connection" };
    try {
      expect(await runner.prepare("animate-3d", input)).toEqual({ ...input, model });
      expect(await runner.prepare("animate-3d", input, undefined, { hooksApplied: true })).toEqual(input);
      await runner.animationActions();
      expect(animations).toHaveBeenCalledWith(undefined, model, undefined);
    } finally { await runner.close(); }
  });

  it("keeps malformed model selections for request validation instead of migrating them", async () => {
    const record = migration("meshy");
    record.references.processing = { id: "connection", operations: ["retexture", "remesh", "animate"] };
    const runner = new ToolRunner(await directory(), { generate: vi.fn() }, undefined, undefined, undefined, undefined, undefined, { model3D: [record.references] });
    try {
      for (const model of [null, false, 0, "", { provider: "meshy" }, { provider: "meshy", id: 1 }]) {
        for (const operation of ["image", "text", "retexture", "remesh", "animate"] as const) {
          const input = { model, operation, images: [image] };
          expect(await runner.prepare(operation === "animate" ? "animate-3d" : "image-to-3d", input as never)).toEqual(input);
        }
        await expect(runner.run("image-to-3d", { model, images: [image] } as never)).rejects.toMatchObject({ statusCode: 400 });
      }
    } finally { await runner.close(); }
  });

  it("can continue a later stage when authorization rejected it before dispatch", async () => {
    const location = await directory(), request = meshyService(), respond = request.getMockImplementation()!;
    let phase = "initial", key: string | undefined = "key";
    request.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/text-to-3d/meshy-1")) {
        if (phase === "initial") throw new Error("offline");
        if (phase === "revoked") key = undefined;
      }
      return respond(url, init);
    });
    const input = { model: meshyModel, operation: "text" as const, prompt: "Tower", images: [], texture: true, pbr: false };
    const journalDirectory = path.join(location, "tools/model3d-tasks");
    await expect(new MeshyProvider(() => "key", request, 0).generate({ ...input, execution: await model3DJournal(journalDirectory, "refinement") })).rejects.toThrow("Could not reach");
    const recovery = new NativeModel3DRecovery(location, [migration("meshy")], async () => {
      if (!key) throw new Model3DGenerationError("Plugin access revoked", 409); return key;
    }, request);
    const runner = new ToolRunner(location, { generate: vi.fn() }, { generate: vi.fn() }, undefined, undefined, undefined, undefined, {}, recovery);
    try {
      phase = "revoked";
      await expect(runner.runPrepared("image-to-3d", input, undefined, { recoveryId: "refinement" })).rejects.toThrow();
      expect(posts(request)).toHaveLength(1);
      expect(JSON.parse(await readFile(path.join(journalDirectory, "refinement.json"), "utf8"))).not.toHaveProperty("refine");
      key = "key"; phase = "restored";
      await expect(runner.runPrepared("image-to-3d", input, undefined, { recoveryId: "refinement" })).resolves.toBeDefined();
      expect(posts(request).map(([, init]) => JSON.parse(String(init?.body)).mode)).toEqual(["preview", "refine"]);
    } finally { await runner.close(); }
  });

  it("resumes a removed custom model using its original mode and defaults", async () => {
    const location = await directory(), request = meshyService(), respond = request.getMockImplementation()!;
    let failDownload = true;
    request.mockImplementation(async (url, init) => String(url) === artifact && failDownload ? new Response("offline", { status: 503 }) : respond(url, init));
    const definition = { ...structuredClone(MODEL_3D_PRESETS.meshy[2]!), id: "studio-version", name: "Studio" };
    definition.settings.polycount.default = 2000; definition.settings.defaults = { texture: false, pbr: false };
    const native = new ProviderModels3D({ runtime: vi.fn(), meshy: { generator: new MeshyProvider(() => "key", request, 0), configured: () => true }, customProviders: async () => [], nativeModels: () => [definition], isEnabled: () => true, isVisible: () => true, defaultModel: () => undefined });
    const input = { model: { provider: "meshy", id: definition.id }, images: [image] };
    const original = new ToolRunner(location, { generate: vi.fn() }, native);
    await expect(original.runPrepared("image-to-3d", input, undefined, { recoveryId: "custom" })).rejects.toThrow("download failed");
    const record = migration("meshy"); record.recovery.models.push({ id: definition.id, settings: structuredClone(definition.settings) });
    record.references.models = [...record.references.models, { id: definition.id, operations: ["text", "image"] }];
    const recovery = new NativeModel3DRecovery(location, [record], async () => "key", request);
    definition.settings.polycount.default = 3000; definition.settings.operation = "image-to-3d";
    failDownload = false;
    const current = { generate: vi.fn(), resolveOperationModel: vi.fn().mockResolvedValue(undefined) };
    const restarted = new ToolRunner(location, { generate: vi.fn() }, current, undefined, undefined, undefined, undefined, {}, recovery);
    await expect(restarted.runPrepared("image-to-3d", input, undefined, { recoveryId: "custom" })).resolves.toMatchObject({ model: input.model });
    expect(posts(request)).toHaveLength(1);
    expect(JSON.parse(String(posts(request)[0]![1]!.body))).toMatchObject({ ai_model: definition.id, target_polycount: 2000, should_texture: false });
    expect(current.generate).not.toHaveBeenCalled(); await original.close(); await restarted.close();
  });

  it.each(["cleared", "changed", "revoked-during-poll"])("refuses %s plugin credentials without falling back to a retained native key", async (mode) => {
    const location = await directory(), request = meshyService(), respond = request.getMockImplementation()!;
    const input = { model: meshyModel, images: [image] };
    request.mockImplementation(async (url, init) => String(url) === artifact ? new Response("offline", { status: 503 }) : respond(url, init));
    const directoryOfJournal = path.join(location, "tools/model3d-tasks");
    await expect(new MeshyProvider(() => "key", request, 0).generate({ ...input, execution: await model3DJournal(directoryOfJournal, "old") })).rejects.toThrow("download failed");
    let key: string | undefined = mode === "cleared" ? undefined : mode === "changed" ? "different" : "key";
    const authorize = async () => { if (!key) throw new Model3DGenerationError("Plugin access revoked", 409); return key; };
    const before = request.mock.calls.length;
    request.mockImplementation(async (url, init) => { key = undefined; return respond(url, init); });
    const recovery = new NativeModel3DRecovery(location, [migration("meshy")], authorize, request);
    const runner = new ToolRunner(location, { generate: vi.fn() }, { generate: vi.fn() }, undefined, undefined, undefined, undefined, {}, recovery);
    await expect(runner.runPrepared("image-to-3d", input, undefined, { recoveryId: "old" })).rejects.toMatchObject({ statusCode: 409 });
    expect(request.mock.calls.length - before).toBe(mode === "revoked-during-poll" ? 1 : 0);
    await runner.close();
  });

  it.each(["meshy", "tripo", "hyper3d"] as const)("resumes %s downloads after recreating the journal without new paid submissions", async (protocol) => {
    const location = await directory();
    const request = protocol === "meshy" ? meshyService() : protocol === "tripo" ? tripoService() : hyperService();
    const original = request.getMockImplementation()!; let failed = false;
    request.mockImplementation(async (url, init) => { if (String(url) === artifact && !failed) { failed = true; return new Response("offline", { status: 503 }); } return original(url, init); });
    const provider = protocol === "meshy" ? new MeshyProvider(() => "key", request, 0) : protocol === "tripo" ? new TripoProvider(() => "key", request, 0) : new Hyper3DProvider(() => "key", request, 0);
    const model = { provider: protocol, id: MODEL_3D_PRESETS[protocol][0]!.id }, input = { model, images: [image] };
    await expect(provider.generate({ ...input, execution: await model3DJournal(location, "recovery") })).rejects.toThrow("download failed");
    // Resume the same paid stages from the pre-versioning format after an upgrade.
    const journalFile = path.join(location, "recovery.json");
    const { version: _version, ...entries } = JSON.parse(await readFile(journalFile, "utf8"));
    await writeFile(journalFile, JSON.stringify(entries));
    const before = posts(request).filter(([url]) => !String(url).endsWith("/status") && !String(url).endsWith("/download")).length;
    const result = await provider.generate({ ...input, execution: await model3DJournal(location, "recovery", { requireExistingStage: true }) });
    expect(result.bytes).toEqual(TEST_GLB);
    expect(posts(request).filter(([url]) => !String(url).endsWith("/status") && !String(url).endsWith("/download"))).toHaveLength(before);
    const content = await readFile(path.join(location, "recovery.json"), "utf8");
    expect(JSON.parse(content)).toEqual({ version: 1, ...entries });
    expect(content).not.toContain('"key"');
    if (process.platform !== "win32")
      expect((await stat(path.join(location, "recovery.json"))).mode & 0o777).toBe(0o600);
  });
  it.each(["meshy", "tripo", "hyper3d"] as const)("does not start %s requests when recovery has no original stage", async (protocol) => {
    const location = await directory(), request = vi.fn<typeof fetch>();
    const provider = protocol === "meshy" ? new MeshyProvider(() => "key", request, 0) : protocol === "tripo" ? new TripoProvider(() => "key", request, 0) : new Hyper3DProvider(() => "key", request, 0);
    await expect(provider.generate({ model: { provider: protocol, id: MODEL_3D_PRESETS[protocol][0]!.id }, images: [image], execution: await model3DJournal(location, "missing", { requireExistingStage: true }) })).rejects.toMatchObject({ statusCode: 409 });
    expect(request).not.toHaveBeenCalled();
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
});

describe("3D jobs and persistence failures", () => {
  it("reuses a rig across tool jobs", async () => {
    const location = await directory(), library = new AssetLibrary(location); await library.load();
    const source = await library.add("hero.glb", TEST_GLB);
    const request = meshyService();
    const runner = new ToolRunner(location, { generate: vi.fn() }, new MeshyProvider(() => "key", request, 0), undefined, library); await runner.load();
    await runner.run("animate-3d", { assetId: source.id, actionIds: [0], heightMeters: 1.6 });
    runner.start("animate-3d", { assetId: source.id, actionIds: [30], heightMeters: 1.6 });
    await vi.waitFor(() => expect(runner.jobs()[0]?.status).toBe("succeeded")); await runner.close();
    expect(posts(request).filter(([url]) => String(url).endsWith("/rigging"))).toHaveLength(1);
    const animationBodies = posts(request).filter(([url]) => String(url).endsWith("/animations")).map(([, init]) => JSON.parse(String(init!.body)));
    expect(animationBodies).toEqual([{ rig_task_id: "meshy-1", action_ids: [0] }, { rig_task_id: "meshy-1", action_ids: [30] }]);
  });
  it("reports history write failures without submitting generation and generates again after storage recovers", async () => {
    const location = await directory(), generate = vi.fn().mockResolvedValue({ bytes: Buffer.from("image"), mediaType: "image/png" });
    const runner = new ToolRunner(location, { generate }); await runner.load();
    const file = path.join(location, "tools", "jobs.json"); await mkdir(file);
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      runner.start("generate-image", { prompt: "Icon" });
      await expect.poll(() => runner.jobs()[0]?.status).toBe("failed");
      await expect.poll(() => report.mock.calls.length).toBeGreaterThan(0);
      expect(generate).not.toHaveBeenCalled();
      expect((await readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      await rm(file, { recursive: true }); runner.start("generate-image", { prompt: "Icon" });
      await expect.poll(() => runner.jobs()[0]?.status).toBe("succeeded");
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
