import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("Connections API", () => {
  it("manages mcp.json Connections through one API", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-connections-api-data-")),
      piAgentDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-connections-api-agent-")),
    });
    apps.push(app);
    await app.ready();

    const created = await app.inject({
      method: "POST",
      url: "/settings/connections",
      payload: { id: "context7", transport: { type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"] } },
    });
    const disabled = await app.inject({ method: "PATCH", url: "/settings/connections/context7/enabled", payload: { enabled: false } });
    const listed = await app.inject({ method: "GET", url: "/settings/connections" });
    const removed = await app.inject({ method: "DELETE", url: "/settings/connections/context7" });

    expect(created.statusCode).toBe(201);
    expect(disabled.statusCode).toBe(204);
    expect(listed.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "ohmygame-godot", source: "preset", enabled: true }),
      expect.objectContaining({ id: "context7", source: "user", enabled: false }),
    ]));
    expect(removed.statusCode).toBe(204);
  });

  it("rejects malformed definitions and protected preset mutations", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-connections-api-data-")),
      piAgentDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-connections-api-agent-")),
    });
    apps.push(app);
    await app.ready();

    const malformed = await app.inject({
      method: "POST",
      url: "/settings/connections",
      payload: { id: "invalid", transport: { type: "stdio", args: [] } },
    });
    const protectedPreset = await app.inject({ method: "DELETE", url: "/settings/connections/ohmygame-godot" });

    expect(malformed.statusCode).toBe(400);
    expect(protectedPreset.statusCode).toBe(400);
  });
});
