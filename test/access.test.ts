import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("desktop daemon access", () => {
  it("protects health and project routes with the process token", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-access-")),
      accessToken: "desktop-secret",
    });
    apps.push(app);

    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(401);
    expect((await app.inject({
      method: "GET",
      url: "/health",
      headers: { authorization: "Bearer desktop-secret" },
    })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/projects", payload: {} })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST",
      url: "/projects",
      headers: { authorization: "Bearer desktop-secret" },
      payload: {},
    })).statusCode).toBe(201);
  });

  it("rejects incorrect bearer tokens regardless of their length", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-access-")),
      accessToken: "desktop-secret",
    });
    apps.push(app);

    for (const token of ["desktop-secrex", "short", "desktop-secret-extra"]) {
      const response = await app.inject({
        method: "GET",
        url: "/health",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(401);
    }
  });

  it("allows only the configured renderer origin", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-access-")),
      accessToken: "desktop-secret",
      allowedOrigins: ["http://127.0.0.1:43120"],
    });
    apps.push(app);

    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/projects",
      headers: { origin: "http://127.0.0.1:43120" },
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:43120");

    const rejected = await app.inject({
      method: "OPTIONS",
      url: "/projects",
      headers: { origin: "https://untrusted.example" },
    });
    expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("preserves renderer CORS headers on the event stream", async () => {
    const origin = "http://127.0.0.1:43120";
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-access-")),
      accessToken: "desktop-secret",
      allowedOrigins: [origin],
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const project = (await app.inject({
      method: "POST",
      url: "/projects",
      headers: { authorization: "Bearer desktop-secret" },
      payload: {},
    })).json();
    const controller = new AbortController();

    const response = await fetch(`${address}/projects/${project.id}/events`, {
      headers: {
        accept: "text/event-stream",
        authorization: "Bearer desktop-secret",
        origin,
      },
      signal: controller.signal,
    });

    try {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    } finally {
      await response.body?.cancel();
      controller.abort();
    }
  });
});
