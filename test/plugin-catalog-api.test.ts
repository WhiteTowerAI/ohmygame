import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { pluginMentionToken } from "../src/shared/plugins.js";
import { PluginServices } from "../src/daemon/plugin-services.js";

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** Adds the package in `source` the way the Add plugin dialog does. */
async function addPlugin(app: ReturnType<typeof createApp>, source: string) {
  const payload = { source: { type: "directory", path: source } };
  const inspected = await app.inject({ method: "POST", url: "/plugin-sources/inspect", payload });
  expect(inspected.statusCode, inspected.body).toBe(200);
  const added = await app.inject({ method: "POST", url: "/plugin-sources/install", payload: { ...payload, digest: inspected.json().digest } });
  expect(added.statusCode, added.body).toBe(201);
}

describe("plugin catalog API", () => {
  it("reviews and adds a package over its routes, then lists where it came from", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-add-api-"));
    const source = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-add-source-"));
    await mkdir(path.join(source, ".ohmygame-plugin"), { recursive: true });
    await writeFile(path.join(source, ".ohmygame-plugin", "plugin.json"), JSON.stringify({
      id: "acme/maker", version: "1.0.0", engines: { "ohmygame-api": "^2.0.0" }, displayName: "Maker", description: "Makes things",
      capabilities: { network: ["api.example.com"] }, contributes: { mcpServers: [{ id: "api", title: "API", url: "https://api.example.com/mcp", tools: ["search"] }] },
    }));
    const app = createApp({ dataDirectory });
    apps.push(app);
    await app.ready();
    const directory = { type: "directory", path: source };

    const inspected = await app.inject({ method: "POST", url: "/plugin-sources/inspect", payload: { source: directory } });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json()).toMatchObject({ id: "acme/maker", asks: ["network:api.example.com"], installedVersions: [] });
    const listed = async () => (await app.inject({ method: "GET", url: "/plugin-store/plugins" })).json<Array<{ id: string; grants: unknown; origin?: unknown }>>().find((plugin) => plugin.id === "acme/maker");
    expect(await listed()).toBeUndefined();

    const stale = await app.inject({ method: "POST", url: "/plugin-sources/install", payload: { source: directory, digest: "f".repeat(64) } });
    expect(stale.statusCode).toBe(400);
    expect(stale.json().error).toContain("changed after you reviewed it");
    const added = await app.inject({ method: "POST", url: "/plugin-sources/install", payload: { source: directory, digest: inspected.json().digest } });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toEqual({ id: "acme/maker", version: "1.0.0" });
    const plugin = await listed();
    expect(plugin?.grants).toBeNull();
    expect(plugin?.origin).toBeUndefined();

    for (const payload of [{ source: { type: "npm", name: "@acme/maker", registry: "https://evil.example" } }, { source: { type: "github", url: "https://github.com/acme/maker", commit: "main" } }, { source: { type: "git", url: "https://example.com/x.git" } }, {}])
      expect((await app.inject({ method: "POST", url: "/plugin-sources/inspect", payload })).statusCode, JSON.stringify(payload)).toBe(400);
    const notGzip = await app.inject({ method: "POST", url: "/plugin-sources/file/inspect", headers: { "content-type": "application/gzip" }, payload: Buffer.from("nope") });
    expect(notGzip.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/plugin-sources/file/install?digest=short`, headers: { "content-type": "application/gzip" }, payload: Buffer.from("nope") })).statusCode).toBe(400);
  });

  it("gives the market's listing over its route, off when no index is set", async () => {
    const off = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-market-api-")) });
    apps.push(off);
    await off.ready();
    expect((await off.inject({ method: "GET", url: "/plugin-market?locale=en" })).json()).toEqual({ status: "off", plugins: [], blocked: [] });
    const fromCard = await off.inject({ method: "POST", url: "/plugin-sources/inspect", payload: { source: { type: "npm", name: "@acme/maker", registry: "npmjs", version: "1.0.0", market: true } } });
    expect(fromCard.statusCode, fromCard.body).toBe(400);
    expect(fromCard.json().error).toContain("isn't on the plugin market any more");

    const body = JSON.stringify({ schemaVersion: 1, versions: [{
      package: "@acme/maker", version: "1.0.0", tarball: "", integrity: "sha512-AAAA", signatures: [],
      plugin: { id: "acme/maker", displayName: { en: "Maker", "zh-CN": "制造者" }, description: { en: "Makes" }, grants: [], adds: {} },
    }], packages: {}, featured: [] });
    const digest = createHash("sha256").update(body).digest("hex");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).endsWith("/index.json")
      ? Response.json({ latest: `index.${digest}.json` })
      : new Response(body));
    const app = createApp({ dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-market-api-")), pluginIndexUrl: "https://plugins.example.com/index.json" });
    apps.push(app);
    await app.ready();
    expect((await app.inject({ method: "GET", url: "/plugin-market?locale=zh-CN" })).json()).toMatchObject({ status: "ready", plugins: [{ id: "acme/maker", displayName: "制造者" }] });
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
    expect(view.global.map((plugin: { id: string }) => plugin.id)).toContain("ohmygame/web-game-studio");
    expect(view.global).toEqual(expect.arrayContaining([expect.objectContaining({ id: "ohmygame/web-game-studio", displayName: "Web Game Studio", icon: expect.any(Object), iconRevision: expect.any(String) })]));
    // By the project's own kind, not its file's type: a Web game isn't a General project here.
    expect(view.global.map((plugin: { id: string }) => plugin.id)).not.toContain("ohmygame/game-studio");
    expect(view.global.map((plugin: { id: string }) => plugin.id)).not.toContain("ohmygame/godot");
    // Those are on already, so a project has no choice to make about them.
    expect(view.plugins.map((plugin: { id: string }) => plugin.id)).not.toContain("ohmygame/web-game-studio");
    expect((await app.inject({ method: "PUT", url: `/projects/${project.id}/plugins/ohmygame/web-game-studio`, payload: { version: "1.0.0" } })).json().error)
      .toContain("applies to every project it suits");
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
    expect(choices.map((plugin: { id: string }) => plugin.id)).not.toContain("ohmygame/web-game-studio");
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
        displayName: "Tools", description: "Tools.", appliesTo, capabilities: { processes: ["node"] }, contributes: { skills: "./skills/" },
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
      await this.grants.consent("acme/tools", ["process:node"]);
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

  it("lists plugins with their settings, switches them, and keeps bundled ones installed", async () => {
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
    // What its page shows, read through its own routes.
    const godot = await listed();
    expect(godot).toMatchObject({
      beta: true,
      icon: { type: "asset", path: "./assets/icon.svg" },
      iconRevision: expect.any(String),
      longDescription: expect.any(String),
      appliesTo: ["general", "ohmygame/godot:godot-game"],
      skills: [{ id: "skills/godot-game/SKILL.md", name: "godot-game", description: expect.any(String) }],
    });
    expect(godot.examples.length).toBeGreaterThan(0);
    const id = encodeURIComponent("ohmygame/godot");
    const icon = await app.inject({ method: "GET", url: `/plugins/${id}/icon` });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers["content-type"]).toContain("image/svg+xml");
    const skill = encodeURIComponent(godot.skills[0].id);
    const content = await app.inject({ method: "GET", url: `/plugins/${id}/skill-content?id=${skill}` });
    expect(content.json()).toEqual({ id: godot.skills[0].id, content: expect.stringContaining("godot-game") });
    expect((await app.inject({ method: "GET", url: `/plugins/${id}/skill-file?id=${skill}` })).json().path).toMatch(/SKILL\.md$/);
    // Only the Skills it lists can be read, and its folder is the app's own.
    expect((await app.inject({ method: "GET", url: `/plugins/${id}/skill-content?id=${encodeURIComponent("../../package.json")}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/plugins/${id}/directory` })).statusCode).toBe(404);
    // The longest id a plugin can have reaches the routes.
    const longest = encodeURIComponent(`${"a".repeat(64)}/${"b".repeat(64)}`);
    expect((await app.inject({ method: "GET", url: `/plugins/${longest}/icon` })).statusCode).toBe(404);
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
    await mkdir(path.join(source, "skills", "web-only"), { recursive: true });
    await writeFile(path.join(source, "skills", "web-only", "SKILL.md"), "---\nname: web-only\ndescription: Web only.\n---\n");
    await writeFile(path.join(source, ".ohmygame-plugin", "plugin.json"), JSON.stringify({
      id: "acme/web-only", version: "1.0.0", engines: { "ohmygame-api": "^2.0.0" }, displayName: "Web only", description: "Web only",
      appliesTo: ["web-game"], icon: "./icon.svg", contributes: { skills: "./skills/" },
    }));
    await writeFile(path.join(source, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="green"/></svg>');
    const app = createApp({
      dataDirectory,
      createSession: async () => ({ messages: [], prompt: async () => {}, abort: async () => {}, dispose: () => {}, subscribe: () => () => {}, getSkills: () => [] }),
    });
    apps.push(app);
    await app.ready();
    await addPlugin(app, source);
    const mentionIds = async (type: string) => {
      const project = (await app.inject({ method: "POST", url: "/projects", payload: { type } })).json();
      const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations` })).json();
      const capabilities = await app.inject({ method: "GET", url: `/projects/${project.id}/conversations/${conversation.id}/capabilities` });
      if (type === "web-game") expect(capabilities.json().plugins).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "acme/web-only", icon: { type: "asset", path: "./icon.svg" }, iconRevision: expect.any(String) }),
      ]));
      return capabilities.json().plugins.map((plugin: { id: string }) => plugin.id);
    };

    expect(await mentionIds("web-game")).toContain("acme/web-only");
    expect(await mentionIds("general")).not.toContain("acme/web-only");
    expect(await mentionIds("general")).toContain("ohmygame/game-studio");
    expect(await mentionIds("godot-game")).toContain("ohmygame/game-studio");
    expect(await mentionIds("web-game")).not.toContain("ohmygame/game-studio");
    const home = (await app.inject({ method: "GET", url: "/composer/capabilities?locale=zh-CN" })).json();
    expect(home.plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "acme/web-only", icon: { type: "asset", path: "./icon.svg" }, iconRevision: expect.any(String) }),
      // Home knows no project yet, so it offers those that apply by themselves whatever they suit; a mention keeps its old form.
      expect.objectContaining({ id: "ohmygame/web-game-studio", name: "web-game-studio", marketplaceId: "ohmygame", marketplaceDisplayName: "OhMyGame", projectTypes: ["web-game"] }),
      expect.objectContaining({ id: "ohmygame/game-studio", projectTypes: ["general", "interactive-story", "godot-game"] }),
    ]));
    // One turned off is no longer offered, nor are its Skills.
    expect(home.skills.map((skill: { name: string }) => skill.name)).toContain("game-studio");
    await app.inject({ method: "PUT", url: "/plugin-store/ohmygame/game-studio/enabled", payload: { enabled: false } });
    const off = (await app.inject({ method: "GET", url: "/composer/capabilities" })).json();
    expect(off.plugins.map((plugin: { id: string }) => plugin.id)).not.toContain("ohmygame/game-studio");
    expect(off.skills.map((skill: { name: string }) => skill.name)).not.toContain("game-studio");
    // A prompt can't mention one that doesn't suit its project.
    const mention = { name: "threejs-world", marketplaceId: "ohmygame", displayName: "Three.js World" };
    const story = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-story" } })).json();
    const storyConversation = (await app.inject({ method: "POST", url: `/projects/${story.id}/conversations` })).json();
    const refused = await app.inject({ method: "POST", url: `/projects/${story.id}/conversations/${storyConversation.id}/turns`, payload: { prompt: `${pluginMentionToken(mention)} build`, mentions: [mention] } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain("different project type");
  });

  it("reads only a registered Skill file from an installed plugin", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-skill-api-"));
    const source = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-skill-source-"));
    await mkdir(path.join(source, ".ohmygame-plugin"), { recursive: true });
    await mkdir(path.join(source, "skills", "test-skill"), { recursive: true });
    await writeFile(path.join(source, ".ohmygame-plugin", "plugin.json"), JSON.stringify({
      id: "acme/test-plugin", version: "1.0.0", engines: { "ohmygame-api": "^2.0.0" }, displayName: "Test Plugin", description: "Test plugin",
      contributes: { skills: "./skills/" },
    }));
    const skillContent = "---\nname: test-skill\ndescription: Test workflows.\n---\n\n# Test Skill\n\nDo the thing.\n";
    await writeFile(path.join(source, "skills", "test-skill", "SKILL.md"), skillContent);
    const app = createApp({ dataDirectory });
    apps.push(app);
    await app.ready();
    await addPlugin(app, source);

    const skill = await app.inject({
      method: "GET",
      url: "/plugins/acme%2Ftest-plugin/skill-content?id=skills%2Ftest-skill%2FSKILL.md",
    });
    const skillFile = await app.inject({
      method: "GET",
      url: "/plugins/acme%2Ftest-plugin/skill-file?id=skills%2Ftest-skill%2FSKILL.md",
    });
    const capabilities = await app.inject({ method: "GET", url: "/composer/capabilities" });
    const unknown = await app.inject({
      method: "GET",
      url: "/plugins/acme%2Ftest-plugin/skill-content?id=.ohmygame-plugin%2Fplugin.json",
    });
    const unknownFile = await app.inject({
      method: "GET",
      url: "/plugins/acme%2Ftest-plugin/skill-file?id=.ohmygame-plugin%2Fplugin.json",
    });

    expect(skill.statusCode).toBe(200);
    expect(skill.json()).toEqual({ id: "skills/test-skill/SKILL.md", content: skillContent });
    expect(skillFile.statusCode).toBe(200);
    expect(skillFile.json().path).toMatch(/skills[/\\]test-skill[/\\]SKILL\.md$/);
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json().plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "acme/test-plugin", marketplaceId: "acme" }),
    ]));
    expect(capabilities.json().skills).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "test-skill",
        pluginDisplayName: "Test Plugin",
        marketplaceDisplayName: "acme",
      }),
    ]));
    expect(unknown.statusCode).toBe(404);
    expect(unknownFile.statusCode).toBe(404);
  });

  it("lists the plugins that ship with the app", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-catalog-")),
      publishFetch: async () => Response.json([]),
    });
    apps.push(app);
    await app.ready();

    const store = (await app.inject({ method: "GET", url: "/plugin-store/plugins" })).json() as Array<{ id: string; appWide: boolean; bundled: boolean; beta?: boolean; categories?: string[]; grants: { enabled: boolean } | null }>;
    const fields = ({ id, appWide, beta, categories, grants }: (typeof store)[number]) => ({ id, appWide, beta, categories, enabled: grants?.enabled });
    expect(store.map(fields)).toEqual(expect.arrayContaining([
      { id: "ohmygame/aseprite", appWide: true, beta: true, categories: ["art"], enabled: false },
      { id: "ohmygame/blender", appWide: true, beta: true, categories: ["art"], enabled: true },
      { id: "ohmygame/game-studio", appWide: true, beta: undefined, categories: ["workflow"], enabled: true },
      { id: "ohmygame/unity", appWide: true, beta: true, categories: ["engine"], enabled: false },
      { id: "ohmygame/godot", appWide: false, beta: true, categories: ["engine"], enabled: true },
    ]));
    expect(store.every((plugin) => plugin.bundled)).toBe(true);
  });
});
