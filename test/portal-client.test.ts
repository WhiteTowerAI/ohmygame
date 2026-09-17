import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PortalClient } from "../src/daemon/portal-client.js";

describe("PortalClient", () => {
  it("exchanges the Supabase token and lists models with the Portal key", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: true, data: { base_url: "https://api.open-game.ai/v1/", api_key: "sk-portal" } }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: "model-a" }, { id: "model-a" }, { id: "model-b" }] }));
    const client = new PortalClient("https://portal.open-game.ai", fetch);

    const credential = await client.credential("supabase-token");
    await expect(client.modelIds(credential)).resolves.toEqual(["model-a", "model-b"]);
    expect(fetch).toHaveBeenNthCalledWith(1, new URL("https://portal.open-game.ai/api/opengame/credential"), expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer supabase-token" }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(2, new URL("https://api.open-game.ai/v1/models"), expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer sk-portal" }),
    }));
  });

  it("rejects credentials that redirect model traffic to insecure external URLs", async () => {
    const client = new PortalClient("https://portal.open-game.ai", vi.fn(async () => Response.json({
      data: { base_url: "http://api.open-game.ai/v1", api_key: "sk-portal" },
    })));

    await expect(client.credential("supabase-token")).rejects.toThrow("must use HTTPS");
  });

  it("forwards authenticated account requests without exposing the admin API", async () => {
    const fetch = vi.fn(async () => Response.json({ data: { current: null } }));
    const client = new PortalClient("https://portal.open-game.ai", fetch);
    await expect(client.subscription("supabase-token")).resolves.toEqual({ current: null });
    expect(fetch).toHaveBeenCalledWith(new URL("https://portal.open-game.ai/api/subscription"), expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer supabase-token" }),
    }));
  });

  it("stages and removes reference media with the signed-in Portal token", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "open-game-portal-media-"));
    const file = path.join(directory, "reference.mp4");
    await writeFile(file, "video");
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: { id: "media.mp4", url: "https://storage.example/media.mp4" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new PortalClient("https://portal.open-game.ai", fetch);

    await expect(client.stageMedia("supabase-token", { type: "video", name: "reference.mp4", mediaType: "video/mp4", absolutePath: file }))
      .resolves.toEqual({ id: "media.mp4", url: "https://storage.example/media.mp4" });
    await client.removeMedia("supabase-token", "media.mp4");

    expect(fetch).toHaveBeenNthCalledWith(1, new URL("https://portal.open-game.ai/api/media?media_type=video%2Fmp4"), expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer supabase-token", "content-type": "application/octet-stream" }),
      body: Buffer.from("video"),
    }));
    expect(fetch).toHaveBeenNthCalledWith(2, new URL("https://portal.open-game.ai/api/media/media.mp4"), expect.objectContaining({ method: "DELETE" }));
  });
});
