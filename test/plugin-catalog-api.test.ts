import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("plugin catalog API", () => {
  it("creates a visible project for each plugin authoring session", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-plugin-authoring-")) });
    apps.push(app);
    await app.ready();

    const created = await app.inject({ method: "POST", url: "/plugins/authoring-session" });
    const next = await app.inject({ method: "POST", url: "/plugins/authoring-session" });
    const { projectId, conversationId } = created.json();
    const [project, conversation, projects] = await Promise.all([
      app.inject({ method: "GET", url: `/projects/${projectId}` }),
      app.inject({ method: "GET", url: `/projects/${projectId}/conversations/${conversationId}` }),
      app.inject({ method: "GET", url: "/projects" }),
    ]);

    expect(created.statusCode).toBe(201);
    expect(next.json().projectId).not.toBe(projectId);
    expect(next.json().conversationId).not.toBe(conversationId);
    expect(project.statusCode).toBe(200);
    expect(project.json()).toMatchObject({ id: projectId, name: "New Plugin", type: "general" });
    expect(conversation.statusCode).toBe(200);
    expect(projects.json()).toHaveLength(2);
  });

  it("lists and reads OpenGame plugins without exposing Pi runtime packages", async () => {
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-plugin-catalog-")) });
    apps.push(app);
    await app.ready();

    const catalog = await app.inject({ method: "GET", url: "/plugins" });
    const detail = await app.inject({ method: "GET", url: "/plugins/opengame%3Agodot" });

    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toMatchObject({
      plugins: [
        { id: "opengame:tool:generate-image", installed: true },
        { id: "opengame:tool:image-to-3d", installed: true },
        { id: "opengame:tool:generate-video", installed: true },
        { id: "opengame:godot", installed: true },
      ],
      errors: [],
    });
    expect(detail.json()).toMatchObject({ id: "opengame:godot", connections: [{ id: "opengame-godot" }] });
  });

  it("stores the Plugin switch separately from Connection access", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-plugin-settings-api-"));
    const app = createApp({ dataDirectory });
    apps.push(app);
    await app.ready();

    const updated = await app.inject({
      method: "PUT",
      url: "/plugins/opengame%3Agodot/settings",
      payload: { enabled: false, components: { "connection:opengame-godot": true } },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ enabled: false, connections: [{ id: "opengame-godot", enabled: true }] });
  });

  it("does not turn an arbitrary Pi MCP configuration into a user Plugin", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-plugin-mcp-api-"));
    const piAgentDirectory = await mkdtemp(path.join(tmpdir(), "open-game-plugin-mcp-agent-"));
    await writeFile(path.join(piAgentDirectory, "mcp.json"), JSON.stringify({
      mcpServers: { figma: { url: "https://example.com/mcp" } },
    }));
    const app = createApp({ dataDirectory, piAgentDirectory });
    apps.push(app);
    await app.ready();

    const listed = await app.inject({ method: "GET", url: "/plugins" });

    expect(listed.json().plugins.filter((plugin: { marketplace: { id: string } }) => plugin.marketplace.id === "personal")).toEqual([]);
    expect(JSON.parse(await readFile(path.join(piAgentDirectory, "mcp.json"), "utf8"))).toMatchObject({
      mcpServers: { figma: { url: "https://example.com/mcp" } },
    });
  });
});
