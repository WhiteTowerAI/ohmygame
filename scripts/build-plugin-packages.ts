// Builds the packages plugin authors install from npm, from the app's own
// code: @ohmygame/plugin-cli (`ohmygame-plugin check` and `pack`, with the
// manifest's JSON Schema and the page components' contracts) and
// create-ohmygame-plugin. `bun run plugin-packages:build`; npm runs it before
// packing either package.
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { PLUGIN_UI_MAJORS } from "../src/shared/plugin-ui-versions.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const packages = path.join(root, "packages");

// Bundled CommonJS dependencies call require, which an ES module lacks.
const banner = `#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);`;

async function bundle(entry: string, outfile: string): Promise<void> {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: "node", format: "esm", target: "node20", banner: { js: banner }, legalComments: "none", logLevel: "warning" });
}

export async function buildPluginPackages(): Promise<void> {
  const cli = path.join(packages, "plugin-cli", "dist");
  const create = path.join(packages, "create-ohmygame-plugin", "dist");
  await Promise.all([rm(cli, { recursive: true, force: true }), rm(create, { recursive: true, force: true })]);
  await bundle(path.join(packages, "plugin-cli", "src", "cli.ts"), path.join(cli, "cli.mjs"));
  await bundle(path.join(packages, "create-ohmygame-plugin", "src", "create.ts"), path.join(create, "create.mjs"));
  await cp(path.join(root, "schemas", "plugin-2.json"), path.join(cli, "plugin.schema.json"));
  for (const major of PLUGIN_UI_MAJORS) {
    await mkdir(path.join(cli, "ui", major), { recursive: true });
    await cp(path.join(packages, "plugin-ui", "ui", major, "custom-elements.json"), path.join(cli, "ui", major, "custom-elements.json"));
  }
  console.log(`Built ${(await readdir(cli)).length} files for @ohmygame/plugin-cli and create-ohmygame-plugin`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildPluginPackages();
