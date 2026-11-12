// Builds the packages plugin authors install from npm, from the app's own
// code: @ohmygame/plugin-cli (`ohmygame-plugin check` and `pack`, with the
// manifest's JSON Schema and the page components' contracts) and
// create-ohmygame-plugin. `bun run plugin-packages:build`; npm runs it before
// packing either package. Each bundle ships with the licenses of the packages
// bundled into it, in THIRD_PARTY_LICENSES.md beside it.
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { PLUGIN_UI_MAJORS } from "../src/shared/plugin-ui-versions.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const packages = path.join(root, "packages");

// Bundled CommonJS dependencies call require, which an ES module lacks.
const banner = `#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);`;

async function bundle(entry: string, outfile: string): Promise<void> {
  const { metafile } = await build({ entryPoints: [entry], outfile, bundle: true, platform: "node", format: "esm", target: "node20", banner: { js: banner }, legalComments: "none", logLevel: "warning", metafile: true, absWorkingDir: root });
  const folders = new Set(Object.keys(metafile.inputs).flatMap((input) => /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input)?.[1] ?? []));
  const notices: string[] = [];
  for (const folder of [...folders].sort()) {
    const { name, version, license } = JSON.parse(await readFile(path.join(root, folder, "package.json"), "utf8")) as { name: string; version: string; license?: string };
    const file = (await readdir(path.join(root, folder))).find((entry) => /^(licen[cs]e|copying)/i.test(entry));
    if (!file) throw new Error(`${name} has no license file to ship with ${path.basename(outfile)}.`);
    notices.push(`## ${name} ${version}\n\n${license ?? ""}\n\n\`\`\`\`text\n${(await readFile(path.join(root, folder, file), "utf8")).trim()}\n\`\`\`\``);
  }
  await writeFile(path.join(path.dirname(outfile), "THIRD_PARTY_LICENSES.md"), `# Third-party licenses\n\n${path.basename(outfile)} includes code from these packages.\n\n${notices.join("\n\n")}\n`);
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
