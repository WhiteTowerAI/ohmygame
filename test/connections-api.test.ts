import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";
it("migrates connections to Plugins and retires the separate Connections API", async () => {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-connections-api-"),
  );
  const piAgentDirectory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-connections-agent-"),
  );
  await writeFile(
    path.join(piAgentDirectory, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        imported: { url: "https://example.com/mcp", disabled: true },
      },
    }),
  );
  const app = createApp({ dataDirectory, piAgentDirectory });
  try {
    await app.ready();
    expect(
      (await app.inject({ method: "GET", url: "/settings/connections" }))
        .statusCode,
    ).toBe(404);
    const catalog = (
      await app.inject({ method: "GET", url: "/plugins" })
    ).json();
    const plugin = catalog.plugins.find(
      (p: { displayName: string }) => p.displayName === "imported",
    );
    expect(plugin).toMatchObject({
      installed: true,
      enabled: false,
      mcpServerCount: 1,
    });
    expect(
      JSON.parse(
        await readFile(
          path.join(piAgentDirectory, "mcp.json.pre-plugins.bak"),
          "utf8",
        ),
      ).mcpServers.imported.disabled,
    ).toBe(true);
  } finally {
    await app.close();
  }
});
