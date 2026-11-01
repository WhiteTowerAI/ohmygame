// Moves projects that used the format 1 TapTap Maker integration to the
// format 2 plugin's Maker type. Each project moves on its own; one that can't
// keeps its record's `integration` and is tried again on the next start.
import { constants } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import type { ProjectState } from "../shared/contracts.js";
import {
  capabilityGrants,
  projectFolderKey,
  readProjectFile,
  writeProjectFile,
} from "./project-plugins.js";
import type { PluginServices } from "./plugin-services.js";

/** The format 1 plugin's id in the bundled catalog. */
export const LEGACY_MAKER_ID = "ohmygame:taptap-maker";
export const MAKER_PLUGIN = "ohmygame/taptap-maker";
export const MAKER_TYPE = `${MAKER_PLUGIN}:maker`;

export interface LegacyMakerMigration {
  projects: { list(): ProjectState[]; migrateIntegration(id: string, pluginType: NonNullable<ProjectState["pluginType"]>): Promise<unknown> };
  services: PluginServices;
  /**
   * Whether the person had turned the format 1 plugin on; that is their
   * consent to the format 2 one, though never for a project from an archive.
   */
  legacyEnabled: boolean;
  /** The format 1 plugin's data folder, which holds the records of unfinished creates and binds. */
  legacyDataFolder: string;
  warn: (message: string, error?: unknown) => void;
  /** Told for each project that moved, so its sessions and screens pick up the type. */
  onMigrated?: (project: ProjectState) => void;
  /** Only this project, as one just imported from an archive. */
  only?: string;
}

export async function migrateLegacyMakerProjects(options: LegacyMakerMigration): Promise<void> {
  const legacy = options.projects
    .list()
    .filter((project) => project.integration?.pluginId === LEGACY_MAKER_ID && (!options.only || project.id === options.only));
  if (!legacy.length) return;
  const { services } = options;
  await services.ready();
  const entry = services.index.get(MAKER_PLUGIN);
  if (!entry) return options.warn("The bundled TapTap Maker plugin is missing; Maker projects keep their format 1 record");
  // The records keep a remote project's id before checkout, so a retried
  // create never makes a second one. Each is copied unless the plugin has its
  // own already; until every one is, no project moves.
  try {
    await copyRecords(
      path.join(options.legacyDataFolder, "initializations"),
      path.join(services.dataFolder(MAKER_PLUGIN), "initializations"),
    );
  } catch (error) {
    return options.warn("Could not copy TapTap Maker's unfinished project records; Maker projects move at the next start", error);
  }
  const grants = capabilityGrants(entry.manifest);
  // Someone who used format 1 Maker gets the format 2 plugin on, unless they
  // already decided about it themselves (consented or turned it on or off).
  const decided = services.grants.plugin(MAKER_PLUGIN);
  if (options.legacyEnabled && (!decided || (!decided.enabled && !decided.allowed.length))) {
    await services.grants.setEnabled(MAKER_PLUGIN, true);
    await services.grants.consent(MAKER_PLUGIN, grants);
  }
  for (const project of legacy) {
    try {
      const folder = await projectFolderKey(project.workspacePath);
      const current = await readProjectFile(folder);
      if (current && !current.ok) throw new Error(`its ohmygame.json is invalid: ${current.issues.slice(0, 3).join("; ")}`);
      const type = current?.file.type;
      if (type !== undefined && type !== "general" && type !== MAKER_TYPE)
        throw new Error(`its ohmygame.json says it is ${type}`);
      // A file the person or another plugin wrote keeps its other fields and pins.
      await writeProjectFile(
        folder,
        (file) => ({
          ...file,
          type: MAKER_TYPE,
          plugins: { ...file.plugins, [MAKER_PLUGIN]: file.plugins?.[MAKER_PLUGIN] ?? entry.version },
        }),
        { type: MAKER_TYPE, plugins: {} },
      );
      if (options.legacyEnabled && !project.integration?.imported) await services.grants.approve(folder, MAKER_PLUGIN, grants);
      await options.projects.migrateIntegration(project.id, { id: MAKER_TYPE, plugin: MAKER_PLUGIN, preview: "native" });
      await services.changed(folder);
      options.onMigrated?.(project);
    } catch (error) {
      options.warn(`Could not move the Maker project ${project.id} to the format 2 plugin`, error);
    }
  }
}

async function copyRecords(from: string, to: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(from);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    await copyFile(path.join(from, name), path.join(to, name), constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
}
