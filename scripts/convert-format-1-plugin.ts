// Converts a format 1 plugin that only adds Skills to format 2, in place:
//   node --import tsx scripts/convert-format-1-plugin.ts <folder> --publisher <name> [--category <category>]...
// The manifest is rewritten and its display strings move to locales/en.json;
// the Skills folder and icon keep their paths.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { convertFormat1Manifest } from "../src/daemon/plugin-conversion.js";
import { indexPluginPackage } from "../src/daemon/plugin-index.js";
import { PLUGIN_CATEGORIES, type PluginCategory } from "../src/shared/plugin-manifest.js";
import { isPluginManifest } from "../src/shared/plugins.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    publisher: { type: "string" },
    category: { type: "string", multiple: true },
  },
});
const [folder] = positionals;
if (!folder || !values.publisher || positionals.length !== 1)
  throw new Error("Usage: convert-format-1-plugin.ts <folder> --publisher <name> [--category <category>]...");
const categories = (values.category ?? []).map((category) => {
  if (!(PLUGIN_CATEGORIES as readonly string[]).includes(category)) throw new Error(`Unknown category ${category}`);
  return category as PluginCategory;
});

const manifestPath = path.join(folder, ".ohmygame-plugin", "plugin.json");
const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
if (!isPluginManifest(manifest)) throw new Error(`${manifestPath} is not a format 1 manifest`);
const converted = convertFormat1Manifest(manifest, { publisher: values.publisher, categories });
await writeFile(manifestPath, `${JSON.stringify(converted.manifest, null, 2)}\n`);
await mkdir(path.join(folder, "locales"), { recursive: true });
await writeFile(path.join(folder, "locales", "en.json"), `${JSON.stringify(converted.strings, null, 2)}\n`);

const checked = await indexPluginPackage(folder);
if (!checked.ok) throw new Error(checked.issues.map((issue) => `${issue.path} ${issue.message}`).join("\n"));
console.log(`${checked.entry.id} ${checked.entry.version}: ${checked.entry.skills.length} Skills`);
