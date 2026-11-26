import type { ProjectType } from "./contracts.js";

export const EXAMPLE_ID_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";

/** Project types an example can start. Examples are copied into a workspace and run as is. */
export const EXAMPLE_PROJECT_TYPES = ["web-game"] as const satisfies readonly ProjectType[];

export interface ExampleSummary {
  id: string;
  type: (typeof EXAMPLE_PROJECT_TYPES)[number];
  name: string;
  description: string;
}

/** A plugin's project template (`contributes.templates`), as `GET /project-templates` lists it. */
export interface ProjectTemplateSummary {
  /** `publisher/name:template`. */
  id: string;
  type: "general" | "web-game";
  name: string;
  description?: string;
  plugin: { id: string; displayName: string; version: string; icon?: { type: "asset"; path: string }; iconRevision?: string };
}

/** An example as packaged by scripts/prepare-examples.ts. Paths are relative to the catalog. */
export interface PreparedExample extends ExampleSummary {
  /** Source copied into a new project's workspace. */
  directory: string;
  cover: string;
  /**
   * Static build played without creating a project. Web games are built when
   * the app is packaged; one without a build, such as an interactive story,
   * plays as its own page from its files.
   */
  play?: string;
}

export interface PreparedExampleCatalog {
  version: 1;
  source: { repository: string; commit: string; release?: string };
  examples: PreparedExample[];
}

const exampleIdPattern = new RegExp(EXAMPLE_ID_PATTERN);

export function isExampleSummary(value: unknown): value is ExampleSummary {
  if (!value || typeof value !== "object") return false;
  const example = value as Record<string, unknown>;
  return typeof example.id === "string" && exampleIdPattern.test(example.id)
    && typeof example.type === "string" && (EXAMPLE_PROJECT_TYPES as readonly string[]).includes(example.type)
    && typeof example.name === "string" && example.name.trim().length > 0
    && typeof example.description === "string";
}

export function isPreparedExampleCatalog(value: unknown): value is PreparedExampleCatalog {
  if (!value || typeof value !== "object") return false;
  const catalog = value as Record<string, unknown>;
  const source = catalog.source as Record<string, unknown> | undefined;
  if (catalog.version !== 1 || !source || typeof source.repository !== "string" || typeof source.commit !== "string") return false;
  if (!Array.isArray(catalog.examples)) return false;
  const ids = new Set<string>();
  for (const example of catalog.examples as unknown[]) {
    if (!isExampleSummary(example)) return false;
    const prepared = example as unknown as Record<string, unknown>;
    if (!isRelativePath(prepared.directory) || !isRelativePath(prepared.cover)) return false;
    if (prepared.play !== undefined && !isRelativePath(prepared.play)) return false;
    if (ids.has(example.id)) return false;
    ids.add(example.id);
  }
  return true;
}

function isRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.split(/[\\/]/).includes("..");
}
