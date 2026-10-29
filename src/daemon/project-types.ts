import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { ProjectState, ProjectType } from "../shared/contracts.js";
import type { WebBuild } from "../shared/extension-host-protocol.js";
import {
  CORE_PROJECT_TYPES,
  PROJECT_FILE_NAME,
  PROJECT_FILE_SCHEMA_URL,
  projectTypePlugin,
} from "../shared/project-file.js";
import { ExtensionHostError } from "./extension-hosts.js";
import {
  localizePluginString,
  type PluginIndexEntry,
  type PluginLocale,
} from "./plugin-index.js";
import type { PluginServices } from "./plugin-services.js";
import {
  capabilityGrants,
  createProjectPlugins,
  projectFolderKey,
  readProjectFile,
  resolveProjectPlugins,
} from "./project-plugins.js";

// Project types: the two the app has itself, and those plugins contribute.
// A plugin type comes with a template or a `createProject` hook, files that
// recognize it in a folder, and how its game is previewed. A `"web-build"`
// type's plugin builds a web version of the game, which the host serves in
// the game panel like any web game.

/** App project kinds that are plugin types now; the app's own routing still names them. */
export const PLUGIN_PROJECT_KINDS = {
  "godot-game": "ohmygame/godot:godot-game",
} as const satisfies Record<string, string>;

type ProjectTypeContribution = NonNullable<
  NonNullable<PluginIndexEntry["manifest"]["contributes"]>["projectTypes"]
>[number];

export interface AvailableProjectType {
  /** A core type, or `publisher/name:type`. */
  id: string;
  title: string;
  description?: string;
  preview?: ProjectTypeContribution["preview"];
  /** For plugin types: the plugin and the version new projects use. */
  plugin?: { id: string; version: string };
  /** Whether new projects of it start from files or from the plugin's hook. */
  creates?: "template" | "hook";
}

const CORE_TITLES: Record<
  (typeof CORE_PROJECT_TYPES)[number],
  Record<PluginLocale, string>
> = {
  general: { en: "General", "zh-CN": "通用" },
  "interactive-story": { en: "Interactive story", "zh-CN": "互动故事" },
};

/** Builds can take minutes; a build that takes longer is stopped. */
const WEB_BUILD_TIMEOUT_MS = 10 * 60_000;
/** Recognizing a folder never reads more than these files' metadata. */
const RECOGNIZE_FILES_MAX = 10;

const unavailable = (message: string) =>
  new ExtensionHostError("unavailable", message);

function contribution(
  entry: PluginIndexEntry,
  typeId: string,
): ProjectTypeContribution | undefined {
  return entry.manifest.contributes?.projectTypes?.find(
    (type) => type.id === typeId,
  );
}

/** Core types first, then each installed plugin's types from its newest version. */
export async function availableProjectTypes(
  services: PluginServices,
  locale: PluginLocale = "en",
): Promise<AvailableProjectType[]> {
  await services.ready();
  const types: AvailableProjectType[] = CORE_PROJECT_TYPES.map((id) => ({
    id,
    title: CORE_TITLES[id][locale],
  }));
  const seen = new Set<string>();
  for (const entry of services.index.entries()) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const newest = services.index.get(entry.id)!;
    if (services.grants.plugin(newest.id)?.enabled === false) continue;
    const hasCreate = Boolean(newest.manifest.entrypoints?.native);
    for (const type of newest.manifest.contributes?.projectTypes ?? [])
      types.push({
        id: `${newest.id}:${type.id}`,
        title: localizePluginString(newest, type.title, locale),
        ...(type.description
          ? {
              description: localizePluginString(
                newest,
                type.description,
                locale,
              ),
            }
          : {}),
        preview: type.preview,
        plugin: { id: newest.id, version: newest.version },
        creates: type.template ? "template" : hasCreate ? "hook" : "template",
      });
  }
  return types;
}

/**
 * The plugin types a folder looks like, for 导入文件夹: every file a type's
 * `recognize` lists must exist as a file. When several match, the person
 * chooses.
 */
export async function recognizeProjectTypes(
  folder: string,
  services: PluginServices,
): Promise<AvailableProjectType[]> {
  const root = await realpath(folder);
  const matches: AvailableProjectType[] = [];
  for (const type of await availableProjectTypes(services)) {
    if (!type.plugin) continue;
    const entry = services.index.get(type.plugin.id, type.plugin.version)!;
    const files =
      contribution(entry, type.id.slice(type.plugin.id.length + 1))?.recognize
        ?.files ?? [];
    if (!files.length) continue;
    const present = await Promise.all(
      files.slice(0, RECOGNIZE_FILES_MAX).map(async (file) => {
        // Paths are validated as plain relative segments in the manifest.
        const target = path.join(root, file);
        const stats = await lstat(target).catch(() => undefined);
        return Boolean(stats?.isFile());
      }),
    );
    if (present.every(Boolean)) matches.push(type);
  }
  return matches;
}

/** Copies a template into an empty folder; links and special files are refused. */
async function copyTemplate(source: string, target: string): Promise<void> {
  for (const item of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, item.name);
    const to = path.join(target, item.name);
    if (item.isDirectory()) {
      await mkdir(to, { recursive: true });
      await copyTemplate(from, to);
    } else if (item.isFile()) {
      // The host writes the project file itself.
      if (item.name === PROJECT_FILE_NAME) continue;
      await copyFile(from, to);
    } else throw new Error(`${from} is not a file or folder`);
  }
}

/**
 * Starts a project of a plugin type in an empty folder: writes
 * `ohmygame.json` with the type's plugin (allowed there, since the person
 * chose it), then the template or the plugin's `createProject`.
 */
export async function createTypedProject({
  folder,
  type,
  name,
  plugins = {},
  services,
  signal,
}: {
  folder: string;
  type: string;
  name: string;
  /** Other plugins the project starts with, at exact versions. */
  plugins?: Record<string, string>;
  services: PluginServices;
  signal?: AbortSignal;
}): Promise<void> {
  await services.ready();
  await mkdir(folder, { recursive: true });
  const existing = (await readdir(folder)).filter(
    (item) => item !== ".DS_Store",
  );
  if (existing.length) throw new Error("A new project needs an empty folder");
  const owner = projectTypePlugin(type);
  if (!owner) {
    if (!(CORE_PROJECT_TYPES as readonly string[]).includes(type))
      throw new Error(`${type} is not a project type`);
    await createProjectPlugins({
      folder,
      type,
      plugins,
      index: services.index,
      grants: services.grants,
    });
    return;
  }
  const entry = services.index.get(owner, plugins[owner]);
  if (!entry) throw unavailable(`${owner} is not installed`);
  const typeId = type.slice(owner.length + 1);
  const contributed = contribution(entry, typeId);
  if (!contributed)
    throw unavailable(
      `${owner} ${entry.version} has no project type ${typeId}`,
    );
  await createProjectPlugins({
    folder,
    type,
    plugins: { ...plugins, [owner]: entry.version },
    index: services.index,
    grants: services.grants,
  });
  if (contributed.template)
    await copyTemplate(path.resolve(entry.root, contributed.template), folder);
  else if (entry.manifest.entrypoints?.native)
    await services.native.projectTypeHook(type, "createProject", {
      folder,
      input: { name },
      signal,
      timeoutMs: WEB_BUILD_TIMEOUT_MS,
    });
  await services.changed(folder);
}

/**
 * Takes on a folder that already holds a plugin type's project, for 导入文件夹:
 * the type must recognize it. Writes `ohmygame.json` only when the folder has
 * none; one that exists is the folder's own and is never rewritten.
 */
export async function adoptTypedProject({
  folder,
  type,
  services,
}: {
  folder: string;
  type: string;
  services: PluginServices;
}): Promise<void> {
  await services.ready();
  const owner = projectTypePlugin(type);
  if (!owner) throw new Error(`${type} is one of the app's own types`);
  const key = await projectFolderKey(folder);
  const existing = await readProjectFile(key);
  if (existing && !existing.ok)
    throw new Error(
      `The folder's ${PROJECT_FILE_NAME} is invalid: ${existing.issues.slice(0, 3).join("; ")}`,
    );
  let version = existing?.ok ? existing.file.plugins?.[owner] : undefined;
  if (existing?.ok) {
    if (existing.file.type !== type)
      throw new Error(
        `The folder's ${PROJECT_FILE_NAME} says it is ${existing.file.type}`,
      );
    if (!version || !services.index.get(owner, version))
      throw unavailable(
        `The folder's ${PROJECT_FILE_NAME} asks for ${owner}${version ? ` ${version}` : ""}, which is not installed`,
      );
  } else {
    if (
      !(await recognizeProjectTypes(key, services)).some(
        (match) => match.id === type,
      )
    )
      throw new Error(`The folder doesn't look like a ${type} project`);
    version = services.index.get(owner)!.version;
    // Created only if still missing: a file another writer made meanwhile is
    // the folder's own and is never replaced.
    try {
      await writeFile(
        path.join(key, PROJECT_FILE_NAME),
        `${JSON.stringify({ $schema: PROJECT_FILE_SCHEMA_URL, type, plugins: { [owner]: version } }, null, 2)}\n`,
        { flag: "wx" },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(
          `The folder's ${PROJECT_FILE_NAME} appeared while it was being added; add it again`,
        );
      throw error;
    }
  }
  // Choosing the type is the person's choice for this folder: its plugin is
  // allowed here at the pinned version. Other plugins the file asks for still
  // wait for approval, and install consent still applies.
  await services.grants.approve(
    key,
    owner,
    capabilityGrants(services.index.get(owner, version)!.manifest),
  );
  await services.changed(folder);
}

/**
 * What the app records for a project of this type: the app kind its screens
 * route on, and the plugin that previews it. `ohmygame.json` decides
 * everything else when the project runs.
 */
export function projectKind(type: AvailableProjectType): {
  kind: ProjectType;
  pluginType?: NonNullable<ProjectState["pluginType"]>;
} {
  if (!type.plugin || !type.preview) return { kind: type.id as ProjectType };
  const alias = Object.entries(PLUGIN_PROJECT_KINDS).find(
    ([, id]) => id === type.id,
  )?.[0] as ProjectType | undefined;
  // A `"web"` type's files are served as they are, a `"web-build"` one's
  // plugin builds them, and a `"native"` one runs outside OhMyGame through
  // its plugin's commands.
  return {
    kind: alias ?? "general",
    pluginType: { id: type.id, plugin: type.plugin.id, preview: type.preview },
  };
}

/** The record for a folder whose `ohmygame.json` names a plugin type, from the version it pins. */
export async function projectKindAt(
  folder: string,
  services: PluginServices,
): Promise<ReturnType<typeof projectKind> | undefined> {
  await services.ready();
  const read = await readProjectFile(folder);
  if (!read?.ok) return undefined;
  const owner = projectTypePlugin(read.file.type);
  const version = owner ? read.file.plugins?.[owner] : undefined;
  const entry = owner && version ? services.index.get(owner, version) : undefined;
  const contributed = entry
    ? contribution(entry, read.file.type.slice(owner!.length + 1))
    : undefined;
  if (!entry || !contributed) return undefined;
  return projectKind({
    id: read.file.type,
    title: contributed.title,
    preview: contributed.preview,
    plugin: { id: entry.id, version: entry.version },
  });
}

/** How the folder's game is previewed, from its type in `ohmygame.json`. */
export async function projectPreviewMode(
  folder: string,
  services: PluginServices,
): Promise<ProjectTypeContribution["preview"] | undefined> {
  await services.ready();
  const read = await readProjectFile(folder).catch(() => undefined);
  if (!read?.ok) return undefined;
  const owner = projectTypePlugin(read.file.type);
  const version = owner ? read.file.plugins?.[owner] : undefined;
  const entry =
    owner && version ? services.index.get(owner, version) : undefined;
  return entry
    ? contribution(entry, read.file.type.slice(owner!.length + 1))?.preview
    : undefined;
}

/**
 * Builds a `"web-build"` project's game with its plugin and returns the
 * folder to serve. Undefined when the project's type isn't built this way.
 */
export async function buildWebPreview({
  folder,
  services,
  signal,
  onProgress,
}: {
  folder: string;
  services: PluginServices;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<{ directory: string; entry: string } | undefined> {
  if ((await projectPreviewMode(folder, services)) !== "web-build")
    return undefined;
  const resolved = await resolveProjectPlugins({
    folder,
    index: services.index,
    grants: services.grants,
  });
  if (!resolved?.ok) return undefined;
  if (!resolved.typeReady)
    throw unavailable(
      `The project's type comes from a plugin that isn't on here: ${resolved.plugins.find((plugin) => plugin.providesType)?.status ?? "missing"}`,
    );
  const result = (await services.native.projectTypeHook(
    resolved.file.type,
    "buildWeb",
    { folder, signal, onProgress, timeoutMs: WEB_BUILD_TIMEOUT_MS },
  )) as Partial<WebBuild> | undefined;
  return checkedWebBuild(folder, result);
}

/** A build stays inside its project, as a folder holding its page. */
async function checkedWebBuild(
  folder: string,
  result: Partial<WebBuild> | undefined,
): Promise<{ directory: string; entry: string }> {
  const fail = (why: string) =>
    new ExtensionHostError("failed", `The web build ${why}`);
  if (!result || typeof result.folder !== "string")
    throw fail("did not say where it is");
  const entry = result.entry ?? "index.html";
  if (
    typeof entry !== "string" ||
    entry.includes("..") ||
    path.isAbsolute(entry)
  )
    throw fail("named a page outside its folder");
  const root = await realpath(folder);
  const directory = await realpath(path.resolve(root, result.folder)).catch(
    () => undefined,
  );
  const relative = directory ? path.relative(root, directory) : "..";
  if (!directory || relative.startsWith("..") || path.isAbsolute(relative))
    throw fail("is not in the project folder");
  const page = await lstat(path.join(directory, entry)).catch(() => undefined);
  if (!page?.isFile()) throw fail(`has no ${entry}`);
  return { directory, entry };
}
