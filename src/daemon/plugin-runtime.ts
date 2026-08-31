import path from "node:path";
import { pluginComponentKey, type PluginDetail } from "../shared/plugins.js";
import type { LocalPluginStore } from "./local-plugins.js";
import type { PluginSettingsStore } from "./plugin-settings.js";

export async function resolvePluginSkillPaths(
  localPlugins: LocalPluginStore,
  settings: PluginSettingsStore,
): Promise<string[]> {
  const skillPaths: string[] = [];
  const local = await localPlugins.list();
  for (const plugin of local.plugins) {
    const root = await localPlugins.installedPath(plugin.id);
    const resolved = settings.resolve(plugin);
    if (!root || !resolved.enabled) continue;
    for (const skill of plugin.skills) {
      if (resolved.components[pluginComponentKey("skill", skill.id)]) skillPaths.push(path.join(root, skill.id));
    }
  }
  return [...new Set(skillPaths)];
}

export function enabledConnectionIds(
  plugins: readonly PluginDetail[],
  settings: PluginSettingsStore,
): Set<string> {
  const ids = new Set<string>();
  for (const plugin of plugins) {
    const resolved = settings.resolve(plugin);
    if (!resolved.enabled) continue;
    for (const connection of plugin.connections) {
      if (resolved.components[pluginComponentKey("connection", connection.id)]) ids.add(connection.id);
    }
  }
  return ids;
}
