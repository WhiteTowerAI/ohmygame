import { cp, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PERSONAL_PUBLISHER } from "../shared/plugin-manifest.js";
import { pluginPublishingFiles, pluginTemplateIssue } from "../shared/plugin-template.js";
import { PLUGIN_MANIFEST_PATH } from "../shared/plugins.js";
import { indexPluginPackage, localizePluginString, type PluginIndexEntry } from "./plugin-index.js";

// "Export as a package": a plugin made in the Plugin Builder, `personal/<name>`,
// copied out as a package its author can publish: under their publisher, with
// the package.json, README and workflow new packages start with. Nothing is
// installed; the person can develop the folder from Add plugin.

export class PluginExportError extends Error {
  readonly statusCode = 400;
}

/** npm drops `.gitignore` from what it publishes, so a project template ships `gitignore`. */
const PUBLISHED_GITIGNORE = "gitignore";

/** Copies the plugin into a new folder `<into>/<name>`, as `<publisher>/<name>`, and returns that folder. */
export async function exportPlugin(entry: PluginIndexEntry, publisher: string, into: string): Promise<string> {
  if (!entry.id.startsWith(`${PERSONAL_PUBLISHER}/`)) throw new PluginExportError("Only a plugin you made in the Plugin Builder can be exported.");
  const name = entry.id.slice(PERSONAL_PUBLISHER.length + 1);
  const issue = pluginTemplateIssue({ publisher, name });
  if (issue) throw new PluginExportError(issue);
  if (!path.isAbsolute(into)) throw new PluginExportError("Choose the folder by its full path.");
  const target = path.join(into, name);
  const present = await readdir(target).catch((cause: NodeJS.ErrnoException) => (cause.code === "ENOENT" ? [] : undefined));
  if (present?.length !== 0) throw new PluginExportError(`${target} already has files in it. Choose another folder.`);
  const staging = path.join(into, `.${name}-${process.pid}-${Date.now()}`);
  await mkdir(into, { recursive: true }).catch(() => {
    throw new PluginExportError(`Can't make a folder in ${into}.`);
  });
  try {
    await cp(entry.root, staging, { recursive: true, verbatimSymlinks: true });
    const manifestFile = path.join(staging, ...PLUGIN_MANIFEST_PATH.split("/"));
    const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as Record<string, unknown>;
    await writeFile(manifestFile, `${JSON.stringify({ ...manifest, id: `${publisher}/${name}` }, null, 2)}\n`);
    // A preset's nodes name the plugin they run in, and it has a new id now.
    for (const preset of entry.manifest.contributes?.canvasPresets ?? []) {
      const file = path.join(staging, preset.board);
      const board = JSON.parse(await readFile(file, "utf8")) as { nodes?: { data?: { node?: unknown } }[] };
      for (const node of board.nodes ?? [])
        if (node.data && typeof node.data.node === "string" && node.data.node.startsWith(`${entry.id}:`))
          node.data.node = `${publisher}/${name}${node.data.node.slice(entry.id.length)}`;
      await writeFile(file, `${JSON.stringify(board, null, 2)}\n`);
    }
    // Installed, a template has its .gitignore back; published, it needs the name npm keeps.
    for (const type of entry.manifest.contributes?.projectTypes ?? [])
      if (type.template) await hideGitignores(path.join(staging, type.template));
    const published = (await readdir(staging)).filter((item) => !["package.json", "README.md", ".gitignore", ".github"].includes(item));
    const files = pluginPublishingFiles({
      publisher,
      name,
      displayName: localizePluginString(entry, entry.manifest.displayName, "en"),
      description: localizePluginString(entry, entry.manifest.description, "en"),
    }, entry.version, published);
    for (const [file, text] of Object.entries(files)) {
      const destination = path.join(staging, ...file.split("/"));
      // A README the plugin already has stays.
      if (file === "README.md" && (await readFile(destination).then(() => true, () => false))) continue;
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, text);
    }
    const checked = await indexPluginPackage(staging);
    if (!checked.ok) throw new PluginExportError(`The exported package isn't valid: ${checked.issues.slice(0, 3).map((item) => `${item.path} ${item.message}`.trim()).join("; ")}`);
    // Only an empty folder gives way; one that got files meanwhile stays as it is.
    await rmdir(target).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "ENOENT") throw new PluginExportError(`${target} already has files in it. Choose another folder.`);
    });
    await rename(staging, target);
    return target;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function hideGitignores(directory: string): Promise<void> {
  for (const item of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(directory, item.name);
    if (item.isDirectory()) await hideGitignores(full);
    else if (item.name === ".gitignore") await rename(full, path.join(directory, PUBLISHED_GITIGNORE));
  }
}
