import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";

it("manages connections through the API", async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-connections-api-"));
  const piAgentDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-connections-agent-"));
  const app = createApp({ dataDirectory, piAgentDirectory });
  try {
    await app.ready();
    // The old settings page API stays retired.
    expect((await app.inject({ method: "GET", url: "/settings/connections" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/connections" })).json()).toEqual([]);

    const created = await app.inject({
      method: "POST",
      url: "/connections",
      payload: { displayName: "Tracker", definition: { url: "https://tracker.example.com/mcp", headers: { Authorization: "Bearer api-secret" } } },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: "tracker", configurationStatus: "ready" });
    const disabled = await app.inject({ method: "PATCH", url: "/connections/tracker", payload: { enabled: false } });
    expect(disabled.json()).toMatchObject({ enabled: false, status: "disabled" });
    const definition = await app.inject({ method: "GET", url: "/connections/tracker/definition" });
    expect(definition.body).not.toContain("api-secret");
    expect((await app.inject({ method: "POST", url: "/connections", payload: { displayName: "Broken", definition: { url: "ftp://x" } } })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: "/connections/tracker" })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/connections/tracker" })).statusCode).toBe(404);
  } finally {
    await app.close();
  }
});
