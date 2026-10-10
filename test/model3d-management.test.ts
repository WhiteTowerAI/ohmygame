import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import type { Model3DDefinition, Model3DModel } from "../src/shared/contracts.js";
import { MODEL_3D_PRESETS } from "../src/shared/model3d-presets.js";
import { normalizeModel3DConfig, resolveModel3D } from "../src/shared/generation-config.js";
import { defaultModel3DSettings } from "../src/shared/custom-models.js";
import { normalizeCustomProviderModel } from "../src/daemon/provider-model-settings.js";

const directories: string[] = [], apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function fixture(provider: "meshy" | "tripo" | "hyper3d", directory?: string) {
  directory ??= await mkdtemp(path.join(tmpdir(), "ohmygame-model3d-management-"));
  if (!directories.includes(directory)) directories.push(directory);
  const runtime = await ModelRuntime.create({ authPath: path.join(directory, "auth.json"), modelsPath: path.join(directory, "models.json"), modelsStorePath: path.join(directory, "catalog.json"), allowModelNetwork: false });
  const request = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === "https://files.test/model.glb") return new Response(Buffer.from("glb"));
    if (provider === "hyper3d") {
      if (String(url).endsWith("/rodin")) return Response.json({ uuid: "task", jobs: { subscription_key: "task-secret" } }, { status: 201 });
      if (String(url).endsWith("/status")) return Response.json({ jobs: [{ status: "Done" }] });
      return Response.json({ list: [{ name: "model.glb", url: "https://files.test/model.glb" }] });
    }
    if (provider === "meshy") return init?.method === "POST" ? Response.json({ result: "task" }) : Response.json({ status: "SUCCEEDED", model_urls: { glb: "https://files.test/model.glb" } });
    if (String(url).endsWith("/files")) return Response.json({ code: 0, data: { file_token: "file" } });
    return init?.method === "POST" ? Response.json({ code: 0, data: { task_id: "task" } }) : Response.json({ code: 0, data: { status: "success", output: { model_url: "https://files.test/model.glb" } } });
  });
  const app = createApp({ dataDirectory: directory, piAgentDirectory: directory, createModelRuntime: async () => runtime, model3DFetch: request });
  apps.push(app);
  const root = `/settings/models/providers/${provider}/models`;
  return { app, directory, request, root };
}
async function generate(app: ReturnType<typeof createApp>, provider: string, id: string, options?: { texture?: boolean; pbr?: boolean }) {
  const result = await app.inject({ method: "POST", url: "/tools/image-to-3d/jobs", payload: { model: { provider, id }, images: [{ mediaType: "image/png", data: "aW1hZ2U=" }], ...options } });
  expect(result.statusCode, result.body).toBe(202);
  let job: { status: string; error?: string } | undefined;
  await vi.waitFor(async () => {
    job = (await app.inject("/tool-jobs")).json().find((job: { id: string }) => job.id === result.json().id);
    expect(job?.status).not.toBe("running");
  }, { timeout: 10_000 });
  return job!;
}

describe("native 3D model management", () => {
  it("adopts a newly bundled version without losing saved names, defaults, or visibility", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-preset-upgrade-")); directories.push(directory);
    const previous = { id: "meshy-6", name: "Saved Meshy 6", settings: { ...defaultModel3DSettings(),
      polycount: { ...defaultModel3DSettings().polycount, default: 1_200 }, defaults: { texture: false, pbr: false } } };
    await writeFile(path.join(directory, "model-visibility.json"), JSON.stringify({ version: 1, hidden: { meshy: [previous.id] },
      nativeModels3D: { meshy: [previous] }, defaultModel3D: { provider: "meshy", id: previous.id } }));
    const { app, root } = await fixture("meshy", directory);
    const model = (await app.inject(root)).json().models.find((model: { id: string }) => model.id === previous.id);
    expect(model).toMatchObject({ name: previous.name, visible: false, source: "preset", model3d: {
      settings: { operation: "multi-image-to-3d", maxReferenceImages: 4, polycount: { default: 1_200 }, defaults: { texture: false, pbr: false } },
    } });
    expect((await app.inject("/model3d-models/catalog")).json().defaultModel).toEqual({ provider: "meshy", id: previous.id });
    // The rebased definition is editable and can be saved again under official validation.
    expect((await app.inject({ method: "PUT", url: `${root}/${previous.id}`, payload: model.model3d })).statusCode).toBe(200);
  });
  it("accepts media model definitions without language-only token and reasoning fields", () => {
    const model = MODEL_3D_PRESETS.meshy[0]!;
    expect(normalizeCustomProviderModel({ id: model.id, name: model.name, usages: { "3d": model.settings } }, "openai-completions", "https://relay.test/v1")).toMatchObject({ usages: { "3d": model.settings }, reasoning: false, supportsImages: false });
  });
  it.each(["meshy", "tripo", "hyper3d"] as const)("runs saved %s versions and preserves visibility, defaults and model IDs after restart", async (provider) => {
    const { app, directory, request, root } = await fixture(provider);
    expect((await app.inject(root)).json()).toMatchObject({ canAddCustomModel: false, model3DProtocol: provider });
    await app.inject({ method: "PUT", url: `/settings/models/providers/${provider}`, payload: { apiKey: "native-test-key" } });
    const definition: Model3DDefinition = { ...MODEL_3D_PRESETS[provider][0]!, id: "future-version", name: "My game assets",
      settings: { ...MODEL_3D_PRESETS[provider][0]!.settings, polycount: { min: 500, max: 5_000, default: 1_200, presets: [1_200, 5_000] }, defaults: { texture: false, pbr: false } } };
    const added = await app.inject({ method: "POST", url: `${root}/custom`, payload: definition });
    expect(added.statusCode, added.body).toBe(201);
    expect(added.body).not.toContain("native-test-key");
    expect(added.json().models).toContainEqual(expect.objectContaining({ id: definition.id, visible: true, custom: true, source: "custom" }));
    expect((await app.inject({ method: "POST", url: `${root}/custom`, payload: definition })).statusCode).toBe(409);
    await app.inject({ method: "PUT", url: "/model3d-models/default", payload: { provider, id: definition.id } });
    expect(await generate(app, provider, definition.id)).toMatchObject({ status: "succeeded" });
    const submitted = request.mock.calls.find(([url, init]) => init?.method === "POST" && !String(url).endsWith("/files"));
    if (provider === "hyper3d") {
      const form = submitted?.[1]?.body as FormData;
      expect(form.get("tier")).toBe(definition.id);
      expect(form.get("quality_override")).toBe("1200");
      expect(form.get("material")).toBe("None");
    } else expect(JSON.parse(String(submitted?.[1]?.body))).toMatchObject(provider === "meshy"
      ? { ai_model: definition.id, target_polycount: 1_200, should_texture: false, enable_pbr: false }
      : { model: definition.id, face_limit: 1_200, texture: false, pbr: false });
    const sdkConfig = await readFile(path.join(directory, "models.json"), "utf8").catch(() => "");
    expect(sdkConfig).not.toContain(definition.id);
    await app.inject({ method: "PUT", url: `${root}/visibility`, payload: { ids: [definition.id], visible: false } });
    request.mockClear();
    expect((await app.inject("/model3d-models/catalog")).json().models.some((model: Model3DModel) => model.id === definition.id)).toBe(false);
    expect(await generate(app, provider, definition.id)).toMatchObject({ status: "failed" });
    expect(request).not.toHaveBeenCalled();
    await app.close();
    const restored = await fixture(provider, directory);
    const settings = (await restored.app.inject(root)).json();
    expect(settings.models).toContainEqual(expect.objectContaining({ id: definition.id, name: definition.name, visible: false, model3d: definition }));
    expect((await restored.app.inject("/model3d-models/catalog")).json().defaultModel).toEqual({ provider, id: definition.id });
    expect((await restored.app.inject({ method: "DELETE", url: `${root}/custom/${definition.id}` })).statusCode).toBe(200);
    expect((await restored.app.inject(root)).json().models).toHaveLength(MODEL_3D_PRESETS[provider].length);
  }, 15_000);

  it("edits and restores official defaults, while enforcing official capabilities and the native connection", async () => {
    const { app, root } = await fixture("meshy");
    const original = MODEL_3D_PRESETS.meshy[0]!;
    const modified = { ...original, name: "Low-poly props", settings: { ...original.settings, polycount: { ...original.settings.polycount, default: 6_000 }, defaults: { texture: false, pbr: false } } };
    expect((await app.inject({ method: "PUT", url: `${root}/${original.id}`, payload: modified })).statusCode).toBe(200);
    const edited = (await app.inject(root)).json().models.find((model: { id: string }) => model.id === original.id);
    expect(edited).toMatchObject({ source: "preset", custom: false, model3d: modified });
    for (const settings of [{ ...modified.settings, maxReferenceImages: 4 }, { ...modified.settings, baseUrl: "https://other.test" }, { ...modified.settings, polycount: { ...modified.settings.polycount, max: 300_000 } }]) {
      expect((await app.inject({ method: "PUT", url: `${root}/${original.id}`, payload: { ...modified, settings } })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "PUT", url: `${root}/${original.id}`, payload: { ...modified, id: "different" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: `${root}/custom/${original.id}` })).statusCode).toBe(400);
    await app.inject({ method: "PUT", url: `${root}/visibility`, payload: { ids: [original.id], visible: false } });
    expect((await app.inject({ method: "DELETE", url: `${root}/${original.id}/overrides` })).statusCode).toBe(200);
    expect((await app.inject(root)).json().models.find((model: { id: string }) => model.id === original.id)).toMatchObject({ visible: false, model3d: original });
  });

  it("removes saved native model definitions when deleting a connection", async () => {
    const { app, root } = await fixture("meshy");
    await app.inject({ method: "PUT", url: "/settings/models/providers/meshy", payload: { apiKey: "native-test-key" } });
    const model = { ...MODEL_3D_PRESETS.meshy[0]!, id: "my-version", name: "My version" };
    await app.inject({ method: "POST", url: `${root}/custom`, payload: model });
    await app.inject({ method: "DELETE", url: "/settings/models/providers/meshy" });
    expect((await app.inject(root)).json()).toMatchObject({ canAddCustomModel: false, models: MODEL_3D_PRESETS.meshy.map((model) => expect.objectContaining({ id: model.id, model3d: model })) });
  });

  it("uses runtime limits and defaults when Canvas normalizes a configured model", () => {
    const model: Model3DModel = { provider: "custom-studio", providerName: "Studio", id: "model", name: "Model", maxReferenceImages: 1,
      polycount: { min: 200, max: 2_000, default: 800, presets: [800] }, supportsTexture: true, supportsPbr: false, defaults: { texture: false, pbr: false } };
    expect(normalizeModel3DConfig({ model, targetPolycount: 4_000, pbr: true }, model)).toMatchObject({ targetPolycount: 800, texture: false, pbr: false });
    expect(resolveModel3D(undefined, [model])).toBe(model);
    expect(resolveModel3D(undefined, [])).toBeUndefined();
  });

  it.each(["meshy", "tripo", "hyper3d"] as const)("uses the same texture validation for a custom %s connection", async (protocol) => {
    const { app, request } = await fixture(protocol);
    const model = { ...MODEL_3D_PRESETS[protocol][0]!, id: "studio-alias",
      settings: { ...MODEL_3D_PRESETS[protocol][0]!.settings, supportsPbr: false } };
    const saved = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload: {
      name: "Studio", preset: protocol, baseUrl: "https://studio.test/v1", api: "openai-completions", authentication: "none", modelConfigurationVersion: 2,
      models: [{ id: model.id, name: model.name, usages: { "3d": model.settings } }],
    } });
    expect(saved.statusCode, saved.body).toBe(201);
    const provider = saved.json().id;
    expect(await generate(app, provider, model.id, { texture: false, pbr: true })).toMatchObject({ status: "succeeded" });
    const submitted = request.mock.calls.find(([url, init]) => init?.method === "POST" && !String(url).endsWith("/files"))!;
    if (protocol === "hyper3d") expect((submitted[1]!.body as FormData).get("material")).toBe("None");
    else expect(JSON.parse(String(submitted[1]!.body))).toMatchObject(protocol === "meshy"
      ? { should_texture: false, enable_pbr: false } : { texture: false, pbr: false });
    request.mockClear();
    expect(await generate(app, provider, model.id, { texture: true, pbr: true })).toMatchObject({ status: "failed", error: expect.stringContaining("texture options") });
    expect(request).not.toHaveBeenCalled();
  }, 15_000);
});
