import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("plugin catalog API", () => {
  it("installs a directory plugin enabled by default", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-plugin-install-api-"));
    const source = await mkdtemp(path.join(tmpdir(), "open-game-plugin-source-"));
    await mkdir(path.join(source, ".opengame-plugin"), { recursive: true });
    await writeFile(path.join(source, ".opengame-plugin", "plugin.json"), JSON.stringify({
      name: "test-plugin", version: "1.0.0", description: "Test plugin",
    }));
    const app = createApp({ dataDirectory });
    apps.push(app);
    await app.ready();

    const installed = await app.inject({ method: "POST", url: "/plugins/install", payload: { type: "directory", path: source } });
    const detail = await app.inject({ method: "GET", url: "/plugins/personal%3Atest-plugin" });

    expect(installed.statusCode).toBe(201);
    expect(installed.json()).toMatchObject({ id: "personal:test-plugin", source: { type: "directory" }, enabled: true });
    expect(detail.json()).toMatchObject({ id: "personal:test-plugin", enabled: true });
  });

  it("reads only a registered Skill file from an installed plugin", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-plugin-skill-api-"));
    const source = await mkdtemp(path.join(tmpdir(), "open-game-plugin-skill-source-"));
    await mkdir(path.join(source, ".opengame-plugin"), { recursive: true });
    await mkdir(path.join(source, "skills", "test"), { recursive: true });
    await writeFile(path.join(source, ".opengame-plugin", "plugin.json"), JSON.stringify({
      name: "test-plugin", version: "1.0.0", description: "Test plugin", skills: "./skills",
    }));
    const skillContent = "---\nname: test-skill\ndescription: Test workflows.\n---\n\n# Test Skill\n\nDo the thing.\n";
    await writeFile(path.join(source, "skills", "test", "SKILL.md"), skillContent);
    const app = createApp({ dataDirectory });
    apps.push(app);
    await app.ready();
    await app.inject({ method: "POST", url: "/plugins/install", payload: { type: "directory", path: source } });

    const skill = await app.inject({
      method: "GET",
      url: "/plugins/personal%3Atest-plugin/skill-content?id=skills%2Ftest%2FSKILL.md",
    });
    const skillFile = await app.inject({
      method: "GET",
      url: "/plugins/personal%3Atest-plugin/skill-file?id=skills%2Ftest%2FSKILL.md",
    });
    const capabilities = await app.inject({ method: "GET", url: "/composer/capabilities" });
    const unknown = await app.inject({
      method: "GET",
      url: "/plugins/personal%3Atest-plugin/skill-content?id=.opengame-plugin%2Fplugin.json",
    });
    const unknownFile = await app.inject({
      method: "GET",
      url: "/plugins/personal%3Atest-plugin/skill-file?id=.opengame-plugin%2Fplugin.json",
    });

    expect(skill.statusCode).toBe(200);
    expect(skill.json()).toEqual({ id: "skills/test/SKILL.md", content: skillContent });
    expect(skillFile.statusCode).toBe(200);
    expect(skillFile.json().path).toMatch(/skills[/\\]test[/\\]SKILL\.md$/);
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json().plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "personal:test-plugin", marketplaceId: "personal" }),
    ]));
    expect(capabilities.json().skills).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "test-skill",
        pluginDisplayName: "Test Plugin",
        marketplaceDisplayName: "Personal",
      }),
    ]));
    expect(unknown.statusCode).toBe(404);
    expect(unknownFile.statusCode).toBe(404);
  });

  it("inspects a Claude marketplace before installing a selected plugin", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-plugin-marketplace-api-"));
    const source = await mkdtemp(path.join(tmpdir(), "open-game-plugin-marketplace-source-"));
    await mkdir(path.join(source, ".claude-plugin"), { recursive: true });
    await mkdir(path.join(source, "skills", "godot"), { recursive: true });
    await writeFile(path.join(source, ".claude-plugin", "marketplace.json"), JSON.stringify({
      name: "game-skills",
      plugins: [{ name: "godot-skills", source: "./", description: "Godot workflows", skills: ["./skills/godot"] }],
    }));
    await writeFile(path.join(source, "skills", "godot", "SKILL.md"), "---\nname: godot\ndescription: Godot workflows.\n---\n");
    const app = createApp({ dataDirectory });
    apps.push(app);
    await app.ready();

    const inspected = await app.inject({ method: "POST", url: "/plugins/inspect", payload: { type: "directory", path: source } });
    const installed = await app.inject({
      method: "POST", url: "/plugins/install",
      payload: { type: "directory", path: source, candidate: "marketplace:game-skills:godot-skills" },
    });

    expect(inspected.statusCode).toBe(200);
    expect(inspected.json()).toEqual({ candidates: [{
      key: "marketplace:game-skills:godot-skills", name: "godot-skills", displayName: "Godot Skills",
      description: "Godot workflows", skillCount: 1, format: "claude",
      marketplace: { id: "game-skills", displayName: "Game Skills" },
    }] });
    expect(installed.json()).toMatchObject({
      id: "marketplace:game-skills:godot-skills",
      marketplace: { id: "game-skills", displayName: "Game Skills" },
      enabled: true,
      skills: [{ name: "Godot" }],
    });
  });

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
    expect(project.json()).toMatchObject({ id: projectId, name: "New Plugin", type: "web-game" });
    expect(conversation.statusCode).toBe(200);
    expect(projects.json()).toHaveLength(2);
  });

  it("lists and reads OpenGame plugins without exposing Pi runtime packages", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "open-game-plugin-catalog-")),
      publishFetch: async () => Response.json([]),
    });
    apps.push(app);
    await app.ready();

    const catalog = await app.inject({ method: "GET", url: "/plugins" });
    const detail = await app.inject({ method: "GET", url: "/plugins/opengame%3Agodot" });

    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toMatchObject({
      plugins: [
        { id: "opengame:godot", installed: true },
      ],
      errors: [],
    });
    expect(catalog.json().plugins.every((plugin: Record<string, unknown>) => !("longDescription" in plugin))).toBe(true);
    expect(detail.json()).toMatchObject({
      id: "opengame:godot",
      longDescription: expect.any(String),
      connections: [{ id: "opengame-godot", name: "Godot" }],
      defaultPrompts: expect.any(Array),
      projectTypes: ["godot-game"],
    });
  });

  it("stores the Plugin switch without owning Connection access", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "open-game-plugin-settings-api-"));
    const app = createApp({ dataDirectory });
    apps.push(app);
    await app.ready();

    const updated = await app.inject({
      method: "PUT",
      url: "/plugins/opengame%3Agodot/settings",
      payload: { enabled: false, components: {} },
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
