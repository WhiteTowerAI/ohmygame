import { createHash, generateKeyPairSync, sign as sign_ } from "node:crypto";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import { PluginServices } from "../src/daemon/plugin-services.js";
import { availableUpdates, downloadRelease, installRelease, readCatalog, releaseMessage } from "../src/daemon/plugin-releases.js";
import { compileWhen, matchesWhen } from "../src/shared/plugin-when.js";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PLUGIN_INDEX_SCHEMA_VERSION,
  PluginIndex,
  indexPluginPackage,
  localizePluginString,
} from "../src/daemon/plugin-index.js";
import {
  pluginApiIssue,
  satisfiesVersionRange,
  toolSchemaIssues,
  validatePluginManifest,
} from "../src/shared/plugin-manifest.js";
import {
  PLUGIN_SCHEMA_FILE,
  pluginSchemaJson,
} from "../scripts/plugin-schema.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures/plugins-v2");
const BUNDLED = path.join(import.meta.dirname, "../plugins-v2");

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function temporary() {
  const dir = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-v2-"));
  cleanup.push(dir);
  return dir;
}

/** The Solarized example, copied so a test can change it. */
async function solarized() {
  const dir = path.join(await temporary(), "solarized");
  await cp(path.join(FIXTURES, "solarized"), dir, { recursive: true });
  return dir;
}

/** Game Studio as format 2: the bundled skills and icon with the new manifest. */
async function gameStudio() {
  const dir = path.join(await temporary(), "game-studio");
  await cp(path.join(BUNDLED, "game-studio"), dir, { recursive: true });
  await cp(path.join(FIXTURES, "game-studio"), dir, { recursive: true });
  return dir;
}

async function editManifest(dir: string, edit: (manifest: any) => void) {
  const file = path.join(dir, ".ohmygame-plugin/plugin.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  edit(manifest);
  await writeFile(file, JSON.stringify(manifest));
}

const minimal = {
  id: "someone/example",
  version: "1.0.0",
  engines: { "ohmygame-api": "^2.0.0" },
  displayName: "Example",
  description: "An example.",
};

const messages = (value: unknown) => {
  const result = validatePluginManifest(value);
  return result.ok
    ? []
    : result.issues.map((issue) => `${issue.path} ${issue.message}`);
};

describe("plugin manifest format 2", () => {
  it("publishes a JSON Schema that matches its source", async () => {
    expect(await readFile(PLUGIN_SCHEMA_FILE, "utf8")).toBe(pluginSchemaJson());
  });

  it("accepts a minimal manifest", () => {
    expect(messages(minimal)).toEqual([]);
  });

  it("rejects unknown fields and format 1 fields", () => {
    expect(
      messages({ ...minimal, interface: { displayName: "X" } }),
    ).toContainEqual(expect.stringContaining("additional properties"));
    expect(messages({ ...minimal, id: "example" })).toContainEqual(
      expect.stringMatching(/^\/id /),
    );
  });

  it("checks rules the schema can't express", () => {
    expect(
      messages({ ...minimal, entrypoints: { native: "./native/index.js" } }),
    ).toEqual([
      "/capabilities/native a native entrypoint needs the native capability",
    ]);
    expect(
      messages({
        ...minimal,
        contributes: {
          tools: [{ name: "run", description: "Runs.", input: "./run.json" }],
          commands: [{ id: "go", title: "Go", run: { tool: "missing" } }],
        },
      }),
    ).toEqual([
      "/contributes/tools tools run in the native entrypoint",
      "/contributes/commands/0/run/tool no tool named missing",
    ]);
    expect(
      messages({
        ...minimal,
        configuration: {
          token: { type: "secret", title: "Token", default: "x" },
          mode: { type: "select", title: "Mode", options: ["a"], default: "b" },
        },
      }),
    ).toEqual([
      "/configuration/token/default a secret can't have a default",
      "/configuration/mode/default must be one of the options",
    ]);
    expect(
      messages({
        ...minimal,
        configuration: { region: { type: "text", title: "Region" } },
        contributes: {
          providers: [
            {
              id: "relay",
              title: "Relay",
              api: "openai-completions",
              baseUrl: "https://relay.example/v1",
              apiKey: "region",
            },
          ],
        },
      }),
    ).toEqual([
      "/contributes/providers/0/apiKey must name a secret configuration field",
      "/contributes/providers/0 list models or discover them",
    ]);
  });

  it("checks MCP servers against what the plugin may run and read", () => {
    const server = (fields: object) => ({
      ...minimal,
      configuration: {
        region: { type: "text", title: "Region" },
        token: { type: "secret", title: "Token" },
      },
      capabilities: { processes: ["maker"] },
      contributes: { mcpServers: [{ id: "maker", title: "Maker", command: "maker", tools: ["build"], ...fields }] },
    });
    // env is passed as written, so it may name variables.
    expect(messages(server({ args: ["--region", "${config.region}"], env: { HOME_HINT: "${HOME}" } }))).toEqual([]);
    expect(messages(server({ command: "node", env: { TOKEN: "${config.token}", MODE: "${config.mode}" } }))).toEqual([
      "/contributes/mcpServers/0/command node must be listed in capabilities.processes",
      "/contributes/mcpServers/0 token is a secret, which needs capabilities.secrets",
      "/contributes/mcpServers/0 no configuration field mode",
    ]);
    // The adapter would read the app's environment into args and cwd.
    expect(messages(server({ args: ["$env:HOME"] }))).toEqual([
      "/contributes/mcpServers/0 args and cwd can't name environment variables",
    ]);
    // The app sets the data folder variable; a request may take up to an hour.
    expect(messages(server({ env: { ohmygame_plugin_data_dir: "/tmp" }, timeoutSeconds: 3600 }))).toEqual([
      "/contributes/mcpServers/0/env OHMYGAME_PLUGIN_DATA_DIR is set by the app",
    ]);
    expect(messages(server({ timeoutSeconds: 3601 }))).toContainEqual(expect.stringContaining("/contributes/mcpServers/0/timeoutSeconds"));
    // HTTP servers wait for a guard on redirects.
    expect(messages(server({ url: "https://localhost/mcp" }))).toEqual([
      "/contributes/mcpServers/0 must not have additional properties",
    ]);
  });

  it("closes keyed records and never throws on bad values", () => {
    for (const configuration of [
      { "bad-key": { type: "made-up", title: 42 } },
      { "bad-key": null },
      { ["a".repeat(70)]: { type: "text", title: "Long" } },
    ])
      expect(messages({ ...minimal, configuration })).toEqual([
        "/configuration must not have additional properties",
      ]);
    expect(
      messages({
        ...minimal,
        contributes: { themes: [{ id: "t", title: "T", dark: { color: 1 } }] },
      }),
    ).toContainEqual(expect.stringContaining("additional properties"));
  });

  it("only accepts canonical project-relative paths for recognition", () => {
    const recognize = (files: string[]) =>
      messages({
        ...minimal,
        contributes: {
          projectTypes: [
            { id: "t", title: "T", preview: "web", recognize: { files } },
          ],
        },
      });
    expect(
      recognize([
        "project.godot",
        ".gitignore",
        "ProjectSettings/ProjectVersion.txt",
      ]),
    ).toEqual([]);
    for (const bad of [
      "C:/outside",
      "C:outside",
      "/abs",
      "../up",
      "a/../b",
      ".",
      "a\\b",
      "a\u0000b",
      "*.godot",
    ])
      expect(recognize([bad]), bad).toHaveLength(1);
  });

  it("checks tool schemas against the supported dialect", () => {
    expect(
      toolSchemaIssues({
        type: "object",
        properties: { scene: { type: "string" } },
      }),
    ).toEqual([]);
    expect(toolSchemaIssues({ type: "object", properties: 7 })).toEqual([
      "/properties must be an object of schemas",
    ]);
    expect(
      toolSchemaIssues({
        type: "object",
        properties: { a: { $ref: "https://x.test/s" } },
      }),
    ).toEqual(["/properties/a/$ref may only point inside the schema"]);
    expect(toolSchemaIssues({ type: "object", if: {} })).toEqual([
      "/if is not a supported keyword",
    ]);
    expect(toolSchemaIssues({ type: "string" })).toEqual([
      "/type must be object",
    ]);
    expect(
      toolSchemaIssues({
        type: "object",
        minProperties: -1,
        properties: {
          a: { type: "string", minLength: 0.5 },
          b: { type: "number", multipleOf: 0 },
          c: { $ref: "#/$defs/missing" },
          d: { $ref: "#/$defs/name" },
        },
        $defs: { name: { type: "string" } },
      }),
    ).toEqual([
      "/minProperties must be a non-negative integer",
      "/properties/a/minLength must be a non-negative integer",
      "/properties/b/multipleOf must be greater than 0",
      "/properties/c/$ref points at nothing in the schema",
    ]);
  });

  it("limits themes to colour tokens", () => {
    expect(
      messages({
        ...minimal,
        contributes: {
          themes: [
            {
              id: "loud",
              title: "Loud",
              dark: {
                "--gray-0": "#000",
                "--color-accent": "red; background: url(x)",
                "--radius-md": "0",
              },
            },
          ],
        },
      }),
    ).toEqual([
      "/contributes/themes/0/dark/--color-accent must be a colour",
      "/contributes/themes/0/dark/--radius-md not a theme token",
    ]);
  });

  it("matches the plugin API version against a manifest's range", () => {
    expect(satisfiesVersionRange("2.3.1", "^2.0.0")).toBe(true);
    expect(satisfiesVersionRange("3.0.0", "^2.0.0")).toBe(false);
    expect(satisfiesVersionRange("0.4.2", "^0.4.0")).toBe(true);
    expect(satisfiesVersionRange("0.5.0", "^0.4.0")).toBe(false);
    expect(satisfiesVersionRange("2.1.9", "~2.1.0")).toBe(true);
    expect(satisfiesVersionRange("2.2.0", "~2.1.0")).toBe(false);
    expect(satisfiesVersionRange("9.0.0", ">=2.0.0")).toBe(true);
    expect(satisfiesVersionRange("2.0.1", "2.0.0")).toBe(false);
    expect(satisfiesVersionRange("0.0.1", "^0.0.1")).toBe(true);
    expect(satisfiesVersionRange("0.0.9", "^0.0.1")).toBe(false);
    expect(satisfiesVersionRange("2.1.0-beta.1", "^2.0.0")).toBe(false);
    expect(satisfiesVersionRange("2.0.0-rc.1", "2.0.0")).toBe(false);
    expect(satisfiesVersionRange("2.0.0+build.7", "2.0.0")).toBe(true);
    expect(
      messages({ ...minimal, engines: { "ohmygame-api": "^02.0.0" } }),
    ).toHaveLength(1);
    expect(pluginApiIssue({ engines: { "ohmygame-api": "^3.0.0" } })).toContain(
      "^3.0.0",
    );
  });
});

describe("when", () => {
  const context = {
    values: { "project.type": "godot-game", "selection.count": 2, platform: "darwin" },
    plugins: new Set(["ohmygame/godot"]),
  } as const;
  const check = (text: string) => {
    const compiled = compileWhen(text);
    if (!compiled.ok) throw new Error(compiled.error);
    return compiled.evaluate(context);
  };

  it("evaluates names, plugins, comparisons and logic", () => {
    expect(check("project.type == 'godot-game'")).toBe(true);
    expect(check("project.plugin('ohmygame/godot') && !project.plugin(\"acme/other\")")).toBe(true);
    expect(check("selection.count == 2 || platform == 'win32'")).toBe(true);
    expect(check("!(platform == 'darwin')")).toBe(false);
    // A name with no value is false and equals nothing.
    expect(check("preview.status")).toBe(false);
    expect(check("preview.status == 'ready'")).toBe(false);
    expect(matchesWhen(undefined, context)).toBe(true);
    expect(matchesWhen("broken ==", context)).toBe(false);
  });

  it("refuses what isn't in the language", () => {
    for (const text of [
      "window.location",
      "project.plugin(id)",
      "project.type = 'x'",
      "(platform == 'darwin'",
      "platform == 'darwin' extra",
      "`x`",
      "!".repeat(30) + "platform",
    ])
      expect(compileWhen(text).ok, text).toBe(false);
    expect(
      messages({
        ...minimal,
        entrypoints: { native: "./index.mjs" },
        contributes: {
          commands: [
            { id: "go", title: "Go", run: { native: "go" }, slots: [{ slot: "project.menu", when: "selection.size > 1" }] },
          ],
        },
      }).some((message) => message.startsWith("/contributes/commands/0/slots/0/when")),
    ).toBe(true);
  });
});

describe("plugin index", () => {
  it("indexes the example theme with its strings", async () => {
    const result = await indexPluginPackage(await solarized());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.id).toBe("ohmygame/solarized");
    expect(result.entry.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(
      localizePluginString(
        result.entry,
        result.entry.manifest.description,
        "zh-CN",
      ),
    ).toContain("Solarized 配色");
    expect(localizePluginString(result.entry, "Plain", "zh-CN")).toBe("Plain");
  });

  it("indexes a bundled skills plugin rewritten for format 2", async () => {
    const result = await indexPluginPackage(await gameStudio());
    expect(result.ok ? [] : result.issues).toEqual([]);
    if (!result.ok) return;
    expect(result.entry.skills.map((skill) => skill.name).sort()).toEqual([
      "game-foundations",
      "game-qa",
      "game-studio",
    ]);
    expect(
      result.entry.skills.every((skill) => skill.description.length > 0),
    ).toBe(true);
  });

  it("indexes the format 2 Godot plugin with its type, tools and command", async () => {
    const result = await indexPluginPackage(
      path.join(BUNDLED, "godot"),
    );
    expect(result.ok ? [] : result.issues).toEqual([]);
    if (!result.ok) return;
    const { manifest } = result.entry;
    expect(manifest.contributes?.projectTypes?.[0]).toMatchObject({
      id: "godot-game",
      recognize: { files: ["project.godot"] },
      preview: "web-build",
    });
    expect(manifest.contributes?.tools?.map((tool) => tool.name)).toEqual([
      "godot_status",
      "run_headless",
      "export_web",
    ]);
    expect(Object.keys(result.entry.toolSchemas ?? {}).length).toBeGreaterThan(0);
    expect(result.entry.skills.map((skill) => skill.name)).toEqual([
      "godot-game",
    ]);
    expect(
      localizePluginString(
        result.entry,
        manifest.contributes!.commands![0]!.title,
        "zh-CN",
      ),
    ).toBe("在 Godot 中运行");
    expect(manifest.contributes?.mcpServers).toMatchObject([
      { id: "godot", command: "node", args: ["./native/mcp.mjs"], env: { OHMYGAME_GODOT_SETTING: "${config.godotPath}" } },
    ]);
  });

  it("starts godot-mcp with the Godot the plugin's tools find", async () => {
    const dir = await temporary();
    const godot = path.join(dir, "Godot", process.platform === "win32" ? "godot.exe" : "godot");
    await mkdir(path.dirname(godot), { recursive: true });
    await writeFile(godot, "", { mode: 0o755 });
    const bin = path.join(dir, "bin");
    await mkdir(bin);
    // Stands in for npx: says what it was given, and exits as godot-mcp might.
    if (process.platform === "win32") await writeFile(path.join(bin, "npx.cmd"), "@echo off\r\necho %GODOT_PATH% %*\r\nexit /b 3\r\n");
    else await writeFile(path.join(bin, "npx"), '#!/bin/sh\necho "$GODOT_PATH $*"\nexit 3\n', { mode: 0o755 });
    const { Path: _windowsPath, ...env } = process.env;
    const result = spawnSync(process.execPath, [path.join(BUNDLED, "godot", "native", "mcp.mjs")], {
      env: { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ""}`, OHMYGAME_GODOT_SETTING: godot },
      encoding: "utf8",
    });
    expect(result.stdout.trim()).toBe(`${godot} -y @coding-solo/godot-mcp@0.1.1`);
    expect(result.status).toBe(3);
  });

  it.skipIf(process.platform === "win32")("stops what godot-mcp started when its launcher is stopped", async () => {
    const dir = await temporary();
    const pidFile = path.join(dir, "game.pid");
    // Stands in for npx running godot-mcp with a game it started.
    await writeFile(path.join(dir, "npx"), '#!/bin/sh\nsleep 60 &\necho $! > "$GAME_PID_FILE"\nwait\n', { mode: 0o755 });
    const launcher = spawn(process.execPath, [path.join(BUNDLED, "godot", "native", "mcp.mjs")], {
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`, GAME_PID_FILE: pidFile },
      stdio: "ignore",
    });
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let game = 0;
    await vi.waitFor(async () => {
      game = Number(await readFile(pidFile, "utf8"));
      expect(alive(game)).toBe(true);
    }, { timeout: 10_000 });
    const exited = new Promise((resolve) => launcher.once("exit", resolve));
    launcher.kill("SIGTERM");
    await exited;
    await vi.waitFor(() => expect(alive(game)).toBe(false), { timeout: 5_000 });
  });

  it("reads strings only from display fields", async () => {
    const dir = await gameStudio();
    await editManifest(dir, (manifest) => {
      manifest.contributes.commands[0].run.prompt =
        "Use %HOME% as the base folder.";
    });
    expect((await indexPluginPackage(dir)).ok).toBe(true);
  });

  it("reports missing files, strings and skills", async () => {
    const dir = await gameStudio();
    await editManifest(dir, (manifest) => {
      manifest.icon = "./assets/missing.svg";
      manifest.contributes.commands[0].title = "%starter.unknown%";
      manifest.contributes.commands[1].run.skill = "level-design";
    });
    const result = await indexPluginPackage(dir);
    expect(result.ok ? [] : result.issues).toEqual([
      { path: "/icon", message: "./assets/missing.svg is not in the package" },
      {
        path: "/contributes/commands/1/run/skill",
        message: "no skill named level-design",
      },
      { path: "./locales/en.json", message: "missing %starter.unknown%" },
    ]);
  });

  it("refuses links and plugins for another plugin API", async () => {
    const linked = await solarized();
    await symlink("/etc/hosts", path.join(linked, "assets/hosts"));
    expect(await indexPluginPackage(linked)).toEqual({
      ok: false,
      issues: [
        { path: "./assets/hosts", message: "packages can't contain links" },
      ],
    });
    const newer = await solarized();
    await editManifest(newer, (manifest) => {
      manifest.engines["ohmygame-api"] = "^3.0.0";
    });
    const result = await indexPluginPackage(newer);
    expect(result.ok ? [] : result.issues.map((issue) => issue.path)).toEqual([
      "/engines/ohmygame-api",
    ]);
  });

  it("loads from its own file without reading packages", async () => {
    const file = path.join(await temporary(), "plugin-index.json");
    const index = new PluginIndex(file);
    const theme = await solarized();
    expect((await index.add(theme)).ok).toBe(true);
    expect((await index.add(await gameStudio())).ok).toBe(true);
    await rm(theme, { recursive: true });

    const reloaded = new PluginIndex(file);
    await reloaded.load();
    expect(reloaded.entries().map((entry) => entry.id)).toEqual([
      "ohmygame/game-studio",
      "ohmygame/solarized",
    ]);
    expect(reloaded.contributions("themes").map((theme) => theme.id)).toEqual([
      "ohmygame/solarized:solarized",
    ]);
    expect(
      reloaded.contributions("commands").map((command) => command.id),
    ).toEqual([
      "ohmygame/game-studio:create-game",
      "ohmygame/game-studio:add-feature",
      "ohmygame/game-studio:fix-bug",
    ]);
    // Checking against the disk drops the package that is gone.
    expect(await reloaded.verify("ohmygame/solarized", "1.0.0")).toBe(false);
    expect(reloaded.get("ohmygame/solarized")).toBeUndefined();
  });

  it("re-indexes a package that changed, and an index written by another schema", async () => {
    const file = path.join(await temporary(), "plugin-index.json");
    const index = new PluginIndex(file);
    const theme = await solarized();
    await index.add(theme);
    const before = index.get("ohmygame/solarized")!.digest;

    await writeFile(
      path.join(theme, "locales/en.json"),
      JSON.stringify({
        displayName: "Solarized",
        description: "Changed.",
        "theme.title": "Solarized",
      }),
    );
    expect(await index.verify("ohmygame/solarized", "1.0.0")).toBe(true);
    expect(index.get("ohmygame/solarized")!.strings.en?.description).toBe(
      "Changed.",
    );
    expect(index.get("ohmygame/solarized")!.digest).not.toBe(before);

    const stored = JSON.parse(await readFile(file, "utf8"));
    await writeFile(
      file,
      JSON.stringify({
        schema: 0,
        entries: [{ ...stored.entries[0], strings: {} }],
      }),
    );
    const rebuilt = new PluginIndex(file);
    await rebuilt.load();
    expect(rebuilt.get("ohmygame/solarized")!.strings.en?.description).toBe(
      "Changed.",
    );
    expect(JSON.parse(await readFile(file, "utf8")).schema).toBe(
      PLUGIN_INDEX_SCHEMA_VERSION,
    );
  });

  it("drops an entry whose package now holds another version", async () => {
    const index = new PluginIndex(
      path.join(await temporary(), "plugin-index.json"),
    );
    const theme = await solarized();
    await index.add(theme);
    await editManifest(theme, (manifest) => {
      manifest.version = "1.1.0";
    });
    expect(await index.verify("ohmygame/solarized", "1.0.0")).toBe(false);
    expect(index.versions("ohmygame/solarized")).toEqual([]);
  });

  it("keeps versions side by side", async () => {
    const file = path.join(await temporary(), "plugin-index.json");
    const index = new PluginIndex(file);
    const older = await solarized();
    const newer = await solarized();
    await editManifest(newer, (manifest) => {
      manifest.version = "1.2.0";
    });
    await index.add(older);
    await index.add(newer);
    const reloaded = new PluginIndex(file);
    await reloaded.load();
    expect(
      reloaded.versions("ohmygame/solarized").map((entry) => entry.version),
    ).toEqual(["1.2.0", "1.0.0"]);
    expect(reloaded.get("ohmygame/solarized")?.version).toBe("1.2.0");
    expect(
      reloaded.contributions("themes").map((theme) => theme.version),
    ).toEqual(["1.2.0"]);
    await reloaded.remove("ohmygame/solarized", "1.2.0");
    expect(await reloaded.verify("ohmygame/solarized", "1.0.0")).toBe(true);
    expect(reloaded.get("ohmygame/solarized")?.version).toBe("1.0.0");
  });

  it("saves concurrent changes in order", async () => {
    const file = path.join(await temporary(), "plugin-index.json");
    const index = new PluginIndex(file);
    const packages = await Promise.all([
      solarized(),
      gameStudio(),
      solarized(),
    ]);
    await editManifest(packages[2]!, (manifest) => {
      manifest.version = "2.0.0";
    });
    await Promise.all([
      ...packages.map((root) => index.add(root)),
      index.remove("ohmygame/solarized", "1.0.0"),
    ]);
    const reloaded = new PluginIndex(file);
    await reloaded.load();
    const ids = (plugins: PluginIndex) =>
      plugins.entries().map((entry) => `${entry.id}@${entry.version}`);
    expect(ids(reloaded)).toEqual(ids(index));
    expect(ids(index)).toEqual([
      "ohmygame/game-studio@1.0.0",
      "ohmygame/solarized@2.0.0",
    ]);
  });

  it("qualifies tool ids and gives agents unique names", async () => {
    const index = new PluginIndex(
      path.join(await temporary(), "plugin-index.json"),
    );
    for (const id of ["one/godot", "two/godot"]) {
      const dir = path.join(await temporary(), "tool");
      await mkdir(path.join(dir, ".ohmygame-plugin"), { recursive: true });
      await mkdir(path.join(dir, "native"));
      await writeFile(
        path.join(dir, "native/index.js"),
        "export function activate() {}",
      );
      await writeFile(
        path.join(dir, "run.json"),
        JSON.stringify({
          type: "object",
          properties: { scene: { type: "string" } },
        }),
      );
      await writeFile(
        path.join(dir, ".ohmygame-plugin/plugin.json"),
        JSON.stringify({
          ...minimal,
          id,
          entrypoints: { native: "./native/index.js" },
          capabilities: { native: true },
          contributes: {
            tools: [
              {
                name: "run_scene",
                description: "Runs a scene.",
                input: "./run.json",
              },
            ],
          },
        }),
      );
      expect((await index.add(dir)).ok).toBe(true);
    }
    expect(
      index.contributions("tools").map(({ id, agentName }) => [id, agentName]),
    ).toEqual([
      ["one/godot:run_scene", "one__godot__run_scene"],
      ["two/godot:run_scene", "two__godot__run_scene"],
    ]);
  });

  it("keeps tool schemas from the indexed bytes, within a size limit", async () => {
    const dir = path.join(await temporary(), "tool");
    await mkdir(path.join(dir, ".ohmygame-plugin"), { recursive: true });
    await writeFile(
      path.join(dir, "index.js"),
      "export function activate() {}",
    );
    const schema = {
      type: "object",
      properties: { scene: { type: "string" } },
    };
    await writeFile(path.join(dir, "run.json"), JSON.stringify(schema));
    const manifest = (input: string) =>
      writeFile(
        path.join(dir, ".ohmygame-plugin/plugin.json"),
        JSON.stringify({
          ...minimal,
          id: "one/tools",
          entrypoints: { native: "./index.js" },
          capabilities: { native: true },
          contributes: {
            tools: [{ name: "run_scene", description: "Runs a scene.", input }],
          },
        }),
      );
    await manifest("./run.json");
    const indexed = await indexPluginPackage(dir);
    expect(indexed.ok && indexed.entry.toolSchemas).toEqual({
      "./run.json": schema,
    });

    await writeFile(
      path.join(dir, "huge.json"),
      JSON.stringify({ type: "object", description: "x".repeat(40_000) }),
    );
    await manifest("./huge.json");
    expect(await indexPluginPackage(dir)).toMatchObject({
      ok: false,
      issues: [
        {
          path: "/contributes/tools/0/input",
          message: "./huge.json is larger than 32 KB",
        },
      ],
    });
  });

  it("refuses special files without blocking, and deep or crowded packages", async () => {
    // Windows has no FIFOs to make; the other limits hold there too.
    if (process.platform !== "win32") {
      const fifo = await solarized();
      execFileSync("mkfifo", [path.join(fifo, "assets/pipe")]);
      expect(await indexPluginPackage(fifo)).toEqual({
        ok: false,
        issues: [
          {
            path: "./assets/pipe",
            message: "packages can only contain files and folders",
          },
        ],
      });
    }
    const deep = await solarized();
    await mkdir(path.join(deep, ...Array.from({ length: 22 }, () => "d")), {
      recursive: true,
    });
    expect(await indexPluginPackage(deep)).toMatchObject({
      ok: false,
      issues: [{ message: "folders nest too deeply" }],
    });
    const crowded = await solarized();
    await Promise.all(
      Array.from({ length: 5_001 }, (_, index) =>
        mkdir(path.join(crowded, `d${index}`)),
      ),
    );
    expect(await indexPluginPackage(crowded)).toMatchObject({
      ok: false,
      issues: [{ message: "too many files" }],
    });
  });
});

describe("plugin releases", () => {
  async function zipPackage(dir: string, file: string, wrapper = "") {
    const zip = new ZipFile();
    const add = async (folder: string) => {
      for (const item of await readdir(path.join(dir, folder), { withFileTypes: true })) {
        const relative = folder ? `${folder}/${item.name}` : item.name;
        if (item.isDirectory()) await add(relative);
        else zip.addFile(path.join(dir, relative), wrapper ? `${wrapper}/${relative}` : relative);
      }
    };
    await add("");
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(file));
  }

  async function setup({ wrapper = "", prepare }: { wrapper?: string; prepare?: (dir: string) => Promise<void> } = {}) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const keys = {
      test: { publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"), publishers: ["ohmygame"] },
    };
    const dir = await temporary();
    const archive = path.join(dir, "solarized.zip");
    const packageDir = await solarized();
    await prepare?.(packageDir);
    await zipPackage(packageDir, archive, wrapper);
    const bytes = await readFile(archive);
    const release = {
      id: "ohmygame/solarized",
      version: "1.0.0",
      url: "https://plugins.example/solarized-1.0.0.zip",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      key: "test",
      signature: "",
    };
    const sign = (value: typeof release) => ({ ...value, signature: sign_(null, releaseMessage(value), privateKey).toString("base64") });
    const services = new PluginServices({ directory: path.join(dir, "store") });
    const downloads: string[] = [];
    const download = async (url: string, file: string) => {
      downloads.push(url);
      await writeFile(file, bytes);
    };
    const install = (value: unknown) =>
      installRelease({ release: value, keys, services, directory: path.join(dir, "store/packages"), download });
    return { dir, release, sign, services, install, downloads, close: () => services.close() };
  }

  it("installs a signed release side by side and finds newer ones", async () => {
    const { release, sign, services, install, close } = await setup();
    try {
      const entry = await install(sign(release));
      expect(entry).toMatchObject({ id: "ohmygame/solarized", version: "1.0.0" });
      expect(services.index.get("ohmygame/solarized", "1.0.0")?.root).toContain(path.join("packages", "ohmygame", "solarized", "1.0.0"));
      const catalog = readCatalog({
        schema: 1,
        plugins: [{ id: "ohmygame/solarized", releases: [sign(release), sign({ ...release, version: "1.2.0" })] }],
      });
      expect(availableUpdates(catalog, services.index).map((item) => item.version)).toEqual(["1.2.0"]);
    } finally {
      await close();
    }
  });

  it("refuses releases it can't trust before or after downloading", async () => {
    const { release, sign, install, downloads, close } = await setup();
    try {
      await expect(install({ ...release, signature: Buffer.alloc(64).toString("base64") })).rejects.toThrow("invalid signature");
      await expect(install(sign({ ...release, id: "acme/solarized" }))).rejects.toThrow("doesn't sign for acme");
      await expect(install(sign({ ...release, key: "other" }))).rejects.toThrow("doesn't know");
      await expect(install({ ...sign(release), url: "http://plugins.example/x.zip" })).rejects.toThrow("release is invalid");
      expect(downloads).toEqual([]);
      await expect(install(sign({ ...release, sha256: "0".repeat(64) }))).rejects.toThrow("doesn't match its digest");
      // Signed and intact, but the package inside is another version.
      await expect(install(sign({ ...release, version: "9.9.9" }))).rejects.toThrow("not the ohmygame/solarized 9.9.9");
      // A signed version is still only a version, never a path.
      await expect(install(sign({ ...release, version: "../../../escaped" }))).rejects.toThrow("isn't a version");
    } finally {
      await close();
    }
  });

  it("leaves an installed plugin alone when a release holds its package", async () => {
    const { release, sign, services, install, close } = await setup();
    try {
      await install(sign(release));
      await services.consent("ohmygame/solarized", []);
      const before = services.index.get("ohmygame/solarized", "1.0.0")!;
      // Signed for 1.1.0, but the archive is the 1.0.0 already installed.
      await expect(install(sign({ ...release, version: "1.1.0" }))).rejects.toThrow("not the ohmygame/solarized 1.1.0");
      expect(services.index.get("ohmygame/solarized", "1.0.0")).toEqual(before);
      expect(services.grants.plugin("ohmygame/solarized")).toBeDefined();
    } finally {
      await close();
    }
  });

  it("unwraps a package zipped with its folder, and reinstalls after an uninstall", async () => {
    const { dir, release, sign, services, install, close } = await setup({ wrapper: "solarized" });
    try {
      const entry = await install(sign(release));
      expect(entry.version).toBe("1.0.0");
      await services.uninstall("ohmygame/solarized", "1.0.0");
      await expect(stat(entry.root)).rejects.toThrow();
      // A folder an earlier install left behind doesn't block this one.
      await mkdir(path.join(entry.root, "stale"), { recursive: true });
      expect((await install(sign(release))).root).toBe(entry.root);
      await expect(stat(path.join(entry.root, "stale"))).rejects.toThrow();
      expect(path.relative(path.join(dir, "store/packages"), entry.root)).toBe(path.join("ohmygame", "solarized", "1.0.0"));
    } finally {
      await close();
    }
  });

  it("keeps a template's dotfiles, and refuses a manifest folder elsewhere", async () => {
    const template = await setup({
      prepare: async (dir) => {
        await mkdir(path.join(dir, "templates/game"), { recursive: true });
        await writeFile(path.join(dir, "templates/game/.gitignore"), ".godot/\n");
      },
    });
    try {
      const entry = await template.install(template.sign(template.release));
      expect(await readFile(path.join(entry.root, "templates/game/.gitignore"), "utf8")).toBe(".godot/\n");
    } finally {
      await template.close();
    }
    const nested = await setup({
      prepare: async (dir) => {
        await mkdir(path.join(dir, "assets/.ohmygame-plugin"), { recursive: true });
        await writeFile(path.join(dir, "assets/.ohmygame-plugin/plugin.json"), "{}");
      },
    });
    try {
      await expect(nested.install(nested.sign(nested.release))).rejects.toThrow("manifest folder outside its package");
    } finally {
      await nested.close();
    }
  });

  it("downloads within the release's size and reports file errors", async () => {
    const dir = await temporary();
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      url: "https://plugins.example/x.zip",
      body: new Response("x".repeat(64)).body,
    })) as unknown as typeof fetch;
    try {
      await downloadRelease("https://plugins.example/x.zip", path.join(dir, "ok.zip"), 64);
      expect((await readFile(path.join(dir, "ok.zip"))).length).toBe(64);
      await expect(downloadRelease("https://plugins.example/x.zip", path.join(dir, "big.zip"), 10)).rejects.toThrow("larger than");
      await expect(downloadRelease("https://plugins.example/x.zip", path.join(dir, "missing", "x.zip"), 64)).rejects.toThrow("ENOENT");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("drops only the bundled copy of a plugin for every project from the index, keeping a version installed apart", async () => {
    const dir = await temporary();
    const services = new PluginServices({ directory: path.join(dir, "store") });
    try {
      const apart = path.join(dir, "blender");
      await cp(path.join(BUNDLED, "blender"), apart, { recursive: true });
      await editManifest(apart, (manifest) => (manifest.version = "9.0.0"));
      await services.index.load();
      // As an earlier version of the app might have indexed it.
      expect((await services.index.add(path.join(BUNDLED, "blender"))).ok).toBe(true);
      expect((await services.index.add(apart)).ok).toBe(true);
      await services.addBundled(BUNDLED);
      expect(services.index.versions("ohmygame/blender").map((entry) => entry.version)).toEqual(["9.0.0"]);
    } finally {
      await services.close();
    }
  });

  it("indexes the app's own format 2 plugins and allows what they ask for, except one that starts off", async () => {
    const dir = await temporary();
    const services = new PluginServices({ directory: path.join(dir, "store"), bundledOff: ["ohmygame/taptap-maker"] });
    try {
      const results = await services.addBundled(BUNDLED);
      expect(results.map((result) => (result.ok ? [] : result.issues))).toEqual(results.map(() => []));
      expect(services.grants.plugin("ohmygame/godot")?.allowed).toEqual(expect.arrayContaining(["native"]));
      // Those that only add Skills apply to every project they suit; the catalog shows them.
      expect(services.index.entries().map((entry) => entry.id).sort()).toEqual(["ohmygame/godot", "ohmygame/taptap-maker"]);
      expect(services.grants.plugin("ohmygame/game-studio")).toBeUndefined();
      // It asks for consent when the person turns it on, and stays as they leave it.
      expect(services.grants.plugin("ohmygame/taptap-maker")).toEqual({ enabled: false, allowed: [] });
      await services.consent("ohmygame/taptap-maker", ["native"]);
      await services.grants.setEnabled("ohmygame/taptap-maker", true);
      await services.addBundled(BUNDLED);
      expect(services.grants.plugin("ohmygame/taptap-maker")?.enabled).toBe(true);
    } finally {
      await services.close();
    }
  });
});
