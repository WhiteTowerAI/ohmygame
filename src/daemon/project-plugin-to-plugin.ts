import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PERSONAL_PUBLISHER } from "../shared/plugin-manifest.js";
import { PLUGIN_MANIFEST_PATH } from "../shared/plugins.js";

// A plugin a project made for itself, `project/<name>`, made into a plugin
// for every project: its package is copied whole under a `personal/` id, so
// the Plugin Builder starts from a package that already passes its checks,
// and the workspace's agent is asked to finish it.

/** A plain tile, so the plugin has the icon an installed plugin's tab needs until the agent draws a better one. */
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#4f5bd5"/><rect x="14" y="16" width="36" height="32" rx="5" fill="none" stroke="#ffffff" stroke-width="4"/><path d="M14 26h36" stroke="#ffffff" stroke-width="4"/></svg>
`;
const ICON_PATH = "assets/icon.svg";

/** The first `personal/<name>` id that `taken` says is free: the plugin's name, then with a number. */
export function personalPluginId(name: string, taken: (id: string) => boolean): string {
  for (let index = 1; ; index += 1) {
    const id = `${PERSONAL_PUBLISHER}/${index === 1 ? name : `${name}-${index}`}`;
    if (!taken(id)) return id;
  }
}

/**
 * Copies the project's plugin at `source` to `root` as `id`: the same files,
 * with the manifest's id changed and, as a project's plugin needs none, a
 * plain icon when it has none.
 */
export async function writeProjectPluginCopy(root: string, source: string, id: string): Promise<void> {
  // The package was indexed, so it holds no links.
  await cp(source, root, { recursive: true });
  const file = path.join(root, ...PLUGIN_MANIFEST_PATH.split("/"));
  const manifest = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  if (manifest.icon === undefined) {
    const icon = path.join(root, ...ICON_PATH.split("/"));
    await mkdir(path.dirname(icon), { recursive: true });
    // A file already there is kept, as the icon.
    await writeFile(icon, ICON, { flag: "wx" }).catch(() => {});
  }
  await writeFile(file, `${JSON.stringify({ ...manifest, id, ...(manifest.icon === undefined ? { icon: `./${ICON_PATH}` } : {}) }, null, 2)}\n`);
}

/** What the workspace's agent is asked to do with the plugin; in English, as all text sent to the agent. */
export function projectPluginPrompt(folder: string, from: string): string {
  return [
    `This plugin was made from ${from}, a plugin one project made for itself; its package is in ${folder}/.`,
    "Read it, give the plugin a description and an icon that fit every project, check it with plugin_manage prepare and look at it in the preview.",
    "Then say what changed and what I should check.",
  ].join(" ");
}
