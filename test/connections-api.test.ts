import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";

it("moves the old mcp.json servers to Connections and manages them there", async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-connections-api-"));
  const piAgentDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-connections-agent-"));
  await writeFile(
    path.join(piAgentDirectory, "mcp.json"),
    JSON.stringify({ mcpServers: { imported: { url: "https://example.com/mcp", disabled: true } } }),
  );
  const app = createApp({ dataDirectory, piAgentDirectory });
  try {
    await app.ready();
    // The old settings page API stays retired.
    expect((await app.inject({ method: "GET", url: "/settings/connections" })).statusCode).toBe(404);
    expect(JSON.parse(await readFile(path.join(piAgentDirectory, "mcp.json.pre-plugins.bak"), "utf8")).mcpServers.imported.disabled).toBe(true);

    // It is a connection now, no longer listed as a plugin.
    const catalog = (await app.inject({ method: "GET", url: "/plugins" })).json();
    expect(catalog.plugins.some((p: { displayName: string }) => p.displayName === "imported")).toBe(false);
    expect((await app.inject({ method: "GET", url: "/connections" })).json()).toEqual([
      expect.objectContaining({ id: "imported", displayName: "imported", transport: "http", enabled: false, status: "disabled" }),
    ]);
    const enabled = await app.inject({ method: "PATCH", url: "/connections/imported", payload: { enabled: true } });
    expect(enabled.json()).toMatchObject({ enabled: true, status: "enabled" });

    const created = await app.inject({
      method: "POST",
      url: "/connections",
      payload: { displayName: "Tracker", definition: { url: "https://tracker.example.com/mcp", headers: { Authorization: "Bearer api-secret" } } },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: "tracker", configurationStatus: "ready" });
    const definition = await app.inject({ method: "GET", url: "/connections/tracker/definition" });
    expect(definition.body).not.toContain("api-secret");
    expect((await app.inject({ method: "POST", url: "/connections", payload: { displayName: "Broken", definition: { url: "ftp://x" } } })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: "/connections/tracker" })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/connections/tracker" })).statusCode).toBe(404);
  } finally {
    await app.close();
  }
});
