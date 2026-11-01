// Moves the format 1 Godot plugin's executable setting to the format 2
// plugin, which replaced it. Format 1 took a command or a path and defaulted
// to `godot`; format 2 takes an absolute path and finds Godot itself when
// it's empty.
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import type { PluginConfigurationStore } from "./plugin-configuration.js";
import type { PluginServices } from "./plugin-services.js";

export const LEGACY_GODOT_ID = "ohmygame:godot";
export const GODOT_PLUGIN = "ohmygame/godot";

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
