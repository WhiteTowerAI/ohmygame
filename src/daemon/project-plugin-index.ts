import { readdir } from "node:fs/promises";
import path from "node:path";
import { isPluginId, type PluginManifestIssue } from "../shared/plugin-manifest.js";
import { PROJECT_PLUGINS_DIRECTORY } from "../shared/project-layout.js";
import { indexPluginPackage, type PluginIndexEntry } from "./plugin-index.js";
import { realFolders } from "./project-layout.js";

// The plugins a project carries, in `.ohmygame/plugins/<publisher>/<name>/`.
// Each is a whole package, read and checked as an installed one is (links
// refused, the same size limits), except for what only the Plugins page
// shows. In its project it replaces the installed plugin with its id; nothing
// else sees it. They aren't kept in the plugin index: `PluginServices` reads
// them again when the folder changes.

/** A folder under `.ohmygame/plugins/` that isn't a plugin the app can use, and why. */
export interface ProjectPluginProblem {
  id: string;
  issues: PluginManifestIssue[];
}

export interface ProjectPluginPackages {
  entries: PluginIndexEntry[];
  problems: ProjectPluginProblem[];
}

/** Reads the plugins in a project folder (its real path). */
export async function readProjectPlugins(folder: string): Promise<ProjectPluginPackages> {
  const entries: PluginIndexEntry[] = [];
  const problems: ProjectPluginProblem[] = [];
  if (!(await realFolders(folder, PROJECT_PLUGINS_DIRECTORY))) return { entries, problems };
  const base = path.join(folder, ...PROJECT_PLUGINS_DIRECTORY.split("/"));
  for (const publisher of await folders(base)) {
    for (const name of await folders(path.join(base, publisher))) {
      const id = `${publisher}/${name}`;
      if (!isPluginId(id)) {
        problems.push({ id, issues: [{ path: "", message: `${PROJECT_PLUGINS_DIRECTORY}/${id} isn't named as a plugin id, publisher/name in lowercase letters, digits and hyphens` }] });
        continue;
      }
      const result = await indexPluginPackage(path.join(base, publisher, name), { project: true });
      if (!result.ok) problems.push({ id, issues: result.issues });
      else if (result.entry.id !== id) problems.push({ id, issues: [{ path: "/id", message: `the manifest says ${result.entry.id}, so it belongs in ${PROJECT_PLUGINS_DIRECTORY}/${result.entry.id}` }] });
      else entries.push(result.entry);
    }
  }
  return { entries, problems };
}

/** The real folders in a folder, by name; links are passed over. */
async function folders(directory: string): Promise<string[]> {
  const items = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return items.filter((item) => item.isDirectory()).map((item) => item.name).sort();
}
