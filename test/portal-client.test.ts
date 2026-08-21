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
});
