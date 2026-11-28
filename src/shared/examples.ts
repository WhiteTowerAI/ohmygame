import type { ProjectType } from "./contracts.js";

export const EXAMPLE_ID_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";
export const EXAMPLE_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
export const EXAMPLE_ARCHIVE_MAX_ENTRIES = 20_000;
export const EXAMPLE_DOWNLOAD_UNAVAILABLE = "example-download-unavailable";

/** Project types an example can start. Examples are copied into a workspace and run as is. */
export const EXAMPLE_PROJECT_TYPES = ["web-game"] as const satisfies readonly ProjectType[];

export interface ExampleSummary {
  id: string;
  type: (typeof EXAMPLE_PROJECT_TYPES)[number];
  name: string;
  description: string;
}

/** An example as packaged by scripts/prepare-examples.ts. Paths are relative to the catalog. */
export interface PreparedExample extends ExampleSummary {
  /** Source copied into a new project's workspace. */
  directory: string;
  cover: string;
  /**
   * Static build played without creating a project. When omitted, Play and
   * Remix both use the project files.
   */
  play?: string;
}

export interface PreparedExampleCatalog {
  /** Version 1 includes projects on disk. Version 2 includes only covers. */
  version: 1 | 2;
  source: { repository: string; commit: string; release?: string };
  examples: PreparedExample[];
}

const exampleIdPattern = new RegExp(EXAMPLE_ID_PATTERN);
const sourceCommitPattern = /^[0-9a-f]{40}$/;

export type ExampleArchiveKind = "files" | "play";

export interface ExampleArchive {
  sha256: string;
  bytes: number;
}

export interface ExampleArchiveManifest {
  version: 1;
  commit: string;
  archives: Record<string, ExampleArchive>;
}

export function exampleArchiveKey(id: string, kind: ExampleArchiveKind): string {
  return `${id}/${kind}`;
}

export function isExampleArchive(value: unknown): value is ExampleArchive {
  if (!value || typeof value !== "object") return false;
  const archive = value as Record<string, unknown>;
  return typeof archive.sha256 === "string" && /^[0-9a-f]{64}$/.test(archive.sha256)
    && typeof archive.bytes === "number" && Number.isSafeInteger(archive.bytes)
    && archive.bytes > 0 && archive.bytes <= EXAMPLE_ARCHIVE_MAX_BYTES;
}

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
  if ((catalog.version !== 1 && catalog.version !== 2) || !source || typeof source.repository !== "string" || typeof source.commit !== "string") return false;
  if (catalog.version === 2 && (!/^[\w.-]+\/[\w.-]+$/.test(source.repository) || !sourceCommitPattern.test(source.commit))) return false;
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
  return typeof value === "string" && !/[\\:\0]/.test(value)
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}
