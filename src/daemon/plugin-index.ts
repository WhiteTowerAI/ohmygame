import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  opendir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  PLUGIN_ARCHIVE_MAX_BYTES,
  PLUGIN_ARCHIVE_MAX_ENTRIES,
  PLUGIN_MANIFEST_PATH,
  PLUGIN_SKILL_CONTENT_MAX_BYTES,
  isNewerPluginVersion,
} from "../shared/plugins.js";
import {
  agentToolName,
  pluginApiIssue,
  toolSchemaIssues,
  validatePluginManifest,
  type PluginContributions,
  type PluginManifestIssue,
  type PluginManifestV2,
} from "../shared/plugin-manifest.js";
import { parseSkillMetadata } from "./skill-metadata.js";

// The plugin index: what every installed format 2 plugin offers, worked out
// once at install and kept in one file, so startup reads that file and
// nothing else. No plugin code runs to build it. Several versions of a
// plugin can be installed side by side; an entry is keyed by id and version
// and rebuilt when its package digest or the index schema changes.
//
// Packages are indexed, verified and rebuilt from folders the app owns (the
// installer's private staging copy, then the install folder it is moved to),
// so nothing else should be changing them. The reader still
// opens every file once, refusing links and anything that isn't a regular
// file, and derives the manifest, the checks and the digest from those same
// bytes.

export const PLUGIN_INDEX_SCHEMA_VERSION = 2;
/** A tool's input or output schema file; it goes to the model with every request. */
export const PLUGIN_TOOL_SCHEMA_MAX_BYTES = 32 * 1024;
export const PLUGIN_LOCALES = ["en", "zh-CN"] as const;
export type PluginLocale = (typeof PLUGIN_LOCALES)[number];
const MAX_DEPTH = 20;

export interface PluginSkillSummary {
  name: string;
  description: string;
  /** `./skills/<name>/SKILL.md` inside the package. */
  path: string;
}

export interface PluginIndexEntry {
  id: string;
  version: string;
  root: string;
  /** SHA-256 over the package's paths and contents. */
  digest: string;
  manifest: PluginManifestV2;
  /** `%key%` strings by locale; `en` holds every key the manifest uses. */
  strings: Partial<Record<PluginLocale, Record<string, string>>>;
  skills: PluginSkillSummary[];
  /** Tool and native command schemas by package path, from the indexed bytes. */
  toolSchemas: Record<string, Record<string, unknown>>;
}

export type PluginPackageResult =
  | { ok: true; entry: PluginIndexEntry }
  | { ok: false; issues: PluginManifestIssue[] };

class PluginPackageError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

/** Every regular file in a package by `./path`, read once. */
type PackageSnapshot = Map<string, Buffer>;

async function readPackage(root: string): Promise<PackageSnapshot> {
  const files: PackageSnapshot = new Map();
  let entries = 0;
  let bytes = 0;
  const walk = async (directory: string, depth: number) => {
    if (depth > MAX_DEPTH)
      throw new PluginPackageError("", "folders nest too deeply");
    // Entries stream in, so a huge folder stops at the limit instead of
    // being listed whole first.
    for await (const entry of await opendir(directory)) {
      const target = path.join(directory, entry.name);
      const relative = `./${path.relative(root, target).split(path.sep).join("/")}`;
      if (++entries > PLUGIN_ARCHIVE_MAX_ENTRIES)
        throw new PluginPackageError("", "too many files");
      if (entry.isSymbolicLink())
        throw new PluginPackageError(relative, "packages can't contain links");
      if (entry.isDirectory()) {
        await walk(target, depth + 1);
        continue;
      }
      if (!entry.isFile())
        throw new PluginPackageError(
          relative,
          "packages can only contain files and folders",
        );
      // Not following a link and not blocking on a FIFO, whatever is there now.
      const handle = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      ).catch(() => {
        throw new PluginPackageError(relative, "could not be read as a file");
      });
      try {
        const stats = await handle.stat();
        if (!stats.isFile())
          throw new PluginPackageError(
            relative,
            "packages can only contain files and folders",
          );
        bytes += stats.size;
        if (bytes > PLUGIN_ARCHIVE_MAX_BYTES)
          throw new PluginPackageError("", "package is too large");
        files.set(relative, await handle.readFile());
      } finally {
        await handle.close();
      }
    }
  };
  await walk(root, 0);
  return files;
}

function digest(files: PackageSnapshot): string {
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    const content = files.get(name)!;
    hash.update(`${name}\0${content.length}\0`);
    hash.update(content);
  }
  return hash.digest("hex");
}

function parseJson(content: Buffer | undefined): unknown {
  if (!content) return undefined;
  try {
    return JSON.parse(content.toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * The `%key%` references in the manifest's display strings. Only fields the
 * UI shows are read, so prompts, tool descriptions and defaults stay literal.
 */
function localizedKeys(manifest: PluginManifestV2): Set<string> {
  const contributes = manifest.contributes ?? {};
  const texts = [
    manifest.displayName,
    manifest.description,
    manifest.longDescription,
    ...(manifest.examples ?? []),
    ...Object.values(manifest.configuration ?? {}).flatMap((field) => [
      field.title,
      field.description,
    ]),
    ...(contributes.projectTypes ?? []).flatMap((type) => [
      type.title,
      type.description,
    ]),
    ...(contributes.commands ?? []).map((command) => command.title),
    ...(contributes.settings?.groups ?? []).flatMap((group) => [
      group.title,
      ...group.rows.flatMap((row) =>
        "title" in row ? [row.title, row.description] : [],
      ),
    ]),
    ...(contributes.themes ?? []).map((theme) => theme.title),
    ...(contributes.providers ?? []).flatMap((provider) => [
      provider.title,
      ...(provider.models ?? []).map((model) => model.title),
    ]),
    ...(contributes.panels ?? []).map((panel) => panel.title),
  ];
  const keys = new Set<string>();
  for (const text of texts) {
    const key = text && /^%([A-Za-z0-9_.-]+)%$/.exec(text)?.[1];
    if (key) keys.add(key);
  }
  return keys;
}

/** Reads, validates and summarizes one unpacked package. */
export async function indexPluginPackage(
  packageRoot: string,
): Promise<PluginPackageResult> {
  const root = path.resolve(packageRoot);
  let files: PackageSnapshot;
  try {
    files = await readPackage(root);
  } catch (error) {
    if (error instanceof PluginPackageError)
      return {
        ok: false,
        issues: [{ path: error.path, message: error.message }],
      };
    throw error;
  }
  return checkPackage(root, files);
}

function checkPackage(
  root: string,
  files: PackageSnapshot,
): PluginPackageResult {
  const issues: PluginManifestIssue[] = [];
  const issue = (at: string, message: string) =>
    issues.push({ path: at, message });
  const hasFolder = (folder: string) => {
    const prefix = folder.endsWith("/") ? folder : `${folder}/`;
    return [...files.keys()].some((name) => name.startsWith(prefix));
  };

  const raw = parseJson(files.get(`./${PLUGIN_MANIFEST_PATH}`));
  if (raw === undefined)
    return {
      ok: false,
      issues: [
        { path: "", message: `${PLUGIN_MANIFEST_PATH} is missing or not JSON` },
      ],
    };
  const validated = validatePluginManifest(raw);
  if (!validated.ok) return validated;
  const manifest = validated.manifest;
  const apiIssue = pluginApiIssue(manifest);
  if (apiIssue) issue("/engines/ohmygame-api", apiIssue);
  const contributes: PluginContributions = manifest.contributes ?? {};

  // Files the manifest points at must be in the package.
  const file = (at: string, relative: string | undefined) => {
    if (relative && !files.has(relative))
      issue(at, `${relative} is not in the package`);
  };
  const folder = (at: string, relative: string | undefined) => {
    if (relative && !hasFolder(relative))
      issue(at, `${relative} is not a folder in the package`);
  };
  file("/icon", manifest.icon);
  file("/entrypoints/native", manifest.entrypoints?.native);
  contributes.projectTypes?.forEach((type, index) => {
    file(`/contributes/projectTypes/${index}/icon`, type.icon);
    folder(`/contributes/projectTypes/${index}/template`, type.template);
  });
  contributes.commands?.forEach((command, index) =>
    file(`/contributes/commands/${index}/icon`, command.icon),
  );
  contributes.providers?.forEach((provider, index) =>
    file(`/contributes/providers/${index}/icon`, provider.icon),
  );
  contributes.panels?.forEach((panel, index) => {
    file(`/contributes/panels/${index}/entry`, panel.entry);
    file(`/contributes/panels/${index}/icon`, panel.icon);
  });
  const toolSchemas: Record<string, Record<string, unknown>> = {};
  const schemas = [
    ...(contributes.tools ?? []).flatMap((tool, index) =>
      (["input", "output"] as const).map((key) => ({ at: `/contributes/tools/${index}/${key}`, schema: tool[key] })),
    ),
    ...(contributes.commands ?? []).map((command, index) => ({
      at: `/contributes/commands/${index}/run/input`,
      schema: "native" in command.run ? command.run.input : undefined,
    })),
  ];
  for (const { at, schema } of schemas) {
    if (!schema) continue;
    const bytes = files.get(schema);
    if (!bytes) {
      issue(at, `${schema} is not in the package`);
      continue;
    }
    if (bytes.length > PLUGIN_TOOL_SCHEMA_MAX_BYTES) {
      issue(
        at,
        `${schema} is larger than ${PLUGIN_TOOL_SCHEMA_MAX_BYTES / 1024} KB`,
      );
      continue;
    }
    const value = parseJson(bytes);
    if (value === undefined) {
      issue(at, `${schema} is not JSON`);
      continue;
    }
    const problems = toolSchemaIssues(value);
    for (const problem of problems) issue(at, `${schema}: ${problem}`);
    if (!problems.length)
      toolSchemas[schema] = value as Record<string, unknown>;
  }

  // Skills: every `<folder>/<name>/SKILL.md`, named after its folder.
  const skills: PluginSkillSummary[] = [];
  if (contributes.skills) {
    const base = contributes.skills.replace(/\/$/, "");
    folder("/contributes/skills", base);
    for (const [name, content] of files) {
      if (!name.startsWith(`${base}/`)) continue;
      const parts = name.slice(base.length + 1).split("/");
      if (parts.length !== 2 || parts[1] !== "SKILL.md") continue;
      const skill = parts[0]!;
      const at = `/contributes/skills/${skill}`;
      if (content.length > PLUGIN_SKILL_CONTENT_MAX_BYTES) {
        issue(at, "SKILL.md is too large");
        continue;
      }
      let metadata;
      try {
        metadata = parseSkillMetadata(content.toString("utf8"));
      } catch {
        issue(at, "SKILL.md frontmatter is not valid YAML");
        continue;
      }
      if (metadata.name !== skill)
        issue(at, "the skill's name must match its folder");
      else if (!metadata.description)
        issue(at, "the skill needs a description");
      else
        skills.push({
          name: skill,
          description: metadata.description,
          path: name,
        });
    }
    skills.sort((a, b) => a.name.localeCompare(b.name));
    if (
      !skills.length &&
      !issues.some((item) => item.path.startsWith("/contributes/skills"))
    )
      issue("/contributes/skills", "no skills found");
  }
  const skillNames = new Set(skills.map((skill) => skill.name));
  contributes.commands?.forEach((command, index) => {
    if (
      "skill" in command.run &&
      command.run.skill &&
      !skillNames.has(command.run.skill)
    )
      issue(
        `/contributes/commands/${index}/run/skill`,
        `no skill named ${command.run.skill}`,
      );
  });

  // Strings: `en` must define every key the manifest uses.
  const strings: PluginIndexEntry["strings"] = {};
  for (const locale of PLUGIN_LOCALES) {
    const relative = `./locales/${locale}.json`;
    if (!files.has(relative)) continue;
    const value = parseJson(files.get(relative));
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Object.values(value).every(
        (text) => typeof text === "string" && text.length > 0,
      )
    )
      issue(relative, "must be an object of non-empty strings");
    else strings[locale] = value as Record<string, string>;
  }
  for (const key of localizedKeys(manifest))
    if (!localeText(strings.en, key)) issue("./locales/en.json", `missing %${key}%`);

  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    entry: {
      id: manifest.id,
      version: manifest.version,
      root,
      digest: digest(files),
      manifest,
      strings,
      skills,
      toolSchemas,
    },
  };
}

/** Resolves a manifest string for display: `%key%` in the locale, then `en`. */
export function localizePluginString(
  entry: Pick<PluginIndexEntry, "strings">,
  value: string,
  locale: PluginLocale,
): string {
  const key = /^%([A-Za-z0-9_.-]+)%$/.exec(value)?.[1];
  if (!key) return value;
  return localeText(entry.strings[locale], key) ?? localeText(entry.strings.en, key) ?? value;
}

/** A locale file's own string for a key: `%toString%` names nothing. */
function localeText(table: Record<string, string> | undefined, key: string): string | undefined {
  return table && Object.hasOwn(table, key) ? table[key] : undefined;
}

type ContributionKind = Exclude<
  keyof PluginContributions,
  "skills" | "settings"
>;
type ContributionItem<K extends ContributionKind> = NonNullable<
  PluginContributions[K]
>[number];

export interface IndexedContribution<K extends ContributionKind> {
  plugin: string;
  version: string;
  /** `publisher/name:id`, or `publisher/name:tool` for tools. */
  id: string;
  item: ContributionItem<K>;
  /** For tools, the name agents call it by. */
  agentName?: string;
}

interface IndexFile {
  schema: number;
  entries: PluginIndexEntry[];
}

const key = (id: string, version: string) => `${id}@${version}`;
const newestFirst = (a: PluginIndexEntry, b: PluginIndexEntry) =>
  isNewerPluginVersion(a.version, b.version)
    ? -1
    : isNewerPluginVersion(b.version, a.version)
      ? 1
      : 0;

export class PluginIndex {
  #entries = new Map<string, PluginIndexEntry>();
  /** Changes and saves run one at a time, in the order they were asked for. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  /**
   * Reads the index. Entries written by another index schema are rebuilt
   * from their packages; packages that are gone or no longer valid drop out.
   */
  load(): Promise<void> {
    return this.#serial(async () => {
      const data = parseJson(
        await readFile(this.file).catch(() => undefined),
      ) as IndexFile | undefined;
      this.#entries.clear();
      if (!data || !Array.isArray(data.entries)) return;
      if (data.schema === PLUGIN_INDEX_SCHEMA_VERSION) {
        for (const entry of data.entries)
          this.#entries.set(key(entry.id, entry.version), entry);
        return;
      }
      for (const entry of data.entries) {
        const result = await indexPluginPackage(entry.root).catch(
          () => undefined,
        );
        if (result?.ok)
          this.#entries.set(
            key(result.entry.id, result.entry.version),
            result.entry,
          );
      }
      await this.#save();
    });
  }

  entries(): PluginIndexEntry[] {
    return [...this.#entries.values()].sort(
      (a, b) => a.id.localeCompare(b.id) || newestFirst(a, b),
    );
  }

  /** Installed versions of a plugin, newest first. */
  versions(id: string): PluginIndexEntry[] {
    return this.entries().filter((entry) => entry.id === id);
  }

  /** One version of a plugin, or its newest when no version is given. */
  get(id: string, version?: string): PluginIndexEntry | undefined {
    return version ? this.#entries.get(key(id, version)) : this.versions(id)[0];
  }

  /** Indexes an unpacked package and records it beside other versions. */
  add(root: string): Promise<PluginPackageResult> {
    return this.#serial(async () => {
      const result = await indexPluginPackage(root);
      if (result.ok) {
        this.#entries.set(
          key(result.entry.id, result.entry.version),
          result.entry,
        );
        await this.#save();
      }
      return result;
    });
  }

  /** Forgets one version, or every version when none is given. */
  remove(id: string, version?: string): Promise<void> {
    return this.#serial(async () => {
      const removed = version
        ? this.#entries.delete(key(id, version))
        : this.versions(id).map((entry) =>
            this.#entries.delete(key(entry.id, entry.version)),
          ).length > 0;
      if (removed) await this.#save();
    });
  }

  /**
   * Checks an entry against its package on disk and re-indexes it when the
   * package changed. Returns false when the package is gone, invalid, or now
   * another plugin or version, which also drops the entry.
   */
  verify(id: string, version: string): Promise<boolean> {
    return this.#serial(async () => {
      const entry = this.#entries.get(key(id, version));
      if (!entry) return false;
      const files = await readPackage(entry.root).catch(() => undefined);
      if (files && digest(files) === entry.digest) return true;
      const result = files ? checkPackage(entry.root, files) : undefined;
      const same =
        result?.ok &&
        result.entry.id === id &&
        result.entry.version === version;
      if (same) this.#entries.set(key(id, version), result.entry);
      else this.#entries.delete(key(id, version));
      await this.#save();
      return Boolean(same);
    });
  }

  /**
   * One kind of contribution across plugins, from each plugin's newest
   * version until a project picks its own.
   */
  contributions<K extends ContributionKind>(kind: K): IndexedContribution<K>[] {
    const newest = new Map<string, PluginIndexEntry>();
    for (const entry of this.entries())
      if (!newest.has(entry.id)) newest.set(entry.id, entry);
    return [...newest.values()].flatMap((entry) =>
      ((entry.manifest.contributes?.[kind] ?? []) as ContributionItem<K>[]).map(
        (item) =>
          "name" in item
            ? {
                plugin: entry.id,
                version: entry.version,
                id: `${entry.id}:${item.name}`,
                item,
                agentName: agentToolName(entry.id, item.name),
              }
            : {
                plugin: entry.id,
                version: entry.version,
                id: `${entry.id}:${item.id}`,
                item,
              },
      ),
    );
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => {});
    return run;
  }

  async #save(): Promise<void> {
    const data: IndexFile = {
      schema: PLUGIN_INDEX_SCHEMA_VERSION,
      entries: this.entries(),
    };
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600 });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
