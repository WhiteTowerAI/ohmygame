// Writes the published JSON Schema for plugin format 2 from its TypeBox
// source. With --check, fails when the committed file is out of date.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLUGIN_MANIFEST_SCHEMA_URL,
  PluginManifestV2Schema,
} from "../src/shared/plugin-manifest.js";

export const PLUGIN_SCHEMA_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../schemas/plugin-2.json",
);

export function pluginSchemaJson(): string {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: PLUGIN_MANIFEST_SCHEMA_URL,
    title: "OhMyGame plugin manifest, format 2",
    ...PluginManifestV2Schema,
  };
  return `${JSON.stringify(schema, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const expected = pluginSchemaJson();
  if (process.argv.includes("--check")) {
    const current = await readFile(PLUGIN_SCHEMA_FILE, "utf8").catch(() => "");
    if (current !== expected) {
      console.error(
        "schemas/plugin-2.json is out of date; run bun run plugin:schema",
      );
      process.exit(1);
    }
  } else await writeFile(PLUGIN_SCHEMA_FILE, expected);
}
