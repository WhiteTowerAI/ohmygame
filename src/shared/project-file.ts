import { Type, type Static } from "typebox";
import { Errors } from "typebox/value";
import { isPluginVersion } from "./plugins.js";

// `ohmygame.json` at a project's root: the project's type and the plugins it
// uses, at exact versions. It travels with the project (git, archives), so it
// says what the project asks for and never what anyone approved; approvals
// stay with each person. Keys it doesn't know are kept when it is rewritten,
// so later project settings can live here too.

export const PROJECT_FILE_NAME = "ohmygame.json";
export const PROJECT_FILE_SCHEMA_URL =
  "https://ohmygame.dev/schema/project-1.json";

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
        Type.String({ minLength: 5, maxLength: 256 }),
        { additionalProperties: false },
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
  for (const [id, version] of Object.entries(file.plugins ?? {}))
    if (!isPluginVersion(version))
      issues.push(`/plugins/${id} must be an exact version`);
  const owner = projectTypePlugin(file.type);
  if (owner && !file.plugins?.[owner])
    issues.push(`/plugins must list ${owner}, which provides the type`);
  return issues.length ? { ok: false, issues } : { ok: true, file };
}
