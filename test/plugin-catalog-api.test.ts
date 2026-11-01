import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { PluginServices } from "../src/daemon/plugin-services.js";

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("plugin catalog API", () => {
  it("installs a directory plugin enabled by default", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-install-api-"));
    const source = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-source-"));
    await mkdir(path.join(source, ".ohmygame-plugin"), { recursive: true });
    await writeFile(path.join(source, ".ohmygame-plugin", "plugin.json"), JSON.stringify({
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

  it("finishes indexing the bundled plugins before it closes the plugin store", async () => {
    let indexed = false;
    let finishIndexing!: () => void;
    vi.spyOn(PluginServices.prototype, "addBundled").mockReturnValue(new Promise((resolve) => {
      finishIndexing = () => { indexed = true; resolve([]); };
    }));
    const closePluginServices = PluginServices.prototype.close;
    let indexedWhenClosed: boolean | undefined;
    vi.spyOn(PluginServices.prototype, "close").mockImplementation(function (this: PluginServices) {
      indexedWhenClosed = indexed;
      return closePluginServices.call(this);
    });
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-close-")) });
    apps.push(app);
    // Indexing finishes only once shutdown has started.
    app.addHook("preClose", async () => { setTimeout(finishIndexing, 200); });
    try {
      await app.ready();
      await app.close();
      expect(indexedWhenClosed).toBe(true);
    } finally {
      finishIndexing();
    }
  });

  it("lists a project's plugins and turns one on there, starting its ohmygame.json", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-project-plugins-api-"));
    const app = createApp({ dataDirectory });
    apps.push(app);
    await app.ready();
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "web-game" } })).json();
    const view = (await app.inject({ method: "GET", url: `/projects/${project.id}/plugins?locale=en` })).json();
    // Plugins from the Plugins page that work with web games are on, for every such project.
    expect(view.global.map((plugin: { id: string }) => plugin.id)).toContain("ohmygame:web-game-studio");
    expect(view.global.map((plugin: { id: string }) => plugin.id)).not.toContain("ohmygame:godot");
    // Godot and Unreal suit General projects (appliesTo), which a Web game's ohmygame.json says it is.
    expect(view.plugins.map((plugin: { id: string }) => plugin.id)).toEqual(expect.arrayContaining(["ohmygame/godot", "ohmygame/unreal-engine"]));
    // An Interactive Story neither lists nor turns them on.
    const story = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-story" } })).json();
    const storyView = (await app.inject({ method: "GET", url: `/projects/${story.id}/plugins?locale=en` })).json();
    expect(storyView.plugins.map((plugin: { id: string }) => plugin.id)).not.toContain("ohmygame/godot");
    expect(storyView.plugins.map((plugin: { id: string }) => plugin.id)).not.toContain("ohmygame/unreal-engine");
    expect((await app.inject({ method: "PUT", url: `/projects/${story.id}/plugins/ohmygame/godot`, payload: { version: "1.0.0" } })).json())
      .toEqual({ error: "ohmygame/godot doesn't work in interactive-story projects" });
    const godot = view.plugins.find((plugin: { id: string }) => plugin.id === "ohmygame/godot");
    expect(godot).toMatchObject({ displayName: "Godot", version: "1.0.0", providesType: false });
    expect(godot.used).toBeUndefined();

    const on = await app.inject({ method: "PUT", url: `/projects/${project.id}/plugins/ohmygame/godot`, payload: { version: "1.0.0" } });
    expect(on.statusCode).toBe(204);
    expect(JSON.parse(await readFile(path.join(project.workspacePath, "ohmygame.json"), "utf8"))).toMatchObject({ type: "general", plugins: { "ohmygame/godot": "1.0.0" } });
    const after = (await app.inject({ method: "GET", url: `/projects/${project.id}/plugins` })).json();
    expect(after.plugins.find((plugin: { id: string }) => plugin.id === "ohmygame/godot")).toMatchObject({ used: "1.0.0" });
    expect((await app.inject({ method: "GET", url: "/projects/missing/plugins" })).statusCode).toBe(404);
    // Home offers the same plugins before a project exists, with the types each adds.
    const choices = (await app.inject({ method: "GET", url: "/project-plugins?locale=en" })).json();
    expect(choices.find((plugin: { id: string }) => plugin.id === "ohmygame/godot")).toMatchObject({
      displayName: "Godot", version: "1.0.0", providesTypes: ["ohmygame/godot:godot-game"], consented: expect.any(Boolean),
      appliesTo: ["general", "ohmygame/godot:godot-game"],
    });
  });

  it("offers the newest version of a plugin that suits the project", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-versions-"));
    const version = async (number: string, appliesTo: string[]) => {
      const folder = path.join(root, number);
      await mkdir(path.join(folder, ".ohmygame-plugin"), { recursive: true });
      await mkdir(path.join(folder, "skills", "tools"), { recursive: true });
      await writeFile(path.join(folder, "skills", "tools", "SKILL.md"), "---\nname: tools\ndescription: Tools.\n---\n");
      await writeFile(path.join(folder, ".ohmygame-plugin", "plugin.json"), JSON.stringify({
        id: "acme/tools", version: number, engines: { "ohmygame-api": "^2.0.0" },
        displayName: "Tools", description: "Tools.", appliesTo, contributes: { skills: "./skills/" },
      }));
      return folder;
    };
    const older = await version("1.0.0", ["general"]);
    const newer = await version("2.0.0", ["interactive-story"]);
    const addBundled = PluginServices.prototype.addBundled;
    vi.spyOn(PluginServices.prototype, "addBundled").mockImplementation(async function (this: PluginServices, directory) {
      const results = await addBundled.call(this, directory);
      await this.index.add(older);
      await this.index.add(newer);
      await this.grants.consent("acme/tools", []);
      return results;
    });
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-versions-api-")) });
    apps.push(app);
    await app.ready();
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "general" } })).json();
    const view = (await app.inject({ method: "GET", url: `/projects/${project.id}/plugins` })).json();
    expect(view.plugins.find((plugin: { id: string }) => plugin.id === "acme/tools")).toMatchObject({ version: "1.0.0" });
    expect((await app.inject({ method: "PUT", url: `/projects/${project.id}/plugins/acme/tools`, payload: { version: "1.0.0" } })).statusCode).toBe(204);
    expect((await app.inject({ method: "PUT", url: `/projects/${project.id}/plugins/acme/tools`, payload: { version: "2.0.0" } })).statusCode).toBe(409);
  });

  it("lists format 2 plugins with their settings, switches them, and keeps bundled ones installed", async () => {
    // Indexing the bundled plugins finishes after a project is made, as on a slow machine.
    let indexBundled!: () => void;
    const gate = new Promise<void>((resolve) => { indexBundled = resolve; });
    const addBundled = PluginServices.prototype.addBundled;
    vi.spyOn(PluginServices.prototype, "addBundled").mockImplementation(async function (this: PluginServices, directory) {
      await gate;
      return addBundled.call(this, directory);
    });
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-store-api-"));
    const app = createApp({ dataDirectory });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    indexBundled();
    /** What the project's event stream replays. */
    const replayed = async () => {
      const controller = new AbortController();
      const response = await fetch(`${address}/projects/${project.id}/events`, { signal: controller.signal });
      const reader = response.body!.getReader();
      let text = "";
      setTimeout(() => controller.abort(), 300);
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          text += new TextDecoder().decode(value);
        }
      } catch { /* Aborted. */ }
      return text;
    };
    const listed = async (locale = "en") => (await app.inject({ method: "GET", url: `/plugin-store/plugins?locale=${locale}` })).json()
      .find((plugin: { id: string }) => plugin.id === "ohmygame/godot");
    expect(await listed()).toMatchObject({
      version: "1.0.0",
      displayName: "Godot",
      bundled: true,
      grants: { enabled: true },
      settings: [{ name: "godotPath", type: "path", title: "Godot executable", description: expect.stringContaining("GODOT_PATH") }],
      adds: { projectTypes: ["Godot game"], tools: expect.any(Number), skills: expect.any(Number) },
    });
    expect((await listed("zh-CN")).settings[0].title).toBe("Godot 可执行文件");
    // The project reads its panels after indexing, so indexing tells it nothing.
    expect(await replayed()).not.toContain("project.plugins.changed");

    // A plugin that ships with the app only turns off.
    const removed = await app.inject({ method: "DELETE", url: "/plugin-store/ohmygame/godot/1.0.0" });
    expect(removed.statusCode).toBe(409);
    expect(await listed()).toBeDefined();
    const off = await app.inject({ method: "PUT", url: "/plugin-store/ohmygame/godot/enabled", payload: { enabled: false } });
    expect(off.statusCode).toBe(204);
    expect((await listed()).grants.enabled).toBe(false);
    expect(await replayed()).toContain("project.plugins.changed");

    const saved = await app.inject({ method: "PUT", url: "/plugin-store/ohmygame/godot/configuration", payload: { godotPath: "/opt/godot" } });
    expect(saved.json()).toEqual({ godotPath: { type: "path", value: "/opt/godot" } });
    const cleared = await app.inject({ method: "PUT", url: "/plugin-store/ohmygame/godot/configuration", payload: { godotPath: null } });
    // Back to its default: empty, so Godot is looked for in the usual places.
    expect(cleared.json()).toEqual({ godotPath: { type: "path", value: "" } });
  });

  it("offers a project only the plugin mentions its prompts accept", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-mention-types-"));
    const source = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-mention-source-"));
    await mkdir(path.join(source, ".ohmygame-plugin"), { recursive: true });
    await writeFile(path.join(source, ".ohmygame-plugin", "plugin.json"), JSON.stringify({
      name: "web-only", version: "1.0.0", description: "Web only", interface: { projectTypes: ["web-game"], icon: { type: "asset", path: "./icon.svg" } },
    }));
    await writeFile(path.join(source, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="green"/></svg>');
    const app = createApp({
      dataDirectory,
      createSession: async () => ({ messages: [], prompt: async () => {}, abort: async () => {}, dispose: () => {}, subscribe: () => () => {}, getSkills: () => [] }),
    });
    apps.push(app);
    await app.ready();
    await app.inject({ method: "POST", url: "/plugins/install", payload: { type: "directory", path: source } });
    const mentionIds = async (type: string) => {
      const project = (await app.inject({ method: "POST", url: "/projects", payload: { type } })).json();
      const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
      const capabilities = await app.inject({ method: "GET", url: `/projects/${project.id}/conversations/${conversation.id}/capabilities` });
      if (type === "web-game") expect(capabilities.json().plugins).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "personal:web-only", icon: { type: "asset", path: "./icon.svg" }, iconRevision: expect.any(String) }),
      ]));
      return capabilities.json().plugins.map((plugin: { id: string }) => plugin.id);
    };

    expect(await mentionIds("web-game")).toContain("personal:web-only");
    expect(await mentionIds("general")).not.toContain("personal:web-only");
    expect(await mentionIds("general")).toContain("ohmygame:game-studio");
    expect(await mentionIds("godot-game")).toContain("ohmygame:game-studio");
    expect(await mentionIds("web-game")).not.toContain("ohmygame:game-studio");
    expect((await app.inject({ method: "GET", url: "/composer/capabilities" })).json().plugins)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: "personal:web-only", icon: { type: "asset", path: "./icon.svg" }, iconRevision: expect.any(String) })]));
  });

  it("reads only a registered Skill file from an installed plugin", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-skill-api-"));
    const source = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-skill-source-"));
    await mkdir(path.join(source, ".ohmygame-plugin"), { recursive: true });
    await mkdir(path.join(source, "skills", "test"), { recursive: true });
    await writeFile(path.join(source, ".ohmygame-plugin", "plugin.json"), JSON.stringify({
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
      url: "/plugins/personal%3Atest-plugin/skill-content?id=.ohmygame-plugin%2Fplugin.json",
    });
    const unknownFile = await app.inject({
      method: "GET",
      url: "/plugins/personal%3Atest-plugin/skill-file?id=.ohmygame-plugin%2Fplugin.json",
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
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-marketplace-api-"));
    const source = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-marketplace-source-"));
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

  it("lists and reads OhMyGame plugins without exposing Pi runtime packages", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-catalog-")),
      publishFetch: async () => Response.json([]),
    });
    apps.push(app);
    await app.ready();

    const catalog = await app.inject({ method: "GET", url: "/plugins" });
    const detail = await app.inject({ method: "GET", url: "/plugins/ohmygame%3Aunity" });

    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toMatchObject({
      plugins: [
        { id: "ohmygame:aseprite", installed: true, beta: true, enabled: false },
        { id: "ohmygame:blender", installed: true, beta: true },
        { id: "ohmygame:cocos-creator", installed: true, beta: true, enabled: false },
        { id: "ohmygame:douyin-minigame", installed: true, beta: true, enabled: false },
        { id: "ohmygame:game-studio", installed: true },
        { id: "ohmygame:threejs-world", installed: true },
        { id: "ohmygame:tiled", installed: true, beta: true, enabled: false },
        { id: "ohmygame:unity", installed: true, beta: true, enabled: false },
        { id: "ohmygame:web-game-studio", installed: true },
        { id: "ohmygame:wechat-minigame", installed: true, beta: true, enabled: false },
      ],
      errors: [],
    });
    expect(catalog.json().plugins.every((plugin: Record<string, unknown>) => !("longDescription" in plugin))).toBe(true);
    expect(detail.json()).toMatchObject({
      id: "ohmygame:unity",
      longDescription: expect.any(String),
      defaultPrompts: expect.any(Array),
      projectTypes: ["general"],
    });
  });

  it("stores the Plugin switch together with MCP capabilities", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-settings-api-"));
    const source = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-mcp-source-"));
    await mkdir(path.join(source, ".ohmygame-plugin"), { recursive: true });
    await writeFile(path.join(source, ".ohmygame-plugin", "plugin.json"), JSON.stringify({
      name: "editor-bridge", version: "1.0.0", description: "Local editor MCP", mcpServers: "./mcp.json",
    }));
    await writeFile(path.join(source, "mcp.json"), JSON.stringify({ mcpServers: { editor: { url: "http://127.0.0.1:8000/mcp", lifecycle: "lazy" } } }));
    const app = createApp({ dataDirectory });
    apps.push(app);
    await app.ready();
    await app.inject({ method: "POST", url: "/plugins/install", payload: { type: "directory", path: source } });

    const updated = await app.inject({
      method: "PUT",
      url: "/plugins/personal%3Aeditor-bridge/settings",
      payload: { enabled: false, components: {} },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ enabled: false, mcpServers: [{ id: "editor", status: "disabled" }] });
  });

  it("moves Pi MCP configuration to Connections without listing it as a plugin", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-mcp-api-"));
    const piAgentDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-mcp-agent-"));
    await writeFile(path.join(piAgentDirectory, "mcp.json"), JSON.stringify({
      mcpServers: { figma: { url: "https://example.com/mcp" } },
    }));
    const app = createApp({ dataDirectory, piAgentDirectory });
    apps.push(app);
    await app.ready();

    const listed = await app.inject({ method: "GET", url: "/plugins" });

    expect(listed.json().plugins.filter((plugin: { marketplace: { id: string } }) => plugin.marketplace.id === "personal")).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/connections" })).json()).toMatchObject([{ id: "figma", displayName: "figma", transport: "http", enabled: true }]);
    expect(JSON.parse(await readFile(path.join(piAgentDirectory, "mcp.json"), "utf8"))).toMatchObject({
      mcpServers: { figma: { url: "https://example.com/mcp" } },
    });
  });
});
