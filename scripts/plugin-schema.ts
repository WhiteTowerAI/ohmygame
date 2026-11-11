// Writes the published JSON Schemas, for plugin format 2 and for a project's
// `ohmygame.json`, from their TypeBox sources. With --check, fails when a
// committed file is out of date.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLUGIN_MANIFEST_SCHEMA_URL,
  PluginManifestV2Schema,
} from "../src/shared/plugin-manifest.js";
import {
  PROJECT_FILE_SCHEMA_URL,
  ProjectFileSchema,
} from "../src/shared/project-file.js";

const SCHEMAS = path.join(path.dirname(fileURLToPath(import.meta.url)), "../schemas");

export const PLUGIN_SCHEMA_FILE = path.join(SCHEMAS, "plugin-2.json");
export const PROJECT_SCHEMA_FILE = path.join(SCHEMAS, "project-1.json");

function schemaJson(id: string, title: string, schema: object): string {
  return `${JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", $id: id, title, ...schema }, null, 2)}\n`;
}

export function pluginSchemaJson(): string {
  return schemaJson(PLUGIN_MANIFEST_SCHEMA_URL, "OhMyGame plugin manifest, format 2", PluginManifestV2Schema);
}

export function projectSchemaJson(): string {
  return schemaJson(PROJECT_FILE_SCHEMA_URL, "OhMyGame project file (ohmygame.json)", ProjectFileSchema);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [file, expected] of [[PLUGIN_SCHEMA_FILE, pluginSchemaJson()], [PROJECT_SCHEMA_FILE, projectSchemaJson()]] as const) {
    if (process.argv.includes("--check")) {
      const current = await readFile(file, "utf8").catch(() => "");
      if (current !== expected) {
        console.error(`schemas/${path.basename(file)} is out of date; run bun run plugin:schema`);
        process.exit(1);
      }
    } else await writeFile(file, expected);
  }
}
