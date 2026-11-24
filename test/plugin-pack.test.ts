import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportPlugin } from "../src/daemon/plugin-export.js";
import { indexPluginPackage } from "../src/daemon/plugin-index.js";
import { packRelease, publishedFiles, stagePublished } from "../src/daemon/plugin-pack.js";
import { extractArchive } from "../src/daemon/archive-extraction.js";
import { PLUGIN_TEMPLATE_PARTS, pluginTemplate } from "../src/shared/plugin-template.js";
import { checkFolder } from "../scripts/plugin-check.js";
import { buildPluginPackages } from "../scripts/build-plugin-packages.js";
import { PLUGIN_HOST_API_VERSION } from "../src/shared/plugin-manifest.js";
import { apiVersionProblems } from "../scripts/plugin-api-version.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function folder(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-pack-"));
  cleanup.push(root);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return root;
}

const npm = (() => {
  try {
    execFileSync("npm", ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
    return true;
  } catch {
    return false;
  }
})();

/** What npm itself would pack. */
function npmPack(root: string): string[] {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", shell: process.platform === "win32", stdio: ["ignore", "pipe", "ignore"] });
  const [result] = JSON.parse(output) as [{ files: { path: string }[] }];
  return result.files.map((file) => file.path).sort();
}

const plugin = { ".ohmygame-plugin/plugin.json": "{}", "skills/make/SKILL.md": "", "notes.md": "", "node_modules/dependency/index.js": "", "package-lock.json": "{}", ".DS_Store": "", "skills/make/old.md.orig": "" };
const cases: Record<string, Record<string, string>> = {
  "everything": { ...plugin, "package.json": JSON.stringify({ name: "@acme/maker", version: "1.0.0" }) },
  "a files list": { ...plugin, "package.json": JSON.stringify({ name: "@acme/maker", version: "1.0.0", files: [".ohmygame-plugin", "skills/", "LICENSE"] }), LICENSE: "", "README.md": "" },
  ".npmignore over .gitignore": { ...plugin, "package.json": JSON.stringify({ name: "@acme/maker", version: "1.0.0" }), ".npmignore": "notes.md\n", ".gitignore": "skills/\n" },
  ".gitignore": { ...plugin, "package.json": JSON.stringify({ name: "@acme/maker", version: "1.0.0" }), ".gitignore": "notes.md\n", "skills/.gitignore": "*.tmp\n", "skills/make/a.tmp": "" },
  "bundled dependencies": {
    ...plugin,
    "package.json": JSON.stringify({ name: "@acme/maker", version: "1.0.0", dependencies: { dependency: "1.0.0", other: "1.0.0" }, bundleDependencies: ["dependency"] }),
    "node_modules/dependency/package.json": JSON.stringify({ name: "dependency", version: "1.0.0", dependencies: { nested: "1.0.0" } }),
    "node_modules/nested/package.json": JSON.stringify({ name: "nested", version: "1.0.0" }),
    "node_modules/nested/index.js": "",
    "node_modules/other/package.json": JSON.stringify({ name: "other", version: "1.0.0" }),
  },
};

describe("exporting a plugin", () => {
  it("moves its canvas presets' nodes to the new id, leaving other plugins' alone", async () => {
    const node = (id: string, plugin: string) => ({ id, type: "plugin", position: { x: 0, y: 0 }, data: { node: plugin, params: {}, inputs: {} } });
    const root = await folder({
      ".ohmygame-plugin/plugin.json": JSON.stringify({
        id: "personal/frames", version: "1.0.0", engines: { "ohmygame-api": "^2.3.0" }, displayName: "Frames", description: "Frames",
        capabilities: { native: true }, entrypoints: { native: "./native/index.mjs" },
        contributes: {
          canvasNodes: [{ id: "copy", title: "Copy", output: "image", run: { native: "copy" } }],
          canvasPresets: [{ id: "set", title: "Set", board: "./presets/set.json" }],
        },
      }),
      "native/index.mjs": "export function activate() {}\n",
      "presets/set.json": JSON.stringify({ nodes: [node("a", "personal/frames:copy"), node("b", "acme/other:blur")], edges: [] }),
    });
    const indexed = await indexPluginPackage(root);
    if (!indexed.ok) throw new Error(JSON.stringify(indexed.issues));
    const exported = await exportPlugin(indexed.entry, "acme", await folder({}));
    const board = JSON.parse(await readFile(path.join(exported, "presets/set.json"), "utf8")) as { nodes: { data: { node: string } }[] };
    expect(board.nodes.map((item) => item.data.node)).toEqual(["acme/frames:copy", "acme/other:blur"]);
  });
});

describe("published files", () => {
  it.skipIf(!npm).each(Object.keys(cases))("match what npm packs: %s", async (name) => {
    const root = await folder(cases[name]!);
    expect(await publishedFiles(root)).toEqual(npmPack(root));
  });

  it("leave out what a package.json would from a folder without one", async () => {
    const root = await folder(plugin);
    expect(await publishedFiles(root)).toEqual([".ohmygame-plugin/plugin.json", "notes.md", "skills/make/SKILL.md"]);
  });

  it("refuse a package.json whose files isn't a list of paths", async () => {
    const root = await folder({ ...plugin, "package.json": JSON.stringify({ name: "@acme/notes", version: "1.0.0", files: [null] }) });
    await expect(publishedFiles(root)).rejects.toThrow("files must be a list of paths");
  });

  it("pack as a release archive at its top, the same each time, keeping what's executable", async () => {
    const root = await folder({ ...plugin, "package.json": JSON.stringify({ name: "@acme/maker", version: "1.0.0", files: [".ohmygame-plugin", "skills/", "bin/"] }), "bin/run.sh": "#!/bin/sh\n" });
    await chmod(path.join(root, "bin/run.sh"), 0o755);
    const packed = await packRelease(root);
    expect(packed.files).toEqual(await publishedFiles(root));
    expect((await packRelease(root)).archive.equals(packed.archive)).toBe(true);
    const archive = path.join(await folder({}), "release.zip");
    await writeFile(archive, packed.archive);
    const unpacked = path.join(path.dirname(archive), "unpacked");
    await extractArchive(archive, unpacked, { maxEntries: 100, maxBytes: 1e6, error: (reason) => new Error(reason) });
    expect((await readdir(unpacked, { recursive: true })).map((file) => file.split(path.sep).join("/")).filter((file) => packed.files.includes(file)).sort()).toEqual(packed.files);
    if (process.platform !== "win32") expect((await stat(path.join(unpacked, "bin/run.sh"))).mode & 0o111).not.toBe(0);
  });

  it("stage into a folder of their own, with project templates' .gitignore back", async () => {
    const root = await folder({
      ".ohmygame-plugin/plugin.json": JSON.stringify({ id: "acme/maker", version: "1.0.0", engines: { "ohmygame-api": "^2.0.0" }, displayName: "Maker", description: "Makes", contributes: { projectTypes: [{ id: "game", title: "Game", description: "A game", template: "./template", preview: "web" }], templates: [{ id: "studio", title: "Studio", projectType: "general", folder: "./studio" }] } }),
      "template/gitignore": "dist/\n",
      "template/index.html": "",
      "studio/gitignore": "build/\n",
      "studio/README.md": "",
      "notes.md.orig": "",
    });
    const target = path.join(root, "..", `${path.basename(root)}-staged`);
    cleanup.push(target);
    await stagePublished(root, target);
    expect((await readdir(target, { recursive: true })).map((file) => file.split(path.sep).join("/")).sort()).toEqual([".ohmygame-plugin", ".ohmygame-plugin/plugin.json", "studio", "studio/.gitignore", "studio/README.md", "template", "template/.gitignore", "template/index.html"]);
  });
});

describe("plugin template", () => {
  const combinations = Array.from({ length: 2 ** PLUGIN_TEMPLATE_PARTS.length }, (_, mask) => PLUGIN_TEMPLATE_PARTS.filter((_, bit) => mask & (1 << bit)));

  it("makes a package with no problems, whatever parts it has", async () => {
    for (const parts of combinations) {
      const root = await folder(pluginTemplate({ publisher: "acme", name: "maker", displayName: "Maker", description: "Makes games", parts }));
      expect(await checkFolder(root), parts.join(",") || "no parts").toEqual([]);
    }
  });

  it.skipIf(!npm)("lists in package.json every file it needs npm to publish", async () => {
    const root = await folder(pluginTemplate({ publisher: "acme", name: "maker", displayName: "Maker", description: "Makes games", parts: PLUGIN_TEMPLATE_PARTS }));
    const packed = npmPack(root);
    expect(packed).toEqual(await publishedFiles(root));
    expect(packed).not.toContain(".github/workflows/release.yml");
    expect(packed).toContain("template/gitignore");
  });

  it("refuses the Plugin Builder's publisher, and names that can't be ids", async () => {
    const make = (publisher: string, name = "maker") => () => pluginTemplate({ publisher, name, displayName: "Maker", description: "Makes", parts: [] });
    expect(make("personal")).toThrow("kept for OhMyGame");
    // OhMyGame makes its own plugins for its npm scope, and the check takes them.
    expect(make("ohmygame")).not.toThrow();
    expect(await checkFolder(await folder(make("ohmygame")()))).toEqual([]);
    expect(make("Acme")).toThrow("isn't a publisher");
    expect(make("acme", "my_plugin")).toThrow("isn't a plugin name");
  });
});

describe("plugin packages for authors", () => {
  it("include examples that pass the app's checks as npm would publish them", async () => {
    const examples = (await readdir("packages/plugin-examples", { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name);
    expect(examples.sort()).toEqual(["canvas-game", "echo-server", "hello-tools", "level-ideas", "project-panel"]);
    for (const example of examples) {
      const folder = path.join("packages/plugin-examples", example);
      expect(await checkFolder(folder), example).toEqual([]);
      if (npm) expect(await publishedFiles(folder), example).toEqual(npmPack(folder));
    }
  });


  it("version with the plugin API they check for, under the app's license", async () => {
    const license = await readFile("LICENSE", "utf8");
    for (const name of ["plugin-cli", "create-ohmygame-plugin", "plugin-ui"]) {
      expect(JSON.parse(await readFile(path.join("packages", name, "package.json"), "utf8")).version, name).toBe(PLUGIN_HOST_API_VERSION);
      expect(await readFile(path.join("packages", name, "LICENSE"), "utf8"), name).toBe(license);
    }
  });

  it("raise the plugin API's minor at most once per release, with its row in the guide", async () => {
    const docs = await readFile("docs/plugins.md", "utf8");
    expect(apiVersionProblems(PLUGIN_HOST_API_VERSION, PLUGIN_HOST_API_VERSION, docs)).toEqual([]);
    const table = "| 2.4.0 | a |\n| 2.5.0 | b |\n| 2.6.0 | c |\n| 3.0.0 | d |\n| 2.5.1 | e |";
    expect(apiVersionProblems("2.4.0", "2.4.0", table)).toEqual([]);
    expect(apiVersionProblems("2.4.0", "2.5.0", table)).toEqual([]);
    expect(apiVersionProblems("2.4.0", "3.0.0", table)).toEqual([]);
    expect(apiVersionProblems("2.4.0", "2.6.0", table)).toEqual([expect.stringContaining("every addition since shares 2.5.0")]);
    expect(apiVersionProblems("2.5.0", "2.4.0", table)).toEqual([expect.stringContaining("older than 2.5.0")]);
    expect(apiVersionProblems("2.4.0", "2.5.1", table)).toEqual([expect.stringContaining("the version a release adds is 2.5.0")]);
    expect(apiVersionProblems("2.4.0", "3.1.0", table)).toEqual([expect.stringContaining("a new format starts at 3.0.0"), expect.stringContaining("no row for 3.1.0")]);
    expect(apiVersionProblems("2.6.0", "2.7.0", table)).toEqual([expect.stringContaining("no row for 2.7.0")]);
  });

  it.skipIf(!npm)("make a plugin, check it and pack it from their built files", { timeout: 60_000 }, async () => {
    await buildPluginPackages();
    const work = await folder({});
    const run = (script: string, ...args: string[]) => spawnSync(process.execPath, [path.resolve("packages", script), ...args], { cwd: work, encoding: "utf8" });
    const made = run("create-ohmygame-plugin/dist/create.mjs", "maker", "--publisher", "acme", "--parts", PLUGIN_TEMPLATE_PARTS.join(","), "--yes");
    expect(made.status, made.stderr).toBe(0);
    expect(run("create-ohmygame-plugin/dist/create.mjs", "maker", "--publisher", "acme", "--yes").stderr).toContain("isn't empty");
    expect(run("create-ohmygame-plugin/dist/create.mjs", "other", "--publisher", "personal", "--yes").stderr).toContain("kept for OhMyGame");
    const checked = run("plugin-cli/dist/cli.mjs", "check", "maker");
    expect(checked.stdout, checked.stderr).toContain("No problems found");
    const packed = run("plugin-cli/dist/cli.mjs", "pack", "maker", "--pack-destination", ".");
    expect(packed.status, packed.stderr).toBe(0);
    expect(await readdir(work)).toContain("acme-maker-0.1.0.tgz");
    for (const script of ["plugin-cli", "create-ohmygame-plugin"])
      expect(await readFile(path.join("packages", script, "dist", "THIRD_PARTY_LICENSES.md"), "utf8"), script).toContain("## typebox ");
    await writeFile(path.join(work, "maker", "package.json"), JSON.stringify({ name: "@acme/maker", version: "0.2.0" }));
    const refused = run("plugin-cli/dist/cli.mjs", "pack", "maker", "--pack-destination", "refused");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("isn't the plugin's 0.1.0");
  });
});
