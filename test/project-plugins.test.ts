import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginIndex } from "../src/daemon/plugin-index.js";
import { PluginServices } from "../src/daemon/plugin-services.js";
import {
  PluginGrants,
  createProjectPlugins,
  projectFolderKey,
  projectSkills,
  readProjectFile,
  resolveProjectPlugins,
  setProjectPlugin,
  writeProjectFile,
} from "../src/daemon/project-plugins.js";
import { validateProjectFile } from "../src/shared/project-file.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures/plugins-v2");
const BUNDLED = path.join(import.meta.dirname, "../plugins");

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

const statuses = (
  resolved: Awaited<ReturnType<typeof resolveProjectPlugins>>,
) =>
  resolved?.ok
    ? Object.fromEntries(
        resolved.plugins.map((plugin) => [plugin.id, plugin.status]),
      )
    : resolved;

describe("project file", () => {
  it("names a core or plugin type, and lists the type's plugin at an exact version", () => {
    expect(validateProjectFile({ type: "general" }).ok).toBe(true);
    expect(
      validateProjectFile({
        type: "ohmygame/godot:godot-game",
        plugins: { "ohmygame/godot": "1.0.0" },
      }).ok,
    ).toBe(true);
    expect(validateProjectFile({ type: "ohmygame/godot:godot-game" })).toEqual({
      ok: false,
      issues: ["/plugins must list ohmygame/godot, which provides the type"],
    });
    expect(
      validateProjectFile({ type: "general", plugins: { "a/b": "^1.0.0" } }),
    ).toEqual({ ok: false, issues: ["/plugins/a/b must be an exact version"] });
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
        '{\n  "$schema": "https://ohmygame.dev/schema/project-1.json"',
      ),
    ).toBe(true);
    expect(JSON.parse(text)).toMatchObject({
      layout: { future: "setting" },
      plugins: { "ohmygame/solarized": "1.0.0" },
    });
    expect(await readProjectFile(await temporary())).toBeUndefined();
  });
});

describe("project plugins", () => {
  it("asks before running what a cloned project requests", async () => {
    const { index, grants, folder } = await setup();
    await clonedProject(folder);

    // Installed, but nobody allowed anything yet.
    let resolved = await resolveProjectPlugins({ folder, index, grants });
    expect(statuses(resolved)).toEqual({
      "ohmygame/godot": "needs-consent",
      "ohmygame/game-studio": "needs-consent",
    });

    // Install consent alone doesn't allow them in this folder.
    for (const id of ["ohmygame/godot", "ohmygame/game-studio"])
      await grants.consent(
        id,
        id === "ohmygame/godot"
          ? ["native", "process:godot", "project.files:write"]
          : [],
      );
    resolved = await resolveProjectPlugins({ folder, index, grants });
    expect(statuses(resolved)).toEqual({
      "ohmygame/godot": "needs-approval",
      "ohmygame/game-studio": "needs-approval",
    });
    expect(resolved?.ok && resolved.typeReady).toBe(false);
    expect(resolved?.ok && resolved.plugins[0]).toMatchObject({
      id: "ohmygame/godot",
      providesType: true,
      missing: ["native", "process:godot", "project.files:write"],
    });

    const key = await projectFolderKey(folder);
    await grants.approve(key, "ohmygame/godot", [
      "native",
      "process:godot",
      "project.files:write",
    ]);
    await grants.approve(key, "ohmygame/game-studio", []);
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
      // Not yet allowed in this folder: no Skills.
      expect(await services.skills(folder)).toEqual([]);
      await services.grants.consent("ohmygame/game-studio", []);
      await services.grants.approve(await projectFolderKey(folder), "ohmygame/game-studio", []);
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
          contributes: {
            mcpServers: [
              { id: "local", title: "Local", command: "maker", args: ["mcp", "--region", "${config.region}"], env: { HOME_HINT: "${HOME}" }, tools: ["build"] },
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
      await services.grants.approve(await projectFolderKey(folder), "acme/maker", grants);
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
        // The adapter passes env as written, never reading the app's own.
        env: { HOME_HINT: "${HOME}" },
        cwd: added.ok ? added.entry.root : "",
        literalEnv: true,
        includeTools: ["build"],
        disabled: false,
      });
      expect(servers[name("signed-in")]).toEqual({
        command: "maker",
        args: ["mcp"],
        env: { MAKER_TOKEN: "t0k" },
        cwd: added.ok ? path.join(added.entry.root, "bin") : "",
        literalEnv: true,
        includeTools: ["publish"],
        disabled: false,
      });
      // A setting can't make the adapter read the app's environment into args.
      await services.values.update(entry, { region: "{env:HOME}" });
      expect(Object.keys(await services.mcpServers(folder))).toEqual([name("signed-in")]);
    } finally {
      await services.close();
    }
  });

  it("asks again when a version wants more, and only for what is new", async () => {
    const { index, grants, folder } = await setup();
    expect(
      (await index.add(await godot("1.1.0", ["api.godotengine.org"]))).ok,
    ).toBe(true);
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

    await writeProjectFile(folder, (file) => ({
      ...file,
      plugins: { "ohmygame/godot": "1.1.0" },
    }));
    let resolved = await resolveProjectPlugins({ folder, index, grants });
    expect(resolved?.ok && resolved.plugins[0]).toMatchObject({
      status: "needs-consent",
      missing: ["network:api.godotengine.org"],
    });
    await grants.consent("ohmygame/godot", ["network:api.godotengine.org"]);
    resolved = await resolveProjectPlugins({ folder, index, grants });
    expect(resolved?.ok && resolved.plugins[0]).toMatchObject({
      status: "needs-approval",
      missing: ["network:api.godotengine.org"],
    });
  });

  it("explains plugins that can't run: missing, other version, off, incompatible", async () => {
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
    await grants.setEnabled("ohmygame/game-studio", false);
    let resolved = await resolveProjectPlugins({ folder, index, grants });
    expect(resolved?.ok && resolved.plugins).toMatchObject([
      { id: "ohmygame/game-studio", status: "disabled" },
      {
        id: "ohmygame/godot",
        status: "version-not-installed",
        installed: ["1.0.0"],
      },
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
    await grants.setEnabled("ohmygame/game-studio", true);
    resolved = await resolveProjectPlugins({ folder, index: reloaded, grants });
    expect(resolved?.ok && resolved.plugins[0]).toMatchObject({
      id: "ohmygame/game-studio",
      status: "incompatible",
    });
  });

  it("keeps a plugin off that was turned off before anything was allowed", async () => {
    const { grants } = await setup();
    await grants.setEnabled("ohmygame/godot", false);
    expect(grants.plugin("ohmygame/godot")).toEqual({ enabled: false, allowed: [] });
    // Allowing it later doesn't turn it back on.
    await grants.consent("ohmygame/godot", ["network:api.godotengine.org"]);
    expect(grants.plugin("ohmygame/godot")?.enabled).toBe(false);
    // Turning on what was never allowed records nothing.
    await grants.setEnabled("someone/tilemaps", true);
    expect(grants.plugin("someone/tilemaps")).toBeUndefined();
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
      version: "1.0.0",
      index,
      grants,
    });
    expect((await readProjectFile(folder))?.ok).toBe(true);
    const key = await projectFolderKey(folder);
    expect(grants.project(key, "ohmygame/game-studio")).toEqual({
      allowed: [],
    });

    await setProjectPlugin({
      folder,
      id: "ohmygame/game-studio",
      version: null,
      index,
      grants,
    });
    expect(grants.project(key, "ohmygame/game-studio")).toBeUndefined();
    const file = await readProjectFile(folder);
    expect(file?.ok && file.file.plugins).toEqual({
      "ohmygame/godot": "1.0.0",
    });
    await expect(
      setProjectPlugin({
        folder,
        id: "ohmygame/godot",
        version: null,
        index,
        grants,
      }),
    ).rejects.toThrow("provides the project's type");
    await expect(
      setProjectPlugin({
        folder,
        id: "ohmygame/godot",
        version: "9.9.9",
        index,
        grants,
      }),
    ).rejects.toThrow("not installed");
  });

  it("gives a project made before ohmygame.json one when it turns a plugin on", async () => {
    const { index, grants, folder } = await setup();
    await expect(setProjectPlugin({ folder, id: "ohmygame/game-studio", version: "1.0.0", index, grants })).rejects.toThrow("does not exist");
    await setProjectPlugin({ folder, id: "ohmygame/game-studio", version: "1.0.0", index, grants, initialType: "general" });
    const file = await readProjectFile(folder);
    expect(file?.ok && file.file).toMatchObject({ type: "general", plugins: { "ohmygame/game-studio": "1.0.0" } });
  });

  it("keeps approvals by the folder's real path and for the person only", async () => {
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

    // The same project copied to another folder asks again.
    const copy = await temporary();
    await cp(
      path.join(folder, "ohmygame.json"),
      path.join(copy, "ohmygame.json"),
    );
    expect(
      statuses(await resolveProjectPlugins({ folder: copy, index, grants })),
    ).toEqual({ "ohmygame/game-studio": "needs-approval" });

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
        setProjectPlugin({ folder, id, version: "1.0.0", index, grants }),
      ),
    );
    const file = await readProjectFile(folder);
    expect(file?.ok && file.file.plugins).toEqual({
      "ohmygame/game-studio": "1.0.0",
      "ohmygame/solarized": "1.0.0",
    });
  });

  it("doesn't bring back a decision another writer took away", async () => {
    const { data, grants, folder } = await setup();
    const key = await projectFolderKey(folder);
    await grants.consent("ohmygame/godot", ["native"]);
    await grants.approve(key, "ohmygame/godot", ["native"]);
    const other = new PluginGrants(path.join(data, "plugin-grants.json"));
    await other.load();
    await grants.revoke(key, "ohmygame/godot");
    await other.consent("ohmygame/game-studio", []);
    expect(other.project(key, "ohmygame/godot")).toBeUndefined();

    // A reload waits for a change already under way.
    await Promise.all([
      grants.setEnabled("ohmygame/godot", false),
      grants.load(),
    ]);
    expect(grants.plugin("ohmygame/godot")?.enabled).toBe(false);
  });

  it("allows nothing when the decisions can't be read or saved", async () => {
    const data = await temporary();
    const file = path.join(data, "plugin-grants.json");
    await mkdir(file);
    const grants = new PluginGrants(file);
    await expect(grants.load()).rejects.toThrow();
    await expect(
      grants.approve("/project", "ohmygame/godot", []),
    ).rejects.toThrow();
    expect(grants.project("/project", "ohmygame/godot")).toBeUndefined();

    if (process.platform === "win32" || process.getuid?.() === 0) return;
    await rm(file, { recursive: true });
    await chmod(data, 0o500);
    try {
      await grants.load();
      await expect(
        grants.approve("/project", "ohmygame/godot", []),
      ).rejects.toThrow();
      expect(grants.project("/project", "ohmygame/godot")).toBeUndefined();
    } finally {
      await chmod(data, 0o700);
    }
  });
});
