import { expect, it, vi } from "vitest";
import { PixelLab } from "../src/daemon/pixellab.js";
import sharp from "sharp";

it("lists Pixen and sends pixel-art generation with the saved bearer token", async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ image: { base64: Buffer.from("pixel-art").toString("base64") } }));
  const pixelLab = new PixelLab(() => "pixel-key", request);
  const result = await pixelLab.generate({ prompt: "blue wizard", transparentBackground: true });

  expect(pixelLab.models()).toEqual(expect.arrayContaining([expect.objectContaining({ provider: "pixellab", id: "pixen", supportsReferenceImage: false })]));
  expect(result).toMatchObject({ bytes: Buffer.from("pixel-art"), mediaType: "image/png" });
  expect(request).toHaveBeenCalledWith("https://api.pixellab.ai/v2/create-image-pixen", expect.objectContaining({
    method: "POST",
    headers: expect.objectContaining({ authorization: "Bearer pixel-key" }),
  }));
  expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
    description: "blue wizard", image_size: { width: 128, height: 128 }, no_background: true,
  });
});

it("does not make a request without a configured key", async () => {
  const request = vi.fn<typeof fetch>();
  await expect(new PixelLab(() => undefined, request).generate({ prompt: "wizard" })).rejects.toMatchObject({ message: "PixelLab API key is not configured", statusCode: 503 });
  expect(request).not.toHaveBeenCalled();
});

it("packs eight directional frames into a sprite sheet", async () => {
  const source = await fixturePng(32, 32);
  const frame = await fixturePng(16, 16);
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ background_job_id: "job" }))
    .mockResolvedValueOnce(Response.json({ status: "completed", last_response: { images: Array.from({ length: 8 }, () => ({ base64: frame.toString("base64") })) } }));
  const result = await new PixelLab(() => "pixel-key", request).generate({
    prompt: "a wizard", imageModel: { provider: "pixellab", id: "8-rotations-v3" }, images: [{ mediaType: "image/png", data: source.toString("base64") }], transparentBackground: true,
  });

  expect(request).toHaveBeenCalledWith("https://api.pixellab.ai/v2/generate-8-rotations-v3", expect.anything());
  expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({ description: "a wizard", no_background: true });
  await expect(sharp(result.bytes).metadata()).resolves.toMatchObject({ width: 64, height: 32 });
});

it("keeps the inspected skeleton as reusable rig data", async () => {
  const source = await fixturePng(32, 32);
  const request = vi.fn<typeof fetch>(async () => Response.json({ keypoints: [{ label: "head", x: 0.5, y: 0.2, z_index: 1 }] }));
  const result = await new PixelLab(() => "pixel-key", request).generate({
    prompt: "", imageModel: { provider: "pixellab", id: "estimate-skeleton" }, images: [{ mediaType: "image/png", data: source.toString("base64") }],
  });

  expect(request).toHaveBeenCalledWith("https://api.pixellab.ai/v2/estimate-skeleton", expect.anything());
  await expect(sharp(result.bytes).metadata()).resolves.toMatchObject({ width: 32, height: 32 });
  expect(result.skeleton).toEqual({ keypoints: [{ label: "head", x: 0.5, y: 0.2, zIndex: 1 }] });
});

it("returns Pixel Animation frames as individual images", async () => {
  const source = await fixturePng(32, 32);
  const frame = await fixturePng(16, 16);
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ background_job_id: "job" }))
    .mockResolvedValueOnce(Response.json({ status: "completed", last_response: { images: Array.from({ length: 3 }, () => ({ base64: frame.toString("base64") })) } }));
  const result = await new PixelLab(() => "pixel-key", request).generate({
    prompt: "walk", imageModel: { provider: "pixellab", id: "animate-v3" }, images: [{ mediaType: "image/png", data: source.toString("base64") }],
  });

  expect(result.bytes).toEqual(frame);
  expect(result.additionalImages).toHaveLength(2);
});

function fixturePng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: "#ff00ff" } }).png().toBuffer();
}
