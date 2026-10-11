import { describe, expect, it, vi } from "vitest";
import { Hyper3DProvider } from "../src/daemon/hyper3d-provider.js";
import { model3DModel } from "../src/shared/custom-models.js";
import { MODEL_3D_PRESETS } from "../src/shared/model3d-presets.js";

const image = { mediaType: "image/png" as const, data: "aW1hZ2U=" };
const definition = MODEL_3D_PRESETS.hyper3d[0]!;
const input = { model: { provider: "hyper3d", id: definition.id }, images: [image] };
function fixture(options: { submitted?: Response; artifact?: string } = {}) {
  const request = vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith("/rodin")) return options.submitted ?? Response.json({ uuid: "task", jobs: { subscription_key: "task-secret" } }, { status: 201 });
    if (String(url).endsWith("/status")) return Response.json({ jobs: [{ status: "Done" }] });
    if (String(url).endsWith("/download")) return Response.json({ list: [{ name: "result.glb", url: options.artifact ?? "https://files.test/result.glb" }] });
    return new Response(Buffer.from("glb"));
  });
  return { request, provider: new Hyper3DProvider(() => "own-test-key", request, 0) };
}
describe("Hyper3D own-key generation", () => {
  it("uses the saved tier and defaults, accepts five unordered references and keeps keys off downloads", async () => {
    const { request, provider } = fixture();
    const result = await provider.generate({ ...input, images: Array.from({ length: 5 }, () => image) }, undefined,
      { ...definition.settings, polycount: { ...definition.settings.polycount, default: 1_200 }, defaults: { texture: false, pbr: false } });
    expect(result).toMatchObject({ mediaType: "model/gltf-binary", requestId: "task" });
    expect(result.bytes.toString()).toBe("glb");
    const form = request.mock.calls[0]![1]!.body as FormData;
    expect(Object.fromEntries([...form].filter(([key]) => key !== "images"))).toEqual({ tier: "Gen-2.5-Medium", texture_mode: "medium", geometry_file_format: "glb", mesh_mode: "Raw", quality_override: "1200", material: "None" });
    expect(form.getAll("images")).toHaveLength(5);
    expect(form.has("image_labels")).toBe(false);
    expect(new Headers(request.mock.calls[0]![1]!.headers).get("authorization")).toBe("Bearer own-test-key");
    expect(request.mock.calls.at(-1)![1]!.headers).toBeUndefined();
  });
  it("supports a custom Hyper3D relay without forcing authentication or replacing its model alias", async () => {
    const { request } = fixture();
    const provider = new Hyper3DProvider(() => undefined, request, 0, () => true, {
      baseUrl: "http://localhost:8080/api/v2", apiKey: "", authentication: "none", headers: { "x-relay": "test" }, settings: definition.settings,
    });
    await provider.generate({ ...input, model: { provider: "relay", id: "my-rodin" } });
    expect(request.mock.calls[0]![0]).toBe("http://localhost:8080/api/v2/rodin");
    expect((request.mock.calls[0]![1]!.body as FormData).get("tier")).toBe("my-rodin");
    expect(new Headers(request.mock.calls[0]![1]!.headers).has("authorization")).toBe(false);
    expect(request.mock.calls.at(-1)![1]!.headers).toBeUndefined();
  });
  it("rejects disabled, unconfigured and invalid inputs before sending any request", async () => {
    const { request, provider } = fixture();
    await expect(new Hyper3DProvider(() => "key", request, 0, () => false).generate(input)).rejects.toThrow("disabled");
    await expect(new Hyper3DProvider(() => undefined, request).generate(input)).rejects.toThrow("not configured");
    for (const value of [{ ...input, images: [] }, { ...input, images: Array.from({ length: 6 }, () => image) },
      { ...input, images: [{ ...image, mediaType: "image/webp" as const }] }, { ...input, targetPolycount: 499 },
      { ...input, model: { provider: "hyper3d", id: "not-configured-tier" } }]) {
      await expect(provider.generate(value)).rejects.toThrow();
    }
    expect(request).not.toHaveBeenCalled();
  });
  it("does not retry submissions, switch tiers or echo upstream secrets on failure", async () => {
    const { request, provider } = fixture({ submitted: Response.json({ error: "own-test-key task-secret" }, { status: 503 }) });
    await expect(provider.generate(input)).rejects.toThrow("could not accept this request");
    expect(request).toHaveBeenCalledTimes(1);
    request.mockRejectedValueOnce(new Error("socket own-test-key"));
    await expect(provider.generate(input)).rejects.toThrow("submission could not be confirmed");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("rejects artifact URLs containing credentials or insecure protocols", async () => {
    const { request, provider } = fixture({ artifact: "http://user:key@files.test/result.glb" });
    await expect(provider.generate(input)).rejects.toThrow("valid GLB artifact");
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("does not expose signed artifact credentials when a download fails", async () => {
    const { request, provider } = fixture();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (url, init) => {
      if (String(url).startsWith("https://files.test/")) throw new Error("private-download-signature");
      return original(url, init);
    });
    await expect(provider.generate(input)).rejects.toThrow("Hyper3D GLB download failed");
  });
  it("reports documented prices only for known tiers", () => {
    expect(model3DModel("hyper3d", "Hyper3D", definition).estimatedCredits).toBe(0.5);
    expect(model3DModel("hyper3d", "Hyper3D", { ...definition, id: "Gen-2.5-Extreme-High" }).estimatedCredits).toBe(1);
    expect(model3DModel("hyper3d", "Hyper3D", { ...definition, id: "Gen-2.5-Future" }).estimatedCredits).toBeUndefined();
  });
});
