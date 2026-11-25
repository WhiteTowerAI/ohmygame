import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginIndex } from "../src/daemon/plugin-index.js";
import { BUNDLED_PLUGINS_OFF, PluginServices } from "../src/daemon/plugin-services.js";
import {
  PluginGrants,
  capabilityGrants,
  createProjectPlugins,
  projectFolderKey,
  projectSkills,
  readProjectFile,
  resolveProjectPlugins,
  setProjectPlugin,
  writeProjectFile,
} from "../src/daemon/project-plugins.js";
import { PROJECT_FILE_SCHEMA_URL, validateProjectFile } from "../src/shared/project-file.js";
import { PROJECT_SCHEMA_FILE, projectSchemaJson } from "../scripts/plugin-schema.js";
import { GODOT_PLUGIN_MCP_SERVER_ID } from "../src/shared/mcp.js";
import { PLUGIN_PROJECT_KINDS } from "../src/shared/project-runtime.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures/plugins");
const BUNDLED = path.join(import.meta.dirname, "../.runtime/preinstalled-plugin-sources");
const GODOT_PLUGIN = "ohmygame/godot";
const GODOT_TYPE = PLUGIN_PROJECT_KINDS["godot-game"];
const UNREAL_PLUGIN = "ohmygame/unreal-engine";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function temporary() {
  const dir = await mkdtemp(path.join(tmpdir(), "ohmygame-project-plugins-"));
  cleanup.push(dir);
  return dir;
}

/** A Godot type plugin; later versions can ask for more. */
async function godot(version: string, network?: string[]) {
  const dir = path.join(await temporary(), `godot-${version}`);
  await mkdir(path.join(dir, ".ohmygame-plugin"), { recursive: true });
  await mkdir(path.join(dir, "native"));
  await mkdir(path.join(dir, "templates/godot-game"), { recursive: true });
  await writeFile(
    path.join(dir, "native/index.js"),
    "export function activate() {}",
  );
  await writeFile(path.join(dir, "templates/godot-game/project.godot"), "");
  await writeFile(
    path.join(dir, ".ohmygame-plugin/plugin.json"),
    JSON.stringify({
      id: "ohmygame/godot",
      version,
      engines: { "ohmygame-api": "^2.0.0" },
      displayName: "Godot",
      description: "Godot games.",
      entrypoints: { native: "./native/index.js" },
      capabilities: {
        native: true,
        "project.files": "write",
        processes: ["godot"],
        ...(network ? { network } : {}),
      },
      contributes: {
        projectTypes: [
          {
            id: "godot-game",
            title: "Godot",
            template: "./templates/godot-game/",
            recognize: { files: ["project.godot"] },
            preview: "web-build",
          },
        ],
      },
    }),
  );
  return dir;
}

async function gameStudio() {
  const dir = path.join(await temporary(), "game-studio");
  await cp(path.join(BUNDLED, "game-studio"), dir, { recursive: true });
  await cp(path.join(FIXTURES, "game-studio"), dir, { recursive: true });
  return dir;
}

/** A plugin with Skills (and, when `native`, code) that says where it's on. */
async function enginePlugin(id: string, activation: unknown, native = false, command = false) {
  const dir = path.join(await temporary(), id.replace("/", "-"));
  await mkdir(path.join(dir, ".ohmygame-plugin"), { recursive: true });
  await mkdir(path.join(dir, "skills", "engine"), { recursive: true });
  await writeFile(path.join(dir, "skills", "engine", "SKILL.md"), "---\nname: engine\ndescription: Use the engine.\n---\n");
  if (native) await writeFile(path.join(dir, "index.js"), "export function activate() {}");
  await writeFile(path.join(dir, ".ohmygame-plugin", "plugin.json"), JSON.stringify({
    id, version: "1.0.0", engines: { "ohmygame-api": "^2.0.0" }, displayName: id, description: "An engine.",
    appliesTo: ["general"], activation,
    ...(native ? { entrypoints: { native: "./index.js" }, capabilities: { native: true } } : {}),
    contributes: { skills: "./skills/", ...(command ? { commands: [{ id: "play", title: "Play", run: { prompt: "Play it." } }] } : {}) },
  }));
  return dir;
}

async function setup() {
  const data = await temporary();
  const index = new PluginIndex(path.join(data, "plugin-index.json"));
  const grants = new PluginGrants(path.join(data, "plugin-grants.json"));
  await grants.load();
  for (const root of [await godot("1.0.0"), await gameStudio()])
    expect((await index.add(root)).ok).toBe(true);
  const folder = await temporary();
  return { data, index, grants, folder };
}

/** A project someone else made, as a clone brings it. */
async function clonedProject(folder: string) {
  await writeFile(
    path.join(folder, "ohmygame.json"),
    JSON.stringify({
      type: "ohmygame/godot:godot-game",
      plugins: { "ohmygame/godot": "1.0.0", "ohmygame/game-studio": "1.0.0" },
      layout: { future: "setting" },
    }),
  );
}

/** The plugins a project's file names and their statuses, as the services see them. */
const stateOf = async (folder: string, services: PluginServices) => {
  const resolved = await services.resolve(folder);
  return resolved.ok ? resolved.plugins.filter((plugin) => !plugin.everyProject).map((plugin) => [plugin.id, plugin.status]) : resolved;
};

const statuses = (
  resolved: Awaited<ReturnType<typeof resolveProjectPlugins>>,
) =>
  resolved?.ok
    ? Object.fromEntries(
        resolved.plugins.map((plugin) => [plugin.id, plugin.status]),
      )
    : resolved;

describe("project file", () => {
  it("names a core or plugin type and enables its provider", () => {
    expect(validateProjectFile({ type: "general" }).ok).toBe(true);
    expect(
      validateProjectFile({
        type: "ohmygame/godot:godot-game",
        plugins: { "ohmygame/godot": "1.0.0" },
      }).ok,
    ).toBe(true);
    expect(validateProjectFile({ type: "ohmygame/godot:godot-game" })).toEqual({
      ok: false,
      issues: ["/plugins must enable ohmygame/godot, which provides the type"],
    });
    expect(
      validateProjectFile({ type: "general", plugins: { "a/b": "^1.0.0" } }),
    ).toEqual({ ok: false, issues: ["/plugins/a/b must be an exact version, true or false"] });
    // On at the newest version, or off where it is on in every project.
    expect(validateProjectFile({ type: "general", plugins: { "a/b": true, "c/d": false } }).ok).toBe(true);
    expect(validateProjectFile({ type: "ohmygame/godot:godot-game", plugins: { "ohmygame/godot": true } })).toMatchObject({ ok: true });
    expect(validateProjectFile({ type: "ohmygame/godot:godot-game", plugins: { "ohmygame/godot": false } })).toMatchObject({ ok: false });
    expect(validateProjectFile({ type: "web-game" }).ok).toBe(false);
  });

  it("keeps keys it doesn't know and writes for people", async () => {
    const folder = await temporary();
    await clonedProject(folder);
    await writeProjectFile(folder, (file) => ({
      ...file,
      plugins: { ...file.plugins, "ohmygame/solarized": "1.0.0" },
    }));
    const text = await readFile(path.join(folder, "ohmygame.json"), "utf8");
    expect(
      text.startsWith(
        '{\n  "$schema": "https://www.ohmygame.ai/schema/project-1.json"',
      ),
    ).toBe(true);
    expect(JSON.parse(text)).toMatchObject({
      layout: { future: "setting" },
      plugins: { "ohmygame/solarized": true },
    });
    expect(await readProjectFile(await temporary())).toBeUndefined();
    // A file an older OhMyGame wrote gets the current schema URL when it is written again.
    await writeFile(path.join(folder, "ohmygame.json"), JSON.stringify({ ...JSON.parse(text), $schema: "https://ohmygame.dev/schema/project-1.json" }));
    await writeProjectFile(folder, (file) => file);
    expect(JSON.parse(await readFile(path.join(folder, "ohmygame.json"), "utf8")).$schema).toBe(PROJECT_FILE_SCHEMA_URL);
  });

  it("publishes a JSON Schema that matches its source", async () => {
    expect(await readFile(PROJECT_SCHEMA_FILE, "utf8")).toBe(projectSchemaJson());
  });
});

describe("project plugins", () => {
  it("runs nothing in safe mode, keeping what was allowed for a normal start", async () => {
    const { data, index, grants, folder } = await setup();
    await clonedProject(folder);
    await grants.consent("ohmygame/godot", ["native", "process:godot", "project.files:write"]);
    expect(statuses(await resolveProjectPlugins({ folder, index, grants }))).toMatchObject({ "ohmygame/godot": "active" });
    const safe = new PluginGrants(path.join(data, "plugin-grants.json"), { safeMode: true });
    await safe.load();
    expect(statuses(await resolveProjectPlugins({ folder, index, grants: safe }))).toEqual({
      "ohmygame/godot": "disabled",
      "ohmygame/game-studio": "disabled",
    });
    expect(safe.plugin("ohmygame/godot")).toMatchObject({ enabled: false, allowed: ["native", "process:godot", "project.files:write"] });
    // A change made meanwhile is still saved as it is.
    await safe.consent("ohmygame/game-studio", []);
    await grants.load();
    expect(grants.plugin("ohmygame/godot")?.enabled).toBe(true);
    expect(grants.plugin("ohmygame/game-studio")?.enabled).toBe(true);
    const services = new PluginServices({ directory: await temporary(), safeMode: true });
    try {
      await expect(services.restart("ohmygame/godot")).rejects.toThrow("Plugins stay off in safe mode");
      // Nor does a Plugin Builder draft's MCP test start its server.
      await expect(services.draftMcpServer(await temporary(), "server", { withSaved: false })).rejects.toThrow("Plugins stay off in safe mode");
    } finally {
      await services.close();
    }
  });

  it("runs what a cloned project turns on once the person consented to it, with nothing to allow per folder", async () => {
    const { index, grants, folder } = await setup();
    await clonedProject(folder);

    // Installed, but nobody allowed anything yet. One that asks for nothing
    // has nothing to consent to, so it runs.
    let resolved = await resolveProjectPlugins({ folder, index, grants });
    expect(statuses(resolved)).toEqual({
      "ohmygame/godot": "needs-consent",
      "ohmygame/game-studio": "active",
    });
    expect(resolved?.ok && resolved.typeReady).toBe(false);
    expect(resolved?.ok && resolved.plugins[0]).toMatchObject({
      id: "ohmygame/godot",
      providesType: true,
      missing: ["native", "process:godot", "project.files:write"],
    });

    // Consent given once, as when installing it, covers this folder too.
    await grants.consent("ohmygame/godot", ["native", "process:godot", "project.files:write"]);
    resolved = await resolveProjectPlugins({ folder, index, grants });
    expect(statuses(resolved)).toEqual({
      "ohmygame/godot": "active",
      "ohmygame/game-studio": "active",
    });
    expect(resolved?.ok && resolved.typeReady).toBe(true);
    expect(
      resolved?.ok && projectSkills(resolved).map((skill) => skill.name),
    ).toEqual(["game-foundations", "game-qa", "game-studio"]);
  });

  it("gives agent sessions the Skills of plugins the project allows", async () => {
    const services = new PluginServices({ directory: await temporary() });
    try {
      expect((await services.index.add(await gameStudio())).ok).toBe(true);
      const folder = await temporary();
      await writeProjectFile(folder, (file) => file, {
        type: "general",
        plugins: { "ohmygame/game-studio": "1.0.0" },
      });
      const skills = await services.skills(folder);
      expect(skills.map((skill) => path.basename(path.dirname(skill.path)))).toEqual([
        "game-foundations",
        "game-qa",
        "game-studio",
      ]);
      expect(skills[0]).toMatchObject({ marketplaceDisplayName: "ohmygame" });
      expect(skills[0]!.path.endsWith(path.join("skills", "game-foundations", "SKILL.md"))).toBe(true);
    } finally {
      await services.close();
    }
  });

  it("starts the bundled Godot's MCP server in a General project that turns Godot on, with its setting", async () => {
    const services = new PluginServices({ directory: await temporary(), bundled: BUNDLED });
    try {
      await services.ready();
      const entry = services.index.get("ohmygame/godot")!;
      const folder = await temporary();
      await writeProjectFile(folder, (file) => file, { type: "general", plugins: { "ohmygame/godot": entry.version } });
      // The timeline knows this name to show Godot's calls as Godot's.
      expect(Object.keys(await services.mcpServers(folder))).toEqual([GODOT_PLUGIN_MCP_SERVER_ID]);
      const server = () => services.mcpServers(folder).then((servers) => Object.values(servers));
      // Empty until it is set, so the server looks for Godot as the tools do.
      expect(await server()).toMatchObject([{
        command: "node",
        args: ["./native/mcp.mjs"],
        cwd: entry.root,
        env: { OHMYGAME_GODOT_SETTING: "" },
        includeTools: expect.arrayContaining(["run_project", "get_debug_output", "add_node"]),
      }]);
      await services.values.update(entry, { godotPath: "/opt/Godot" });
      expect(await server()).toMatchObject([{ env: { OHMYGAME_GODOT_SETTING: "/opt/Godot" } }]);
    } finally {
      await services.close();
    }
  });

  it("connects to the bundled Unreal's MCP server only on this computer, at the port the person sets", async () => {
    const services = new PluginServices({ directory: await temporary(), bundled: BUNDLED, bundledOff: [UNREAL_PLUGIN] });
    try {
      await services.ready();
      const entry = services.index.get(UNREAL_PLUGIN)!;
      const folder = await temporary();
      await writeProjectFile(folder, (file) => file, { type: "general", plugins: { [UNREAL_PLUGIN]: entry.version } });
      // Off everywhere until a project names it; the app consents for a plugin it brings.
      // The adapter keeps it on that origin, with OAuth, redirects and URL expansion off.
      expect(Object.values(await services.mcpServers(folder))).toEqual([{
        url: "http://127.0.0.1:8000/mcp",
        allowedOrigins: ["http://127.0.0.1:8000"],
        includeTools: ["list_toolsets", "describe_toolset", "call_tool"],
        disabled: false,
      }]);
      await services.configure(UNREAL_PLUGIN, { endpoint: "http://localhost:8100/mcp" });
      expect(Object.values(await services.mcpServers(folder))).toMatchObject([{ url: "http://localhost:8100/mcp", allowedOrigins: ["http://localhost:8100"] }]);
      // A setting can't move it past the hosts the person allowed.
      for (const endpoint of ["http://192.168.1.5:8000/mcp", "https://example.com/mcp", "http://user:secret@127.0.0.1:8000/mcp"])
        await expect(services.configure(UNREAL_PLUGIN, { endpoint })).rejects.toThrow(endpoint);
      expect(Object.values(await services.mcpServers(folder))).toMatchObject([{ url: "http://localhost:8100/mcp" }]);
    } finally {
      await services.close();
    }
  });

  it("turns a plugin on by itself in projects whose folder looks like its engine's, and only there", async () => {
    const services = new PluginServices({ directory: await temporary() });
    try {
      for (const root of [
        await enginePlugin("acme/unity", { files: ["ProjectSettings/ProjectVersion.txt"] }),
        await enginePlugin("acme/unreal", { files: ["*.uproject"] }),
        await enginePlugin("acme/tiles", "project"),
        await enginePlugin("acme/native-engine", { files: ["engine.cfg"] }, true),
        await enginePlugin("acme/prompts", { files: ["prompts.cfg"] }, false, true),
      ]) expect((await services.install(root)).ok).toBe(true);
      const on = async (folder: string) => {
        const resolved = await services.resolve(folder);
        if (!resolved.ok) throw new Error(resolved.issues.join("; "));
        return Object.fromEntries(resolved.plugins.map((plugin) => [plugin.id, `${plugin.status}${plugin.detected ? " (detected)" : ""}`]));
      };
      const plain = await temporary();
      // Saying where it's on means per project until the person decides, even for Skills alone.
      expect(await on(plain)).toEqual({});
      expect(services.onInEveryProject("acme/tiles")).toBe(false);
      const unity = await temporary();
      await mkdir(path.join(unity, "ProjectSettings"));
      await writeFile(path.join(unity, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0.30f1");
      expect(await on(unity)).toEqual({ "acme/unity": "active (detected)" });
      const unreal = await temporary();
      await writeFile(path.join(unreal, "Shooter.uproject"), "{}");
      await writeFile(path.join(unreal, "engine.cfg"), "");
      // Code it runs still waits for the person to allow it, here and in the folder.
      await writeFile(path.join(unreal, "prompts.cfg"), "");
      expect(await on(unreal)).toEqual({ "acme/unreal": "active (detected)", "acme/native-engine": "needs-consent (detected)", "acme/prompts": "active (detected)" });
      // Matching `*.ext` takes files in any case, and not folders.
      const shouting = await temporary();
      await writeFile(path.join(shouting, "Shooter.UPROJECT"), "{}");
      expect(await on(shouting)).toEqual({ "acme/unreal": "active (detected)" });
      const folderOnly = await temporary();
      await mkdir(path.join(folderOnly, "Old.uproject"));
      expect(await on(folderOnly)).toEqual({});
      expect(await services.recognizesFolder(unity)).toBe(true);
      expect(await services.recognizesFolder(plain)).toBe(false);
      // Turned off in the project, its file says so, and it stays off; turned on again, the file names nothing.
      await services.setProjectPlugin(unity, "acme/unity", false, { initialType: "general" });
      expect(await readProjectFile(unity)).toMatchObject({ ok: true, file: { plugins: { "acme/unity": false } } });
      expect(await on(unity)).toEqual({});
      await services.setProjectPlugin(unity, "acme/unity", true, { initialType: "general" });
      expect(await on(unity)).toEqual({ "acme/unity": "active (detected)" });
      // Code it runs, once allowed here, runs in this folder.
      await services.setProjectPlugin(unreal, "acme/native-engine", true, { initialType: "general" });
      expect((await on(unreal))["acme/native-engine"]).toBe("active (detected)");
      // A project that turned it off keeps it off; the person's choice for every project wins.
      await writeProjectFile(unity, (file) => ({ ...file, plugins: { "acme/unity": false } }));
      expect(await on(unity)).toEqual({});
      await services.setEveryProject("acme/tiles", true);
      expect(await on(plain)).toEqual({ "acme/tiles": "active" });
    } finally {
      await services.close();
    }
  });

  it("recognizes an engine's folder by OhMyGame's own engine plugin from before activation", async () => {
    const services = new PluginServices({ directory: await temporary() });
    try {
      expect((await services.install(await enginePlugin("ohmygame/unity", undefined))).ok).toBe(true);
      const unity = await temporary();
      await mkdir(path.join(unity, "ProjectSettings"));
      await writeFile(path.join(unity, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0.30f1");
      expect(await services.recognizesFolder(unity)).toBe(true);
      expect(await services.recognizesFolder(await temporary())).toBe(false);
    } finally {
      await services.close();
    }
  });

  it("tests an installed plugin's MCP server with its saved settings, or says why it can't start", async () => {
    const services = new PluginServices({ directory: await temporary() });
    try {
      const root = await temporary();
      await mkdir(path.join(root, ".ohmygame-plugin"), { recursive: true });
      await writeFile(path.join(root, ".ohmygame-plugin", "plugin.json"), JSON.stringify({
        id: "acme/editor", version: "1.0.0", displayName: "Editor", description: "MCP fixture",
        engines: { "ohmygame-api": "^2.0.0" },
        capabilities: { network: ["127.0.0.1"] },
        configuration: { endpoint: { type: "text", title: "Editor address" } },
        contributes: { mcpServers: [{
          id: "editor", title: "Editor", url: "${config.endpoint}", tools: ["call_tool"],
          setup: "Start the editor's MCP server first.", docs: "https://example.com/editor-mcp",
        }] },
      }));
      expect((await services.install(root)).ok).toBe(true);
      const probed: Array<{ name: string; definition: unknown }> = [];
      const probe = async (name: string, definition: unknown) => {
        probed.push({ name, definition });
        return { status: "connected" as const, toolCount: 1, message: `${name} (1 tools):\n- ${name}_call_tool` };
      };
      // Nothing runs until the person allows what it asks for.
      await expect(services.testMcpServer("acme/editor", "editor", "en", probe)).rejects.toThrow("allow");
      await services.grants.consent("acme/editor", ["network:127.0.0.1"]);
      expect(await services.testMcpServer("acme/editor", "editor", "en", probe)).toEqual({
        status: "failed", toolCount: 0, message: "Fill in Editor address in the plugin's settings", missingSettings: ["Editor address"],
      });
      expect(probed).toEqual([]);
      await services.configure("acme/editor", { endpoint: "http://127.0.0.1:9000/mcp" });
      // It's shown by its title and URL; the guide never reaches how the server starts.
      expect(await services.testMcpServer("acme/editor", "editor", "en", probe)).toEqual({
        status: "connected", toolCount: 1, message: '"Editor" (http://127.0.0.1:9000/mcp) (1 tools):\n- call_tool',
      });
      expect(probed[0]!.definition).toEqual({ url: "http://127.0.0.1:9000/mcp", allowedOrigins: ["http://127.0.0.1:9000"], includeTools: ["call_tool"], disabled: false });
      await expect(services.testMcpServer("acme/editor", "editor", "en", async (name) => { throw new Error(`Failed to connect to "${name}"`); }))
        .rejects.toThrow('Failed to connect to "Editor" (http://127.0.0.1:9000/mcp)');
      await expect(services.testMcpServer("acme/editor", "other", "en", probe)).rejects.toThrow("no such MCP server");
    } finally {
      await services.close();
    }
  });

  it("turns plugins on in every project, and keeps only what a project changes", async () => {
    const kinds = new Map<string, { type: string }>();
    const services = new PluginServices({ directory: await temporary(), bundled: BUNDLED, bundledOff: BUNDLED_PLUGINS_OFF, projectKind: (folder) => kinds.get(folder) });
    try {
      await services.ready();
      const general = await temporary();
      kinds.set(await projectFolderKey(general), { type: "general" });
      const on = async (folder: string) => {
        const resolved = await services.resolve(folder);
        return resolved.ok ? resolved.plugins.filter((plugin) => plugin.status === "active").map((plugin) => plugin.id) : resolved;
      };
      // A plugin that only adds Skills starts on in every project it suits; one in beta starts off.
      expect(await on(general)).toContain("ohmygame/game-studio");
      expect(await on(general)).not.toContain("ohmygame/unity");
      // Off in this project is the only thing its file records.
      await services.setProjectPlugin(general, "ohmygame/game-studio", false, { initialType: "general" });
      let file = await readProjectFile(general);
      expect(file?.ok && file.file.plugins).toEqual({ "ohmygame/game-studio": false });
      expect(await on(general)).not.toContain("ohmygame/game-studio");
      // On again, it follows every project once more.
      await services.setProjectPlugin(general, "ohmygame/game-studio", true);
      file = await readProjectFile(general);
      expect(file?.ok && file.file.plugins).toBeUndefined();
      // One that is off everywhere is turned on here at its newest version.
      await services.setProjectPlugin(general, "ohmygame/tiled", true);
      file = await readProjectFile(general);
      expect(file?.ok && file.file.plugins).toEqual({ "ohmygame/tiled": true });
      expect(await on(general)).toContain("ohmygame/tiled");
      // Turned on in every project, it reaches a project that never named it.
      const other = await temporary();
      kinds.set(await projectFolderKey(other), { type: "general" });
      expect(await on(other)).not.toContain("ohmygame/tiled");
      await services.setEveryProject("ohmygame/tiled", true);
      expect(await on(other)).toContain("ohmygame/tiled");
      // Off in every project, it stays on only where a project turned it on.
      await services.setEveryProject("ohmygame/tiled", false);
      expect(await on(general)).toContain("ohmygame/tiled");
      expect(await on(other)).not.toContain("ohmygame/tiled");
    } finally {
      await services.close();
    }
  });

  it("runs a plugin turned on in every project in each folder at once, and in a cloned project that names it", async () => {
    const services = new PluginServices({ directory: await temporary(), bundled: BUNDLED, bundledOff: BUNDLED_PLUGINS_OFF, projectKind: () => ({ type: "general" }) });
    try {
      await services.ready();
      const unreal = services.index.get(UNREAL_PLUGIN)!;
      const folder = await temporary();
      // Turning it on is allowing it.
      await services.setEveryProject(UNREAL_PLUGIN, true);
      let resolved = await services.resolve(folder);
      expect(resolved.ok && resolved.plugins.find((plugin) => plugin.id === UNREAL_PLUGIN)).toMatchObject({ status: "active", everyProject: true });
      // A cloned project's file naming it runs it too: the person already allowed it.
      await writeProjectFile(folder, (file) => file, { type: "general", plugins: { [UNREAL_PLUGIN]: unreal.version } });
      resolved = await services.resolve(folder);
      expect(resolved.ok && resolved.plugins.find((plugin) => plugin.id === UNREAL_PLUGIN)).toMatchObject({ status: "active" });
    } finally {
      await services.close();
    }
  });

  it("matches appliesTo against what the project is in the app, not only its file", async () => {
    const kinds = new Map<string, { type: string }>();
    const services = new PluginServices({ directory: await temporary(), bundled: BUNDLED, bundledOff: BUNDLED_PLUGINS_OFF, projectKind: (folder) => kinds.get(folder) });
    try {
      await services.ready();
      // A Web game's file says general, like any other project's.
      const web = await temporary();
      await writeProjectFile(web, (file) => file, { type: "general" });
      kinds.set(await projectFolderKey(web), { type: "web-game" });
      const resolved = await services.resolve(web);
      const on = resolved.ok ? resolved.plugins.map((plugin) => plugin.id) : [];
      expect(on).toContain("ohmygame/web-game-studio");
      expect(on).not.toContain("ohmygame/game-studio");
      await expect(services.setProjectPlugin(web, UNREAL_PLUGIN, true)).rejects.toThrow("doesn't work in web-game projects");
    } finally {
      await services.close();
    }
  });

  it("refuses to enable the current package where it doesn't apply", async () => {
    const kinds = new Map<string, { type: string }>();
    const services = new PluginServices({ directory: await temporary(), projectKind: (folder) => kinds.get(folder) });
    const tool = async (version: string, appliesTo?: string[]) => {
      const dir = path.join(await temporary(), `tool-${version}`);
      await mkdir(path.join(dir, ".ohmygame-plugin"), { recursive: true });
      await writeFile(path.join(dir, ".ohmygame-plugin/plugin.json"), JSON.stringify({
        id: "acme/tool", version, engines: { "ohmygame-api": "^2.0.0" }, displayName: "Tool", description: "Tool.",
        capabilities: { network: ["tool.example.com"] }, ...(appliesTo ? { appliesTo } : {}),
      }));
      return dir;
    };
    try {
      await services.ready();
      for (const root of [await tool("1.0.0"), await tool("2.0.0", ["web-game"])]) expect((await services.index.add(root)).ok).toBe(true);
      await services.consent("acme/tool", ["network:tool.example.com"]);
      const general = await temporary();
      kinds.set(await projectFolderKey(general), { type: "general" });
      await expect(services.setProjectPlugin(general, "acme/tool", true, { initialType: "general" })).rejects.toThrow("doesn't work in general projects");
      await expect(readProjectFile(general)).resolves.toBeUndefined();
      await writeFile(path.join(general, "ohmygame.json"), JSON.stringify({ type: "general", plugins: { "acme/tool": "1.0.0" } }));
      expect(await stateOf(general, services)).toEqual([["acme/tool", "not-applicable"]]);
    } finally {
      await services.close();
    }
  });

  it("runs a plugin only in the project types its appliesTo names", async () => {
    const services = new PluginServices({ directory: await temporary(), bundled: BUNDLED });
    try {
      await services.ready();
      const unreal = services.index.get(UNREAL_PLUGIN)!;
      const godot = services.index.get(GODOT_PLUGIN)!;
      expect(unreal.manifest.appliesTo).toEqual(["general"]);
      // An Interactive Story can't turn on Unreal, which suits General projects.
      const web = await temporary();
      await writeProjectFile(web, (file) => file, { type: "interactive-story" });
      await expect(services.setProjectPlugin(web, UNREAL_PLUGIN, true)).rejects.toThrow("doesn't work in interactive-story projects");
      // One the file asks for anyway (an older app, or by hand) doesn't run there, and can still be turned off.
      await writeProjectFile(web, (file) => ({ ...file, plugins: { [UNREAL_PLUGIN]: unreal.version } }));
      await services.consent(UNREAL_PLUGIN, capabilityGrants(unreal.manifest));
      expect(await stateOf(web, services)).toEqual([[UNREAL_PLUGIN, "not-applicable"]]);
      expect(await services.mcpServers(web)).toEqual({});
      await services.setProjectPlugin(web, UNREAL_PLUGIN, false);
      expect(await stateOf(web, services)).toEqual([]);
      // Godot names its own type, so a Godot project keeps it and can't add Unreal.
      const typed = await temporary();
      await createProjectPlugins({ folder: typed, type: GODOT_TYPE, plugins: { [GODOT_PLUGIN]: godot.version }, index: services.index, grants: services.grants });
      expect(await stateOf(typed, services)).toEqual([[GODOT_PLUGIN, "active"]]);
      await expect(services.setProjectPlugin(typed, UNREAL_PLUGIN, true)).rejects.toThrow("doesn't work in");
      // A General project can turn on both.
      const general = await temporary();
      await services.setProjectPlugin(general, UNREAL_PLUGIN, true, { initialType: "general" });
      await services.setProjectPlugin(general, GODOT_PLUGIN, true);
      expect(await stateOf(general, services)).toEqual([[GODOT_PLUGIN, "active"], [UNREAL_PLUGIN, "active"]]);
    } finally {
      await services.close();
    }
  });

  it("leaves out an HTTP MCP server whose saved URL is outside what the plugin may reach", async () => {
    const directory = await temporary();
    // As one saved by hand, or before the check, would be.
    await writeFile(path.join(directory, "configuration.json"), JSON.stringify({ version: 1, plugins: { [UNREAL_PLUGIN]: { endpoint: { type: "text", value: "http://192.168.1.5:8000/mcp" } } } }));
    const services = new PluginServices({ directory, bundled: BUNDLED });
    try {
      await services.ready();
      const entry = services.index.get(UNREAL_PLUGIN)!;
      const folder = await temporary();
      await writeProjectFile(folder, (file) => file, { type: "general", plugins: { [UNREAL_PLUGIN]: entry.version } });
      await services.consent(UNREAL_PLUGIN, capabilityGrants(entry.manifest));
      expect(services.values.view(entry).endpoint).toEqual({ type: "text", value: "http://192.168.1.5:8000/mcp" });
      expect(await services.mcpServers(folder)).toEqual({});
    } finally {
      await services.close();
    }
  });

  it("keeps plugin settings it can't read rather than replace them", async () => {
    const directory = await temporary();
    const saved = JSON.stringify({ version: 2, plugins: { [UNREAL_PLUGIN]: { endpoint: { type: "text", value: "http://127.0.0.1:8000/mcp" } } } });
    await writeFile(path.join(directory, "configuration.json"), saved);
    const services = new PluginServices({ directory, bundled: BUNDLED });
    try {
      await services.ready();
      const entry = services.index.get(UNREAL_PLUGIN)!;
      await expect(services.values.update(entry, { endpoint: "http://127.0.0.1:9000/mcp" })).rejects.toThrow("newer OhMyGame");
      await services.values.forget(UNREAL_PLUGIN);
      expect(await readFile(path.join(directory, "configuration.json"), "utf8")).toBe(saved);
    } finally {
      await services.close();
    }
  });

  it("starts the MCP servers of plugins the project allows, once their settings are filled in", async () => {
    const services = new PluginServices({ directory: await temporary() });
    try {
      const root = path.join(await temporary(), "maker");
      await mkdir(path.join(root, ".ohmygame-plugin"), { recursive: true });
      await writeFile(
        path.join(root, ".ohmygame-plugin/plugin.json"),
        JSON.stringify({
          id: "acme/maker",
          version: "1.0.0",
          engines: { "ohmygame-api": "^2.0.0" },
          displayName: "Maker",
          description: "Maker games.",
          configuration: {
            region: { type: "text", title: "Region" },
            token: { type: "secret", title: "Token" },
          },
          capabilities: { processes: ["maker"], secrets: true },
          projectFiles: ["./.maker/"],
          contributes: {
            mcpServers: [
              { id: "local", title: "Local", command: "maker", args: ["mcp", "--region", "${config.region}"], env: { HOME_HINT: "${HOME}" }, tools: ["build"], timeoutSeconds: 600 },
              { id: "signed-in", title: "Signed in", command: "maker", args: ["mcp"], env: { MAKER_TOKEN: "${config.token}" }, cwd: "./bin", tools: ["publish"] },
            ],
          },
        }),
      );
      const added = await services.index.add(root);
      expect(added.ok).toBe(true);
      const folder = await temporary();
      await writeProjectFile(folder, (file) => file, { type: "general", plugins: { "acme/maker": "1.0.0" } });
      expect(await services.mcpServers(folder)).toEqual({});
      const grants = ["process:maker", "secrets"];
      await services.grants.consent("acme/maker", grants);
      // Neither setting is filled in yet.
      expect(await services.mcpServers(folder)).toEqual({});
      const entry = services.index.get("acme/maker", "1.0.0")!;
      await services.values.update(entry, { region: "eu", token: "t0k" });
      const servers = await services.mcpServers(folder);
      const name = (id: string) => Object.keys(servers).find((key) => key.endsWith(`-v2-${id}`))!;
      expect(Object.keys(servers)).toHaveLength(2);
      expect(servers[name("local")]).toEqual({
        command: "maker",
        args: ["mcp", "--region", "eu"],
        // The adapter passes env as written, never reading the app's own;
        // the app adds the plugin's data folder.
        env: { HOME_HINT: "${HOME}", OHMYGAME_PLUGIN_DATA_DIR: services.dataFolder("acme/maker") },
        cwd: added.ok ? added.entry.root : "",
        literalEnv: true,
        includeTools: ["build"],
        requestTimeoutMs: 600_000,
        disabled: false,
      });
      expect(servers[name("signed-in")]).toEqual({
        command: "maker",
        args: ["mcp"],
        env: { MAKER_TOKEN: "t0k", OHMYGAME_PLUGIN_DATA_DIR: services.dataFolder("acme/maker") },
        cwd: added.ok ? path.join(added.entry.root, "bin") : "",
        literalEnv: true,
        includeTools: ["publish"],
        disabled: false,
      });
      // A setting can't make the adapter read the app's environment into args.
      await services.values.update(entry, { region: "{env:HOME}" });
      expect(Object.keys(await services.mcpServers(folder))).toEqual([name("signed-in")]);
      expect((await stat(services.dataFolder("acme/maker"))).isDirectory()).toBe(true);
      // An id from a route that isn't a plugin's never reaches the file system.
      const outside = path.join(services.dataFolder("acme/maker"), "..", "..", "..", "projects");
      await mkdir(outside, { recursive: true });
      await services.uninstall("../../projects");
      expect(() => services.dataFolder("../../projects")).toThrow("Not a plugin id");
      expect((await stat(outside)).isDirectory()).toBe(true);
      // Before uninstalling, it says what goes: the last version takes its settings and data.
      await writeFile(path.join(services.dataFolder("acme/maker"), "session.json"), "{}");
      expect(await services.uninstallPreview("acme/maker", "1.0.0")).toEqual({ last: true, settings: 2, dataBytes: 2, projectFiles: ["./.maker/"] });
      // Kept, they wait for a later install; what was allowed goes either way.
      await services.uninstall("acme/maker", "1.0.0", { keepData: true });
      expect(services.grants.plugin("acme/maker")).toBeUndefined();
      expect(services.values.count("acme/maker")).toBe(2);
      expect((await stat(path.join(services.dataFolder("acme/maker"), "session.json"))).isFile()).toBe(true);
      expect((await services.index.add(root)).ok).toBe(true);
      // Uninstalling the last version deletes the data folder.
      await services.uninstall("acme/maker");
      expect(services.values.count("acme/maker")).toBe(0);
      await expect(stat(services.dataFolder("acme/maker"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await services.close();
    }
  });

  it("asks again when a version wants more, only for what is new, and not again in each folder", async () => {
    const { index, grants, folder } = await setup();
    await createProjectPlugins({
      folder,
      type: "ohmygame/godot:godot-game",
      plugins: { "ohmygame/godot": "1.0.0" },
      index,
      grants,
    });
    await grants.consent("ohmygame/godot", [
      "native",
      "process:godot",
      "project.files:write",
    ]);
    expect(
      statuses(await resolveProjectPlugins({ folder, index, grants })),
    ).toEqual({ "ohmygame/godot": "active" });

    expect((await index.add(await godot("1.1.0", ["api.godotengine.org"]), { replace: true })).ok).toBe(true);
    const resolved = await resolveProjectPlugins({ folder, index, grants });
    expect(resolved?.ok && resolved.plugins[0]).toMatchObject({
      status: "needs-consent",
      missing: ["network:api.godotengine.org"],
    });
    // Allowed for the app, it runs in the folder that already turned it on.
    await grants.consent("ohmygame/godot", ["network:api.godotengine.org"]);
    expect(statuses(await resolveProjectPlugins({ folder, index, grants }))).toEqual({ "ohmygame/godot": "active" });
  });

  it("explains plugins that can't run: missing, off, incompatible", async () => {
    const { data, index, grants, folder } = await setup();
    await writeFile(
      path.join(folder, "ohmygame.json"),
      JSON.stringify({
        type: "general",
        plugins: {
          "ohmygame/godot": "0.9.0",
          "someone/tilemaps": "1.0.0",
          "ohmygame/game-studio": "1.0.0",
        },
      }),
    );
    await grants.consent("ohmygame/game-studio", []);
    // Safe mode is what turns a plugin off for the whole app.
    const safe = new PluginGrants(path.join(data, "plugin-grants.json"), { safeMode: true });
    await safe.load();
    let resolved = await resolveProjectPlugins({ folder, index, grants: safe });
    expect(resolved?.ok && resolved.plugins).toMatchObject([
      { id: "ohmygame/game-studio", status: "disabled" },
      { id: "ohmygame/godot", status: "disabled" },
      { id: "someone/tilemaps", status: "not-installed" },
    ]);
    expect(resolved?.ok && resolved.typeReady).toBe(true);

    // An index entry from before an app update that dropped its plugin API.
    const indexFile = path.join(data, "plugin-index.json");
    const stored = JSON.parse(await readFile(indexFile, "utf8"));
    for (const entry of stored.entries)
      entry.manifest.engines["ohmygame-api"] = "^1.0.0";
    await writeFile(indexFile, JSON.stringify(stored));
    const reloaded = new PluginIndex(indexFile);
    await reloaded.load();
    resolved = await resolveProjectPlugins({ folder, index: reloaded, grants });
    expect(resolved?.ok && resolved.plugins[0]).toMatchObject({
      id: "ohmygame/game-studio",
      status: "incompatible",
    });
  });

  it("brings version 1 decisions up to date once: what's installed is allowed, and one stopped everywhere is off and asks again", async () => {
    const { data } = await setup();
    const file = path.join(data, "old-grants.json");
    await writeFile(file, JSON.stringify({ schema: 1, plugins: {
      "ohmygame/godot": { enabled: false, allowed: [] },
      "someone/tilemaps": { enabled: true, allowed: ["network:a.example"], everyProject: true },
    }, projects: { "/games/maze": { "ohmygame/godot": { allowed: ["native"] }, "someone/tilemaps": { allowed: [] } } } }));
    const grants = new PluginGrants(file);
    await grants.load();
    await grants.upgrade(new Map([["ohmygame/godot", ["native"]], ["someone/tilemaps", ["network:b.example", "sessions"]], ["acme/new", []]]));
    expect(grants.plugin("ohmygame/godot")).toEqual({ enabled: true, everyProject: false, allowed: [] });
    expect(grants.plugin("someone/tilemaps")).toEqual({ enabled: true, everyProject: true, allowed: ["network:a.example", "network:b.example"] });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ schema: 3 });
    expect(JSON.parse(await readFile(file, "utf8"))).not.toHaveProperty("projects");
    // Once only: what's allowed later isn't widened again.
    await grants.upgrade(new Map([["someone/tilemaps", ["network:c.example"]]]));
    expect(grants.plugin("someone/tilemaps")?.allowed).toEqual(["network:a.example", "network:b.example"]);
    // A file from a newer app is left as it is, and a later change keeps what it doesn't know.
    await writeFile(file, JSON.stringify({ schema: 4, plugins: { "ohmygame/godot": { enabled: false, allowed: [] } }, projects: { "/game": {} } }));
    await grants.load();
    await grants.upgrade(new Map([["ohmygame/godot", ["native"]]]));
    await grants.consent("acme/new", []);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      schema: 4,
      plugins: { "ohmygame/godot": { enabled: false, allowed: [] }, "acme/new": { enabled: true, allowed: [] } },
      projects: { "/game": {} },
    });
  });

  it("drops version 2's per-folder approvals and keeps every other decision", async () => {
    const { data } = await setup();
    const file = path.join(data, "old-grants.json");
    const plugins = {
      "ohmygame/godot": { enabled: true, everyProject: false, allowed: ["native"] },
      "someone/tilemaps": { enabled: true, everyProject: true, allowed: ["network:a.example"] },
    };
    await writeFile(file, JSON.stringify({ schema: 2, plugins, projects: { "/games/maze": { "ohmygame/godot": { allowed: ["native"] } } } }));
    const grants = new PluginGrants(file);
    await grants.load();
    // What is installed now isn't consented to again: that was version 1's step.
    await grants.upgrade(new Map([["ohmygame/godot", ["native", "process:godot"]], ["acme/new", ["native"]]]));
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ schema: 3, plugins });
  });

  it("turns plugins on and off in a project, but not the type's plugin", async () => {
    const { index, grants, folder } = await setup();
    await createProjectPlugins({
      folder,
      type: "ohmygame/godot:godot-game",
      plugins: { "ohmygame/godot": "1.0.0" },
      index,
      grants,
    });
    await setProjectPlugin({
      folder,
      id: "ohmygame/game-studio",
      on: true,
      index,
      grants,
    });
    expect((await readProjectFile(folder))?.ok).toBe(true);

    await setProjectPlugin({
      folder,
      id: "ohmygame/game-studio",
      on: false,
      index,
      grants,
    });
    const file = await readProjectFile(folder);
    expect(file?.ok && file.file.plugins).toEqual({
      "ohmygame/godot": true,
    });
    await expect(
      setProjectPlugin({
        folder,
        id: "ohmygame/godot",
        on: false,
        index,
        grants,
      }),
    ).rejects.toThrow("provides the project's type");
    await expect(
      setProjectPlugin({
        folder,
        id: "acme/missing",
        on: true,
        index,
        grants,
      }),
    ).rejects.toThrow("not installed");
  });

  it("gives a project made before ohmygame.json one when it turns a plugin on", async () => {
    const { index, grants, folder } = await setup();
    await expect(setProjectPlugin({ folder, id: "ohmygame/game-studio", on: true, index, grants })).rejects.toThrow("does not exist");
    await setProjectPlugin({ folder, id: "ohmygame/game-studio", on: true, index, grants, initialType: "general" });
    const file = await readProjectFile(folder);
    expect(file?.ok && file.file).toMatchObject({ type: "general", plugins: { "ohmygame/game-studio": true } });
  });

  it("keeps decisions for the person, not in the project, and they cover every folder", async () => {
    const { data, index, grants, folder } = await setup();
    await createProjectPlugins({
      folder,
      type: "general",
      plugins: { "ohmygame/game-studio": "1.0.0" },
      index,
      grants,
    });
    await grants.consent("ohmygame/game-studio", []);
    const link = path.join(await temporary(), "link");
    await symlink(folder, link);
    expect(
      statuses(await resolveProjectPlugins({ folder: link, index, grants })),
    ).toEqual({ "ohmygame/game-studio": "active" });
    expect(
      await readFile(path.join(folder, "ohmygame.json"), "utf8"),
    ).not.toContain("allowed");

    // The same project copied to another folder runs it too.
    const copy = await temporary();
    await cp(
      path.join(folder, "ohmygame.json"),
      path.join(copy, "ohmygame.json"),
    );
    expect(
      statuses(await resolveProjectPlugins({ folder: copy, index, grants })),
    ).toEqual({ "ohmygame/game-studio": "active" });

    // Decisions survive a restart; an unreadable file means asking again.
    const reloaded = new PluginGrants(path.join(data, "plugin-grants.json"));
    await reloaded.load();
    expect(reloaded.plugin("ohmygame/game-studio")).toEqual({
      enabled: true,
      allowed: [],
    });
    await writeFile(path.join(data, "plugin-grants.json"), "{ not json");
    await reloaded.load();
    expect(reloaded.plugin("ohmygame/game-studio")).toBeUndefined();
  });

  it("reports an invalid project file instead of guessing", async () => {
    const { index, grants, folder } = await setup();
    await writeFile(path.join(folder, "ohmygame.json"), "{");
    expect(await resolveProjectPlugins({ folder, index, grants })).toEqual({
      ok: false,
      issues: ["ohmygame.json is not JSON"],
    });
  });
});

describe("project plugin writes", () => {
  it("keeps both of two changes made at once", async () => {
    const { index, grants, folder } = await setup();
    expect((await index.add(path.join(FIXTURES, "solarized"))).ok).toBe(true);
    await createProjectPlugins({
      folder,
      type: "general",
      plugins: {},
      index,
      grants,
    });
    await Promise.all(
      ["ohmygame/game-studio", "ohmygame/solarized"].map((id) =>
        setProjectPlugin({ folder, id, on: true, index, grants }),
      ),
    );
    const file = await readProjectFile(folder);
    expect(file?.ok && file.file.plugins).toEqual({
      "ohmygame/game-studio": true,
      "ohmygame/solarized": true,
    });
  });

  it("doesn't bring back a decision another writer took away", async () => {
    const { data, grants } = await setup();
    await grants.consent("ohmygame/godot", ["native"]);
    const other = new PluginGrants(path.join(data, "plugin-grants.json"));
    await other.load();
    await grants.forget("ohmygame/godot");
    await other.consent("ohmygame/game-studio", []);
    expect(other.plugin("ohmygame/godot")).toBeUndefined();

    // A reload waits for a change already under way.
    await Promise.all([
      grants.setEveryProject("ohmygame/godot", false),
      grants.load(),
    ]);
    expect(grants.plugin("ohmygame/godot")?.everyProject).toBe(false);
  });

  it("allows nothing when the decisions can't be read or saved", async () => {
    const data = await temporary();
    const file = path.join(data, "plugin-grants.json");
    await mkdir(file);
    const grants = new PluginGrants(file);
    await expect(grants.load()).rejects.toThrow();
    await expect(
      grants.consent("ohmygame/godot", []),
    ).rejects.toThrow();
    expect(grants.plugin("ohmygame/godot")).toBeUndefined();

    if (process.platform === "win32" || process.getuid?.() === 0) return;
    await rm(file, { recursive: true });
    await chmod(data, 0o500);
    try {
      await grants.load();
      await expect(
        grants.consent("ohmygame/godot", []),
      ).rejects.toThrow();
      expect(grants.plugin("ohmygame/godot")).toBeUndefined();
    } finally {
      await chmod(data, 0o700);
    }
  });
});


it("offers localized browser shortcuts only from active plugins", async () => {
  const services = new PluginServices({ directory: await temporary(), projectKind: () => ({ type: "general" }) });
  const root = await temporary();
  const folder = await temporary();
  await mkdir(path.join(root, ".ohmygame-plugin"));
  await mkdir(path.join(root, "locales"));
  await writeFile(path.join(root, ".ohmygame-plugin/plugin.json"), JSON.stringify({
    id: "acme/docs", version: "1.0.0", engines: { "ohmygame-api": "^2.5.0" }, displayName: "Docs", description: "Documentation links.",
    contributes: { browserShortcuts: [{ id: "guide", title: "%guide%", url: "https://docs.example.com/" }] },
  }));
  await writeFile(path.join(root, "locales/en.json"), JSON.stringify({ guide: "Guide" }));
  await writeFile(path.join(root, "locales/zh-CN.json"), JSON.stringify({ guide: "指南" }));
  try {
    await services.ready();
    expect((await services.index.add(root)).ok).toBe(true);
    await services.setProjectPlugin(folder, "acme/docs", true, { initialType: "general" });
    expect(await services.browserShortcuts(folder, "zh-CN")).toEqual([{ plugin: "acme/docs", pluginTitle: "Docs", title: "指南", url: "https://docs.example.com/" }]);
    expect((await services.browserShortcuts(folder))[0]?.title).toBe("Guide");
    await services.setProjectPlugin(folder, "acme/docs", false);
    expect(await services.browserShortcuts(folder)).toEqual([]);
  } finally {
    await services.close();
  }
});

/** A plugin with a Skill and native code whose `which` tool says which copy answered. */
async function carriedPlugin(dir: string, label: string, manifest: Record<string, unknown> = {}) {
  await mkdir(path.join(dir, ".ohmygame-plugin"), { recursive: true });
  await mkdir(path.join(dir, "tools"), { recursive: true });
  await mkdir(path.join(dir, "skills", "tool"), { recursive: true });
  await writeFile(path.join(dir, "skills", "tool", "SKILL.md"), `---\nname: tool\ndescription: The ${label} tool.\n---\n`);
  await writeFile(path.join(dir, "tools", "empty.json"), JSON.stringify({ type: "object", properties: {}, additionalProperties: false }));
  await writeFile(path.join(dir, "index.mjs"), `export function activate(context) { context.registerTool("which", () => ${JSON.stringify(label)}); }`);
  await writeFile(path.join(dir, ".ohmygame-plugin", "plugin.json"), JSON.stringify({
    id: "acme/tool", version: "1.0.0", engines: { "ohmygame-api": "^2.0.0" }, displayName: "Tool", description: "A tool.",
    appliesTo: ["general"], entrypoints: { native: "./index.mjs" }, capabilities: { native: true },
    contributes: { skills: "./skills/", tools: [{ name: "which", description: "Says which copy.", input: "./tools/empty.json" }] },
    ...manifest,
  }));
  return dir;
}

describe("plugins a project carries", () => {
  async function carrying(options: { engaged?: () => boolean; safeMode?: boolean } = {}) {
    const engaged = options.engaged;
    const services = new PluginServices({
      directory: await temporary(),
      hosts: { callTimeoutMs: 5_000, cancelGraceMs: 200 },
      ...(engaged ? { projectEngaged: async () => engaged() } : {}),
      ...(options.safeMode ? { safeMode: true } : {}),
    });
    expect((await services.install(await carriedPlugin(path.join(await temporary(), "tool"), "installed"))).ok).toBe(true);
    const folder = await temporary();
    await writeProjectFile(folder, (file) => file, { type: "general", plugins: { "acme/tool": "1.0.0" } });
    const copy = path.join(folder, ".ohmygame", "plugins", "acme", "tool");
    await carriedPlugin(copy, "copy", { version: "1.0.0-mine" });
    return { services, folder, copy };
  }

  it("uses the project's copy in its place, with nothing to allow, and only in that project", async () => {
    const { services, folder, copy } = await carrying();
    try {
      // Nothing was allowed: the installed one waits, the copy runs.
      const other = await temporary();
      await writeProjectFile(other, (file) => file, { type: "general", plugins: { "acme/tool": "1.0.0" } });
      expect(await stateOf(other, services)).toEqual([["acme/tool", "needs-consent"]]);
      const resolved = await services.resolve(folder);
      const state = resolved.ok ? resolved.plugins.find((plugin) => plugin.id === "acme/tool") : undefined;
      expect(state).toMatchObject({ status: "active", version: "1.0.0-mine", entry: { source: "project", root: await projectFolderKey(copy) } });
      expect((await services.skills(folder)).map((skill) => skill.path)).toEqual([path.join(await projectFolderKey(copy), "skills", "tool", "SKILL.md")]);
      expect(await services.native.callTool("acme/tool:which", { folder })).toBe("copy");

      // Off in the project writes `false`; on again takes it out.
      await services.setProjectPlugin(folder, "acme/tool", false);
      expect((await readProjectFile(folder))?.ok && (await readProjectFile(folder) as { file: { plugins: unknown } }).file.plugins).toEqual({ "acme/tool": false });
      expect(await stateOf(folder, services)).toEqual([["acme/tool", "off"]]);
      await services.setProjectPlugin(folder, "acme/tool", true);
      expect(await stateOf(folder, services)).toEqual([["acme/tool", "active"]]);
      expect(services.grants.plugin("acme/tool")).toBeUndefined();

      // An update leaves the project copy in place. Removing it restores the current package.
      expect((await readProjectFile(folder) as { file: { plugins?: unknown } }).file.plugins ?? {}).toEqual({});
      await writeProjectFile(folder, (file) => ({ ...file, plugins: { "acme/tool": "1.0.0" } }));
      await services.installAdded(await carriedPlugin(path.join(await temporary(), "tool-1.1.0"), "newer", { version: "1.1.0" }));
      expect(services.index.versions("acme/tool").map((entry) => entry.version)).toEqual(["1.1.0"]);
      expect(await services.native.callTool("acme/tool:which", { folder })).toBe("copy");
      await services.deleteCopy(folder, "acme/tool");
      expect(await services.native.callTool("acme/tool:which", { folder })).toBe("newer");
    } finally {
      await services.close();
    }
  });

  it("reads the copy again when it changes, and goes back to the installed one without it", async () => {
    const { services, folder, copy } = await carrying();
    try {
      await services.consent("acme/tool", ["native"]);
      expect(await services.native.callTool("acme/tool:which", { folder })).toBe("copy");
      await writeFile(path.join(copy, "index.mjs"), `export function activate(context) { context.registerTool("which", () => "edited"); }`);
      await vi.waitFor(async () => expect(await services.native.callTool("acme/tool:which", { folder })).toBe("edited"), { timeout: 5_000 });
      await rm(copy, { recursive: true });
      await vi.waitFor(async () => expect(await services.native.callTool("acme/tool:which", { folder })).toBe("installed"), { timeout: 5_000 });
    } finally {
      await services.close();
    }
  });

  it("says why a copy can't be used instead of running the installed one", async () => {
    const { services, folder, copy } = await carrying();
    try {
      await writeFile(path.join(copy, ".ohmygame-plugin", "plugin.json"), JSON.stringify({ id: "acme/other", version: "1.0.0", engines: { "ohmygame-api": "^2.0.0" }, displayName: "Other", description: "Other." }));
      const resolved = await services.resolve(folder);
      expect(resolved.ok && resolved.plugins.find((plugin) => plugin.id === "acme/tool")).toMatchObject({
        status: "invalid", issues: [expect.stringContaining("the manifest says acme/other")],
      });
      // Turning it on doesn't fall back to the installed one, or allow it.
      await services.setProjectPlugin(folder, "acme/tool", true);
      expect((await readProjectFile(folder) as { file: { plugins?: unknown } }).file.plugins ?? {}).toEqual({});
      expect(services.grants.plugin("acme/tool")).toBeUndefined();
    } finally {
      await services.close();
    }
  });

  it("carries nothing in a project from elsewhere until it starts, or in safe mode", async () => {
    let engaged = false;
    const { services, folder } = await carrying({ engaged: () => engaged });
    try {
      expect(await stateOf(folder, services)).toEqual([["acme/tool", "needs-consent"]]);
      engaged = true;
      await services.changed(folder);
      expect(await stateOf(folder, services)).toEqual([["acme/tool", "active"]]);
    } finally {
      await services.close();
    }
    const safe = await carrying({ safeMode: true });
    try {
      expect(await stateOf(safe.folder, safe.services)).toEqual([["acme/tool", "disabled"]]);
    } finally {
      await safe.services.close();
    }
  });
});
