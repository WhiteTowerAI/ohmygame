import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename } from "node:fs/promises";
import path from "node:path";
import packlist from "npm-packlist";
import { PLUGIN_ARCHIVE_MAX_BYTES, PLUGIN_ARCHIVE_MAX_ENTRIES } from "../shared/plugins.js";
import { extractTarball } from "./archive-extraction.js";
import { indexPluginPackage } from "./plugin-index.js";

// What a plugin folder publishes, by npm's own rules (`files`, `.npmignore`,
// else `.gitignore`, and what npm always leaves out), so a folder added from
// this computer, in development or not, is what `npm publish` would send.

/** npm drops `.gitignore` from what it publishes, so a template ships `gitignore`. */
const PUBLISHED_GITIGNORE = "gitignore";
const VALID_PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

export class PluginPackError extends Error {}

function withinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function assertNoSymlinkSegments(base: string, segments: readonly string[]): Promise<void> {
  let current = base;
  for (const segment of segments) {
    current = path.join(current, segment);
    const info = await lstat(current).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return undefined;
      throw cause;
    });
    if (!info) return;
    if (info.isSymbolicLink()) throw new PluginPackError("packages can't contain links");
  }
}

/** The files `npm pack` would put in the package, as sorted `/`-separated paths. */
export async function publishedFiles(root: string): Promise<string[]> {
  const realRoot = await realpath(root);
  const text = await readFile(path.join(realRoot, "package.json"), "utf8").catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return undefined;
    throw cause;
  });
  let manifest: Record<string, unknown> = {};
  if (text !== undefined) {
    try {
      manifest = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new PluginPackError("package.json isn't JSON");
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new PluginPackError("package.json isn't an object");
  }
  const files = await packlist(await packageNode(realRoot, manifest, true, new Map(), realRoot));
  // npm can't pack a folder without package.json; its rules for one leave out
  // what a package.json would, which a plain folder needn't publish either.
  const kept = text === undefined ? files.filter((file) => !/^(?:node_modules\/|(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$)/.test(file)) : files;
  return [...kept].sort();
}

interface PackageNode {
  path: string;
  target: PackageNode;
  isLink: false;
  isProjectRoot: boolean;
  package: Record<string, unknown>;
  edgesOut: Map<string, { to: PackageNode; dev: boolean; peer: boolean }>;
}

const names = (value: unknown): string[] => value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];

/**
 * The parts of npm's package tree packlist reads: the folder, its package.json
 * and, for what it bundles, where each dependency is installed, found the way
 * Node finds it, in `node_modules` here or in a folder above, inside the root.
 */
async function packageNode(directory: string, manifest: Record<string, unknown>, isProjectRoot: boolean, seen: Map<string, PackageNode>, root = directory): Promise<PackageNode> {
  const known = seen.get(directory);
  if (known) return known;
  // packlist throws outside its promise on a malformed list, which would stop the app.
  if (manifest.files !== undefined && !(Array.isArray(manifest.files) && manifest.files.every((item) => typeof item === "string")))
    throw new PluginPackError(`${isProjectRoot ? "package.json" : `${path.relative(root, directory).split(path.sep).join("/")}/package.json`}: files must be a list of paths`);
  const node = { path: directory, isLink: false, isProjectRoot, package: { ...manifest }, edgesOut: new Map() } as PackageNode;
  node.target = node;
  seen.set(directory, node);
  const dependencies = names(manifest.dependencies);
  const optional = names(manifest.optionalDependencies);
  let bundled: string[];
  if (isProjectRoot) {
    const declared = manifest.bundleDependencies ?? manifest.bundledDependencies;
    if (Array.isArray(declared)) {
      for (const item of declared) {
        if (typeof item === "string" && !VALID_PACKAGE_NAME.test(item)) {
          throw new PluginPackError(`package.json: invalid bundled dependency "${item}"`);
        }
      }
    }
    bundled = declared === true ? dependencies : Array.isArray(declared) ? declared.filter((name): name is string => typeof name === "string") : [];
    node.package.bundleDependencies = bundled;
  } else bundled = [...dependencies, ...optional];
  for (const name of bundled) {
    const found = await installed(directory, name, root);
    if (!found) continue;
    const child = await packageNode(found.folder, found.manifest, false, seen, root);
    node.edgesOut.set(name, {
      to: child,
      dev: isProjectRoot && !dependencies.includes(name) && !optional.includes(name) && names(manifest.devDependencies).includes(name),
      peer: isProjectRoot && !dependencies.includes(name) && !optional.includes(name) && names(manifest.peerDependencies).includes(name),
    });
  }
  return node;
}

async function installed(from: string, name: string, root: string): Promise<{ folder: string; manifest: Record<string, unknown> } | undefined> {
  if (!VALID_PACKAGE_NAME.test(name)) return undefined;
  const parts = name.split("/");
  for (let directory = from; ; directory = path.dirname(directory)) {
    const folder = path.join(directory, "node_modules", ...parts);
    await assertNoSymlinkSegments(directory, ["node_modules", ...parts, "package.json"]);
    const text = await readFile(path.join(folder, "package.json"), "utf8").catch(() => undefined);
    if (text !== undefined) {
      const realFolder = await realpath(folder).catch(() => undefined);
      if (!realFolder || !withinRoot(root, realFolder)) {
        throw new PluginPackError("bundled dependency escapes package root");
      }
      try {
        const manifest = JSON.parse(text) as unknown;
        if (manifest && typeof manifest === "object" && !Array.isArray(manifest)) return { folder: realFolder, manifest: manifest as Record<string, unknown> };
      } catch {
        // npm can't read it either, so it bundles nothing from it.
      }
      return undefined;
    }
    if (path.relative(root, directory) === "" || path.dirname(directory) === directory) return undefined;
  }
}

/**
 * Copies what the folder publishes into `target`, a new folder, and gives
 * project templates back their `.gitignore`, as adding a published package does.
 */
export async function stagePublished(root: string, target: string): Promise<void> {
  const realRoot = await realpath(root);
  const files = await publishedFiles(realRoot);
  if (files.length > PLUGIN_ARCHIVE_MAX_ENTRIES) throw new PluginPackError("too many files");
  await mkdir(target, { recursive: true });
  const realTarget = await realpath(target);
  let bytes = 0;
  const staged: Array<{ source: string; destination: string }> = [];
  for (const file of files) {
    const parts = file.split("/");
    if (!file || file.includes("\0") || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes(":"))) {
      throw new PluginPackError("package file path is invalid");
    }
    await assertNoSymlinkSegments(realRoot, parts);
    const source = path.join(realRoot, ...parts);
    const info = await lstat(source);
    if (!info.isFile()) continue;
    const realSource = await realpath(source);
    if (!withinRoot(realRoot, realSource)) throw new PluginPackError("package file escapes root");
    const destination = path.resolve(realTarget, ...parts);
    if (!withinRoot(realTarget, destination)) throw new PluginPackError("package file escapes target");
    bytes += info.size;
    if (bytes > PLUGIN_ARCHIVE_MAX_BYTES) throw new PluginPackError("package is too large");
    staged.push({ source: realSource, destination });
  }
  for (const entry of staged) {
    await mkdir(path.dirname(entry.destination), { recursive: true });
    await copyFile(entry.source, entry.destination);
  }
  await restoreTemplateGitignores(realTarget);
}

/** Unpacks into `folder`, returning the package's root: the one folder an archive wraps it in. */
export async function unpackPlugin(
  archive: string,
  folder: string,
  { published, error }: { published: boolean; error: (reason: string) => Error },
): Promise<string> {
  const destination = path.join(folder, "package");
  await mkdir(destination);
  await extractTarball(archive, destination, {
    maxEntries: PLUGIN_ARCHIVE_MAX_ENTRIES,
    maxBytes: PLUGIN_ARCHIVE_MAX_BYTES,
    error,
  });
  const items = await readdir(destination, { withFileTypes: true });
  const root = items.length === 1 && items[0]!.isDirectory() && items[0]!.name !== ".ohmygame-plugin"
    ? path.join(destination, items[0]!.name)
    : destination;
  if (published) await restoreTemplateGitignores(root);
  return root;
}

async function restoreTemplateGitignores(root: string): Promise<void> {
  const checked = await indexPluginPackage(root);
  if (!checked.ok) return;
  for (const projectType of checked.entry.manifest.contributes?.projectTypes ?? [])
    if (projectType.template) await renameGitignores(path.join(root, projectType.template));
  for (const template of checked.entry.manifest.contributes?.templates ?? [])
    await renameGitignores(path.join(root, template.folder));
}

async function renameGitignores(directory: string): Promise<void> {
  const items = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const names = new Set(items.map((item) => item.name));
  for (const item of items) {
    if (item.isDirectory()) await renameGitignores(path.join(directory, item.name));
    else if (item.name === PUBLISHED_GITIGNORE && !names.has(".gitignore"))
      await rename(path.join(directory, item.name), path.join(directory, ".gitignore"));
  }
}
