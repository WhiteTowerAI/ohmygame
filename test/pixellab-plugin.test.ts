import path from "node:path";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { expect, it } from "vitest";
import { PluginMediaProviders } from "../src/daemon/plugin-media-providers.js";
import { validatePluginManifest } from "../src/shared/plugin-manifest.js";
import { migrateLegacyPixelLabNodes } from "../src/shared/pixellab-legacy.js";
import type { PluginIndexEntry } from "../src/daemon/plugin-index.js";
import type { PluginServices } from "../src/daemon/plugin-services.js";

const GIF = Buffer.from("GIF89a");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

it("packages PixelLab as an ordinary image provider and returns its official animation GIF", async () => {
  const manifest = JSON.parse(await readFile("plugins/pixellab/.ohmygame-plugin/plugin.json", "utf8"));
  expect(validatePluginManifest(manifest).ok).toBe(true);
  expect(manifest.contributes.canvasNodes).toBeUndefined();
  expect(manifest.contributes.skills).toBe("./skills/");
  expect(await readFile("plugins/pixellab/skills/pixellab-assets/SKILL.md", "utf8")).toContain("name: pixellab-assets");
  expect(manifest.longDescription).toBe("%longDescription%");
  expect(manifest.examples).toEqual(["%example.1%", "%example.2%"]);
  expect(manifest.contributes.providers[0].media.image.models.map((model: { id: string }) => model.id))
    .toEqual(["pixen", "create-character", "skeleton-animation"]);

  const entry = {
    id: manifest.id, version: manifest.version, root: path.resolve("plugins/pixellab"), digest: "test",
    strings: { en: JSON.parse(await readFile("plugins/pixellab/locales/en.json", "utf8")) }, skills: [], toolSchemas: {}, manifest,
  } as unknown as PluginIndexEntry;
  const services = { everyProject: async () => [entry], values: { secret: () => "secret" } } as unknown as PluginServices;
  const requests: Array<{ url: string; body?: unknown }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const value = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: value, body });
    if (value.endsWith("/create-image-pixen")) return Response.json({ image: { base64: `data:image/png;base64,${PNG.toString("base64")}` } });
    if (value.endsWith("/create-character-v3")) return Response.json({ character_id: "character", background_job_id: "character-job" });
    if (value.endsWith("/background-jobs/character-job") || value.endsWith("/background-jobs/animation-job")) return Response.json({ status: "completed" });
    if (value.endsWith("/characters/animations")) return Response.json({ background_job_ids: ["animation-job"], animation_group_id: "animation" });
    if (value.includes("/characters/character/gif")) return new Response(GIF, { headers: { "content-type": "image/gif" } });
    throw new Error(`Unexpected PixelLab request: ${value}`);
  }) as typeof fetch;
  const media = new PluginMediaProviders(services, fetcher);
  const models = (await media.imageProviders())[0]!.models;
  expect(models.map((model) => model.id)).toEqual(["pixen", "create-character", "skeleton-animation"]);
  const animation = models.find((model) => model.id === "skeleton-animation")!;
  const pixen = models.find((model) => model.id === "pixen")!;
  expect(animation.minReferenceImages).toBe(1);
  await expect(media.generateImage(animation, { prompt: "run in place" }))
    .rejects.toThrow("requires at least 1 reference image");

  const source = await sharp({ create: { width: 512, height: 128, channels: 4, background: "#55aacc" } }).png().toBuffer();
  await expect(media.generateImage(animation, {
    prompt: "run in place",
    images: [{ mediaType: "image/png", data: source.toString("base64") }],
  })).resolves.toEqual({ bytes: GIF, mediaType: "image/gif" });
  const characterRequest = requests.find((request) => request.url.endsWith("/create-character-v3"))!;
  const reference = (characterRequest.body as { reference_image: { base64: string } }).reference_image.base64.replace(/^data:image\/png;base64,/, "");
  await expect(sharp(Buffer.from(reference, "base64")).metadata()).resolves.toMatchObject({ width: 256, height: 64 });
  expect(requests.find((request) => request.url.endsWith("/characters/animations"))?.body).toEqual(expect.objectContaining({
    mode: "skeleton-v3", action_description: "run in place", directions: ["south"], character_id: "character",
  }));
  expect(requests.some((request) => request.url.includes("animate-with-skeleton") || (JSON.stringify(request.body) ?? "").includes("keypoints"))).toBe(false);

  await expect(media.generateImage(pixen, { prompt: "a potion", resolution: "512", aspectRatio: "1:1" })).resolves.toEqual({ bytes: PNG, mediaType: "image/png" });
  expect(requests.find((request) => request.url.endsWith("/create-image-pixen"))?.body).toEqual(expect.objectContaining({ image_size: { width: 512, height: 512 } }));
});

it("migrates the retired PixelLab generation nodes to image nodes", () => {
  const migrated = migrateLegacyPixelLabNodes({ nodes: [{
    id: "animation", type: "plugin", position: { x: 10, y: 20 },
    data: { node: "ohmygame/pixellab:skeleton-animation", params: { action: "run in place" }, inputs: { reference: [{ nodeId: "hero" }] }, assetId: "result" },
  }] });
  expect(migrated.migrated).toEqual(["animation"]);
  expect(migrated.value).toMatchObject({ nodes: [expect.objectContaining({
    id: "animation", type: "image", data: expect.objectContaining({
      prompt: "run in place", model: { provider: "plugin.ohmygame.pixellab.pixellab", id: "skeleton-animation" }, images: [{ nodeId: "hero" }], assetId: "result",
    }),
  })] });
});
