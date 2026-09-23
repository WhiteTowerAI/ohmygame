import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AccountServiceClient } from "../src/daemon/account-service-client.js";

describe("AccountServiceClient", () => {
  it("exchanges the Supabase token and lists models with the account key", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: true, data: { base_url: "https://api.ohmygame.ai/v1/", api_key: "sk-account" } }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: "model-a" }, { id: "model-a" }, { id: "model-b" }] }));
    const client = new AccountServiceClient("https://account.ohmygame.ai", fetch);

    const credential = await client.credential("supabase-token");
    await expect(client.modelIds(credential)).resolves.toEqual(["model-a", "model-b"]);
    expect(fetch).toHaveBeenNthCalledWith(1, new URL("https://account.ohmygame.ai/api/credential"), expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer supabase-token" }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(2, new URL("https://api.ohmygame.ai/v1/models"), expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer sk-account" }),
    }));
  });

  it("rejects credentials that redirect model traffic to insecure external URLs", async () => {
    const client = new AccountServiceClient("https://account.ohmygame.ai", vi.fn(async () => Response.json({
      data: { base_url: "http://api.ohmygame.ai/v1", api_key: "sk-account" },
    })));

    await expect(client.credential("supabase-token")).rejects.toThrow("must use HTTPS");
  });

  it("stages and removes reference media with the signed-in account token", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-account-media-"));
    const file = path.join(directory, "reference.mp4");
    await writeFile(file, "video");
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: { id: "media.mp4", url: "https://storage.example/media.mp4" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new AccountServiceClient("https://account.ohmygame.ai", fetch);

    await expect(client.stageMedia("supabase-token", { type: "video", name: "reference.mp4", mediaType: "video/mp4", absolutePath: file }))
      .resolves.toEqual({ id: "media.mp4", url: "https://storage.example/media.mp4" });
    await client.removeMedia("supabase-token", "media.mp4");

    expect(fetch).toHaveBeenNthCalledWith(1, new URL("https://account.ohmygame.ai/api/media?media_type=video%2Fmp4"), expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer supabase-token", "content-type": "application/octet-stream" }),
      body: Buffer.from("video"),
    }));
    expect(fetch).toHaveBeenNthCalledWith(2, new URL("https://account.ohmygame.ai/api/media/media.mp4"), expect.objectContaining({ method: "DELETE" }));
  });
});
