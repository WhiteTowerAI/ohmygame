// Moves what the format 1 Godot plugin kept to the format 2 plugin, which
// replaced it: Godot projects from before it, which had no `ohmygame.json`,
// and its executable setting. Format 1 took a command or a path and defaulted
// to `godot`; format 2 takes an absolute path and finds Godot itself when
// it's empty.
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import type { ProjectState } from "../shared/contracts.js";
import { PLUGIN_PROJECT_KINDS } from "../shared/project-runtime.js";
import type { PluginConfigurationStore } from "./plugin-configuration.js";
import type { PluginServices } from "./plugin-services.js";
import { capabilityGrants, projectFolderKey, readProjectFile, writeProjectFile } from "./project-plugins.js";

export const LEGACY_GODOT_ID = "ohmygame:godot";
export const GODOT_PLUGIN = "ohmygame/godot";
export const GODOT_TYPE = PLUGIN_PROJECT_KINDS["godot-game"];

export interface LegacyGodotProjects {
  projects: { list(): ProjectState[]; setPluginType(id: string, pluginType: NonNullable<ProjectState["pluginType"]>): Promise<unknown> };
  services: Pick<PluginServices, "ready" | "index" | "grants" | "changed">;
  /**
   * Whether Godot works in these projects as it did: the person hadn't turned
   * the format 1 plugin off, and the project isn't one just taken from an
   * archive, whose folder waits for the person's approval.
   */
  approve: boolean;
  warn: (message: string, error?: unknown) => void;
  onMigrated?: (project: ProjectState) => void;
  /** Only this project, as one just imported from an archive. */
  only?: string;
}

/**
 * Gives each Godot project that has no plugin type yet the format 2 Godot
 * type: its `ohmygame.json` names the type and pins the bundled version.
 * A folder whose file names another type keeps it; a project that can't move
 * is tried again on the next start.
 */
export async function migrateLegacyGodotProjects(options: LegacyGodotProjects): Promise<void> {
  const legacy = options.projects
    .list()
    .filter((project) => project.type === "godot-game" && !project.pluginType && (!options.only || project.id === options.only));
  if (!legacy.length) return;
  await options.services.ready();
  const entry = options.services.index.get(GODOT_PLUGIN);
  const contributed = entry?.manifest.contributes?.projectTypes?.find((type) => `${GODOT_PLUGIN}:${type.id}` === GODOT_TYPE);
  if (!entry || !contributed?.preview)
    return options.warn("The bundled Godot plugin is missing; Godot projects keep their format 1 record");
  const pluginType = { id: GODOT_TYPE, plugin: GODOT_PLUGIN, preview: contributed.preview };
  for (const project of legacy) {
    try {
      const folder = await projectFolderKey(project.workspacePath);
      const existing = await readProjectFile(folder);
      if (existing && !existing.ok) {
        options.warn(`Godot project ${project.id} has an invalid ohmygame.json; it keeps its format 1 record`);
        continue;
      }
      if (existing?.ok && existing.file.type !== GODOT_TYPE) continue;
      const pinned = existing?.ok ? existing.file.plugins?.[GODOT_PLUGIN] : undefined;
      const version = pinned && options.services.index.get(GODOT_PLUGIN, pinned) ? pinned : entry.version;
      if (version !== pinned)
        await writeProjectFile(
          folder,
          (file) => ({ ...file, plugins: { ...file.plugins, [GODOT_PLUGIN]: version } }),
          { type: GODOT_TYPE, plugins: { [GODOT_PLUGIN]: version } },
        );
      if (options.approve)
        await options.services.grants.approve(folder, GODOT_PLUGIN, capabilityGrants(options.services.index.get(GODOT_PLUGIN, version)!.manifest));
      await options.projects.setPluginType(project.id, pluginType);
      await options.services.changed(folder);
      options.onMigrated?.(project);
    } catch (error) {
      options.warn(`Could not move Godot project ${project.id} to the format 2 plugin`, error);
    }
  }
}

export interface LegacyGodotMigration {
  configuration: Pick<PluginConfigurationStore, "storedValues" | "remove">;
  services: Pick<PluginServices, "ready" | "index" | "values">;
  warn: (message: string, error?: unknown) => void;
  /** For tests: the PATH and executable suffixes to look a command up in. */
  environment?: { PATH?: string; PATHEXT?: string };
}

/**
 * Sets format 2 Godot's `godotPath` from format 1's `godot-path`, unless the
 * person already set it, and then forgets the format 1 values so a later
 * change sticks. A command that isn't found stays for the next start.
 */
export async function migrateLegacyGodotPath(options: LegacyGodotMigration): Promise<void> {
  const stored = options.configuration.storedValues(LEGACY_GODOT_ID);
  if (!stored) return;
  const setting = typeof stored["godot-path"] === "string" ? stored["godot-path"].trim() : "";
  if (setting && setting !== "godot") {
    await options.services.ready();
    const entry = options.services.index.get(GODOT_PLUGIN);
    if (!entry) return options.warn("The bundled Godot plugin is missing; its executable setting moves at the next start");
    const current = options.services.values.view(entry).godotPath;
    if (!(current && "value" in current && current.value)) {
      const executable = path.isAbsolute(setting) ? setting : await onPath(setting, options.environment ?? process.env);
      if (!executable) return options.warn(`Godot's executable setting names ${setting}, which isn't on the PATH; it moves at the next start`);
      try {
        await options.services.values.update(entry, { godotPath: executable });
      } catch (error) {
        return options.warn("Could not move Godot's executable setting", error);
      }
    }
  }
  await options.configuration.remove(LEGACY_GODOT_ID);
}

/** Where a command runs from, as a shell would find it, or undefined. */
async function onPath(command: string, environment: { PATH?: string; PATHEXT?: string }): Promise<string | undefined> {
  if (command.includes("/") || command.includes("\\")) return undefined;
  const suffixes = process.platform === "win32" ? ["", ...(environment.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const folder of (environment.PATH ?? "").split(path.delimiter).filter(Boolean))
    for (const suffix of suffixes) {
      const candidate = path.join(folder, command + suffix);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Try the next one.
      }
    }
  return undefined;
}
