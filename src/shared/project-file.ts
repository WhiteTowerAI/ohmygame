import { Type, type Static } from "typebox";
import { Errors } from "typebox/value";
import { isPluginVersion } from "./plugins.js";

// `ohmygame.json` at a project's root: the project's type and how its plugins
// differ from the person's choice for every project: `true` for on at the
// installed version, or `false` for off. The plugin that provides the type is
// written as its installed version, which also means on. The file travels
// with the project in Git and archives. Approvals stay with the local
// installation. Unrecognized keys are preserved when OhMyGame writes the file.

export const PROJECT_FILE_NAME = "ohmygame.json";
/** The JSON Schema in `schemas/project-1.json`, which the website serves from the repository's `main` branch. */
export const PROJECT_FILE_SCHEMA_URL =
  "https://www.ohmygame.ai/schema/project-1.json";

/** Types the app has without plugins; every other type comes from one. */
export const CORE_PROJECT_TYPES = ["general", "interactive-story"] as const;
export type CoreProjectType = (typeof CORE_PROJECT_TYPES)[number];

const PLUGIN_ID = "[a-z0-9]+(?:-[a-z0-9]+)*/[a-z0-9]+(?:-[a-z0-9]+)*";

export const ProjectFileSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    type: Type.String({
      pattern: `^(?:${CORE_PROJECT_TYPES.join("|")}|${PLUGIN_ID}:[a-z0-9]+(?:-[a-z0-9]+)*)$`,
      description: "A core type, or publisher/name:type from a plugin",
    }),
    plugins: Type.Optional(
      Type.Record(
        Type.String({ pattern: `^${PLUGIN_ID}$` }),
        Type.Union([
          Type.String({ description: "An exact version, read as enabled. Written for the plugin that provides the type, which older OhMyGame releases require.", minLength: 5, maxLength: 256 }),
          Type.Boolean(),
        ]),
        { description: "Per-project plugin switches. An enabled plugin uses the current installation.", additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: true },
);

export type ProjectFile = Static<typeof ProjectFileSchema> &
  Record<string, unknown>;

export type ProjectFileResult =
  { ok: true; file: ProjectFile } | { ok: false; issues: string[] };

/** The plugin that provides a type, or undefined for a core type. */
export function projectTypePlugin(type: string): string | undefined {
  const separator = type.lastIndexOf(":");
  return separator < 0 ? undefined : type.slice(0, separator);
}

export function validateProjectFile(value: unknown): ProjectFileResult {
  const issues = [...Errors(ProjectFileSchema, value)]
    .filter((error) => error.keyword !== "boolean")
    .map((error) => `${error.instancePath || "/"} ${error.message}`);
  if (issues.length) return { ok: false, issues };
  const file = value as ProjectFile;
  const plugins = Object.entries(file.plugins ?? {});
  for (const [id, version] of plugins)
    if (typeof version === "string" && !isPluginVersion(version))
      issues.push(`/plugins/${id} must be an exact version, true or false`);
  const owner = projectTypePlugin(file.type);
  if (owner && !file.plugins?.[owner])
    issues.push(`/plugins must enable ${owner}, which provides the type`);
  if (issues.length) return { ok: false, issues };
  // compat: Keep reading version strings until the project file and archive
  // formats can drop the legacy form. Old version strings enable the
  // current installation. Persist the booleans on the next project-file edit.
  // The type's plugin keeps its string; writing the file sets its version.
  if (plugins.some(([id, value]) => id !== owner && typeof value === "string"))
    return { ok: true, file: { ...file, plugins: Object.fromEntries(
      plugins.map(([id, value]) => [id, id === owner ? value : value !== false]),
    ) } };
  return { ok: true, file };
}
