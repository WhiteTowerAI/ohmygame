import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishedFiles, stagePublished } from "../src/daemon/plugin-pack.js";
import { PLUGIN_TEMPLATE_PARTS, pluginTemplate } from "../src/shared/plugin-template.js";
import { checkFolder } from "../scripts/plugin-check.js";
import { buildPluginPackages } from "../scripts/build-plugin-packages.js";
import { PLUGIN_HOST_API_VERSION } from "../src/shared/plugin-manifest.js";

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

describe("published files", () => {
  it.skipIf(!npm).each(Object.keys(cases))("match what npm packs: %s", async (name) => {
    const root = await folder(cases[name]!);
    expect(await publishedFiles(root)).toEqual(npmPack(root));
  });

  it("leave out what a package.json would from a folder without one", async () => {
    const root = await folder(plugin);
    expect(await publishedFiles(root)).toEqual([".ohmygame-plugin/plugin.json", "notes.md", "skills/make/SKILL.md"]);
  });

  it("stage into a folder of their own, with project templates' .gitignore back", async () => {
    const root = await folder({
      ".ohmygame-plugin/plugin.json": JSON.stringify({ id: "acme/maker", version: "1.0.0", engines: { "ohmygame-api": "^2.0.0" }, displayName: "Maker", description: "Makes", contributes: { projectTypes: [{ id: "game", title: "Game", description: "A game", template: "./template", preview: "web" }] } }),
      "template/gitignore": "dist/\n",
      "template/index.html": "",
      "notes.md.orig": "",
    });
    const target = path.join(root, "..", `${path.basename(root)}-staged`);
    cleanup.push(target);
    await stagePublished(root, target);
    expect((await readdir(target, { recursive: true })).map((file) => file.split(path.sep).join("/")).sort()).toEqual([".ohmygame-plugin", ".ohmygame-plugin/plugin.json", "template", "template/.gitignore", "template/index.html"]);
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
    expect(packed).not.toContain(".github/workflows/publish.yml");
    expect(packed).toContain("template/gitignore");
  });

  it("refuses a publisher the app keeps, and names that can't be ids", () => {
    const make = (publisher: string, name = "maker") => () => pluginTemplate({ publisher, name, displayName: "Maker", description: "Makes", parts: [] });
    expect(make("personal")).toThrow("kept for OhMyGame");
    expect(make("ohmygame")).toThrow("kept for OhMyGame");
    expect(make("Acme")).toThrow("isn't a publisher");
    expect(make("acme", "my_plugin")).toThrow("isn't a plugin name");
  });
});

describe("plugin packages for authors", () => {
  it("version with the plugin API they check for", async () => {
    for (const name of ["plugin-cli", "create-ohmygame-plugin", "plugin-ui"])
      expect(JSON.parse(await readFile(path.join("packages", name, "package.json"), "utf8")).version, name).toBe(PLUGIN_HOST_API_VERSION);
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
    await writeFile(path.join(work, "maker", "package.json"), JSON.stringify({ name: "@acme/maker", version: "0.2.0" }));
    const refused = run("plugin-cli/dist/cli.mjs", "pack", "maker", "--pack-destination", "refused");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("isn't the plugin's 0.1.0");
  });
});
